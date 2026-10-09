/**
 * Registers orcad's `orca` launcher in `~/.local/bin` the way `orca serve` registers the
 * desktop's, through the same installer and conflict checks. Best-effort and idempotent.
 */
import { existsSync, lstatSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { CliInstaller } from '../cli/cli-installer'
import { isPathInsideOrEqual } from '../cli/cli-install-path-format'
import { installLinuxBareOrcaDispatcher } from '../cli/linux-bare-orca-dispatcher'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'

/** The root whose `bin/` holds upstream's profile launcher (`<userData>/cli/bin/orca`). */
export function orcadCliResourcesPath(launcherPath: string): string {
  return dirname(dirname(launcherPath))
}

/** Why: the Linux installer links `bin/orca-ide`, but orcad's launcher is `bin/orca`; alias it in place. */
function ensureInstallerLauncherName(platform: NodeJS.Platform, resourcesPath: string): void {
  const expected = getBundledLauncherPath(platform, resourcesPath)
  const launcher = join(resourcesPath, 'bin', 'orca')
  if (!expected || expected === launcher || !existsSync(launcher)) {
    return
  }
  try {
    lstatSync(expected)
  } catch {
    symlinkSync('orca', expected)
  }
}

export type OrcadCliRegistrationResult =
  | { state: 'installed'; commandPath: string | null; pathConfigured: boolean | null }
  | { state: 'skipped'; commandPath: string | null; reason: string }

/**
 * Why stricter than the installer: it reclaims a link to any older Orca launcher, including a
 * desktop app's. orcad must not repoint a desktop user's `orca` at itself, so only a vacant
 * slot or a link into its own launcher directory is ours.
 */
export function isOrcadOwnedCliSlot(status: CliInstallStatus, resourcesPath: string): boolean {
  if (!status.supported) {
    return false
  }
  if (status.state === 'not_installed' || status.state === 'installed') {
    return true
  }
  return (
    status.state === 'stale' &&
    status.currentTarget !== null &&
    isPathInsideOrEqual(join(resourcesPath, 'bin'), status.currentTarget)
  )
}

export async function registerOrcadCli(options: {
  platform: NodeJS.Platform
  dataRoot: string
  resourcesPath: string
  homePath?: string
  /** Test seam — defaults to this process's PATH, which macOS scans for the active `orca`. */
  pathEnv?: string
}): Promise<OrcadCliRegistrationResult> {
  const homePath = options.homePath ?? homedir()
  ensureInstallerLauncherName(options.platform, options.resourcesPath)
  const installer = new CliInstaller({
    platform: options.platform,
    isPackaged: true,
    userDataPath: options.dataRoot,
    resourcesPath: options.resourcesPath,
    homePath,
    ...(options.pathEnv !== undefined ? { processPathEnv: options.pathEnv } : {}),
    // Why ~/.local/bin on macOS too: /usr/local/bin needs elevation a headless host cannot ask for.
    defaultMacCommandPath: join(homePath, '.local', 'bin', 'orca'),
    privilegedRunner: async () => {
      throw new Error('orcad CLI registration must not request administrator privileges')
    }
  })
  const status = await installer.getStatus()
  if (!isOrcadOwnedCliSlot(status, options.resourcesPath)) {
    return {
      state: 'skipped',
      commandPath: status.commandPath,
      reason: status.detail ?? status.state
    }
  }
  const installed = status.state === 'installed' ? status : await installer.install()
  if (options.platform === 'linux') {
    // Why: agent launchers type bare `orca`, but the Linux CLI registers as `orca-ide`.
    await installLinuxBareOrcaDispatcher({ resourcesPath: options.resourcesPath, homePath })
  }
  return {
    state: 'installed',
    commandPath: installed.commandPath,
    pathConfigured: installed.pathConfigured
  }
}
