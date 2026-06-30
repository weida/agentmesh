/**
 * Reputation-aware ordering for agent discovery.
 *
 * Agents carry optional live metrics merged from the gateway's call log:
 *   { successRate: 0-100, avgResponseMs: number, ... }
 * Agents with no recorded calls have those fields absent and must sort LAST —
 * discovery should prefer agents with a proven track record over untested ones.
 *
 * Pure and side-effect free so it can be unit tested without standing up the
 * HTTP server. Returns a new array; does not mutate the input.
 *
 * @param {Array<object>} agents
 * @param {string} sort  'successRate' | 'avgResponseMs' | undefined
 * @returns {Array<object>}
 */
export function sortAgentsByReputation(agents, sort) {
  if (sort !== 'successRate' && sort !== 'avgResponseMs') return agents

  const copy = agents.slice()
  if (sort === 'successRate') {
    // Higher is better; missing metric => -1 (sorts last).
    copy.sort((a, b) => (b.successRate ?? -1) - (a.successRate ?? -1))
  } else {
    // Lower latency is better; missing metric => Infinity (sorts last).
    copy.sort((a, b) => (a.avgResponseMs ?? Infinity) - (b.avgResponseMs ?? Infinity))
  }
  return copy
}
