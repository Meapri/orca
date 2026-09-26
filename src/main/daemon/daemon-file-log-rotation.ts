// Size-based rotation for a log file that several processes may append to at once.
//
// Why cross-process: every daemon generation (the current one plus any legacy protocol
// daemons kept alive for their sessions) is launched with the same `--log-file`, so a
// per-process byte counter undercounts the shared file and each writer would rotate
// on its own schedule. The on-disk size is the only count all writers agree on, and a
// short-lived lock file keeps two writers from cascading the same generation twice.

import { closeSync, existsSync, openSync, renameSync, statSync, unlinkSync } from 'node:fs'

/** A rotation takes a handful of renames; a lock older than this belongs to a writer
 *  that died mid-rotation and would otherwise block rotation forever. */
export const ROTATION_LOCK_STALE_MS = 10_000

export type RotationOutcome = 'rotated' | 'not-needed' | 'lock-held'

export function rotationLockPath(filePath: string): string {
  return `${filePath}.rotate-lock`
}

function currentFileSize(filePath: string): number {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

/** Exclusive-create the lock; reclaim it once when its holder is evidently gone. */
function acquireRotationLock(lockPath: string, now: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600))
      return true
    } catch (error) {
      const exists =
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
      if (!exists || attempt > 0) {
        return false
      }
    }
    try {
      if (now - statSync(lockPath).mtimeMs < ROTATION_LOCK_STALE_MS) {
        return false
      }
      unlinkSync(lockPath)
    } catch {
      // The holder released it between the failed create and here; retry the create once.
    }
  }
  return false
}

function releaseRotationLock(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch {
    // A stale-lock reclaim by another writer already removed it.
  }
}

function cascadeRotatedFiles(filePath: string, maxRotatedFiles: number): void {
  for (let i = maxRotatedFiles; i >= 1; i--) {
    const src = i === 1 ? filePath : `${filePath}.${i - 1}`
    const dst = `${filePath}.${i}`
    if (!existsSync(src)) {
      continue
    }
    if (existsSync(dst)) {
      unlinkSync(dst)
    }
    renameSync(src, dst)
  }
}

/**
 * Rotate `filePath` when appending `incomingBytes` would push the shared file past
 * `maxBytes`. Throws only on a filesystem failure inside the cascade, which the caller
 * treats like any other write failure.
 */
export function rotateSharedLogIfNeeded(options: {
  filePath: string
  incomingBytes: number
  maxBytes: number
  maxRotatedFiles: number
  now?: number
}): RotationOutcome {
  const { filePath, incomingBytes, maxBytes, maxRotatedFiles } = options
  const size = currentFileSize(filePath)
  // Why size > 0: one line larger than the cap must still land somewhere.
  if (maxRotatedFiles < 1 || size === 0 || size + incomingBytes <= maxBytes) {
    return 'not-needed'
  }
  const lockPath = rotationLockPath(filePath)
  if (!acquireRotationLock(lockPath, options.now ?? Date.now())) {
    // Another writer is rotating right now; appending to whichever file is current is safe.
    return 'lock-held'
  }
  try {
    // Re-check under the lock: the writer that just released it may already have rotated.
    const lockedSize = currentFileSize(filePath)
    if (lockedSize === 0 || lockedSize + incomingBytes <= maxBytes) {
      return 'not-needed'
    }
    cascadeRotatedFiles(filePath, maxRotatedFiles)
    return 'rotated'
  } finally {
    releaseRotationLock(lockPath)
  }
}
