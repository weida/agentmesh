/**
 * SavantDex Relay Agent
 *
 * Provider SDK for connecting to the SavantDex gateway via WebSocket relay.
 * No public IP, no open ports, no Streamr node required.
 *
 * Usage:
 *   import { RelayAgent } from 'savantdex/sdk/relay-agent.mjs'
 *   import { Wallet } from 'ethers'
 *
 *   const agent = new RelayAgent({
 *     gatewayUrl: 'wss://savantdex.weicao.dev/ws/agent',
 *     signer: new Wallet('0x...'),      // or any { address, signMessage }
 *     agentId: 'my-agent-v1',
 *   })
 *
 *   agent.onTask(async (task) => {
 *     // task = { taskId, taskType, input, timeoutMs }
 *     return { result: 'hello' }   // returned value sent as output
 *     // throw new Error(...)       // sent as { error: message }
 *   })
 *
 *   await agent.connect()   // blocks until auth_ok
 *   // ... agent processes tasks until disconnect
 *   await agent.disconnect()
 *
 * Prerequisites:
 *   Agent must be registered in the registry — either via admin registration
 *   (POST /admin/agents/register) or via Streamr-mode worker registration.
 */

import WebSocket from 'ws'
import { randomBytes } from 'crypto'
import { Wallet } from 'ethers'
import { computeResultHash } from './canonical.mjs'
import { buildAttestationPayload, signAttestation } from './attestation.mjs'
import { solvePow } from './pow.mjs'

const MIN_RECONNECT_MS = 1000
const MAX_RECONNECT_MS = 60000

export class RelayAgent {
  #gatewayUrl
  #signer
  #agentId
  #taskHandler
  #ws
  #connected
  #intentionalClose
  #reconnectMs
  #heartbeatIntervalMs

  /**
   * @param {object} config
   * @param {string}  config.gatewayUrl    — wss://... or ws://... relay endpoint
   * @param {string}  [config.privateKey]  — Ethereum private key (creates Wallet signer)
   * @param {object}  [config.signer]      — any object with { address: string, signMessage(msg): Promise<string> }
   * @param {string}  config.agentId       — must match a registered agent in the registry
   */
  constructor({ gatewayUrl, privateKey, signer, agentId }) {
    if (!gatewayUrl) throw new Error('[RelayAgent] gatewayUrl is required')
    if (!agentId) throw new Error('[RelayAgent] agentId is required')
    if (!privateKey && !signer) throw new Error('[RelayAgent] privateKey or signer is required')

    this.#gatewayUrl = gatewayUrl
    this.#agentId = agentId
    this.#signer = signer || new Wallet(privateKey)
    this.#taskHandler = null
    this.#ws = null
    this.#connected = false
    this.#intentionalClose = false
    this.#reconnectMs = MIN_RECONNECT_MS
    this.#heartbeatIntervalMs = 30000
  }

  /**
   * Register a task handler.  Must be called before connect().
   * @param {function} handler — async (task) => output.  Throw to send error.
   */
  onTask(handler) {
    if (typeof handler !== 'function') throw new Error('[RelayAgent] handler must be a function')
    this.#taskHandler = handler
  }

  /**
   * Connect to the gateway and authenticate.
   * Resolves when auth_ok is received.  Rejects on first auth failure.
   * After initial connection, auto-reconnects on disconnect (exponential backoff).
   */
  async connect() {
    if (!this.#taskHandler) throw new Error('[RelayAgent] Call onTask() before connect()')
    this.#intentionalClose = false
    return this.#doConnect(true)
  }

  /**
   * Gracefully close the connection.  Stops auto-reconnect.
   */
  async disconnect() {
    this.#intentionalClose = true
    if (this.#ws) {
      this.#ws.close(1000, 'Client disconnect')
      this.#ws = null
    }
    this.#connected = false
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  #doConnect(isInitial) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.#gatewayUrl)
      this.#ws = ws

      ws.on('open', () => {
        this.#sendAuth(ws).catch(e => {
          console.error(`[RelayAgent] Auth send failed: ${e.message}`)
          ws.close()
          if (isInitial) reject(e)
        })
      })

      ws.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }

        switch (msg.type) {
          case 'auth_ok':
            this.#connected = true
            this.#reconnectMs = MIN_RECONNECT_MS
            this.#heartbeatIntervalMs = msg.heartbeatIntervalMs || 30000
            console.log(`[RelayAgent] Connected: ${this.#agentId} (session: ${msg.sessionId})`)
            if (isInitial) resolve()
            break

          case 'auth_error':
            console.error(`[RelayAgent] Auth failed: ${msg.error}`)
            ws.close()
            if (isInitial) reject(new Error(`Auth failed: ${msg.error}`))
            break

          case 'ping':
            trySend(ws, { type: 'pong', ts: msg.ts })
            break

          case 'task':
            this.#handleTask(ws, msg)
            break

          case 'task_cancel':
            // Best-effort notification — handler is already running, can't cancel
            console.warn(`[RelayAgent] Task cancel received: ${msg.taskId}`)
            break

          case 'superseded':
            console.warn(`[RelayAgent] Superseded: ${msg.reason || 'new connection'}`)
            break
        }
      })

      ws.on('close', (code, reason) => {
        const wasConnected = this.#connected
        this.#connected = false
        this.#ws = null

        if (this.#intentionalClose) return

        const reasonStr = reason?.toString() || ''
        console.log(`[RelayAgent] Disconnected: code=${code} reason=${reasonStr}`)

        if (!isInitial || wasConnected) {
          // Auto-reconnect with backoff
          console.log(`[RelayAgent] Reconnecting in ${this.#reconnectMs}ms...`)
          setTimeout(() => {
            this.#reconnectMs = Math.min(this.#reconnectMs * 2, MAX_RECONNECT_MS)
            this.#doConnect(false).catch(e => {
              console.error(`[RelayAgent] Reconnect failed: ${e.message}`)
            })
          }, this.#reconnectMs)
        }
      })

      ws.on('error', (e) => {
        console.error(`[RelayAgent] WebSocket error: ${e.message}`)
        if (isInitial && !this.#connected) {
          reject(e)
        }
      })
    })
  }

  async #sendAuth(ws) {
    const timestamp = Date.now()
    const nonce = randomBytes(16).toString('hex')
    const address = (this.#signer.address || await this.#signer.getAddress()).toLowerCase()
    const message = `savantdex-relay:${this.#agentId}:${address}:${timestamp}:${nonce}`
    const signature = await this.#signer.signMessage(message)

    trySend(ws, {
      type: 'auth',
      agentId: this.#agentId,
      ownerAddress: address,
      timestamp,
      nonce,
      signature,
    })
  }

  async #handleTask(ws, msg) {
    const { taskId, taskType, input, timeoutMs } = msg

    try {
      const output = await this.#taskHandler({ taskId, taskType, input, timeoutMs })
      const attestation = await this.#buildAttestation(taskId, output)
      trySend(ws, { type: 'result', taskId, output, attestation })
    } catch (err) {
      trySend(ws, { type: 'result', taskId, error: err.message })
    }
  }

  async #buildAttestation(taskId, output) {
    try {
      const address = await this.#signer.getAddress()
      const payload = buildAttestationPayload({
        taskId,
        providerAgentId:      this.#agentId,
        providerOwnerAddress: address,
        resultHash:           computeResultHash(output),
        completedAt:          new Date().toISOString(),
      })
      return await signAttestation(payload, this.#signer)
    } catch (err) {
      console.warn(`[RelayAgent] attestation failed for ${taskId}: ${err.message}`)
      return null
    }
  }

  /**
   * Self-register this agent in the registry via PoW + wallet signature.
   * One-shot — does not maintain a connection. Call before connect().
   *
   * @param {object}   opts
   * @param {string}   opts.registryUrl   — registry base URL, e.g. "https://savantdex.weicao.dev"
   * @param {object}   opts.signer        — any { address, signMessage(msg): Promise<string> }
   * @param {string}   opts.agentId       — desired agent ID (lowercase alphanumeric, 4-50 chars)
   * @param {string[]} opts.capabilities  — e.g. ["token-risk"]
   * @param {object}   [opts.meta]        — extra fields: name, description, taskType, inputSchema, ...
   * @returns {Promise<{ ok, agentId, streamId, ownerAddress, transport }>}
   */
  static async register({ registryUrl, signer, agentId, capabilities, meta = {} }) {
    const base = registryUrl.replace(/\/$/, '')

    const { challengeId, prefix, difficulty } = await fetch(`${base}/register/challenge`, { method: 'POST' })
      .then(r => r.json())

    const nonce = solvePow(prefix, difficulty)
    const ownerAddress = (signer.address || await signer.getAddress()).toLowerCase()
    const timestamp = Date.now()
    const message = `savantdex-register-agent:${agentId}:${ownerAddress}:${timestamp}`
    const signature = await signer.signMessage(message)

    const res = await fetch(`${base}/register/agent`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, ownerAddress, timestamp, signature, challengeId, nonce, capabilities, ...meta }),
    })
    const data = await res.json()
    if (!res.ok) throw Object.assign(new Error(data.error || `Register failed (${res.status})`), { status: res.status })
    return data
  }
}

function trySend(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj))
    }
  } catch {
    // Swallow — connection may be closing
  }
}
