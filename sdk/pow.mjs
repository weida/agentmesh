/**
 * Proof of Work challenge/verify for self-service registration.
 *
 * Challenge: server issues { challengeId, prefix, difficulty }.
 * Client finds nonce such that SHA-256(prefix + nonce) has `difficulty` leading zero bits.
 * At difficulty=20 (~1M hashes), this takes ~1-2s on typical hardware.
 *
 * Challenges are ephemeral (in-memory, 5-min TTL, single-use).
 */

import { createHash, randomBytes, randomUUID } from 'crypto'

const POW_DIFFICULTY = Number(process.env.POW_DIFFICULTY) || 20
const CHALLENGE_TTL_MS = 5 * 60 * 1000  // 5 minutes

const challenges = new Map()  // challengeId → { prefix, difficulty, createdAt, used }

// ── Public API ───────────────────────────────────────────────────────────────

export function createPowChallenge(difficulty = POW_DIFFICULTY) {
  const challengeId = randomUUID()
  const prefix = randomBytes(16).toString('hex')
  challenges.set(challengeId, { prefix, difficulty, createdAt: Date.now(), used: false })
  return { challengeId, prefix, difficulty }
}

/**
 * Client-side PoW solver. Finds a nonce such that SHA-256(prefix + nonce) has
 * `difficulty` leading zero bits. Synchronous and CPU-bound (~1-2s at
 * difficulty 20). Shared by the SDK register() helpers and verifier scripts so
 * the solving logic lives in exactly one place.
 *
 * @param {string} prefix      challenge prefix from createPowChallenge()
 * @param {number} difficulty  required leading zero bits
 * @returns {string} the solving nonce (as a string, matching wire format)
 */
export function solvePow(prefix, difficulty) {
  const fullBytes = Math.floor(difficulty / 8)
  const remainBits = difficulty % 8
  const mask = remainBits > 0 ? (0xFF << (8 - remainBits)) & 0xFF : 0
  for (let nonce = 0; ; nonce++) {
    const hash = createHash('sha256').update(prefix + String(nonce)).digest()
    let ok = true
    for (let i = 0; i < fullBytes; i++) { if (hash[i] !== 0) { ok = false; break } }
    if (ok && remainBits > 0 && (hash[fullBytes] & mask) !== 0) ok = false
    if (ok) return String(nonce)
  }
}

export function verifyPow(challengeId, nonce) {
  const entry = challenges.get(challengeId)
  if (!entry) {
    const e = new Error('Challenge not found or expired')
    e.code = 'POW_INVALID'; throw e
  }
  if (entry.used) {
    const e = new Error('Challenge already used')
    e.code = 'POW_INVALID'; throw e
  }
  if (Date.now() - entry.createdAt > CHALLENGE_TTL_MS) {
    challenges.delete(challengeId)
    const e = new Error('Challenge expired')
    e.code = 'POW_INVALID'; throw e
  }
  if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 20) {
    const e = new Error('Invalid nonce')
    e.code = 'POW_INVALID'; throw e
  }

  const hash = createHash('sha256').update(entry.prefix + nonce).digest()
  if (!hasLeadingZeroBits(hash, entry.difficulty)) {
    const e = new Error('PoW solution incorrect')
    e.code = 'POW_INVALID'; throw e
  }

  entry.used = true
}

// ── Store-backed variants (multi-instance) ────────────────────────────────────
//
// The in-memory variants above are per-process: a challenge issued by one
// gateway instance cannot be verified by another. These variants persist the
// challenge in a shared StateStore (see backend/state-store.mjs) so any
// instance can issue and any instance can verify, with single-use enforced
// atomically. The store object must implement { set, get, setIfAbsent }.

const CHALLENGE_KEY = (id) => `pow-challenge:${id}`
const USED_KEY      = (id) => `pow-used:${id}`

/** Validate a PoW solution against a known prefix/difficulty. Returns boolean. */
function checkSolution(prefix, difficulty, nonce) {
  if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 20) return false
  const hash = createHash('sha256').update(prefix + nonce).digest()
  return hasLeadingZeroBits(hash, difficulty)
}

/**
 * Store-backed challenge creation. Persists { prefix, difficulty } under a
 * TTL'd key so any instance can later verify it.
 * @returns {Promise<{ challengeId, prefix, difficulty }>}
 */
export async function createPowChallengeWithStore(store, difficulty = POW_DIFFICULTY) {
  const challengeId = randomUUID()
  const prefix = randomBytes(16).toString('hex')
  await store.set(CHALLENGE_KEY(challengeId), JSON.stringify({ prefix, difficulty }), CHALLENGE_TTL_MS)
  return { challengeId, prefix, difficulty }
}

/**
 * Store-backed verification. Throws { code: 'POW_INVALID' } on any failure.
 * Single-use is enforced via setIfAbsent on a per-challenge "used" marker, so
 * a concurrent double-submit (even to different instances) is rejected.
 */
export async function verifyPowWithStore(store, challengeId, nonce) {
  const raw = await store.get(CHALLENGE_KEY(challengeId))
  if (!raw) {
    const e = new Error('Challenge not found or expired'); e.code = 'POW_INVALID'; throw e
  }
  let entry
  try { entry = JSON.parse(raw) } catch {
    const e = new Error('Challenge corrupt'); e.code = 'POW_INVALID'; throw e
  }
  if (!checkSolution(entry.prefix, entry.difficulty, nonce)) {
    const e = new Error('PoW solution incorrect'); e.code = 'POW_INVALID'; throw e
  }
  // Atomic claim-once: the first verifier to mark this challenge used wins.
  const claimed = await store.setIfAbsent(USED_KEY(challengeId), '1', CHALLENGE_TTL_MS)
  if (!claimed) {
    const e = new Error('Challenge already used'); e.code = 'POW_INVALID'; throw e
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

function hasLeadingZeroBits(buf, bits) {
  const fullBytes = Math.floor(bits / 8)
  const remainBits = bits % 8
  for (let i = 0; i < fullBytes; i++) {
    if (buf[i] !== 0) return false
  }
  if (remainBits > 0) {
    const mask = 0xFF << (8 - remainBits)  // e.g. remainBits=4 → 0xF0
    if ((buf[fullBytes] & mask) !== 0) return false
  }
  return true
}

// Periodic cleanup: evict expired entries so the Map does not grow unbounded.
setInterval(() => {
  const cutoff = Date.now() - CHALLENGE_TTL_MS
  for (const [id, entry] of challenges) {
    if (entry.createdAt < cutoff) challenges.delete(id)
  }
}, 60_000).unref()
