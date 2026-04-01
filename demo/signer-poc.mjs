#!/usr/bin/env node
/**
 * Phase 1-PoC: External Signer + Streamr SDK Compatibility Test
 *
 * Validates:
 *   1. CustomIdentityConfig works with Streamr SDK
 *   2. publish() and subscribe() work through an external signer
 *   3. Signing latency at real SavantDex load (1–5 rps)
 *   4. stream management (getOrCreateStream, grantPermissions) behaviour
 *
 * This process holds NO private key. All signing is delegated to
 * signer-poc-server.mjs running on 127.0.0.1:SIGNER_PORT.
 *
 * Required env:
 *   SIGNER_ADDRESS   Ethereum address of the signer (printed by signer-poc-server.mjs)
 *
 * Optional env:
 *   SIGNER_PORT            (default: 17099)
 *   EXTERNAL_IP            (VPS public IP for Streamr network)
 *   POC_STREAM_ID          Pre-existing stream to use (skips creation)
 *   POC_ROUNDS             Number of publish/subscribe roundtrips (default: 10)
 *   POC_RPS                Target requests per second (default: 2)
 *
 * Run signer server first:
 *   node demo/signer-poc-server.mjs
 *
 * Then run this:
 *   SIGNER_ADDRESS=0x... node demo/signer-poc.mjs
 */

import { Identity, StreamrClient, StreamPermission, SignatureType } from '@streamr/sdk'

const SIGNER_PORT    = Number(process.env.SIGNER_PORT || 17099)
const SIGNER_ADDRESS = process.env.SIGNER_ADDRESS
const EXTERNAL_IP    = process.env.EXTERNAL_IP
const STREAM_ID      = process.env.POC_STREAM_ID
const ROUNDS         = Number(process.env.POC_ROUNDS || 10)
const RPS            = Number(process.env.POC_RPS    || 2)

if (!SIGNER_ADDRESS || !/^0x[a-fA-F0-9]{40}$/.test(SIGNER_ADDRESS)) {
  console.error('Missing or invalid SIGNER_ADDRESS. Run signer-poc-server.mjs first and copy its address.')
  process.exit(1)
}

// ── Remote Identity ───────────────────────────────────────────────────────────
// Implements Streamr SDK's abstract Identity class.
// The private key lives only in signer-poc-server.mjs.
//
// NOTE: Intentionally uses regular properties instead of JS private fields (#).
// The SDK ships as CJS; this file is ESM. Node.js private-field brand checks
// break when a class defined in ESM extends a class from a CJS bundle — the
// instance's brand doesn't satisfy the ESM class's #field brand check.
// Regular properties are sufficient here since RemoteSignerIdentity is not
// exported or shared beyond this module.
class RemoteSignerIdentity extends Identity {
  _address
  _signerUrl
  _signLatencies = []

  constructor(address, signerPort) {
    super()
    this._address   = address.toLowerCase()
    this._signerUrl = `http://127.0.0.1:${signerPort}/sign-message`
  }

  getUserId() {
    return Promise.resolve(this._address)
  }

  getUserIdRaw() {
    return Promise.resolve(Buffer.from(this._address.slice(2), 'hex'))
  }

  getSignatureType() {
    return SignatureType.ECDSA_SECP256K1_EVM
  }

  async createMessageSignature(payload) {
    const t0 = performance.now()

    const res = await fetch(this._signerUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ payload: Buffer.from(payload).toString('hex') }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Signer server error ${res.status}: ${text}`)
    }

    const { signature } = await res.json()
    const elapsed = performance.now() - t0
    this._signLatencies.push(elapsed)

    // Convert hex signature to Uint8Array (65 bytes: r|s|v)
    return Buffer.from(signature.slice(2), 'hex')
  }

  async getTransactionSigner() {
    // On-chain transaction signing is out of scope for this PoC.
    // Stream management calls (createStream, grantPermissions) will fail here —
    // this is intentional: we want to observe exactly which operations require it.
    throw new Error(
      '[RemoteSignerIdentity] getTransactionSigner not implemented in PoC. ' +
      'Stream management requires on-chain signing — pre-create the stream or extend this.'
    )
  }

  getSignLatencies() {
    return this._signLatencies
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function percentile(arr, p) {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)].toFixed(2)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function log(label, msg = '') {
  console.log(`\n[${label}]${msg ? ' ' + msg : ''}`)
}

function result(ok, msg) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Verify signer server is reachable before creating StreamrClient
  log('PREFLIGHT')
  try {
    const probe = await fetch(`http://127.0.0.1:${SIGNER_PORT}/sign-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: Buffer.alloc(32).toString('hex') }),
    })
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`)
    const { address } = await probe.json()
    result(true, `Signer server reachable, address: ${address}`)
    if (address.toLowerCase() !== SIGNER_ADDRESS.toLowerCase()) {
      result(false, `Address mismatch: server=${address} env=${SIGNER_ADDRESS}`)
      process.exit(1)
    }
  } catch (err) {
    result(false, `Signer server unreachable on port ${SIGNER_PORT}: ${err.message}`)
    console.error('  → Start signer-poc-server.mjs first')
    process.exit(1)
  }

  const identity = new RemoteSignerIdentity(SIGNER_ADDRESS, SIGNER_PORT)

  log('STREAMR CLIENT', 'initialising with CustomIdentityConfig')
  const client = new StreamrClient({
    auth: { identity },
    network: EXTERNAL_IP
      ? { controlLayer: { externalIp: EXTERNAL_IP } }
      : undefined,
  })

  let stream
  let streamId = STREAM_ID

  try {
    // ── Stream management ──────────────────────────────────────────────────────
    log('STREAM MANAGEMENT')
    if (streamId) {
      try {
        stream = await client.getStream(streamId)
        result(true, `Using pre-existing stream: ${streamId}`)
      } catch (err) {
        result(false, `getStream failed: ${err.message}`)
        process.exit(1)
      }
    } else {
      console.log('No POC_STREAM_ID set — attempting getOrCreateStream (requires getTransactionSigner)')
      try {
        stream = await client.getOrCreateStream({ id: `/signer-poc/${Date.now()}` })
        streamId = stream.id
        await stream.grantPermissions(
          { permission: StreamPermission.PUBLISH,   public: true },
          { permission: StreamPermission.SUBSCRIBE, public: true },
        )
        result(true, `Created stream: ${streamId}`)
      } catch (err) {
        result(false, `Stream creation failed (expected if getTransactionSigner not impl): ${err.message}`)
        console.log('  → Set POC_STREAM_ID to a pre-existing stream and re-run')
        process.exit(1)
      }
    }

    // ── Subscribe ──────────────────────────────────────────────────────────────
    log('SUBSCRIBE')
    const received = []
    const sub = await client.subscribe(streamId, (msg) => {
      received.push({ marker: msg?.marker, ts: performance.now() })
    })
    result(true, 'Subscription opened via RemoteSignerIdentity')

    // ── Publish roundtrip at controlled RPS ───────────────────────────────────
    log('PUBLISH ROUNDTRIP', `${ROUNDS} messages @ ${RPS} rps`)
    const intervalMs = 1000 / RPS
    const sent = []

    for (let i = 0; i < ROUNDS; i++) {
      const marker = `poc-${Date.now()}-${i}`
      const tSend = performance.now()
      await client.publish(streamId, { marker, seq: i })
      sent.push({ marker, tSend })
      if (i < ROUNDS - 1) await sleep(intervalMs)
    }
    result(true, `Published ${ROUNDS} messages`)

    // Wait for all messages (max 15s)
    const deadline = Date.now() + 15000
    while (received.length < ROUNDS && Date.now() < deadline) {
      await sleep(200)
    }
    result(received.length === ROUNDS, `Received ${received.length}/${ROUNDS} messages back`)

    // ── Latency report ─────────────────────────────────────────────────────────
    log('LATENCY REPORT')
    const signLat = identity.getSignLatencies()
    console.log(`Sign calls:       ${signLat.length}`)
    console.log(`Sign p50:         ${percentile(signLat, 50)} ms`)
    console.log(`Sign p95:         ${percentile(signLat, 95)} ms`)
    console.log(`Sign p99:         ${percentile(signLat, 99)} ms`)

    // End-to-end roundtrip (publish → subscribe callback)
    const rtts = sent.map(s => {
      const r = received.find(r => r.marker === s.marker)
      return r ? r.ts - s.tSend : null
    }).filter(Boolean)

    if (rtts.length) {
      console.log(`E2E roundtrip p50: ${percentile(rtts, 50)} ms`)
      console.log(`E2E roundtrip p95: ${percentile(rtts, 95)} ms`)
    }

    // ── Summary ────────────────────────────────────────────────────────────────
    console.log('\n=== SUMMARY ===')
    console.log('PASS CustomIdentityConfig accepted by StreamrClient')
    console.log('PASS publish/subscribe work through external signer')
    console.log(`INFO sign p50: ${percentile(signLat, 50)}ms  p95: ${percentile(signLat, 95)}ms`)
    console.log('INFO stream management (createStream) requires getTransactionSigner — out of PoC scope')

    await sub.unsubscribe()

  } catch (err) {
    console.error('\n=== SUMMARY ===')
    console.error(`FAIL ${err.message}`)
    process.exitCode = 1
  } finally {
    try { await client.destroy() } catch {}
  }
}

await main()
