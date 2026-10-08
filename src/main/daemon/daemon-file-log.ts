// Append-only NDJSON logger for the detached daemon process. The daemon runs
// out-of-process with stdio 'ignore', so console output goes nowhere; this
// writes lifecycle events to a rotated file under the app's logs directory so
// they land in diagnostic bundles (windows-terminal-update-survival-plan.md
// §Phase 0). Never log terminal input/output content or tokens.
//
// Two hard constraints:
//   1. FAIL-OPEN. Any error (EACCES, ENOSPC, bad path) suspends logging and is
//      swallowed — logging must never throw into daemon lifecycle logic or
//      affect startup/shutdown.
//   2. Best-effort durability. Each line is a single synchronous appendFileSync
//      so a process death mid-write can lose at most the last (partial) line;
//      NDJSON readers skip a truncated trailing line.
//
// Rotation reads the shared file's real size rather than a per-process counter,
// because every daemon generation appends to the same path (see
// daemon-file-log-rotation.ts). The bound therefore holds across restarts and
// concurrent writers: at most (maxRotatedFiles + 1) files of ~maxBytes each.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { rotateSharedLogIfNeeded } from './daemon-file-log-rotation'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const DEFAULT_MAX_ROTATED_FILES = 2 // daemon.log + daemon.log.1 + daemon.log.2
const PRIVATE_FILE_MODE = 0o600
// Why suspend rather than disable: a full disk on a small VPS is usually freed by an
// operator within minutes, and a daemon that lives for weeks should log again after.
export const DAEMON_LOG_FAILURE_BACKOFF_MS = 60_000

/** Total files in the rotated daemon-log family (active + rotated). The bundle
 *  collector passes this to `listRotatedFiles` so it reads every rotated file. */
export const DAEMON_LOG_MAX_FILES = DEFAULT_MAX_ROTATED_FILES + 1

export type DaemonFileLog = {
  /** Append one lifecycle event. Terse fields only — never user data. */
  log(event: string, details?: Record<string, unknown>): void
  /** Best-effort marker that no further writes are expected. */
  close(): void
}

export type DaemonFileLogOptions = {
  readonly maxBytes?: number
  readonly maxRotatedFiles?: number
  /** Clock seam for the failure backoff; tests only. */
  readonly now?: () => number
}

/** No-op logger used when the daemon was launched without `--log-file` (adopted
 *  old daemons, tests). Keeps every call site unconditional. */
export function createNoopDaemonFileLog(): DaemonFileLog {
  return {
    log() {},
    close() {}
  }
}

export function createDaemonFileLog(
  filePath: string,
  opts: DaemonFileLogOptions = {}
): DaemonFileLog {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRotatedFiles = opts.maxRotatedFiles ?? DEFAULT_MAX_ROTATED_FILES
  const now = opts.now ?? Date.now

  let closed = false
  let suspendedUntil = 0
  let directoryReady = false

  function suspend(): void {
    suspendedUntil = now() + DAEMON_LOG_FAILURE_BACKOFF_MS
    // Why re-ensure after a failure: an operator may have removed the logs dir to free space.
    directoryReady = false
  }

  function ensureDirectory(): boolean {
    if (directoryReady) {
      return true
    }
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      directoryReady = true
      return true
    } catch {
      suspend()
      return false
    }
  }

  ensureDirectory()

  function log(event: string, details: Record<string, unknown> = {}): void {
    if (closed || now() < suspendedUntil) {
      return
    }
    let line: string
    try {
      line = `${JSON.stringify({
        src: 'daemon',
        ts: new Date().toISOString(),
        pid: process.pid,
        event,
        ...details
      })}\n`
    } catch {
      // Non-serializable detail (circular ref) — drop the line, never crash.
      return
    }
    if (!ensureDirectory()) {
      return
    }
    try {
      rotateSharedLogIfNeeded({
        filePath,
        incomingBytes: Buffer.byteLength(line, 'utf8'),
        maxBytes,
        maxRotatedFiles
      })
      appendFileSync(filePath, line, { mode: PRIVATE_FILE_MODE })
    } catch {
      suspend()
    }
  }

  return {
    log,
    close(): void {
      // Best-effort marker; append is synchronous so there is nothing to flush.
      log('daemon-log-closed')
      closed = true
    }
  }
}
