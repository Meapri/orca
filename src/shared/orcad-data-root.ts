import { join } from 'node:path'

/** orcad's data root: `$ORCA_USER_DATA`, else `$XDG_DATA_HOME/Orca`, else `~/.orca`. Empty is unset. */
export function resolveOrcadDataRoot(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string
): string {
  if (env.ORCA_USER_DATA) {
    return env.ORCA_USER_DATA
  }
  return env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, 'Orca') : join(homeDir, '.orca')
}
