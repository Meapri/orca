import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { createWebSocketDeliveryReceipts } from './ws-delivery-receipts'
import { WebSocketTransport } from './ws-transport'

function fakeSocket() {
  const pings: string[] = []
  return {
    pings,
    socket: {
      OPEN: 1 as const,
      readyState: 1 as WebSocket['readyState'],
      ping: (data?: unknown) => {
        pings.push(Buffer.isBuffer(data) ? data.toString('latin1') : '')
      }
    }
  }
}

describe('createWebSocketDeliveryReceipts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('releases a waiter only when the pong echoing its own ping arrives', () => {
    const { socket, pings } = fakeSocket()
    const receipts = createWebSocketDeliveryReceipts(socket)
    const first = vi.fn()
    const second = vi.fn()
    receipts.request(first)
    receipts.request(second)

    receipts.notePong(Buffer.from(pings[0]!))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()

    // A heartbeat pong proves nothing about ordering relative to the delivery ping.
    receipts.notePong(Buffer.from('orca'))
    expect(second).not.toHaveBeenCalled()
  })

  it('treats a pong for the latest ping as covering earlier ones', () => {
    const { socket, pings } = fakeSocket()
    const receipts = createWebSocketDeliveryReceipts(socket)
    const first = vi.fn()
    const second = vi.fn()
    receipts.request(first)
    receipts.request(second)

    receipts.notePong(Buffer.from(pings[1]!))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('degrades instead of stalling for peers that never echo or never answer', async () => {
    const { socket } = fakeSocket()
    const receipts = createWebSocketDeliveryReceipts(socket, 1_000)
    const echoless = vi.fn()
    receipts.request(echoless)
    receipts.notePong(Buffer.alloc(0))
    expect(echoless).toHaveBeenCalledTimes(1)

    const unanswered = vi.fn()
    receipts.request(unanswered)
    await vi.advanceTimersByTimeAsync(999)
    expect(unanswered).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(unanswered).toHaveBeenCalledTimes(1)
  })

  it('releases immediately on a socket that can no longer ping, and never after cancel', () => {
    const { socket } = fakeSocket()
    socket.readyState = 3
    const receipts = createWebSocketDeliveryReceipts(socket)
    const closed = vi.fn()
    receipts.request(closed)
    expect(closed).toHaveBeenCalledTimes(1)

    socket.readyState = 1
    const cancelled = vi.fn()
    const cancel = receipts.request(cancelled)
    cancel()
    receipts.notePong(Buffer.alloc(0))
    expect(cancelled).not.toHaveBeenCalled()
  })
})

describe('WebSocketTransport delivery receipts over a real socket', () => {
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

  async function connect(autoPong: boolean) {
    const transport = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
    transports.push(transport)
    const ready = new Promise<WebSocket>((resolve) =>
      transport.onMessage((_message, _reply, ws) => resolve(ws))
    )
    await transport.start()
    const client = new WebSocket(`ws://127.0.0.1:${transport.resolvedPort}`, { autoPong })
    clients.push(client)
    await new Promise<void>((resolve) => client.once('open', () => resolve()))
    client.send('hello')
    return { transport, client, serverSocket: await ready }
  }

  it('confirms delivery once the peer has read everything sent before the probe', async () => {
    const { transport, client, serverSocket } = await connect(true)
    const received: string[] = []
    client.on('message', (data) => received.push(String(data)))
    serverSocket.send('state-1')
    const delivered = new Promise<string[]>((resolve) =>
      transport.requestDeliveryReceipt(serverSocket, () => resolve([...received]))
    )

    await expect(delivered).resolves.toEqual(['state-1'])
  })

  it('does not confirm delivery while the peer withholds its pong', async () => {
    const { transport, serverSocket } = await connect(false)
    const onDelivered = vi.fn()
    transport.requestDeliveryReceipt(serverSocket, onDelivered)

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(onDelivered).not.toHaveBeenCalled()
  })
})
