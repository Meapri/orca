// Which data root `orca serve status | doctor | pairing` talks to on this host.
import { existsSync } from 'node:fs'
import { getRuntimeMetadataPath } from '../shared/runtime-bootstrap'
import { resolveUserDataPath as resolveOrcadDataRoot } from '../main/orcad/orcad-app-paths'
import { getDefaultUserDataPath } from './runtime/metadata'
import { RuntimeClientError } from './runtime/types'

/**
 * Why not the CLI's usual default: orcad keeps its state in `$ORCA_USER_DATA` / `~/.orca`, while
 * the CLI defaults to the desktop's userData. Inside an Orca terminal `ORCA_USER_DATA_PATH`
 * already names the runtime that owns the shell, so it wins over guessing.
 */
export function resolveServeDataRoot(flags: ReadonlyMap<string, string | boolean>): string {
  const explicit = flags.get('data-root')
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || explicit.length === 0) {
      throw new RuntimeClientError('invalid_argument', 'Missing value for --data-root.')
    }
    return explicit
  }
  if (process.env.ORCA_USER_DATA) {
    return process.env.ORCA_USER_DATA
  }
  if (process.env.ORCA_USER_DATA_PATH) {
    return process.env.ORCA_USER_DATA_PATH
  }
  const orcadRoot = resolveOrcadDataRoot()
  if (existsSync(getRuntimeMetadataPath(orcadRoot))) {
    return orcadRoot
  }
  try {
    const desktopRoot = getDefaultUserDataPath()
    if (existsSync(getRuntimeMetadataPath(desktopRoot))) {
      return desktopRoot
    }
  } catch {
    // An unresolvable desktop path (no APPDATA) leaves the orcad default.
  }
  return orcadRoot
}
