import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_RIPGREP_PLATFORMS, bundledRipgrepBinaryName } from './bundled-ripgrep'
import {
  ORCAD_RIPGREP_ARTIFACTS,
  ORCAD_RIPGREP_LICENSE_ARTIFACTS,
  ORCAD_WEB_CLIENT_MANIFEST_FILENAME,
  orcadArtifactFilenames,
  parseOrcadWebClientManifest,
  serializeOrcadWebClientManifest
} from './orcad-artifacts'

describe('standalone runtime artifacts', () => {
  it('ships search binaries for every SSH host and includes them in the install identity', () => {
    const expected = BUNDLED_RIPGREP_PLATFORMS.map(
      (platform) => `ripgrep/${platform}/${bundledRipgrepBinaryName(platform)}`
    )
    expect(ORCAD_RIPGREP_ARTIFACTS).toEqual(expected)
    expect(orcadArtifactFilenames()).toEqual(expect.arrayContaining(expected))
  })

  it('ships the binary redistribution notices with every install', () => {
    const sourceDir = join(__dirname, '../../resources/licenses/ripgrep')
    expect(ORCAD_RIPGREP_LICENSE_ARTIFACTS.map((path) => path.split('/').at(-1)).sort()).toEqual(
      readdirSync(sourceDir).sort()
    )
    expect(orcadArtifactFilenames()).toEqual(
      expect.arrayContaining([...ORCAD_RIPGREP_LICENSE_ARTIFACTS])
    )
  })
})

describe('web client manifest', () => {
  const index = { path: 'web-index.html', size: 12, sha256: 'a'.repeat(64) }
  const asset = { path: 'assets/web-index-abc.js', size: 3, sha256: 'b'.repeat(64) }

  it('is part of every install identity', () => {
    expect(orcadArtifactFilenames()).toContain(ORCAD_WEB_CLIENT_MANIFEST_FILENAME)
    expect(orcadArtifactFilenames('win32-x64')).toContain(ORCAD_WEB_CLIENT_MANIFEST_FILENAME)
  })

  it('round-trips in a stable order', () => {
    const text = serializeOrcadWebClientManifest([index, asset])
    expect(serializeOrcadWebClientManifest([asset, index])).toBe(text)
    expect(parseOrcadWebClientManifest(text)).toEqual([asset, index])
  })

  it.each(['../escape.js', 'assets/../../x', '/abs.js', 'assets//x.js', 'a\\b.js', '.hidden'])(
    'refuses the unsafe path %s',
    (path) => {
      const text = serializeOrcadWebClientManifest([index, { ...asset, path }])
      expect(() => parseOrcadWebClientManifest(text)).toThrow('invalid file entry')
    }
  )

  it('refuses a bundle without its entry page', () => {
    expect(() => parseOrcadWebClientManifest(serializeOrcadWebClientManifest([asset]))).toThrow(
      'web-index.html'
    )
  })

  it('refuses duplicate entries and malformed digests', () => {
    const duplicate = JSON.stringify({ schemaVersion: 1, files: [index, index] })
    expect(() => parseOrcadWebClientManifest(duplicate)).toThrow('invalid file entry')
    const digest = serializeOrcadWebClientManifest([{ ...index, sha256: 'nope' }])
    expect(() => parseOrcadWebClientManifest(digest)).toThrow('invalid file entry')
  })
})
