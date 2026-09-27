import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORCAD_CLI_BUNDLE_FILENAME } from '../../shared/orcad-artifacts'
import { buildOrcadCliLauncherScript, prepareOrcadCliLauncher } from './orcad-cli-launcher'

let root = ''
let dataRoot = ''
let installRoot = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orcad-cli-launcher-'))
  dataRoot = join(root, 'data')
  installRoot = join(root, 'install')
  mkdirSync(installRoot, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function shipBundle(): void {
  writeFileSync(join(installRoot, ORCAD_CLI_BUNDLE_FILENAME), '// cli')
}

describe('prepareOrcadCliLauncher', () => {
  it.each([
    ['linux', 'orca-ide'],
    ['darwin', 'orca']
  ] as const)('writes the %s launcher under the data root', (platform, launcherName) => {
    shipBundle()
    const resourcesPath = prepareOrcadCliLauncher({
      platform,
      dataRoot,
      installRoot,
      runtimePath: '/opt/orcad/bun-runtime'
    })

    expect(resourcesPath).toBe(join(dataRoot, 'cli'))
    const launcherPath = join(dataRoot, 'cli', 'bin', launcherName)
    expect(readFileSync(launcherPath, 'utf8')).toBe(
      buildOrcadCliLauncherScript({
        runtimePath: '/opt/orcad/bun-runtime',
        cliEntryPath: realpathSync(join(installRoot, ORCAD_CLI_BUNDLE_FILENAME)),
        dataRoot
      })
    )
    expect(statSync(launcherPath).mode & 0o111).not.toBe(0)
  })

  it('repoints an existing launcher at the current install', () => {
    shipBundle()
    const options = { platform: 'linux' as const, dataRoot, installRoot, runtimePath: '/old' }
    prepareOrcadCliLauncher(options)
    prepareOrcadCliLauncher({ ...options, runtimePath: '/new' })

    expect(readFileSync(join(dataRoot, 'cli', 'bin', 'orca-ide'), 'utf8')).toContain("exec '/new'")
  })

  it('offers no launcher without the bundle or on Windows', () => {
    const options = { dataRoot, installRoot, runtimePath: '/runtime' }
    expect(prepareOrcadCliLauncher({ ...options, platform: 'linux' })).toBeNull()
    shipBundle()
    expect(prepareOrcadCliLauncher({ ...options, platform: 'win32' })).toBeNull()
  })
})

describe('buildOrcadCliLauncherScript', () => {
  it('pins the data root so an inherited one cannot retarget the CLI', () => {
    const script = buildOrcadCliLauncherScript({
      runtimePath: "/it's/bun",
      cliEntryPath: '/install/orca-cli.js',
      dataRoot: '/home/orca/.orca'
    })
    expect(script).toContain("export ORCA_USER_DATA_PATH='/home/orca/.orca'\n")
    expect(script).toContain(`exec '/it'"'"'s/bun' '/install/orca-cli.js' "$@"`)
    expect(script).toContain('unset NODE_OPTIONS')
  })
})
