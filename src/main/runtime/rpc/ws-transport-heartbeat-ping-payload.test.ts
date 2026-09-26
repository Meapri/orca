import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { WebSocketTransport } from './ws-transport'
import { REMOTE_RUNTIME_SOCKET_PING_PAYLOAD } from '../../../shared/remote-runtime-socket-liveness'

// Regression for #20673: an empty heartbeat ping makes every peer auto-pong an empty frame, and
// an empty write fails with EFAULT on Electron/Linux ARM64 hosts, dropping the socket each sweep.
describe('WebSocketTransport heartbeat ping payload', () => {
  const transports: WebSocketTransport[] = []
  const clients: WebSocket[] = []

  afterEach(async () => {
    for (const client of clients) {
      client.terminate()
    }
    clients.length = 0
    await Promise.all(transports.map((transport) => transport.stop().catch(() => {})))
    transports.length = 0
  })

  async function connectAuthenticated(options: {
    autoPong: boolean
  }): Promise<{ transport: WebSocketTransport; client: WebSocket }> {
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      port: 0,
      heartbeatIntervalMs: 40
    })
    transports.push(transport)
    // Why: the heartbeat only probes authenticated sockets; bind an id the way E2EE readiness does.
    transport.onMessage((_message, _reply, ws) => transport.setClientId(ws, 'device-token'))
    await transport.start()
    const client = new WebSocket(`ws://127.0.0.1:${transport.resolvedPort}`, {
      autoPong: options.autoPong
    })
    clients.push(client)
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve())
      client.once('error', reject)
    })
    client.send('auth')
    return { transport, client }
  }

  it('probes with a non-empty payload that compliant peers echo back', async () => {
    const { client } = await connectAuthenticated({ autoPong: true })
    const pings: Buffer[] = []
    client.on('ping', (data) => pings.push(data))

    await vi.waitFor(() => expect(pings.length).toBeGreaterThanOrEqual(3), { timeout: 2_000 })

    for (const payload of pings) {
      expect(payload.length).toBeGreaterThan(0)
      expect(new Uint8Array(payload)).toEqual(REMOTE_RUNTIME_SOCKET_PING_PAYLOAD)
    }
    expect(client.readyState).toBe(WebSocket.OPEN)
  })

  it('still counts an empty pong from an older peer as proof of life', async () => {
    const { client } = await connectAuthenticated({ autoPong: false })
    let pings = 0
    client.on('ping', () => {
      pings += 1
      // Why: an older or non-compliant peer may answer without echoing; liveness must not depend on it.
      client.pong()
    })

    await vi.waitFor(() => expect(pings).toBeGreaterThanOrEqual(5), { timeout: 2_000 })
    expect(client.readyState).toBe(WebSocket.OPEN)
  })

  it('reaps a peer that never answers the probe at all', async () => {
    const { client } = await connectAuthenticated({ autoPong: false })
    const closed = new Promise<number>((resolve) => client.once('close', (code) => resolve(code)))

    await expect(closed).resolves.toBe(1006)
  })
})
