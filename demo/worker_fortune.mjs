/**
 * SavantDex Worker - Fortune Teller (Western Astrology)
 * Always responds in English using zodiac, planets, and birth chart
 *
 * Handles task type: 'fortune'
 * Input: { name: 'John', birthdate: '1990-05-15', birthtime?: '14:30', question?: '...' }
 * Output: { reading }
 */

import { SavantDex } from '../sdk/index.mjs'
import OpenAI from 'openai'

const PRIVATE_KEY = process.env.PRIVATE_KEY
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY
const EXTERNAL_IP = process.env.EXTERNAL_IP || '39.101.135.96'

if (!PRIVATE_KEY) { console.error('Missing PRIVATE_KEY'); process.exit(1) }
if (!DEEPSEEK_KEY) { console.error('Missing DEEPSEEK_API_KEY'); process.exit(1) }

const deepseek = new OpenAI({
  apiKey: DEEPSEEK_KEY,
  baseURL: 'https://api.deepseek.com'
})

const SYSTEM_PROMPT = `You are an elegant astrologer specializing in Western astrology — sun signs, moon signs, rising signs, planetary influences, and birth chart energy.

Rules you must follow:
- ALWAYS respond in English, regardless of the input language
- Use Western astrology exclusively: zodiac signs, planets, houses, aspects
- Derive the sun sign from the birth date; if birth time is provided, mention rising sign energy
- Keep the tone poetic, warm, and empowering — never alarming or fatalistic
- Format your response with clear sections using these exact headers:
  ✦ CELESTIAL PROFILE
  ✦ CURRENT PLANETARY ENERGY
  ✦ LUCKY ELEMENTS
  ✦ COSMIC GUIDANCE
- Each section: 2–4 sentences. Total response under 280 words.
- Never output phone numbers, ID numbers, addresses, or any personal data
- If asked anything unrelated to astrology or fortune-telling, respond: "The stars do not answer such questions."`

function buildPrompt(name, birthdate, birthtime, question) {
  const lines = [
    `Name: ${name}`,
    `Date of birth: ${birthdate}`,
  ]
  if (birthtime) lines.push(`Time of birth: ${birthtime}`)
  if (question) lines.push(`Their question: "${question}"`)
  lines.push('\nProvide a fortune reading.')
  return lines.join('\n')
}

const agent = new SavantDex({
  privateKey: PRIVATE_KEY,
  agentId: 'fortune-teller-v1',
  network: { websocketPort: 32207, externalIp: EXTERNAL_IP }
})

await agent.register()
console.log('\n=== SavantDex Worker - Fortune Teller ===')
console.log('Stream:', await agent.getStreamId())
console.log('Waiting for tasks...\n')

await agent.onTask(async (task, reply) => {
  if (task.type !== 'fortune') {
    return reply({ error: 'Unknown task type' })
  }

  const { name, birthdate, birthtime, question } = task.input || {}

  if (!name || !birthdate) {
    return reply({ error: 'name and birthdate are required' })
  }

  // Validate birthdate format loosely
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
    return reply({ error: 'birthdate must be YYYY-MM-DD' })
  }

  console.log(`[fortune] Reading for: ${name}, ${birthdate}`)

  try {
    const res = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(name, birthdate, birthtime, question) }
      ],
      max_tokens: 600,
      temperature: 0.9,
    })

    const reading = res.choices[0].message.content.trim()
    console.log(`[result] ${reading.slice(0, 100)}...\n`)

    await reply({ reading })
  } catch (err) {
    console.error(`[error] ${err.message}`)
    await reply({ error: err.message })
  }
})
