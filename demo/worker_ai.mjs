/**
 * AgentMesh Demo - AI Worker (DeepSeek)
 * Handles summarize / ask tasks via DeepSeek API
 *
 * Run: DEEPSEEK_API_KEY=xxx node demo/worker_ai.mjs
 */

import { AgentMesh } from '../sdk/index.mjs'
import OpenAI from 'openai'

const PRIVATE_KEY = process.env.PRIVATE_KEY
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY
if (!PRIVATE_KEY) { console.error('Missing PRIVATE_KEY'); process.exit(1) }
if (!DEEPSEEK_KEY) { console.error('Missing DEEPSEEK_API_KEY'); process.exit(1) }

const client = new OpenAI({
  apiKey: DEEPSEEK_KEY,
  baseURL: 'https://api.deepseek.com'
})

const agent = new AgentMesh({
  privateKey: PRIVATE_KEY,
  agentId: 'summarizer-v1',
  network: { websocketPort: 32200, externalIp: '39.101.135.96' }
})

await agent.register()
console.log('\n=== AgentMesh AI Worker (DeepSeek) ===')
console.log('Stream:', await agent.getStreamId())
console.log('Model:  deepseek-chat')
console.log('Waiting for tasks...\n')

await agent.onTask(async (task, reply) => {
  if (task.type === 'summarize') {
    const text = task.input?.text || ''
    console.log(`[summarize] ${text.slice(0, 80)}...`)

    const res = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Reply concisely.' },
        { role: 'user', content: `Summarize in 1-2 sentences:\n\n${text}` }
      ]
    })
    const summary = res.choices[0].message.content.trim()
    console.log(`[result] ${summary}\n`)
    await reply({ summary, model: 'deepseek-chat' })

  } else if (task.type === 'ask') {
    const question = task.input?.question || ''
    console.log(`[ask] ${question}`)

    const res = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: question }
      ]
    })
    const answer = res.choices[0].message.content.trim()
    console.log(`[result] ${answer.slice(0, 100)}\n`)
    await reply({ answer, model: 'deepseek-chat' })

  } else {
    await reply({ error: `Unknown task type: ${task.type}` })
  }
})
