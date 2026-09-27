import { join } from 'node:path'

// Why `orca-ide` on Linux: GNOME Orca ships /usr/bin/orca, so the CLI never claims that name.
export const LINUX_CLI_COMMAND_NAME = 'orca-ide'

let hostCliResourcesPath: string | null = null

/** Why: a Node host (orcad) has no Electron resources tree, so it names where its launcher lives. */
export function setHostCliResourcesPath(resourcesPath: string | null): void {
  hostCliResourcesPath = resourcesPath
}

/** The root whose `bin/` holds this host's own CLI launcher, when it ships one. */
export function getCliResourcesPath(): string | undefined {
  return process.resourcesPath ?? hostCliResourcesPath ?? undefined
}

/** Absolute path of the CLI launcher this app ships in its own resources bundle.
 *  Lives apart from cli-installer so callers that only need the path (PTY env
 *  assembly) don't pull in the installer's `electron` dependency. */
export function getBundledLauncherPath(
  platform: NodeJS.Platform,
  resourcesPath: string
): string | null {
  if (platform === 'darwin') {
    return join(resourcesPath, 'bin', 'orca')
  }
  if (platform === 'linux') {
    return join(resourcesPath, 'bin', LINUX_CLI_COMMAND_NAME)
  }
  if (platform === 'win32') {
    return join(resourcesPath, 'bin', 'orca.exe')
  }
  return null
}
