import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getCliLaunchArgs } from './cli-launch-redirect'
import { argvRequestsServeMode, normalizeServeModeArgv } from './serve-mode-argv'

const cliEntryPath = posix.join(
  '/opt/Orca/resources',
  'app.asar.unpacked',
  'out',
  'cli',
  'index.js'
)
const linuxOptions = {
  platform: 'linux' as const,
  isPackaged: true,
  commandNames: ['serve', 'status']
}

describe('serve administration subcommands', () => {
  it.each([
    ['/AppRun', 'serve', 'devices', 'list'],
    ['/AppRun', 'serve', 'pairing', 'new', '--mobile'],
    ['/AppRun', '--no-sandbox', 'serve', '--json', 'devices', 'revoke', 'd1'],
    ['/AppRun', 'serve', 'status', '--json'],
    ['/AppRun', 'serve', '--data-root', '/srv/orcad', 'doctor'],
    ['/AppRun', 'serve', 'pairing', '--rotate'],
    ['/AppRun', 'serve', 'pairing', 'show'],
    ['/AppRun', 'serve', 'relay', 'status'],
    ['/AppRun', 'serve', 'relay', 'sign-in', '--json']
  ])('never starts a server for %j', (...argv) => {
    expect(argvRequestsServeMode(argv)).toBe(false)
    expect(normalizeServeModeArgv(argv)).toEqual(argv)
  })

  it('still launches a server when the admin word is only an option value', () => {
    expect(argvRequestsServeMode(['/AppRun', 'serve', '--pairing-address', 'devices'])).toBe(true)
    expect(argvRequestsServeMode(['/AppRun', 'serve', '--port', '6768'])).toBe(true)
  })

  it('hands the admin subcommands to the CLI on a direct AppImage launch', () => {
    expect(
      getCliLaunchArgs(
        ['/opt/Orca/orca-ide', '--no-sandbox', 'serve', 'devices', 'list', '--json'],
        cliEntryPath,
        linuxOptions
      )
    ).toEqual(['serve', 'devices', 'list', '--json'])
    expect(
      getCliLaunchArgs(['/opt/Orca/orca-ide', 'serve', 'status'], cliEntryPath, linuxOptions)
    ).toEqual(['serve', 'status'])
    expect(
      getCliLaunchArgs(
        ['/opt/Orca/orca-ide', 'serve', '--port', '6768'],
        cliEntryPath,
        linuxOptions
      )
    ).toBeNull()
  })
})
