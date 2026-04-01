#!/usr/bin/env node
/**
 * SavantDex Runtime Key Generator
 *
 * Generates a fresh Ethereum wallet and saves it as an encrypted keystore file.
 * The private key is never printed or stored in plaintext — only the keystore is written.
 *
 * Use this for runtime keys (workers, gateway).
 * Do NOT use this for owner keys — owner keys must be generated offline.
 *
 * Usage:
 *   KEYSTORE_PASSWORD=strong-password node sdk/genkey.mjs
 *
 * With label (recommended when generating multiple keys):
 *   KEYSTORE_LABEL=worker  KEYSTORE_PASSWORD=... node sdk/genkey.mjs
 *   KEYSTORE_LABEL=gateway KEYSTORE_PASSWORD=... node sdk/genkey.mjs
 *
 * Output path override:
 *   KEYSTORE_PATH=/secure/worker.keystore.json KEYSTORE_PASSWORD=... node sdk/genkey.mjs
 *
 * After running:
 *   - Fund the printed address with a small amount of POL (for Streamr stream creation)
 *   - Set KEYSTORE_PATH in the relevant service's .env
 *   - Set SECRETS_PATH / AGE_IDENTITY_PATH (see sdk/secrets.mjs) to protect the password
 */

import { Wallet } from 'ethers'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const envPassword = process.env.KEYSTORE_PASSWORD
const label = process.env.KEYSTORE_LABEL

// Derive default output path from label if no explicit path given
function defaultOutPath() {
  if (process.env.KEYSTORE_PATH) return resolve(process.env.KEYSTORE_PATH)
  if (label) return resolve(`${label}.keystore.json`)
  return resolve('keystore.json')
}

const outPath = defaultOutPath()

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer) })
  })
}

const password = envPassword || await prompt('Enter keystore password: ')

if (!password || password.length < 8) {
  console.error('Error: password must be at least 8 characters')
  process.exit(1)
}

console.error('Generating new wallet and encrypting keystore...')

const wallet = Wallet.createRandom()
const keystoreJson = await wallet.encrypt(password)

writeFileSync(outPath, keystoreJson, { mode: 0o600 })

console.log(`Address:  ${wallet.address}`)
console.log(`Keystore: ${outPath}`)
console.log('')
console.log('Next steps:')
console.log(`  1. Fund this address with a small amount of POL (needed for Streamr stream creation)`)
console.log(`  2. Add to your service .env:`)
console.log(`       KEYSTORE_PATH=${outPath}`)
console.log(`  3. Protect the password with age-encrypted secrets (see sdk/secrets.mjs)`)
console.log(`  4. Never print or store the private key — it exists only inside the keystore`)
