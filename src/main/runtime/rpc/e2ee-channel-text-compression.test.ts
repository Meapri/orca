import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { E2EEChannel } from './e2ee-channel'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from './e2ee-crypto'
import {
  decryptE2EEText,
  E2EE_TEXT_DEFLATE_CAPABILITY,
  type E2EETextReplyOptions
} from '../../../shared/e2ee-text-compression'

const LISTING = JSON.stringify({
  id: 'req-1',
  ok: true,
  result: { worktrees: Array.from({ length: 200 }, (_, i) => ({ path: `/srv/repo/wt-${i}` })) }
})

function connect(clientCapabilities: string[], replyOptions: E2EETextReplyOptions | undefined) {
  const serverKeys = generateKeyPair()
  const clientKeys = generateKeyPair()
  const sent: string[] = []
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the channel only calls send/close/readyState/OPEN on it.
  const channel = new E2EEChannel(ws as unknown as WebSocket, {
    serverSecretKey: serverKeys.secretKey,
    resolveAuthenticatedDevice: (token) =>
      token === 'valid-token'
        ? { deviceId: 'device-1', deviceToken: token, scope: 'runtime' }
        : null,
    onReady: () => {},
    onError: () => {}
  })
  channel.onMessage((_plaintext, reply) => reply(LISTING, replyOptions))
  const sharedKey = deriveSharedKey(clientKeys.secretKey, serverKeys.publicKey)
  channel.handleRawMessage(
    JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: Buffer.from(clientKeys.publicKey).toString('base64')
    })
  )
  channel.handleRawMessage(
    encrypt(
      JSON.stringify({ type: 'e2ee_auth', deviceToken: 'valid-token', clientCapabilities }),
      sharedKey
    )
  )
  channel.handleRawMessage(
    encrypt(JSON.stringify({ id: 'req-1', method: 'worktree.list' }), sharedKey)
  )
  return { lastFrame: () => sent.at(-1)!, sharedKey, channel }
}

describe('E2EEChannel compress-before-encrypt', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('deflates an opted-in reply for a client that advertised decoding it', () => {
    const { lastFrame, sharedKey, channel } = connect([E2EE_TEXT_DEFLATE_CAPABILITY], {
      compressible: true
    })
    expect(decryptE2EEText(lastFrame(), sharedKey)).toBe(LISTING)
    expect(decrypt(lastFrame(), sharedKey)).not.toBe(LISTING)
    expect(lastFrame().length).toBeLessThan(encrypt(LISTING, sharedKey).length / 3)
    channel.destroy()
  })

  it('never compresses for a client that did not advertise the capability', () => {
    const { lastFrame, sharedKey, channel } = connect([], { compressible: true })
    expect(decrypt(lastFrame(), sharedKey)).toBe(LISTING)
    channel.destroy()
  })

  it('never compresses a reply the dispatcher did not mark compressible', () => {
    const { lastFrame, sharedKey, channel } = connect([E2EE_TEXT_DEFLATE_CAPABILITY], undefined)
    expect(decrypt(lastFrame(), sharedKey)).toBe(LISTING)
    channel.destroy()
  })
})
