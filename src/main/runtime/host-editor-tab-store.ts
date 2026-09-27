/**
 * Host-owned editor tabs (file, markdown, diff) for a runtime with no desktop renderer.
 *
 * On the desktop the renderer owns editor tabs and publishes them over session.tabs; a headless
 * host (orcad, `orca serve`) has no renderer, so it keeps its own list here and publishes it on the
 * same channel. Ids are host-minted uuids that never return once closed, so the closed-surface
 * ledger can refuse a stale copy of one (see docs/reference/multi-client-state-authority.md).
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DurableTextFileStorage } from './durable-text-file-storage'

export const HOST_EDITOR_TAB_STORE_SCHEMA_VERSION = 1 as const
export const MAX_HOST_EDITOR_TABS = 512

const recordSchema = z.object({
  id: z.string().min(1),
  worktreeId: z.string().min(1),
  relativePath: z.string().min(1),
  filePath: z.string().min(1),
  view: z.enum(['markdown', 'file']),
  mode: z.enum(['edit', 'diff']),
  diffSource: z.enum(['staged', 'unstaged']).optional(),
  language: z.string(),
  openedAt: z.number().int().nonnegative()
})

const storeFileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  tabs: z.array(z.unknown())
})

export type HostEditorTabRecord = z.infer<typeof recordSchema>

export type HostEditorTabOpenRequest = Omit<HostEditorTabRecord, 'id' | 'openedAt'>

export type HostEditorTabStoreOptions = {
  /** A closed id never reopens; the ledger answers this for ids a crash left in the file. */
  isRetired?: (tabId: string) => boolean
  now?: () => number
  mintId?: () => string
}

function sameEditorSurface(
  record: HostEditorTabRecord,
  request: HostEditorTabOpenRequest
): boolean {
  return (
    record.worktreeId === request.worktreeId &&
    record.relativePath === request.relativePath &&
    record.view === request.view &&
    record.mode === request.mode &&
    record.diffSource === request.diffSource
  )
}

export class HostEditorTabStore {
  private tabs: HostEditorTabRecord[] | null = null
  // Why: a file from a newer schema is left untouched rather than replaced by this build's view.
  private readOnly = false
  private readonly isRetired: (tabId: string) => boolean
  private readonly now: () => number
  private readonly mintId: () => string

  constructor(
    private readonly storage: DurableTextFileStorage | null,
    options: HostEditorTabStoreOptions = {}
  ) {
    this.isRetired = options.isRetired ?? (() => false)
    this.now = options.now ?? Date.now
    this.mintId = options.mintId ?? randomUUID
  }

  list(worktreeId: string): HostEditorTabRecord[] {
    return this.load().filter((tab) => tab.worktreeId === worktreeId && !this.isRetired(tab.id))
  }

  hasTabs(worktreeId?: string): boolean {
    return this.load().some(
      (tab) =>
        (worktreeId === undefined || tab.worktreeId === worktreeId) && !this.isRetired(tab.id)
    )
  }

  worktreeIds(): string[] {
    return [
      ...new Set(
        this.load()
          .filter((tab) => !this.isRetired(tab.id))
          .map((tab) => tab.worktreeId)
      )
    ]
  }

  find(worktreeId: string, tabId: string): HostEditorTabRecord | null {
    return this.list(worktreeId).find((tab) => tab.id === tabId) ?? null
  }

  /** Opening a surface that is already open returns that tab, like the desktop editor does. */
  open(request: HostEditorTabOpenRequest): { tab: HostEditorTabRecord; created: boolean } {
    const existing = this.list(request.worktreeId).find((tab) => sameEditorSurface(tab, request))
    if (existing) {
      return { tab: existing, created: false }
    }
    const tab: HostEditorTabRecord = { ...request, id: this.mintId(), openedAt: this.now() }
    // Why: newest kept — the cap only bounds a file no client ever prunes.
    this.commit([...this.load(), tab].slice(-MAX_HOST_EDITOR_TABS))
    return { tab, created: true }
  }

  close(worktreeId: string, tabId: string): HostEditorTabRecord | null {
    const tabs = this.load()
    const closed = tabs.find((tab) => tab.worktreeId === worktreeId && tab.id === tabId)
    if (!closed) {
      return null
    }
    this.commit(tabs.filter((tab) => tab !== closed))
    return closed
  }

  /** Drops every tab of a removed workspace; answers the ids it dropped. */
  forgetWorktree(worktreeId: string): string[] {
    const tabs = this.load()
    const forgotten = tabs.filter((tab) => tab.worktreeId === worktreeId)
    if (forgotten.length > 0) {
      this.commit(tabs.filter((tab) => tab.worktreeId !== worktreeId))
    }
    return forgotten.map((tab) => tab.id)
  }

  private commit(next: HostEditorTabRecord[]): void {
    const previous = this.tabs
    this.tabs = next
    if (!this.storage || this.readOnly) {
      return
    }
    try {
      this.storage.write(
        `${JSON.stringify({ schemaVersion: HOST_EDITOR_TAB_STORE_SCHEMA_VERSION, tabs: next })}\n`
      )
    } catch (error) {
      // Why: an open or close the host could not make durable must not be acknowledged.
      this.tabs = previous
      throw error
    }
  }

  private load(): HostEditorTabRecord[] {
    if (this.tabs) {
      return this.tabs
    }
    this.tabs = this.readStored()
    return this.tabs
  }

  private readStored(): HostEditorTabRecord[] {
    let serialized: string | null
    try {
      serialized = this.storage?.read() ?? null
    } catch (error) {
      console.warn('[host-editor-tabs] could not read the tab file; keeping it untouched', error)
      this.readOnly = true
      return []
    }
    if (serialized === null) {
      return []
    }
    let parsed: z.infer<typeof storeFileSchema>
    try {
      parsed = storeFileSchema.parse(JSON.parse(serialized))
    } catch (error) {
      console.warn('[host-editor-tabs] unreadable tab file; keeping it untouched', error)
      this.readOnly = true
      return []
    }
    if (parsed.schemaVersion > HOST_EDITOR_TAB_STORE_SCHEMA_VERSION) {
      this.readOnly = true
      return []
    }
    // A malformed row is dropped on its own; one bad row must not lose every open tab.
    return parsed.tabs.flatMap((row) => {
      const record = recordSchema.safeParse(row)
      return record.success && !this.isRetired(record.data.id) ? [record.data] : []
    })
  }
}
