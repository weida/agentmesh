/**
 * MemoryStore — runs the shared StateStore contract.
 * Run: node --test backend/state-store.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, createStateStore } from './state-store.mjs'
import { assertStoreContract } from './store-contract.mjs'

test('MemoryStore satisfies the StateStore contract', async (t) => {
  const store = new MemoryStore({ sweepIntervalMs: 0 })
  await assertStoreContract(t, store, 'mem')
  store.close()
})

test('createStateStore returns a MemoryStore by default', () => {
  const s = createStateStore({ sweepIntervalMs: 0 })
  assert.ok(s instanceof MemoryStore)
  s.close()
})
