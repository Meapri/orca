import { useAppStore } from '@/store'

/**
 * Converges a restored local tab onto the host's view after the host refused it as closed.
 *
 * The refusal (`TERMINAL_SURFACE_RETIRED_ERROR`) means another client closed this tab while this one
 * was away, so this client's copy is the only place it still exists. Close it locally only — the
 * host already retired it, and a second close RPC would just be refused.
 */
export function dropHostRetiredLocalTerminalTab(tabId: string): void {
  // Why deferred: the refusal lands inside this pane's own connect; closing now would unmount it mid-call.
  queueMicrotask(() => {
    const state = useAppStore.getState()
    const stillLocal = Object.values(state.tabsByWorktree).some((tabs) =>
      tabs.some((tab) => tab.id === tabId)
    )
    if (!stillLocal) {
      return
    }
    state.closeTab(tabId, {
      reason: 'cleanup',
      remoteCloseOwnedByHost: true,
      localPtyTeardownOwnedExternally: true,
      captureRecentlyClosed: false
    })
  })
}
