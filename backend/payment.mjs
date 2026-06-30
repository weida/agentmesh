/**
 * SavantDex Payment Ledger — Phase A + B + C + D
 *
 * Responsibilities:
 *   - SQLite schema initialization and migration
 *   - Requester identity resolution (Phase D: resolveRequester via RequesterAuthMethod)
 *   - Pre-invocation budget validation
 *   - TaskAgreement + InvocationRecord creation
 *   - Atomic charging transaction with evidence gate (Phase C+)
 *   - Funding record lifecycle (admin-gated)
 *   - Provider settlement record lifecycle (admin-gated)
 *   - Delivery receipt and agreement proof (Phase C)
 *   - Query surfaces for budget, receivables, funding, settlements, task trace
 *
 * All monetary values are stored and passed as strings (DATA base units, 18 decimals).
 * agreementVersion = "1" for Phase A/B tasks (no evidence gate).
 * agreementVersion = "2" for Phase C+ tasks (evidence gate enforced).
 * Schema user_version = 7 (faucetClaimedAt column added to RequesterBudget).
 *
 * resultHash canonicalization: SHA-256 of JSON.stringify(sortKeysDeep(result)).
 * proofType Phase C initial value: "gateway-observed".
 *
 * Auth model (Phase D):
 *   RequesterIdentity    — canonical business identity anchor (requesterAgentId + ownerAddress)
 *   RequesterAuthMethod  — credential bindings (api-key, wallet-signature)
 *   resolveRequester()   — primary auth entrypoint; returns { requesterAgentId, ownerAddress, authMethod }
 *   resolveApiKey()      — deprecated; kept for backward compat during migration
 *   RequesterAuth        — deprecated; kept as compatibility layer, superseded by RequesterAuthMethod
 *
 * methodRef semantics:
 *   api-key:          SHA-256(rawApiKey)
 *   wallet-signature: normalized ownerAddress (checksummed hex)
 */

import Database from 'better-sqlite3'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { computeResultHash } from '../sdk/canonical.mjs'

const DB_PATH = process.env.PAYMENT_DB_PATH || './payment.db'
const AGREEMENT_VERSION  = '2'            // Phase C: evidence gate enforced for version >= 2
const CHALLENGE_TTL_MS   = 5 * 60 * 1000  // 5 minutes — challenge window
const SESSION_TTL_MS     = 15 * 60 * 1000 // 15 minutes — no silent refresh (Phase D first cut)

let db

// ── Init ──────────────────────────────────────────────────────────────────────

export function initDb(path = DB_PATH) {
  const dir = path.replace(/\/[^/]+$/, '')
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true })

  db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Phase A baseline schema (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS RequesterAuth (
      apiKeyHash        TEXT PRIMARY KEY,
      requesterAgentId  TEXT NOT NULL,
      ownerAddress      TEXT NOT NULL,
      status            TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
      createdAt         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS RequesterBudget (
      requesterAgentId      TEXT PRIMARY KEY,
      ownerAddress          TEXT NOT NULL,
      currency              TEXT NOT NULL,
      remainingBaseUnits    TEXT NOT NULL,
      reservedBaseUnits     TEXT NOT NULL DEFAULT '0',
      maxPerTaskBaseUnits   TEXT NOT NULL,
      dailyLimitBaseUnits   TEXT NOT NULL,
      dailySpentBaseUnits   TEXT NOT NULL,
      dailySpentWindowStart TEXT NOT NULL,
      updatedAt             TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS TaskAgreement (
      taskId               TEXT PRIMARY KEY,
      agreementVersion     TEXT NOT NULL,
      requesterAgentId     TEXT NOT NULL,
      providerAgentId      TEXT NOT NULL,
      providerOwnerAddress TEXT NOT NULL,
      taskType             TEXT NOT NULL,
      pricingModelJson     TEXT NOT NULL,
      billingRule          TEXT NOT NULL CHECK(billingRule = 'completed-only'),
      timeoutMs            INTEGER NOT NULL,
      agreementHash        TEXT NOT NULL UNIQUE,
      createdAt            TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS InvocationRecord (
      taskId               TEXT PRIMARY KEY,
      requesterAgentId     TEXT NOT NULL,
      providerAgentId      TEXT NOT NULL,
      providerOwnerAddress TEXT NOT NULL,
      status               TEXT NOT NULL CHECK(status IN ('submitted','completed','failed','timeout','needs_disambiguation')),
      chargedAt            TEXT,
      reservedAmountBaseUnits TEXT NOT NULL DEFAULT '0',
      agreementHash        TEXT NOT NULL,
      createdAt            TEXT NOT NULL,
      completedAt          TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_invocation_provider
      ON InvocationRecord(providerAgentId, completedAt);

    CREATE TABLE IF NOT EXISTS ProviderReceivable (
      ownerAddress      TEXT NOT NULL,
      currency          TEXT NOT NULL,
      accruedBaseUnits  TEXT NOT NULL,
      updatedAt         TEXT NOT NULL,
      PRIMARY KEY (ownerAddress, currency)
    );

    CREATE TABLE IF NOT EXISTS LedgerEvent (
      eventId              TEXT PRIMARY KEY,
      eventType            TEXT NOT NULL CHECK(eventType IN ('budget_seeded','charge_applied','receivable_accrued')),
      taskId               TEXT,
      requesterAgentId     TEXT,
      providerAgentId      TEXT,
      providerOwnerAddress TEXT,
      amountBaseUnits      TEXT NOT NULL,
      currency             TEXT NOT NULL,
      agreementHash        TEXT,
      createdAt            TEXT NOT NULL
    );
  `)

  runMigrations()
  return db
}

// ── Schema migrations ─────────────────────────────────────────────────────────

function runMigrations() {
  let v = db.pragma('user_version', { simple: true })
  if (v < 1) { applyMigrationV1(); v = 1 }
  if (v < 2) { applyMigrationV2(); v = 2 }
  if (v < 3) { applyMigrationV3(); v = 3 }
  if (v < 4) { applyMigrationV4(); v = 4 }
  if (v < 5) { applyMigrationV5(); v = 5 }   // eslint-disable-line no-unused-vars
  if (v < 6) { applyMigrationV6(); v = 6 }
  if (v < 7) { applyMigrationV7(); v = 7 }     // faucetClaimedAt column
  if (v < 8) { applyMigrationV8(); v = 8 }     // relax DeliveryReceipt/TaskAgreementProof proofType CHECK
}

function applyMigrationV1() {
  // Phase B: add FundingRecord + ProviderSettlementRecord,
  // expand LedgerEvent.eventType to include funding_credited + provider_settled.
  db.transaction(() => {
    // Recreate LedgerEvent with expanded eventType CHECK
    db.exec(`
      ALTER TABLE LedgerEvent RENAME TO LedgerEvent_pre_v1;

      CREATE TABLE LedgerEvent (
        eventId              TEXT PRIMARY KEY,
        eventType            TEXT NOT NULL CHECK(eventType IN (
                               'budget_seeded','charge_applied','receivable_accrued',
                               'funding_credited','provider_settled'
                             )),
        taskId               TEXT,
        requesterAgentId     TEXT,
        providerAgentId      TEXT,
        providerOwnerAddress TEXT,
        amountBaseUnits      TEXT NOT NULL,
        currency             TEXT NOT NULL,
        agreementHash        TEXT,
        createdAt            TEXT NOT NULL
      );

      INSERT INTO LedgerEvent SELECT * FROM LedgerEvent_pre_v1;
      DROP TABLE LedgerEvent_pre_v1;

      CREATE TABLE IF NOT EXISTS FundingRecord (
        fundingId        TEXT PRIMARY KEY,
        requesterAgentId TEXT NOT NULL,
        ownerAddress     TEXT NOT NULL,
        currency         TEXT NOT NULL,
        amountBaseUnits  TEXT NOT NULL,
        sourceType       TEXT NOT NULL CHECK(sourceType IN ('manual','onchain-transfer','admin-credit')),
        sourceRef        TEXT,
        status           TEXT NOT NULL CHECK(status IN ('pending','credited','rejected')),
        createdAt        TEXT NOT NULL,
        processedAt      TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_funding_requester
        ON FundingRecord(requesterAgentId, createdAt);

      CREATE TABLE IF NOT EXISTS ProviderSettlementRecord (
        settlementId                         TEXT PRIMARY KEY,
        ownerAddress                         TEXT NOT NULL,
        currency                             TEXT NOT NULL,
        amountBaseUnits                      TEXT NOT NULL,
        totalReceivableBaseUnitsAtSettlement TEXT NOT NULL,
        method                               TEXT NOT NULL CHECK(method IN ('manual-transfer','admin-reconciliation','onchain-transfer')),
        reference                            TEXT,
        status                               TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
        createdAt                            TEXT NOT NULL,
        processedAt                          TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_settlement_provider
        ON ProviderSettlementRecord(ownerAddress, createdAt);
    `)
    db.pragma('user_version = 1')
  })()
}

function applyMigrationV2() {
  // Phase C: add DeliveryReceipt + TaskAgreementProof tables.
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS DeliveryReceipt (
        taskId               TEXT PRIMARY KEY,
        agreementHash        TEXT NOT NULL,
        providerAgentId      TEXT NOT NULL,
        providerOwnerAddress TEXT NOT NULL,
        resultHash           TEXT NOT NULL,
        proofType            TEXT NOT NULL CHECK(proofType IN ('gateway-observed','provider-signed')),
        proofPayloadJson     TEXT NOT NULL,
        createdAt            TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS TaskAgreementProof (
        taskId           TEXT PRIMARY KEY,
        agreementHash    TEXT NOT NULL,
        proofType        TEXT NOT NULL CHECK(proofType IN ('gateway-observed','provider-signed')),
        proofPayloadJson TEXT NOT NULL,
        createdAt        TEXT NOT NULL
      );
    `)
    db.pragma('user_version = 2')
  })()
}

function applyMigrationV3() {
  // Phase D: add RequesterIdentity + RequesterAuthMethod tables.
  // Migrate existing RequesterAuth (api-key) records into the new model.
  // RequesterAuth is kept as a deprecated compatibility layer — not dropped here.
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS RequesterIdentity (
        requesterAgentId  TEXT PRIMARY KEY,
        ownerAddress      TEXT NOT NULL,
        status            TEXT NOT NULL CHECK(status IN ('active','disabled')),
        createdAt         TEXT NOT NULL,
        updatedAt         TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS RequesterAuthMethod (
        authMethodId      TEXT PRIMARY KEY,
        requesterAgentId  TEXT NOT NULL,
        ownerAddress      TEXT NOT NULL,
        methodType        TEXT NOT NULL CHECK(methodType IN ('api-key','wallet-signature')),
        methodRef         TEXT NOT NULL,
        status            TEXT NOT NULL CHECK(status IN ('active','disabled')),
        createdAt         TEXT NOT NULL,
        updatedAt         TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_method_ref_active
        ON RequesterAuthMethod(methodType, methodRef)
        WHERE status = 'active';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_method_wallet_per_requester
        ON RequesterAuthMethod(requesterAgentId, methodType)
        WHERE methodType = 'wallet-signature' AND status = 'active';

      CREATE INDEX IF NOT EXISTS idx_auth_method_requester
        ON RequesterAuthMethod(requesterAgentId);
    `)

    // Migrate RequesterAuth → RequesterIdentity + RequesterAuthMethod
    const rows = db.prepare('SELECT * FROM RequesterAuth').all()
    const now = nowIso()
    const insertIdentity = db.prepare(`
      INSERT OR IGNORE INTO RequesterIdentity
        (requesterAgentId, ownerAddress, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?)
    `)
    const insertMethod = db.prepare(`
      INSERT OR IGNORE INTO RequesterAuthMethod
        (authMethodId, requesterAgentId, ownerAddress, methodType, methodRef, status, createdAt, updatedAt)
      VALUES (?, ?, ?, 'api-key', ?, ?, ?, ?)
    `)
    for (const row of rows) {
      insertIdentity.run(row.requesterAgentId, row.ownerAddress, row.status, row.createdAt, now)
      insertMethod.run(randomUUID(), row.requesterAgentId, row.ownerAddress, row.apiKeyHash, row.status, row.createdAt, now)
    }

    db.pragma('user_version = 3')
  })()
}

function applyMigrationV4() {
  // Phase D3: add WalletAuthChallenge + RequesterSession tables.
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS WalletAuthChallenge (
        challengeId       TEXT PRIMARY KEY,
        requesterAgentId  TEXT NOT NULL,
        ownerAddress      TEXT NOT NULL,
        nonce             TEXT NOT NULL,
        message           TEXT NOT NULL,
        expiresAt         TEXT NOT NULL,
        usedAt            TEXT,
        createdAt         TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS RequesterSession (
        sessionId         TEXT PRIMARY KEY,
        requesterAgentId  TEXT NOT NULL,
        ownerAddress      TEXT NOT NULL,
        authMethodType    TEXT NOT NULL,
        tokenHash         TEXT NOT NULL UNIQUE,
        expiresAt         TEXT NOT NULL,
        revokedAt         TEXT,
        createdAt         TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_requester
        ON RequesterSession(requesterAgentId);
    `)
    db.pragma('user_version = 4')
  })()
}

function applyMigrationV5() {
  // Phase D4: add authMethodUsed column to InvocationRecord for auth-method observability.
  db.transaction(() => {
    db.exec(`
      ALTER TABLE InvocationRecord ADD COLUMN authMethodUsed TEXT;
      CREATE INDEX IF NOT EXISTS idx_invocation_auth_method
        ON InvocationRecord(authMethodUsed, createdAt);
    `)
    db.pragma('user_version = 5')
  })()
}

function applyMigrationV6() {
  db.transaction(() => {
    const budgetCols = db.prepare(`PRAGMA table_info(RequesterBudget)`).all().map(r => r.name)
    const invocationCols = db.prepare(`PRAGMA table_info(InvocationRecord)`).all().map(r => r.name)
    if (!budgetCols.includes('reservedBaseUnits')) {
      db.exec(`ALTER TABLE RequesterBudget ADD COLUMN reservedBaseUnits TEXT NOT NULL DEFAULT '0';`)
    }
    if (!invocationCols.includes('reservedAmountBaseUnits')) {
      db.exec(`ALTER TABLE InvocationRecord ADD COLUMN reservedAmountBaseUnits TEXT NOT NULL DEFAULT '0';`)
    }
    db.pragma('user_version = 6')
  })()
}

function applyMigrationV7() {
  db.transaction(() => {
    const cols = db.prepare(`PRAGMA table_info(RequesterBudget)`).all().map(r => r.name)
    if (!cols.includes('faucetClaimedAt')) {
      db.exec(`ALTER TABLE RequesterBudget ADD COLUMN faucetClaimedAt TEXT;`)
    }
    db.pragma('user_version = 7')
  })()
}

// Phase-1 receipt signing introduced a new proofType 'gateway-signed-v1' that
// the V2 CHECK constraint rejects silently under INSERT OR IGNORE. Rebuild the
// two proof tables without the enum constraint — proofType is a free-form
// string from now on, validated at the application layer instead.
function applyMigrationV8() {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE DeliveryReceipt_new (
        taskId               TEXT PRIMARY KEY,
        agreementHash        TEXT NOT NULL,
        providerAgentId      TEXT NOT NULL,
        providerOwnerAddress TEXT NOT NULL,
        resultHash           TEXT NOT NULL,
        proofType            TEXT NOT NULL,
        proofPayloadJson     TEXT NOT NULL,
        createdAt            TEXT NOT NULL
      );
      INSERT INTO DeliveryReceipt_new SELECT * FROM DeliveryReceipt;
      DROP TABLE DeliveryReceipt;
      ALTER TABLE DeliveryReceipt_new RENAME TO DeliveryReceipt;

      CREATE TABLE TaskAgreementProof_new (
        taskId           TEXT PRIMARY KEY,
        agreementHash    TEXT NOT NULL,
        proofType        TEXT NOT NULL,
        proofPayloadJson TEXT NOT NULL,
        createdAt        TEXT NOT NULL
      );
      INSERT INTO TaskAgreementProof_new SELECT * FROM TaskAgreementProof;
      DROP TABLE TaskAgreementProof;
      ALTER TABLE TaskAgreementProof_new RENAME TO TaskAgreementProof;
    `)
    db.pragma('user_version = 8')
  })()
}

function getDb() {
  if (!db) throw new Error('payment db not initialized — call initDb() first')
  return db
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashApiKey(rawKey) {
  return createHash('sha256').update(rawKey).digest('hex')
}

function nowIso() {
  return new Date().toISOString()
}

function utcDayStart(isoString) {
  const d = new Date(isoString)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
}

function isNewUtcDay(windowStart) {
  const now = new Date()
  const w = new Date(windowStart)
  return (
    now.getUTCFullYear() !== w.getUTCFullYear() ||
    now.getUTCMonth()    !== w.getUTCMonth()    ||
    now.getUTCDate()     !== w.getUTCDate()
  )
}

function addUnits(a, b) {
  return (BigInt(a) + BigInt(b)).toString()
}

function gte(a, b) { return BigInt(a) >= BigInt(b) }
function lte(a, b) { return BigInt(a) <= BigInt(b) }

// resultHash canonicalization lives in ../sdk/canonical.mjs; re-exported here
// so existing callers (`import { computeResultHash } from './payment.mjs'`)
// keep working.
export { computeResultHash }

function computeAgreementHash({ agreementVersion, taskId, requesterAgentId, providerAgentId,
  providerOwnerAddress, taskType, pricingModel, billingRule, timeoutMs, createdAt }) {
  const canonical = JSON.stringify({
    agreementVersion, taskId, requesterAgentId, providerAgentId,
    providerOwnerAddress, taskType, pricingModel, billingRule, timeoutMs, createdAt,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

// ── Helpers (address) ─────────────────────────────────────────────────────────

// Normalize EVM address to lowercase hex for consistent storage and lookup.
// Full EIP-55 checksum encoding is deferred.
function normalizeAddress(addr) {
  return addr.toLowerCase()
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Primary auth entrypoint (Phase D+).
 * Returns { requesterAgentId, ownerAddress, authMethod } or null.
 * Looks up api-key in RequesterAuthMethod first; falls back to RequesterAuth
 * for any records not yet migrated.
 */
export function resolveRequester(rawKey) {
  const ref = hashApiKey(rawKey)
  const database = getDb()

  // Check RequesterAuthMethod regardless of status — if the record exists here,
  // it is the authoritative source and we do NOT fall back to RequesterAuth.
  const method = database.prepare(`
    SELECT requesterAgentId, ownerAddress, methodType, status
    FROM RequesterAuthMethod
    WHERE methodType = 'api-key' AND methodRef = ?
  `).get(ref)
  if (method) {
    if (method.status !== 'active') return null
    return { requesterAgentId: method.requesterAgentId, ownerAddress: method.ownerAddress, authMethod: 'api-key' }
  }

  // Fallback: deprecated RequesterAuth — only for records not yet migrated into RequesterAuthMethod.
  const legacy = database.prepare(
    `SELECT * FROM RequesterAuth WHERE apiKeyHash = ? AND status = 'active'`
  ).get(ref)
  if (legacy) {
    return { requesterAgentId: legacy.requesterAgentId, ownerAddress: legacy.ownerAddress, authMethod: 'api-key' }
  }

  return null
}

/**
 * @deprecated Use resolveRequester() instead.
 * Kept for backward compatibility during Phase D migration.
 */
export function resolveApiKey(rawKey) {
  const hash = hashApiKey(rawKey)
  return getDb().prepare(
    `SELECT * FROM RequesterAuth WHERE apiKeyHash = ? AND status = 'active'`
  ).get(hash) || null
}

export function getAuthMethods(requesterAgentId) {
  return getDb().prepare(`
    SELECT authMethodId, methodType, methodRef, status, createdAt, updatedAt
    FROM RequesterAuthMethod WHERE requesterAgentId = ? ORDER BY createdAt
  `).all(requesterAgentId)
}

export function getRequesterIdentity(requesterAgentId) {
  return getDb().prepare(
    `SELECT * FROM RequesterIdentity WHERE requesterAgentId = ?`
  ).get(requesterAgentId) || null
}

/**
 * D2: Bind a wallet address to an existing requester identity.
 * Creates a RequesterAuthMethod(methodType='wallet-signature') row.
 *
 * Rules:
 *   - RequesterIdentity must exist and be active
 *   - ownerAddress must match identity.ownerAddress (case-insensitive)
 *   - No active wallet-signature method already bound to this requester
 *   - No active wallet-signature method already bound to this wallet address
 *
 * For the first cut, this is admin-only (enforced at the API layer).
 */
export function bindWalletMethod({ requesterAgentId, ownerAddress }) {
  const database = getDb()
  const methodRef = normalizeAddress(ownerAddress)

  const identity = database.prepare(
    `SELECT * FROM RequesterIdentity WHERE requesterAgentId = ? AND status = 'active'`
  ).get(requesterAgentId)
  if (!identity)
    throw Object.assign(new Error('RequesterIdentity not found or inactive'), { code: 'IDENTITY_NOT_FOUND' })

  if (normalizeAddress(identity.ownerAddress) !== methodRef)
    throw Object.assign(
      new Error(`ownerAddress mismatch: identity owner is ${identity.ownerAddress}`),
      { code: 'OWNER_MISMATCH' }
    )

  const existingForRequester = database.prepare(`
    SELECT authMethodId FROM RequesterAuthMethod
    WHERE requesterAgentId = ? AND methodType = 'wallet-signature' AND status = 'active'
  `).get(requesterAgentId)
  if (existingForRequester)
    throw Object.assign(
      new Error('Active wallet-signature method already bound to this requester'),
      { code: 'METHOD_ALREADY_EXISTS' }
    )

  const existingForWallet = database.prepare(`
    SELECT requesterAgentId FROM RequesterAuthMethod
    WHERE methodType = 'wallet-signature' AND methodRef = ? AND status = 'active'
  `).get(methodRef)
  if (existingForWallet)
    throw Object.assign(
      new Error(`ownerAddress already bound to requester ${existingForWallet.requesterAgentId}`),
      { code: 'WALLET_ALREADY_BOUND' }
    )

  const authMethodId = randomUUID()
  const now = nowIso()
  database.prepare(`
    INSERT INTO RequesterAuthMethod
      (authMethodId, requesterAgentId, ownerAddress, methodType, methodRef, status, createdAt, updatedAt)
    VALUES (?, ?, ?, 'wallet-signature', ?, 'active', ?, ?)
  `).run(authMethodId, requesterAgentId, ownerAddress, methodRef, now, now)

  return { authMethodId, requesterAgentId, ownerAddress, methodType: 'wallet-signature' }
}

// ── D3: wallet challenge and session ─────────────────────────────────────────

/**
 * Creates a wallet auth challenge for a requester with an active wallet-signature binding.
 * Returns { challengeId, message, nonce, expiresAt }.
 * Challenge message uses EIP-191 personal sign format (verifiable with eth_sign / personal_sign).
 */
export function createChallenge({ requesterAgentId, ownerAddress }) {
  const database = getDb()
  const methodRef = normalizeAddress(ownerAddress)

  const method = database.prepare(`
    SELECT authMethodId FROM RequesterAuthMethod
    WHERE requesterAgentId = ? AND methodType = 'wallet-signature' AND methodRef = ? AND status = 'active'
  `).get(requesterAgentId, methodRef)
  if (!method)
    throw Object.assign(
      new Error('No active wallet-signature binding for this requester and address'),
      { code: 'WALLET_NOT_BOUND' }
    )

  const challengeId = randomUUID()
  const nonce       = randomBytes(16).toString('hex')
  const now         = nowIso()
  const expiresAt   = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()

  const message = [
    'SavantDex authentication',
    '',
    `requesterAgentId: ${requesterAgentId}`,
    `ownerAddress: ${ownerAddress}`,
    `nonce: ${nonce}`,
    `issuedAt: ${now}`,
    `expiresAt: ${expiresAt}`,
  ].join('\n')

  database.prepare(`
    INSERT INTO WalletAuthChallenge
      (challengeId, requesterAgentId, ownerAddress, nonce, message, expiresAt, usedAt, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(challengeId, requesterAgentId, ownerAddress, nonce, message, expiresAt, now)

  return { challengeId, message, nonce, expiresAt }
}

/**
 * Returns a challenge row if it exists, is not yet used, and has not expired.
 * Returns null otherwise — callers should treat all failure cases as "challenge invalid".
 */
export function getChallenge(challengeId) {
  const challenge = getDb().prepare(
    `SELECT * FROM WalletAuthChallenge WHERE challengeId = ?`
  ).get(challengeId)
  if (!challenge)                                    return null
  if (challenge.usedAt)                              return null
  if (new Date(challenge.expiresAt) <= new Date())   return null
  return challenge
}

/**
 * Atomically marks the challenge as used and creates a RequesterSession.
 * Caller is responsible for verifying the signature before calling this.
 * Returns { sessionToken, sessionId, expiresAt, requesterAgentId, ownerAddress }.
 */
export function consumeChallengeAndCreateSession({ challengeId }) {
  const database = getDb()

  return database.transaction(() => {
    const challenge = database.prepare(
      `SELECT * FROM WalletAuthChallenge WHERE challengeId = ?`
    ).get(challengeId)
    if (!challenge)
      throw Object.assign(new Error('Challenge not found'), { code: 'CHALLENGE_NOT_FOUND' })
    if (challenge.usedAt)
      throw Object.assign(new Error('Challenge already used'), { code: 'CHALLENGE_ALREADY_USED' })
    if (new Date(challenge.expiresAt) <= new Date())
      throw Object.assign(new Error('Challenge expired'), { code: 'CHALLENGE_EXPIRED' })

    // Re-check identity and binding at consume time — admin may have disabled either
    // after the challenge was issued but before the requester returned the signature.
    const identity = database.prepare(
      `SELECT status FROM RequesterIdentity WHERE requesterAgentId = ?`
    ).get(challenge.requesterAgentId)
    if (!identity || identity.status !== 'active')
      throw Object.assign(new Error('RequesterIdentity is inactive'), { code: 'IDENTITY_INACTIVE' })

    const method = database.prepare(`
      SELECT authMethodId FROM RequesterAuthMethod
      WHERE requesterAgentId = ? AND methodType = 'wallet-signature'
        AND methodRef = ? AND status = 'active'
    `).get(challenge.requesterAgentId, normalizeAddress(challenge.ownerAddress))
    if (!method)
      throw Object.assign(new Error('wallet-signature binding is no longer active'), { code: 'BINDING_INACTIVE' })

    const now = nowIso()
    database.prepare(`UPDATE WalletAuthChallenge SET usedAt = ? WHERE challengeId = ?`).run(now, challengeId)

    const rawToken  = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
    const sessionId = randomUUID()

    database.prepare(`
      INSERT INTO RequesterSession
        (sessionId, requesterAgentId, ownerAddress, authMethodType, tokenHash, expiresAt, revokedAt, createdAt)
      VALUES (?, ?, ?, 'wallet-signature', ?, ?, NULL, ?)
    `).run(sessionId, challenge.requesterAgentId, challenge.ownerAddress, tokenHash, expiresAt, now)

    return {
      sessionToken:     rawToken,
      sessionId,
      expiresAt,
      requesterAgentId: challenge.requesterAgentId,
      ownerAddress:     challenge.ownerAddress,
    }
  })()
}

/**
 * Resolves a raw session token to a requester identity.
 * Returns { requesterAgentId, ownerAddress, authMethod } or null if invalid/expired/revoked.
 */
export function resolveSession(rawToken) {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  const database  = getDb()

  const session = database.prepare(
    `SELECT * FROM RequesterSession WHERE tokenHash = ? AND revokedAt IS NULL`
  ).get(tokenHash)
  if (!session)                                  return null
  if (new Date(session.expiresAt) <= new Date()) return null

  // Confirm the identity is still active
  const identity = database.prepare(
    `SELECT status FROM RequesterIdentity WHERE requesterAgentId = ?`
  ).get(session.requesterAgentId)
  if (!identity || identity.status !== 'active') return null

  // Confirm the wallet-signature binding is still active
  const method = database.prepare(`
    SELECT authMethodId FROM RequesterAuthMethod
    WHERE requesterAgentId = ? AND methodType = 'wallet-signature'
      AND methodRef = ? AND status = 'active'
  `).get(session.requesterAgentId, normalizeAddress(session.ownerAddress))
  if (!method) return null

  return {
    requesterAgentId: session.requesterAgentId,
    ownerAddress:     session.ownerAddress,
    authMethod:       'wallet-signature',
  }
}

/**
 * Revokes a session by raw token. Throws SESSION_NOT_FOUND if token is unknown.
 */
export function revokeSession(rawToken) {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  const database  = getDb()
  const session   = database.prepare(
    `SELECT sessionId FROM RequesterSession WHERE tokenHash = ?`
  ).get(tokenHash)
  if (!session)
    throw Object.assign(new Error('Session not found'), { code: 'SESSION_NOT_FOUND' })
  database.prepare(`UPDATE RequesterSession SET revokedAt = ? WHERE tokenHash = ?`).run(nowIso(), tokenHash)
  return { ok: true }
}

// ── Budget ────────────────────────────────────────────────────────────────────

export function getBudget(requesterAgentId) {
  return getDb().prepare(
    `SELECT * FROM RequesterBudget WHERE requesterAgentId = ?`
  ).get(requesterAgentId) || null
}

export function preInvocationCheck(requesterAgentId, amountBaseUnits) {
  const budget = getBudget(requesterAgentId)
  if (!budget) return { ok: false, errorCode: 'BUDGET_INSUFFICIENT' }

  const effectiveDailySpent = isNewUtcDay(budget.dailySpentWindowStart)
    ? '0'
    : budget.dailySpentBaseUnits
  const reserved = budget.reservedBaseUnits || '0'

  if (!gte(budget.remainingBaseUnits, amountBaseUnits))
    return { ok: false, errorCode: 'BUDGET_INSUFFICIENT' }

  if (!lte(amountBaseUnits, budget.maxPerTaskBaseUnits))
    return { ok: false, errorCode: 'MAX_PER_TASK_EXCEEDED' }

  if (!lte(addUnits(addUnits(effectiveDailySpent, reserved), amountBaseUnits), budget.dailyLimitBaseUnits))
    return { ok: false, errorCode: 'DAILY_LIMIT_EXCEEDED' }

  return { ok: true }
}

// ── Pre-invocation writes ─────────────────────────────────────────────────────

export function writeSubmitted({
  taskId, requesterAgentId, providerAgentId, providerOwnerAddress,
  taskType, pricingModel, timeoutMs = 60000, gatewayAddress = null,
  authMethodUsed = null,
}) {
  const now = nowIso()
  const billingRule = 'completed-only'

  const agreementHash = computeAgreementHash({
    agreementVersion: AGREEMENT_VERSION, taskId, requesterAgentId, providerAgentId,
    providerOwnerAddress, taskType, pricingModel, billingRule, timeoutMs, createdAt: now,
  })

  getDb().transaction(() => {
    const database = getDb()
    let reservedAmountBaseUnits = '0'
    if (pricingModel.type === 'fixed') {
      const amountBaseUnits = pricingModel.amountBaseUnits
      const budget = database.prepare(
        `SELECT * FROM RequesterBudget WHERE requesterAgentId = ?`
      ).get(requesterAgentId)
      if (!budget) throw Object.assign(new Error('RequesterBudget not found'), { code: 'BUDGET_INSUFFICIENT' })

      const effectiveDailySpent = isNewUtcDay(budget.dailySpentWindowStart)
        ? '0'
        : budget.dailySpentBaseUnits
      const reserved = budget.reservedBaseUnits || '0'

      if (!gte(budget.remainingBaseUnits, amountBaseUnits))
        throw Object.assign(new Error('Insufficient requester budget'), { code: 'BUDGET_INSUFFICIENT' })
      if (!lte(amountBaseUnits, budget.maxPerTaskBaseUnits))
        throw Object.assign(new Error('Task exceeds requester max-per-task budget'), { code: 'MAX_PER_TASK_EXCEEDED' })
      if (!lte(addUnits(addUnits(effectiveDailySpent, reserved), amountBaseUnits), budget.dailyLimitBaseUnits))
        throw Object.assign(new Error('Task exceeds requester daily budget limit'), { code: 'DAILY_LIMIT_EXCEEDED' })

      reservedAmountBaseUnits = amountBaseUnits
      database.prepare(`
        UPDATE RequesterBudget
        SET remainingBaseUnits = ?, reservedBaseUnits = ?, updatedAt = ?
        WHERE requesterAgentId = ?
      `).run(
        (BigInt(budget.remainingBaseUnits) - BigInt(amountBaseUnits)).toString(),
        addUnits(reserved, amountBaseUnits),
        now,
        requesterAgentId
      )
    }

    database.prepare(`
      INSERT INTO TaskAgreement
        (taskId, agreementVersion, requesterAgentId, providerAgentId, providerOwnerAddress,
         taskType, pricingModelJson, billingRule, timeoutMs, agreementHash, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId, AGREEMENT_VERSION, requesterAgentId, providerAgentId, providerOwnerAddress,
      taskType, JSON.stringify(pricingModel), billingRule, timeoutMs, agreementHash, now
    )
    database.prepare(`
      INSERT INTO InvocationRecord
        (taskId, requesterAgentId, providerAgentId, providerOwnerAddress,
         status, chargedAt, reservedAmountBaseUnits, agreementHash, createdAt, completedAt, authMethodUsed)
      VALUES (?, ?, ?, ?, 'submitted', NULL, ?, ?, ?, NULL, ?)
    `).run(taskId, requesterAgentId, providerAgentId, providerOwnerAddress, reservedAmountBaseUnits, agreementHash, now, authMethodUsed)

    // Phase C (transitional): write TaskAgreementProof for agreementVersion >= 2.
    // This proof is gateway-observed — the gateway records that it brokered this
    // agreement, not that the requester cryptographically signed it.
    // Requester-side signing is deferred to Stage C3. Until then, this record
    // should NOT be presented as "requester-verified agreement proof".
    if (parseInt(AGREEMENT_VERSION, 10) >= 2) {
      const proofPayloadJson = JSON.stringify({
        proofType: 'gateway-observed',
        agreementHash,
        gatewayAddress: gatewayAddress || 'unknown',
        createdAt: now,
      })
      database.prepare(`
        INSERT OR IGNORE INTO TaskAgreementProof
          (taskId, agreementHash, proofType, proofPayloadJson, createdAt)
        VALUES (?, ?, 'gateway-observed', ?, ?)
      `).run(taskId, agreementHash, proofPayloadJson, now)
    }
  })()

  return { agreementHash }
}

// ── Status updates ────────────────────────────────────────────────────────────

export function markStatus(taskId, status) {
  const terminal = ['completed', 'failed', 'timeout', 'needs_disambiguation']
  const completedAt = terminal.includes(status) ? nowIso() : null
  const database = getDb()
  database.transaction(() => {
    const record = database.prepare(`SELECT * FROM InvocationRecord WHERE taskId = ?`).get(taskId)
    if (!record) return

    if (status !== 'completed' && BigInt(record.reservedAmountBaseUnits || '0') > 0n && record.chargedAt === null) {
      const budget = database.prepare(
        `SELECT * FROM RequesterBudget WHERE requesterAgentId = ?`
      ).get(record.requesterAgentId)
      if (budget) {
        const reservedAmount = record.reservedAmountBaseUnits
        const reserved = budget.reservedBaseUnits || '0'
        database.prepare(`
          UPDATE RequesterBudget
          SET remainingBaseUnits = ?, reservedBaseUnits = ?, updatedAt = ?
          WHERE requesterAgentId = ?
        `).run(
          addUnits(budget.remainingBaseUnits, reservedAmount),
          (BigInt(reserved) - BigInt(reservedAmount)).toString(),
          completedAt || nowIso(),
          record.requesterAgentId
        )
      }
      database.prepare(
        `UPDATE InvocationRecord SET reservedAmountBaseUnits = '0' WHERE taskId = ?`
      ).run(taskId)
    }

    database.prepare(
      `UPDATE InvocationRecord SET status = ?, completedAt = ? WHERE taskId = ?`
    ).run(status, completedAt, taskId)
  })()
}

// ── Charging transaction ──────────────────────────────────────────────────────

export function chargeCompleted(taskId) {
  const database = getDb()

  return database.transaction(() => {
    const record = database.prepare(
      `SELECT * FROM InvocationRecord WHERE taskId = ?`
    ).get(taskId)

    if (!record)                   return { charged: false, reason: 'record_not_found' }
    if (record.status !== 'completed') return { charged: false, reason: 'not_completed' }
    if (record.chargedAt !== null)  return { charged: false, reason: 'already_charged' }

    const agreement = database.prepare(
      `SELECT * FROM TaskAgreement WHERE taskId = ?`
    ).get(taskId)
    if (!agreement) return { charged: false, reason: 'agreement_not_found' }

    // Phase C evidence gate: enforced for agreementVersion >= 2.
    // Both existence and agreementHash consistency are required — a receipt or
    // proof linked to a different agreement must not satisfy this gate.
    if (parseInt(agreement.agreementVersion, 10) >= 2) {
      const receipt = database.prepare(`SELECT agreementHash FROM DeliveryReceipt WHERE taskId = ?`).get(taskId)
      if (!receipt) return { charged: false, reason: 'missing_delivery_receipt' }
      if (receipt.agreementHash !== agreement.agreementHash)
        return { charged: false, reason: 'delivery_receipt_hash_mismatch' }
      const proof = database.prepare(`SELECT agreementHash FROM TaskAgreementProof WHERE taskId = ?`).get(taskId)
      if (!proof) return { charged: false, reason: 'missing_agreement_proof' }
      if (proof.agreementHash !== agreement.agreementHash)
        return { charged: false, reason: 'agreement_proof_hash_mismatch' }
    }

    const pricingModel = JSON.parse(agreement.pricingModelJson)
    if (pricingModel.type === 'free') return { charged: false, reason: 'free_task' }

    const { amountBaseUnits, currency } = pricingModel
    const now = nowIso()

    const budget = database.prepare(
      `SELECT * FROM RequesterBudget WHERE requesterAgentId = ?`
    ).get(record.requesterAgentId)
    if (!budget) return { charged: false, reason: 'budget_not_found' }

    // Rotate daily window if needed
    let dailySpent = budget.dailySpentBaseUnits
    let windowStart = budget.dailySpentWindowStart
    if (isNewUtcDay(windowStart)) {
      dailySpent = '0'
      windowStart = utcDayStart(now)
    }

    const reservedAmount = record.reservedAmountBaseUnits || '0'
    const useReservation = BigInt(reservedAmount) > 0n

    // Old tasks created before reservation support fall back to the legacy direct-debit path.
    if (!useReservation) {
      if (!gte(budget.remainingBaseUnits, amountBaseUnits))
        return { charged: false, reason: 'insufficient_balance' }
      if (!lte(amountBaseUnits, budget.maxPerTaskBaseUnits))
        return { charged: false, reason: 'max_per_task_exceeded' }
      if (!lte(addUnits(dailySpent, amountBaseUnits), budget.dailyLimitBaseUnits))
        return { charged: false, reason: 'daily_limit_exceeded' }
    } else if (BigInt(reservedAmount) < BigInt(amountBaseUnits)) {
      return { charged: false, reason: 'reservation_underfunded' }
    }

    const newDailySpent = addUnits(dailySpent, amountBaseUnits)
    const newRemaining = useReservation
      ? budget.remainingBaseUnits
      : (BigInt(budget.remainingBaseUnits) - BigInt(amountBaseUnits)).toString()
    const newReserved = useReservation
      ? (BigInt(budget.reservedBaseUnits || '0') - BigInt(amountBaseUnits)).toString()
      : (budget.reservedBaseUnits || '0')

    const insertEvent = database.prepare(`
      INSERT INTO LedgerEvent
        (eventId, eventType, taskId, requesterAgentId, providerAgentId,
         providerOwnerAddress, amountBaseUnits, currency, agreementHash, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    insertEvent.run(randomUUID(), 'charge_applied',     taskId, record.requesterAgentId,
      record.providerAgentId, record.providerOwnerAddress, amountBaseUnits, currency, agreement.agreementHash, now)
    insertEvent.run(randomUUID(), 'receivable_accrued', taskId, record.requesterAgentId,
      record.providerAgentId, record.providerOwnerAddress, amountBaseUnits, currency, agreement.agreementHash, now)

    database.prepare(`
      UPDATE RequesterBudget
      SET remainingBaseUnits = ?, reservedBaseUnits = ?, dailySpentBaseUnits = ?, dailySpentWindowStart = ?, updatedAt = ?
      WHERE requesterAgentId = ?
    `).run(newRemaining, newReserved, newDailySpent, windowStart, now, record.requesterAgentId)

    const existing = database.prepare(
      `SELECT accruedBaseUnits FROM ProviderReceivable WHERE ownerAddress = ? AND currency = ?`
    ).get(record.providerOwnerAddress, currency)

    if (existing) {
      database.prepare(`
        UPDATE ProviderReceivable SET accruedBaseUnits = ?, updatedAt = ?
        WHERE ownerAddress = ? AND currency = ?
      `).run(addUnits(existing.accruedBaseUnits, amountBaseUnits), now, record.providerOwnerAddress, currency)
    } else {
      database.prepare(`
        INSERT INTO ProviderReceivable (ownerAddress, currency, accruedBaseUnits, updatedAt)
        VALUES (?, ?, ?, ?)
      `).run(record.providerOwnerAddress, currency, amountBaseUnits, now)
    }

    database.prepare(
      `UPDATE InvocationRecord SET chargedAt = ?, reservedAmountBaseUnits = '0' WHERE taskId = ?`
    ).run(now, taskId)

    return { charged: true }
  })()
}

// ── Phase C: delivery receipt ─────────────────────────────────────────────────

/**
 * Phase-1 receipt write. Accepts the canonical payload directly — callers are
 * responsible for building it via `buildReceiptPayload()` in receipt.mjs and
 * (optionally) signing via `signReceiptPayload()`. This keeps a single source
 * of truth for the canonical shape and decouples receipt persistence from the
 * payment ledger: receipts are written for every completed task, regardless
 * of whether a billing agreement exists.
 */
export function writeDeliveryReceipt({
  payload,
  signedPayload = null, signature = null, signerAddress = null,
  gatewayAddress = null,
  providerAttestation = null,
}) {
  if (!payload || !payload.taskId || !payload.resultHash) return

  const gatewaySigned  = signedPayload && signature && signerAddress
  const providerSigned = providerAttestation
                         && providerAttestation.payload
                         && providerAttestation.signature
                         && providerAttestation.address
  const proofType = providerSigned && gatewaySigned
    ? 'dual-signed-v1'
    : gatewaySigned
      ? 'gateway-signed-v1'
      : 'gateway-observed'
  const now       = nowIso()

  const proofPayload = gatewaySigned
    ? {
        proofType,
        gatewayAddress: signerAddress,
        observedAt:     now,
        signedPayload,
        signature,
        ...(providerSigned ? { providerAttestation } : {}),
      }
    : {
        proofType,
        gatewayAddress: gatewayAddress || 'unknown',
        observedAt:     now,
        resultHash:     payload.resultHash,
        agreementHash:  payload.agreementHash || '',
      }

  getDb().prepare(`
    INSERT OR IGNORE INTO DeliveryReceipt
      (taskId, agreementHash, providerAgentId, providerOwnerAddress,
       resultHash, proofType, proofPayloadJson, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.taskId,
    payload.agreementHash        || '',
    payload.providerAgentId      || '',
    payload.providerOwnerAddress || '',
    payload.resultHash,
    proofType, JSON.stringify(proofPayload), now
  )
}

/**
 * Fetch a delivery receipt by taskId for public verification.
 * Returns { taskId, proofType, payload, signature, signerAddress, createdAt } or null.
 */
export function getDeliveryReceipt(taskId) {
  const database = getDb()
  const row = database.prepare(`
    SELECT taskId, agreementHash, providerAgentId, providerOwnerAddress,
           resultHash, proofType, proofPayloadJson, createdAt
      FROM DeliveryReceipt WHERE taskId = ?
  `).get(taskId)
  if (!row) return null

  let proof
  try { proof = JSON.parse(row.proofPayloadJson) } catch { proof = {} }

  return {
    taskId:     row.taskId,
    proofType:  row.proofType,
    createdAt:  row.createdAt,
    resultHash: row.resultHash,
    providerAgentId:      row.providerAgentId,
    providerOwnerAddress: row.providerOwnerAddress,
    agreementHash:        row.agreementHash,
    // For signed-v1 only: the exact payload that was signed + signature + signer
    payload:       proof.signedPayload || null,
    signature:     proof.signature     || null,
    signerAddress: isSignedProofType(row.proofType) ? proof.gatewayAddress : null,
    // For dual-signed-v1 only: provider's independent co-signature
    providerAttestation: proof.providerAttestation || null,
    // Legacy fields kept for callers that saw the old shape
    proofPayload:  proof,
  }
}

function isSignedProofType(t) {
  return typeof t === 'string' && (t.startsWith('gateway-signed-') || t.startsWith('dual-signed-'))
}

/**
 * Look up the agreement row for a task, if one was written (i.e. the task
 * went through the payment-tracked path). Returns null for tasks that bypassed
 * `writeSubmitted` — e.g. admin / dev-mode invocations. Callers should treat
 * `agreementHash` as optional in the receipt payload when this returns null.
 *
 * Kept deliberately minimal — the canonical payload builder lives in
 * receipt.mjs (`buildReceiptPayload`) as the single source of truth. This
 * helper only returns raw DB fields.
 */
export function getTaskAgreementForReceipt(taskId) {
  const database = getDb()
  const agr = database.prepare(
    `SELECT agreementHash, providerAgentId, providerOwnerAddress, requesterAgentId, taskType
       FROM TaskAgreement WHERE taskId = ?`
  ).get(taskId)
  return agr || null
}

// ── Funding record lifecycle ──────────────────────────────────────────────────

export function createFundingRecord({
  requesterAgentId, ownerAddress, currency, amountBaseUnits, sourceType, sourceRef = null,
}) {
  const database = getDb()
  const budget = database.prepare(
    `SELECT * FROM RequesterBudget WHERE requesterAgentId = ?`
  ).get(requesterAgentId)
  if (!budget) throw Object.assign(new Error('Requester not found'), { code: 'REQUESTER_NOT_FOUND' })

  if (budget.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase())
    throw Object.assign(
      new Error(`ownerAddress mismatch: expected ${budget.ownerAddress}`),
      { code: 'OWNER_MISMATCH' }
    )
  if (budget.currency !== currency)
    throw Object.assign(
      new Error(`currency mismatch: budget currency is ${budget.currency}`),
      { code: 'CURRENCY_MISMATCH' }
    )

  const fundingId = randomUUID()
  const now = nowIso()
  database.prepare(`
    INSERT INTO FundingRecord
      (fundingId, requesterAgentId, ownerAddress, currency, amountBaseUnits,
       sourceType, sourceRef, status, createdAt, processedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
  `).run(fundingId, requesterAgentId, ownerAddress, currency, amountBaseUnits, sourceType, sourceRef, now)
  return { fundingId }
}

export function processFunding(fundingId, decision) {
  if (decision !== 'credited' && decision !== 'rejected')
    throw Object.assign(new Error('decision must be credited or rejected'), { code: 'INVALID_DECISION' })

  const database = getDb()
  return database.transaction(() => {
    const record = database.prepare(`SELECT * FROM FundingRecord WHERE fundingId = ?`).get(fundingId)
    if (!record) throw Object.assign(new Error('FundingRecord not found'), { code: 'NOT_FOUND' })
    if (record.status !== 'pending')
      throw Object.assign(new Error(`FundingRecord already ${record.status}`), { code: 'ALREADY_PROCESSED' })

    const now = nowIso()
    database.prepare(
      `UPDATE FundingRecord SET status = ?, processedAt = ? WHERE fundingId = ?`
    ).run(decision, now, fundingId)

    if (decision === 'credited') {
      const budget = database.prepare(
        `SELECT * FROM RequesterBudget WHERE requesterAgentId = ?`
      ).get(record.requesterAgentId)
      if (!budget) throw Object.assign(new Error('RequesterBudget not found'), { code: 'BUDGET_NOT_FOUND' })

      const newRemaining = addUnits(budget.remainingBaseUnits, record.amountBaseUnits)
      database.prepare(
        `UPDATE RequesterBudget SET remainingBaseUnits = ?, updatedAt = ? WHERE requesterAgentId = ?`
      ).run(newRemaining, now, record.requesterAgentId)

      database.prepare(`
        INSERT INTO LedgerEvent
          (eventId, eventType, taskId, requesterAgentId, providerAgentId,
           providerOwnerAddress, amountBaseUnits, currency, agreementHash, createdAt)
        VALUES (?, 'funding_credited', NULL, ?, NULL, NULL, ?, ?, NULL, ?)
      `).run(randomUUID(), record.requesterAgentId, record.amountBaseUnits, record.currency, now)
    }

    return { ok: true, decision }
  })()
}

export function getFundingHistory(requesterAgentId) {
  return getDb().prepare(`
    SELECT * FROM FundingRecord WHERE requesterAgentId = ? ORDER BY createdAt DESC
  `).all(requesterAgentId)
}

export function getFundingById(fundingId) {
  return getDb().prepare(`SELECT * FROM FundingRecord WHERE fundingId = ?`).get(fundingId) || null
}

// ── Provider settlement lifecycle ─────────────────────────────────────────────

export function createSettlementRecord({
  ownerAddress, currency, amountBaseUnits, method, reference = null,
}) {
  const database = getDb()

  // Wrap the read-check-write in a transaction so the balance check and the
  // pending-settlement insert are atomic.
  return database.transaction(() => {
    const receivable = database.prepare(
      `SELECT accruedBaseUnits FROM ProviderReceivable WHERE ownerAddress = ? AND currency = ?`
    ).get(ownerAddress, currency)
    const totalReceivableBaseUnitsAtSettlement = receivable?.accruedBaseUnits || '0'

    // Compute current unpaid = accrued - sum(completed + pending settlements).
    // Pending settlements MUST be reserved against the balance: otherwise an
    // admin could create multiple pending settlements that each individually
    // pass the "<= unpaid" check (because pending ones were ignored), then
    // complete them all and over-settle the provider's receivable (double-pay).
    const reservedRows = database.prepare(`
      SELECT amountBaseUnits FROM ProviderSettlementRecord
      WHERE ownerAddress = ? AND currency = ? AND status IN ('completed', 'pending')
    `).all(ownerAddress, currency)
    const alreadyReserved = reservedRows.reduce((acc, r) => acc + BigInt(r.amountBaseUnits), 0n)
    const unpaid = BigInt(totalReceivableBaseUnitsAtSettlement) - alreadyReserved

    if (BigInt(amountBaseUnits) > unpaid)
      throw Object.assign(
        new Error(`Settlement amount ${amountBaseUnits} exceeds unpaid balance ${unpaid.toString()}`),
        { code: 'EXCEEDS_UNPAID_BALANCE' }
      )

    const settlementId = randomUUID()
    const now = nowIso()
    database.prepare(`
      INSERT INTO ProviderSettlementRecord
        (settlementId, ownerAddress, currency, amountBaseUnits,
         totalReceivableBaseUnitsAtSettlement, method, reference, status, createdAt, processedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
    `).run(settlementId, ownerAddress, currency, amountBaseUnits,
      totalReceivableBaseUnitsAtSettlement, method, reference, now)
    return { settlementId }
  })()
}

export function processSettlement(settlementId, decision) {
  if (decision !== 'completed' && decision !== 'failed')
    throw Object.assign(new Error('decision must be completed or failed'), { code: 'INVALID_DECISION' })

  const database = getDb()
  return database.transaction(() => {
    const record = database.prepare(
      `SELECT * FROM ProviderSettlementRecord WHERE settlementId = ?`
    ).get(settlementId)
    if (!record) throw Object.assign(new Error('SettlementRecord not found'), { code: 'NOT_FOUND' })
    if (record.status !== 'pending')
      throw Object.assign(new Error(`SettlementRecord already ${record.status}`), { code: 'ALREADY_PROCESSED' })

    const now = nowIso()
    database.prepare(
      `UPDATE ProviderSettlementRecord SET status = ?, processedAt = ? WHERE settlementId = ?`
    ).run(decision, now, settlementId)

    if (decision === 'completed') {
      database.prepare(`
        INSERT INTO LedgerEvent
          (eventId, eventType, taskId, requesterAgentId, providerAgentId,
           providerOwnerAddress, amountBaseUnits, currency, agreementHash, createdAt)
        VALUES (?, 'provider_settled', NULL, NULL, NULL, ?, ?, ?, NULL, ?)
      `).run(randomUUID(), record.ownerAddress, record.amountBaseUnits, record.currency, now)
    }

    return { ok: true, decision }
  })()
}

export function getSettlementHistory(ownerAddress) {
  const database = getDb()
  const settlements = database.prepare(`
    SELECT * FROM ProviderSettlementRecord WHERE ownerAddress = ? ORDER BY createdAt DESC
  `).all(ownerAddress)

  // Compute settled total per currency (completed only)
  const settledByCurrency = {}
  for (const s of settlements) {
    if (s.status === 'completed') {
      settledByCurrency[s.currency] = (
        BigInt(settledByCurrency[s.currency] || '0') + BigInt(s.amountBaseUnits)
      ).toString()
    }
  }

  return { settlements, settledByCurrency }
}

export function getSettlementById(settlementId) {
  return getDb().prepare(
    `SELECT * FROM ProviderSettlementRecord WHERE settlementId = ?`
  ).get(settlementId) || null
}

// ── Query surfaces ────────────────────────────────────────────────────────────

export function getProviderReceivable(ownerAddress) {
  const database = getDb()
  const receivables = database.prepare(
    `SELECT * FROM ProviderReceivable WHERE ownerAddress = ?`
  ).all(ownerAddress)

  const recentInvocations = database.prepare(`
    SELECT taskId, providerAgentId, status, chargedAt, createdAt, completedAt
    FROM InvocationRecord
    WHERE providerOwnerAddress = ? AND completedAt IS NOT NULL
    ORDER BY completedAt DESC LIMIT 10
  `).all(ownerAddress)

  // Compute paid/unpaid per currency
  const completedSettlements = database.prepare(`
    SELECT currency, amountBaseUnits
    FROM ProviderSettlementRecord
    WHERE ownerAddress = ? AND status = 'completed'
  `).all(ownerAddress)

  const settledByCurrency = {}
  for (const s of completedSettlements) {
    settledByCurrency[s.currency] = (
      BigInt(settledByCurrency[s.currency] || '0') + BigInt(s.amountBaseUnits)
    ).toString()
  }

  const balance = receivables.map(r => {
    const settled = settledByCurrency[r.currency] || '0'
    const unpaid  = (BigInt(r.accruedBaseUnits) - BigInt(settled)).toString()
    return { currency: r.currency, accruedBaseUnits: r.accruedBaseUnits, settledBaseUnits: settled, unpaidBaseUnits: unpaid }
  })

  return { balance, recentInvocations }
}

export function getTaskTrace(taskId) {
  const database   = getDb()
  const agreement  = database.prepare(`SELECT * FROM TaskAgreement       WHERE taskId = ?`).get(taskId)
  const agreementProof = database.prepare(`SELECT * FROM TaskAgreementProof WHERE taskId = ?`).get(taskId) || null
  const invocation = database.prepare(`SELECT * FROM InvocationRecord    WHERE taskId = ?`).get(taskId)
  const events     = database.prepare(`SELECT * FROM LedgerEvent          WHERE taskId = ? ORDER BY createdAt`).all(taskId)
  const deliveryReceipt = database.prepare(`SELECT * FROM DeliveryReceipt WHERE taskId = ?`).get(taskId) || null
  return { agreement, agreementProof, invocation, events, deliveryReceipt }
}

export function getAuthStats() {
  const database = getDb()

  // Counts by auth method (all time)
  const totals = database.prepare(`
    SELECT authMethodUsed, COUNT(*) as count
    FROM InvocationRecord
    GROUP BY authMethodUsed
  `).all()

  // Counts by auth method in last 24 hours
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const last24h = database.prepare(`
    SELECT authMethodUsed, COUNT(*) as count
    FROM InvocationRecord
    WHERE createdAt >= ?
    GROUP BY authMethodUsed
  `).all(since24h)

  // Most recent requesters using wallet-signature (last 20 tasks)
  const recentWallet = database.prepare(`
    SELECT requesterAgentId, MAX(createdAt) as lastUsedAt, COUNT(*) as taskCount
    FROM InvocationRecord
    WHERE authMethodUsed = 'wallet-signature'
    GROUP BY requesterAgentId
    ORDER BY lastUsedAt DESC
    LIMIT 20
  `).all()

  // Requesters still on api-key in last 7 days (candidates for migration)
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const apiKeyRequesters = database.prepare(`
    SELECT requesterAgentId, MAX(createdAt) as lastUsedAt, COUNT(*) as taskCount
    FROM InvocationRecord
    WHERE authMethodUsed = 'api-key' AND createdAt >= ?
    GROUP BY requesterAgentId
    ORDER BY lastUsedAt DESC
  `).all(since7d)

  return { totals, last24h, recentWallet, apiKeyRequesters }
}

// ── Seed helper ───────────────────────────────────────────────────────────────

export function seedRequester({
  rawKey, requesterAgentId, ownerAddress,
  currency = 'DATA', remainingBaseUnits, maxPerTaskBaseUnits, dailyLimitBaseUnits,
}) {
  const now = nowIso()
  const database = getDb()
  // rawKey=null means wallet-only requester: skip RequesterAuth + api-key method
  const apiKeyHash = rawKey != null ? hashApiKey(rawKey) : null

  database.transaction(() => {
    // Deprecated RequesterAuth — kept for backward compat; omit for wallet-only requesters
    if (apiKeyHash != null) {
      database.prepare(`
        INSERT OR REPLACE INTO RequesterAuth
          (apiKeyHash, requesterAgentId, ownerAddress, status, createdAt)
        VALUES (?, ?, ?, 'active', ?)
      `).run(apiKeyHash, requesterAgentId, ownerAddress, now)
    }

    // Phase D: RequesterIdentity + RequesterAuthMethod
    database.prepare(`
      INSERT OR REPLACE INTO RequesterIdentity
        (requesterAgentId, ownerAddress, status, createdAt, updatedAt)
      VALUES (?, ?, 'active', ?, ?)
    `).run(requesterAgentId, ownerAddress, now, now)

    if (apiKeyHash != null) {
      database.prepare(`
        INSERT OR IGNORE INTO RequesterAuthMethod
          (authMethodId, requesterAgentId, ownerAddress, methodType, methodRef, status, createdAt, updatedAt)
        VALUES (?, ?, ?, 'api-key', ?, 'active', ?, ?)
      `).run(randomUUID(), requesterAgentId, ownerAddress, apiKeyHash, now, now)
    }

    database.prepare(`
      INSERT OR REPLACE INTO RequesterBudget
        (requesterAgentId, ownerAddress, currency,
         remainingBaseUnits, reservedBaseUnits, maxPerTaskBaseUnits, dailyLimitBaseUnits,
         dailySpentBaseUnits, dailySpentWindowStart, faucetClaimedAt, updatedAt)
      VALUES (?, ?, ?, ?, '0', ?, ?, '0', ?, NULL, ?)
    `).run(requesterAgentId, ownerAddress, currency,
      remainingBaseUnits, maxPerTaskBaseUnits, dailyLimitBaseUnits,
      utcDayStart(now), now)

    if (BigInt(remainingBaseUnits) > 0n) {
      database.prepare(`
        INSERT INTO LedgerEvent
          (eventId, eventType, taskId, requesterAgentId, providerAgentId,
           providerOwnerAddress, amountBaseUnits, currency, agreementHash, createdAt)
        VALUES (?, 'budget_seeded', NULL, ?, NULL, NULL, ?, ?, NULL, ?)
      `).run(randomUUID(), requesterAgentId, remainingBaseUnits, currency, now)
    }
  })()
}

// ── Self-service registration ────────────────────────────────────────────────

export function selfRegisterRequester({ requesterAgentId, ownerAddress }) {
  const database = getDb()
  const normalized = normalizeAddress(ownerAddress)

  database.transaction(() => {
    // Check: agentId already taken?
    const existing = database.prepare(
      `SELECT requesterAgentId FROM RequesterIdentity WHERE requesterAgentId = ?`
    ).get(requesterAgentId)
    if (existing) {
      const e = new Error(`requesterAgentId already registered: ${requesterAgentId}`)
      e.code = 'AGENT_ID_TAKEN'; throw e
    }

    // Check: wallet already registered?
    const byWallet = database.prepare(
      `SELECT requesterAgentId FROM RequesterIdentity WHERE ownerAddress = ? AND status = 'active'`
    ).get(normalized)
    if (byWallet) {
      const e = new Error(`Wallet already registered as: ${byWallet.requesterAgentId}`)
      e.code = 'WALLET_ALREADY_REGISTERED'; throw e
    }

    // Create identity with zero budget — faucet grant is separate
    seedRequester({
      rawKey: null,
      requesterAgentId,
      ownerAddress: normalized,
      remainingBaseUnits:  '0',
      maxPerTaskBaseUnits: '0',
      dailyLimitBaseUnits: '0',
    })

    // Bind wallet auth method
    bindWalletMethod({ requesterAgentId, ownerAddress: normalized })
  })()

  return { ok: true, requesterAgentId, ownerAddress: normalized }
}

// ── Faucet: one-time budget grant ────────────────────────────────────────────

const FAUCET_ENABLED    = process.env.FAUCET_ENABLED !== 'false'  // on by default
const FAUCET_BUDGET     = process.env.FAUCET_BUDGET     || '10000000000000000000'  // 10 DATA
const FAUCET_PER_TASK   = process.env.FAUCET_PER_TASK   || '2000000000000000000'   // 2 DATA
const FAUCET_DAILY      = process.env.FAUCET_DAILY      || '5000000000000000000'   // 5 DATA

export function claimFaucet({ requesterAgentId, ownerAddress }) {
  if (!FAUCET_ENABLED) {
    const e = new Error('Faucet is currently disabled')
    e.code = 'FAUCET_DISABLED'; throw e
  }

  const database = getDb()
  const normalized = normalizeAddress(ownerAddress)

  // Must be a registered identity
  const identity = database.prepare(
    `SELECT * FROM RequesterIdentity WHERE requesterAgentId = ? AND status = 'active'`
  ).get(requesterAgentId)
  if (!identity) {
    const e = new Error('Requester not found')
    e.code = 'REQUESTER_NOT_FOUND'; throw e
  }
  if (identity.ownerAddress !== normalized) {
    const e = new Error('ownerAddress mismatch')
    e.code = 'OWNER_MISMATCH'; throw e
  }

  // Check if already claimed — keyed on faucetClaimedAt, not balance (balance can reach 0 after spending)
  const budget = database.prepare(
    `SELECT faucetClaimedAt FROM RequesterBudget WHERE requesterAgentId = ?`
  ).get(requesterAgentId)
  if (budget && budget.faucetClaimedAt !== null) {
    const e = new Error('Faucet already claimed')
    e.code = 'ALREADY_CLAIMED'; throw e
  }

  // Grant budget
  const now = nowIso()
  database.prepare(`
    UPDATE RequesterBudget
    SET remainingBaseUnits = ?, maxPerTaskBaseUnits = ?, dailyLimitBaseUnits = ?,
        dailySpentBaseUnits = '0', dailySpentWindowStart = ?, faucetClaimedAt = ?, updatedAt = ?
    WHERE requesterAgentId = ?
  `).run(FAUCET_BUDGET, FAUCET_PER_TASK, FAUCET_DAILY, utcDayStart(now), now, now, requesterAgentId)

  database.prepare(`
    INSERT INTO LedgerEvent
      (eventId, eventType, taskId, requesterAgentId, providerAgentId,
       providerOwnerAddress, amountBaseUnits, currency, agreementHash, createdAt)
    VALUES (?, 'budget_seeded', NULL, ?, NULL, NULL, ?, 'DATA', NULL, ?)
  `).run(randomUUID(), requesterAgentId, FAUCET_BUDGET, now)

  return { ok: true, requesterAgentId, budget: { remaining: FAUCET_BUDGET, currency: 'DATA' } }
}
