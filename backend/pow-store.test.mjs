/**
 * Store-backed PoW (multi-instance) tests.
 * Run: node --test backend/pow-store.test.mjs
 *
 * Verifies createPowChallengeWithStore / verifyPowWithStore against a
 * MemoryStore — the same path the gateway uses, and the path a RedisStore
 * makes cross-instance.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPowChallengeWithStore, verifyPowWithStore, solvePow } from '../sdk/pow.mjs'
import { MemoryStore } from './state-store.mjs'

const DIFFICULTY = 8 // low — fast to solve in tests

function store() { return new MemoryStore({ sweepIntervalMs: 0 }) }

test('issue -> solve -> verify succeeds', async () => {
  const s = store()
  const c = await createPowChallengeWithStore(s, DIFFICULTY)
  assert.ok(c.challengeId && c.prefix)
  assert.equal(c.difficulty, DIFFICULTY)
  const nonce = solvePow(c.prefix, c.difficulty)
  await verifyPowWithStore(s, c.challengeId, nonce) // must not throw
  s.close()
})

test('replay of the same challenge is rejected (single-use)', async () => {
  const s = store()
  const c = await createPowChallengeWithStore(s, DIFFICULTY)
  const nonce = solvePow(c.prefix, c.difficulty)
  await verifyPowWithStore(s, c.challengeId, nonce)
  await assert.rejects(
    () => verifyPowWithStore(s, c.challengeId, nonce),
    (e) => e.code === 'POW_INVALID' && /already used/.test(e.message),
  )
  s.close()
})

test('wrong nonce is rejected', async () => {
  const s = store()
  const c = await createPowChallengeWithStore(s, DIFFICULTY)
  await assert.rejects(
    () => verifyPowWithStore(s, c.challengeId, 'not-a-solution'),
    (e) => e.code === 'POW_INVALID',
  )
  s.close()
})

test('unknown challenge id is rejected', async () => {
  const s = store()
  await assert.rejects(
    () => verifyPowWithStore(s, 'no-such-challenge', '0'),
    (e) => e.code === 'POW_INVALID' && /not found/.test(e.message),
  )
  s.close()
})

test('cross-instance: challenge issued via one store handle verifies via another sharing state', async () => {
  // Simulate two instances pointing at the same backing store by sharing the
  // same MemoryStore instance between two logical call sites.
  const shared = store()
  const issued = await createPowChallengeWithStore(shared, DIFFICULTY)
  const nonce = solvePow(issued.prefix, issued.difficulty)
  // "Other instance" verifies using the same shared store.
  await verifyPowWithStore(shared, issued.challengeId, nonce)
  shared.close()
})
