import { describe, expect, it, vi } from 'vitest'
import { AutomationService } from '../automations/service'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import type * as ManagedAgentHookControls from '../agent-hooks/managed-agent-hook-controls'

vi.mock('../agent-hooks/first-work-rename-runtime', () => ({ firstWorkRenameDeps: () => ({}) }))
const { diskHygiene } = vi.hoisted(() => {
  const calls: string[] = []
  return { diskHygiene: calls }
})
const { hookInstalls } = vi.hoisted(() => {
  const installs: { shouldContinue?: (agent: string) => boolean }[] = []
  return { hookInstalls: installs }
})
vi.mock('../agent-hooks/managed-agent-hook-controls', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedAgentHookControls>()),
  installManagedAgentHooks: async (
    _settings: unknown,
    options: { shouldContinue?: (agent: string) => boolean }
  ) => {
    hookInstalls.push(options)
    return []
  }
}))
vi.mock('../terminal-history-deletion', () => ({
  scheduleAllPendingHistoryTreeRemovals: () => diskHygiene.push('history')
}))
vi.mock('../terminal-history-gc', () => ({
  scheduleHistoryGc: () => diskHygiene.push('history-gc'),
  cancelHistoryGc: () => diskHygiene.push('history-gc-cancelled')
}))
vi.mock('../worktree-trash', () => ({
  collectWorktreeTrashSweepRoots: () => [],
  sweepStaleWorktreeTrash: async () => {
    diskHygiene.push('trash')
  }
}))

import { installOrcadHeadlessParity } from './orcad-headless-parity'

function makeStore() {
  return {
    getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => []),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({
      workspaceDir: '/tmp/workspaces',
      autoRenameBranchFromWork: false
    })),
    getProjects: vi.fn(() => [])
  }
}

function makeAgentHookServer() {
  const statusListeners = new Set<(event: EnrichedAgentHookEventPayload) => void>()
  const dropListeners = new Set<(paneKey: string) => void>()
  return {
    statusListeners,
    dropListeners,
    subscribeEnrichedStatus: (listener: (event: EnrichedAgentHookEventPayload) => void) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    subscribeStatusDrop: (listener: (paneKey: string) => void) => {
      dropListeners.add(listener)
      return () => dropListeners.delete(listener)
    },
    subscribePaneStatusClear: () => () => {},
    getStatusSnapshot: () => []
  }
}

function makeAccounts() {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these suites never run an automation, so no usage lookup reaches the stores.
    claudeUsage: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    codexUsage: {} as never,
    stop: vi.fn()
  }
}

describe('installOrcadHeadlessParity', () => {
  it('publishes the headless placeholder graph so session-tab RPCs stop refusing (#17846)', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore returns every read the graph publish reaches.
    const store = makeStore() as never
    const runtime = new OrcaRuntimeService(store)
    expect(runtime.getStatus().graphStatus).not.toBe('ready')

    installOrcadHeadlessParity({
      runtime,
      store,
      agentHookServer: makeAgentHookServer(),
      accounts: makeAccounts()
    })

    const status = runtime.getStatus()
    expect(status.graphStatus).toBe('ready')
    expect(status.authoritativeWindowId).toBe(HEADLESS_RUNTIME_WINDOW_ID)
  })

  it('subscribes the rename, notification and sleeping-agent consumers, and removes them on uninstall', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore returns every read the graph publish reaches.
    const store = makeStore() as never
    const server = makeAgentHookServer()

    const runtime = new OrcaRuntimeService(store)
    const setAutomationService = vi.spyOn(runtime, 'setAutomationService')
    const setResumeHost = vi.spyOn(runtime, 'setHeadlessAgentResumeHost')
    const accounts = makeAccounts()
    const parity = installOrcadHeadlessParity({ runtime, store, agentHookServer: server, accounts })
    expect(server.statusListeners.size).toBe(3)
    expect(server.dropListeners.size).toBe(1)
    expect(setAutomationService.mock.calls[0]?.[0]).toBeInstanceOf(AutomationService)
    expect(setResumeHost.mock.calls[0]?.[0]).not.toBeNull()

    parity.uninstall()
    expect(server.statusListeners.size).toBe(0)
    expect(server.dropListeners.size).toBe(0)
    expect(accounts.stop).toHaveBeenCalledOnce()
    // Why: shutdown's own PTY teardown must not reach a resume host.
    expect(setResumeHost.mock.calls.at(-1)?.[0]).toBeNull()
  })

  it('arms scheduled work only when asked, after the transport is up', async () => {
    diskHygiene.length = 0
    hookInstalls.length = 0
    vi.useFakeTimers()
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore returns every read the graph publish reaches.
      const store = {
        ...makeStore(),
        listAutomations: () => [],
        listAutomationRuns: () => []
      } as never
      const runtime = new OrcaRuntimeService(store)
      const parity = installOrcadHeadlessParity({
        runtime,
        store,
        agentHookServer: makeAgentHookServer(),
        accounts: makeAccounts()
      })
      expect(diskHygiene).toEqual([])

      expect(hookInstalls).toHaveLength(0)

      parity.startScheduledWork()
      await Promise.resolve()
      expect(diskHygiene).toEqual(['history', 'history-gc', 'trash'])
      expect(hookInstalls).toHaveLength(1)
      expect(hookInstalls[0]?.shouldContinue?.('claude')).toBe(true)
      parity.uninstall()
      expect(diskHygiene.at(-1)).toBe('history-gc-cancelled')
      // A reconcile still running at shutdown stops before its next agent.
      expect(hookInstalls[0]?.shouldContinue?.('claude')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves user-global hook config alone when agent status hooks are switched off', () => {
    hookInstalls.length = 0
    vi.useFakeTimers()
    try {
      const base = makeStore()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore returns every read the graph publish reaches.
      const store = {
        ...base,
        getSettings: () => ({ ...base.getSettings(), agentStatusHooksEnabled: false }),
        listAutomations: () => [],
        listAutomationRuns: () => []
      } as never
      const parity = installOrcadHeadlessParity({
        runtime: new OrcaRuntimeService(store),
        store,
        agentHookServer: makeAgentHookServer(),
        accounts: makeAccounts()
      })
      parity.startScheduledWork()
      expect(hookInstalls).toHaveLength(0)
      parity.uninstall()
    } finally {
      vi.useRealTimers()
    }
  })
})
