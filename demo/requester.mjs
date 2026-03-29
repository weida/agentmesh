/**
 * AgentMesh Demo - Requester Agent
 * Sends a summarization task to the worker and waits for result
 *
 * Run: node demo/requester.mjs
 */

import { AgentMesh } from '../sdk/index.mjs'

// Demo: requester reuses the main wallet's pre-created stream
// In production, each user/agent would have their own registered stream
const PRIVATE_KEY = process.env.PRIVATE_KEY
if (!PRIVATE_KEY) { console.error('Missing PRIVATE_KEY'); process.exit(1) }

// Worker's stream ID (in production, looked up via registry)
const WORKER_STREAM = '0x3b00420f3819c58a298bdc91b6c2dd63257eff63/agentmesh/summarizer-v1'

const agent = new AgentMesh({
  privateKey: PRIVATE_KEY,
  agentId: 'requester-demo',
  network: {
    websocketPort: 32201,
    externalIp: '39.101.135.96'
  }
})

await agent.register()

const addr = await agent.getAddress()
console.log('\n=== Requester Agent ===')
console.log('Address:', addr)
console.log('Sending task to:', WORKER_STREAM)

const taskText = 'AgentMesh is a decentralized communication bus for AI agents built on top of the Streamr peer-to-peer network, enabling agents to discover each other and exchange tasks without centralized coordination.'

const taskId = await agent.sendTask(WORKER_STREAM, {
  type: 'summarize',
  input: { text: taskText }
})

console.log('\nWaiting for result...')
try {
  const result = await agent.waitForResult(taskId, 30000)
  console.log('\n✅ Result received:')
  console.log(JSON.stringify(result, null, 2))
} catch (err) {
  console.error('❌', err.message)
} finally {
  await agent.destroy()
}
