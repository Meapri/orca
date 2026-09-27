// Why Node-only (node:zlib): only the desktop main process and the CLI decode compressed frames,
// and only they advertise the capability; browser and mobile clients never receive one.
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { decryptBytes, MAX_E2EE_ENCRYPTED_BASE64_CHARACTERS } from './e2ee-crypto'

/** A client that advertises this decodes host->client text frames compressed before encryption. */
export const E2EE_TEXT_DEFLATE_CAPABILITY = 'e2ee.text-deflate.v1' as const

// Why 0x00: JSON text never starts with NUL, so an uncompressed frame can never be misread.
const COMPRESSED_MARKER = 0x00
const ALGORITHM_DEFLATE_RAW = 0x01
const HEADER_BYTES = 2
// Below this the deflate header and CPU cost more than they save.
export const E2EE_TEXT_COMPRESSION_MIN_BYTES = 1024
// Matches the text plaintext cap in e2ee-crypto; also bounds a hostile inflate.
const MAX_INFLATED_TEXT_BYTES = 4 * 1024 * 1024

export type E2EETextReplyOptions = {
  /** Set only for payloads with no secret beside attacker-influenced text (see the policy). */
  compressible?: boolean
}

export type E2EETextReply = (response: string, options?: E2EETextReplyOptions) => void

/**
 * Compresses one frame in its own deflate context — nothing is shared across frames, so one
 * frame's length can never depend on another frame's content. Null when it would not shrink.
 */
export function compressE2EETextPayload(plaintext: string): Uint8Array | null {
  const raw = Buffer.from(plaintext, 'utf8')
  if (raw.byteLength < E2EE_TEXT_COMPRESSION_MIN_BYTES) {
    return null
  }
  const deflated = deflateRawSync(raw)
  if (deflated.byteLength + HEADER_BYTES >= raw.byteLength) {
    return null
  }
  const framed = new Uint8Array(HEADER_BYTES + deflated.byteLength)
  framed[0] = COMPRESSED_MARKER
  framed[1] = ALGORITHM_DEFLATE_RAW
  framed.set(deflated, HEADER_BYTES)
  return framed
}

export function decodeE2EETextPayload(plaintext: Uint8Array): string | null {
  if (plaintext[0] !== COMPRESSED_MARKER) {
    return new TextDecoder().decode(plaintext)
  }
  if (plaintext[1] !== ALGORITHM_DEFLATE_RAW) {
    return null
  }
  try {
    const inflated = inflateRawSync(plaintext.subarray(HEADER_BYTES), {
      maxOutputLength: MAX_INFLATED_TEXT_BYTES
    })
    return new TextDecoder().decode(inflated)
  } catch {
    return null
  }
}

/** `decrypt` for clients that advertise the capability: reads plain and compressed frames. */
export function decryptE2EEText(encrypted: string, sharedKey: Uint8Array): string | null {
  if (encrypted.length > MAX_E2EE_ENCRYPTED_BASE64_CHARACTERS) {
    return null
  }
  const bundle = Uint8Array.from(Buffer.from(encrypted, 'base64'))
  const plaintext = decryptBytes(bundle, sharedKey)
  return plaintext ? decodeE2EETextPayload(plaintext) : null
}
