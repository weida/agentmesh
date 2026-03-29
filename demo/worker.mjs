/**
 * AgentMesh Demo - Worker Agent
 * A "text summarizer" agent that receives tasks and returns results
 *
 * Run: node demo/worker.mjs
 */

import { AgentMesh } from '../sdk/index.mjs'

// Worker uses the main wallet (stream owner, has POL for registration)
const PRIVATE_KEY = '0x8d4212d3d63f786687cbf1b70c43a905cd2b9e42cf826bfe574bb491b14ea2e4'

const agent = new AgentMesh({
  privateKey: PRIVATE_KEY,
  agentId: 'summarizer-v1',
  network: {
    websocketPort: 32200,
    externalIp: '39.101.135.96'
  }
})

// Register once (creates stream on-chain if not exists)
const streamId = await agent.register()
console.log('\n=== Summarizer Worker Ready ===')
console.log('Stream ID:', streamId)
console.log('Waiting for tasks...\n')

// Handle incoming tasks
await agent.onTask(async (task, reply) => {
  if (task.type === 'summarize') {
    const text = task.input?.text || ''
    console.log(`Processing: "${text.slice(0, 60)}..."`)

    // Simulate AI processing
    await new Promise(r => setTimeout(r, 800))
    const summary = `[Summary] ${text.split(' ').slice(0, 8).join(' ')}...`

    await reply({ summary, wordCount: text.split(' ').length })
  } else {
    await reply({ error: `Unknown task type: ${task.type}` })
  }
})
