/**
 * SavantDex Registry Client
 *
 * Handles signed registration of a SavantDex agent into the registry.
 * Workers call registerToRegistry() on startup after agent.register().
 *
 * Usage:
 *   import { registerToRegistry } from '../sdk/registry.mjs'
 *   await registerToRegistry(agent, wallet, {
 *     registryUrl: 'http://localhost:3000',
 *     capabilities: ['explain-tx'],
 *     description: 'Explains Ethereum and Polygon transactions in plain English',
 *   })
 */

import { Wallet } from 'ethers'

/**
 * @param {object} agent         SavantDex instance (already registered on Streamr)
 * @param {string} privateKey    Raw hex private key (for signing — never sent over wire)
 * @param {object} opts
 * @param {string} opts.registryUrl
 * @param {string[]} opts.capabilities
 * @param {string} [opts.description]
 * @param {string} [opts.name]           Human-readable display name
 * @param {string} [opts.category]       Category slug (e.g. 'blockchain', 'lifestyle')
 * @param {object} [opts.exampleInput]   Example input fields { key: value }
 * @param {object} [opts.exampleOutput]  Example output fields { key: value }
 * @param {Array}  [opts.inputSchema]    Input field descriptors for UI rendering
 * @param {string} [opts.docsUrl]        Link to documentation
 */
export async function registerToRegistry(agent, privateKey, opts) {
  const { registryUrl, capabilities, description = '',
          name, category, exampleInput, exampleOutput, inputSchema, docsUrl } = opts

  const streamId = await agent.getStreamId()
  const agentId = streamId.split('/').pop()
  const wallet = new Wallet(privateKey)
  const owner = wallet.address.toLowerCase()
  const timestamp = Date.now()

  const message = `Register ${agentId} ${streamId} ts:${timestamp}`
  const signature = await wallet.signMessage(message)

  const payload = { agentId, streamId, capabilities, description, owner, timestamp, signature }
  if (name !== undefined)         payload.name = name
  if (category !== undefined)     payload.category = category
  if (exampleInput !== undefined) payload.exampleInput = exampleInput
  if (exampleOutput !== undefined) payload.exampleOutput = exampleOutput
  if (inputSchema !== undefined)  payload.inputSchema = inputSchema
  if (docsUrl !== undefined)      payload.docsUrl = docsUrl

  const res = await fetch(`${registryUrl}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(`Registry error: ${data.error}`)

  console.log(`[registry] Registered: ${agentId}`)
  return data
}
