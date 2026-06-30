/**
 * SavantDex Backend API Server v1.2
 * HTTP bridge between the web frontend and Streamr P2P network
 * Runs on port 4000
 *
 * Key model (Phase 1-Migration):
 *   Gateway holds NO private key. All Streamr signing is delegated to
 *   signer/server.mjs running on 127.0.0.1:SIGNER_PORT.
 *
 * Required env (signer mode):
 *   SIGNER_ADDRESS   Gateway runtime address (printed by signer/server.mjs on startup)
 *   SIGNER_PORT      Signer server port (default: 17099)
 *
 * Legacy env (still works if no SIGNER_ADDRESS is set):
 *   KEYSTORE_PATH, KEYSTORE_PASSWORD (or SECRETS_PATH + AGE_IDENTITY_PATH)
 */

import process from 'process'
process.umask(0o077)  // restrict new file creation to owner-only (600/700)

import http from 'http'
import { ethers } from 'ethers'
import { timingSafeEqual, randomBytes, createHash } from 'crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs'
import { initRelay, getRelayStatus, relayTask, relayAgentCount, getRelayConnections, shutdownRelay } from './ws-relay.mjs'
import { createPowChallenge, verifyPow } from '../sdk/pow.mjs'
import { SavantDex } from '../sdk/index.mjs'
import { RemoteSignerIdentity } from '../sdk/remote-identity.mjs'
import { loadSecrets } from '../sdk/secrets.mjs'
import { loadPrivateKey } from '../sdk/keystore.mjs'
import {
  initDb, resolveRequester, resolveApiKey, getAuthMethods, getRequesterIdentity, bindWalletMethod,
  createChallenge, getChallenge, consumeChallengeAndCreateSession, resolveSession, revokeSession,
  preInvocationCheck,
  writeSubmitted, markStatus, chargeCompleted,
  getBudget, getProviderReceivable, getTaskTrace, getAuthStats,
  createFundingRecord, processFunding, getFundingHistory, getFundingById,
  createSettlementRecord, processSettlement, getSettlementHistory, getSettlementById,
  writeDeliveryReceipt, getDeliveryReceipt, getTaskAgreementForReceipt,
  computeResultHash,
  selfRegisterRequester,
  claimFaucet,
} from './payment.mjs'
import {
  buildReceiptPayload, signReceiptPayload,
  buildExportPayload, signExportPayload, canonicalExportMessage,
} from './receipt.mjs'
import { verifyProviderAttestation } from './attestation.mjs'
import { sortAgentsByReputation } from './reputation.mjs'

const PORT          = process.env.PORT          || 4000
const REGISTRY_URL  = process.env.REGISTRY_URL  || 'http://localhost:3000'
const EXTERNAL_IP   = process.env.EXTERNAL_IP   || '127.0.0.1'
const SIGNER_ADDRESS = process.env.SIGNER_ADDRESS
const SIGNER_PORT    = Number(process.env.SIGNER_PORT || 17099)
const SIGNER_TOKEN   = process.env.SIGNER_TOKEN || null
const METRICS_FILE  = './metrics.json'
const STREAM_CACHE_TTL = 60 * 1000   // 60s
const STREAM_CACHE_MAX_STALE_MS = 60 * 60 * 1000 // 1h hard stop on stale fallback
const PAYMENT_ENABLED = process.env.PAYMENT_ENABLED !== 'false'

// Per-task execution timeout (relay + Streamr transports and the ledger
// reservation window). Configurable so slow agents can be given more headroom
// without editing code. Falls back to 60s and ignores non-positive values.
const TASK_TIMEOUT_MS = (() => {
  const v = Number(process.env.TASK_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 60_000
})()

// Admin key loading:
//   Preferred:  BACKEND_SECRETS_PATH + AGE_IDENTITY_PATH → age-encrypted JSON with { ADMIN_API_KEY }
//   Fallback:   ADMIN_API_KEY env var (with deprecation warning)
function loadAdminKey() {
  const secretsPath  = process.env.BACKEND_SECRETS_PATH
  const identityPath = process.env.AGE_IDENTITY_PATH
  if (secretsPath && identityPath) {
    try {
      const out = execFileSync('age', ['--decrypt', '-i', identityPath, secretsPath], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
      })
      const parsed = JSON.parse(out)
      if (parsed.ADMIN_API_KEY) {
        console.log('[Backend] ADMIN_API_KEY loaded from age-encrypted secrets')
        return parsed.ADMIN_API_KEY
      }
      console.warn('[Backend] BACKEND_SECRETS_PATH set but ADMIN_API_KEY field missing')
    } catch (e) {
      console.error('[Backend] Failed to decrypt backend secrets:', e.stderr?.toString() || e.message)
    }
  }
  if (process.env.ADMIN_API_KEY) {
    console.warn('[Backend] WARNING: ADMIN_API_KEY read from env var. Migrate to BACKEND_SECRETS_PATH + AGE_IDENTITY_PATH.')
    return process.env.ADMIN_API_KEY
  }
  return null
}
const ADMIN_API_KEY = loadAdminKey()

initDb()

// --- Auth: signer server (preferred) or legacy keystore ---
let gatewayAuth
if (SIGNER_ADDRESS) {
  console.log(`[Backend] Using remote signer: ${SIGNER_ADDRESS} on port ${SIGNER_PORT}`)
  gatewayAuth = { identity: new RemoteSignerIdentity(SIGNER_ADDRESS, SIGNER_PORT, SIGNER_TOKEN) }
} else {
  console.warn('[Backend] SIGNER_ADDRESS not set — falling back to local keystore (legacy mode)')
  const { KEYSTORE_PASSWORD } = await loadSecrets()
  const PRIVATE_KEY = await loadPrivateKey(KEYSTORE_PASSWORD)
  gatewayAuth = { privateKey: PRIVATE_KEY }
}

// --- In-memory metrics (persisted to METRICS_FILE) ---
// Shape: { [agentId]: { calls, success, fail, totalMs, lastSuccessAt } }

function loadMetrics() {
  if (!existsSync(METRICS_FILE)) return {}
  try { return JSON.parse(readFileSync(METRICS_FILE, 'utf8')) } catch { return {} }
}

function saveMetrics() {
  const tmp = `${METRICS_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(metrics, null, 2))
  renameSync(tmp, METRICS_FILE)
}

const metrics = loadMetrics()
setInterval(saveMetrics, 30_000)  // flush every 30s

function recordCall(agentId, success, durationMs) {
  if (!metrics[agentId]) metrics[agentId] = { calls: 0, success: 0, fail: 0, totalMs: 0, lastSuccessAt: null }
  const m = metrics[agentId]
  m.calls++
  m.totalMs += durationMs
  if (success) {
    m.success++
    m.lastSuccessAt = new Date().toISOString()
  } else {
    m.fail++
  }
}

function getMetricsSummary(agentId) {
  const m = metrics[agentId]
  if (!m || m.calls === 0) return {}
  return {
    avgResponseMs: Math.round(m.totalMs / m.calls),
    successRate:   Math.round((m.success / m.calls) * 100),
    lastSuccessAt: m.lastSuccessAt,
    status:        m.fail / m.calls > 0.5 ? 'degraded' : 'online',
  }
}

// --- Dynamic agent registry lookup with TTL cache ---
// Cache shape: { streamId, pricingModel, providerOwnerAddress, taskType, expiresAt }
const streamCache = new Map()

async function resolveAgentCard(agentId) {
  const cached = streamCache.get(agentId)
  if (cached && cached.expiresAt > Date.now()) return cached

  try {
    const res = await fetch(`${REGISTRY_URL}/agents/${encodeURIComponent(agentId)}/card`)
    if (!res.ok) {
      if (cached?.streamId && cached.fetchedAt > Date.now() - STREAM_CACHE_MAX_STALE_MS) {
        console.warn(`[Backend] Registry ${res.status} for ${agentId}, using stale cache`)
        return cached
      }
      return null
    }
    const card = await res.json()
    if (!card.invocation?.streamId) return null
    const transport = card.invocation?.transport || ['streamr']
    const entry = {
      streamId:            card.invocation.streamId,
      pricingModel:        card.pricingModel || { type: 'free', currency: 'DATA', amountBaseUnits: '0', decimals: 18, billingUnit: 'task' },
      providerOwnerAddress: card.provider?.ownerAddress || null,
      taskType:            card.invocation?.taskType || 'unknown',
      transport,
      fetchedAt:           Date.now(),
      expiresAt:           Date.now() + STREAM_CACHE_TTL,
    }
    streamCache.set(agentId, entry)
    return entry
  } catch {
    if (cached?.streamId && cached.fetchedAt > Date.now() - STREAM_CACHE_MAX_STALE_MS) {
      console.warn(`[Backend] Registry unreachable for ${agentId}, using stale cache`)
      return cached
    }
    return null
  }
}

// --- Gateway ---
console.log('[Backend] Initializing Streamr gateway...')
let gateway = null
let gatewayAddress = null
try {
  gateway = new SavantDex({
    ...gatewayAuth,
    agentId: 'api-gateway',
    network: { websocketPort: Number(process.env.WEBSOCKET_PORT || 32204), externalIp: EXTERNAL_IP }
  })
  await gateway.register()
  gatewayAddress = await gateway.getAddress()
  console.log(`[Backend] Gateway ready: ${gatewayAddress}`)
  await gateway.onTask(async (_task, reply) => {
    await reply({ error: 'gateway does not process tasks directly' })
  })
  console.log('[Backend] P2P inbox pre-warmed')
} catch (err) {
  console.warn(`[Backend] Streamr gateway unavailable (relay-only mode): ${err.message}`)
}

// --- Rate limiting ---
//
// Two limits per client:
//   1. Concurrent in-flight /task calls (prevents one client from flooding the P2P inbox)
//   2. Sliding window count across /task + /auth/* (prevents brute force and DB spam)
//
// Client key: upstream socket address by default. X-Forwarded-For is only honored when
// TRUSTED_PROXY_IPS includes the peer — otherwise the header is ignored to stop trivial
// spoofing of the rate-limit key.
const inFlight = new Map()
const rlWindow = new Map() // key -> array of timestamps
const RL_WINDOW_MS      = 60_000
const RL_WINDOW_MAX     = 60     // /task + /auth total per minute per client
const RL_INFLIGHT_MAX   = 5
const TRUSTED_PROXY_IPS = new Set(
  (process.env.TRUSTED_PROXY_IPS || '127.0.0.1,::1,::ffff:127.0.0.1').split(',').map(s => s.trim()).filter(Boolean)
)

function clientKey(req) {
  const peer = req.socket.remoteAddress || 'unknown'
  if (TRUSTED_PROXY_IPS.has(peer)) {
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0].trim()
    }
  }
  return peer
}

function checkConcurrentLimit(key) {
  if ((inFlight.get(key) || 0) >= RL_INFLIGHT_MAX) {
    return { error: 'Too many concurrent requests, please try again shortly', code: 'RATE_LIMITED' }
  }
  return null
}

function checkWindowLimit(key) {
  const now = Date.now()
  const cutoff = now - RL_WINDOW_MS
  let hits = rlWindow.get(key)
  if (!hits) { hits = []; rlWindow.set(key, hits) }
  while (hits.length && hits[0] < cutoff) hits.shift()
  if (hits.length >= RL_WINDOW_MAX) {
    return { error: 'Rate limit exceeded, please slow down', code: 'RATE_LIMITED' }
  }
  hits.push(now)
  return null
}

// Periodic cleanup: drop idle keys so the map does not grow unbounded under churn.
setInterval(() => {
  const cutoff = Date.now() - RL_WINDOW_MS
  for (const [k, hits] of rlWindow) {
    while (hits.length && hits[0] < cutoff) hits.shift()
    if (hits.length === 0) rlWindow.delete(k)
  }
}, RL_WINDOW_MS).unref()

// --- HTTP helpers ---

const MAX_BODY_BYTES = 64 * 1024 // 64 KiB — backend accepts only small JSON task bodies

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let aborted = false
    const chunks = []
    req.on('data', chunk => {
      if (aborted) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        req.pause()
        const e = new Error('Request body too large')
        e.code = 'BODY_TOO_LARGE'
        reject(e)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

// Allowlist of browser origins permitted to call this backend directly with CORS.
// Non-browser clients (SDK, curl, workers) do not send Origin and are unaffected.
// Setting this to '*' is still supported as an opt-out but not recommended because
// it lets any third-party site issue /task calls with a user's X-Session-Token.
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ||
  'http://localhost:3001,http://127.0.0.1:3001,https://savantdex.weicao.dev,https://lab.garlicspace.com'
).split(',').map(s => s.trim()).filter(Boolean)

function corsHeaders(req) {
  const origin = req.headers.origin
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Session-Token, X-Admin-Key',
    'Vary': 'Origin',
  }
  if (!origin) return headers
  if (CORS_ALLOWED_ORIGINS.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*'
  } else if (CORS_ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

function send(res, status, data) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...corsHeaders(res.req),
  }
  res.writeHead(status, headers)
  res.end(JSON.stringify(data))
}

// Constant-time admin key check. Any mismatch in presence or length short-circuits
// to a dummy comparison so the failure path does not leak timing information.
const ADMIN_KEY_BUF = ADMIN_API_KEY ? Buffer.from(ADMIN_API_KEY, 'utf8') : null
const ADMIN_KEY_DUMMY = ADMIN_KEY_BUF ? Buffer.alloc(ADMIN_KEY_BUF.length) : null

function adminKeyMatches(provided) {
  if (!ADMIN_KEY_BUF) return false
  if (typeof provided !== 'string') {
    timingSafeEqual(ADMIN_KEY_DUMMY, ADMIN_KEY_DUMMY)
    return false
  }
  const supplied = Buffer.from(provided, 'utf8')
  if (supplied.length !== ADMIN_KEY_BUF.length) {
    timingSafeEqual(ADMIN_KEY_DUMMY, ADMIN_KEY_DUMMY)
    return false
  }
  return timingSafeEqual(supplied, ADMIN_KEY_BUF)
}

// Returns true if request carries a valid admin key; sends 401 and returns false otherwise.
function requireAdmin(req, res) {
  if (!ADMIN_API_KEY) {
    err(res, 503, 'Admin operations not configured (ADMIN_API_KEY not set)', 'ADMIN_NOT_CONFIGURED')
    return false
  }
  if (!adminKeyMatches(req.headers['x-admin-key'])) {
    err(res, 401, 'Invalid or missing X-Admin-Key', 'UNAUTHORIZED')
    return false
  }
  return true
}

function err(res, status, message, code) {
  send(res, status, { error: message, code })
}

// --- Input sanitization ---

const SENSITIVE_PATTERNS = [
  { re: /\b(0x)?[0-9a-fA-F]{64}\b/,           label: 'private key' },
  { re: /[5KL][1-9A-HJ-NP-Za-km-z]{50,51}/,   label: 'WIF private key' },
  { re: /\b\d{17}[\dXx]\b/,                    label: 'Chinese ID number' },
  { re: /\b\d{3}-\d{2}-\d{4}\b/,               label: 'SSN' },
  { re: /\b[A-Z]{1,2}\d{6,9}\b/,               label: 'passport number' },
  { re: /\b(?:\d[ -]?){13,16}\b/,              label: 'card number' },
  { re: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4,}/, label: 'phone number' },
]

function sanitizeInput(input) {
  if (typeof input !== 'object' || input === null) {
    throw Object.assign(new Error('Invalid input format'), { code: 'INVALID_INPUT' })
  }
  const MAX_KEYS = 32
  const MAX_DEPTH = 6
  let seenKeys = 0

  function sanitizeValue(key, value, depth) {
    if (depth > MAX_DEPTH) {
      throw Object.assign(new Error('Input nesting too deep'), { code: 'INVALID_INPUT' })
    }
    if (typeof value === 'string') {
      if (value.length > 2000) {
        throw Object.assign(new Error('Input too long (max 2000 characters)'), { code: 'INPUT_TOO_LONG' })
      }
      const isAddressField = key === 'hash' || key === 'address' || key === 'token'
      const patterns = isAddressField
        ? SENSITIVE_PATTERNS.filter(p => p.label !== 'private key' && p.label !== 'WIF private key' && p.label !== 'phone number')
        : SENSITIVE_PATTERNS
      for (const { re, label } of patterns) {
        if (re.test(value)) {
          throw Object.assign(new Error(`Input blocked: detected ${label}`), { code: 'INPUT_BLOCKED' })
        }
      }
      return value.trim()
    }
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(key, item, depth + 1))
    if (value && typeof value === 'object') {
      const sanitized = {}
      for (const [childKey, childValue] of Object.entries(value)) {
        seenKeys++
        if (seenKeys > MAX_KEYS) {
          throw Object.assign(new Error('Too many input fields'), { code: 'INPUT_TOO_LARGE' })
        }
        sanitized[childKey] = sanitizeValue(childKey, childValue, depth + 1)
      }
      return sanitized
    }
    return value
  }

  const sanitized = {}
  for (const [key, value] of Object.entries(input)) {
    seenKeys++
    if (seenKeys > MAX_KEYS) {
      throw Object.assign(new Error('Too many input fields'), { code: 'INPUT_TOO_LARGE' })
    }
    sanitized[key] = sanitizeValue(key, value, 0)
  }
  return sanitized
}

// --- Route handlers ---

async function handleTask(req, res) {
  const ip = clientKey(req)

  const concErr = checkConcurrentLimit(ip)
  if (concErr) return err(res, 429, concErr.error, concErr.code)
  const winErr = checkWindowLimit(ip)
  if (winErr) return err(res, 429, winErr.error, winErr.code)

  inFlight.set(ip, (inFlight.get(ip) || 0) + 1)
  const release = () => {
    const n = (inFlight.get(ip) || 1) - 1
    if (n <= 0) inFlight.delete(ip); else inFlight.set(ip, n)
  }

  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    release()
    return err(res, 400, 'Invalid JSON body', 'INVALID_JSON')
  }

  const { agentId, type, input } = body
  if (!agentId || !type || !input) {
    release()
    return err(res, 400, 'agentId, type, and input are required', 'MISSING_FIELDS')
  }

  const agentCard = await resolveAgentCard(agentId)
  if (!agentCard) {
    release()
    return err(res, 404, 'Agent not found', 'AGENT_NOT_FOUND')
  }
  const { streamId: workerStream, pricingModel, providerOwnerAddress, taskType, transport } = agentCard

  let sanitizedInput
  try {
    sanitizedInput = sanitizeInput(input)
  } catch (e) {
    console.warn(`[Backend] Input blocked for ${agentId}: ${e.message}`)
    release()
    return err(res, 400, e.code === 'INPUT_BLOCKED' ? 'Input blocked by safety checks' : e.message, e.code || 'INPUT_BLOCKED')
  }

  // ── Pre-invocation gate ───────────────────────────────────────────────────
  let requesterAuth = null
  let authMethodUsed = null
  if (PAYMENT_ENABLED) {
    const rawKey      = req.headers['x-api-key']
    const sessionToken = req.headers['x-session-token']

    if (rawKey) {
      requesterAuth = resolveRequester(rawKey)
      if (!requesterAuth) { release(); return err(res, 401, 'Invalid or inactive API key', 'UNAUTHORIZED') }
      authMethodUsed = 'api-key'
    } else if (sessionToken) {
      requesterAuth = resolveSession(sessionToken)
      if (!requesterAuth) { release(); return err(res, 401, 'Invalid, expired, or revoked session token', 'UNAUTHORIZED') }
      authMethodUsed = 'wallet-signature'
    } else {
      release()
      return err(res, 401, 'X-API-Key or X-Session-Token header required', 'UNAUTHORIZED')
    }

    if (pricingModel.type === 'fixed') {
      const check = preInvocationCheck(requesterAuth.requesterAgentId, pricingModel.amountBaseUnits)
      if (!check.ok) {
        release()
        return err(res, 402, check.errorCode, check.errorCode)
      }
    }
  }

  console.log(`[Backend] Task: ${agentId}/${type} [${ip}]${authMethodUsed ? ` auth=${authMethodUsed}` : ''}`)
  const start = Date.now()

  // Pre-generate taskId so TaskAgreement + InvocationRecord are written BEFORE sendTask
  const taskId = `task-${randomBytes(16).toString('hex')}`

  if (PAYMENT_ENABLED && requesterAuth) {
    try {
      writeSubmitted({
        taskId,
        requesterAgentId:     requesterAuth.requesterAgentId,
        providerAgentId:      agentId,
        providerOwnerAddress: providerOwnerAddress || '0x0000000000000000000000000000000000000000',
        taskType:             taskType || type,
        pricingModel,
        timeoutMs:            TASK_TIMEOUT_MS,
        gatewayAddress,
        authMethodUsed,
      })
    } catch (e) {
      release()
      if (['BUDGET_INSUFFICIENT', 'MAX_PER_TASK_EXCEEDED', 'DAILY_LIMIT_EXCEEDED'].includes(e.code)) {
        return err(res, 402, e.code, e.code)
      }
      console.error(`[Backend] Failed to reserve budget for ${taskId}: ${e.message}`)
      return err(res, 500, 'Task reservation failed', 'RESERVATION_FAILED')
    }
  }

  // ── Transport routing: relay (preferred) or Streamr P2P (fallback) ────────
  const relay = getRelayStatus(agentId)
  const supportsStreamr = !transport || transport.includes('streamr')
  const transportMode = relay.connected ? 'relay' : supportsStreamr ? 'streamr' : null

  if (!transportMode) {
    // Relay-only agent is offline — no Streamr fallback available
    if (PAYMENT_ENABLED && requesterAuth) markStatus(taskId, 'failed')
    release()
    console.warn(`[Backend] Task ${taskId} → agent ${agentId} is relay-only and offline`)
    return err(res, 503, 'Agent is currently offline', 'AGENT_OFFLINE')
  }

  try {
    let result
    let providerAttestation = null
    const sentAt = Date.now() - start

    if (relay.connected) {
      console.log(`[Backend] Task ${taskId} → relay (${agentId})`)
      const relayRes = await relayTask(agentId, taskId, taskType, sanitizedInput, TASK_TIMEOUT_MS)
      result = relayRes.output
      providerAttestation = relayRes.attestation
    } else {
      console.log(`[Backend] Task ${taskId} → Streamr P2P (${workerStream})`)
      await gateway.sendTask(workerStream, { type, input: sanitizedInput, taskId })
      result = await gateway.waitForResult(taskId, TASK_TIMEOUT_MS, providerOwnerAddress || workerStream.split('/')[0])
    }

    const receivedAt = Date.now() - start

    // ── Post-completion ─────────────────────────────────────────────────────
    const resultStatus = result?.status || 'completed'
    const ledgerStatus = ['completed','failed','timeout','needs_disambiguation'].includes(resultStatus)
      ? resultStatus
      : 'completed'

    // 1) Trust primitive: sign + persist a delivery receipt for every completed
    //    task, regardless of payment configuration. If the task went through
    //    the payment path, we embed its agreementHash; otherwise the receipt
    //    still attests to "gateway observed this agent returning this result".
    if (ledgerStatus === 'completed') {
      try {
        const agr = getTaskAgreementForReceipt(taskId)
        const resultHash = computeResultHash(result)
        const payload = buildReceiptPayload({
          taskId,
          agreementHash:        agr?.agreementHash        || null,
          providerAgentId:      agr?.providerAgentId      || agentId,
          providerOwnerAddress: agr?.providerOwnerAddress || providerOwnerAddress || null,
          requesterAgentId:     agr?.requesterAgentId     || requesterAuth?.requesterAgentId || null,
          taskType:             agr?.taskType             || taskType || type,
          resultHash,
          completedAt:          new Date().toISOString(),
        })
        const signed = await signReceiptPayload(payload)

        let verifiedProviderAttestation = null
        if (providerAttestation) {
          const check = verifyProviderAttestation({
            attestation:          providerAttestation,
            expectedTaskId:       taskId,
            expectedResultHash:   resultHash,
            expectedOwnerAddress: payload.providerOwnerAddress,
            expectedAgentId:      payload.providerAgentId,
          })
          if (check.valid) {
            verifiedProviderAttestation = {
              payload:   providerAttestation.payload,
              signature: providerAttestation.signature,
              address:   check.recoveredAddress.toLowerCase(),
            }
          } else {
            console.warn(`[Receipt] provider attestation rejected for ${taskId}: ${check.reason}`)
          }
        }

        writeDeliveryReceipt({
          payload,
          gatewayAddress,
          signedPayload:       signed ? payload : null,
          signature:           signed?.signature     || null,
          signerAddress:       signed?.signerAddress || null,
          providerAttestation: verifiedProviderAttestation,
        })
      } catch (e) {
        console.warn(`[Receipt] write failed for ${taskId}: ${e.message}`)
      }
    }

    // 2) Payment ledger: only runs for tasks that entered the paid path.
    if (PAYMENT_ENABLED && requesterAuth) {
      markStatus(taskId, ledgerStatus)
      if (ledgerStatus === 'completed') {
        const charge = chargeCompleted(taskId)
        if (!charge.charged && charge.reason !== 'free_task' && charge.reason !== 'already_charged') {
          console.warn(`[Payment] Charge skipped for ${taskId}: ${charge.reason}`)
        }
      }
    }

    release()
    recordCall(agentId, true, receivedAt)
    console.log(`[Backend] Done: ${taskId} (${receivedAt}ms, ${transportMode})`)

    send(res, 200, {
      taskId,
      result,
      duration: receivedAt,
      trace:   { sentMs: sentAt, receivedMs: receivedAt, p2pMs: receivedAt - sentAt },
      network: { protocol: transportMode === 'relay' ? 'WebSocket Relay' : 'Streamr P2P', workerStream, gatewayAddress },
    })
  } catch (e) {
    release()
    const isTimeout = e.message?.includes('Timeout')
    recordCall(agentId, false, Date.now() - start)
    console.error(`[Backend] Failed (${transportMode}): ${e.message}`)

    // Move the invocation to a terminal state in the ledger so the reserved
    // budget is released. Previously only the timeout branch did this, which
    // leaked the reservation for every non-timeout failure (relay error,
    // worker error, agent disconnect) — the InvocationRecord stayed
    // 'submitted' forever and the requester's reserved funds were never
    // returned. markStatus('failed'/'timeout') refunds the reservation.
    if (PAYMENT_ENABLED && requesterAuth && taskId) {
      try { markStatus(taskId, isTimeout ? 'timeout' : 'failed') } catch {}
    }

    err(res, isTimeout ? 504 : 500, isTimeout ? 'Task timed out' : 'Task execution failed', isTimeout ? 'TIMEOUT' : 'WORKER_ERROR')
  }
}

async function handleAgents(req, res) {
  try {
    const inUrl = new URL(req.url, 'http://x')
    const fwd = new URLSearchParams()
    for (const k of ['capability', 'category', 'q', 'keyword', 'supportsAsync', 'maxExpectedLatencyMs']) {
      const v = inUrl.searchParams.get(k)
      if (v) fwd.set(k, v.slice(0, 200))
    }
    const resp = await fetch(`${REGISTRY_URL}/agents/search?${fwd}`)
    if (!resp.ok) return err(res, 502, 'Registry unavailable', 'REGISTRY_ERROR')
    const data = await resp.json()
    // Merge live metrics into each agent record
    const withMetrics = (data.agents || []).map(a => ({
      ...a,
      ...getMetricsSummary(a.agentId),
    }))

    // Optional reputation-aware ordering (agents with no track record sort last).
    const agents = sortAgentsByReputation(withMetrics, inUrl.searchParams.get('sort'))

    send(res, 200, { count: agents.length, agents })
  } catch (e) {
    console.error('[Backend] Registry list fetch failed:', e.message)
    err(res, 502, 'Registry unavailable', 'REGISTRY_ERROR')
  }
}

async function handleAgent(agentId, res) {
  try {
    const resp = await fetch(`${REGISTRY_URL}/agents/${encodeURIComponent(agentId)}`)
    if (!resp.ok) return err(res, 404, 'Agent not found', 'AGENT_NOT_FOUND')
    const agent = await resp.json()
    send(res, 200, { ...agent, ...getMetricsSummary(agentId) })
  } catch (e) {
    err(res, 502, 'Registry unavailable', 'REGISTRY_ERROR')
  }
}

/**
 * GET /agents/:id/export — portable agent record.
 *
 * Intent: a provider can download a canonical, signed snapshot of their agent's
 * registration to prove off-platform migration. The payload is the minimum
 * transferable record; the signature lets a receiving party verify it was
 * genuinely exported from this platform.
 *
 * Response shape:
 *   {
 *     payload:       { version, agentId, ownerAddress, transport, capabilities, ... },
 *     recordHash:    "<sha256 of canonical payload>",
 *     signature:     "0x<sig>" | null,
 *     signerAddress: "0x<addr>" | null     // platform gateway address
 *   }
 *
 * Unsigned fallback: if the signer is offline, returns payload+recordHash with
 * null signature. Verifier can still compare the hash across deployments.
 */
async function handleAgentExport(agentId, res) {
  try {
    const resp = await fetch(`${REGISTRY_URL}/agents/${encodeURIComponent(agentId)}`)
    if (!resp.ok) return err(res, 404, 'Agent not found', 'AGENT_NOT_FOUND')
    const agent = await resp.json()

    const payload = buildExportPayload(agent)
    const canonicalMsg = canonicalExportMessage(payload)
    const recordHash = createHash('sha256').update(canonicalMsg).digest('hex')
    const signed = await signExportPayload(payload)

    send(res, 200, {
      payload,
      recordHash,
      signature:     signed?.signature     || null,
      signerAddress: signed?.signerAddress || null,
    })
  } catch (e) {
    err(res, 502, 'Registry unavailable', 'REGISTRY_ERROR')
  }
}

function handleDebugAgents(req, res) {
  if (!requireAdmin(req, res)) return
  const cache = Object.fromEntries(
    [...streamCache.entries()].map(([id, v]) => [id, {
      streamId: v.streamId,
      ttlMs: v.expiresAt - Date.now(),
    }])
  )
  send(res, 200, { cache, metrics })
}

async function handleGetBudget(requesterAgentId, res) {
  const budget = getBudget(requesterAgentId)
  if (!budget) return err(res, 404, 'Requester not found', 'NOT_FOUND')
  // Public: redacted to avoid leaking internal limits / daily window
  send(res, 200, {
    requesterAgentId: budget.requesterAgentId,
    currency:         budget.currency,
    remainingBaseUnits: budget.remainingBaseUnits,
  })
}

async function handleGetReceivables(ownerAddress, res) {
  const data = getProviderReceivable(ownerAddress)
  // Public: only expose accrued balance, not individual invocation history
  send(res, 200, {
    ownerAddress:       data.ownerAddress ?? ownerAddress,
    currency:           data.currency,
    accruedBaseUnits:   data.accruedBaseUnits ?? data.balance?.accruedBaseUnits,
  })
}

async function handleGetTask(taskId, req, res) {
  const trace = getTaskTrace(taskId)
  if (!trace.invocation) return err(res, 404, 'Task not found', 'NOT_FOUND')
  // Scoped: requester can see their own tasks via API key or session token
  const rawKey      = req.headers['x-api-key']
  const sessionToken = req.headers['x-session-token']
  if (rawKey) {
    const auth = resolveApiKey(rawKey)
    if (!auth || auth.requesterAgentId !== trace.invocation.requesterAgentId) {
      return err(res, 403, 'Access denied', 'FORBIDDEN')
    }
  } else if (sessionToken) {
    const auth = resolveSession(sessionToken)
    if (!auth || auth.requesterAgentId !== trace.invocation.requesterAgentId) {
      return err(res, 403, 'Access denied', 'FORBIDDEN')
    }
  } else {
    // No requester credential — admin key required
    if (!requireAdmin(req, res)) return
  }
  send(res, 200, trace)
}

// --- Phase B: Funding ---

async function handleCreateFunding(req, res) {
  if (!requireAdmin(req, res)) return
  let body
  try { body = JSON.parse(await readBody(req)) } catch { return err(res, 400, 'Invalid JSON', 'INVALID_JSON') }
  const { requesterAgentId, ownerAddress, currency, amountBaseUnits, sourceType, sourceRef } = body
  if (!requesterAgentId || !ownerAddress || !currency || !amountBaseUnits || !sourceType)
    return err(res, 400, 'requesterAgentId, ownerAddress, currency, amountBaseUnits, sourceType required', 'MISSING_FIELDS')
  try {
    const result = createFundingRecord({ requesterAgentId, ownerAddress, currency, amountBaseUnits, sourceType, sourceRef })
    send(res, 201, result)
  } catch (e) {
    const status = e.code === 'REQUESTER_NOT_FOUND' ? 404 : 422
    err(res, status, e.message, e.code || 'ERROR')
  }
}

async function handleProcessFunding(req, res, fundingId, decision) {
  if (!requireAdmin(req, res)) return
  try {
    const result = processFunding(fundingId, decision)
    send(res, 200, result)
  } catch (e) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'ALREADY_PROCESSED' ? 409 : 400
    err(res, status, e.message, e.code || 'ERROR')
  }
}

async function handleGetFundingHistory(requesterAgentId, res) {
  send(res, 200, { funding: getFundingHistory(requesterAgentId) })
}

async function handleGetAuthMethods(req, requesterAgentId, res) {
  if (!requireAdmin(req, res)) return
  send(res, 200, { requesterAgentId, authMethods: getAuthMethods(requesterAgentId) })
}

// ── D3: wallet challenge + session handlers ────────────────────────────────────

async function handleCreateChallenge(req, res) {
  const winErr = checkWindowLimit(clientKey(req))
  if (winErr) return err(res, 429, winErr.error, winErr.code)
  let body
  try { body = JSON.parse(await readBody(req)) } catch { return err(res, 400, 'Invalid JSON body', 'INVALID_JSON') }
  const { requesterAgentId, ownerAddress } = body
  if (!requesterAgentId || !ownerAddress)
    return err(res, 400, 'requesterAgentId and ownerAddress are required', 'MISSING_FIELDS')
  try {
    send(res, 200, createChallenge({ requesterAgentId, ownerAddress }))
  } catch (e) {
    // Return generic 404 regardless of reason — avoids exposing binding state to unauthenticated callers.
    if (e.code === 'WALLET_NOT_BOUND') return err(res, 404, 'Challenge not available', 'NOT_FOUND')
    throw e
  }
}

async function handleVerifySignature(req, res) {
  const winErr = checkWindowLimit(clientKey(req))
  if (winErr) return err(res, 429, winErr.error, winErr.code)
  let body
  try { body = JSON.parse(await readBody(req)) } catch { return err(res, 400, 'Invalid JSON body', 'INVALID_JSON') }
  const { challengeId, signature } = body
  if (!challengeId || !signature)
    return err(res, 400, 'challengeId and signature are required', 'MISSING_FIELDS')

  const challenge = getChallenge(challengeId)
  if (!challenge) return err(res, 404, 'Challenge not found, expired, or already used', 'CHALLENGE_INVALID')

  let recovered
  try {
    recovered = ethers.verifyMessage(challenge.message, signature)
  } catch {
    return err(res, 400, 'Invalid signature format', 'SIGNATURE_INVALID')
  }
  if (recovered.toLowerCase() !== challenge.ownerAddress.toLowerCase())
    return err(res, 401, 'Signature does not match challenge ownerAddress', 'SIGNATURE_MISMATCH')

  try {
    const session = consumeChallengeAndCreateSession({ challengeId })
    send(res, 200, { sessionToken: session.sessionToken, expiresAt: session.expiresAt })
  } catch (e) {
    if (e.code === 'CHALLENGE_ALREADY_USED' || e.code === 'CHALLENGE_EXPIRED')
      return err(res, 409, e.message, e.code)
    throw e
  }
}

async function handleRevokeSession(req, res) {
  const winErr = checkWindowLimit(clientKey(req))
  if (winErr) return err(res, 429, winErr.error, winErr.code)
  let body
  try { body = JSON.parse(await readBody(req)) } catch { return err(res, 400, 'Invalid JSON body', 'INVALID_JSON') }
  const { sessionToken } = body
  if (!sessionToken) return err(res, 400, 'sessionToken is required', 'MISSING_FIELDS')
  try {
    send(res, 200, revokeSession(sessionToken))
  } catch (e) {
    if (e.code === 'SESSION_NOT_FOUND') return err(res, 404, e.message, e.code)
    throw e
  }
}

// ── Faucet: self-service registration ──────────────────────────────────────

const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{2,48}[a-z0-9]$/
const REG_SIG_WINDOW_MS = 5 * 60 * 1000

function handleRegisterChallenge(req, res) {
  const winErr = checkWindowLimit(clientKey(req))
  if (winErr) return err(res, 429, winErr.error, winErr.code)
  send(res, 200, createPowChallenge())
}

async function handleRegisterRequester(req, res) {
  const winErr = checkWindowLimit(clientKey(req))
  if (winErr) return err(res, 429, winErr.error, winErr.code)

  let body
  try { body = JSON.parse(await readBody(req)) } catch { return err(res, 400, 'Invalid JSON', 'INVALID_JSON') }

  const { requesterAgentId, ownerAddress, timestamp, signature, challengeId, nonce } = body
  if (!requesterAgentId || !ownerAddress || !timestamp || !signature || !challengeId || !nonce)
    return err(res, 400, 'requesterAgentId, ownerAddress, timestamp, signature, challengeId, nonce required', 'MISSING_FIELDS')

  if (!AGENT_ID_RE.test(requesterAgentId))
    return err(res, 400, 'Invalid requesterAgentId format (lowercase alphanumeric, 4-50 chars)', 'INVALID_ID')

  if (Math.abs(Date.now() - timestamp) > REG_SIG_WINDOW_MS)
    return err(res, 400, 'Timestamp out of range (±5 min)', 'TIMESTAMP_EXPIRED')

  // Verify PoW
  try { verifyPow(challengeId, nonce) } catch (e) {
    return err(res, 400, e.message, e.code || 'POW_INVALID')
  }

  // Verify wallet signature
  const message = `savantdex-register-requester:${requesterAgentId}:${ownerAddress.toLowerCase()}:${timestamp}`
  let recovered
  try { recovered = ethers.verifyMessage(message, signature) } catch {
    return err(res, 400, 'Invalid signature format', 'SIGNATURE_INVALID')
  }
  if (recovered.toLowerCase() !== ownerAddress.toLowerCase())
    return err(res, 401, 'Signature does not match ownerAddress', 'SIGNATURE_MISMATCH')

  try {
    const result = selfRegisterRequester({ requesterAgentId, ownerAddress })
    send(res, 201, result)
  } catch (e) {
    if (e.code === 'AGENT_ID_TAKEN' || e.code === 'WALLET_ALREADY_REGISTERED')
      return err(res, 409, e.message, e.code)
    throw e
  }
}

async function handleFaucetClaim(req, res) {
  const winErr = checkWindowLimit(clientKey(req))
  if (winErr) return err(res, 429, winErr.error, winErr.code)

  let body
  try { body = JSON.parse(await readBody(req)) } catch { return err(res, 400, 'Invalid JSON', 'INVALID_JSON') }

  const { requesterAgentId, ownerAddress, timestamp, signature, challengeId, nonce } = body
  if (!requesterAgentId || !ownerAddress || !timestamp || !signature || !challengeId || !nonce)
    return err(res, 400, 'requesterAgentId, ownerAddress, timestamp, signature, challengeId, nonce required', 'MISSING_FIELDS')

  if (Math.abs(Date.now() - timestamp) > REG_SIG_WINDOW_MS)
    return err(res, 400, 'Timestamp out of range (±5 min)', 'TIMESTAMP_EXPIRED')

  // Verify PoW
  try { verifyPow(challengeId, nonce) } catch (e) {
    return err(res, 400, e.message, e.code || 'POW_INVALID')
  }

  // Verify wallet signature
  const message = `savantdex-faucet-claim:${requesterAgentId}:${ownerAddress.toLowerCase()}:${timestamp}`
  let recovered
  try { recovered = ethers.verifyMessage(message, signature) } catch {
    return err(res, 400, 'Invalid signature format', 'SIGNATURE_INVALID')
  }
  if (recovered.toLowerCase() !== ownerAddress.toLowerCase())
    return err(res, 401, 'Signature does not match ownerAddress', 'SIGNATURE_MISMATCH')

  try {
    const result = claimFaucet({ requesterAgentId, ownerAddress })
    send(res, 200, result)
  } catch (e) {
    if (e.code === 'FAUCET_DISABLED')     return err(res, 503, e.message, e.code)
    if (e.code === 'REQUESTER_NOT_FOUND') return err(res, 404, e.message, e.code)
    if (e.code === 'OWNER_MISMATCH')      return err(res, 403, e.message, e.code)
    if (e.code === 'ALREADY_CLAIMED')     return err(res, 409, e.message, e.code)
    throw e
  }
}

function handleGetAuthStats(req, res) {
  if (!requireAdmin(req, res)) return
  send(res, 200, getAuthStats())
}

async function handleAdminBindAuthMethod(req, res, requesterAgentId) {
  if (!requireAdmin(req, res)) return
  let body
  try { body = JSON.parse(await readBody(req)) } catch { return err(res, 400, 'Invalid JSON body', 'INVALID_JSON') }

  const { methodType, ownerAddress } = body
  if (!methodType || !ownerAddress)
    return err(res, 400, 'methodType and ownerAddress are required', 'MISSING_FIELDS')
  if (methodType !== 'wallet-signature')
    return err(res, 400, `Unsupported methodType: ${methodType}`, 'UNSUPPORTED_METHOD_TYPE')

  try {
    const result = bindWalletMethod({ requesterAgentId, ownerAddress })
    send(res, 201, result)
  } catch (e) {
    if (e.code === 'IDENTITY_NOT_FOUND') return err(res, 404, e.message, e.code)
    if (e.code === 'OWNER_MISMATCH')      return err(res, 400, e.message, e.code)
    if (e.code === 'METHOD_ALREADY_EXISTS' || e.code === 'WALLET_ALREADY_BOUND')
      return err(res, 409, e.message, e.code)
    throw e
  }
}

async function handleGetFundingById(req, res, fundingId) {
  if (!requireAdmin(req, res)) return
  const record = getFundingById(fundingId)
  if (!record) return err(res, 404, 'FundingRecord not found', 'NOT_FOUND')
  send(res, 200, record)
}

// --- Phase B: Settlement ---

async function handleCreateSettlement(req, res) {
  if (!requireAdmin(req, res)) return
  let body
  try { body = JSON.parse(await readBody(req)) } catch { return err(res, 400, 'Invalid JSON', 'INVALID_JSON') }
  const { ownerAddress, currency, amountBaseUnits, method, reference } = body
  if (!ownerAddress || !currency || !amountBaseUnits || !method)
    return err(res, 400, 'ownerAddress, currency, amountBaseUnits, method required', 'MISSING_FIELDS')
  try {
    const result = createSettlementRecord({ ownerAddress, currency, amountBaseUnits, method, reference })
    send(res, 201, result)
  } catch (e) {
    const status = e.code === 'EXCEEDS_UNPAID_BALANCE' ? 422 : 400
    err(res, status, e.message, e.code || 'ERROR')
  }
}

async function handleProcessSettlement(req, res, settlementId, decision) {
  if (!requireAdmin(req, res)) return
  try {
    const result = processSettlement(settlementId, decision)
    send(res, 200, result)
  } catch (e) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'ALREADY_PROCESSED' ? 409 : 400
    err(res, status, e.message, e.code || 'ERROR')
  }
}

async function handleGetSettlementHistory(ownerAddress, res) {
  send(res, 200, getSettlementHistory(ownerAddress))
}

async function handleGetSettlementById(req, res, settlementId) {
  if (!requireAdmin(req, res)) return
  const record = getSettlementById(settlementId)
  if (!record) return err(res, 404, 'SettlementRecord not found', 'NOT_FOUND')
  send(res, 200, record)
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req))
      return res.end()
    }

    if (req.method === 'POST' && url.pathname === '/task')          return handleTask(req, res)
    if (req.method === 'GET'  && url.pathname === '/agents')        return handleAgents(req, res)
    if (req.method === 'GET'  && url.pathname.startsWith('/agents/')) {
      const rest = decodeURIComponent(url.pathname.slice('/agents/'.length))
      const exportMatch = rest.match(/^([^/]+)\/export$/)
      if (exportMatch) return handleAgentExport(exportMatch[1], res)
      return handleAgent(rest, res)
    }
    if (req.method === 'GET'  && url.pathname === '/debug/agents')  return handleDebugAgents(req, res)
    if (req.method === 'GET'  && url.pathname === '/health')
      return send(res, 200, { ok: true })

    const receiptMatch = url.pathname.match(/^\/receipts\/([^/]+)$/)
    if (req.method === 'GET' && receiptMatch) {
      const taskId = decodeURIComponent(receiptMatch[1])
      const receipt = getDeliveryReceipt(taskId)
      if (!receipt) return err(res, 404, 'Receipt not found', 'NOT_FOUND')
      return send(res, 200, receipt)
    }

    const budgetMatch = url.pathname.match(/^\/requesters\/([^/]+)\/budget$/)
    if (req.method === 'GET' && budgetMatch)
      return handleGetBudget(decodeURIComponent(budgetMatch[1]), res)

    const fundingHistoryMatch = url.pathname.match(/^\/requesters\/([^/]+)\/funding$/)
    if (req.method === 'GET' && fundingHistoryMatch) {
      if (!requireAdmin(req, res)) return
      return handleGetFundingHistory(decodeURIComponent(fundingHistoryMatch[1]), res)
    }

    const receivablesMatch = url.pathname.match(/^\/providers\/([^/]+)\/receivables$/)
    if (req.method === 'GET' && receivablesMatch)
      return handleGetReceivables(decodeURIComponent(receivablesMatch[1]), res)

    const settlementHistoryMatch = url.pathname.match(/^\/providers\/([^/]+)\/settlements$/)
    if (req.method === 'GET' && settlementHistoryMatch) {
      if (!requireAdmin(req, res)) return
      return handleGetSettlementHistory(decodeURIComponent(settlementHistoryMatch[1]), res)
    }

    const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/)
    if (req.method === 'GET' && taskMatch)
      return handleGetTask(decodeURIComponent(taskMatch[1]), req, res)

    if (req.method === 'POST' && url.pathname === '/register/challenge')
      return handleRegisterChallenge(req, res)
    if (req.method === 'POST' && url.pathname === '/register/requester')
      return handleRegisterRequester(req, res)
    if (req.method === 'POST' && url.pathname === '/faucet/claim')
      return handleFaucetClaim(req, res)

    if (req.method === 'POST' && url.pathname === '/auth/challenge')
      return handleCreateChallenge(req, res)

    if (req.method === 'POST' && url.pathname === '/auth/verify-signature')
      return handleVerifySignature(req, res)

    if (req.method === 'POST' && url.pathname === '/auth/session/revoke')
      return handleRevokeSession(req, res)

    const adminAuthMethodsMatch = url.pathname.match(/^\/admin\/requesters\/([^/]+)\/auth-methods$/)
    if (req.method === 'GET'  && adminAuthMethodsMatch)
      return handleGetAuthMethods(req, decodeURIComponent(adminAuthMethodsMatch[1]), res)
    if (req.method === 'POST' && adminAuthMethodsMatch)
      return handleAdminBindAuthMethod(req, res, decodeURIComponent(adminAuthMethodsMatch[1]))

    if (req.method === 'POST' && url.pathname === '/admin/funding')
      return handleCreateFunding(req, res)

    const fundingCreditMatch = url.pathname.match(/^\/admin\/funding\/([^/]+)\/(credit|reject)$/)
    if (req.method === 'POST' && fundingCreditMatch)
      return handleProcessFunding(req, res, fundingCreditMatch[1], fundingCreditMatch[2] === 'credit' ? 'credited' : 'rejected')

    const fundingByIdMatch = url.pathname.match(/^\/admin\/funding\/([^/]+)$/)
    if (req.method === 'GET' && fundingByIdMatch)
      return handleGetFundingById(req, res, fundingByIdMatch[1])

    if (req.method === 'POST' && url.pathname === '/admin/settlements')
      return handleCreateSettlement(req, res)

    const settlementActionMatch = url.pathname.match(/^\/admin\/settlements\/([^/]+)\/(complete|fail)$/)
    if (req.method === 'POST' && settlementActionMatch)
      return handleProcessSettlement(req, res, settlementActionMatch[1], settlementActionMatch[2] === 'complete' ? 'completed' : 'failed')

    const settlementByIdMatch = url.pathname.match(/^\/admin\/settlements\/([^/]+)$/)
    if (req.method === 'GET' && settlementByIdMatch)
      return handleGetSettlementById(req, res, settlementByIdMatch[1])

    if (req.method === 'GET' && url.pathname === '/admin/auth-stats')
      return handleGetAuthStats(req, res)

    if (req.method === 'GET' && url.pathname === '/admin/relay/status') {
      if (!requireAdmin(req, res)) return
      return send(res, 200, { connectedAgents: relayAgentCount(), agents: getRelayConnections() })
    }

    return err(res, 404, 'Not found', 'NOT_FOUND')
  } catch (e) {
    console.error('[Backend] Unhandled request error:', e.message)
    return err(res, 500, 'Internal server error', 'INTERNAL_ERROR')
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Backend] API server running on 127.0.0.1:${PORT}`)
  console.log(`  POST /task                                      - Submit task`)
  console.log(`  GET  /agents                                    - List agents`)
  console.log(`  GET  /agents/:id                                - Single agent`)
  console.log(`  GET  /debug/agents                              - Cache + metrics dump`)
  console.log(`  GET  /health                                    - Health check`)
  console.log(`  GET  /requesters/:id/budget                     - Requester budget`)
  console.log(`  GET  /requesters/:id/funding                    - Requester funding history`)
  console.log(`  GET  /providers/:addr/receivables               - Provider receivables (accrued/settled/unpaid)`)
  console.log(`  GET  /providers/:addr/settlements               - Provider settlement history`)
  console.log(`  GET  /tasks/:taskId                             - Task trace`)
  console.log(`  GET  /receipts/:taskId                          - Signed delivery receipt (Phase 1)`)
  console.log(`  GET  /agents/:id/export                         - Portable signed agent record`)
  console.log(`  POST /register/challenge                        - PoW challenge for self-registration`)
  console.log(`  POST /register/requester                        - Self-register requester (wallet sig + PoW)`)
  console.log(`  POST /faucet/claim                              - Claim faucet grant (10 DATA, once per requester)`)
  console.log(`  POST /auth/challenge                            - Request wallet auth challenge`)
  console.log(`  POST /auth/verify-signature                     - Verify signature, get session token`)
  console.log(`  POST /auth/session/revoke                       - Revoke session token`)
  console.log(`  GET  /admin/requesters/:id/auth-methods         - [admin] List auth methods`)
  console.log(`  POST /admin/requesters/:id/auth-methods         - [admin] Bind wallet to requester identity`)
  console.log(`  GET  /admin/auth-stats                          - [admin] Auth method usage stats`)
  console.log(`  POST /admin/funding                             - [admin] Create funding record`)
  console.log(`  POST /admin/funding/:id/credit                  - [admin] Credit funding`)
  console.log(`  POST /admin/funding/:id/reject                  - [admin] Reject funding`)
  console.log(`  GET  /admin/funding/:id                         - [admin] Get funding record`)
  console.log(`  POST /admin/settlements                         - [admin] Create settlement record`)
  console.log(`  POST /admin/settlements/:id/complete            - [admin] Complete settlement`)
  console.log(`  POST /admin/settlements/:id/fail                - [admin] Fail settlement`)
  console.log(`  GET  /admin/settlements/:id                     - [admin] Get settlement record`)
  console.log(`  GET  /admin/relay/status                        - [admin] Relay connections`)
  console.log(`  WS   /ws/agent                                 - WebSocket relay for providers`)
  console.log(`  Payment: ${PAYMENT_ENABLED ? 'ENABLED' : 'DISABLED (set PAYMENT_ENABLED=true)'}`)
  console.log(`  Admin:   ${ADMIN_API_KEY ? 'ENABLED (X-Admin-Key required)' : 'NOT CONFIGURED (set ADMIN_API_KEY)'}`)

  // Initialize WebSocket relay on the same HTTP server
  initRelay(server, { registryUrl: REGISTRY_URL })
})

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[Backend] ${signal} received — shutting down gracefully`)

  // Hard deadline so a stuck connection or hang can't block exit forever.
  const forceTimer = setTimeout(() => {
    console.warn('[Backend] Graceful shutdown timed out — forcing exit')
    process.exit(1)
  }, 10_000)
  forceTimer.unref()

  try {
    // Stop accepting new HTTP connections and drain in-flight requests.
    await new Promise((resolve) => server.close(resolve))
    // Tear down the relay (heartbeat, connections, ws server).
    shutdownRelay()
    // Persist the latest metrics and release the Streamr client.
    saveMetrics()
    await gateway.destroy()
  } catch (e) {
    console.error(`[Backend] Error during shutdown: ${e.message}`)
  } finally {
    clearTimeout(forceTimer)
    process.exit(0)
  }
}
