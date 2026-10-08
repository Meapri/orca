import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { WebRuntimeClient } from './web-runtime-client'
import { reviveWebRuntimeConnectionsNow } from './web-runtime-resume-signals'
import { parseWebPairingInput } from './web-pairing'
import {
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from '../../../shared/e2ee-crypto'

const fakeSockets: FakeWebSocket[] = []
const windowListeners = new Map<string, (event: { persisted?: boolean }) => void>()

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = FakeWebSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED
  })
  send = vi.fn()
  constructor(readonly url: string) {
    fakeSockets.push(this)
  }

  refuse(): void {
    this.onerror?.()
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
}

const serverKeys = generateKeyPair()

const pairing = {
  v: 2 as const,
  endpoint: 'ws://203.0.113.10:6768',
  deviceToken: 'token',
  publicKeyB64: publicKeyToBase64(serverKeys.publicKey),
  alternateEndpoints: ['ws://100.64.0.5:6768']
}

/** Plays the host side of the E2EE handshake over a fake socket until the client is connected. */
async function completeHandshake(socket: FakeWebSocket): Promise<void> {
  socket.readyState = FakeWebSocket.OPEN
  socket.onopen?.()
  const hello: { publicKeyB64: string } = JSON.parse(String(socket.send.mock.calls[0]?.[0]))
  const key = deriveSharedKey(serverKeys.secretKey, publicKeyFromBase64(hello.publicKeyB64))
  socket.onmessage?.({ data: JSON.stringify({ type: 'e2ee_ready' }) })
  await vi.advanceTimersByTimeAsync(0)
  socket.onmessage?.({ data: encrypt(JSON.stringify({ type: 'e2ee_authenticated' }), key) })
  await vi.advanceTimersByTimeAsync(0)
}

function encodeOffer(offer: Record<string, unknown>): string {
  return `orca://pair?code=${Buffer.from(JSON.stringify(offer)).toString('base64url')}`
}

describe('web runtime endpoint failover', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fakeSockets.length = 0
    // Why not cleared: the signals install once per realm, like a real page.
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      addEventListener: (name: string, listener: (event: { persisted?: boolean }) => void) =>
        windowListeners.set(name, listener),
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('decodes alternates from a newer host and ignores them when an older host omits the field', () => {
    const withAlternates = parseWebPairingInput(
      encodeOffer({
        ...pairing,
        alternateEndpoints: ['http://100.64.0.5:6768', 42, pairing.endpoint]
      })
    )
    expect(withAlternates?.alternateEndpoints).toEqual(['ws://100.64.0.5:6768'])
    const { alternateEndpoints: _omitted, ...legacy } = pairing
    expect(parseWebPairingInput(encodeOffer(legacy))).not.toHaveProperty('alternateEndpoints')
  })

  it('dials the alternate at once when the primary refuses, and reports the one that answered', async () => {
    const connected: string[] = []
    const client = new WebRuntimeClient(pairing, {
      onEndpointConnected: (endpoint) => connected.push(endpoint)
    })
    expect(fakeSockets.map((socket) => socket.url)).toEqual([pairing.endpoint])

    fakeSockets[0]!.refuse()
    expect(fakeSockets.map((socket) => socket.url)).toEqual([
      pairing.endpoint,
      'ws://100.64.0.5:6768'
    ])

    await completeHandshake(fakeSockets[1]!)
    expect(connected).toEqual(['ws://100.64.0.5:6768'])
    // Why: a child subscription client must start at the address that answered, not the dead primary.
    const child = client.subscribe('terminal.subscribe', {}, { onResponse: () => {} })
    expect(fakeSockets.at(-1)?.url).toBe('ws://100.64.0.5:6768')
    client.close()
    await expect(child).rejects.toThrow()
  })

  it('backs off once every paired address went unanswered in a pass', () => {
    const client = new WebRuntimeClient(pairing)
    fakeSockets[0]!.refuse()
    fakeSockets[1]!.refuse()
    expect(fakeSockets).toHaveLength(2)
    vi.advanceTimersByTime(1_000)
    expect(fakeSockets).toHaveLength(3)
    expect(fakeSockets[2]!.url).toBe(pairing.endpoint)
    client.close()
  })

  it('keeps a single-endpoint pairing on its backoff ladder (older host)', () => {
    const { alternateEndpoints: _omitted, ...legacy } = pairing
    const client = new WebRuntimeClient(legacy)
    fakeSockets[0]!.refuse()
    expect(fakeSockets).toHaveLength(1)
    vi.advanceTimersByTime(1_000)
    expect(fakeSockets.map((socket) => socket.url)).toEqual([legacy.endpoint, legacy.endpoint])
    client.close()
  })

  it('skips the remaining backoff when the page resumes', () => {
    const { alternateEndpoints: _omitted, ...legacy } = pairing
    const client = new WebRuntimeClient(legacy)
    fakeSockets[0]!.refuse()
    expect(fakeSockets).toHaveLength(1)
    windowListeners.get('online')?.({})
    expect(fakeSockets).toHaveLength(2)
    client.close()
  })

  it('declares a connected socket dead when a resume probe goes unanswered', async () => {
    const { alternateEndpoints: _omitted, ...legacy } = pairing
    const client = new WebRuntimeClient(legacy)
    const socket = fakeSockets[0]!
    await completeHandshake(socket)
    const sentBeforeProbe = socket.send.mock.calls.length

    expect(reviveWebRuntimeConnectionsNow()).toBeGreaterThanOrEqual(1)
    expect(socket.send).toHaveBeenCalledTimes(sentBeforeProbe + 1)
    vi.advanceTimersByTime(7_999)
    expect(socket.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(socket.close).toHaveBeenCalledTimes(1)
    client.close()
  })
})
