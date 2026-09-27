import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult
} from '../../shared/mobile-markdown-document'
import { detectLanguage } from '../../shared/editor-language-detect'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import { projectHostEditorTab, type HostEditorSessionTab } from './host-editor-tab-projection'
import type { HostEditorTabRecord, HostEditorTabStore } from './host-editor-tab-store'
import {
  readHostMarkdownTab,
  saveHostMarkdownTab,
  type HostMarkdownFileAccess
} from './host-markdown-tab-document'

export type HostEditorTabsHost = {
  /** True only while no renderer owns editor tabs; a renderer stays the owner when attached. */
  ownsEditorTabs(): boolean
  openFileAccess(worktreeId: string, filePath: string): Promise<HostMarkdownFileAccess>
  /** Rebuild the worktree's session-tabs snapshot and notify subscribers. */
  publish(worktreeId: string): void
  /** Tombstone closed ids in the closed-surface ledger before the close is acknowledged. */
  retire(worktreeId: string, tabIds: readonly string[]): void
}

export type HostEditorTabOpenInput = {
  worktreeId: string
  filePath: string
  relativePath: string
  isMarkdown: boolean
  diff?: { staged: boolean }
}

export class HostEditorTabs {
  private readonly saveQueues = new Map<string, Promise<void>>()
  // Why: bumps the published documentVersion after a host save so other viewers re-read.
  private readonly savedVersionByTabId = new Map<string, string>()

  constructor(
    private readonly store: HostEditorTabStore,
    private readonly host: HostEditorTabsHost
  ) {}

  ownsEditorTabs(): boolean {
    return this.host.ownsEditorTabs()
  }

  hasTabs(worktreeId?: string): boolean {
    return this.host.ownsEditorTabs() && this.store.hasTabs(worktreeId)
  }

  /** Workspaces holding host tabs, so a fleet-wide list reaches one with no terminal yet. */
  worktreeIds(): string[] {
    return this.host.ownsEditorTabs() ? this.store.worktreeIds() : []
  }

  sessionTabs(worktreeId: string): HostEditorSessionTab[] {
    if (!this.host.ownsEditorTabs()) {
      return []
    }
    return this.store
      .list(worktreeId)
      .map((record) => projectHostEditorTab(record, this.savedVersionByTabId.get(record.id)))
  }

  open(input: HostEditorTabOpenInput): { tabId: string } {
    const { tab, created } = this.store.open({
      worktreeId: input.worktreeId,
      filePath: input.filePath,
      relativePath: input.relativePath,
      // Why: the desktop opens a markdown diff as a diff, not as a markdown document.
      view: input.isMarkdown && !input.diff ? 'markdown' : 'file',
      mode: input.diff ? 'diff' : 'edit',
      ...(input.diff ? { diffSource: input.diff.staged ? 'staged' : 'unstaged' } : {}),
      language: input.isMarkdown ? 'markdown' : detectLanguage(input.relativePath)
    })
    if (created) {
      this.host.publish(input.worktreeId)
    }
    return { tabId: tab.id }
  }

  /** False when the id is not a host editor tab, so the caller keeps its own refusal. */
  close(worktreeId: string, tabId: string): boolean {
    if (!this.host.ownsEditorTabs() || !this.store.find(worktreeId, tabId)) {
      return false
    }
    this.host.retire(worktreeId, [tabId])
    this.store.close(worktreeId, tabId)
    this.savedVersionByTabId.delete(tabId)
    this.host.publish(worktreeId)
    return true
  }

  /** A removed workspace takes its tabs with it; ids are tombstoned so no stale client revives one. */
  forgetWorktree(worktreeId: string): void {
    const ids = this.store.list(worktreeId).map((tab) => tab.id)
    if (ids.length > 0) {
      this.host.retire(worktreeId, ids)
    }
    this.store.forgetWorktree(worktreeId)
    for (const id of ids) {
      this.savedVersionByTabId.delete(id)
    }
  }

  /** Null when the id is not a host markdown tab, so the caller keeps its own refusal. */
  async readMarkdown(
    worktreeId: string,
    tabId: string
  ): Promise<RuntimeMarkdownReadTabResult | null> {
    const tab = this.findMarkdownTab(worktreeId, tabId)
    if (!tab) {
      return null
    }
    return readHostMarkdownTab(tab, await this.host.openFileAccess(worktreeId, tab.filePath))
  }

  async saveMarkdown(
    worktreeId: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult | null> {
    const tab = this.findMarkdownTab(worktreeId, tabId)
    if (!tab) {
      return null
    }
    // Why: keyed by path, not tab — two clients saving one file must not interleave read and write.
    const saved = await runKeyedSerializedOperation(this.saveQueues, tab.filePath, async () =>
      saveHostMarkdownTab(
        tab,
        await this.host.openFileAccess(worktreeId, tab.filePath),
        baseVersion,
        content
      )
    )
    if (this.savedVersionByTabId.get(tab.id) !== saved.version) {
      this.savedVersionByTabId.set(tab.id, saved.version)
      this.host.publish(worktreeId)
    }
    return saved
  }

  private findMarkdownTab(worktreeId: string, tabId: string): HostEditorTabRecord | null {
    if (!this.host.ownsEditorTabs()) {
      return null
    }
    const tab = this.store.find(worktreeId, tabId)
    return tab?.view === 'markdown' ? tab : null
  }
}
