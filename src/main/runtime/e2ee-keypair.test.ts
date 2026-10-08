import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'
import { loadOrCreateE2EEKeypair } from './e2ee-keypair'
import { E2EE_KEYPAIR_FILENAME } from './mobile-pairing-files'

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

describe('loadOrCreateE2EEKeypair', () => {
  it('advertises the public key derived from the stored secret when the halves disagree', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-e2ee-keypair-'))
    const real = nacl.box.keyPair()
    const unrelated = nacl.box.keyPair()
    const filePath = join(userDataPath, E2EE_KEYPAIR_FILENAME)
    writeFileSync(
      filePath,
      JSON.stringify({
        v: 1,
        publicKeyB64: b64(unrelated.publicKey),
        secretKeyB64: b64(real.secretKey)
      })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const loaded = loadOrCreateE2EEKeypair(userDataPath)

    expect(loaded.publicKeyB64).toBe(b64(real.publicKey))
    expect(b64(loaded.secretKey)).toBe(b64(real.secretKey))
    // Why: the secret is kept, so every device already paired against it stays valid.
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      v: 1,
      publicKeyB64: b64(real.publicKey),
      secretKeyB64: b64(real.secretKey)
    })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('leaves a consistent keypair file untouched', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-e2ee-keypair-'))
    const real = nacl.box.keyPair()
    const filePath = join(userDataPath, E2EE_KEYPAIR_FILENAME)
    const contents = JSON.stringify({
      v: 1,
      publicKeyB64: b64(real.publicKey),
      secretKeyB64: b64(real.secretKey)
    })
    writeFileSync(filePath, contents)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const loaded = loadOrCreateE2EEKeypair(userDataPath)

    expect(loaded.publicKeyB64).toBe(b64(real.publicKey))
    expect(readFileSync(filePath, 'utf8')).toBe(contents)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
