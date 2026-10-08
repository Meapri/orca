import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decrypt, deriveSharedKey, encrypt, encryptBytes, generateKeyPair } from './e2ee-crypto'
import {
  compressE2EETextPayload,
  decodeE2EETextPayload,
  decryptE2EEText,
  E2EE_TEXT_COMPRESSION_MIN_BYTES
} from './e2ee-text-compression'

function sharedKey(): Uint8Array {
  const client = generateKeyPair()
  const server = generateKeyPair()
  return deriveSharedKey(client.secretKey, server.publicKey)
}

const listing = JSON.stringify({
  id: 'req-1',
  ok: true,
  result: {
    files: Array.from(
      { length: 400 },
      (_, index) => `src/renderer/src/components/file-${index}.tsx`
    )
  }
})

describe('E2EE text compression', () => {
  it('round-trips a large JSON reply and shrinks it', () => {
    const compressed = compressE2EETextPayload(listing)
    expect(compressed).not.toBeNull()
    expect(compressed!.byteLength).toBeLessThan(Buffer.byteLength(listing) / 4)
    expect(decodeE2EETextPayload(compressed!)).toBe(listing)
  })

  it('leaves replies below the threshold alone', () => {
    const small = JSON.stringify({
      id: '1',
      ok: true,
      pad: 'x'.repeat(E2EE_TEXT_COMPRESSION_MIN_BYTES - 64)
    })
    expect(compressE2EETextPayload(small)).toBeNull()
  })

  it('reads an uncompressed frame exactly as legacy decrypt does', () => {
    const key = sharedKey()
    const frame = encrypt(listing, key)
    expect(decryptE2EEText(frame, key)).toBe(decrypt(frame, key))
  })

  it('decrypts a compressed frame that a legacy decoder could not parse as JSON', () => {
    const key = sharedKey()
    const frame = Buffer.from(encryptBytes(compressE2EETextPayload(listing)!, key)).toString(
      'base64'
    )
    expect(decryptE2EEText(frame, key)).toBe(listing)
    // Why this matters: only clients that advertised the capability may ever be sent one.
    expect(() => JSON.parse(decrypt(frame, key) ?? '')).toThrow()
  })

  it('refuses an unknown algorithm and an inflate past the text plaintext cap', () => {
    expect(decodeE2EETextPayload(Uint8Array.from([0, 9, 1, 2, 3]))).toBeNull()
    const bomb = deflateRawSync(Buffer.alloc(5 * 1024 * 1024, 0x20))
    const framed = new Uint8Array(2 + bomb.byteLength)
    framed[0] = 0
    framed[1] = 1
    framed.set(bomb, 2)
    expect(decodeE2EETextPayload(framed)).toBeNull()
  })
})
