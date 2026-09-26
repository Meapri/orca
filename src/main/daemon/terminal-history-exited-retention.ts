/**
 * Bounded retention for terminal history whose PTY has exited.
 *
 * An exited session's tree (checkpoint + incremental log, up to hundreds of MB) is only
 * removed when its pane is closed through Orca. A host whose clients never close panes —
 * agents that finish and are abandoned, a client that is gone for good — kept every one
 * forever. Nothing reads that tree once `endedAt` is written (cold restore requires a
 * session that did not end cleanly), so collecting it only costs the scrollback of a
 * terminal whose process is gone.
 */
import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import { readTerminalHistoryMeta } from './terminal-history-metadata'
import { isTerminalHistoryQuarantineEntry } from './terminal-history-recovery-quarantine'
import {
  isTerminalHistoryPendingDeleteEntry,
  removeTerminalHistorySessionTrees
} from './terminal-history-session-tombstone'
import {
  selectExitedHistoryForCollection,
  type ExitedHistoryCandidate,
  type ExitedHistoryRetentionPolicy
} from './terminal-history-exited-retention-policy'

const YIELD_EVERY_ENTRIES = 32
// Why a depth bound: a session tree is flat (meta, checkpoint, log); anything deeper is not ours.
const MAX_TREE_DEPTH = 4

export type ExitedHistoryRetentionResult = {
  scanned: number
  exited: number
  /** Sessions kept because their state cannot be proven exited from disk. */
  unverifiable: number
  collected: number
  collectedBytes: number
}

export type ExitedHistoryRetentionOptions = {
  basePath: string
  policy: ExitedHistoryRetentionPolicy
  /** True while any daemon adapter in this process still writes the session. */
  isSessionInUse: (sessionId: string) => boolean
  now?: number
  removeSessionTrees?: (basePath: string, sessionId: string) => Promise<void>
}

async function treeBytes(path: string, depth = 0): Promise<number> {
  let entries: Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory() && depth < MAX_TREE_DEPTH) {
      total += await treeBytes(entryPath, depth + 1)
    } else if (entry.isFile()) {
      try {
        total += (await lstat(entryPath)).size
      } catch {
        // Removed concurrently; it no longer counts.
      }
    }
  }
  return total
}

function decodeSessionId(entryName: string): string | null {
  try {
    return decodeURIComponent(entryName)
  } catch {
    return null
  }
}

export async function collectExitedTerminalHistory(
  options: ExitedHistoryRetentionOptions
): Promise<ExitedHistoryRetentionResult> {
  const now = options.now ?? Date.now()
  const result: ExitedHistoryRetentionResult = {
    scanned: 0,
    exited: 0,
    unverifiable: 0,
    collected: 0,
    collectedBytes: 0
  }
  let entries: Dirent[]
  try {
    entries = await readdir(options.basePath, { withFileTypes: true })
  } catch {
    return result
  }
  const candidates: ExitedHistoryCandidate[] = []
  for (const [index, entry] of entries.entries()) {
    if (index % YIELD_EVERY_ENTRIES === YIELD_EVERY_ENTRIES - 1) {
      await yieldToEventLoop()
    }
    if (
      !entry.isDirectory() ||
      isTerminalHistoryQuarantineEntry(entry.name) ||
      isTerminalHistoryPendingDeleteEntry(entry.name)
    ) {
      continue
    }
    const sessionId = decodeSessionId(entry.name)
    if (!sessionId) {
      continue
    }
    result.scanned++
    const read = readTerminalHistoryMeta(options.basePath, sessionId)
    if (read.status !== 'readable') {
      // Missing or unreadable meta cannot prove anything; recovery may still want it.
      result.unverifiable++
      continue
    }
    const { endedAt, exitCode } = read.meta
    const endedAtMs = endedAt === null ? Number.NaN : Date.parse(endedAt)
    if (typeof exitCode !== 'number' || !Number.isFinite(endedAtMs)) {
      result.unverifiable++
      continue
    }
    if (options.isSessionInUse(sessionId)) {
      continue
    }
    result.exited++
    candidates.push({
      sessionId,
      endedAtMs,
      bytes: await treeBytes(join(options.basePath, entry.name))
    })
  }
  const bytesBySession = new Map(candidates.map((entry) => [entry.sessionId, entry.bytes]))
  const removeTrees = options.removeSessionTrees ?? removeTerminalHistorySessionTrees
  for (const sessionId of selectExitedHistoryForCollection(candidates, options.policy, now)) {
    // Why re-checked: a reattach can open a writer between the scan and this removal.
    if (options.isSessionInUse(sessionId)) {
      continue
    }
    try {
      await removeTrees(options.basePath, sessionId)
      result.collected++
      result.collectedBytes += bytesBySession.get(sessionId) ?? 0
    } catch (error) {
      console.warn(
        '[history:retention] failed to collect exited session:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  return result
}
