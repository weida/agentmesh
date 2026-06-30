#!/usr/bin/env node
/**
 * Self-registration end-to-end smoke.
 *
 * Exercises the full new-user onboarding path against a live backend:
 *   1. generate a fresh wallet + random agent id (no prerequisites)
 *   2. POST /register/challenge + /register/requester (PoW + EIP-191 sign)
 *   3. POST /faucet/claim (top up 10 DATA)
 *   4. Run a paid task via GatewayRequester with wallet/session auth
 *   5. GET  /receipts/:taskId — expect proofType=dual-signed-v1
 *
 * Defaults target localhost:
 *   backend  http://127.0.0.1:4000   (register/faucet/task/receipts)
 *   registry http://127.0.0.1:3000   (agent discovery)
 *
 * Overrides:
 *   --gateway-url URL    backend base (where /register/* and /task live)
 *   --registry-url URL   registry base (where /agents/:id lives)
 *   --receipt-url URL    receipt base (defaults to gateway-url)
 *   --agent-id ID        agent to invoke (default: wallet-intelligence-v1)
 *   --input JSON         task input JSON (default: vitalik.eth profile)
 *
 * Prod target (cosmetic note): savantdex.weicao.dev nginx unconditionally
 * injects a demo X-API-Key at `= /api/task`, which the backend prefers over
 * X-Session-Token. The task will succeed but authMethodUsed will record
 * `api-key`, not `wallet-signature`. Registration + faucet + receipt stages
 * still exercise the wallet path end-to-end.
 *
 * Exits 0 on full green, 1 on any stage failure.
 */

import { Wallet } from 'ethers'
import { GatewayRequester } from '../sdk/gateway-requester.mjs'
import { solvePow } from '../sdk/pow.mjs'

// ── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function getArg(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}

const GATEWAY_URL  = getArg('--gateway-url',  'http://127.0.0.1:4000').replace(/\/$/, '')
const REGISTRY_URL = getArg('--registry-url', 'http://127.0.0.1:3000').replace(/\/$/, '')
const RECEIPT_URL  = getArg('--receipt-url',  GATEWAY_URL).replace(/\/$/, '')
const AGENT_ID     = getArg('--agent-id',     'wallet-intelligence-v1')
const TASK_INPUT   = JSON.parse(getArg('--input',
  JSON.stringify({ address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', chain: 'ethereum' })))

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(stage, msg)   { console.log(`[${stage}] ${msg}`) }
function fail(stage, err)  {
  console.error(`[${stage}] FAIL: ${err?.message || err}`)
  if (err?.code) console.error(`  code=${err.code}`)
  if (err?.status) console.error(`  status=${err.status}`)
  process.exit(1)
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`)
    e.status = res.status
    e.code   = data.code
    throw e
  }
  return data
}

// ── Smoke ────────────────────────────────────────────────────────────────────

async function main() {
  const signer       = Wallet.createRandom()
  const ownerAddress = signer.address.toLowerCase()
  const requesterAgentId = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  log('setup', `gateway      = ${GATEWAY_URL}`)
  log('setup', `registry     = ${REGISTRY_URL}`)
  log('setup', `agentId      = ${AGENT_ID}`)
  log('setup', `ownerAddress = ${ownerAddress}`)
  log('setup', `requesterId  = ${requesterAgentId}`)

  // 1. Register requester ────────────────────────────────────────────────────
  try {
    const { challengeId, prefix, difficulty } =
      await postJson(`${GATEWAY_URL}/register/challenge`, {})
    log('register', `challenge difficulty=${difficulty}`)
    const nonce = solvePow(prefix, difficulty)
    const timestamp = Date.now()
    const msg = `savantdex-register-requester:${requesterAgentId}:${ownerAddress}:${timestamp}`
    const signature = await signer.signMessage(msg)
    const reg = await postJson(`${GATEWAY_URL}/register/requester`, {
      requesterAgentId, ownerAddress, timestamp, signature, challengeId, nonce,
    })
    log('register', `ok — identity=${reg.requesterAgentId}`)
  } catch (e) { fail('register', e) }

  // 2. Claim faucet (10 DATA) ────────────────────────────────────────────────
  try {
    const { challengeId, prefix, difficulty } =
      await postJson(`${GATEWAY_URL}/register/challenge`, {})
    const nonce = solvePow(prefix, difficulty)
    const timestamp = Date.now()
    const msg = `savantdex-faucet-claim:${requesterAgentId}:${ownerAddress}:${timestamp}`
    const signature = await signer.signMessage(msg)
    const faucet = await postJson(`${GATEWAY_URL}/faucet/claim`, {
      requesterAgentId, ownerAddress, timestamp, signature, challengeId, nonce,
    })
    log('faucet', `granted=${faucet.budget?.remaining || '?'} ${faucet.budget?.currency || ''}`.trim())
  } catch (e) {
    if (e.code === 'FAUCET_DISABLED') {
      log('faucet', 'DISABLED — continuing (task had better be free)')
    } else {
      fail('faucet', e)
    }
  }

  // 3. Run paid task via wallet-session auth ─────────────────────────────────
  let taskResult
  try {
    const client = GatewayRequester.create({
      gatewayUrl:  GATEWAY_URL,
      registryUrl: REGISTRY_URL,
      requesterAgentId, ownerAddress, signer,
    })
    taskResult = await client.run(AGENT_ID, TASK_INPUT, { timeout: 60_000 })
    log('task', `status=${taskResult.status} taskId=${taskResult.taskId} durationMs=${taskResult.meta.durationMs}`)
    if (taskResult.status !== 'completed') {
      fail('task', new Error(`expected completed, got ${taskResult.status}: ${taskResult.error}`))
    }
  } catch (e) { fail('task', e) }

  // 4. Verify dual-signed receipt ────────────────────────────────────────────
  try {
    const receiptRes = await fetch(`${RECEIPT_URL}/receipts/${encodeURIComponent(taskResult.taskId)}`)
    if (!receiptRes.ok) throw new Error(`GET /receipts → HTTP ${receiptRes.status}`)
    const receipt = await receiptRes.json()
    log('receipt', `proofType=${receipt.proofType}`)
    if (receipt.proofType !== 'dual-signed-v1') {
      fail('receipt', new Error(`expected dual-signed-v1, got ${receipt.proofType}`))
    }
    if (!receipt.providerAttestation?.address) {
      fail('receipt', new Error('providerAttestation missing on receipt'))
    }
    log('receipt', `provider=${receipt.providerAttestation.address}`)
  } catch (e) { fail('receipt', e) }

  console.log('\nSMOKE PASSED — self-registration → faucet → task → dual-signed receipt all green.')
}

main().catch(e => fail('unexpected', e))
