import { homedir } from 'node:os'
import { join } from 'node:path'
import { APP_DISTRIBUTION } from '../shared/app-distribution'

/**
 * Home-level dir for integration credentials this app encrypts with its own safeStorage key.
 * Why per-distribution: another Orca build cannot decrypt these and would overwrite them.
 */
export function getAppSecretHomeDir(home: string = homedir()): string {
  return join(home, APP_DISTRIBUTION.homeStateDirName)
}
