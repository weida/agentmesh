/**
 * RedisStore — networked StateStore backend for multi-instance gateways.
 *
 * Implements the same contract as MemoryStore (see state-store.mjs) backed by
 * Redis, so replay-nonces and rate-limit windows are shared across every
 * gateway instance pointing at the same Redis.
 *
 * Loaded only when STATE_BACKEND=redis, via dynamic import from
 * createStateStore() — the `redis` package is an optionalDependency, so
 * single-instance (memory) deployments never need it installed.
 *
 * Connection: pass an already-created node-redis client, or let the store
 * create one from REDIS_URL (default redis://127.0.0.1:6379). The store
 * connects lazily on first use so construction never blocks or throws.
 *
 * Atomicity:
 *   setIfAbsent   -> SET key val NX PX ttl            (native atomic claim-once)
 *   incrWithWindow-> Lua: INCR + PEXPIRE-on-first-hit (atomic counter+window)
 */

// Lua: increment a counter and, only when it is created (value becomes 1), set
// its expiry. Returns the new count. Atomic — no read/modify/write race.
const INCR_WINDOW_LUA = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return v
`

export class RedisStore {
  #client
  #connecting = null
  #ready = false

  /**
   * @param {object} [opts]
   * @param {object} [opts.client]  pre-created node-redis client (else built from url)
   * @param {string} [opts.url]     redis connection url (default REDIS_URL or localhost)
   */
  constructor({ client = null, url = process.env.REDIS_URL || 'redis://127.0.0.1:6379' } = {}) {
    this.#client = client
    this.#url = url
  }

  #url

  async #ensureClient() {
    if (this.#ready && this.#client?.isOpen) return this.#client
    if (!this.#connecting) {
      this.#connecting = (async () => {
        if (!this.#client) {
          // Dynamic import keeps `redis` an optional dependency.
          const { createClient } = await import('redis')
          this.#client = createClient({
            url: this.#url,
            socket: {
              connectTimeout: 5_000,
              // Bounded reconnect: give up after a handful of attempts so a
              // dead Redis surfaces as a fast error instead of hanging request
              // promises forever. Returning an Error stops reconnection.
              reconnectStrategy: (retries) =>
                retries > 5 ? new Error('Redis unreachable') : Math.min(retries * 200, 2_000),
            },
          })
          this.#client.on('error', (e) => console.error(`[RedisStore] client error: ${e.message}`))
        }
        if (!this.#client.isOpen) await this.#client.connect()
        this.#ready = true
        return this.#client
      })().catch((e) => {
        // Reset so a later call can retry instead of being stuck on a rejected
        // promise forever. Discard the dead client.
        this.#connecting = null
        this.#ready = false
        try { this.#client?.destroy?.() } catch { /* ignore */ }
        this.#client = null
        throw e
      })
    }
    return this.#connecting
  }

  async setIfAbsent(key, value, ttlMs) {
    const c = await this.#ensureClient()
    // SET ... NX PX returns 'OK' when set, null when the key already existed.
    const res = await c.set(key, value, { NX: true, PX: ttlMs })
    return res === 'OK'
  }

  async get(key) {
    const c = await this.#ensureClient()
    const v = await c.get(key)
    return v == null ? null : v
  }

  async set(key, value, ttlMs) {
    const c = await this.#ensureClient()
    await c.set(key, value, { PX: ttlMs })
  }

  async del(key) {
    const c = await this.#ensureClient()
    await c.del(key)
  }

  async incrWithWindow(key, windowMs) {
    const c = await this.#ensureClient()
    const count = await c.eval(INCR_WINDOW_LUA, { keys: [key], arguments: [String(windowMs)] })
    return Number(count)
  }

  /** Close the connection (clean shutdown / tests). */
  async close() {
    if (this.#client && this.#client.isOpen) {
      try { await this.#client.quit() } catch { /* already closing */ }
    }
    this.#ready = false
    this.#connecting = null
  }
}
