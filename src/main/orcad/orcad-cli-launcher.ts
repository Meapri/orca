/**
 * The `orca` launcher orcad writes under its data root, so agents in its PTYs, the host
 * installer's census and the service user all reach this runtime's CLI. The data root is a
 * stable path across upgrades, so `~/.local/bin` symlinks survive a new install directory.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { ORCAD_CLI_BUNDLE_FILENAME } from '../../shared/orcad-artifacts'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'
import { DEV_LAUNCHER_DIR } from '../cli/cli-install-constants'
import { quoteShell } from '../cli/cli-install-path-format'

/** Why `DEV_LAUNCHER_DIR[0]`: the installer reclaims its own stale links only under `<userData>/cli/bin`. */
export function orcadCliResourcesPath(dataRoot: string): string {
  return join(dataRoot, DEV_LAUNCHER_DIR[0])
}

export function buildOrcadCliLauncherScript(args: {
  runtimePath: string
  cliEntryPath: string
  dataRoot: string
}): string {
  // Why pinned, like the dev launcher: an inherited ORCA_USER_DATA_PATH would aim this
  // runtime's CLI at another Orca's metadata.
  return `#!/usr/bin/env bash
set -euo pipefail
export ORCA_USER_DATA_PATH=${quoteShell(args.dataRoot)}
export ORCA_NODE_OPTIONS="\${NODE_OPTIONS-}"
export ORCA_NODE_REPL_EXTERNAL_MODULE="\${NODE_REPL_EXTERNAL_MODULE-}"
unset NODE_OPTIONS
unset NODE_REPL_EXTERNAL_MODULE
exec ${quoteShell(args.runtimePath)} ${quoteShell(args.cliEntryPath)} "$@"
`
}

/**
 * Writes (or refreshes) the launcher and returns the resources root whose `bin/` holds it, or
 * null when this host cannot run one: Windows (a POSIX script) or a build without the bundle.
 */
export function prepareOrcadCliLauncher(options: {
  platform: NodeJS.Platform
  dataRoot: string
  installRoot: string
  runtimePath: string
}): string | null {
  const bundlePath = join(options.installRoot, ORCAD_CLI_BUNDLE_FILENAME)
  if (options.platform === 'win32' || !existsSync(bundlePath)) {
    return null
  }
  const resourcesPath = orcadCliResourcesPath(options.dataRoot)
  const launcherPath = getBundledLauncherPath(options.platform, resourcesPath)
  if (!launcherPath) {
    return null
  }
  const script = buildOrcadCliLauncherScript({
    runtimePath: options.runtimePath,
    // Why realpath: pin this exact install, not a `current` link a later activation repoints.
    cliEntryPath: realpathSync(bundlePath),
    dataRoot: options.dataRoot
  })
  if (readLauncher(launcherPath) !== script) {
    mkdirSync(dirname(launcherPath), { recursive: true })
    writeFileSync(launcherPath, script, 'utf8')
  }
  chmodSync(launcherPath, 0o755)
  return resourcesPath
}

function readLauncher(launcherPath: string): string | null {
  try {
    return readFileSync(launcherPath, 'utf8')
  } catch {
    return null
  }
}
