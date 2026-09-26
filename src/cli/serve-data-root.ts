// Which local data root every `orca serve status | doctor | pairing | devices` command talks to.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { getRuntimeMetadataPath } from '../shared/runtime-bootstrap'
import { resolveOrcadDataRoot } from '../shared/orcad-data-root'
import { getDefaultUserDataPath } from './runtime/metadata'
import { RuntimeClientError } from './runtime/types'

export type ServeDataRootProbe = {
  env?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  homeDir?: string
  hasMetadata?: (userDataPath: string) => boolean
}

/**
 * Why not the CLI's usual default: orcad keeps its state in `$ORCA_USER_DATA` / `~/.orca`, while
 * the CLI defaults to the desktop's userData, so a VPS running only orcad must not be told to
 * start Orca. Explicit input wins (`--data-root`, then orcad's own `ORCA_USER_DATA`, then the
 * `ORCA_USER_DATA_PATH` an Orca terminal exports); otherwise the first default root with runtime
 * metadata, orcad before the desktop, and orcad's root when neither has any.
 */
export function resolveServeDataRoot(
  flags: ReadonlyMap<string, string | boolean>,
  probe: ServeDataRootProbe = {}
): string {
  const env = probe.env ?? process.env
  const homeDir = probe.homeDir ?? homedir()
  const hasMetadata =
    probe.hasMetadata ??
    ((userDataPath: string) => existsSync(getRuntimeMetadataPath(userDataPath)))
  const explicit = flags.get('data-root')
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || explicit.length === 0) {
      throw new RuntimeClientError('invalid_argument', 'Missing value for --data-root.')
    }
    return explicit
  }
  if (env.ORCA_USER_DATA) {
    return env.ORCA_USER_DATA
  }
  if (env.ORCA_USER_DATA_PATH) {
    return env.ORCA_USER_DATA_PATH
  }
  const orcadRoot = resolveOrcadDataRoot(env, homeDir)
  if (hasMetadata(orcadRoot)) {
    return orcadRoot
  }
  try {
    const desktopRoot = getDefaultUserDataPath(probe.platform ?? process.platform, homeDir)
    if (hasMetadata(desktopRoot)) {
      return desktopRoot
    }
  } catch {
    // An unresolvable desktop path (no APPDATA) leaves the orcad default.
  }
  return orcadRoot
}
