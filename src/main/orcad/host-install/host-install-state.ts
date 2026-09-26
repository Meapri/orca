/**
 * The installer's durable state, in exactly the formats the SSH deploy writes: the
 * `orcad-active.json` activation record, and `orcad-state-snapshots/<pre-...>/state.tar`
 * produced by the same shell commands. Reusing the command builders (run locally through
 * `sh -c` instead of over SSH) is what keeps a snapshot taken by one path restorable by the
 * other.
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runProcessSync } from '../../../shared/child-process/run-process'
import { writeFileAtomically } from '../../codex-accounts/fs-utils'
import {
  ORCAD_ACTIVATION_FILENAME,
  ORCAD_STATE_SNAPSHOT_DIR,
  emptyOrcadActivationRecord,
  parseOrcadActivationRecord,
  serializeOrcadActivationRecord,
  type OrcadActivationRecord,
  type OrcadStateSnapshot
} from '../../ssh/orcad-activation-record'
import {
  captureOrcadStateSnapshotCommand,
  compareOrcadStateSnapshotCommand,
  newestStateMtimeCommand,
  ORCAD_SNAPSHOT_MEMBERS,
  orcadSnapshotDirName,
  orcadSnapshotIsUnchanged,
  parseNewestStateMtimeSeconds,
  parseOrcadSnapshotCapture,
  parseOrcadSnapshotRestore,
  restoreOrcadStateSnapshotCommand
} from '../../ssh/orcad-state-snapshot'
import { getRemoteHostPlatform, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

/** Only the POSIX command dialect matters to these builders; the arch is never read. */
const LOCAL_POSIX_HOST: RemoteHostPlatform = getRemoteHostPlatform('linux-x64')

/** Written between stop and commit so a failed activation knows which snapshot is its own. */
const HOST_PENDING_ACTIVATION_FILENAME = '.orcad-pending-activation.json'

function activationRecordPath(base: string): string {
  return join(base, ORCAD_ACTIVATION_FILENAME)
}

/** An unreadable record throws: treating it as empty would orphan the rollback target. */
export function readActivationRecord(base: string): OrcadActivationRecord {
  const path = activationRecordPath(base)
  const parsed = parseOrcadActivationRecord(existsSync(path) ? readFileSync(path, 'utf8') : null)
  if (parsed.state === 'unreadable') {
    throw new Error(`Cannot read ${path}: ${parsed.reason}`)
  }
  return parsed.state === 'ok' ? parsed.record : emptyOrcadActivationRecord()
}

export function writeActivationRecord(base: string, record: OrcadActivationRecord): void {
  writeFileAtomically(activationRecordPath(base), serializeOrcadActivationRecord(record), {
    mode: 0o600
  })
}

function runShell(command: string): string {
  const result = runProcessSync({ program: '/bin/sh', args: ['-c', command], timeoutMs: 600_000 })
  return result.stdout
}

function snapshotDirPath(base: string, dirName: string): string {
  return join(base, ORCAD_STATE_SNAPSHOT_DIR, dirName)
}

export type HostPendingActivation = {
  candidate: string
  outgoing: string | null
  snapshot: OrcadStateSnapshot | null
}

/** Capture the pre-activation snapshot. Call only after the outgoing orcad has exited. */
export function captureHostSnapshot(input: {
  base: string
  dataRoot: string
  candidate: string
  outgoing: string | null
  now: Date
}): HostPendingActivation {
  const dirName = orcadSnapshotDirName(input.candidate, input.now.getTime())
  const capture = parseOrcadSnapshotCapture(
    runShell(
      captureOrcadStateSnapshotCommand(
        LOCAL_POSIX_HOST,
        input.dataRoot,
        snapshotDirPath(input.base, dirName)
      )
    )
  )
  if (capture === 'failed') {
    throw new Error(
      `Could not snapshot ${input.dataRoot} before activating ${input.candidate}; refusing to ` +
        'activate without a way back.'
    )
  }
  const pending: HostPendingActivation = {
    candidate: input.candidate,
    outgoing: input.outgoing,
    snapshot:
      capture === 'empty'
        ? null
        : {
            dirName,
            takenBeforeVersion: input.candidate,
            readableByVersion: input.outgoing,
            takenAt: input.now.toISOString()
          }
  }
  writeFileAtomically(
    join(input.base, HOST_PENDING_ACTIVATION_FILENAME),
    `${JSON.stringify(pending)}\n`,
    { mode: 0o600 }
  )
  return pending
}

export function readPendingActivation(base: string): HostPendingActivation | null {
  const path = join(base, HOST_PENDING_ACTIVATION_FILENAME)
  if (!existsSync(path)) {
    return null
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} is not a pending activation`)
  }
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(parsed))
  const { candidate, outgoing, snapshot } = fields
  if (typeof candidate !== 'string') {
    throw new Error(`${path} names no candidate version`)
  }
  // Reuse the record parser's snapshot validation instead of trusting the file's fields.
  const record = parseOrcadActivationRecord(
    JSON.stringify({ ...emptyOrcadActivationRecord(), snapshot })
  )
  return {
    candidate,
    outgoing: typeof outgoing === 'string' ? outgoing : null,
    snapshot: record.state === 'ok' ? record.record.snapshot : null
  }
}

export function clearPendingActivation(base: string): void {
  rmSync(join(base, HOST_PENDING_ACTIVATION_FILENAME), { force: true })
}

/** After a rejected candidate: may the incumbent start against the current state? */
export function stateUnchangedSinceSnapshot(input: {
  base: string
  dataRoot: string
  snapshot: OrcadStateSnapshot | null
}): boolean {
  if (!input.snapshot) {
    // Nothing was captured because the root held no state; any state now is new.
    return !ORCAD_SNAPSHOT_MEMBERS.some((member) => existsSync(join(input.dataRoot, member)))
  }
  return orcadSnapshotIsUnchanged(
    runShell(
      compareOrcadStateSnapshotCommand(
        LOCAL_POSIX_HOST,
        input.dataRoot,
        snapshotDirPath(input.base, input.snapshot.dirName)
      )
    )
  )
}

export function snapshotPresent(base: string, snapshot: OrcadStateSnapshot | null): boolean {
  if (!snapshot) {
    return false
  }
  try {
    return statSync(join(snapshotDirPath(base, snapshot.dirName), 'state.tar')).isFile()
  } catch {
    return false
  }
}

/** `null` when unknown, which rollback assessment treats as "yes, there were writes". */
export function stateWrittenSince(dataRoot: string, activatedAt: string | null): boolean | null {
  const activatedAtSeconds = activatedAt ? Math.floor(Date.parse(activatedAt) / 1000) : Number.NaN
  if (!Number.isFinite(activatedAtSeconds)) {
    return null
  }
  const newest = parseNewestStateMtimeSeconds(
    runShell(newestStateMtimeCommand(LOCAL_POSIX_HOST, dataRoot))
  )
  return newest === null ? null : newest >= activatedAtSeconds
}

export function restoreHostSnapshot(input: {
  base: string
  dataRoot: string
  snapshot: OrcadStateSnapshot
}): 'restored' | 'missing' | 'failed' {
  return parseOrcadSnapshotRestore(
    runShell(
      restoreOrcadStateSnapshotCommand(
        LOCAL_POSIX_HOST,
        input.dataRoot,
        snapshotDirPath(input.base, input.snapshot.dirName)
      )
    )
  )
}
