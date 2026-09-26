/**
 * Optional systemd resource limits for the terminal daemon's `orca-daemon-*.scope`.
 *
 * The scope holds the daemon and every PTY it owns, so a limit here bounds all terminal and
 * agent work on the host together (#12588): `MemoryHigh` throttles and reclaims before
 * `MemoryMax` OOM-kills inside the scope, `TasksMax` caps fork bombs, `CPUWeight` keeps the
 * rest of the host responsive. All are off unless an operator sets them.
 *
 * `OOMPolicy=continue` is always requested for a fresh scope: under systemd's default
 * (`stop`), one OOM-killed agent would stop the whole scope and every terminal with it.
 */

export const TERMINAL_SCOPE_LIMIT_ENV = {
  MemoryHigh: 'ORCA_TERMINAL_MEMORY_HIGH',
  MemoryMax: 'ORCA_TERMINAL_MEMORY_MAX',
  TasksMax: 'ORCA_TERMINAL_TASKS_MAX',
  CPUWeight: 'ORCA_TERMINAL_CPU_WEIGHT'
} as const

type ScopeLimitProperty = keyof typeof TERMINAL_SCOPE_LIMIT_ENV
const SCOPE_LIMIT_PROPERTIES: readonly ScopeLimitProperty[] = [
  'MemoryHigh',
  'MemoryMax',
  'TasksMax',
  'CPUWeight'
]

const MEMORY_VALUE = /^(\d+(\.\d+)?[KMGT]?|\d{1,2}(\.\d+)?%|100%|infinity)$/i
const TASKS_VALUE = /^(\d+|\d{1,2}(\.\d+)?%|100%|infinity)$/i

function isValidLimit(property: ScopeLimitProperty, value: string): boolean {
  if (property === 'MemoryHigh' || property === 'MemoryMax') {
    return MEMORY_VALUE.test(value)
  }
  if (property === 'TasksMax') {
    return TASKS_VALUE.test(value)
  }
  if (value === 'idle') {
    return true
  }
  const weight = Number(value)
  return /^\d+$/.test(value) && weight >= 1 && weight <= 10_000
}

export type DaemonScopeResourceLimits = {
  /** `Name=value` cgroup assignments, valid for `--property=` and `set-property`. */
  limits: string[]
  warnings: string[]
}

export function resolveDaemonScopeResourceLimits(
  env: NodeJS.ProcessEnv = process.env
): DaemonScopeResourceLimits {
  const limits: string[] = []
  const warnings: string[] = []
  for (const property of SCOPE_LIMIT_PROPERTIES) {
    const envName = TERMINAL_SCOPE_LIMIT_ENV[property]
    const value = env[envName]?.trim()
    if (!value) {
      continue
    }
    if (!isValidLimit(property, value)) {
      warnings.push(`${envName}=${value} is not a valid ${property} value; ignoring it.`)
      continue
    }
    limits.push(`${property}=${value}`)
  }
  return { limits, warnings }
}

export const DAEMON_SCOPE_OOM_POLICY = 'OOMPolicy=continue'

/** Launch-time `--property=` arguments for a fresh daemon scope. */
export function daemonScopePropertyArgs(limits: readonly string[]): string[] {
  return [DAEMON_SCOPE_OOM_POLICY, ...limits].map((property) => `--property=${property}`)
}
