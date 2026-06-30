# Multi-Instance Gateway — Design Proposal

Status: **Draft for review** · Scope: horizontal scaling of the backend gateway

## Problem

The gateway keeps several pieces of state in process memory. With a single
instance this is correct and fast. The moment a second gateway instance runs
behind a load balancer, these in-memory maps stop being a shared source of
truth and break correctness or security.

### State inventory

| State | Location | Backing today | Multi-instance effect |
|---|---|---|---|
| Relay auth nonces | `ws-relay.mjs` `usedNonces` | in-memory Map | **Replay protection bypass** — a valid auth message replayed to a *different* instance is accepted |
| Relay connections | `ws-relay.mjs` `connections` | in-memory Map | A task can only be delivered by the instance holding the agent's WebSocket |
| PoW register challenges | `sdk/pow.mjs` `challenges` | in-memory Map | Challenge issued by instance A fails verification on instance B |
| Rate-limit windows | `server.mjs` `rlWindow` / `inFlight` | in-memory Map | Effective limit multiplied by instance count; per-client cap not enforced globally |
| Stream/card cache | `server.mjs` `streamCache` | in-memory Map (TTL) | Each instance caches independently — only a few extra registry reads; **acceptable** |
| Wallet sessions | `payment.mjs` `RequesterSession` | **SQLite (shared)** | Already correct ✓ |
| Register/auth challenges | `payment.mjs` `WalletAuthChallenge` | **SQLite (shared)** | Already correct ✓ |
| Provider/budget ledger | `payment.mjs` | **SQLite (shared)** | Already correct ✓ |

Key insight: the *payment* layer was already designed for shared state. The
gaps are concentrated in the **relay transport** and the **PoW/rate-limit**
helpers.

## Goals

1. No replay-protection regression when running N instances.
2. A task addressed to any connected agent reaches that agent regardless of
   which instance received the HTTP request.
3. Rate limits enforced approximately globally.
4. Minimal new operational surface; keep single-instance deployment a
   first-class, zero-dependency mode.

## Non-goals

- Replacing SQLite for the ledger (out of scope; it already shares fine via a
  single DB file / networked DB).
- Exactly-once global rate limiting (approximate is sufficient).

## Approach

### Shared store abstraction

Introduce a small `StateStore` interface with two implementations selected by
env (`STATE_BACKEND=memory|redis`, default `memory`):

- `MemoryStore` — current behavior, single instance, zero dependencies.
- `RedisStore` — backed by Redis for multi-instance.

Operations needed are deliberately tiny:

```
setIfAbsent(key, value, ttlMs) -> boolean   // nonce / challenge dedup (atomic SET NX PX)
get(key) / set(key, value, ttlMs)           // challenge payloads
incrWithWindow(key, windowMs) -> count       // rate limiting
publish(channel, msg) / subscribe(channel)   // cross-instance task routing
```

This keeps the blast radius small and lets the memory mode stay the default.

### 1. Relay nonces (high — security)

Replace `usedNonces` Map with `store.setIfAbsent(nonceKey, '1', TIMESTAMP_WINDOW_MS)`.
Redis `SET key val NX PX ttl` is atomic, so a replay to any instance fails.
Memory mode keeps the existing Map.

### 2. PoW register challenges (medium)

`createPowChallenge` writes the challenge to the store with TTL; `verifyPow`
reads + marks-used atomically (`SET NX` on a `:used` marker). Any instance can
issue and any instance can verify. Memory mode unchanged.

### 3. Rate limiting (medium)

Replace the per-instance sliding window with `store.incrWithWindow(clientKey,
RL_WINDOW_MS)` (Redis `INCR` + `PEXPIRE`). Approximate global enforcement;
memory mode keeps the local window. The in-flight concurrency cap stays local
(it bounds *this* instance's inbox, which is the right granularity).

### 4. Relay connection routing (high — functional)

The hard one: a WebSocket lives on exactly one instance. Two viable designs:

**Option A — Sticky routing by agentId (recommended first step).**
The load balancer / a thin router maps `agentId → instance`. Simpler: agents
connect through a path that hashes `agentId` to a backend. No cross-instance
hop. Downside: uneven load if a few agents are very hot; rebalancing on
instance changes.

**Option B — Pub/sub task forwarding.**
Each instance records `agentId → instanceId` in the store on connect. When an
instance receives a task for an agent it doesn't hold, it publishes the task on
the owner instance's channel and awaits the result via a correlation id.
More flexible, but adds a network hop and failure modes (owner instance dies
mid-task). `relayTask`'s existing `{resolve, reject, timer}` model maps cleanly
onto a request/response over pub/sub.

Recommendation: ship **Option A** first (no code change to relayTask, pure
infra), measure, and only build Option B if load skew demands it.

## Rollout

1. Land the `StateStore` abstraction with `MemoryStore` as default — **no
   behavior change**, fully covered by existing tests.
2. Add `RedisStore` + wire nonces, PoW challenges, rate limiting (items 1–3).
   Gate behind `STATE_BACKEND=redis`. Add integration tests against a Redis
   container in CI.
3. Relay routing (item 4): start with Option A sticky routing at the LB; document
   the agentId→instance contract.

Each step is independently shippable and the default path stays single-instance
with zero new dependencies.

## Risks

- Redis becomes a new availability dependency in multi-instance mode. Mitigate:
  memory mode remains default; Redis only required when `STATE_BACKEND=redis`.
- Approximate rate limiting can allow brief bursts above the limit across
  instances. Acceptable for abuse-prevention purposes.
- Option B (if pursued) needs careful timeout/ownership handling when the owner
  instance disconnects mid-task — reuse the existing `failAllInFlight` semantics.
