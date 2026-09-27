// A minimal paired terminal-stream client for the soak harness: the legacy E2EE handshake, one
// `terminal.multiplex` subscription, and a byte count of everything the host sent. It speaks the
// wire directly (not the desktop renderer) so a scenario can measure what a reconnect costs.
import { randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import nacl from 'tweetnacl'
import WebSocket from 'ws'

const FRAME_KIND = 0x74
const FRAME_VERSION = 1
const HEADER_BYTES = 16
export const OPCODE = {
  Output: 1,
  SnapshotStart: 2,
  SnapshotChunk: 3,
  SnapshotEnd: 4,
  Subscribe: 9,
  OutputSpan: 15
}

export function decodePairingUrl(url) {
  const code = new URL(url).searchParams.get('code')
  return JSON.parse(
    Buffer.from(code.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString()
  )
}

function seal(bytes, key) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const box = nacl.box.after(bytes, nonce, key)
  return Buffer.concat([Buffer.from(nonce), Buffer.from(box)])
}

function open(bundle, key) {
  const bytes = new Uint8Array(bundle)
  return nacl.box.open.after(
    bytes.subarray(nacl.box.nonceLength),
    bytes.subarray(0, nacl.box.nonceLength),
    key
  )
}

function encodeFrame(opcode, streamId, payload) {
  const out = Buffer.alloc(HEADER_BYTES + payload.length)
  out.writeUInt8(FRAME_KIND, 0)
  out.writeUInt8(FRAME_VERSION, 1)
  out.writeUInt8(opcode, 2)
  out.writeUInt32LE(streamId, 4)
  Buffer.from(payload).copy(out, HEADER_BYTES)
  return out
}

function decodeFrame(bytes) {
  const buffer = Buffer.from(bytes)
  if (buffer.length < HEADER_BYTES || buffer.readUInt8(0) !== FRAME_KIND) {
    return null
  }
  return {
    opcode: buffer.readUInt8(2),
    streamId: buffer.readUInt32LE(4),
    seq: buffer.readUInt32LE(8) * 0x100000000 + buffer.readUInt32LE(12),
    payload: buffer.subarray(HEADER_BYTES)
  }
}

/**
 * Connect, authenticate and open one multiplexed terminal stream. Resolves once the host has
 * answered the subscribe; `stats` keeps counting until `close()`.
 */
export async function openTerminalStream({
  pairing,
  endpoint,
  terminal,
  resume,
  timeoutMs = 20_000
}) {
  const keys = nacl.box.keyPair()
  const key = nacl.box.before(Buffer.from(pairing.publicKeyB64, 'base64'), keys.secretKey)
  const ws = new WebSocket(endpoint ?? pairing.endpoint)
  const stats = {
    wireBytes: 0,
    snapshotBytes: 0,
    outputBytes: 0,
    frames: 0,
    snapshotEnded: false,
    lastOutputSeq: null,
    lastByteAt: null,
    subscribed: null,
    subscribeSentAt: null
  }
  let state = 'awaiting_ready'
  const requestId = randomUUID()
  const sendText = (value) =>
    ws.send(seal(Buffer.from(JSON.stringify(value)), key).toString('base64'))
  const subscribed = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('terminal stream subscribe timed out')),
      timeoutMs
    )
    ws.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    ws.on('close', () => {
      clearTimeout(timer)
      reject(new Error('socket closed before subscribe'))
    })
    ws.on('message', (data, isBinary) => {
      if (stats.subscribeSentAt !== null) {
        stats.wireBytes += data.length
        stats.lastByteAt = Date.now()
      }
      if (isBinary) {
        const plain = open(data, key)
        const frame = plain && decodeFrame(plain)
        if (!frame) {
          return
        }
        stats.frames += 1
        if (frame.opcode === OPCODE.SnapshotStart) {
          const start = JSON.parse(frame.payload.toString() || '{}')
          if (typeof start.seq === 'number') {
            stats.lastOutputSeq = start.seq
          }
        } else if (frame.opcode === OPCODE.SnapshotChunk) {
          stats.snapshotBytes += frame.payload.length
        } else if (frame.opcode === OPCODE.SnapshotEnd) {
          stats.snapshotEnded = true
        } else if (frame.opcode === OPCODE.Output || frame.opcode === OPCODE.OutputSpan) {
          stats.outputBytes += frame.payload.length
          if (frame.seq > 0) {
            stats.lastOutputSeq = frame.seq
          }
        }
        return
      }
      const text = data.toString()
      if (state === 'awaiting_ready') {
        state = 'awaiting_authenticated'
        sendText({ type: 'e2ee_auth', deviceToken: pairing.deviceToken, clientCapabilities: [] })
        return
      }
      const plain = open(Buffer.from(text, 'base64'), key)
      const message = plain ? JSON.parse(Buffer.from(plain).toString()) : null
      if (state === 'awaiting_authenticated') {
        state = 'ready'
        sendText({
          id: requestId,
          deviceToken: pairing.deviceToken,
          method: 'terminal.multiplex',
          params: {}
        })
        return
      }
      const event = message?.result
      if (event?.type === 'ready') {
        stats.subscribeSentAt = Date.now()
        const payload = {
          streamId: 1,
          terminal,
          client: { id: 'orcad-soak-resume', type: 'desktop' },
          viewport: { cols: 120, rows: 40 },
          capabilities: { outputResume: 1 },
          ...(resume ? { resume } : {})
        }
        ws.send(seal(encodeFrame(OPCODE.Subscribe, 0, Buffer.from(JSON.stringify(payload))), key))
      } else if (event?.type === 'subscribed') {
        stats.subscribed = event
        clearTimeout(timer)
        resolve()
      } else if (message?.ok === false) {
        clearTimeout(timer)
        reject(new Error(`terminal.multiplex failed: ${JSON.stringify(message.error)}`))
      }
    })
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: Buffer.from(keys.publicKey).toString('base64')
        })
      )
    )
  })
  await subscribed
  return {
    stats,
    /** The point a reconnect would present: the host's run token and the last applied seq. */
    resumePoint: () =>
      stats.subscribed?.resumeToken && typeof stats.lastOutputSeq === 'number'
        ? { token: stats.subscribed.resumeToken, seq: stats.lastOutputSeq }
        : null,
    close: () => ws.terminate()
  }
}

function decodeText(plain) {
  // A NUL first byte marks a deflate-raw frame (e2ee.text-deflate.v1); JSON never starts with NUL.
  return plain[0] === 0
    ? inflateRawSync(Buffer.from(plain).subarray(2)).toString()
    : Buffer.from(plain).toString()
}

/**
 * One RPC over a fresh E2EE socket, counting the ciphertext bytes of the reply. The capability
 * list is explicit so a scenario can compare a client that decodes compressed frames with one
 * that predates them.
 */
export async function callRuntimeOnce({ pairing, endpoint, method, params, clientCapabilities }) {
  const keys = nacl.box.keyPair()
  const key = nacl.box.before(Buffer.from(pairing.publicKeyB64, 'base64'), keys.secretKey)
  const ws = new WebSocket(endpoint ?? pairing.endpoint)
  const requestId = randomUUID()
  const sendText = (value) =>
    ws.send(seal(Buffer.from(JSON.stringify(value)), key).toString('base64'))
  let state = 'awaiting_ready'
  try {
    return await new Promise((resolve, reject) => {
      ws.on('error', reject)
      ws.on('close', () => reject(new Error(`socket closed before ${method} answered`)))
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            type: 'e2ee_hello',
            publicKeyB64: Buffer.from(keys.publicKey).toString('base64')
          })
        )
      )
      ws.on('message', (data) => {
        if (state === 'awaiting_ready') {
          state = 'awaiting_authenticated'
          sendText({ type: 'e2ee_auth', deviceToken: pairing.deviceToken, clientCapabilities })
          return
        }
        const plain = open(Buffer.from(data.toString(), 'base64'), key)
        if (!plain) {
          reject(new Error('undecryptable frame'))
          return
        }
        if (state === 'awaiting_authenticated') {
          state = 'ready'
          sendText({ id: requestId, deviceToken: pairing.deviceToken, method, params })
          return
        }
        const text = decodeText(plain)
        const message = JSON.parse(text)
        if (message.id === requestId) {
          resolve({
            ok: message.ok,
            compressed: plain[0] === 0,
            replyWireBytes: data.length,
            replyPlaintextBytes: Buffer.byteLength(text)
          })
        }
      })
    })
  } finally {
    ws.terminate()
  }
}
