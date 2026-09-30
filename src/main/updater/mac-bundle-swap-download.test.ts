import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadMacBundleSwapAsset, type MacBundleSwapFetch } from './mac-bundle-swap-download'

const PAYLOAD = Buffer.from('orca-next update payload '.repeat(4096))
const PAYLOAD_SHA512 = createHash('sha512').update(PAYLOAD).digest('base64')

function fetchReturning(body: Buffer): MacBundleSwapFetch {
  return vi.fn(async () => new Response(new Uint8Array(body), { status: 200 }))
}

describe('downloadMacBundleSwapAsset', () => {
  let tempRoot: string | null = null

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
      tempRoot = null
    }
  })

  function asset(sha512 = PAYLOAD_SHA512, size: number | null = PAYLOAD.length) {
    return {
      version: '1.4.215',
      url: 'https://github.com/Meapri/orca/releases/download/v1.4.215/orca-next-macos-arm64.zip',
      fileName: 'orca-next-macos-arm64.zip',
      sha512,
      size
    }
  }

  it('keeps the zip only when its sha512 matches the release manifest', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'orca-swap-download-'))
    const progress: number[] = []
    const zipPath = await downloadMacBundleSwapAsset({
      asset: asset(),
      destinationDir: tempRoot,
      request: fetchReturning(PAYLOAD),
      onProgress: (fraction) => progress.push(fraction)
    })
    expect(readFileSync(zipPath).equals(PAYLOAD)).toBe(true)
    expect(progress.at(-1)).toBe(1)
  })

  it('deletes a download whose checksum does not match', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'orca-swap-download-'))
    const tampered = Buffer.concat([PAYLOAD.subarray(1), Buffer.from('x')])
    await expect(
      downloadMacBundleSwapAsset({
        asset: asset(),
        destinationDir: tempRoot,
        request: fetchReturning(tampered)
      })
    ).rejects.toThrow(/checksum/)
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('rejects a truncated download before hashing matters', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'orca-swap-download-'))
    await expect(
      downloadMacBundleSwapAsset({
        asset: asset(PAYLOAD_SHA512, PAYLOAD.length + 1),
        destinationDir: tempRoot,
        request: fetchReturning(PAYLOAD)
      })
    ).rejects.toThrow(/size/)
    expect(existsSync(join(tempRoot, 'orca-next-macos-arm64.zip'))).toBe(false)
  })

  it('surfaces HTTP failures', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'orca-swap-download-'))
    await expect(
      downloadMacBundleSwapAsset({
        asset: asset(),
        destinationDir: tempRoot,
        request: vi.fn(async () => new Response(null, { status: 404 }))
      })
    ).rejects.toThrow(/HTTP 404/)
  })
})
