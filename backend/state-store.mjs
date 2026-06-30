/**
 * StateStore — small shared-state abstraction for multi-instance gateways.
 *
 * Single-instance deployments use MemoryStore (the default) and gain nothing
 * new operationally — same in-process maps as before. Multi-instance
 * deployments select a networked backend (e.g. Redis) so that replay-protection
 * nonces, PoW challenges, and rate-limit windows are shared across instances.
 *
 * The surface is intentionally tiny — only what the gateway actually needs:
 *
 *   setIfAbsent(key, value, ttlMs) -> Promise<boolean>
 *       Atomic "claim once". Returns true if the key was absent and is now set
 *       (claim succeeded), false if it already existed. Used for nonce and
 *       challenge single-use semantics.
 *
 *   get(key) -> Promise<string|null>
 *   set(key, value, ttlMs) -> Promise<void>
 *       Plain TTL'd key/value, for challenge payloads.
 *
 *   incrWithWindow(key, windowMs) -> Promise<number>
 *       Increment a counter that expires windowMs after first increment.
 *       Returns the new count. Used for approximate global rate limiting.
 *
 * All methods are async so a networked backend can implement the same
 * interface without changing call sites.
 *
 * Backend selection: STATE_BACKEND=memory (default). A 'redis' backend can be
 * added later implementing this same shape; call sites do not change.
 */

import { RedisStore } from './redis-store.mjs'

const STATE_BACKEND = process.env.STATE_BACKEND || 'memory'

/**
 * In-process implementation. Behaviorally identical to the maps it replaces,
 * including lazy expiry on access plus a periodic sweep so the maps do not grow
 * unbounded under churn.
 */
export class MemoryStore {
  #kv = new Map()       // key -> { value, expiresAt }
  #counters = new Map() // key -> { count, expiresAt }
  #sweepTimer = null

  constructor({ sweepIntervalMs = 60_000 } = {}) {
    if (sweepIntervalMs > 0) {
      this.#sweepTimer = setInterval(() => this.#sweep(), sweepIntervalMs)
      this.#sweepTimer.unref?.()
    }
  }

  #sweep(now = Date.now()) {
    for (const [k, e] of this.#kv) if (e.expiresAt <= now) this.#kv.delete(k)
    for (const [k, e] of this.#counters) if (e.expiresAt <= now) this.#counters.delete(k)
  }

  async setIfAbsent(key, value, ttlMs) {
    const now = Date.now()
    const existing = this.#kv.get(key)
    if (existing && existing.expiresAt > now) return false
    this.#kv.set(key, { value, expiresAt: now + ttlMs })
    return true
  }

  async get(key) {
    const e = this.#kv.get(key)
    if (!e) return null
    if (e.expiresAt <= Date.now()) { this.#kv.delete(key); return null }
    return e.value
  }

  async set(key, value, ttlMs) {
    this.#kv.set(key, { value, expiresAt: Date.now() + ttlMs })
  }

  async del(key) {
    this.#kv.delete(key)
  }

  async incrWithWindow(key, windowMs) {
    const now = Date.now()
    const e = this.#counters.get(key)
    if (!e || e.expiresAt <= now) {
      // Window starts now; expires windowMs from the first increment.
      this.#counters.set(key, { count: 1, expiresAt: now + windowMs })
      return 1
    }
    e.count += 1
    return e.count
  }

  /** Stop the sweep timer (for clean shutdown / tests). */
  close() {
    if (this.#sweepTimer) { clearInterval(this.#sweepTimer); this.#sweepTimer = null }
  }
}

/**
 * Create the configured store. Defaults to MemoryStore. STATE_BACKEND=redis
 * selects RedisStore (the `redis` package is an optionalDependency, loaded
 * lazily by RedisStore on first use — not at import time).
 */
export function createStateStore(opts = {}) {
  switch (STATE_BACKEND) {
    case 'memory':
      return new MemoryStore(opts)
    case 'redis':
      return new RedisStore(opts)
    default:
      console.warn(`[StateStore] Unknown STATE_BACKEND="${STATE_BACKEND}", falling back to memory`)
      return new MemoryStore(opts)
  }
}
