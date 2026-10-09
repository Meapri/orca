import { beforeEach, describe, expect, it, vi } from 'vitest'

const closeTab = vi.fn()
let tabsByWorktree: Record<string, { id: string }[]> = {}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ tabsByWorktree, closeTab }) }
}))

const { dropHostRetiredLocalTerminalTab } = await import('./host-retired-terminal-tab')

describe('dropHostRetiredLocalTerminalTab', () => {
  beforeEach(() => {
    closeTab.mockReset()
    tabsByWorktree = { wt: [{ id: 'tab-stale' }, { id: 'tab-live' }] }
  })

  it('closes only the refused tab, locally, without a second host close', async () => {
    dropHostRetiredLocalTerminalTab('tab-stale')
    expect(closeTab).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(closeTab).toHaveBeenCalledTimes(1)
    expect(closeTab).toHaveBeenCalledWith('tab-stale', {
      reason: 'cleanup',
      remoteCloseOwnedByHost: true,
      localPtyTeardownOwnedExternally: true,
      captureRecentlyClosed: false
    })
  })

  it('does nothing when the tab is already gone locally', async () => {
    tabsByWorktree = { wt: [{ id: 'tab-live' }] }
    dropHostRetiredLocalTerminalTab('tab-stale')
    await Promise.resolve()
    expect(closeTab).not.toHaveBeenCalled()
  })
})
