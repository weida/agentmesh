/**
 * reputation.mjs — reputation-aware ordering tests.
 * Run: node --test backend/reputation.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortAgentsByReputation } from './reputation.mjs'

const agents = () => [
  { agentId: 'untested' },                              // no metrics
  { agentId: 'reliable',  successRate: 99, avgResponseMs: 800 },
  { agentId: 'flaky',     successRate: 40, avgResponseMs: 120 },
  { agentId: 'fast-ok',   successRate: 95, avgResponseMs: 90 },
]

test('no sort param returns the input unchanged', () => {
  const input = agents()
  const out = sortAgentsByReputation(input, undefined)
  assert.equal(out, input, 'same reference returned when no sort requested')
})

test('unknown sort value is a no-op', () => {
  const input = agents()
  const out = sortAgentsByReputation(input, 'bogus')
  assert.equal(out, input)
})

test('sort by successRate: highest first, untested last', () => {
  const out = sortAgentsByReputation(agents(), 'successRate')
  assert.deepEqual(out.map(a => a.agentId), ['reliable', 'fast-ok', 'flaky', 'untested'])
})

test('sort by avgResponseMs: fastest first, untested last', () => {
  const out = sortAgentsByReputation(agents(), 'avgResponseMs')
  assert.deepEqual(out.map(a => a.agentId), ['fast-ok', 'flaky', 'reliable', 'untested'])
})

test('does not mutate the input array', () => {
  const input = agents()
  const before = input.map(a => a.agentId)
  sortAgentsByReputation(input, 'successRate')
  assert.deepEqual(input.map(a => a.agentId), before, 'input order preserved')
})

test('all-untested agents keep stable relative order', () => {
  const input = [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }]
  const out = sortAgentsByReputation(input, 'successRate')
  assert.deepEqual(out.map(a => a.agentId), ['a', 'b', 'c'])
})
