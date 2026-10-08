import { constants as zlibConstants } from 'node:zlib'
import type { PerMessageDeflateOptions } from 'ws'

// Why: every runtime frame is E2EE ciphertext, so deflate cannot find repeats; what it can
// recover is base64's 2 spare bits per character on text frames (~25%, measured 0.753 ratio).
// Huffman-only captures exactly that at about half the CPU of level 1, and without context
// takeover each connection keeps no sliding window — ciphertext has nothing to reference.
// The extension is negotiated per RFC 7692, so a peer that does not offer it is unaffected.
const TEXT_FRAME_COMPRESSION_THRESHOLD_BYTES = 1024

export function remoteRuntimePerMessageDeflateOptions(): PerMessageDeflateOptions {
  return {
    threshold: TEXT_FRAME_COMPRESSION_THRESHOLD_BYTES,
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    zlibDeflateOptions: { strategy: zlibConstants.Z_HUFFMAN_ONLY },
    // Why: bounds concurrent zlib jobs so a burst of large replies cannot pin the threadpool.
    concurrencyLimit: 4
  }
}

// Why: binary frames are raw ciphertext bytes with full entropy; deflating them only costs CPU.
export const BINARY_CIPHERTEXT_SEND = { binary: true, compress: false } as const
