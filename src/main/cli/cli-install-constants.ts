import { APP_DISTRIBUTION } from '../../shared/app-distribution'

// Why not `orca`: the official Orca owns that global command; each app installs its own name.
export const PACKAGED_MAC_COMMAND_NAME = APP_DISTRIBUTION.cliCommandName
export const DEFAULT_MAC_COMMAND_PATH = `/usr/local/bin/${PACKAGED_MAC_COMMAND_NAME}`
export const DEV_COMMAND_NAME = 'orca-dev'
export const LEGACY_LINUX_COMMAND_NAME = 'orca'
export const DEV_LAUNCHER_DIR = ['cli', 'bin'] as const
export const WINDOWS_PATH_WRITE_TIMEOUT_MS = 5_000
