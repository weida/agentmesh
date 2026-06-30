/**
 * Settlement balance-protection tests.
 * Run: node --test backend/settlement.test.mjs
 *
 * Focus: createSettlementRecord must reserve pending settlements against the
 * provider's unpaid balance, so multiple pending settlements cannot be created
 * and later completed to over-settle (double-pay) the receivable.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initDb, seedRequester, writeSubmitted, markStatus, chargeCompleted,
  writeDeliveryReceipt, computeResultHash, getTaskTrace,
  createSettlementRecord, processSettlement, getProviderReceivable,
} from './payment.mjs'
import { buildReceiptPayload } from './receipt.mjs'

initDb(':memory:')

const ONE = 1_000_000_000_000_000_000n
const PROVIDER = '0xprovider0000000000000000000000000000prov'
const PRICE = (ONE * 10n).toString()  // 10 DATA per task

// Drive a completed+charged task so the provider accrues a receivable.
function accrueOneTask(taskId) {
  writeSubmitted({
    taskId, requesterAgentId: 'req-settle',
    providerAgentId: 'agent-settle', providerOwnerAddress: PROVIDER,
    taskType: 'test', pricingModel: { type: 'fixed', currency: 'DATA', amountBaseUnits: PRICE, decimals: 18, billingUnit: 'task' },
  })
  markStatus(taskId, 'completed')
  const { agreement } = getTaskTrace(taskId)
  const payload = buildReceiptPayload({
    taskId,
    agreementHash:        agreement.agreementHash,
    providerAgentId:      agreement.providerAgentId,
    providerOwnerAddress: agreement.providerOwnerAddress,
    requesterAgentId:     agreement.requesterAgentId,
    taskType:             agreement.taskType,
    resultHash:           computeResultHash({ status: 'completed' }),
    completedAt:          new Date().toISOString(),
  })
  writeDeliveryReceipt({ payload })
  const r = chargeCompleted(taskId)
  assert.equal(r.charged, true, 'task charged')
}

test('setup: provider accrues 10 DATA receivable', () => {
  seedRequester({
    rawKey: 'key-settle', requesterAgentId: 'req-settle', ownerAddress: '0xsettle',
    remainingBaseUnits: (ONE * 100n).toString(),
    maxPerTaskBaseUnits: (ONE * 50n).toString(),
    dailyLimitBaseUnits: (ONE * 100n).toString(),
  })
  accrueOneTask('settle-task-1')

  const { balance } = getProviderReceivable(PROVIDER)
  const accrued = BigInt(balance.find(b => b.currency === 'DATA')?.accruedBaseUnits || '0')
  assert.equal(accrued, ONE * 10n, 'provider accrued 10 DATA')
})

test('regression: pending settlement reserves balance — cannot double-create', () => {
  // First pending settlement for the full unpaid amount: allowed.
  const { settlementId: s1 } = createSettlementRecord({
    ownerAddress: PROVIDER, currency: 'DATA', amountBaseUnits: PRICE, method: 'manual-transfer',
  })
  assert.ok(s1, 'first full-balance settlement created')

  // Second settlement of any positive amount must be rejected: the first one
  // is pending and already reserves the entire unpaid balance.
  assert.throws(
    () => createSettlementRecord({
      ownerAddress: PROVIDER, currency: 'DATA', amountBaseUnits: PRICE, method: 'manual-transfer',
    }),
    /exceeds unpaid balance/,
    'second pending settlement rejected while first is pending',
  )

  // Completing the first settlement keeps the balance reserved (now as
  // 'completed' instead of 'pending') — still no headroom for a new one.
  processSettlement(s1, 'completed')
  assert.throws(
    () => createSettlementRecord({
      ownerAddress: PROVIDER, currency: 'DATA', amountBaseUnits: '1', method: 'manual-transfer',
    }),
    /exceeds unpaid balance/,
    'no balance remains after the full settlement completed',
  )
})

test('failing a pending settlement frees the reserved balance', () => {
  // Accrue another 10 DATA, reserve it with a pending settlement, then fail it.
  accrueOneTask('settle-task-2')
  const { settlementId: s2 } = createSettlementRecord({
    ownerAddress: PROVIDER, currency: 'DATA', amountBaseUnits: PRICE, method: 'manual-transfer',
  })
  processSettlement(s2, 'failed')

  // A failed settlement no longer reserves balance, so a fresh one is allowed.
  const { settlementId: s3 } = createSettlementRecord({
    ownerAddress: PROVIDER, currency: 'DATA', amountBaseUnits: PRICE, method: 'manual-transfer',
  })
  assert.ok(s3, 'failed settlement releases the reservation for a new one')
})
