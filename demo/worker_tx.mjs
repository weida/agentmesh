/**
 * SavantDex Worker - Transaction Explainer
 * Fetches tx details via Etherscan, explains via DeepSeek in plain Chinese
 *
 * Handles task type: 'explain-tx'
 * Input: { hash: '0x...' }
 * Output: { explanation, from, to, value, status, tokenTransfers }
 */

import { SavantDex } from '../sdk/index.mjs'
import OpenAI from 'openai'

const PRIVATE_KEY = process.env.PRIVATE_KEY
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY
const EXTERNAL_IP = process.env.EXTERNAL_IP || '39.101.135.96'

if (!PRIVATE_KEY) { console.error('Missing PRIVATE_KEY'); process.exit(1) }
if (!DEEPSEEK_KEY) { console.error('Missing DEEPSEEK_API_KEY'); process.exit(1) }
if (!ETHERSCAN_KEY) { console.error('Missing ETHERSCAN_API_KEY'); process.exit(1) }

const deepseek = new OpenAI({
  apiKey: DEEPSEEK_KEY,
  baseURL: 'https://api.deepseek.com'
})

const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api'

async function etherscan(params, chainId = '1') {
  const url = new URL(ETHERSCAN_BASE)
  url.searchParams.set('chainid', chainId)
  url.searchParams.set('apikey', ETHERSCAN_KEY)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  const res = await fetch(url.toString())
  const data = await res.json()
  if (data.status === '0' && data.result !== '0x') {
    throw new Error(`Etherscan error: ${data.message}`)
  }
  return data.result
}

// Try Ethereum mainnet first, then Polygon if not found
async function getTxChain(hash) {
  for (const [chainId, name] of [['1', 'Ethereum'], ['137', 'Polygon']]) {
    try {
      const tx = await etherscan({ module: 'proxy', action: 'eth_getTransactionByHash', txhash: hash }, chainId)
      if (tx && tx.hash) return { chainId, chainName: name }
    } catch {}
  }
  return { chainId: '1', chainName: 'Ethereum' }
}

// Known contract labels for common protocols
const KNOWN_CONTRACTS = {
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 Router',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3 Router 2',
  '0x1111111254fb6c44bac0bed2854e76f90643097d': '1inch Aggregator V4',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch Aggregator V5',
  '0x00000000219ab540356cbb839cbe05303d7705fa': 'ETH2 Deposit Contract',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC Token',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT Token',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI Token',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH Token',
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC Token',
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': 'AAVE Token',
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': 'UNI Token',
}

function labelAddress(addr) {
  if (!addr) return '合约创建'
  const lower = addr.toLowerCase()
  return KNOWN_CONTRACTS[lower] || addr.slice(0, 8) + '...' + addr.slice(-6)
}

async function getTxData(hash, chainId = '1') {
  const [txReceipt, txInfo, tokenTxList] = await Promise.allSettled([
    etherscan({ module: 'proxy', action: 'eth_getTransactionReceipt', txhash: hash }, chainId),
    etherscan({ module: 'proxy', action: 'eth_getTransactionByHash', txhash: hash }, chainId),
    etherscan({ module: 'account', action: 'tokentx', txhash: hash, page: '1', offset: '50' }, chainId),
  ])

  return {
    receipt: txReceipt.status === 'fulfilled' ? txReceipt.value : null,
    tx: txInfo.status === 'fulfilled' ? txInfo.value : null,
    tokenTx: tokenTxList.status === 'fulfilled' ? (Array.isArray(tokenTxList.value) ? tokenTxList.value : []) : [],
  }
}

const agent = new SavantDex({
  privateKey: PRIVATE_KEY,
  agentId: 'tx-explainer-v1',
  network: { websocketPort: 32206, externalIp: EXTERNAL_IP }
})

await agent.register()
console.log('\n=== SavantDex Worker - Transaction Explainer ===')
console.log('Stream:', await agent.getStreamId())
console.log('Waiting for tasks...\n')

await agent.onTask(async (task, reply) => {
  if (task.type !== 'explain-tx') {
    return reply({ error: `Unknown task type: ${task.type}` })
  }

  const hash = task.input?.hash?.trim()
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return reply({ error: 'Invalid transaction hash (must be 0x + 64 hex chars)' })
  }

  console.log(`[tx-explainer] Fetching: ${hash}`)

  try {
    const { chainId, chainName } = await getTxChain(hash)
    console.log(`[tx-explainer] Detected chain: ${chainName} (${chainId})`)
    const { receipt, tx, tokenTx } = await getTxData(hash, chainId)

    if (!tx) {
      return reply({ error: 'Transaction not found on Ethereum or Polygon' })
    }

    const nativeToken = chainId === '137' ? 'POL' : 'ETH'

    const from = tx.from || ''
    const to = tx.to || ''
    const valueWei = BigInt(tx.value || '0')
    const valueNative = (Number(valueWei) / 1e18).toFixed(6)
    const gasUsed = receipt ? parseInt(receipt.gasUsed, 16) : 0
    const gasPrice = parseInt(tx.gasPrice || '0', 16)
    const gasFeeNative = ((gasUsed * gasPrice) / 1e18).toFixed(6)
    const status = receipt ? (receipt.status === '0x1' ? 'Success' : 'Failed') : 'Pending'
    const blockNumber = receipt ? parseInt(receipt.blockNumber, 16) : 'pending'
    const isContract = to && !KNOWN_CONTRACTS[to.toLowerCase()] && tx.input && tx.input !== '0x'
    const isSimpleTransfer = tx.input === '0x' || tx.input === '0x0'

    // Token transfers summary
    const tokenSummary = tokenTx.slice(0, 5).map(t => {
      const decimals = Number(t.tokenDecimal) || 18
      const amount = (Number(t.value) / Math.pow(10, decimals)).toFixed(4)
      return `${amount} ${t.tokenSymbol} 从 ${t.from.slice(0,8)}... → ${t.to.slice(0,8)}...`
    })

    // Build context for AI
    const inputPreview = tx.input && tx.input.length > 10
      ? tx.input.slice(0, 10) + '...' + `(${Math.floor((tx.input.length - 2) / 2)} bytes)`
      : tx.input

    const prompt = `Explain the following ${chainName} transaction in plain language:

**Hash**: ${hash}
**Status**: ${status}
**Block**: ${blockNumber}
**From**: ${from} (${labelAddress(from)})
**To**: ${to || '(contract creation)'} (${labelAddress(to)})
**${nativeToken} Value**: ${valueNative} ${nativeToken}
**Gas Fee**: ${gasFeeNative} ${nativeToken}
**Calldata**: ${inputPreview}
${tokenTx.length > 0 ? `**Token Transfers**:\n${tokenSummary.join('\n')}` : '**Token Transfers**: none'}
**Known Protocol**: ${KNOWN_CONTRACTS[to?.toLowerCase()] || 'Unknown / EOA'}

Explain:
1. What this transaction did (one-sentence summary)
2. Which protocol or action was involved
3. From the sender's perspective: what did they do, gain, or lose?

Keep under 130 words. Write for a non-technical audience.`

    const res = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a blockchain analyst. Explain on-chain transactions in clear, simple English that anyone can understand.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 400,
    })

    const explanation = res.choices[0].message.content.trim()
    console.log(`[result] ${explanation.slice(0, 100)}...\n`)

    await reply({
      explanation,
      from,
      to: to || '(contract creation)',
      value: `${valueNative} ${nativeToken}`,
      gasFee: `${gasFeeNative} ${nativeToken}`,
      status,
      block: String(blockNumber),
      tokenTransfers: tokenSummary.join('\n') || 'None',
      protocol: KNOWN_CONTRACTS[to?.toLowerCase()] || 'Unknown',
      chain: chainName,
    })
  } catch (err) {
    console.error(`[error] ${err.message}`)
    await reply({ error: err.message })
  }
})
