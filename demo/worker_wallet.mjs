/**
 * SavantDex Worker - Wallet Analyst
 * Fetches on-chain data via Etherscan, analyzes via DeepSeek
 *
 * Handles task type: 'analyze-wallet'
 * Input: { address: '0x...' }
 * Output: { analysis, holdings, txCount, firstSeen, riskLevel }
 */

import { SavantDex } from '../sdk/index.mjs'
import { loadPrivateKey } from '../sdk/keystore.mjs'
import { registerToRegistry } from '../sdk/registry.mjs'
import OpenAI from 'openai'

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY
const EXTERNAL_IP = process.env.EXTERNAL_IP || '127.0.0.1'

if (!DEEPSEEK_KEY) { console.error('Missing DEEPSEEK_API_KEY'); process.exit(1) }
if (!ETHERSCAN_KEY) { console.error('Missing ETHERSCAN_API_KEY'); process.exit(1) }

const PRIVATE_KEY = await loadPrivateKey()

const deepseek = new OpenAI({
  apiKey: DEEPSEEK_KEY,
  baseURL: 'https://api.deepseek.com'
})

// Etherscan API v2 (multi-chain support)
const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api'

async function etherscan(params) {
  const url = new URL(ETHERSCAN_BASE)
  url.searchParams.set('chainid', '1') // Ethereum mainnet
  url.searchParams.set('apikey', ETHERSCAN_KEY)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  const res = await fetch(url.toString())
  const data = await res.json()
  if (data.status === '0' && data.message !== 'No transactions found') {
    throw new Error(`Etherscan error: ${data.message} - ${data.result}`)
  }
  return data.result
}

async function getWalletData(address) {
  const [ethBalance, txList, tokenTx, internalTx] = await Promise.allSettled([
    etherscan({ module: 'account', action: 'balance', address, tag: 'latest' }),
    etherscan({ module: 'account', action: 'txlist', address, startblock: '0', endblock: '99999999', page: '1', offset: '20', sort: 'desc' }),
    etherscan({ module: 'account', action: 'tokentx', address, page: '1', offset: '20', sort: 'desc' }),
    etherscan({ module: 'account', action: 'txlistinternal', address, page: '1', offset: '10', sort: 'desc' }),
  ])

  return {
    ethBalance: ethBalance.status === 'fulfilled' ? ethBalance.value : '0',
    txList: txList.status === 'fulfilled' ? (Array.isArray(txList.value) ? txList.value : []) : [],
    tokenTx: tokenTx.status === 'fulfilled' ? (Array.isArray(tokenTx.value) ? tokenTx.value : []) : [],
    internalTx: internalTx.status === 'fulfilled' ? (Array.isArray(internalTx.value) ? internalTx.value : []) : [],
  }
}

function summarizeWalletData(address, data) {
  const ethBalanceEth = (BigInt(data.ethBalance || '0') / BigInt(1e14)).toString()
  const ethBalanceFormatted = (Number(ethBalanceEth) / 1e4).toFixed(4)

  const txCount = data.txList.length
  const firstTx = data.txList.length > 0 ? data.txList[data.txList.length - 1] : null
  const lastTx = data.txList.length > 0 ? data.txList[0] : null
  const firstSeen = firstTx ? new Date(Number(firstTx.timeStamp) * 1000).toISOString().slice(0, 10) : 'unknown'
  const lastActive = lastTx ? new Date(Number(lastTx.timeStamp) * 1000).toISOString().slice(0, 10) : 'unknown'

  // Unique token interactions
  const tokens = {}
  for (const tx of data.tokenTx) {
    if (!tokens[tx.tokenSymbol]) tokens[tx.tokenSymbol] = 0
    tokens[tx.tokenSymbol]++
  }
  const topTokens = Object.entries(tokens)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([sym, count]) => `${sym}(${count}次)`)

  // Unique contract interactions
  const contracts = new Set(data.txList.filter(tx => tx.to && tx.input !== '0x').map(tx => tx.to))

  // Recent tx summary
  const recentTxSummary = data.txList.slice(0, 5).map(tx => {
    const ethVal = (Number(tx.value) / 1e18).toFixed(4)
    const isOut = tx.from.toLowerCase() === address.toLowerCase()
    return `${isOut ? '发出' : '接收'} ${ethVal} ETH → ${tx.to?.slice(0, 10)}...`
  })

  return {
    ethBalanceFormatted,
    txCount,
    firstSeen,
    lastActive,
    topTokens,
    contractCount: contracts.size,
    recentTxSummary,
    tokenTypesCount: Object.keys(tokens).length,
  }
}

const agent = new SavantDex({
  privateKey: PRIVATE_KEY,
  agentId: 'wallet-analyst-v1',
  network: { websocketPort: 32205, externalIp: EXTERNAL_IP }
})

await agent.register()
await registerToRegistry(agent, PRIVATE_KEY, {
  registryUrl: process.env.REGISTRY_URL || 'http://localhost:3000',
  capabilities: ['wallet-analysis', 'portfolio', 'defi'],
  description: 'Analyzes any Ethereum wallet: holdings, DeFi activity, risk profile, and on-chain history.',
  name: 'Wallet Analyst',
  category: 'blockchain',
  exampleInput: { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
  exampleOutput: { summary: 'Vitalik.eth — ETH holder, active Gitcoin donor, minimal DeFi exposure.' },
  inputSchema: [
    { key: 'address', label: 'Ethereum Address', type: 'text', required: true, placeholder: '0x...', hint: 'Any EVM-compatible wallet address' }
  ],
}).catch(e => console.warn('[registry] Registration skipped:', e.message))

console.log('\n=== SavantDex Worker - Wallet Analyst ===')
console.log('Stream:', await agent.getStreamId())
console.log('Waiting for tasks...\n')

await agent.onTask(async (task, reply) => {
  if (task.type !== 'analyze-wallet') {
    return reply({ error: `Unknown task type: ${task.type}` })
  }

  const address = task.input?.address?.trim()
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return reply({ error: 'Invalid Ethereum address' })
  }

  console.log(`[wallet-analyst] Analyzing: ${address}`)

  try {
    const data = await getWalletData(address)
    const summary = summarizeWalletData(address, data)

    console.log(`  ETH Balance: ${summary.ethBalanceFormatted}`)
    console.log(`  Tx count (recent 20): ${summary.txCount}`)
    console.log(`  Tokens: ${summary.topTokens.join(', ')}`)

    const prompt = `Analyze the following Ethereum wallet data and provide a professional assessment:

**Wallet**: ${address}
**ETH Balance**: ${summary.ethBalanceFormatted} ETH
**Transactions (latest 20)**: ${summary.txCount}
**First active**: ${summary.firstSeen}
**Last active**: ${summary.lastActive}
**Unique contracts**: ${summary.contractCount}
**Token types interacted**: ${summary.tokenTypesCount}
**Top tokens**: ${summary.topTokens.join(', ') || 'none'}
**Recent activity**:
${summary.recentTxSummary.join('\n')}

Provide:
1. Behavior profile (active level, main usage)
2. Holdings overview
3. Token preference analysis
4. Risk flags (if any unusual patterns)
5. Overall label: Newcomer / Regular User / Active Trader / DeFi Power User / Institutional

Keep response under 180 words. Be concise and professional.`

    const res = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a professional blockchain analyst specializing in Ethereum on-chain data. Always reply in English.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 500,
    })

    const analysis = res.choices[0].message.content.trim()
    console.log(`[result] ${analysis.slice(0, 100)}...\n`)

    await reply({
      analysis,
      holdings: `${summary.ethBalanceFormatted} ETH`,
      txCount: summary.txCount,
      firstSeen: summary.firstSeen,
      lastActive: summary.lastActive,
      topTokens: summary.topTokens.join(', '),
    })
  } catch (err) {
    console.error(`[error] ${err.message}`)
    await reply({ error: err.message })
  }
})
