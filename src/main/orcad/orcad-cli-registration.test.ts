import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import {
  isOrcadOwnedCliSlot,
  orcadCliResourcesPath,
  registerOrcadCli
} from './orcad-cli-registration'

let root = ''
let homePath = ''
let dataRoot = ''
let resourcesPath = ''

// Mirrors prepareOrcadCliLauncher's output: `<userData>/cli/bin/orca` on every Unix platform.
function prepare(_platform: NodeJS.Platform): void {
  const launcherPath = join(dataRoot, 'cli', 'bin', 'orca')
  mkdirSync(join(dataRoot, 'cli', 'bin'), { recursive: true })
  writeFileSync(launcherPath, '#!/usr/bin/env sh\n', { mode: 0o700 })
  resourcesPath = orcadCliResourcesPath(launcherPath)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orcad-cli-registration-'))
  homePath = join(root, 'home')
  dataRoot = join(root, 'data')
  mkdirSync(homePath, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('registerOrcadCli', () => {
  it('links orca-ide and a bare orca dispatcher into ~/.local/bin on Linux, idempotently', async () => {
    prepare('linux')
    const options = {
      platform: 'linux' as const,
      dataRoot,
      resourcesPath,
      homePath,
      pathEnv: join(homePath, '.local', 'bin')
    }

    const first = await registerOrcadCli(options)
    const second = await registerOrcadCli(options)

    const commandPath = join(homePath, '.local', 'bin', 'orca-ide')
    expect(first).toMatchObject({ state: 'installed', commandPath })
    expect(second).toMatchObject({ state: 'installed', commandPath })
    expect(readlinkSync(commandPath)).toBe(join(resourcesPath, 'bin', 'orca-ide'))
    expect(readFileSync(join(homePath, '.local', 'bin', 'orca'), 'utf8')).toContain(
      join(resourcesPath, 'bin', 'orca-ide')
    )
  })

  it('links ~/.local/bin/orca on macOS without asking for elevation', async () => {
    prepare('darwin')
    const result = await registerOrcadCli({
      platform: 'darwin',
      dataRoot,
      resourcesPath,
      homePath,
      pathEnv: join(homePath, '.local', 'bin')
    })

    expect(result.state).toBe('installed')
    expect(readlinkSync(join(homePath, '.local', 'bin', 'orca'))).toBe(
      join(resourcesPath, 'bin', 'orca')
    )
  })

  it('never replaces an unrelated command', async () => {
    prepare('linux')
    const commandPath = join(homePath, '.local', 'bin', 'orca-ide')
    mkdirSync(join(homePath, '.local', 'bin'), { recursive: true })
    writeFileSync(commandPath, '#!/bin/sh\necho mine\n')

    const result = await registerOrcadCli({
      platform: 'linux',
      dataRoot,
      resourcesPath,
      homePath,
      pathEnv: join(homePath, '.local', 'bin')
    })

    expect(result.state).toBe('skipped')
    expect(lstatSync(commandPath).isSymbolicLink()).toBe(false)
    expect(readFileSync(commandPath, 'utf8')).toContain('echo mine')
  })

  it("leaves a desktop app's registration pointing at the desktop app", async () => {
    prepare('darwin')
    const commandPath = join(homePath, '.local', 'bin', 'orca')
    const desktopLauncher = join(root, 'Orca.app', 'Contents', 'Resources', 'bin', 'orca')
    mkdirSync(join(root, 'Orca.app', 'Contents', 'Resources', 'bin'), { recursive: true })
    writeFileSync(desktopLauncher, '#!/bin/sh\n', { mode: 0o755 })
    mkdirSync(join(homePath, '.local', 'bin'), { recursive: true })
    symlinkSync(desktopLauncher, commandPath)

    const result = await registerOrcadCli({
      platform: 'darwin',
      dataRoot,
      resourcesPath,
      homePath,
      pathEnv: join(homePath, '.local', 'bin')
    })

    expect(result.state).toBe('skipped')
    expect(readlinkSync(commandPath)).toBe(desktopLauncher)
  })
})

describe('isOrcadOwnedCliSlot', () => {
  const base: CliInstallStatus = {
    platform: 'linux',
    commandName: 'orca-ide',
    commandPath: '/home/u/.local/bin/orca-ide',
    pathDirectory: '/home/u/.local/bin',
    pathConfigured: true,
    launcherPath: '/data/cli/bin/orca-ide',
    installMethod: 'symlink',
    supported: true,
    state: 'not_installed',
    currentTarget: null,
    unsupportedReason: null,
    detail: null
  }

  it('claims only vacant slots and links into its own launcher directory', () => {
    expect(isOrcadOwnedCliSlot(base, '/data/cli')).toBe(true)
    expect(isOrcadOwnedCliSlot({ ...base, state: 'installed' }, '/data/cli')).toBe(true)
    expect(
      isOrcadOwnedCliSlot(
        { ...base, state: 'stale', currentTarget: '/data/cli/bin/orca-ide' },
        '/data/cli'
      )
    ).toBe(true)
    expect(
      isOrcadOwnedCliSlot(
        { ...base, state: 'stale', currentTarget: '/opt/Orca/resources/bin/orca-ide' },
        '/data/cli'
      )
    ).toBe(false)
    expect(isOrcadOwnedCliSlot({ ...base, state: 'conflict' }, '/data/cli')).toBe(false)
    expect(isOrcadOwnedCliSlot({ ...base, supported: false }, '/data/cli')).toBe(false)
  })
})
