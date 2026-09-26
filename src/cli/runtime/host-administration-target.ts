import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import { resolveOrcadDataRoot } from '../../shared/orcad-data-root'
import { getDefaultUserDataPath } from './metadata'

/**
 * Which local runtime `orca serve devices|pairing` administers. The desktop app and orcad keep their
 * state in different roots, so a VPS operator running only orcad must not be told "start Orca first".
 * Explicit env always wins; otherwise the first root with live metadata, desktop before orcad.
 */
export function resolveHostAdministrationUserDataPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
  hasMetadata: (userDataPath: string) => boolean = (path) =>
    existsSync(getRuntimeMetadataPath(path))
): string {
  if (env.ORCA_USER_DATA_PATH) {
    return env.ORCA_USER_DATA_PATH
  }
  if (env.ORCA_USER_DATA) {
    return env.ORCA_USER_DATA
  }
  const desktopRoot = getDefaultUserDataPath(platform, homeDir)
  if (hasMetadata(desktopRoot)) {
    return desktopRoot
  }
  const orcadRoot = resolveOrcadDataRoot(env, homeDir)
  return hasMetadata(orcadRoot) ? orcadRoot : desktopRoot
}
