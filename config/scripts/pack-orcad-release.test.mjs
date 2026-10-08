import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCAD_CLI_BUNDLE_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  orcadArtifactFilenames
} from '../../src/shared/orcad-artifacts.ts'
import {
  assertReleasableBundle,
  orcadReleaseTarballName,
  sha256Line
} from './pack-orcad-release.mjs'

const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function bundle(target, { omit } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pack-orcad-'))
  dirs.push(dir)
  for (const name of [...orcadArtifactFilenames(target), ORCAD_CLI_BUNDLE_FILENAME]) {
    if (name !== omit) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      writeFileSync(join(dir, name), name)
    }
  }
  writeFileSync(join(dir, ORCAD_SERVER_TARGET_FILENAME), `${target}\n`)
  writeFileSync(join(dir, '.version'), '0.1.0+abc123')
  return dir
}

describe('pack-orcad-release', () => {
  it('names tarballs by content-hashed version and target', () => {
    expect(orcadReleaseTarballName('0.1.0+abc123', 'linux-x64-glibc')).toBe(
      'orcad-0.1.0+abc123-linux-x64-glibc.tar.gz'
    )
    expect(() => orcadReleaseTarballName('0.1.0', 'linux-x64-glibc')).toThrow(/content-hashed/)
    expect(() => orcadReleaseTarballName('0.1.0+abc', '../etc')).toThrow(/build target/)
  })

  it('writes checksums in sha256sum -c format', () => {
    expect(sha256Line('ab'.repeat(32), 'x.tar.gz')).toBe(`${'ab'.repeat(32)}  x.tar.gz\n`)
  })

  it('accepts a complete bundle and refuses a torn or mistargeted one', () => {
    expect(assertReleasableBundle(bundle('linux-x64-glibc'), 'linux-x64-glibc')).toEqual({
      version: '0.1.0+abc123',
      target: 'linux-x64-glibc'
    })
    expect(() =>
      assertReleasableBundle(bundle('linux-x64-glibc', { omit: 'daemon-entry.js' }))
    ).toThrow(/daemon-entry\.js/)
    // Release-only: SSH slots never carry it, but a release must.
    expect(() =>
      assertReleasableBundle(bundle('linux-x64-glibc', { omit: ORCAD_CLI_BUNDLE_FILENAME }))
    ).toThrow(/orca-cli\.js/)
    expect(() => assertReleasableBundle(bundle('linux-arm64-glibc'), 'linux-x64-glibc')).toThrow(
      /built for linux-arm64-glibc/
    )
    expect(() => assertReleasableBundle(bundle('win32-x64'))).toThrow(/POSIX-only/)
  })
})
