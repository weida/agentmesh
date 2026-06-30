/**
 * state-store.mjs — MemoryStore contract tests.
 * Run: node --test backend/state-store.test.mjs
 *
 * These tests define the StateStore contract; a future RedisStore should pass
 * the same assertions.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, createStateStore } from './state-store.mjs'

function newStore() {
  // Disable the background sweep; tests drive expiry by time directly.
  return new MemoryStore({ sweepIntervalMs: 0 })
}

test('setIfAbsent: first claim wins, second is rejected', async () => {
  const s = newStore()
  assert.equal(await s.setIfAbsent('n1', '1', 60_000), true, 'first claim succeeds')
  assert.equal(await s.setIfAbsent('n1', '1', 60_000), false, 'replay rejected')
  s.close()
})

test('setIfAbsent: claim is allowed again after TTL expiry', async () => {
  const s = newStore()
  assert.equal(await s.setIfAbsent('n2', '1', 5), true)
  await new Promise(r => setTimeout(r, 12))
  assert.equal(await s.setIfAbsent('n2', '1', 5), true, 'expired key can be reclaimed')
  s.close()
})

test('get/set: returns value before expiry, null after', async () => {
  const s = newStore()
  await s.set('k', 'payload', 50)
  assert.equal(await s.get('k'), 'payload')
  await new Promise(r => setTimeout(r, 60))
  assert.equal(await s.get('k'), null, 'expired value reads as null')
  s.close()
})

test('get: missing key returns null', async () => {
  const s = newStore()
  assert.equal(await s.get('nope'), null)
  s.close()
})

test('del: removes a key', async () => {
  const s = newStore()
  await s.set('k', 'v', 60_000)
  await s.del('k')
  assert.equal(await s.get('k'), null)
  s.close()
})

test('incrWithWindow: counts within a window, resets after it', async () => {
  const s = newStore()
  assert.equal(await s.incrWithWindow('rl', 50), 1)
  assert.equal(await s.incrWithWindow('rl', 50), 2)
  assert.equal(await s.incrWithWindow('rl', 50), 3)
  await new Promise(r => setTimeout(r, 60))
  assert.equal(await s.incrWithWindow('rl', 50), 1, 'counter resets after window')
  s.close()
})

test('incrWithWindow: independent keys do not interfere', async () => {
  const s = newStore()
  await s.incrWithWindow('a', 1000)
  await s.incrWithWindow('a', 1000)
  assert.equal(await s.incrWithWindow('b', 1000), 1, 'separate key starts fresh')
  s.close()
})

test('createStateStore returns a MemoryStore by default', () => {
  const s = createStateStore({ sweepIntervalMs: 0 })
  assert.ok(s instanceof MemoryStore)
  s.close()
})
