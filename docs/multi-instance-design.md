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

#### Option A — implementation contract

No application code changes. The invariant the deployment must guarantee:

> **All HTTP `/task` requests for an agent, and that agent's `/ws/agent`
> WebSocket, are routed to the same backend instance.**

Because `relayTask` looks the agent up in the instance-local `connections`
map, the task and the connection only meet when they land on the same
instance. The routing key is the **`agentId`**.

The challenge: the `agentId` lives in different places for the two request
types:

- **WebSocket connect** (`/ws/agent`): the agent sends `agentId` inside the
  first `auth` message — *after* the connection is established. An L4/L7 LB
  cannot see it at routing time.
- **HTTP `/task`**: `agentId` is in the JSON body — also not in the URL.

Two ways to make `agentId` routable without touching the protocol:

1. **Expose `agentId` in the connect URL / header.** Have providers connect to
   `wss://host/ws/agent?agentId=<id>` (the SDK already knows it) and requesters
   send `/task?agentId=<id>` or an `X-Agent-Id` header. Configure the LB to hash
   that field to a backend (e.g. nginx `hash $arg_agentId consistent;` in an
   upstream block, or an Envoy/HAProxy consistent-hash policy). Consistent
   hashing minimizes reshuffling when instances scale.
2. **Dedicated relay tier.** Run the WebSocket relay as its own horizontally
   sharded service, sharded by `agentId`, with the HTTP API forwarding tasks to
   the shard that owns the agent (a thin version of Option B, but only between
   API tier and relay tier).

Recommended: option 1 with consistent hashing on `agentId`. It needs only LB
config and a one-line SDK/requester change to surface `agentId` in the URL —
no server logic change.

Operational notes:

- Health checks must not be hashed by `agentId` (use `/health` on every
  instance directly).
- On instance add/remove, consistent hashing reshuffles a fraction of agents;
  those agents' WebSockets drop and the SDK's auto-reconnect (with the fatal
  vs. transient close-code handling already in place) re-establishes them on
  the new owner. In-flight tasks on a moved agent fail and must be retried by
  the requester — acceptable, and already how a single-instance restart behaves.
- The shared StateStore (nonces, rate limits) is unaffected by routing; it is
  consulted regardless of which instance handles a request.

This section is a **deployment guide**, not a code change. Option B remains the
fallback if `agentId` load skew makes sticky routing impractical.

## Rollout

1. **[done]** Land the `StateStore` abstraction with `MemoryStore` as default —
   **no behavior change**, covered by contract tests (`state-store.test.mjs`).
2. **[in progress]** Wire call sites onto the store:
   - **[done]** Relay auth nonces — `ws-relay.mjs` now claims each
     `${timestamp}:${nonce}` via `store.setIfAbsent` (atomic, cross-instance).
   - **[done]** Request rate window — `server.mjs` `checkWindowLimit` uses
     `store.incrWithWindow` (fixed-window, approximate global). The in-flight
     concurrency cap stays local by design.
   - **[done]** PoW register challenges — `createPowChallengeWithStore` /
     `verifyPowWithStore` persist the challenge in the shared store and enforce
     single-use atomically via `setIfAbsent`. The backend gateway uses these;
     the in-memory `createPowChallenge` / `verifyPow` are kept for SDK/external
     callers and the registry (single registry process, so process-local is
     fine). Covered by `pow-store.test.mjs`.
   - **[done]** `RedisStore` implementing the `StateStore` contract, selected
     via `STATE_BACKEND=redis`. The `redis` client is a backend
     optionalDependency, loaded lazily so memory-mode installs never need it.
     Bounded reconnect + connect timeout so a dead Redis fails fast instead of
     hanging request promises. CI runs the shared contract against a live Redis
     service container (`redis-store` job, `REDIS_TEST_URL`).
3. **[documented]** Relay routing (item 4): Option A sticky routing — see the
   "Option A — implementation contract" section above. Deployment/LB guide, no
   code change required.

Each step is independently shippable and the default path stays single-instance
with zero new dependencies.

## Risks

- Redis becomes a new availability dependency in multi-instance mode. Mitigate:
  memory mode remains default; Redis only required when `STATE_BACKEND=redis`.
- Approximate rate limiting can allow brief bursts above the limit across
  instances. Acceptable for abuse-prevention purposes.
- Option B (if pursued) needs careful timeout/ownership handling when the owner
  instance disconnects mid-task — reuse the existing `failAllInFlight` semantics.
