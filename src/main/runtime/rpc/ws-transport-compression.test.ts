import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { WebSocketTransport } from './ws-transport'
import { BINARY_CIPHERTEXT_SEND } from './ws-transport-compression'

// Stand-in for an encrypted text reply: base64 of full-entropy bytes, as e2ee-channel produces.
const CIPHERTEXT_TEXT = randomBytes(96 * 1024).toString('base64')

function wireBytesRead(client: WebSocket): number {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ws keeps its net.Socket on _socket; the test reads its byte counter only.
  return (client as unknown as { _socket: Socket })._socket.bytesRead
}

describe('WebSocketTransport permessage-deflate', () => {
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

  async function connect(clientOffersDeflate: boolean): Promise<{ client: WebSocket }> {
    const transport = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
    transports.push(transport)
    transport.onMessage((message, reply, ws) => {
      if (message === 'text') {
        reply(CIPHERTEXT_TEXT)
      } else if (message === 'binary') {
        ws.send(Buffer.alloc(96 * 1024), BINARY_CIPHERTEXT_SEND)
      }
    })
    await transport.start()
    const client = new WebSocket(`ws://127.0.0.1:${transport.resolvedPort}`, {
      perMessageDeflate: clientOffersDeflate
    })
    clients.push(client)
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve())
      client.once('error', reject)
    })
    return { client }
  }

  async function roundTrip(client: WebSocket, request: string): Promise<Buffer> {
    const reply = new Promise<Buffer>((resolve) =>
      client.once('message', (data) =>
        resolve(Buffer.isBuffer(data) ? data : Buffer.from(String(data)))
      )
    )
    client.send(request)
    return reply
  }

  it('negotiates with a client that offers it and shrinks base64 ciphertext text frames', async () => {
    const { client } = await connect(true)
    expect(client.extensions).toContain('permessage-deflate')

    const before = wireBytesRead(client)
    const reply = await roundTrip(client, 'text')
    const wire = wireBytesRead(client) - before

    expect(reply.toString()).toBe(CIPHERTEXT_TEXT)
    expect(wire).toBeLessThan(CIPHERTEXT_TEXT.length * 0.8)
  })

  it('stays uncompressed and interoperable with an older client that does not offer it', async () => {
    const { client } = await connect(false)
    expect(client.extensions).toBe('')

    const before = wireBytesRead(client)
    const reply = await roundTrip(client, 'text')
    const wire = wireBytesRead(client) - before

    expect(reply.toString()).toBe(CIPHERTEXT_TEXT)
    expect(wire).toBeGreaterThanOrEqual(CIPHERTEXT_TEXT.length)
  })

  it('never deflates binary ciphertext frames even on a negotiated connection', async () => {
    const { client } = await connect(true)
    await roundTrip(client, 'text')

    const before = wireBytesRead(client)
    // Why zeros: they would compress to almost nothing, so a full-size read proves compress:false.
    const reply = await roundTrip(client, 'binary')
    const wire = wireBytesRead(client) - before

    expect(reply.byteLength).toBe(96 * 1024)
    expect(wire).toBeGreaterThanOrEqual(96 * 1024)
  })
})
