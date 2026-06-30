/**
 * SavantDex GatewayRequester
 *
 * HTTP gateway client with transparent wallet/session authentication.
 * Implements the same run() interface as SavantDexRequester but routes
 * all calls through the gateway HTTP API instead of Streamr P2P directly.
 *
 * Authentication options:
 *   api-key  — X-API-Key header (existing path, no wallet needed)
 *   wallet   — EIP-191 challenge/sign/session flow (Phase D)
 *              Accepts any signer with a signMessage(message) method:
 *              ethers Wallet, ethers Signer, viem WalletClient, MetaMask getSigner(), etc.
 *
 * Session management (wallet auth only):
 *   - Challenge + sign on first call or after session expires
 *   - Session cached in memory for its TTL (15m server-side)
 *   - Re-authenticates automatically 60s before expiry
 *   - No silent refresh — full re-sign when expired
 *
 * Usage (api-key):
 *   const client = GatewayRequester.create({
 *     gatewayUrl: 'https://api.savantdex.io',
 *     apiKey: 'sk-...',
 *   })
 *   const result = await client.run('wallet-intelligence-v1', { wallet: '0x...' })
 *
 * Usage (wallet):
 *   import { ethers } from 'ethers'
 *   const signer = new ethers.Wallet(privateKey)          // node.js
 *   // const signer = await provider.getSigner()          // browser / MetaMask
 *
 *   const client = GatewayRequester.create({
 *     gatewayUrl: 'https://api.savantdex.io',
 *     requesterAgentId: 'my-bot-v1',
 *     ownerAddress: signer.address,
 *     signer,
 *   })
 *   const result = await client.run('wallet-intelligence-v1', { wallet: '0x...' })
 */

import { solvePow } from './pow.mjs'

const SESSION_REFRESH_MARGIN_MS = 60 * 1000  // re-auth when <60s remaining

export class GatewayRequester {
  #gatewayUrl
  #registryUrl
  #auth    // { type: 'api-key', key } | { type: 'wallet', signer, requesterAgentId, ownerAddress }
  #session // { token: string, expiresAt: string } | null

  constructor({ gatewayUrl, registryUrl, auth }) {
    this.#gatewayUrl  = gatewayUrl.replace(/\/$/, '')
    this.#registryUrl = registryUrl.replace(/\/$/, '')
    this.#auth    = auth
    this.#session = null
  }

  /**
   * @param {object} config
   * @param {string}  config.gatewayUrl        — gateway base URL, e.g. "https://api.savantdex.io"
   * @param {string}  [config.registryUrl]     — registry base URL (default: same host, port 3000)
   * @param {string}  [config.apiKey]          — api-key auth (mutually exclusive with signer)
   * @param {object}  [config.signer]          — wallet signer with signMessage(msg) → Promise<string>
   * @param {string}  [config.requesterAgentId]— required for wallet auth
   * @param {string}  [config.ownerAddress]    — required for wallet auth; must match bound wallet
   */
  static create({ gatewayUrl, registryUrl, apiKey, signer, requesterAgentId, ownerAddress }) {
    if (!gatewayUrl) throw new Error('gatewayUrl is required')

    const resolvedRegistryUrl = registryUrl || _defaultRegistryUrl(gatewayUrl)

    let auth
    if (apiKey) {
      auth = { type: 'api-key', key: apiKey }
    } else if (signer) {
      if (!requesterAgentId) throw new Error('requesterAgentId is required for wallet auth')
      if (!ownerAddress)     throw new Error('ownerAddress is required for wallet auth')
      if (typeof signer.signMessage !== 'function')
        throw new Error('signer must have a signMessage(message) method')
      auth = { type: 'wallet', signer, requesterAgentId, ownerAddress }
    } else {
      throw new Error('apiKey or signer is required')
    }

    return new GatewayRequester({ gatewayUrl, registryUrl: resolvedRegistryUrl, auth })
  }

  // ── Discovery ────────────────────────────────────────────────────────────────

  /**
   * Find agents matching filters.
   * @param {object} [filters]
   * @param {string}  [filters.capability]
   * @param {string}  [filters.category]
   * @param {string}  [filters.q]
   * @param {boolean} [filters.supportsAsync]
   * @param {number}  [filters.maxExpectedLatencyMs]
   * @returns {Promise<Array>}
   */
  async findAgents(filters = {}) {
    const params = new URLSearchParams()
    if (filters.capability != null)           params.set('capability', filters.capability)
    if (filters.category != null)             params.set('category', filters.category)
    if (filters.q != null)                    params.set('q', filters.q)
    if (filters.supportsAsync != null)        params.set('supportsAsync', String(filters.supportsAsync))
    if (filters.maxExpectedLatencyMs != null) params.set('maxExpectedLatencyMs', String(filters.maxExpectedLatencyMs))
    const qs = params.toString()
    const res = await fetch(`${this.#registryUrl}/agents${qs ? '?' + qs : ''}`)
    if (!res.ok) throw new Error(`Registry error ${res.status}: ${await res.text()}`)
    return (await res.json()).agents
  }

  /**
   * Get the agent card for a specific agent.
   * @param {string} agentId
   * @returns {Promise<object>}
   */
  async getCard(agentId) {
    const res = await fetch(`${this.#registryUrl}/agents/${encodeURIComponent(agentId)}`)
    if (!res.ok) throw new Error(`Agent not found: ${agentId}`)
    return res.json()
  }

  // ── Invocation ───────────────────────────────────────────────────────────────

  /**
   * Run a task on a remote agent through the gateway and wait for the result.
   *
   * @param {string|object} agentIdOrCard  agentId string or registry record with callHint
   * @param {object}        input          task input matching the agent's inputSchema
   * @param {object}        [opts]
   * @param {number}        [opts.timeout=30000]  ms before giving up (client-side)
   * @returns {Promise<TaskResult>}
   *
   * TaskResult = {
   *   taskId:  string,
   *   status:  'completed' | 'failed',
   *   output:  object,
   *   error:   string | null,
   *   meta: { durationMs, agentId, taskType }
   * }
   */
  async run(agentIdOrCard, input, opts = {}) {
    const { timeout = 30000 } = opts
    const { agentId, taskType } = await this.#resolveCard(agentIdOrCard)

    if (!taskType) {
      throw new Error(`Agent "${agentId}" has no taskType — cannot build task envelope`)
    }

    const startMs = Date.now()

    let res = await this.#postTask({ agentId, taskType, input, timeout })

    // Wallet auth: a 401 means our cached session was rejected server-side
    // (gateway restart, manual revoke, clock skew) even though the local
    // expiresAt still looked valid. Drop the stale session, re-authenticate,
    // and retry once — this is the "re-auth happens automatically" contract.
    if (res.status === 401 && this.#auth.type === 'wallet') {
      this.#session = null
      res = await this.#postTask({ agentId, taskType, input, timeout })
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      const msg  = body.error || `Gateway error ${res.status}`
      const err  = Object.assign(new Error(msg), { status: res.status, code: body.code })
      throw err
    }

    const data      = await res.json()
    const durationMs = Date.now() - startMs
    const hasError  = data.result && typeof data.result.error === 'string'

    return {
      taskId:  data.taskId,
      status:  hasError ? 'failed' : 'completed',
      output:  hasError ? null : data.result,
      error:   hasError ? data.result.error : null,
      meta: { durationMs, agentId, taskType },
    }
  }

  /**
   * Issue a single POST /task request with fresh auth headers.
   * Returns the raw Response so the caller can inspect status for retry logic.
   */
  async #postTask({ agentId, taskType, input, timeout }) {
    const authHeaders = await this.#getAuthHeaders()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      return await fetch(`${this.#gatewayUrl}/task`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body:    JSON.stringify({ agentId, type: taskType, input }),
        signal:  controller.signal,
      })
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`Task timed out after ${timeout}ms`)
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Lower-level wallet auth (for frontends that need UI state control) ────────

  /**
   * Request a wallet auth challenge from the gateway.
   * Use this when you need to show intermediate UI state (e.g. "Waiting for wallet...").
   * For A2A usage, call run() directly — challenge/sign/session are managed automatically.
   *
   * Only valid when created with signer auth.
   * @returns {Promise<{ challengeId: string, message: string, expiresAt: string }>}
   */
  async createChallenge() {
    this.#requireWalletAuth()
    const { requesterAgentId, ownerAddress } = this.#auth
    const res = await fetch(`${this.#gatewayUrl}/auth/challenge`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ requesterAgentId, ownerAddress }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw Object.assign(
        new Error(body.error || `Challenge request failed (${res.status})`),
        { code: body.code, status: res.status }
      )
    }
    return res.json()
  }

  /**
   * Verify a wallet signature and establish a session.
   * Call after the user has signed the challenge message.
   * Caches the resulting session so subsequent run() calls use it automatically.
   *
   * @param {string} challengeId  — from createChallenge()
   * @param {string} signature    — EIP-191 signature of challenge.message
   * @returns {Promise<{ expiresAt: string }>}
   */
  async verifySignature(challengeId, signature) {
    this.#requireWalletAuth()
    const res = await fetch(`${this.#gatewayUrl}/auth/verify-signature`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ challengeId, signature }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw Object.assign(
        new Error(body.error || `Signature verification failed (${res.status})`),
        { code: body.code, status: res.status }
      )
    }
    const { sessionToken, expiresAt } = await res.json()
    this.#session = { token: sessionToken, expiresAt }
    return { expiresAt }
  }

  // ── Session management ────────────────────────────────────────────────────────

  /**
   * Revoke the current session (wallet auth only).
   * No-op if using api-key auth or no active session.
   */
  async revokeSession() {
    if (this.#auth.type !== 'wallet' || !this.#session) return
    try {
      await fetch(`${this.#gatewayUrl}/auth/session/revoke`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sessionToken: this.#session.token }),
      })
    } finally {
      this.#session = null
    }
  }

  async destroy() {
    await this.revokeSession()
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  #requireWalletAuth() {
    if (this.#auth.type !== 'wallet') throw new Error('wallet auth required — create with signer, not apiKey')
  }

  async #getAuthHeaders() {
    if (this.#auth.type === 'api-key') {
      return { 'X-API-Key': this.#auth.key }
    }

    // Wallet auth: reuse session if still valid with margin
    if (this.#session) {
      const remainingMs = new Date(this.#session.expiresAt) - Date.now()
      if (remainingMs > SESSION_REFRESH_MARGIN_MS) {
        return { 'X-Session-Token': this.#session.token }
      }
    }

    // (Re-)authenticate: challenge → sign → verify
    await this.#authenticate()
    return { 'X-Session-Token': this.#session.token }
  }

  async #authenticate() {
    const { requesterAgentId, ownerAddress, signer } = this.#auth

    // Step 1: request challenge
    const cRes = await fetch(`${this.#gatewayUrl}/auth/challenge`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ requesterAgentId, ownerAddress }),
    })
    if (!cRes.ok) {
      const body = await cRes.json().catch(() => ({}))
      throw Object.assign(
        new Error(body.error || `Challenge request failed (${cRes.status})`),
        { code: body.code, status: cRes.status }
      )
    }
    const { challengeId, message } = await cRes.json()

    // Step 2: sign with the provided signer
    const signature = await signer.signMessage(message)

    // Step 3: verify signature and obtain session token
    const vRes = await fetch(`${this.#gatewayUrl}/auth/verify-signature`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ challengeId, signature }),
    })
    if (!vRes.ok) {
      const body = await vRes.json().catch(() => ({}))
      throw Object.assign(
        new Error(body.error || `Signature verification failed (${vRes.status})`),
        { code: body.code, status: vRes.status }
      )
    }
    const { sessionToken, expiresAt } = await vRes.json()
    this.#session = { token: sessionToken, expiresAt }
  }

  async #resolveCard(agentIdOrCard) {
    if (typeof agentIdOrCard === 'string') {
      const res = await fetch(`${this.#registryUrl}/agents/${encodeURIComponent(agentIdOrCard)}`)
      if (!res.ok) throw new Error(`Agent not found: ${agentIdOrCard}`)
      const record = await res.json()
      return {
        agentId:  agentIdOrCard,
        taskType: record.callHint?.taskType || null,
      }
    }
    return {
      agentId:  agentIdOrCard.agentId,
      taskType: agentIdOrCard.callHint?.taskType || null,
    }
  }

  /**
   * Self-register a new requester identity via PoW + wallet signature.
   * Creates the identity with zero budget — call POST /faucet/claim separately to top up.
   *
   * @param {object}  opts
   * @param {string}  opts.gatewayUrl         — gateway base URL, e.g. "https://savantdex.weicao.dev"
   * @param {object}  opts.signer             — any { address, signMessage(msg): Promise<string> }
   * @param {string}  opts.requesterAgentId   — desired requester ID (lowercase alphanumeric, 4-50 chars)
   * @returns {Promise<{ ok, requesterAgentId, ownerAddress }>}
   */
  static async register({ gatewayUrl, signer, requesterAgentId }) {
    const base = gatewayUrl.replace(/\/$/, '')

    const { challengeId, prefix, difficulty } = await fetch(`${base}/register/challenge`, { method: 'POST' })
      .then(r => r.json())

    const nonce = solvePow(prefix, difficulty)
    const ownerAddress = (signer.address || await signer.getAddress()).toLowerCase()
    const timestamp = Date.now()
    const message = `savantdex-register-requester:${requesterAgentId}:${ownerAddress}:${timestamp}`
    const signature = await signer.signMessage(message)

    const res = await fetch(`${base}/register/requester`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterAgentId, ownerAddress, timestamp, signature, challengeId, nonce }),
    })
    const data = await res.json()
    if (!res.ok) throw Object.assign(new Error(data.error || `Register failed (${res.status})`), { status: res.status, code: data.code })
    return data
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _defaultRegistryUrl(gatewayUrl) {
  // Default: same host as gateway (gateway already proxies /agents endpoints).
  // Callers can override with an explicit registryUrl for split deployments.
  return gatewayUrl.replace(/\/$/, '')
}
