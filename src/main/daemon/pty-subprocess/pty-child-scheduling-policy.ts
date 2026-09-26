/**
 * Scheduling and OOM policy for a freshly spawned PTY child (POSIX only, best-effort).
 *
 * Niceness (#14639): a PTY child inherits the daemon's nice level, which is whatever orcad was
 * started with. An operator who nices the runtime (systemd `Nice=`, `nice orcad`) meant the
 * service, not the user's shells and agents, so by default a niced daemon resets each child to
 * 0. Lowering nice needs `RLIMIT_NICE` (systemd `LimitNICE=`) or `CAP_SYS_NICE`; without it the
 * reset fails and the child keeps the inherited level — today's behavior.
 * `ORCA_TERMINAL_NICE=inherit` keeps inheritance; an integer pins a level.
 *
 * OOM preference (Linux, #16084): raising the child's `oom_score_adj` makes the kernel pick a
 * runaway agent before the daemon that owns every other terminal. Raising is unprivileged and
 * inherited by the child's descendants. `ORCA_TERMINAL_OOM_SCORE_ADJ=0` turns it off.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { getPriority, setPriority } from 'node:os'

export const TERMINAL_NICE_ENV = 'ORCA_TERMINAL_NICE'
export const TERMINAL_OOM_SCORE_ADJ_ENV = 'ORCA_TERMINAL_OOM_SCORE_ADJ'
export const DEFAULT_TERMINAL_OOM_SCORE_ADJ = 200

export type PtyChildSchedulingDeps = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  getPriority?: (pid?: number) => number
  setPriority?: (pid: number, priority: number) => void
  readFile?: (path: string) => string
  writeFile?: (path: string, contents: string) => void
}

export type PtyChildSchedulingOutcome = {
  nice: 'unchanged' | 'set' | 'denied'
  oomScoreAdj: 'unchanged' | 'set' | 'denied'
}

function parseInteger(raw: string | undefined, min: number, max: number): number | null {
  const value = raw?.trim()
  if (!value || !/^-?\d+$/.test(value)) {
    return null
  }
  const parsed = Number(value)
  return parsed >= min && parsed <= max ? parsed : null
}

function resolveTargetNice(env: NodeJS.ProcessEnv, ownNice: number): number | null {
  const raw = env[TERMINAL_NICE_ENV]?.trim().toLowerCase()
  if (raw === 'inherit') {
    return null
  }
  const pinned = parseInteger(raw, -20, 19)
  if (pinned !== null) {
    return pinned
  }
  // Why only when niced: an un-niced daemon's children already run at the default level.
  return ownNice > 0 ? 0 : null
}

export function applyPtyChildSchedulingPolicy(
  pid: number | undefined,
  deps: PtyChildSchedulingDeps = {}
): PtyChildSchedulingOutcome {
  const outcome: PtyChildSchedulingOutcome = { nice: 'unchanged', oomScoreAdj: 'unchanged' }
  const platform = deps.platform ?? process.platform
  if (platform === 'win32' || pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    return outcome
  }
  const env = deps.env ?? process.env
  const readPriority = deps.getPriority ?? getPriority
  const writePriority = deps.setPriority ?? setPriority
  try {
    const target = resolveTargetNice(env, readPriority())
    if (target !== null && readPriority(pid) !== target) {
      writePriority(pid, target)
      outcome.nice = 'set'
    }
  } catch {
    outcome.nice = 'denied'
  }
  if (platform !== 'linux') {
    return outcome
  }
  const oomScoreAdj =
    parseInteger(env[TERMINAL_OOM_SCORE_ADJ_ENV], 0, 1000) ?? DEFAULT_TERMINAL_OOM_SCORE_ADJ
  if (oomScoreAdj === 0) {
    return outcome
  }
  const path = `/proc/${pid}/oom_score_adj`
  try {
    const current = Number((deps.readFile ?? ((file) => readFileSync(file, 'utf8')))(path).trim())
    // Why only raise: a unit that already set a higher OOMScoreAdjust= must keep it.
    if (Number.isFinite(current) && current >= oomScoreAdj) {
      return outcome
    }
    ;(deps.writeFile ?? writeFileSync)(path, String(oomScoreAdj))
    outcome.oomScoreAdj = 'set'
  } catch {
    outcome.oomScoreAdj = 'denied'
  }
  return outcome
}
