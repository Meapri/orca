/**
 * Rollback and pruning for the on-host installer. Rollback safety is `assessOrcadRollback`,
 * the SSH deploy's rule; pruning honours the same GC pins (`orcadGcPinnedDirNames`) plus the
 * versions live daemons were forked from, which an update deliberately leaves running.
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  ORCAD_STATE_SNAPSHOT_DIR,
  orcadGcPinnedDirNames,
  type OrcadActivationRecord
} from '../../ssh/orcad-activation-record'
import { assessOrcadRollback, type OrcadRollbackSafety } from '../../ssh/orcad-update-plan'
import {
  remoteInstallDirName,
  remoteInstallDirOwner,
  remoteInstallVersionDirRegex,
  ORCAD_INSTALL_MODEL
} from '../../ssh/remote-install-model'
import { ORCAD_PID_FILENAME } from '../../ssh/orcad-remote-host-support'
import { ORCAD_INSTALL_COMPLETE_FILENAME } from '../../../shared/orcad-artifacts'
import { probeProcess, type DaemonIsolation, type HostTerminalCensus } from './host-install-census'
import { snapshotPresent, stateWrittenSince } from './host-install-state'

/** The symlink the service unit starts through; outside the version-dir namespace, so no GC owns it. */
export const ORCAD_CURRENT_LINK_NAME = 'orcad-current'

export function planHostRollback(input: {
  base: string
  dataRoot: string
  record: OrcadActivationRecord
  isolation: DaemonIsolation
  census: HostTerminalCensus
}): OrcadRollbackSafety {
  // Without per-terminal start times, every live terminal is counted as post-activation.
  const startedSinceActivation =
    input.isolation.state === 'no-daemon' ? 0 : input.census.liveSessions
  return assessOrcadRollback({
    record: input.record,
    snapshotPresent: snapshotPresent(input.base, input.record.snapshot),
    census: { liveSessions: startedSinceActivation, startedSinceActivation },
    stateWritesSinceActivation: stateWrittenSince(input.dataRoot, input.record.activatedAt)
  })
}

function currentLinkTarget(base: string): string | null {
  try {
    return basename(readlinkSync(join(base, ORCAD_CURRENT_LINK_NAME)))
  } catch {
    return null
  }
}

export type HostPruneResult = { removed: string[]; kept: string[] }

/** An install still in progress, or an orcad an SSH deploy launched from it, keeps the dir. */
function versionDirInUse(path: string): boolean {
  if (!existsSync(join(path, ORCAD_INSTALL_COMPLETE_FILENAME))) {
    return true
  }
  let pid: number
  try {
    pid = Number(readFileSync(join(path, ORCAD_PID_FILENAME), 'utf8').trim())
  } catch {
    return false
  }
  return !Number.isSafeInteger(pid) || pid <= 1 || probeProcess(pid) !== 'dead'
}

/** Remove orcad version dirs nothing needs; never touches relay dirs or the data root. */
export function pruneHostInstall(input: {
  base: string
  record: OrcadActivationRecord
  isolation: DaemonIsolation
  pendingCandidate?: string | null
  dryRun?: boolean
  now?: () => number
}): HostPruneResult {
  const now = input.now ?? Date.now
  const pinned = new Set(orcadGcPinnedDirNames(input.record))
  for (const version of input.isolation.versions) {
    pinned.add(remoteInstallDirName(ORCAD_INSTALL_MODEL, version))
  }
  if (input.pendingCandidate) {
    pinned.add(remoteInstallDirName(ORCAD_INSTALL_MODEL, input.pendingCandidate))
  }
  const linked = currentLinkTarget(input.base)
  if (linked) {
    pinned.add(linked)
  }
  // An unverifiable daemon may have been forked from any version; keep them all.
  const keepEveryVersion = input.isolation.state === 'unverifiable'
  const versionDir = remoteInstallVersionDirRegex(ORCAD_INSTALL_MODEL)
  const result: HostPruneResult = { removed: [], kept: [] }
  for (const name of existsSync(input.base) ? readdirSync(input.base) : []) {
    if (remoteInstallDirOwner(name) !== 'orcad') {
      continue
    }
    const isTombstone = !versionDir.test(name)
    if (
      !isTombstone &&
      (pinned.has(name) || keepEveryVersion || versionDirInUse(join(input.base, name)))
    ) {
      result.kept.push(name)
      continue
    }
    result.removed.push(name)
    if (input.dryRun) {
      continue
    }
    const path = join(input.base, name)
    // Rename first so a half-deleted tree never looks like a complete install.
    const doomed = isTombstone ? path : `${path}.gc-tombstone.${process.pid}.${now()}`
    if (!isTombstone) {
      renameSync(path, doomed)
    }
    rmSync(doomed, { recursive: true, force: true })
  }
  const snapshotsDir = join(input.base, ORCAD_STATE_SNAPSHOT_DIR)
  const keepSnapshot = input.record.snapshot?.dirName
  for (const name of existsSync(snapshotsDir) ? readdirSync(snapshotsDir) : []) {
    // Only the recorded snapshot can serve a rollback; the pending one belongs to an activation.
    if (name === keepSnapshot || input.pendingCandidate) {
      continue
    }
    result.removed.push(`${ORCAD_STATE_SNAPSHOT_DIR}/${name}`)
    if (!input.dryRun) {
      rmSync(join(snapshotsDir, name), { recursive: true, force: true })
    }
  }
  return result
}
