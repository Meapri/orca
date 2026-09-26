/**
 * The on-host installer's activation decisions, delegated to the same policy the SSH deploy
 * uses (`planOrcadUpdate`, `evaluateOrcadActivation`) so there is one rulebook for both paths.
 *
 * What the installer adds is the stop-safety question the SSH deploy answers with a PID-scoped
 * stop: the installer restarts a *service unit*, which reaches every process in the unit's
 * cgroup. That stop is non-destructive only when the daemon holds its own scope; otherwise the
 * census rule is mandatory and `--force` never waives it.
 */
import type { OrcadActivationRecord } from '../../ssh/orcad-activation-record'
import { planOrcadUpdate } from '../../ssh/orcad-update-plan'
import {
  evaluateOrcadActivation,
  type OrcadActivationVerdict
} from '../../ssh/orcad-activation-gate'
import { parseOrcadReadinessOutput } from '../../ssh/orcad-remote-launch'
import { computeLocalOrcadBuildHash } from '../../ssh/orcad-local-build-hash'
import type { DaemonIsolation, HostTerminalCensus } from './host-install-census'

export type HostStopSafety =
  | { safe: true; reason: string }
  | { safe: false; code: 'orcad_install_stop_destructive'; reason: string }

/** May the service unit be stopped without ending live terminals? */
export function assessServiceStop(
  isolation: DaemonIsolation,
  census: HostTerminalCensus
): HostStopSafety {
  if (isolation.state === 'isolated') {
    return { safe: true, reason: isolation.reason }
  }
  if (census.verdict === 'empty') {
    return {
      safe: true,
      reason: `${isolation.reason}; the terminal census is empty, so no live work is at risk`
    }
  }
  if (isolation.state === 'no-daemon' && census.verdict === 'unverifiable') {
    // No daemon record is alive, but the census could not confirm it: an unrecorded
    // fallback daemon is still possible, so stay on the destructive side.
    return {
      safe: false,
      code: 'orcad_install_stop_destructive',
      reason:
        `No daemon record is alive, but ${census.reason}. Stopping could still end work ` +
        'this installer cannot see. Provide a working census command and retry.'
    }
  }
  const censusText =
    census.verdict === 'live'
      ? `${census.liveSessions} terminal(s) are live`
      : `the census is unverifiable (${census.reason})`
  return {
    safe: false,
    code: 'orcad_install_stop_destructive',
    reason:
      `${isolation.reason}, and ${censusText}. Stopping the service would end them. ` +
      'Enable the daemon scope (loginctl enable-linger, reachable user bus) or wait until ' +
      'the host is idle. --force does not override this.'
  }
}

export type HostActivationPlan =
  | { action: 'proceed'; notes: string[] }
  | { action: 'noop'; reason: string }
  | { action: 'refuse'; code: string; reason: string }

export function planHostActivation(input: {
  record: OrcadActivationRecord
  candidateVersion: string
  isolation: DaemonIsolation
  census: HostTerminalCensus
  force?: boolean
  /** No service is running (first install, or an operator-stopped unit). */
  serviceStopped?: boolean
}): HostActivationPlan {
  const plan = planOrcadUpdate({
    record: input.record,
    candidateVersion: input.candidateVersion,
    // A daemon with no live record owns no sessions, so zero is host evidence here.
    census: {
      liveSessions: input.isolation.state === 'no-daemon' ? 0 : input.census.liveSessions,
      startedSinceActivation: null
    },
    ...(input.force !== undefined ? { force: input.force } : {})
  })
  // Re-activating the active version stops nothing, so it needs no stop-safety verdict.
  if (plan.action === 'noop') {
    return { action: 'noop', reason: plan.reason }
  }
  if (!input.serviceStopped) {
    const stop = assessServiceStop(input.isolation, input.census)
    if (!stop.safe) {
      return { action: 'refuse', code: stop.code, reason: stop.reason }
    }
  }
  if (plan.action === 'defer') {
    return { action: 'refuse', code: plan.code, reason: plan.reason }
  }
  return { action: 'proceed', notes: plan.notes }
}

export type HostActivationGate = OrcadActivationVerdict & { mainPid: number | null }

/**
 * Gate on the readiness line the service published. Identity is proved twice: by the build
 * hash of the candidate's own `orcad.js`, and — when the supervisor reports one — by the
 * readiness PID matching the unit's main PID, so a stale process cannot answer for the unit.
 */
export function gateHostActivation(input: {
  readinessRaw: string
  versionDir: string
  fullVersion: string
  mainPid?: number | null
}): HostActivationGate {
  const parsed = parseOrcadReadinessOutput(input.readinessRaw)
  const readiness = parsed.state === 'ready' ? parsed.readiness : null
  const mainPid = input.mainPid && input.mainPid > 0 ? input.mainPid : null
  if (readiness?.health && mainPid !== null && readiness.health.pid !== mainPid) {
    return {
      decision: 'reject',
      code: 'orcad_activation_build_mismatch',
      reason:
        `The readiness line was published by PID ${readiness.health.pid}, but the service's ` +
        `main PID is ${mainPid}. Another process answered for this unit; nothing was activated.`,
      mainPid
    }
  }
  const verdict = evaluateOrcadActivation(readiness, {
    buildHash: computeLocalOrcadBuildHash(input.versionDir),
    fullVersion: input.fullVersion
  })
  return { ...verdict, mainPid }
}
