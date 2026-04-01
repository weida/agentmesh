/**
 * SavantDex Registry Client
 *
 * Handles signed registration of a SavantDex agent into the registry.
 * Workers call registerToRegistry() on startup after agent.register().
 *
 * Auth model (v0.4):
 *   signature = personal_sign(
 *     "Authorize runtime {runtimeAddress} for agent {agentId} stream {streamId} ts:{timestamp}"
 *   )
 *   - privateKey is the owner key (signs the authorization)
 *   - runtimeAddress is derived from the agent's Streamr identity
 *
 * Demo note: until Phase 1-Migration, owner key == runtime key (same address).
 * The registry accepts this because runtimeAddress == ownerAddress is valid.
 *
 * Usage:
 *   import { registerToRegistry } from '../sdk/registry.mjs'
 *   await registerToRegistry(agent, ownerPrivateKey, {
 *     registryUrl: 'http://localhost:3000',
 *     capabilities: ['explain-tx'],
 *     description: 'Explains Ethereum and Polygon transactions',
 *   })
 */

import { Wallet } from 'ethers'

/**
 * @param {object} agent            SavantDex instance (already registered on Streamr)
 * @param {string} ownerPrivateKey  Owner's private key — signs the authorization (never sent)
 * @param {object} opts
 * @param {string}   opts.registryUrl
 * @param {string[]} opts.capabilities
 * @param {string}   [opts.description]
 * @param {string}   [opts.name]
 * @param {string}   [opts.category]
 * @param {object}   [opts.exampleInput]
 * @param {object}   [opts.exampleOutput]
 * @param {Array}    [opts.inputSchema]
 * @param {string}   [opts.docsUrl]
 */
export async function registerToRegistry(agent, ownerPrivateKey, opts) {
  const { registryUrl, capabilities, description = '',
          name, category, exampleInput, exampleOutput, inputSchema, docsUrl } = opts

  const streamId      = await agent.getStreamId()
  const agentId       = streamId.split('/').pop()

  // Owner signs the authorization
  const ownerWallet   = new Wallet(ownerPrivateKey)
  const ownerAddress  = ownerWallet.address.toLowerCase()

  // Runtime address is derived from the streamId prefix (the Streamr identity address)
  const runtimeAddress = streamId.split('/')[0].toLowerCase()

  const timestamp = Date.now()
  const message   = `Authorize runtime ${runtimeAddress} for agent ${agentId} stream ${streamId} ts:${timestamp}`
  const signature = await ownerWallet.signMessage(message)

  const payload = {
    agentId, streamId,
    ownerAddress, runtimeAddress,
    capabilities, description,
    timestamp, signature,
  }
  if (name !== undefined)          payload.name = name
  if (category !== undefined)      payload.category = category
  if (exampleInput !== undefined)  payload.exampleInput = exampleInput
  if (exampleOutput !== undefined) payload.exampleOutput = exampleOutput
  if (inputSchema !== undefined)   payload.inputSchema = inputSchema
  if (docsUrl !== undefined)       payload.docsUrl = docsUrl

  const res = await fetch(`${registryUrl}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(`Registry error: ${data.error}`)

  console.log(`[registry] Registered: ${agentId} (owner: ${ownerAddress}, runtime: ${runtimeAddress})`)
  return data
}
