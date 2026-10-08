/**
 * How long history for an exited terminal is kept, and how much of it.
 *
 * Only sessions whose PTY exit was observed (meta `endedAt` set AND a numeric `exitCode`) are
 * ever collectible — the `exited` verdict of docs/reference/ssh-execution-boundary.md. A
 * session a shutdown marked ended without an exit code, or one still marked running, may be
 * live in a daemon this process is not attached to, so it is `unverifiable` and never touched.
 */

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MIB = 1024 * 1024

export const DEFAULT_EXITED_HISTORY_MAX_AGE_MS = 7 * DAY_MS
export const DEFAULT_EXITED_HISTORY_MAX_TOTAL_BYTES = 2048 * MIB
// Why a floor: the spawn-probe race can restore from a just-ended session (`ignoreCleanEnd`),
// so a session that ended moments ago must survive even a zero-day policy.
export const EXITED_HISTORY_MIN_AGE_MS = 10 * 60 * 1000

export const EXITED_HISTORY_RETENTION_DAYS_ENV = 'ORCA_TERMINAL_HISTORY_RETENTION_DAYS'
export const EXITED_HISTORY_MAX_MB_ENV = 'ORCA_TERMINAL_HISTORY_MAX_EXITED_MB'

export type ExitedHistoryRetentionPolicy = {
  /** Null keeps exited history regardless of age. */
  maxAgeMs: number | null
  /** Null keeps exited history regardless of total size. */
  maxTotalBytes: number | null
  minAgeMs: number
}

export type ExitedHistoryRetentionPolicyResolution = {
  policy: ExitedHistoryRetentionPolicy
  /** Operator-facing notes for values that were rejected and replaced by the default. */
  warnings: string[]
}

type ParsedLimit = { kind: 'value'; value: number } | { kind: 'off' } | { kind: 'invalid' }

function parseLimit(raw: string | undefined): ParsedLimit | null {
  const value = raw?.trim().toLowerCase()
  if (!value) {
    return null
  }
  if (value === 'off' || value === 'unlimited') {
    return { kind: 'off' }
  }
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return { kind: 'invalid' }
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? { kind: 'value', value: parsed } : { kind: 'invalid' }
}

function resolveLimit(
  env: NodeJS.ProcessEnv,
  name: string,
  unitMs: number,
  fallback: number,
  warnings: string[]
): number | null {
  const parsed = parseLimit(env[name])
  if (!parsed) {
    return fallback
  }
  if (parsed.kind === 'off') {
    return null
  }
  if (parsed.kind === 'invalid') {
    warnings.push(`${name}=${env[name]} is not a number or "off"; using the default.`)
    return fallback
  }
  return Math.round(parsed.value * unitMs)
}

export function resolveExitedHistoryRetentionPolicy(
  env: NodeJS.ProcessEnv = process.env
): ExitedHistoryRetentionPolicyResolution {
  const warnings: string[] = []
  return {
    policy: {
      maxAgeMs: resolveLimit(
        env,
        EXITED_HISTORY_RETENTION_DAYS_ENV,
        DAY_MS,
        DEFAULT_EXITED_HISTORY_MAX_AGE_MS,
        warnings
      ),
      maxTotalBytes: resolveLimit(
        env,
        EXITED_HISTORY_MAX_MB_ENV,
        MIB,
        DEFAULT_EXITED_HISTORY_MAX_TOTAL_BYTES,
        warnings
      ),
      minAgeMs: EXITED_HISTORY_MIN_AGE_MS
    },
    warnings
  }
}

export type ExitedHistoryCandidate = {
  sessionId: string
  endedAtMs: number
  bytes: number
}

/**
 * Which exited sessions to collect: everything past the age limit, then the oldest of the
 * rest until the survivors fit the byte budget. Nothing younger than `minAgeMs` is chosen.
 */
export function selectExitedHistoryForCollection(
  candidates: readonly ExitedHistoryCandidate[],
  policy: ExitedHistoryRetentionPolicy,
  now: number
): string[] {
  const oldestFirst = [...candidates].sort((left, right) => left.endedAtMs - right.endedAtMs)
  const selected: string[] = []
  let retainedBytes = oldestFirst.reduce((sum, candidate) => sum + candidate.bytes, 0)
  for (const candidate of oldestFirst) {
    const ageMs = now - candidate.endedAtMs
    if (ageMs < policy.minAgeMs) {
      break
    }
    const expired = policy.maxAgeMs !== null && ageMs > policy.maxAgeMs
    const overBudget = policy.maxTotalBytes !== null && retainedBytes > policy.maxTotalBytes
    if (!expired && !overBudget) {
      break
    }
    selected.push(candidate.sessionId)
    retainedBytes -= candidate.bytes
  }
  return selected
}
