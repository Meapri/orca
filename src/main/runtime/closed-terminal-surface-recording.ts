import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { TERMINAL_SURFACE_RETIRED_ERROR } from '../../shared/terminal-surface-retirement-refusal'
import type { ClosedTerminalSurfaceLedger } from './closed-terminal-surface-ledger'

/** Every terminal tab id the host knows for a workspace, so removing it retires them all. */
export function collectWorkspaceTerminalTabIds(
  worktreeId: string,
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
  session: WorkspaceSessionState | null | undefined
): Set<string> {
  const tabIds = new Set<string>()
  for (const tab of snapshot?.tabs ?? []) {
    if (tab.type === 'terminal') {
      tabIds.add(tab.parentTabId)
    }
  }
  for (const tab of session?.tabsByWorktree?.[worktreeId] ?? []) {
    tabIds.add(tab.id)
  }
  return tabIds
}

/** Refuses a create/adopt that would bring a retired tab or pane id back. */
export function assertTerminalSurfaceNotRetired(
  ledger: Pick<ClosedTerminalSurfaceLedger, 'findRetiredSurface'>,
  tabId: string | null | undefined,
  leafId?: string | null
): void {
  if (!tabId) {
    return
  }
  if (ledger.findRetiredSurface(tabId, leafId)) {
    throw new Error(TERMINAL_SURFACE_RETIRED_ERROR)
  }
}
