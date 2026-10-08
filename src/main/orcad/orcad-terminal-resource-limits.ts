/**
 * Bring an adopted terminal daemon's scope up to the configured resource limits.
 *
 * Why after adoption as well as at launch: orcad restarts adopt the running daemon (restarting
 * it would kill every terminal), so a limit an operator adds later would otherwise wait for a
 * daemon that may never be replaced. `set-property --runtime` changes the live cgroup in place.
 */
import { runProcess, type ProcessResult } from '../../shared/child-process/run-process'
import {
  buildDaemonScopeSetPropertyCommand,
  isOwnDaemonScopeUnit,
  type DurableDaemonScopeCommand
} from '../daemon/daemon-cgroup-scope'
import { resolveDaemonScopeResourceLimits } from '../daemon/daemon-scope-resource-limits'
import { setTerminalResourceLimitsShortfall } from '../daemon/daemon-scope-resource-limit-status'

const SET_PROPERTY_TIMEOUT_MS = 5_000

export type TerminalResourceLimitsApplyDeps = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** The live daemon's own cgroup unit, as its PID record reports it. */
  readCgroupUnit: () => string | null
  run?: (command: DurableDaemonScopeCommand) => Promise<Pick<ProcessResult, 'code' | 'timedOut'>>
}

export type TerminalResourceLimitsApplyOutcome = 'none-configured' | 'applied' | 'unavailable'

export async function applyTerminalResourceLimitsToLiveDaemon(
  deps: TerminalResourceLimitsApplyDeps
): Promise<TerminalResourceLimitsApplyOutcome> {
  const env = deps.env ?? process.env
  const { limits } = resolveDaemonScopeResourceLimits(env)
  if (limits.length === 0) {
    return 'none-configured'
  }
  const unit = (deps.platform ?? process.platform) === 'linux' ? deps.readCgroupUnit() : null
  // Why only our own scopes: a legacy `app-orca-*` scope can also hold desktop GUI processes.
  if (!isOwnDaemonScopeUnit(unit)) {
    setTerminalResourceLimitsShortfall({ reason: 'systemd_scope_unavailable', limits })
    return 'unavailable'
  }
  const run =
    deps.run ??
    ((command: DurableDaemonScopeCommand) =>
      runProcess({
        program: command.command,
        args: command.args,
        env: command.env,
        timeoutMs: SET_PROPERTY_TIMEOUT_MS
      }))
  try {
    const result = await run(buildDaemonScopeSetPropertyCommand(unit, limits, env))
    if (result.code === 0 && !result.timedOut) {
      setTerminalResourceLimitsShortfall(null)
      return 'applied'
    }
    setTerminalResourceLimitsShortfall({
      reason: 'set_property_failed',
      limits,
      detail: result.timedOut ? 'timed out' : `exit ${String(result.code)}`
    })
  } catch (error) {
    setTerminalResourceLimitsShortfall({
      reason: 'set_property_failed',
      limits,
      detail: error instanceof Error ? error.message : String(error)
    })
  }
  console.warn(`[orcad] Could not apply terminal resource limits to ${unit}.`)
  return 'unavailable'
}
