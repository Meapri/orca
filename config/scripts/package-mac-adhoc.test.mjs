import { describe, expect, it } from 'vitest'
import { createAdhocSigningEnv, parsePackageMacAdhocArgs } from './package-mac-adhoc.mjs'

describe('package-mac-adhoc', () => {
  it('defaults to the host arch and package version, and validates overrides', () => {
    expect(parsePackageMacAdhocArgs([], { arch: 'arm64', version: '1.4.214' })).toEqual({
      arch: 'arm64',
      version: '1.4.214'
    })
    expect(
      parsePackageMacAdhocArgs(['--arch', 'x64', '--version', '1.4.215-next.1'], {
        arch: 'arm64',
        version: '1.4.214'
      })
    ).toEqual({ arch: 'x64', version: '1.4.215-next.1' })
    expect(() =>
      parsePackageMacAdhocArgs(['--version', 'v1.4.215'], { arch: 'arm64', version: '1.4.214' })
    ).toThrow(/semver/)
    expect(() =>
      parsePackageMacAdhocArgs(['--arch', 'universal'], { arch: 'arm64', version: '1.4.214' })
    ).toThrow(/arch/)
  })

  it('forces ad-hoc identities and stamps the release version', () => {
    const env = createAdhocSigningEnv(
      { PATH: '/usr/bin' },
      { version: '1.4.215', commit: 'abc', arch: 'arm64' }
    )
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CSC_NAME: '-',
      ORCA_COMPUTER_MACOS_SIGN_IDENTITY: '-',
      ORCA_LOCAL_BUILD_VERSION: '1.4.215',
      ORCA_BUILD_COMMIT: 'abc',
      ORCA_MAC_ARCHS: 'arm64'
    })
  })

  it('refuses env that would switch electron-builder to Developer ID release signing', () => {
    expect(() =>
      createAdhocSigningEnv(
        { ORCA_MAC_RELEASE: '1' },
        { version: '1.4.215', commit: 'abc', arch: 'arm64' }
      )
    ).toThrow(/ORCA_MAC_RELEASE/)
  })
})
