import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { HostEditorTabRecord } from './host-editor-tab-store'
import { appendBrowserTabOrder } from './mobile-session-browser-group-projection'
import { getHeadlessMobileSessionGroupId } from './mobile-session-layout-projection'
import { mobileSnapshotValueEqual } from './mobile-session-snapshot-equality'

export type HostEditorSessionTab = RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab

export function isEditorSessionTab(
  tab: RuntimeMobileSessionSnapshotTab
): tab is HostEditorSessionTab {
  return tab.type === 'markdown' || tab.type === 'file'
}

function editorTabTitle(relativePath: string, fallback: string): string {
  return relativePath.split(/[\\/]/).pop() || relativePath || fallback
}

/** The same session-tab rows the desktop renderer publishes for an open editor file. */
export function projectHostEditorTab(
  record: HostEditorTabRecord,
  documentVersion: string | undefined
): HostEditorSessionTab {
  if (record.view === 'markdown') {
    return {
      type: 'markdown',
      id: record.id,
      title: editorTabTitle(record.relativePath, 'Markdown'),
      filePath: record.filePath,
      relativePath: record.relativePath,
      language: 'markdown',
      mode: 'edit',
      isDirty: false,
      isActive: false,
      // Why: the desktop's editor file id is its path; mirroring clients key their open file on it.
      sourceFileId: record.filePath,
      sourceFilePath: record.filePath,
      sourceRelativePath: record.relativePath,
      documentVersion: documentVersion ?? `file:${record.filePath}`,
      color: null,
      isPinned: false
    }
  }
  return {
    type: 'file',
    id: record.id,
    title: editorTabTitle(record.relativePath, 'File'),
    filePath: record.filePath,
    relativePath: record.relativePath,
    language: record.language,
    mode: record.mode,
    ...(record.diffSource ? { diffSource: record.diffSource } : {}),
    isDirty: false,
    color: null,
    isPinned: false,
    isActive: false
  }
}

/**
 * Merges the host's live editor tabs into a snapshot, or returns null when nothing changed. A row
 * the host retired is dropped; an editor row the host never minted (a renderer's) is left alone.
 */
export function reconcileHostEditorTabsIntoSnapshot(
  existing: RuntimeMobileSessionTabsSnapshot,
  live: readonly HostEditorSessionTab[],
  isRetired: (tabId: string) => boolean
): RuntimeMobileSessionTabsSnapshot | null {
  const existingEditorTabs = existing.tabs.filter(isEditorSessionTab)
  const previousById = new Map(existingEditorTabs.map((tab) => [tab.id, tab]))
  // Why: color/pin are applied to the snapshot by session.tabs.setTabProps, not stored per record.
  const liveById = new Map(
    live.map((tab) => {
      const previous = previousById.get(tab.id)
      return [
        tab.id,
        previous
          ? { ...tab, color: previous.color ?? null, isPinned: previous.isPinned === true }
          : tab
      ]
    })
  )
  // Keep the snapshot's order so a pure rebuild never reads as a change.
  const retainedInOrder = existingEditorTabs.flatMap((tab) => {
    const next = liveById.get(tab.id)
    if (next && liveById.delete(tab.id)) {
      return [next]
    }
    return isRetired(tab.id) ? [] : [tab]
  })
  const liveEditorTabs = [...retainedInOrder, ...liveById.values()]
  if (mobileSnapshotValueEqual(liveEditorTabs, existingEditorTabs)) {
    return null
  }
  const liveIds = new Set(liveEditorTabs.map((tab) => tab.id))
  const closedIds = new Set(
    existingEditorTabs.map((tab) => tab.id).filter((id) => !liveIds.has(id))
  )
  const nextTabs: RuntimeMobileSessionSnapshotTab[] = [
    ...existing.tabs.filter((tab) => !isEditorSessionTab(tab)),
    ...liveEditorTabs
  ]
  const groups = (existing.tabGroups ?? []).map((group) => ({
    ...group,
    tabOrder: group.tabOrder.filter((id) => !closedIds.has(id)),
    activeTabId:
      group.activeTabId !== null && closedIds.has(group.activeTabId) ? null : group.activeTabId
  }))
  const topLevelOrder = [
    ...new Set(nextTabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id)))
  ]
  const tabGroups =
    groups.length > 0
      ? appendBrowserTabOrder(groups, [...liveIds])
      : [
          {
            id: getHeadlessMobileSessionGroupId(existing.worktree),
            activeTabId: topLevelOrder[0] ?? null,
            tabOrder: topLevelOrder
          }
        ]
  const activeStillPresent = nextTabs.some((tab) => tab.id === existing.activeTabId)
  const active = activeStillPresent
    ? null
    : (nextTabs.find((tab) => tab.isActive) ?? nextTabs[0] ?? null)
  return {
    ...existing,
    snapshotVersion: existing.snapshotVersion + 1,
    ...(activeStillPresent
      ? {}
      : { activeTabId: active?.id ?? null, activeTabType: active?.type ?? null }),
    tabGroups,
    tabs: nextTabs
  }
}
