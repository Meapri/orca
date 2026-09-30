import { describe, expect, it } from 'vitest'
import { selectMacBundleSwapAsset } from './mac-bundle-swap-manifest'

const SHA_ARM = `${'a'.repeat(86)}==`
const SHA_X64 = `${'b'.repeat(86)}==`
const RELEASE = 'https://github.com/Meapri/orca/releases/download/v1.4.215'

function manifest(version = '1.4.215', extra = ''): string {
  return [
    `version: ${version}`,
    'files:',
    '  - url: orca-next-macos-x64.zip',
    `    sha512: ${SHA_X64}`,
    '    size: 100',
    '  - url: orca-next-macos-arm64.zip',
    `    sha512: ${SHA_ARM}`,
    '    size: 200',
    '  - url: orca-next-macos-arm64.dmg',
    `    sha512: ${SHA_ARM}`,
    '    size: 300',
    extra,
    'path: orca-next-macos-x64.zip',
    `sha512: ${SHA_X64}`
  ].join('\n')
}

describe('selectMacBundleSwapAsset', () => {
  it('picks the arch zip and resolves it inside its release', () => {
    expect(
      selectMacBundleSwapAsset({
        manifestText: manifest(),
        releaseDownloadUrl: RELEASE,
        expectedVersion: '1.4.215',
        arch: 'arm64'
      })
    ).toEqual({
      version: '1.4.215',
      url: `${RELEASE}/orca-next-macos-arm64.zip`,
      fileName: 'orca-next-macos-arm64.zip',
      sha512: SHA_ARM,
      size: 200
    })
    expect(
      selectMacBundleSwapAsset({
        manifestText: manifest(),
        releaseDownloadUrl: RELEASE,
        expectedVersion: '1.4.215',
        arch: 'x64'
      }).fileName
    ).toBe('orca-next-macos-x64.zip')
  })

  it('refuses a manifest for a different version than the one offered', () => {
    expect(() =>
      selectMacBundleSwapAsset({
        manifestText: manifest('1.4.214'),
        releaseDownloadUrl: RELEASE,
        expectedVersion: '1.4.215',
        arch: 'arm64'
      })
    ).toThrow(/does not match/)
  })

  it('refuses a zip entry without a usable sha512', () => {
    const text = manifest().replace(`    sha512: ${SHA_ARM}\n    size: 200`, '    size: 200')
    expect(() =>
      selectMacBundleSwapAsset({
        manifestText: text,
        releaseDownloadUrl: RELEASE,
        expectedVersion: '1.4.215',
        arch: 'arm64'
      })
    ).toThrow(/sha512/)
  })

  it('refuses a manifest URL that leaves the release', () => {
    const text = manifest().replace(
      'url: orca-next-macos-arm64.zip',
      'url: https://evil.test/orca-next-macos-arm64.zip'
    )
    expect(() =>
      selectMacBundleSwapAsset({
        manifestText: text,
        releaseDownloadUrl: RELEASE,
        expectedVersion: '1.4.215',
        arch: 'arm64'
      })
    ).toThrow(/outside its release/)
  })
})
