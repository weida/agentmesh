/**
 * Phase A Payment — 10 acceptance test cases
 * Run: node backend/payment.test.mjs
 */

import { initDb, resolveApiKey, preInvocationCheck, writeSubmitted,
         markStatus, chargeCompleted, getBudget, getProviderReceivable, seedRequester,
         writeDeliveryReceipt, computeResultHash, getTaskTrace } from './payment.mjs'
import { buildReceiptPayload } from './receipt.mjs'

// Phase C evidence gate: chargeCompleted requires a DeliveryReceipt for
// agreementVersion >= 2. These tests run in-process and never go through the
// real gateway task loop, so the receipt must be written explicitly with the
// same canonical payload shape the server builds in production.
function completeTask(taskId) {
  markStatus(taskId, 'completed')
  const { agreement } = getTaskTrace(taskId)
  const result = { status: 'completed' }
  const payload = buildReceiptPayload({
    taskId,
    agreementHash:        agreement?.agreementHash || null,
    providerAgentId:      agreement?.providerAgentId || 'agent-test',
    providerOwnerAddress: agreement?.providerOwnerAddress || null,
    requesterAgentId:     agreement?.requesterAgentId || null,
    taskType:             agreement?.taskType || 'test',
    resultHash:           computeResultHash(result),
    completedAt:          new Date().toISOString(),
  })
  writeDeliveryReceipt({ payload })
}

let passed = 0
let failed = 0

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}`)
    failed++
  }
}

// ── Setup ──────────────────────────────────────────────────────────────────────

initDb(':memory:')

const ONE_DATA  = 1_000_000_000_000_000_000n
const PRICE     = (ONE_DATA * 5n).toString()   // 5 DATA per task

seedRequester({
  rawKey: 'key-free', requesterAgentId: 'req-free',
  ownerAddress: '0xfree',
  remainingBaseUnits:  '0',
  maxPerTaskBaseUnits: '0',
  dailyLimitBaseUnits: '0',
})

seedRequester({
  rawKey: 'key-funded', requesterAgentId: 'req-funded',
  ownerAddress: '0xfunded',
  remainingBaseUnits:  (ONE_DATA * 100n).toString(),
  maxPerTaskBaseUnits: (ONE_DATA * 10n).toString(),
  dailyLimitBaseUnits: (ONE_DATA * 20n).toString(),
})

// req-tight-daily: high maxPerTask, very low daily limit — for test 8
seedRequester({
  rawKey: 'key-tight', requesterAgentId: 'req-tight-daily',
  ownerAddress: '0xtight',
  remainingBaseUnits:  (ONE_DATA * 50n).toString(),
  maxPerTaskBaseUnits: (ONE_DATA * 10n).toString(),
  dailyLimitBaseUnits: (ONE_DATA * 5n).toString(),   // 5 DATA daily cap
})

seedRequester({
  rawKey: 'key-reserve', requesterAgentId: 'req-reserve',
  ownerAddress: '0xreserve',
  remainingBaseUnits:  (ONE_DATA * 100n).toString(),
  maxPerTaskBaseUnits: (ONE_DATA * 10n).toString(),
  dailyLimitBaseUnits: (ONE_DATA * 20n).toString(),
})

seedRequester({
  rawKey: 'key-tight-reserve', requesterAgentId: 'req-tight-reserve',
  ownerAddress: '0xtightreserve',
  remainingBaseUnits:  (ONE_DATA * 50n).toString(),
  maxPerTaskBaseUnits: (ONE_DATA * 10n).toString(),
  dailyLimitBaseUnits: (ONE_DATA * 5n).toString(),
})

const FREE_PRICING    = { type: 'free',  currency: 'DATA', amountBaseUnits: '0',    decimals: 18, billingUnit: 'task' }
const FIXED_PRICING   = { type: 'fixed', currency: 'DATA', amountBaseUnits: PRICE,  decimals: 18, billingUnit: 'task' }
const PROVIDER        = '0xprovider'

// ── Test 1: free agent success — no charge ────────────────────────────────────

console.log('\nTest 1: free agent success does not charge')
{
  const { agreementHash } = writeSubmitted({
    taskId: 'task-free-1', requesterAgentId: 'req-funded',
    providerAgentId: 'agent-free', providerOwnerAddress: PROVIDER,
    taskType: 'test', pricingModel: FREE_PRICING,
  })
  completeTask('task-free-1')
  const result = chargeCompleted('task-free-1')
  assert(!result.charged, 'free task not charged')
  assert(result.reason === 'free_task', 'reason is free_task')
  const budget = getBudget('req-funded')
  assert(budget.remainingBaseUnits === (ONE_DATA * 100n).toString(), 'budget unchanged')
}

// ── Test 2: fixed agent success — budget decreases, receivable increases ──────

console.log('\nTest 2: fixed agent success charges correctly')
{
  writeSubmitted({
    taskId: 'task-fixed-1', requesterAgentId: 'req-funded',
    providerAgentId: 'agent-fixed', providerOwnerAddress: PROVIDER,
    taskType: 'test', pricingModel: FIXED_PRICING,
  })
  completeTask('task-fixed-1')
  const result = chargeCompleted('task-fixed-1')
  assert(result.charged === true, 'fixed task charged')
  const budget = getBudget('req-funded')
  assert(budget.remainingBaseUnits === (ONE_DATA * 95n).toString(), 'budget deducted by 5 DATA')
  assert((budget.reservedBaseUnits || '0') === '0', 'reservation released after successful charge')
  const { balance } = getProviderReceivable(PROVIDER)
  assert(balance[0].accruedBaseUnits === PRICE, 'provider receivable increased')
}

// ── Test 2b: submitted paid task reserves budget before send ──────────────────

console.log('\nTest 2b: submitted paid task reserves budget immediately')
{
  writeSubmitted({
    taskId: 'task-reserve-1', requesterAgentId: 'req-reserve',
    providerAgentId: 'agent-fixed', providerOwnerAddress: PROVIDER,
    taskType: 'test', pricingModel: FIXED_PRICING,
  })
  const budget = getBudget('req-reserve')
  assert(budget.remainingBaseUnits === (ONE_DATA * 95n).toString(), 'available budget reduced at submission time')
  assert((budget.reservedBaseUnits || '0') === PRICE, 'reserved balance increased at submission time')
}

// ── Test 2c: second paid submission is blocked once budget is reserved ─────────

console.log('\nTest 2c: reserved budget blocks further submitted tasks')
{
  let blocked = null
  try {
    writeSubmitted({
      taskId: 'task-reserve-2', requesterAgentId: 'req-tight-reserve',
      providerAgentId: 'agent-fixed', providerOwnerAddress: PROVIDER,
      taskType: 'test',
      pricingModel: { type: 'fixed', currency: 'DATA', amountBaseUnits: (ONE_DATA * 4n).toString(), decimals: 18, billingUnit: 'task' },
    })
    writeSubmitted({
      taskId: 'task-reserve-3', requesterAgentId: 'req-tight-reserve',
      providerAgentId: 'agent-fixed', providerOwnerAddress: PROVIDER,
      taskType: 'test',
      pricingModel: { type: 'fixed', currency: 'DATA', amountBaseUnits: (ONE_DATA * 2n).toString(), decimals: 18, billingUnit: 'task' },
    })
  } catch (e) {
    blocked = e.code
  }
  assert(blocked === 'DAILY_LIMIT_EXCEEDED', 'second submitted task blocked by reserved daily capacity')
}

// ── Test 3: failed — no charge ────────────────────────────────────────────────

console.log('\nTest 3: failed result does not charge')
{
  writeSubmitted({
    taskId: 'task-fail-1', requesterAgentId: 'req-funded',
    providerAgentId: 'agent-fixed', providerOwnerAddress: PROVIDER,
    taskType: 'test', pricingModel: FIXED_PRICING,
  })
  markStatus('task-fail-1', 'failed')
  const result = chargeCompleted('task-fail-1')
  assert(!result.charged, 'failed task not charged')
  assert(result.reason === 'not_completed', 'reason is not_completed')
  const budget = getBudget('req-funded')
  assert(budget.remainingBaseUnits === (ONE_DATA * 95n).toString(), 'failed task reservation released back to available balance')
  assert((budget.reservedBaseUnits || '0') === '0', 'failed task reservation fully cleared')
}

// ── Test 4: timeout — no charge ───────────────────────────────────────────────

console.log('\nTest 4: timeout does not charge')
{
  writeSubmitted({
    taskId: 'task-timeout-1', requesterAgentId: 'req-funded',
    providerAgentId: 'agent-fixed', providerOwnerAddress: PROVIDER,
    taskType: 'test', pricingModel: FIXED_PRICING,
  })
  markStatus('task-timeout-1', 'timeout')
  const result = chargeCompleted('task-timeout-1')
  assert(!result.charged, 'timeout task not charged')
}

// ── Test 5: needs_disambiguation — no charge ──────────────────────────────────

console.log('\nTest 5: needs_disambiguation does not charge')
{
  writeSubmitted({
    taskId: 'task-disambig-1', requesterAgentId: 'req-funded',
    providerAgentId: 'agent-fixed', providerOwnerAddress: PROVIDER,
    taskType: 'test', pricingModel: FIXED_PRICING,
  })
  markStatus('task-disambig-1', 'needs_disambiguation')
  const result = chargeCompleted('task-disambig-1')
  assert(!result.charged, 'needs_disambiguation not charged')
}

// ── Test 6: insufficient budget rejects pre-invocation ────────────────────────

console.log('\nTest 6: insufficient budget rejects pre-invocation')
{
  // req-free has 0 budget
  const check = preInvocationCheck('req-free', PRICE)
  assert(!check.ok, 'check fails')
  assert(check.errorCode === 'BUDGET_INSUFFICIENT', 'error is BUDGET_INSUFFICIENT')
}

// ── Test 7: max per task exceeded rejects ─────────────────────────────────────

console.log('\nTest 7: max per task exceeded rejects pre-invocation')
{
  // req-funded maxPerTask is 10 DATA, try 11 DATA
  const overPrice = (ONE_DATA * 11n).toString()
  const check = preInvocationCheck('req-funded', overPrice)
  assert(!check.ok, 'check fails')
  assert(check.errorCode === 'MAX_PER_TASK_EXCEEDED', 'error is MAX_PER_TASK_EXCEEDED')
}

// ── Test 8: daily limit exceeded rejects ─────────────────────────────────────

console.log('\nTest 8: daily limit exceeded rejects pre-invocation')
{
  // req-tight-daily: dailyLimit=5 DATA, maxPerTask=10 DATA, remaining=50 DATA
  // First call: 4 DATA → within all limits, charge it to push dailySpent to 4 DATA
  writeSubmitted({
    taskId: 'task-daily-1', requesterAgentId: 'req-tight-daily',
    providerAgentId: 'agent-fixed', providerOwnerAddress: PROVIDER,
    taskType: 'test',
    pricingModel: { type: 'fixed', currency: 'DATA', amountBaseUnits: (ONE_DATA * 4n).toString(), decimals: 18, billingUnit: 'task' },
  })
  completeTask('task-daily-1')
  chargeCompleted('task-daily-1')   // dailySpent now = 4 DATA

  // Now try 2 DATA: 4 + 2 = 6 > 5 daily limit → DAILY_LIMIT_EXCEEDED
  const check = preInvocationCheck('req-tight-daily', (ONE_DATA * 2n).toString())
  assert(!check.ok, 'check fails')
  assert(check.errorCode === 'DAILY_LIMIT_EXCEEDED', 'error is DAILY_LIMIT_EXCEEDED')
}

// ── Test 9: duplicate completed result does not double-charge ─────────────────

console.log('\nTest 9: duplicate completed result does not double-charge')
{
  writeSubmitted({
    taskId: 'task-dup-1', requesterAgentId: 'req-funded',
    providerAgentId: 'agent-fixed', providerOwnerAddress: PROVIDER,
    taskType: 'test', pricingModel: FIXED_PRICING,
  })
  completeTask('task-dup-1')
  const first  = chargeCompleted('task-dup-1')
  const second = chargeCompleted('task-dup-1')
  assert(first.charged === true,  'first charge succeeds')
  assert(!second.charged,          'second charge rejected')
  assert(second.reason === 'already_charged', 'reason is already_charged')
}

// ── Test 10: submitted paid task without budget is rejected early ─────────────

console.log('\nTest 10: paid task without budget is rejected before submission')
{
  let code = null
  const { balance: balanceBefore } = getProviderReceivable(PROVIDER)
  const accruedBefore = BigInt(balanceBefore[0]?.accruedBaseUnits || '0')
  try {
    writeSubmitted({
      taskId: 'task-nobudget-1', requesterAgentId: 'req-no-budget',
      providerAgentId: 'agent-fixed', providerOwnerAddress: PROVIDER,
      taskType: 'test', pricingModel: FIXED_PRICING,
    })
  } catch (e) {
    code = e.code
  }
  const { balance: balanceAfter } = getProviderReceivable(PROVIDER)
  const accruedAfter = BigInt(balanceAfter[0]?.accruedBaseUnits || '0')
  assert(code === 'BUDGET_INSUFFICIENT', 'submission rejected when budget missing')
  assert(accruedBefore === accruedAfter, 'provider receivable unchanged after rejected submission')
}

// ── Regression: non-completed terminal status releases the reservation ──────────
// Guards the gateway bug where a non-timeout task failure (relay error, worker
// error, agent disconnect) left the InvocationRecord in 'submitted' and never
// refunded the reserved budget. markStatus('failed') must return the reserved
// amount to remaining and zero out the reservation.
{
  seedRequester({
    rawKey: 'key-refund', requesterAgentId: 'req-refund',
    ownerAddress: '0xrefund',
    remainingBaseUnits:  (ONE_DATA * 100n).toString(),
    maxPerTaskBaseUnits: (ONE_DATA * 10n).toString(),
    dailyLimitBaseUnits: (ONE_DATA * 20n).toString(),
  })

  const before = getBudget('req-refund')

  writeSubmitted({
    taskId: 'task-refund-1', requesterAgentId: 'req-refund',
    providerAgentId: 'agent-fixed', providerOwnerAddress: PROVIDER,
    taskType: 'test', pricingModel: FIXED_PRICING,
  })

  const reserved = getBudget('req-refund')
  assert(
    BigInt(reserved.remainingBaseUnits) === BigInt(before.remainingBaseUnits) - BigInt(PRICE),
    'reservation debits remaining on submit',
  )
  assert(BigInt(reserved.reservedBaseUnits) === BigInt(PRICE), 'reservation tracked in reservedBaseUnits')

  // Simulate a non-timeout failure (the path that previously leaked budget).
  markStatus('task-refund-1', 'failed')

  const after = getBudget('req-refund')
  assert(
    BigInt(after.remainingBaseUnits) === BigInt(before.remainingBaseUnits),
    'failed task refunds reserved amount back to remaining',
  )
  assert(BigInt(after.reservedBaseUnits) === 0n, 'failed task clears the reservation')

  // And it must never accrue to the provider.
  const { balance } = getProviderReceivable(PROVIDER)
  const accrued = BigInt(balance.find(b => true)?.accruedBaseUnits || '0')
  // chargeCompleted should refuse a non-completed task even if called.
  const charge = chargeCompleted('task-refund-1')
  assert(charge.charged === false, 'chargeCompleted refuses a failed task')
  const { balance: balance2 } = getProviderReceivable(PROVIDER)
  const accrued2 = BigInt(balance2.find(b => true)?.accruedBaseUnits || '0')
  assert(accrued === accrued2, 'failed task does not accrue provider receivable')
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
