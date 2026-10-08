/**
 * Registers orcad's `orca` launcher in `~/.local/bin` the way `orca serve` registers the
 * desktop's, through the same installer and conflict checks. Best-effort and idempotent.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { CliInstaller } from '../cli/cli-installer'
import { isPathInsideOrEqual } from '../cli/cli-install-path-format'
import { installLinuxBareOrcaDispatcher } from '../cli/linux-bare-orca-dispatcher'

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
