/**
 * `orcad --limit <key>=<value>`: the command-line spelling of the resource-governance env vars.
 *
 * Why env vars underneath: the terminal daemon is a separate, detached process that reads its
 * PTY policy from its environment, and a systemd unit's `Environment=` is the natural place for
 * the rest. A flag just sets the same variable before anything reads it, so the two spellings
 * can never disagree. See docs/reference/orcad-operations.md#resource-governance.
 */
import {
  EXITED_HISTORY_MAX_MB_ENV,
  EXITED_HISTORY_RETENTION_DAYS_ENV
} from '../daemon/terminal-history-exited-retention-policy'
import { TERMINAL_SCOPE_LIMIT_ENV } from '../daemon/daemon-scope-resource-limits'
import {
  TERMINAL_NICE_ENV,
  TERMINAL_OOM_SCORE_ADJ_ENV
} from '../daemon/pty-subprocess/pty-child-scheduling-policy'
import { BROWSER_MAX_TABS_ENV, BROWSER_TAB_IDLE_MINUTES_ENV } from './external-chromium-tab-limits'

export const ORCAD_RESOURCE_LIMIT_ENV: Readonly<Record<string, string>> = {
  'terminal-memory-high': TERMINAL_SCOPE_LIMIT_ENV.MemoryHigh,
  'terminal-memory-max': TERMINAL_SCOPE_LIMIT_ENV.MemoryMax,
  'terminal-tasks-max': TERMINAL_SCOPE_LIMIT_ENV.TasksMax,
  'terminal-cpu-weight': TERMINAL_SCOPE_LIMIT_ENV.CPUWeight,
  'terminal-nice': TERMINAL_NICE_ENV,
  'terminal-oom-score-adj': TERMINAL_OOM_SCORE_ADJ_ENV,
  'history-retention-days': EXITED_HISTORY_RETENTION_DAYS_ENV,
  'history-max-exited-mb': EXITED_HISTORY_MAX_MB_ENV,
  'browser-max-tabs': BROWSER_MAX_TABS_ENV,
  'browser-tab-idle-minutes': BROWSER_TAB_IDLE_MINUTES_ENV
}

/** Parse one `key=value` token into its env var assignment; throws on an unknown key. */
export function parseOrcadResourceLimit(token: string): [envName: string, value: string] {
  const separator = token.indexOf('=')
  const key = separator > 0 ? token.slice(0, separator) : ''
  const value = separator > 0 ? token.slice(separator + 1).trim() : ''
  const envName = Object.hasOwn(ORCAD_RESOURCE_LIMIT_ENV, key)
    ? ORCAD_RESOURCE_LIMIT_ENV[key]
    : undefined
  if (!envName || !value) {
    throw new Error(
      `--limit expects <key>=<value> with key one of: ${Object.keys(ORCAD_RESOURCE_LIMIT_ENV).join(', ')}; got ${token || "''"}`
    )
  }
  return [envName, value]
}

/** A flag outranks the inherited environment, which is what an operator typing it expects. */
export function applyOrcadResourceLimits(
  limits: Readonly<Record<string, string>> | undefined,
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const [envName, value] of Object.entries(limits ?? {})) {
    env[envName] = value
  }
}
