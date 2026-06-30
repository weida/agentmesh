/**
 * Shared StateStore contract assertions, exercised by both MemoryStore and
 * RedisStore tests so the two backends are guaranteed to behave identically.
 *
 * Each check uses unique key prefixes so it is safe to run against a shared
 * Redis without cross-test interference.
 */

import assert from 'node:assert/strict'

/**
 * @param {object} t       node:test context (for t.test subtests)
 * @param {function} makeStore  () => StateStore  (fresh-ish store per call)
 * @param {string} prefix  unique key namespace for this run
 */
export async function assertStoreContract(t, store, prefix) {
  const k = (s) => `${prefix}:${s}`

  await t.test('setIfAbsent: first claim wins, replay rejected', async () => {
    assert.equal(await store.setIfAbsent(k('nonce'), '1', 60_000), true)
    assert.equal(await store.setIfAbsent(k('nonce'), '1', 60_000), false)
  })

  await t.test('setIfAbsent: reclaimable after TTL', async () => {
    assert.equal(await store.setIfAbsent(k('ttl'), '1', 30), true)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(await store.setIfAbsent(k('ttl'), '1', 30), true)
  })

  await t.test('get/set: value before expiry, null after', async () => {
    await store.set(k('kv'), 'payload', 40)
    assert.equal(await store.get(k('kv')), 'payload')
    await new Promise(r => setTimeout(r, 60))
    assert.equal(await store.get(k('kv')), null)
  })

  await t.test('get: missing key returns null', async () => {
    assert.equal(await store.get(k('absent')), null)
  })

  await t.test('del: removes a key', async () => {
    await store.set(k('d'), 'v', 60_000)
    await store.del(k('d'))
    assert.equal(await store.get(k('d')), null)
  })

  await t.test('incrWithWindow: counts in window, resets after', async () => {
    assert.equal(await store.incrWithWindow(k('rl'), 50), 1)
    assert.equal(await store.incrWithWindow(k('rl'), 50), 2)
    await new Promise(r => setTimeout(r, 70))
    assert.equal(await store.incrWithWindow(k('rl'), 50), 1)
  })

  await t.test('incrWithWindow: independent keys', async () => {
    await store.incrWithWindow(k('a'), 1000)
    assert.equal(await store.incrWithWindow(k('b'), 1000), 1)
  })
}
