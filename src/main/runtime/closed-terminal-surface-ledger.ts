/**
 * Host-owned record of terminal surfaces a close retired, so no client can bring them back.
 *
 * Every paired client restores its own copy of the workspace (the desktop from its local profile,
 * which can be weeks old) and re-mounts those panes by asking the host to create a terminal at the
 * tab/leaf ids it remembers. The host otherwise adopts any well-formed hinted id, so a client that
 * was offline when another client closed the tab resurrects it. Tab and leaf ids are uuids and a
 * closed id never legitimately returns, so an entry here is a final refusal for that id.
 *
 * Entries carry a host-issued monotonic revision. Retention is bounded (TTL + cap, the same policy
 * as the client's own tombstones); `horizonRevision` names the newest evicted entry so a reader can
 * tell "never closed" from "closed before the ledger's memory".
 */
import { z } from 'zod'
import {
  CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS,
  pruneClosedTerminalTabTombstones
} from '../../shared/closed-terminal-tab-tombstones'

export const CLOSED_TERMINAL_SURFACE_LEDGER_SCHEMA_VERSION = 1 as const
export const MAX_CLOSED_TERMINAL_SURFACE_LEDGER_ENTRIES = 4096

export type ClosedTerminalSurfaceCause = 'tab-close' | 'pane-close' | 'workspace-removed'

export type ClosedTerminalSurfaceEntry = {
  closedAt: number
  worktreeId: string
  revision: number
  cause: ClosedTerminalSurfaceCause
}

const entrySchema = z.object({
  closedAt: z.number().int().nonnegative(),
  worktreeId: z.string().min(1),
  revision: z.number().int().positive(),
  cause: z.enum(['tab-close', 'pane-close', 'workspace-removed']).catch('tab-close')
})

const ledgerFileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  horizonRevision: z.number().int().nonnegative(),
  tabs: z.record(z.string(), entrySchema),
  panes: z.record(z.string(), entrySchema)
})

type LedgerState = z.infer<typeof ledgerFileSchema>

/** Where the ledger survives a restart. `null` read means absent; a throw from write is logged. */
export type ClosedTerminalSurfaceLedgerStorage = {
  read: () => string | null
  write: (serialized: string) => void
}

export type RetiredTerminalSurfaceMatch = ClosedTerminalSurfaceEntry & {
  scope: 'tab' | 'pane'
}

function emptyState(): LedgerState {
  return {
    schemaVersion: CLOSED_TERMINAL_SURFACE_LEDGER_SCHEMA_VERSION,
    revision: 0,
    horizonRevision: 0,
    tabs: {},
    panes: {}
  }
}

export class ClosedTerminalSurfaceLedger {
  private state: LedgerState | null = null
  // Why: a file written by a newer schema is honored for refusals but never overwritten.
  private readOnly = false

  constructor(
    private readonly storage: ClosedTerminalSurfaceLedgerStorage | null,
    private readonly now: () => number = Date.now,
    private readonly limit: number = MAX_CLOSED_TERMINAL_SURFACE_LEDGER_ENTRIES
  ) {}

  getRevision(): number {
    return this.load().revision
  }

  getHorizonRevision(): number {
    return this.load().horizonRevision
  }

  recordClosedTabs(
    worktreeId: string,
    tabIds: Iterable<string>,
    cause: Exclude<ClosedTerminalSurfaceCause, 'pane-close'> = 'tab-close'
  ): number | null {
    const keys = [...new Set(tabIds)].filter((tabId) => tabId.length > 0)
    return this.record('tabs', worktreeId, keys, cause)
  }

  recordClosedPane(worktreeId: string, tabId: string, leafId: string): number | null {
    return this.record('panes', worktreeId, [paneLedgerKey(tabId, leafId)], 'pane-close')
  }

  /** Tombstones what a committed session-tab close removed: the whole tab, or one split leaf. */
  recordSessionTabClose(
    worktreeId: string,
    tab: { type: string; parentTabId?: string; leafId?: string },
    closedTabIds: readonly string[]
  ): void {
    if (tab.type !== 'terminal' || !tab.parentTabId || !tab.leafId) {
      return
    }
    if (closedTabIds.includes(tab.parentTabId)) {
      this.recordClosedTabs(worktreeId, [tab.parentTabId])
    } else {
      this.recordClosedPane(worktreeId, tab.parentTabId, tab.leafId)
    }
  }

  findRetiredSurface(tabId: string, leafId?: string | null): RetiredTerminalSurfaceMatch | null {
    const state = this.load()
    const now = this.now()
    const tab = state.tabs[tabId]
    if (tab && isRetained(tab, now)) {
      return { ...tab, scope: 'tab' }
    }
    if (!leafId) {
      return null
    }
    const pane = state.panes[paneLedgerKey(tabId, leafId)]
    return pane && isRetained(pane, now) ? { ...pane, scope: 'pane' } : null
  }

  private record(
    table: 'tabs' | 'panes',
    worktreeId: string,
    keys: readonly string[],
    cause: ClosedTerminalSurfaceCause
  ): number | null {
    if (keys.length === 0) {
      return null
    }
    const state = this.load()
    const closedAt = this.now()
    const revision = state.revision + 1
    const nextTable = { ...state[table] }
    for (const key of keys) {
      nextTable[key] = { closedAt, worktreeId, revision, cause }
    }
    this.state = this.prune({ ...state, revision, [table]: nextTable }, closedAt)
    this.persist()
    return revision
  }

  private prune(state: LedgerState, now: number): LedgerState {
    const tabs = pruneClosedTerminalTabTombstones(state.tabs, now, this.limit)
    const panes = pruneClosedTerminalTabTombstones(state.panes, now, this.limit)
    let horizonRevision = state.horizonRevision
    for (const [table, kept] of [
      [state.tabs, tabs],
      [state.panes, panes]
    ] as const) {
      for (const [key, entry] of Object.entries(table)) {
        if (!(key in kept)) {
          horizonRevision = Math.max(horizonRevision, entry.revision)
        }
      }
    }
    return { ...state, tabs, panes, horizonRevision }
  }

  private load(): LedgerState {
    if (this.state) {
      return this.state
    }
    this.state = this.readStored() ?? emptyState()
    return this.state
  }

  private readStored(): LedgerState | null {
    let raw: string | null
    try {
      raw = this.storage?.read() ?? null
    } catch (error) {
      // Why read-only: a transient read failure must not let the next close overwrite the file.
      this.readOnly = true
      console.warn('[closed-surface-ledger] unreadable; fencing in memory only:', error)
      return null
    }
    if (raw === null) {
      return null
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      console.warn('[closed-surface-ledger] corrupt file; starting empty')
      return null
    }
    const version = z.object({ schemaVersion: z.number() }).safeParse(json)
    this.readOnly =
      version.success && version.data.schemaVersion > CLOSED_TERMINAL_SURFACE_LEDGER_SCHEMA_VERSION
    const parsed = ledgerFileSchema.safeParse(json)
    if (!parsed.success) {
      console.warn('[closed-surface-ledger] unrecognized file; starting empty')
      return null
    }
    return parsed.data
  }

  private persist(): void {
    if (!this.storage || this.readOnly || !this.state) {
      return
    }
    try {
      this.storage.write(JSON.stringify(this.state))
    } catch (error) {
      // Why: the in-memory entry still fences this run; losing durability only reopens the pre-fix gap.
      console.error('[closed-surface-ledger] failed to persist:', error)
    }
  }
}

function isRetained(entry: ClosedTerminalSurfaceEntry, now: number): boolean {
  return now - entry.closedAt <= CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS
}

// Why not makePaneKey: that throws on non-uuid leaves, and a lookup must never throw.
function paneLedgerKey(tabId: string, leafId: string): string {
  return `${tabId}\0${leafId}`
}
