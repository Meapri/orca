// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS } from '../agent-task-complete-policy'
import { getTerminalPaneProgress } from './terminal-progress-store'

type MockAppStoreState = {
  activeWorktreeId: string | null
  activeTabId: string | null
  terminalLayoutsByTabId: Record<string, { activeLeafId: string }>
  settings: { experimentalTerminalAttention: boolean }
}

const storeState = vi.hoisted((): { current: MockAppStoreState } => ({
  current: {
    activeWorktreeId: 'wt-other',
    activeTabId: null,
    terminalLayoutsByTabId: {},
    settings: { experimentalTerminalAttention: false }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => storeState.current }
}))

const { installTerminalPaneOscNotifications } = await import('./terminal-pane-osc-notifications')

const LEAF_ID = '6f1c2a4e-0b7d-4c1e-9a55-3d2b8f0e7c11'
const PANE_KEY = `tab-1:${LEAF_ID}`

// Why real timers: xterm's write pipeline schedules on timers, so faking them stalls writes.
const waitPastGrace = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS + 20))

function setup(
  options: { replaying?: boolean; beforeInstall?: (terminal: HeadlessTerminal) => void } = {}
) {
  const headless = new HeadlessTerminal({ cols: 40, rows: 4, allowProposedApi: true })
  options.beforeInstall?.(headless)
  const container = document.createElement('div')
  const deps = {
    dispatchNotification: vi.fn(),
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn()
  }
  const disposable = installTerminalPaneOscNotifications({
    terminal: headless,
    container,
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    paneKey: PANE_KEY,
    isReplaying: () => options.replaying ?? false,
    ...deps
  })
  const write = (data: string): Promise<void> =>
    new Promise((resolve) => headless.write(data, resolve))
  return { headless, container, deps, disposable, write }
}

describe('installTerminalPaneOscNotifications', () => {
  beforeEach(() => {
    storeState.current.activeWorktreeId = 'wt-other'
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('routes OSC 9 and OSC 777 through the terminal-bell lane after the grace delay', async () => {
    const { deps, disposable, write, headless } = setup()
    await write('\x1b]9;Build done\x07\x1b]777;notify;Deploy;shipped\x1b\\')
    expect(deps.markTerminalTabUnread).toHaveBeenCalledWith('tab-1', 'terminal-bell')
    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    await waitPastGrace()
    expect(deps.dispatchNotification.mock.calls.map(([event]) => event)).toEqual([
      {
        source: 'terminal-bell',
        paneKey: PANE_KEY,
        terminalNotification: { title: null, body: 'Build done' }
      },
      {
        source: 'terminal-bell',
        paneKey: PANE_KEY,
        terminalNotification: { title: 'Deploy', body: 'shipped' }
      }
    ])
    disposable.dispose()
    headless.dispose()
  })

  it('stays quiet for the pane the user is looking at', async () => {
    storeState.current.activeWorktreeId = 'wt-1'
    storeState.current.activeTabId = 'tab-1'
    storeState.current.terminalLayoutsByTabId = { 'tab-1': { activeLeafId: LEAF_ID } }
    const { deps, disposable, write, headless } = setup()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await write('\x1b]9;hello\x07')
    await waitPastGrace()
    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    expect(deps.markWorktreeUnread).not.toHaveBeenCalled()
    disposable.dispose()
    headless.dispose()
  })

  it('ignores replayed notifications and progress', async () => {
    const { deps, disposable, write, headless } = setup({ replaying: true })
    await write('\x1b]9;old news\x07\x1b]9;4;1;50\x07')
    await waitPastGrace()
    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    expect(getTerminalPaneProgress(PANE_KEY)).toBeNull()
    disposable.dispose()
    headless.dispose()
  })

  it('leaves Orca shell markers to their own consumers', async () => {
    const other = vi.fn(() => true)
    // Why: registered first, so it only runs if the notification handler declines the sequence.
    const { deps, disposable, write, headless } = setup({
      beforeInstall: (terminal) => terminal.parser.registerOscHandler(777, other)
    })
    await write('\x1b]777;orca-shell-ready\x07\x1b]777;notify;hi\x07')
    expect(other).toHaveBeenCalledOnce()
    expect(other).toHaveBeenCalledWith('orca-shell-ready')
    expect(deps.markWorktreeUnread).toHaveBeenCalledOnce()
    disposable.dispose()
    headless.dispose()
  })

  it('draws, updates and removes the pane progress bar', async () => {
    const { container, disposable, write, headless } = setup()
    await write('\x1b]9;4;1;40\x07')
    const bar = container.querySelector<HTMLElement>('.orca-terminal-progress')
    expect(bar?.dataset.state).toBe('normal')
    expect(bar?.querySelector<HTMLElement>('.orca-terminal-progress-fill')?.style.width).toBe('40%')
    await write('\x1b]9;4;2\x07')
    expect(bar?.dataset.state).toBe('error')
    await write('\x1b]9;4;0\x07')
    expect(container.querySelector('.orca-terminal-progress')).toBeNull()
    await write('\x1b]9;4;3\x07')
    disposable.dispose()
    expect(container.querySelector('.orca-terminal-progress')).toBeNull()
    expect(getTerminalPaneProgress(PANE_KEY)).toBeNull()
    headless.dispose()
  })

  it('drops a pending notification when the pane closes first', async () => {
    const { deps, disposable, write, headless } = setup()
    await write('\x1b]9;soon\x07')
    disposable.dispose()
    await waitPastGrace()
    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    headless.dispose()
  })
})
