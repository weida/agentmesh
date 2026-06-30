/**
 * GatewayRequester unit tests (no network — global fetch is stubbed).
 *
 * Focus: wallet-auth session lifecycle, specifically the "re-auth happens
 * automatically" contract when the gateway rejects a cached session with 401.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayRequester } from '../sdk/gateway-requester.mjs'

// Minimal signer stub: records how many times it was asked to sign.
function makeSigner(address = '0xabc0000000000000000000000000000000000abc') {
  let signCount = 0
  return {
    address,
    get signCount() { return signCount },
    async signMessage(_msg) { signCount++; return '0xsig' },
  }
}

// Build a fetch stub from a route table. Each handler returns { status, body }.
function stubFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url)
    const key = `${opts.method || 'GET'} ${u.pathname}`
    calls.push({ key, headers: opts.headers || {} })
    const handler = routes[key]
    if (!handler) throw new Error(`unexpected fetch: ${key}`)
    const { status, body } = handler(calls.length)
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return body },
      async text() { return JSON.stringify(body) },
    }
  }
  return calls
}

const ORIGINAL_FETCH = globalThis.fetch

function client() {
  return GatewayRequester.create({
    gatewayUrl: 'https://gw.test',
    requesterAgentId: 'req-test',
    ownerAddress: '0xabc0000000000000000000000000000000000abc',
    signer: makeSigner(),
  })
}

test('wallet auth: stale session 401 triggers automatic re-auth and retry', async (t) => {
  t.after(() => { globalThis.fetch = ORIGINAL_FETCH })

  const future = new Date(Date.now() + 15 * 60 * 1000).toISOString()
  let taskHits = 0

  const calls = stubFetch({
    'GET /agents/agent-x': () => ({ status: 200, body: { callHint: { taskType: 'do-x' } } }),
    'POST /auth/challenge': () => ({ status: 200, body: { challengeId: 'c1', message: 'sign me' } }),
    'POST /auth/verify-signature': () => ({ status: 200, body: { sessionToken: 'tok', expiresAt: future } }),
    'POST /task': () => {
      taskHits++
      // First call: pretend the cached session is stale → 401.
      if (taskHits === 1) return { status: 401, body: { error: 'expired', code: 'UNAUTHORIZED' } }
      return { status: 200, body: { taskId: 't1', result: { ok: true } } }
    },
  })

  const c = client()
  const result = await c.run('agent-x', { foo: 1 })

  assert.equal(result.status, 'completed')
  assert.deepEqual(result.output, { ok: true })

  // Two /task attempts, and authentication ran twice (initial + after 401).
  assert.equal(taskHits, 2, 'task retried once after 401')
  const challenges = calls.filter(c => c.key === 'POST /auth/challenge').length
  assert.equal(challenges, 2, 're-authenticated after stale session')
})

test('wallet auth: persistent 401 surfaces the error after one retry', async (t) => {
  t.after(() => { globalThis.fetch = ORIGINAL_FETCH })

  const future = new Date(Date.now() + 15 * 60 * 1000).toISOString()
  let taskHits = 0

  stubFetch({
    'GET /agents/agent-x': () => ({ status: 200, body: { callHint: { taskType: 'do-x' } } }),
    'POST /auth/challenge': () => ({ status: 200, body: { challengeId: 'c1', message: 'm' } }),
    'POST /auth/verify-signature': () => ({ status: 200, body: { sessionToken: 'tok', expiresAt: future } }),
    'POST /task': () => { taskHits++; return { status: 401, body: { error: 'nope', code: 'UNAUTHORIZED' } } },
  })

  const c = client()
  await assert.rejects(() => c.run('agent-x', { foo: 1 }), /nope/)
  assert.equal(taskHits, 2, 'retried exactly once, then gave up')
})

test('api-key auth: 401 is NOT retried (no session to refresh)', async (t) => {
  t.after(() => { globalThis.fetch = ORIGINAL_FETCH })

  let taskHits = 0
  stubFetch({
    'GET /agents/agent-x': () => ({ status: 200, body: { callHint: { taskType: 'do-x' } } }),
    'POST /task': () => { taskHits++; return { status: 401, body: { error: 'bad key', code: 'UNAUTHORIZED' } } },
  })

  const c = GatewayRequester.create({ gatewayUrl: 'https://gw.test', apiKey: 'sk-bad' })
  await assert.rejects(() => c.run('agent-x', { foo: 1 }), /bad key/)
  assert.equal(taskHits, 1, 'api-key auth does not retry on 401')
})
