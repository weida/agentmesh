/**
 * SavantDex SDK v0.3
 * Decentralized AI agent marketplace on Streamr Network
 */

import { StreamrClient, StreamPermission } from '@streamr/sdk'

export class SavantDex {
  #client
  #streamId
  #agentId
  #address

  /**
   * @param {object} config
   * @param {string} config.privateKey  - Ethereum private key
   * @param {string} config.agentId     - Unique agent identifier (e.g. "wallet-analyst-v1")
   * @param {object} [config.network]   - Optional Streamr network overrides
   */
  constructor({ privateKey, agentId, network = {} }) {
    this.#agentId = agentId
    this.#client = new StreamrClient({
      auth: { privateKey },
      network: {
        controlLayer: {
          websocketPortRange: network.websocketPort
            ? { min: network.websocketPort, max: network.websocketPort }
            : undefined,
          externalIp: network.externalIp
        }
      }
    })
  }

  /** Returns this agent's Ethereum address */
  async getAddress() {
    if (!this.#address) this.#address = await this.#client.getAddress()
    return this.#address
  }

  /** Returns the stream ID for this agent's inbox */
  async getStreamId() {
    if (!this.#streamId) {
      const addr = await this.getAddress()
      this.#streamId = `${addr.toLowerCase()}/savantdex/${this.#agentId}`
    }
    return this.#streamId
  }

  /**
   * Register this agent - creates its inbox stream if not exists, opens public subscribe
   * Call once on first run (costs POL gas). Subsequent runs skip if stream exists.
   */
  async register() {
    const streamId = await this.getStreamId()
    const stream = await this.#client.getOrCreateStream({ id: `/savantdex/${this.#agentId}` })

    const isPublicSub = await stream.hasPermission({ permission: StreamPermission.SUBSCRIBE, public: true })
    const isPublicPub = await stream.hasPermission({ permission: StreamPermission.PUBLISH, public: true })
    const toGrant = []
    if (!isPublicSub) toGrant.push(StreamPermission.SUBSCRIBE)
    if (!isPublicPub) toGrant.push(StreamPermission.PUBLISH)
    if (toGrant.length > 0) {
      await stream.grantPermissions({ permissions: toGrant, public: true })
    }

    console.log(`[SavantDex] Registered: ${streamId}`)
    return streamId
  }

  /**
   * Send a task to another agent
   * @param {string} targetStreamId - Target agent's stream ID
   * @param {object} task           - Task payload
   * @param {string} task.type      - Task type identifier
   * @param {any}    task.input     - Task input data
   * @returns {string} taskId
   */
  async sendTask(targetStreamId, { type, input }) {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const replyStreamId = await this.getStreamId()

    await this.#client.publish(targetStreamId, {
      taskId,
      type,
      input,
      replyTo: replyStreamId,
      from: await this.getAddress(),
      ts: Date.now()
    })

    console.log(`[SavantDex] Task sent: ${taskId} → ${targetStreamId}`)
    return taskId
  }

  /**
   * Listen for incoming tasks
   * @param {function} handler - async (task, reply) => void
   *   reply(result) sends result back to requester
   */
  async onTask(handler) {
    const streamId = await this.getStreamId()
    await this.#client.subscribe(streamId, async (msg) => {
      if (!msg.taskId) return

      console.log(`[SavantDex] Task received: ${msg.taskId} (${msg.type})`)

      const reply = async (output) => {
        if (!msg.replyTo) return
        await this.#client.publish(msg.replyTo, {
          taskId: msg.taskId,
          type: 'result',
          output,
          from: await this.getAddress(),
          ts: Date.now()
        })
        console.log(`[SavantDex] Result sent: ${msg.taskId} → ${msg.replyTo}`)
      }

      try {
        await handler(msg, reply)
      } catch (err) {
        await reply({ error: err.message })
      }
    })

    console.log(`[SavantDex] Listening on: ${streamId}`)
  }

  /**
   * Wait for a result matching taskId
   * @param {string} taskId
   * @param {number} timeout - ms
   */
  async waitForResult(taskId, timeout = 30000) {
    const streamId = await this.getStreamId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${taskId}`)), timeout)

      this.#client.subscribe(streamId, (msg) => {
        if (msg.taskId === taskId && msg.type === 'result') {
          clearTimeout(timer)
          resolve(msg.output)
        }
      }).catch(reject)
    })
  }

  async destroy() {
    await this.#client.destroy()
  }
}
