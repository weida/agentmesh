/**
 * SavantDex WebSocket Relay Server
 *
 * Allows provider agents to connect via outbound WebSocket instead of
 * running a full Streamr P2P node.  The gateway acts as a hub, routing
 * tasks to connected agents and returning results.
 *
 * Protocol messages (JSON over WebSocket):
 *
 *   Client → Server:
 *     { type: "auth",   agentId, ownerAddress, timestamp, signature }
 *     { type: "pong",   ts }
 *     { type: "result", taskId, output }          — success
 *     { type: "result", taskId, error }            — failure
 *
 *   Server → Client:
 *     { type: "auth_ok",    sessionId, heartbeatIntervalMs }
 *     { type: "auth_error", error }
 *     { type: "ping",       ts }
 *     { type: "task",       taskId, taskType, input, timeoutMs }
 *     { type: "task_cancel", taskId }
 *     { type: "superseded", reason }
 *
 * Security:
 *   - EIP-191 wallet signature with domain-separated canonical message
 *   - Timestamp window ±60 s (replay protection)
 *   - ownerAddress verified against registry
 *   - Single connection per agentId (new connection supersedes old)
 *   - Max WebSocket frame size enforced
 */

import { WebSocketServer } from 'ws'
import { ethers } from 'ethers'
import { randomBytes } from 'crypto'
import { createStateStore } from './state-store.mjs'

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_HEARTBEAT_MS    = 30_000
const DEFAULT_AUTH_TIMEOUT_MS = 10_000
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024  // 256 KiB
const TIMESTAMP_WINDOW_MS     = 60_000
const CLOSE_AUTH_TIMEOUT      = 4001
const CLOSE_AUTH_EXPECTED      = 4002
const CLOSE_TIMESTAMP_RANGE   = 4003
const CLOSE_SIGNATURE_MISMATCH = 4004
const CLOSE_REGISTRY_MISMATCH = 4005
const CLOSE_SUPERSEDED        = 4010
const CLOSE_HEARTBEAT_TIMEOUT = 4020

// ── State ────────────────────────────────────────────────────────────────────

// agentId → { ws, ownerAddress, connectedAt, lastPong, inFlight: Map<taskId, {resolve, reject, timer}> }
const connections = new Map()

// Nonce dedup: `${timestamp}:${nonce}` → expiry (ms since epoch)
// Replay protection for relay auth: a `${timestamp}:${nonce}` key is claimed
// once via store.setIfAbsent. Backed by the shared StateStore so the guard
// holds across gateway instances (memory store in single-instance mode).
let store = null

let registryUrl = ''
let heartbeatMs = DEFAULT_HEARTBEAT_MS
let heartbeatInterval = null
let wss = null

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the relay layer.  Attaches a WebSocketServer to the existing
 * HTTP server on the /ws/agent path.
 *
 * @param {import('http').Server} httpServer
 * @param {object} opts
 * @param {string}  opts.registryUrl
 * @param {number}  [opts.heartbeatMs=30000]
 * @param {number}  [opts.authTimeoutMs=10000]
 * @param {number}  [opts.maxFrameBytes=262144]
 */
export function initRelay(httpServer, opts) {
  registryUrl = opts.registryUrl
  heartbeatMs = opts.heartbeatMs || DEFAULT_HEARTBEAT_MS
  store = opts.store || createStateStore()
  const authTimeoutMs = opts.authTimeoutMs || DEFAULT_AUTH_TIMEOUT_MS
  const maxFrameBytes = opts.maxFrameBytes || DEFAULT_MAX_FRAME_BYTES

  const wssLocal = new WebSocketServer({
    server: httpServer,
    path: '/ws/agent',
    maxPayload: maxFrameBytes,
  })
  wss = wssLocal

  wssLocal.on('connection', (ws) => {
    handleNewConnection(ws, authTimeoutMs)
  })

  // Heartbeat sweep
  heartbeatInterval = setInterval(() => {
    const now = Date.now()
    for (const [agentId, conn] of connections) {
      if (now - conn.lastPong > heartbeatMs * 2.5) {
        console.warn(`[Relay] Heartbeat timeout: ${agentId}`)
        conn.ws.close(CLOSE_HEARTBEAT_TIMEOUT, 'Heartbeat timeout')
        handleDisconnect(agentId)
        continue
      }
      trySend(conn.ws, { type: 'ping', ts: now })
    }
  }, heartbeatMs)

  console.log(`[Relay] Initialized on /ws/agent (heartbeat ${heartbeatMs}ms, max frame ${maxFrameBytes}B)`)
}

/**
 * Gracefully shut the relay down: stop the heartbeat sweep, fail any in-flight
 * tasks, close every agent connection, and close the WebSocketServer. Safe to
 * call multiple times. Used by the server's SIGINT/SIGTERM handler.
 */
export function shutdownRelay() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
  }
  for (const [agentId, conn] of connections) {
    failAllInFlight(agentId, 'Server shutting down')
    try { conn.ws.close(1001, 'Server shutting down') } catch { /* closing already */ }
  }
  connections.clear()
  if (wss) {
    try { wss.close() } catch { /* already closed */ }
    wss = null
  }
}

/**
 * Check if an agent is connected via relay.
 * @param {string} agentId
 * @returns {{ connected: boolean, ownerAddress?: string }}
 */
export function getRelayStatus(agentId) {
  const conn = connections.get(agentId)
  if (!conn) return { connected: false }
  return { connected: true, ownerAddress: conn.ownerAddress }
}

/**
 * Send a task to a relay-connected agent and wait for the result.
 * @param {string} agentId
 * @param {string} taskId
 * @param {string} taskType
 * @param {object} input
 * @param {number} timeoutMs
 * @returns {Promise<{ output: object, attestation: ({payload: object, signature: string}|null) }>}
 */
export function relayTask(agentId, taskId, taskType, input, timeoutMs) {
  const conn = connections.get(agentId)
  if (!conn) return Promise.reject(new Error(`Agent ${agentId} not connected via relay`))

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.inFlight.delete(taskId)
      // Send best-effort cancel
      trySend(conn.ws, { type: 'task_cancel', taskId })
      reject(new Error(`Timeout waiting for ${taskId}`))
    }, timeoutMs)

    conn.inFlight.set(taskId, { resolve, reject, timer })
    trySend(conn.ws, { type: 'task', taskId, taskType, input, timeoutMs })
  })
}

/**
 * Number of currently connected relay agents.
 * @returns {number}
 */
export function relayAgentCount() {
  return connections.size
}

/**
 * Snapshot of all relay connections for admin endpoint.
 * @returns {Array<{ agentId: string, ownerAddress: string, connectedAt: number, inFlightCount: number, lastPong: number }>}
 */
export function getRelayConnections() {
  const result = []
  for (const [agentId, conn] of connections) {
    result.push({
      agentId,
      ownerAddress: conn.ownerAddress,
      connectedAt: conn.connectedAt,
      inFlightCount: conn.inFlight.size,
      lastPong: conn.lastPong,
    })
  }
  return result
}

// ── Connection lifecycle ─────────────────────────────────────────────────────

function handleNewConnection(ws, authTimeoutMs) {
  // Auth timeout — must send auth within authTimeoutMs
  const authTimer = setTimeout(() => {
    trySend(ws, { type: 'auth_error', error: 'Auth timeout' })
    ws.close(CLOSE_AUTH_TIMEOUT, 'Auth timeout')
  }, authTimeoutMs)

  let authed = false

  ws.on('message', async (raw) => {
    // Before auth, only accept auth message
    if (!authed) {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        clearTimeout(authTimer)
        trySend(ws, { type: 'auth_error', error: 'Invalid JSON' })
        ws.close(CLOSE_AUTH_EXPECTED, 'Invalid JSON')
        return
      }

      if (msg.type !== 'auth') {
        clearTimeout(authTimer)
        trySend(ws, { type: 'auth_error', error: 'Expected auth message' })
        ws.close(CLOSE_AUTH_EXPECTED, 'Expected auth message')
        return
      }

      const result = await validateAuth(msg)
      if (!result.ok) {
        clearTimeout(authTimer)
        trySend(ws, { type: 'auth_error', error: result.error })
        ws.close(result.code, result.error)
        return
      }

      // Auth succeeded
      clearTimeout(authTimer)
      authed = true
      const { agentId, ownerAddress } = msg

      // Supersede existing connection
      if (connections.has(agentId)) {
        const old = connections.get(agentId)
        trySend(old.ws, { type: 'superseded', reason: 'New connection from same agent' })
        old.ws.close(CLOSE_SUPERSEDED, 'Superseded')
        failAllInFlight(agentId, 'Connection superseded')
        connections.delete(agentId)
      }

      const now = Date.now()
      connections.set(agentId, {
        ws,
        ownerAddress: ownerAddress.toLowerCase(),
        connectedAt: now,
        lastPong: now,
        inFlight: new Map(),
      })

      const sessionId = randomBytes(8).toString('hex')
      trySend(ws, { type: 'auth_ok', sessionId, heartbeatIntervalMs: heartbeatMs })

      console.log(`[Relay] Agent connected: ${agentId} (owner: ${ownerAddress})`)

      // Switch to normal message handling
      ws.removeAllListeners('message')
      ws.on('message', (data) => handleMessage(agentId, data))
      ws.on('close', () => handleDisconnect(agentId, ws))
      ws.on('error', (e) => {
        console.warn(`[Relay] WebSocket error for ${agentId}: ${e.message}`)
      })

      return
    }
  })

  ws.on('error', () => {
    // Pre-auth error — just clean up
    clearTimeout(authTimer)
  })
}

async function validateAuth(msg) {
  const { agentId, ownerAddress, timestamp, nonce, signature } = msg

  if (!agentId || !ownerAddress || !timestamp || !nonce || !signature) {
    return { ok: false, error: 'Missing auth fields', code: CLOSE_AUTH_EXPECTED }
  }

  // Timestamp check
  if (Math.abs(Date.now() - timestamp) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, error: 'Timestamp out of range', code: CLOSE_TIMESTAMP_RANGE }
  }

  // Nonce dedup — atomic claim-once via the shared store. Returns false if this
  // `${timestamp}:${nonce}` was already used within the timestamp window, which
  // catches replays even across gateway instances.
  const nonceKey = `relay-nonce:${timestamp}:${nonce}`
  const claimed = await store.setIfAbsent(nonceKey, '1', TIMESTAMP_WINDOW_MS)
  if (!claimed) {
    return { ok: false, error: 'Nonce already used', code: CLOSE_AUTH_EXPECTED }
  }

  // Signature verification
  const canonical = `savantdex-relay:${agentId}:${ownerAddress.toLowerCase()}:${timestamp}:${nonce}`
  let recovered
  try {
    recovered = ethers.verifyMessage(canonical, signature)
  } catch {
    return { ok: false, error: 'Invalid signature', code: CLOSE_SIGNATURE_MISMATCH }
  }

  if (recovered.toLowerCase() !== ownerAddress.toLowerCase()) {
    return { ok: false, error: 'Signature mismatch', code: CLOSE_SIGNATURE_MISMATCH }
  }

  // Registry verification
  try {
    const res = await fetch(`${registryUrl}/agents/${encodeURIComponent(agentId)}`)
    if (!res.ok) {
      return { ok: false, error: 'Agent not found in registry', code: CLOSE_REGISTRY_MISMATCH }
    }
    const record = await res.json()
    const registeredOwner = (record.ownerAddress || '').toLowerCase()
    if (registeredOwner !== ownerAddress.toLowerCase()) {
      return { ok: false, error: 'Owner address does not match registry', code: CLOSE_REGISTRY_MISMATCH }
    }
  } catch (e) {
    console.error(`[Relay] Registry check failed for ${agentId}: ${e.message}`)
    return { ok: false, error: 'Registry unavailable', code: CLOSE_REGISTRY_MISMATCH }
  }

  return { ok: true }
}

function handleMessage(agentId, raw) {
  const conn = connections.get(agentId)
  if (!conn) return

  let msg
  try {
    msg = JSON.parse(raw.toString())
  } catch {
    console.warn(`[Relay] Invalid JSON from ${agentId}`)
    return
  }

  if (msg.type === 'pong') {
    conn.lastPong = Date.now()
    return
  }

  if (msg.type === 'result') {
    if (!msg.taskId) return
    const pending = conn.inFlight.get(msg.taskId)
    if (!pending) return

    clearTimeout(pending.timer)
    conn.inFlight.delete(msg.taskId)

    if (msg.error) {
      pending.reject(new Error(msg.error))
    } else {
      pending.resolve({ output: msg.output, attestation: msg.attestation || null })
    }
    return
  }

  // Unknown message type — ignore
}

function handleDisconnect(agentId, expectedWs = null) {
  const conn = connections.get(agentId)
  if (!conn) return

  // Guard against a superseded connection's late 'close' event tearing down the
  // replacement connection. When an agent reconnects, the old ws is closed but
  // its close event fires asynchronously — by then connections.get(agentId)
  // already points at the NEW connection. Only clean up if the closing ws is
  // still the one we have on record.
  if (expectedWs && conn.ws !== expectedWs) return

  failAllInFlight(agentId, 'Agent disconnected')
  connections.delete(agentId)

  console.log(`[Relay] Agent disconnected: ${agentId}`)
}

function failAllInFlight(agentId, reason) {
  const conn = connections.get(agentId)
  if (!conn) return
  for (const [taskId, pending] of conn.inFlight) {
    clearTimeout(pending.timer)
    pending.reject(new Error(reason))
  }
  conn.inFlight.clear()
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function trySend(ws, obj) {
  try {
    if (ws.readyState === 1) {  // WebSocket.OPEN
      ws.send(JSON.stringify(obj))
    }
  } catch {
    // Swallow — connection may be closing
  }
}
