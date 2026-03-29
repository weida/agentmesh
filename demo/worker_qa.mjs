/**
 * AgentMesh - Q&A Agent (DeepSeek)
 * Capabilities: ask, qa, chat
 */

import { AgentMesh } from '../sdk/index.mjs'
import OpenAI from 'openai'

const PRIVATE_KEY = process.env.PRIVATE_KEY
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY
if (!PRIVATE_KEY) { console.error('Missing PRIVATE_KEY'); process.exit(1) }
if (!DEEPSEEK_KEY) { console.error('Missing DEEPSEEK_API_KEY'); process.exit(1) }

const client = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: 'https://api.deepseek.com' })

const agent = new AgentMesh({
  privateKey: PRIVATE_KEY,
  agentId: 'qa-v1',
  network: { websocketPort: 32203, externalIp: '39.101.135.96' }
})

await agent.register()
console.log('\n=== Q&A Agent (DeepSeek) ===')
console.log('Stream:', await agent.getStreamId())
console.log('Capabilities: ask, qa, chat')
console.log('Waiting for tasks...\n')

await agent.onTask(async (task, reply) => {
  if (!['ask', 'qa', 'chat'].includes(task.type)) {
    return reply({ error: `Unknown task type: ${task.type}` })
  }

  const question = task.input?.question || task.input?.text || ''
  const context = task.input?.context || ''
  console.log(`[ask] ${question.slice(0, 80)}`)

  const messages = [
    { role: 'system', content: 'You are a helpful and knowledgeable assistant. Answer clearly and concisely.' }
  ]
  if (context) messages.push({ role: 'user', content: `Context: ${context}` })
  messages.push({ role: 'user', content: question })

  const res = await client.chat.completions.create({ model: 'deepseek-chat', messages })
  const answer = res.choices[0].message.content.trim()
  console.log(`[result] ${answer.slice(0, 100)}\n`)
  await reply({ answer, model: 'deepseek-chat' })
})
