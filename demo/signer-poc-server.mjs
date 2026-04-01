#!/usr/bin/env node
/**
 * Phase 1-PoC: Minimal Signing Server
 *
 * Holds the keystore and exposes a single signing endpoint on localhost.
 * The agent process never receives the private key — only signature results.
 *
 * This is a PoC implementation. Not production-hardened.
 *
 * Required env:
 *   KEYSTORE_PATH, KEYSTORE_PASSWORD (or SECRETS_PATH + AGE_IDENTITY_PATH)
 *
 * Optional env:
 *   SIGNER_PORT   Port to listen on (default: 17099)
 *
 * Endpoint:
 *   POST /sign-message
 *   Body:   { "payload": "<hex string>" }
 *   Result: { "signature": "<hex string>", "address": "0x..." }
 *
 * Accepted payload kinds (whitelist):
 *   - Raw bytes from Streamr SDK createMessageSignature calls
 *   - Only signs with personal_sign semantics (Ethereum prefix + keccak256)
 *   - Does NOT accept arbitrary free-form messages
 */

import http from 'node:http'
import { Wallet } from 'ethers'
import { loadSecrets } from '../sdk/secrets.mjs'
import { loadPrivateKey } from '../sdk/keystore.mjs'

const PORT = Number(process.env.SIGNER_PORT || 17099)

// ── Load key at startup ───────────────────────────────────────────────────────
const { KEYSTORE_PASSWORD } = await loadSecrets()
const privateKey = await loadPrivateKey(KEYSTORE_PASSWORD)
const wallet = new Wallet(privateKey)
console.log(`[signer] Address: ${wallet.address}`)

// ── Request counter for basic observability ───────────────────────────────────
let reqCount = 0

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/sign-message') {
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }

  let body = ''
  for await (const chunk of req) body += chunk

  let payload
  try {
    const parsed = JSON.parse(body)
    if (!parsed.payload || typeof parsed.payload !== 'string') {
      throw new Error('missing payload field')
    }
    payload = Buffer.from(parsed.payload, 'hex')
  } catch (err) {
    res.writeHead(400)
    res.end(JSON.stringify({ error: `bad request: ${err.message}` }))
    return
  }

  const t0 = performance.now()
  try {
    // ethers signMessage: adds "\x19Ethereum Signed Message:\n{len}" prefix + keccak256
    const signature = await wallet.signMessage(payload)
    const elapsed = (performance.now() - t0).toFixed(2)

    reqCount++
    if (reqCount % 10 === 0) {
      console.log(`[signer] ${reqCount} requests processed, last sign: ${elapsed}ms`)
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ signature, address: wallet.address, signMs: elapsed }))
  } catch (err) {
    console.error('[signer] signing error:', err.message)
    res.writeHead(500)
    res.end(JSON.stringify({ error: 'signing failed' }))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[signer] Listening on 127.0.0.1:${PORT}`)
  console.log(`[signer] Ready to sign — agent process should not hold private key`)
})

server.on('error', (err) => {
  console.error('[signer] Server error:', err.message)
  process.exit(1)
})
