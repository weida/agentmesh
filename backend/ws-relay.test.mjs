/**
 * ws-relay.mjs — unit / integration tests
 *
 * Run: node backend/ws-relay.test.mjs
 *
 * Spins up a real HTTP server with the relay attached, then exercises:
 *   1. Auth success (valid signature)
 *   2. Auth rejected — missing fields
 *   3. Auth rejected — expired timestamp
 *   4. Auth rejected — nonce replay
 *   5. Auth rejected — signature mismatch (wrong key)
 *   6. Auth rejected — agent not in registry
 *   7. Auth timeout (no auth message sent)
 *   8. Supersede — new connection evicts old
 *   9. Task routing — relayTask → result → resolve
 *  10. Task timeout — relayTask rejects on timeout
 *  11. Heartbeat pong handling
 *  12. Disconnect — in-flight tasks reject
 *  13. handleMessage — invalid JSON ignored
 *  14. handleMessage — unknown message type ignored
 */

import http from 'http'
import assert from 'assert/strict'
import { Wallet } from 'ethers'
import WebSocket from 'ws'
import { randomBytes } from 'crypto'
import {
  initRelay, getRelayStatus, relayTask, relayAgentCount, getRelayConnections,
} from './ws-relay.mjs'

// ── Fake registry ────────────────────────────────────────────────────────────

const AGENT_ID = 'test-agent-v1'
const wallet = Wallet.createRandom()
const OWNER = wallet.address.toLowerCase()

// Spin up a tiny registry stub that returns the expected owner for AGENT_ID
const registryServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === `/agents/${AGENT_ID}`) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ownerAddress: OWNER }))
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  }
})

await new Promise(r => registryServer.listen(0, '127.0.0.1', r))
const REGISTRY_PORT = registryServer.address().port
const REGISTRY_URL = `http://127.0.0.1:${REGISTRY_PORT}`

// ── Gateway server with relay ────────────────────────────────────────────────

const gwServer = http.createServer((req, res) => {
  res.writeHead(404)
  res.end()
})
await new Promise(r => gwServer.listen(0, '127.0.0.1', r))
const GW_PORT = gwServer.address().port
const WS_URL = `ws://127.0.0.1:${GW_PORT}/ws/agent`

initRelay(gwServer, {
  registryUrl: REGISTRY_URL,
  heartbeatMs: 2000,       // fast heartbeat for testing
  authTimeoutMs: 1500,
})

// ── Helpers ──────────────────────────────────────────────────────────────────

async function buildAuth(agentId = AGENT_ID, signer = wallet, ts = Date.now()) {
  const nonce = randomBytes(16).toString('hex')
  const address = signer.address.toLowerCase()
  const message = `savantdex-relay:${agentId}:${address}:${ts}:${nonce}`
  const signature = await signer.signMessage(message)
  return { type: 'auth', agentId, ownerAddress: address, timestamp: ts, nonce, signature }
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('WS connect timeout')), 5000)
  })
}

function waitMsg(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitMsg timeout')), timeoutMs)
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString())
      if (predicate(msg)) {
        clearTimeout(timer)
        ws.removeListener('message', handler)
        resolve(msg)
      }
    }
    ws.on('message', handler)
  })
}

async function authedWs(agentId = AGENT_ID, signer = wallet) {
  const ws = await connectWs()
  const authMsg = await buildAuth(agentId, signer)
  const authOkP = waitMsg(ws, m => m.type === 'auth_ok')
  ws.send(JSON.stringify(authMsg))
  await authOkP
  return ws
}

function close(ws) {
  return new Promise(r => {
    if (!ws || ws.readyState > 1) return r()
    ws.on('close', r)
    ws.close()
    setTimeout(r, 1000) // safety
  })
}

let passed = 0
let failed = 0

function test(name, fn) {
  return fn()
    .then(() => { console.log(`  ✓ ${name}`); passed++ })
    .catch(e => { console.error(`  ✗ ${name}: ${e.message}`); failed++ })
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\n=== ws-relay.mjs tests ===\n')

// 1. Auth success
await test('auth success — valid signature', async () => {
  const ws = await authedWs()
  const status = getRelayStatus(AGENT_ID)
  assert.ok(status.connected, 'should be connected')
  assert.equal(status.ownerAddress, OWNER)
  assert.equal(relayAgentCount(), 1)
  await close(ws)
  // Wait for disconnect to propagate
  await new Promise(r => setTimeout(r, 200))
})

// 2. Auth rejected — missing fields
await test('auth rejected — missing fields', async () => {
  const ws = await connectWs()
  const errP = waitMsg(ws, m => m.type === 'auth_error')
  ws.send(JSON.stringify({ type: 'auth', agentId: AGENT_ID })) // missing ownerAddress, etc.
  const msg = await errP
  assert.ok(msg.error.includes('Missing'), `expected "Missing" in error, got: ${msg.error}`)
  await close(ws)
})

// 3. Auth rejected — expired timestamp
await test('auth rejected — expired timestamp', async () => {
  const ws = await connectWs()
  const errP = waitMsg(ws, m => m.type === 'auth_error')
  const auth = await buildAuth(AGENT_ID, wallet, Date.now() - 120_000) // 2min ago
  ws.send(JSON.stringify(auth))
  const msg = await errP
  assert.ok(msg.error.includes('Timestamp'), `expected timestamp error, got: ${msg.error}`)
  await close(ws)
})

// 4. Nonce replay
await test('auth rejected — nonce replay', async () => {
  const nonce = randomBytes(16).toString('hex')
  const ts = Date.now()
  const address = wallet.address.toLowerCase()
  const message = `savantdex-relay:${AGENT_ID}:${address}:${ts}:${nonce}`
  const signature = await wallet.signMessage(message)
  const authPayload = { type: 'auth', agentId: AGENT_ID, ownerAddress: address, timestamp: ts, nonce, signature }

  // First use: should succeed
  const ws1 = await connectWs()
  const okP = waitMsg(ws1, m => m.type === 'auth_ok')
  ws1.send(JSON.stringify(authPayload))
  await okP
  await close(ws1)
  await new Promise(r => setTimeout(r, 200))

  // Replay: exact same payload
  const ws2 = await connectWs()
  const errP = waitMsg(ws2, m => m.type === 'auth_error')
  ws2.send(JSON.stringify(authPayload))
  const msg = await errP
  assert.ok(msg.error.includes('Nonce'), `expected nonce error, got: ${msg.error}`)
  await close(ws2)
})

// 5. Signature mismatch — wrong key
await test('auth rejected — signature mismatch', async () => {
  const wrongWallet = Wallet.createRandom()
  const ws = await connectWs()
  const errP = waitMsg(ws, m => m.type === 'auth_error')
  // Sign with wrong key but claim to be OWNER
  const ts = Date.now()
  const nonce = randomBytes(16).toString('hex')
  const message = `savantdex-relay:${AGENT_ID}:${OWNER}:${ts}:${nonce}`
  const signature = await wrongWallet.signMessage(message)
  ws.send(JSON.stringify({ type: 'auth', agentId: AGENT_ID, ownerAddress: OWNER, timestamp: ts, nonce, signature }))
  const msg = await errP
  assert.ok(msg.error.includes('mismatch') || msg.error.includes('Signature'), `expected sig error, got: ${msg.error}`)
  await close(ws)
})

// 6. Agent not in registry
await test('auth rejected — agent not in registry', async () => {
  const ws = await connectWs()
  const errP = waitMsg(ws, m => m.type === 'auth_error')
  const auth = await buildAuth('nonexistent-agent-v1', wallet)
  ws.send(JSON.stringify(auth))
  const msg = await errP
  assert.ok(msg.error.includes('not found') || msg.error.includes('registry'), `expected registry error, got: ${msg.error}`)
  await close(ws)
})

// 7. Auth timeout
await test('auth timeout — no auth message', async () => {
  const ws = await connectWs()
  const closeP = new Promise((resolve) => {
    ws.on('close', (code) => resolve(code))
  })
  const code = await closeP
  assert.equal(code, 4001, `expected close code 4001, got ${code}`)
})

// 8. Supersede
await test('supersede — new connection evicts old', async () => {
  const ws1 = await authedWs()
  const supersededP = waitMsg(ws1, m => m.type === 'superseded')
  const ws2 = await authedWs()

  const msg = await supersededP
  assert.ok(msg.type === 'superseded')

  // ws2 is the active one
  const status = getRelayStatus(AGENT_ID)
  assert.ok(status.connected)

  await close(ws1)
  await close(ws2)
  await new Promise(r => setTimeout(r, 200))
})

// 8b. Supersede regression — the OLD connection's late 'close' event must not
// tear down the NEW connection. Before the fix, handleDisconnect(agentId) fired
// by the old ws would delete the freshly-registered replacement connection,
// leaving the agent effectively dead after a reconnect.
await test('supersede — new connection survives old connection close', async () => {
  const ws1 = await authedWs()
  const supersededP = waitMsg(ws1, m => m.type === 'superseded')
  const ws2 = await authedWs()
  await supersededP

  // Ensure the old ws is fully closed and its server-side 'close' handler has
  // run before we exercise the new connection.
  await close(ws1)
  await new Promise(r => setTimeout(r, 300))

  // The replacement connection must still be registered and routable.
  assert.ok(getRelayStatus(AGENT_ID).connected, 'new connection still connected after old closed')

  ws2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'task') {
      ws2.send(JSON.stringify({ type: 'result', taskId: msg.taskId, output: { ok: true } }))
    }
    if (msg.type === 'ping') ws2.send(JSON.stringify({ type: 'pong', ts: msg.ts }))
  })

  const res = await relayTask(AGENT_ID, 'task-supersede-1', 'test-type', { q: 1 }, 5000)
  assert.deepEqual(res.output, { ok: true }, 'task routed to surviving connection')

  await close(ws2)
  await new Promise(r => setTimeout(r, 200))
})

// 8b. Supersede regression — the OLD connection's late 'close' event must not
// tear down the NEW connection. Before the fix, handleDisconnect(agentId) fired
// by the old ws would delete the freshly-registered replacement connection,
// leaving the agent effectively dead after a reconnect.
await test('supersede — new connection survives old connection close', async () => {
  const ws1 = await authedWs()
  const supersededP = waitMsg(ws1, m => m.type === 'superseded')
  const ws2 = await authedWs()
  await supersededP

  // Make sure the old ws is fully closed and its 'close' handler has run
  // server-side before we exercise the new connection.
  await close(ws1)
  await new Promise(r => setTimeout(r, 300))

  // The replacement connection must still be registered and routable.
  assert.ok(getRelayStatus(AGENT_ID).connected, 'new connection still connected after old closed')

  ws2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'task') {
      ws2.send(JSON.stringify({ type: 'result', taskId: msg.taskId, output: { ok: true } }))
    }
    if (msg.type === 'ping') ws2.send(JSON.stringify({ type: 'pong', ts: msg.ts }))
  })

  const res = await relayTask(AGENT_ID, 'task-supersede-1', 'test-type', { q: 1 }, 5000)
  assert.deepEqual(res.output, { ok: true }, 'task routed to surviving connection')

  await close(ws2)
  await new Promise(r => setTimeout(r, 200))
})
await test('task routing — relayTask resolves on result', async () => {
  const ws = await authedWs()
  // Set up handler for incoming tasks
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'task') {
      ws.send(JSON.stringify({ type: 'result', taskId: msg.taskId, output: { answer: 42 } }))
    }
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }))
    }
  })

  const res = await relayTask(AGENT_ID, 'task-001', 'test-type', { q: 'hello' }, 5000)
  assert.deepEqual(res.output, { answer: 42 })
  assert.equal(res.attestation, null, 'no attestation when stub omits it')

  await close(ws)
  await new Promise(r => setTimeout(r, 200))
})

// 10. Task timeout
await test('task timeout — relayTask rejects', async () => {
  const ws = await authedWs()
  // Handler ignores tasks (simulates slow agent)
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }))
  })

  try {
    await relayTask(AGENT_ID, 'task-timeout', 'test-type', {}, 500)
    assert.fail('should have timed out')
  } catch (e) {
    assert.ok(e.message.includes('Timeout'), `expected timeout error, got: ${e.message}`)
  }

  await close(ws)
  await new Promise(r => setTimeout(r, 200))
})

// 11. Task error propagation
await test('task error — relayTask rejects with agent error', async () => {
  const ws = await authedWs()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'task') {
      ws.send(JSON.stringify({ type: 'result', taskId: msg.taskId, error: 'agent exploded' }))
    }
    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }))
  })

  try {
    await relayTask(AGENT_ID, 'task-err', 'test-type', {}, 5000)
    assert.fail('should have rejected')
  } catch (e) {
    assert.equal(e.message, 'agent exploded')
  }

  await close(ws)
  await new Promise(r => setTimeout(r, 200))
})

// 12. Disconnect — in-flight tasks reject
await test('disconnect — in-flight tasks reject', async () => {
  const ws = await authedWs()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }))
    // Don't respond to tasks
  })

  const taskP = relayTask(AGENT_ID, 'task-dc', 'test-type', {}, 10000)
  // Close from client side after a tick
  await new Promise(r => setTimeout(r, 100))
  ws.close()

  try {
    await taskP
    assert.fail('should have rejected')
  } catch (e) {
    assert.ok(e.message.includes('disconnected') || e.message.includes('superseded'),
      `expected disconnect error, got: ${e.message}`)
  }
  await new Promise(r => setTimeout(r, 200))
})

// 13. getRelayConnections snapshot
await test('getRelayConnections returns connection info', async () => {
  const ws = await authedWs()
  const conns = getRelayConnections()
  assert.equal(conns.length, 1)
  assert.equal(conns[0].agentId, AGENT_ID)
  assert.equal(conns[0].ownerAddress, OWNER)
  assert.equal(typeof conns[0].connectedAt, 'number')
  await close(ws)
  await new Promise(r => setTimeout(r, 200))
})

// 14. relayTask rejects when agent not connected
await test('relayTask rejects when agent offline', async () => {
  assert.equal(getRelayStatus(AGENT_ID).connected, false, 'should be disconnected')
  try {
    await relayTask(AGENT_ID, 'task-off', 'test-type', {}, 1000)
    assert.fail('should have rejected')
  } catch (e) {
    assert.ok(e.message.includes('not connected'), `expected not connected, got: ${e.message}`)
  }
})

// ── Teardown ─────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)

gwServer.close()
registryServer.close()
process.exit(failed > 0 ? 1 : 0)
