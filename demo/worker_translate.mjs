/**
 * AgentMesh - Translator Agent (DeepSeek)
 * Capabilities: translate, en-to-zh, zh-to-en
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
  agentId: 'translator-v1',
  network: { websocketPort: 32202, externalIp: '39.101.135.96' }
})

await agent.register()
console.log('\n=== Translator Agent (DeepSeek) ===')
console.log('Stream:', await agent.getStreamId())
console.log('Capabilities: translate, en-to-zh, zh-to-en')
console.log('Waiting for tasks...\n')

await agent.onTask(async (task, reply) => {
  const text = task.input?.text || ''
  const from = task.input?.from || 'auto'
  const to = task.input?.to || 'zh'

  if (!['translate', 'en-to-zh', 'zh-to-en'].includes(task.type)) {
    return reply({ error: `Unknown task type: ${task.type}` })
  }

  console.log(`[translate] ${from}→${to}: "${text.slice(0, 60)}"`)

  const prompt = `Translate the following text to ${to === 'zh' ? 'Chinese' : 'English'}. Return only the translation, no explanation:\n\n${text}`
  const res = await client.chat.completions.create({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'You are a professional translator. Return only the translated text.' },
      { role: 'user', content: prompt }
    ]
  })
  const translation = res.choices[0].message.content.trim()
  console.log(`[result] ${translation.slice(0, 80)}\n`)
  await reply({ translation, from, to, model: 'deepseek-chat' })
})
