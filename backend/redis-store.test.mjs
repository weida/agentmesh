/**
 * RedisStore — runs the SAME shared StateStore contract as MemoryStore.
 * Run: REDIS_TEST_URL=redis://127.0.0.1:6379 node --test backend/redis-store.test.mjs
 *
 * Skipped unless REDIS_TEST_URL is set (and the `redis` package is installed),
 * so the suite stays green in environments without Redis. CI provides a Redis
 * service container and sets REDIS_TEST_URL to exercise this.
 */

import { test } from 'node:test'
import { assertStoreContract } from './store-contract.mjs'

const REDIS_TEST_URL = process.env.REDIS_TEST_URL

test('RedisStore satisfies the StateStore contract', { skip: !REDIS_TEST_URL && 'REDIS_TEST_URL not set' }, async (t) => {
  const { RedisStore } = await import('./redis-store.mjs')
  const store = new RedisStore({ url: REDIS_TEST_URL })
  // Namespace keys with a timestamp so reruns against a shared Redis don't collide.
  await assertStoreContract(t, store, `redis-test:${Date.now()}`)
  await store.close()
})
