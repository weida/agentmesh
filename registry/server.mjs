/**
 * SavantDex Registry Server v0.6
 *
 * Registration fields (all optional unless noted):
 *   agentId, streamId, capabilities[]  — required
 *   description, name, category, docsUrl
 *   inputSchema[], outputSchema[]       — field definitions
 *   exampleInput, exampleOutput
 *   taskType          string  — e.g. "screen-token", "analyze-tx"
 *   protocolVersion   string  — e.g. "1.0"
 *   supportsAsync     bool
 *   expectedLatencyMs number
 *   authType          string  — e.g. "none", "api-key"
 *   pricingModel      object  — e.g. { type: "free" }
 *
 * Auth model (v0.4 — new registrations):
 *   POST /agents/register body must include:
 *     { ownerAddress, runtimeAddress, agentId, streamId, timestamp, signature }
 *
 *   signature = personal_sign(
 *     "Authorize runtime {runtimeAddress} for agent {agentId} stream {streamId} ts:{timestamp}"
 *   )
 *   - Signer must be ownerAddress
 *   - streamId address prefix must equal runtimeAddress
 *   - timestamp within 5-minute window
 *
 *   Demo note: ownerAddress and runtimeAddress may be the same address while
 *   key separation has not yet been completed (Phase 1-Migration pending).
 *
 * Legacy auth model (v0.3 — kept for backward compatibility):
 *   body: { owner, agentId, streamId, timestamp, signature }
 *   signature = personal_sign( "Register {agentId} {streamId} ts:{timestamp}" )
 *   Existing records created before v0.4 are still readable and deletable.
 *
 * Delete: headers X-Timestamp + X-Signature
 *   signature = personal_sign( "Delete {agentId} ts:{timestamp}" )
 *   Signer must be ownerAddress (v0.4) or owner (legacy)
 *
 * Discovery endpoints:
 *   GET /agents                   — list all agents (filterable), includes callHint
 *   GET /agents/search            — alias, same filter logic
 *   GET /agents/:agentId          — single agent detail with callHint
 *   GET /agents/:agentId/card     — A2A-style standardized agent card (computed view)
 *
 * Filter params:
 *   capability, category, q / keyword, supportsAsync, maxExpectedLatencyMs
 *
 * Agent Card format (savantdex/card/1.0):
 *   { schemaVersion, id, name, version, description, provider, capabilities,
 *     skills[{ id, description, inputSchema, outputSchema, expectedLatencyMs }],
 *     invocation{ protocol, protocolVersion, streamId, taskType },
 *     status, registeredAt, updatedAt }
 */

import process from 'process'
process.umask(0o077)

import { createServer } from 'http'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs'
import { timingSafeEqual } from 'crypto'
import { verifyMessage } from 'ethers'
import { createPowChallenge, verifyPow } from '../sdk/pow.mjs'

const PORT          = process.env.PORT || 3000
const DB_FILE       = process.env.DB_FILE || './agents.json'
const SIG_WINDOW_MS = 5 * 60 * 1000
const ADMIN_API_KEY = process.env.REGISTRY_ADMIN_API_KEY || null

// CORS: GET is open (SDKs, agents, and frontends all read the registry).
// POST/DELETE are restricted to known origins to prevent cross-origin writes.
const CORS_WRITE_ORIGINS = (process.env.CORS_WRITE_ORIGINS ||
  'http://localhost:3001,http://127.0.0.1:3001,https://savantdex.weicao.dev,https://lab.garlicspace.com'
).split(',').map(s => s.trim()).filter(Boolean)

function corsHeaders(req, isWrite) {
  const origin = req.headers.origin
  if (!origin) return { 'Access-Control-Allow-Origin': '*' }
  if (CORS_WRITE_ORIGINS.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' }
  }
  // Unknown origin on a write path: omit ACAO so the browser blocks it
  if (isWrite) return { 'Vary': 'Origin' }
  // Read path: open
  return { 'Access-Control-Allow-Origin': '*' }
}

// ── Admin auth ───────────────────────────────────────────────────────────────

const ADMIN_KEY_BUF   = ADMIN_API_KEY ? Buffer.from(ADMIN_API_KEY, 'utf8') : null
const ADMIN_KEY_DUMMY = ADMIN_KEY_BUF ? Buffer.alloc(ADMIN_KEY_BUF.length) : null

function requireAdmin(req) {
  if (!ADMIN_KEY_BUF) return { ok: false, status: 503, error: 'Admin not configured' }
  const provided = req.headers['x-admin-key']
  if (typeof provided !== 'string') {
    timingSafeEqual(ADMIN_KEY_DUMMY, ADMIN_KEY_DUMMY)
    return { ok: false, status: 401, error: 'Invalid or missing X-Admin-Key' }
  }
  const supplied = Buffer.from(provided, 'utf8')
  if (supplied.length !== ADMIN_KEY_BUF.length) {
    timingSafeEqual(ADMIN_KEY_DUMMY, ADMIN_KEY_DUMMY)
    return { ok: false, status: 401, error: 'Invalid or missing X-Admin-Key' }
  }
  if (!timingSafeEqual(supplied, ADMIN_KEY_BUF)) {
    return { ok: false, status: 401, error: 'Invalid or missing X-Admin-Key' }
  }
  return { ok: true }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function loadDB() {
  if (!existsSync(DB_FILE)) return {}
  return JSON.parse(readFileSync(DB_FILE, 'utf8'))
}

function saveDB(db) {
  // Atomic write: serialize to a temp file in the same directory, then rename
  // over the target. rename(2) is atomic on POSIX, so a crash mid-write can
  // never leave a truncated/corrupt agents.json — readers see either the old
  // file or the fully-written new one.
  const tmp = `${DB_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(db, null, 2))
  renameSync(tmp, DB_FILE)
}

// ── Signature helpers ─────────────────────────────────────────────────────────

/**
 * v0.4: owner authorizes runtime
 * message = "Authorize runtime {runtimeAddress} for agent {agentId} stream {streamId} ts:{timestamp}"
 */
function verifyOwnerRuntimeSig({ agentId, streamId, ownerAddress, runtimeAddress, timestamp, signature }) {
  if (!signature || !timestamp || !ownerAddress || !runtimeAddress) {
    return { ok: false, error: 'ownerAddress, runtimeAddress, timestamp and signature are required' }
  }

  const age = Date.now() - Number(timestamp)
  if (age > SIG_WINDOW_MS || age < -30000) {
    return { ok: false, error: 'Timestamp expired or invalid (±5 min window)' }
  }

  // streamId must be owned by runtimeAddress: format is {runtimeAddress}/savantdex/{agentId}
  const streamOwner = streamId.split('/')[0].toLowerCase()
  if (streamOwner !== runtimeAddress.toLowerCase()) {
    return { ok: false, error: `streamId address prefix (${streamOwner}) does not match runtimeAddress (${runtimeAddress.toLowerCase()})` }
  }

  const message = `Authorize runtime ${runtimeAddress.toLowerCase()} for agent ${agentId} stream ${streamId} ts:${timestamp}`
  try {
    const recovered = verifyMessage(message, signature).toLowerCase()
    if (recovered !== ownerAddress.toLowerCase()) {
      return { ok: false, error: 'Signature does not match ownerAddress' }
    }
    return { ok: true, ownerAddress: recovered, runtimeAddress: runtimeAddress.toLowerCase() }
  } catch {
    return { ok: false, error: 'Invalid signature' }
  }
}

/**
 * v0.3 legacy: single owner registers directly
 * Kept for backward compatibility with existing workers and records.
 */
function verifyLegacySig({ agentId, streamId, owner, timestamp, signature }) {
  if (!signature || !timestamp || !owner) {
    return { ok: false, error: 'owner, timestamp and signature are required' }
  }
  const age = Date.now() - Number(timestamp)
  if (age > SIG_WINDOW_MS || age < -30000) {
    return { ok: false, error: 'Timestamp expired or invalid (±5 min window)' }
  }
  const message = `Register ${agentId} ${streamId} ts:${timestamp}`
  try {
    const recovered = verifyMessage(message, signature).toLowerCase()
    if (recovered !== owner.toLowerCase()) {
      return { ok: false, error: 'Signature does not match owner address' }
    }
    return { ok: true, address: recovered }
  } catch {
    return { ok: false, error: 'Invalid signature' }
  }
}

function verifyDeleteSig({ agentId, ownerAddress, timestamp, signature }) {
  if (!signature || !timestamp) {
    return { ok: false, error: 'X-Timestamp and X-Signature headers are required' }
  }
  const age = Date.now() - Number(timestamp)
  if (age > SIG_WINDOW_MS || age < -30000) {
    return { ok: false, error: 'Timestamp expired or invalid (±5 min window)' }
  }
  const message = `Delete ${agentId} ts:${timestamp}`
  try {
    const recovered = verifyMessage(message, signature).toLowerCase()
    if (recovered !== ownerAddress.toLowerCase()) {
      return { ok: false, error: 'Signature does not match owner address' }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Invalid signature' }
  }
}

// ── callHint builder ──────────────────────────────────────────────────────────

/**
 * Builds a self-contained call descriptor for requester agents.
 * Contains everything needed to call this agent without reading raw registry fields.
 */
function buildCallHint(record) {
  const hint = {
    streamId:          record.streamId,
    taskType:          record.taskType || null,
    inputSchema:       record.inputSchema || [],
    supportsAsync:     record.supportsAsync ?? false,
    expectedLatencyMs: record.expectedLatencyMs || null,
  }
  if (record.protocolVersion) hint.protocolVersion = record.protocolVersion
  if (record.authType)        hint.authType = record.authType
  return hint
}

function withCallHint(record) {
  return { ...record, callHint: buildCallHint(record) }
}

// ── Agent Card builder (A2A-aligned descriptor) ───────────────────────────────

/**
 * Builds a standardized agent card from a registry record.
 * Computed view — no extra stored fields required.
 * Format: savantdex/card/1.0 (inspired by Google A2A agent card spec)
 */
function buildAgentCard(record) {
  // skills = one skill per taskType (or one generic skill if no taskType)
  const skill = {
    id:                record.taskType || record.agentId,
    description:       record.description || '',
    inputSchema:       record.inputSchema  || [],
    outputSchema:      record.outputSchema || [],
    expectedLatencyMs: record.expectedLatencyMs || null,
  }

  return {
    schemaVersion: 'savantdex/card/1.0',
    id:            record.agentId,
    name:          record.name || record.agentId,
    version:       record.protocolVersion || null,
    description:   record.description || '',
    provider: {
      ownerAddress:   record.ownerAddress || record.owner || null,
      runtimeAddress: record.runtimeAddress || null,
      network:        'streamr/polygon',
    },
    capabilities: {
      streaming:  false,
      async:      record.supportsAsync ?? false,
      interrupts: false,
      authType:   record.authType || 'none',
    },
    skills: [ skill ],
    invocation: {
      protocol:        'savantdex',
      protocolVersion: record.protocolVersion || null,
      streamId:        record.streamId,
      taskType:        record.taskType || null,
      transport:       record.transport === 'relay' ? ['relay'] : ['streamr'],
    },
    pricingModel:  record.pricingModel || { type: 'free' },
    docsUrl:       record.docsUrl || null,
    status:        record.status || 'active',
    registeredAt:  record.registeredAt || null,
    updatedAt:     record.updatedAt || null,
  }
}

// ── Shared filter logic ───────────────────────────────────────────────────────

function filterAgents(db, params) {
  const capability       = params.get?.('capability')?.toLowerCase()  ?? params.capability?.toLowerCase()
  const category         = params.get?.('category')?.toLowerCase()    ?? params.category?.toLowerCase()
  const kw               = (params.get?.('q') ?? params.get?.('keyword') ?? params.q ?? params.keyword)?.toLowerCase()
  const asyncOnly        = params.get?.('supportsAsync') ?? params.supportsAsync
  const maxLatencyStr    = params.get?.('maxExpectedLatencyMs') ?? params.maxExpectedLatencyMs

  let results = Object.values(db)

  if (capability) results = results.filter(a => a.capabilities?.includes(capability))
  if (category)   results = results.filter(a => a.category === category)
  if (kw)         results = results.filter(a =>
    a.agentId?.toLowerCase().includes(kw) ||
    (a.description || '').toLowerCase().includes(kw) ||
    (a.name || '').toLowerCase().includes(kw) ||
    a.capabilities?.some(c => c.includes(kw))
  )
  if (asyncOnly === 'true' || asyncOnly === true) {
    results = results.filter(a => a.supportsAsync === true)
  }
  if (maxLatencyStr != null) {
    const maxMs = Number(maxLatencyStr)
    if (Number.isFinite(maxMs)) {
      results = results.filter(a => a.expectedLatencyMs == null || a.expectedLatencyMs <= maxMs)
    }
  }

  return results.map(withCallHint)
}

// ── Route handlers ────────────────────────────────────────────────────────────

function registerAgent(db, body) {
  const {
    agentId, streamId, capabilities = [], description = '',
    // v0.4 fields
    ownerAddress, runtimeAddress,
    // v0.3 legacy fields
    owner, timestamp, signature,
    // display fields
    name, category, exampleInput, exampleOutput, inputSchema, docsUrl,
    // agent-native discovery fields
    taskType, outputSchema, protocolVersion, supportsAsync, expectedLatencyMs, authType, pricingModel,
  } = body

  if (!agentId || !streamId) {
    return { status: 400, data: { error: 'agentId and streamId are required' } }
  }
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return { status: 400, data: { error: 'capabilities must be a non-empty array' } }
  }

  let resolvedOwner, resolvedRuntime, authVersion

  if (ownerAddress && runtimeAddress) {
    // v0.4 path: owner authorizes runtime
    const result = verifyOwnerRuntimeSig({ agentId, streamId, ownerAddress, runtimeAddress, timestamp, signature })
    if (!result.ok) return { status: 401, data: { error: result.error } }
    resolvedOwner   = result.ownerAddress
    resolvedRuntime = result.runtimeAddress
    authVersion     = 'v0.4'
  } else if (owner) {
    // v0.3 legacy path: single-address registration
    const result = verifyLegacySig({ agentId, streamId, owner, timestamp, signature })
    if (!result.ok) return { status: 401, data: { error: result.error } }
    resolvedOwner   = result.address
    resolvedRuntime = result.address  // owner == runtime in legacy model
    authVersion     = 'v0.3-legacy'
  } else {
    return { status: 401, data: { error: 'ownerAddress+runtimeAddress (v0.4) or owner (legacy) required' } }
  }

  // Re-registration ownership check
  const existing = db[agentId]
  const existingOwner = existing?.ownerAddress || existing?.owner
  if (existing && existingOwner && existingOwner !== resolvedOwner) {
    return { status: 403, data: { error: 'Cannot overwrite: different owner' } }
  }

  const record = {
    agentId,
    streamId,
    capabilities: capabilities.map(c => c.toLowerCase()),
    description,
    ownerAddress:   resolvedOwner,
    runtimeAddress: resolvedRuntime,
    status:         'active',
    authVersion,
    registeredAt:   existing?.registeredAt || new Date().toISOString(),
    updatedAt:      new Date().toISOString(),
  }

  if (name !== undefined)          record.name = String(name).slice(0, 100)
  if (category !== undefined)      record.category = String(category).slice(0, 50).toLowerCase()
  if (docsUrl !== undefined)       record.docsUrl = String(docsUrl).slice(0, 500)
  if (exampleInput !== undefined && typeof exampleInput === 'object')   record.exampleInput = exampleInput
  if (exampleOutput !== undefined && typeof exampleOutput === 'object') record.exampleOutput = exampleOutput
  if (Array.isArray(inputSchema))  record.inputSchema = inputSchema
  // agent-native discovery fields
  if (taskType !== undefined)                                           record.taskType = String(taskType).slice(0, 100)
  if (Array.isArray(outputSchema))                                      record.outputSchema = outputSchema
  if (protocolVersion !== undefined)                                    record.protocolVersion = String(protocolVersion).slice(0, 20)
  if (supportsAsync !== undefined)                                      record.supportsAsync = Boolean(supportsAsync)
  if (expectedLatencyMs !== undefined && Number.isFinite(Number(expectedLatencyMs))) record.expectedLatencyMs = Number(expectedLatencyMs)
  if (authType !== undefined)                                           record.authType = String(authType).slice(0, 50)
  if (pricingModel !== undefined && typeof pricingModel === 'object')  record.pricingModel = pricingModel

  db[agentId] = record
  saveDB(db)
  return { status: 200, data: { ok: true, agentId, streamId, ownerAddress: resolvedOwner, runtimeAddress: resolvedRuntime } }
}

function listAgents(db, searchParams) {
  const results = filterAgents(db, searchParams)
  return { status: 200, data: { count: results.length, agents: results } }
}

function getAgent(db, agentId) {
  const agent = db[agentId]
  if (!agent) return { status: 404, data: { error: `Agent not found: ${agentId}` } }
  return { status: 200, data: withCallHint(agent) }
}

function deleteAgent(db, agentId, headers) {
  const agent = db[agentId]
  if (!agent) return { status: 404, data: { error: `Agent not found: ${agentId}` } }

  // Resolve owner address from either v0.4 or legacy record
  const ownerAddress = agent.ownerAddress || agent.owner
  if (!ownerAddress) {
    // No owner stored — legacy record; refuse deletion (no way to verify ownership)
    return { status: 403, data: { error: 'Cannot delete legacy record without ownerAddress — contact admin' } }
  }

  const { ok, error } = verifyDeleteSig({
    agentId,
    ownerAddress,
    timestamp: headers['x-timestamp'],
    signature: headers['x-signature'],
  })
  if (!ok) return { status: 401, data: { error } }

  delete db[agentId]
  saveDB(db)
  return { status: 200, data: { ok: true, deleted: agentId } }
}

/**
 * Admin-assisted registration for relay-only providers.
 * No wallet signature required — admin key is the auth.
 * Generates a synthetic streamId (relay://{agentId}) since relay agents don't use Streamr P2P.
 */
// ── Faucet: self-service agent registration ──────────────────────────────────

const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{2,48}[a-z0-9]$/
const REG_SIG_WINDOW_MS = 5 * 60 * 1000

function selfRegisterAgent(db, body) {
  const {
    agentId, ownerAddress, timestamp, signature, challengeId, nonce,
    capabilities = [],
    description, name, category, docsUrl,
    taskType, inputSchema, outputSchema, exampleInput, exampleOutput,
    protocolVersion, supportsAsync, expectedLatencyMs, pricingModel,
  } = body

  // Required fields
  if (!agentId) return { status: 400, data: { error: 'agentId is required' } }
  if (!ownerAddress) return { status: 400, data: { error: 'ownerAddress is required' } }
  if (!timestamp || !signature || !challengeId || !nonce)
    return { status: 400, data: { error: 'timestamp, signature, challengeId, nonce required' } }
  if (!Array.isArray(capabilities) || capabilities.length === 0)
    return { status: 400, data: { error: 'capabilities must be a non-empty array' } }

  // agentId format
  if (!AGENT_ID_RE.test(agentId))
    return { status: 400, data: { error: 'Invalid agentId format (lowercase alphanumeric, 4-50 chars)' } }

  // Timestamp window
  if (Math.abs(Date.now() - timestamp) > REG_SIG_WINDOW_MS)
    return { status: 400, data: { error: 'Timestamp out of range (±5 min)' } }

  // Verify PoW
  try { verifyPow(challengeId, nonce) } catch (e) {
    return { status: 400, data: { error: e.message } }
  }

  // Verify wallet signature
  const message = `savantdex-register-agent:${agentId}:${ownerAddress.toLowerCase()}:${timestamp}`
  let recovered
  try { recovered = verifyMessage(message, signature) } catch {
    return { status: 400, data: { error: 'Invalid signature format' } }
  }
  if (recovered.toLowerCase() !== ownerAddress.toLowerCase())
    return { status: 401, data: { error: 'Signature does not match ownerAddress' } }

  // Ownership check for re-registration
  const existing = db[agentId]
  const existingOwner = existing?.ownerAddress || existing?.owner
  if (existing && existingOwner && existingOwner.toLowerCase() !== ownerAddress.toLowerCase())
    return { status: 403, data: { error: `Cannot overwrite: different owner` } }

  const streamId = `relay://${agentId}`

  const record = {
    agentId,
    streamId,
    capabilities: capabilities.map(c => c.toLowerCase()),
    description:    description || '',
    ownerAddress:   ownerAddress.toLowerCase(),
    runtimeAddress: null,
    status:         'active',
    authVersion:    'self-registered',
    transport:      'relay',
    registeredAt:   existing?.registeredAt || new Date().toISOString(),
    updatedAt:      new Date().toISOString(),
  }

  if (name !== undefined)          record.name = String(name).slice(0, 100)
  if (category !== undefined)      record.category = String(category).slice(0, 50).toLowerCase()
  if (docsUrl !== undefined)       record.docsUrl = String(docsUrl).slice(0, 500)
  if (exampleInput !== undefined && typeof exampleInput === 'object')   record.exampleInput = exampleInput
  if (exampleOutput !== undefined && typeof exampleOutput === 'object') record.exampleOutput = exampleOutput
  if (Array.isArray(inputSchema))  record.inputSchema = inputSchema
  if (taskType !== undefined)                                           record.taskType = String(taskType).slice(0, 100)
  if (Array.isArray(outputSchema))                                      record.outputSchema = outputSchema
  if (protocolVersion !== undefined)                                    record.protocolVersion = String(protocolVersion).slice(0, 20)
  if (supportsAsync !== undefined)                                      record.supportsAsync = Boolean(supportsAsync)
  if (expectedLatencyMs !== undefined && Number.isFinite(Number(expectedLatencyMs))) record.expectedLatencyMs = Number(expectedLatencyMs)
  if (pricingModel !== undefined && typeof pricingModel === 'object')  record.pricingModel = pricingModel

  db[agentId] = record
  saveDB(db)
  return { status: 200, data: { ok: true, agentId, streamId, ownerAddress: record.ownerAddress, transport: 'relay' } }
}

function adminRegisterAgent(db, body) {
  const {
    agentId, ownerAddress, capabilities = [],
    description, name, category, docsUrl,
    taskType, inputSchema, outputSchema, exampleInput, exampleOutput,
    protocolVersion, supportsAsync, expectedLatencyMs, authType, pricingModel,
    streamId: explicitStreamId,
  } = body

  if (!agentId) return { status: 400, data: { error: 'agentId is required' } }
  if (!ownerAddress) return { status: 400, data: { error: 'ownerAddress is required' } }
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return { status: 400, data: { error: 'capabilities must be a non-empty array' } }
  }

  // Re-registration ownership check (admin can override by passing the same ownerAddress)
  const existing = db[agentId]
  const existingOwner = existing?.ownerAddress || existing?.owner
  if (existing && existingOwner && existingOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
    return { status: 403, data: { error: `Cannot overwrite: different owner (existing: ${existingOwner})` } }
  }

  const streamId = explicitStreamId || `relay://${agentId}`

  const record = {
    agentId,
    streamId,
    capabilities: capabilities.map(c => c.toLowerCase()),
    description:    description || '',
    ownerAddress:   ownerAddress.toLowerCase(),
    runtimeAddress: null,
    status:         'active',
    authVersion:    'admin',
    transport:      'relay',
    registeredAt:   existing?.registeredAt || new Date().toISOString(),
    updatedAt:      new Date().toISOString(),
  }

  if (name !== undefined)          record.name = String(name).slice(0, 100)
  if (category !== undefined)      record.category = String(category).slice(0, 50).toLowerCase()
  if (docsUrl !== undefined)       record.docsUrl = String(docsUrl).slice(0, 500)
  if (exampleInput !== undefined && typeof exampleInput === 'object')   record.exampleInput = exampleInput
  if (exampleOutput !== undefined && typeof exampleOutput === 'object') record.exampleOutput = exampleOutput
  if (Array.isArray(inputSchema))  record.inputSchema = inputSchema
  if (taskType !== undefined)                                           record.taskType = String(taskType).slice(0, 100)
  if (Array.isArray(outputSchema))                                      record.outputSchema = outputSchema
  if (protocolVersion !== undefined)                                    record.protocolVersion = String(protocolVersion).slice(0, 20)
  if (supportsAsync !== undefined)                                      record.supportsAsync = Boolean(supportsAsync)
  if (expectedLatencyMs !== undefined && Number.isFinite(Number(expectedLatencyMs))) record.expectedLatencyMs = Number(expectedLatencyMs)
  if (authType !== undefined)                                           record.authType = String(authType).slice(0, 50)
  if (pricingModel !== undefined && typeof pricingModel === 'object')  record.pricingModel = pricingModel

  db[agentId] = record
  saveDB(db)
  return { status: 200, data: { ok: true, agentId, streamId, ownerAddress: record.ownerAddress, transport: 'relay' } }
}

/**
 * Admin delete — allows removing any agent without owner signature.
 */
function adminDeleteAgent(db, agentId) {
  if (!db[agentId]) return { status: 404, data: { error: 'Agent not found' } }
  delete db[agentId]
  saveDB(db)
  return { status: 200, data: { ok: true, deleted: agentId } }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    // Preflight: detect if the actual request will be a write (POST/DELETE)
    const requestedMethod = (req.headers['access-control-request-method'] || '').toUpperCase()
    const isWrite = requestedMethod === 'POST' || requestedMethod === 'DELETE'
    res.writeHead(204, {
      ...corsHeaders(req, isWrite),
      'Access-Control-Allow-Methods': 'GET,POST,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type,X-Timestamp,X-Signature,X-Admin-Key'
    })
    return res.end()
  }

  const url  = new URL(req.url, `http://localhost`)
  const path = url.pathname
  const db   = loadDB()

  try {
    let result

    // ── Admin routes (checked first) ──────────────────────────────────────
    if (req.method === 'POST' && path === '/admin/agents/register') {
      const auth = requireAdmin(req)
      if (!auth.ok) { result = { status: auth.status, data: { error: auth.error } } }
      else {
        const body = await parseBody(req)
        result = adminRegisterAgent(db, body)
      }

    } else if (req.method === 'DELETE' && path.startsWith('/admin/agents/')) {
      const auth = requireAdmin(req)
      if (!auth.ok) { result = { status: auth.status, data: { error: auth.error } } }
      else {
        const agentId = decodeURIComponent(path.slice('/admin/agents/'.length))
        result = adminDeleteAgent(db, agentId)
      }

    // ── Self-service provider registration ────────────────────────────
    } else if (req.method === 'POST' && path === '/register/challenge') {
      result = { status: 200, data: createPowChallenge() }

    } else if (req.method === 'POST' && path === '/register/agent') {
      const body = await parseBody(req)
      result = selfRegisterAgent(db, body)

    // ── Public routes ──────────────────────────────────────────────────────
    } else if (req.method === 'POST' && path === '/agents/register') {
      const body = await parseBody(req)
      result = registerAgent(db, body)

    } else if (req.method === 'GET' && (path === '/agents' || path === '/agents/search')) {
      // Unified list + search endpoint — /agents is canonical, /agents/search is alias
      result = listAgents(db, url.searchParams)

    } else if (req.method === 'GET' && path.endsWith('/card') && path.startsWith('/agents/')) {
      const agentId = decodeURIComponent(path.slice(8, -5))
      const agent = db[agentId]
      if (!agent) {
        result = { status: 404, data: { error: `Agent not found: ${agentId}` } }
      } else {
        result = { status: 200, data: buildAgentCard(agent) }
      }

    } else if (req.method === 'GET' && path.startsWith('/agents/')) {
      const agentId = decodeURIComponent(path.slice(8))
      result = getAgent(db, agentId)

    } else if (req.method === 'DELETE' && path.startsWith('/agents/')) {
      const agentId = decodeURIComponent(path.slice(8))
      result = deleteAgent(db, agentId, req.headers)

    } else if (req.method === 'GET' && path === '/health') {
      result = { status: 200, data: { ok: true, agents: Object.keys(db).length } }

    } else {
      result = { status: 404, data: { error: 'Not found' } }
    }

    send(res, result.status, result.data)

  } catch (err) {
    send(res, 500, { error: err.message })
  }
})

const MAX_BODY_BYTES = 64 * 1024 // 64 KiB

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        return reject(new Error('Request body too large'))
      }
      body += chunk
    })
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) }
      catch { reject(new Error('Invalid JSON')) }
    })
  })
}

function send(res, status, data) {
  const r = res.req
  const isWrite = r && (r.method === 'POST' || r.method === 'DELETE')
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...corsHeaders(r || { headers: {} }, isWrite),
  })
  res.end(JSON.stringify(data))
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`SavantDex Registry v0.6 running on port ${PORT}`)
  console.log(`  POST   /register/challenge           - PoW challenge for self-registration`)
  console.log(`  POST   /register/agent               - Self-register relay provider (wallet sig + PoW)`)
  console.log(`  POST   /agents/register              - Register with owner/runtime signature (v0.4) or legacy`)
  console.log(`  POST   /admin/agents/register        - Admin-assisted registration (relay providers)`)
  console.log(`  DELETE /admin/agents/:agentId         - Admin delete (no owner signature)`)
  console.log(`  GET    /agents                       - List/filter agents (canonical)`)
  console.log(`  GET    /agents/search                - Alias for /agents (backward-compat)`)
  console.log(`  GET    /agents/:agentId              - Get agent detail with callHint`)
  console.log(`  DELETE /agents/:agentId              - Remove (owner signature required)`)
  console.log(`  GET    /health                       - Health check`)
  console.log(`  GET    /agents/:agentId/card         - Standardized agent card (A2A-aligned)`)
  console.log(`  Filter params: capability, category, q, supportsAsync, maxExpectedLatencyMs`)
  if (ADMIN_API_KEY) console.log(`  Admin endpoints: enabled`)
  else console.warn(`  Admin endpoints: DISABLED (REGISTRY_ADMIN_API_KEY not set)`)
})
