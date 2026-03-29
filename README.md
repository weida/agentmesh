# AgentMesh SDK

Decentralized AI agent communication bus built on [Streamr Network](https://streamr.network).

Agents register an on-chain inbox stream, then send tasks and receive results peer-to-peer — no central server, no Sponsorship required.

## Quick Start

```bash
npm install agentmesh @streamr/sdk
```

### Worker Agent (provides a capability)

```js
import { AgentMesh } from 'agentmesh'

const agent = new AgentMesh({
  privateKey: process.env.PRIVATE_KEY,  // Ethereum private key
  agentId: 'summarizer-v1',
  network: { websocketPort: 32200, externalIp: 'YOUR_SERVER_IP' }
})

// First run only: creates stream on Polygon (costs ~0.01 POL gas)
await agent.register()

await agent.onTask(async (task, reply) => {
  if (task.type === 'summarize') {
    const result = await callYourAI(task.input.text)
    await reply({ summary: result })
  }
})
```

### Requester Agent (sends tasks)

```js
import { AgentMesh } from 'agentmesh'

const agent = new AgentMesh({
  privateKey: process.env.PRIVATE_KEY,
  agentId: 'my-app',
  network: { websocketPort: 32201, externalIp: 'YOUR_SERVER_IP' }
})

await agent.register()

const WORKER_STREAM = '0xABCD.../agentmesh/summarizer-v1'

const taskId = await agent.sendTask(WORKER_STREAM, {
  type: 'summarize',
  input: { text: 'Long article text here...' }
})

const result = await agent.waitForResult(taskId, 30000)
console.log(result.summary)
```

## API

### `new AgentMesh(config)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `privateKey` | string | Ethereum private key (hex with 0x prefix) |
| `agentId` | string | Unique agent name, e.g. `"summarizer-v1"` |
| `network.websocketPort` | number | Fixed port for Streamr node (open in firewall) |
| `network.externalIp` | string | Public IP of the server |

### `agent.register()` → `Promise<streamId>`
Creates the agent's inbox stream on Polygon mainnet (if not exists) and opens public publish/subscribe permissions.
- **Required once** per `agentId` per wallet
- Costs ~0.01–0.05 POL in gas

### `agent.getStreamId()` → `Promise<string>`
Returns `{address}/agentmesh/{agentId}` — share this with requesters so they can send tasks.

### `agent.sendTask(targetStreamId, task)` → `Promise<taskId>`
Sends a task to another agent's stream.

| Field | Type | Description |
|-------|------|-------------|
| `task.type` | string | Task type identifier, e.g. `"summarize"` |
| `task.input` | any | Task input data |

### `agent.onTask(handler)` → `Promise<void>`
Subscribes to incoming tasks. Handler receives:
- `task` — full task message (`taskId`, `type`, `input`, `from`, `replyTo`, `ts`)
- `reply(output)` — sends result back to requester

### `agent.waitForResult(taskId, timeout?)` → `Promise<output>`
Waits for a result matching `taskId`. Default timeout: 30 seconds.

### `agent.destroy()` → `Promise<void>`
Cleanly shuts down the Streamr node.

## Message Format

### Task message (Requester → Worker)
```json
{
  "taskId": "task-1234567890-abc123",
  "type": "summarize",
  "input": { "text": "..." },
  "replyTo": "0xREQUESTER.../agentmesh/my-app",
  "from": "0xREQUESTER_ADDRESS",
  "ts": 1700000000000
}
```

### Result message (Worker → Requester)
```json
{
  "taskId": "task-1234567890-abc123",
  "type": "result",
  "output": { "summary": "..." },
  "from": "0xWORKER_ADDRESS",
  "ts": 1700000000000
}
```

## Requirements

- Node.js 20+
- A public server with open inbound ports (for Streamr node connectivity)
- ~0.1 POL on Polygon mainnet (one-time stream registration per agent)

## Architecture

```
Requester                    Streamr P2P Network              Worker
   │                                                             │
   │──── publish task ──────────────────────────────────────►  │
   │                                                             │  onTask handler
   │                                                             │  calls AI API
   │  ◄──── publish result ─────────────────────────────────── │
   │
waitForResult resolves
```

Each agent has an **inbox stream** on Streamr (`{address}/agentmesh/{agentId}`).
Messages are routed peer-to-peer through the Streamr DHT — no central relay.
