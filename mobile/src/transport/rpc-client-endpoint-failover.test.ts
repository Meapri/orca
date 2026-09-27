// Real sockets and real E2EE: a paired host reachable at an alternate address while its primary
// refuses connections. The direct client must walk to the alternate and report it as the one
// that answered, and a single-endpoint pairing (an old host's offer) must behave as before.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createServer, type AddressInfo } from 'node:net'
import nacl from 'tweetnacl'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { connect, type RpcClient } from './rpc-client'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => new Uint8Array(randomBytes(n))
}))

const AUTH_TOKEN = 'failover-device-token'
const serverKeyPair = nacl.box.keyPair()
const serverPublicKeyB64 = Buffer.from(serverKeyPair.publicKey).toString('base64')

function seal(plaintext: string, sharedKey: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box.after(new TextEncoder().encode(plaintext), nonce, sharedKey)
  const bundle = new Uint8Array(nonce.length + ciphertext.length)
  bundle.set(nonce)
  bundle.set(ciphertext, nonce.length)
  return Buffer.from(bundle).toString('base64')
}

function open(encrypted: string, sharedKey: Uint8Array): string | null {
  const bundle = Uint8Array.from(Buffer.from(encrypted, 'base64'))
  const nonce = bundle.slice(0, nacl.box.nonceLength)
  const plaintext = nacl.box.open.after(bundle.slice(nacl.box.nonceLength), nonce, sharedKey)
  return plaintext ? new TextDecoder().decode(plaintext) : null
}

function startHost(): Promise<WebSocketServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  wss.on('connection', (ws: ServerSocket) => {
    let sharedKey: Uint8Array | null = null
    let authenticated = false
    ws.on('message', (data) => {
      const message = data.toString('utf-8')
      if (!sharedKey) {
        const hello: { publicKeyB64: string } = JSON.parse(message)
        sharedKey = nacl.box.before(
          Uint8Array.from(Buffer.from(hello.publicKeyB64, 'base64')),
          serverKeyPair.secretKey
        )
        ws.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }
      const plaintext = open(message, sharedKey)
      if (!plaintext) {
        return
      }
      const request: { id?: string; type?: string; deviceToken?: string } = JSON.parse(plaintext)
      if (!authenticated) {
        if (request.type === 'e2ee_auth' && request.deviceToken === AUTH_TOKEN) {
          authenticated = true
          ws.send(seal(JSON.stringify({ type: 'e2ee_authenticated' }), sharedKey))
        }
        return
      }
      ws.send(seal(JSON.stringify({ id: request.id, ok: true, result: { up: true } }), sharedKey))
    })
  })
  return new Promise((resolve) => wss.once('listening', () => resolve(wss)))
}

function portOf(address: AddressInfo | string | null): number {
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP address')
  }
  return address.port
}

/** A loopback port nothing listens on, so a dial is refused at once. */
async function refusedEndpoint(): Promise<string> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = portOf(probe.address())
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return `ws://127.0.0.1:${port}`
}

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('direct client endpoint failover', () => {
  const clients: RpcClient[] = []
  const hosts: WebSocketServer[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close()
    }
    await Promise.all(
      hosts.splice(0).map(
        (wss) =>
          new Promise<void>((resolve) => {
            for (const socket of wss.clients) {
              socket.terminate()
            }
            wss.close(() => resolve())
          })
      )
    )
  })

  it('dials the next paired address after the primary goes unanswered and reports it', async () => {
    const host = await startHost()
    hosts.push(host)
    const alternate = `ws://127.0.0.1:${portOf(host.address())}`
    const primary = await refusedEndpoint()
    const connected: string[] = []

    const client = connect(primary, AUTH_TOKEN, serverPublicKeyB64, {
      alternateEndpoints: [alternate],
      onEndpointConnected: (endpoint) => connected.push(endpoint)
    })
    clients.push(client)

    await waitFor(() => client.getState() === 'connected')
    expect(connected).toEqual([alternate])
    const reply = await client.sendRequest('status.get')
    expect(reply.ok).toBe(true)
  })

  it('keeps a single-endpoint pairing on its one address (an older host offers no alternates)', async () => {
    const host = await startHost()
    hosts.push(host)
    const endpoint = `ws://127.0.0.1:${portOf(host.address())}`
    const connected: string[] = []

    const client = connect(endpoint, AUTH_TOKEN, serverPublicKeyB64, {
      onEndpointConnected: (answered) => connected.push(answered)
    })
    clients.push(client)

    await waitFor(() => client.getState() === 'connected')
    expect(connected).toEqual([endpoint])
  })
})
