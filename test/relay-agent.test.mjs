/**
 * RelayAgent integration test — exercises the task-handling loop against a
 * local WebSocketServer stub to verify provider attestation is attached to
 * the result message with a recoverable signature.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { Wallet, verifyMessage } from 'ethers'
import { RelayAgent } from '../sdk/relay-agent.mjs'
import { canonicalAttestationMessage } from '../sdk/attestation.mjs'
import { computeResultHash } from '../sdk/canonical.mjs'

test('RelayAgent attaches signed attestation on result', async () => {
  const wallet = Wallet.createRandom()
  const wss    = new WebSocketServer({ port: 0 })
  const port   = wss.address().port

  const received = new Promise((resolve) => {
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'auth') {
          ws.send(JSON.stringify({ type: 'auth_ok' }))
          ws.send(JSON.stringify({
            type: 'task', taskId: 't-1', taskType: 'echo',
            input: { x: 1 }, timeoutMs: 5000,
          }))
        }
        if (msg.type === 'result') resolve(msg)
      })
    })
  })

  const agent = new RelayAgent({
    gatewayUrl: `ws://127.0.0.1:${port}`,
    signer:     wallet,
    agentId:    'test-agent-v1',
  })
  agent.onTask(async () => ({ ok: true, value: 42 }))
  await agent.connect()

  const msg = await received
  assert.equal(msg.taskId, 't-1')
  assert.deepEqual(msg.output, { ok: true, value: 42 })
  assert.ok(msg.attestation, 'attestation present')
  assert.equal(msg.attestation.payload.taskId, 't-1')
  assert.equal(msg.attestation.payload.providerAgentId, 'test-agent-v1')
  assert.equal(
    msg.attestation.payload.resultHash,
    computeResultHash({ ok: true, value: 42 }),
  )

  const recovered = verifyMessage(
    canonicalAttestationMessage(msg.attestation.payload),
    msg.attestation.signature,
  )
  assert.equal(recovered.toLowerCase(), wallet.address.toLowerCase())

  agent.disconnect?.()
  wss.close()
})

test('RelayAgent does not reconnect after a fatal auth close code', async () => {
  const wallet = Wallet.createRandom()
  const wss    = new WebSocketServer({ port: 0 })
  const port   = wss.address().port

  let connectionCount = 0
  wss.on('connection', (ws) => {
    connectionCount++
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'auth') {
        // Establish the session, then drop it with a fatal registry-mismatch
        // code (4005). The agent must NOT reconnect — retrying with the same
        // credentials would loop forever.
        ws.send(JSON.stringify({ type: 'auth_ok', sessionId: 'fatal-test', heartbeatIntervalMs: 30000 }))
        setTimeout(() => ws.close(4005, 'Owner address does not match registry'), 50)
      }
    })
  })

  const agent = new RelayAgent({
    gatewayUrl: `ws://127.0.0.1:${port}`,
    signer:     wallet,
    agentId:    'fatal-agent-v1',
  })
  agent.onTask(async () => ({}))
  await agent.connect()

  // Wait well past the initial 1s reconnect backoff window.
  await new Promise(r => setTimeout(r, 1500))

  assert.equal(connectionCount, 1, 'no reconnect attempt after fatal auth close')

  agent.disconnect?.()
  wss.close()
})
