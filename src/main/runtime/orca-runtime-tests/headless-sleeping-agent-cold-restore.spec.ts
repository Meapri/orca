import { describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_RUNTIME_WINDOW_ID,
  OrcaRuntimeService,
  makePaneKey
} from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'
import { ClosedTerminalSurfaceLedger } from '../closed-terminal-surface-ledger'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import type { EnrichedAgentHookEventPayload } from '../../agent-hooks/server/server-types'
import { installHeadlessSleepingAgentHost } from '../../agent-hooks/headless-sleeping-agent-host'

/**
 * #21743 end to end on a real runtime: an agent pane on a renderer-less host loses its PTY with
 * the daemon, and the host relaunches it in the same pane with its provider's resume command.
 * The fake PTY controller stands in for the agent CLI and records what it was asked to run.
 */
const TAB_ID = 'tab-agent'
const PANE_KEY = makePaneKey(TAB_ID, HEADLESS_LEAF_ID)
const SESSION_ID = 'claude-session-1'

function hookEvent(): EnrichedAgentHookEventPayload {
  return {
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    worktreeId: TEST_WORKTREE_ID,
    connectionId: null,
    receivedAt: 10,
    stateStartedAt: 10,
    providerSession: { key: 'session_id', id: SESSION_ID },
    payload: { state: 'done', prompt: 'ship it', agentType: 'claude' }
  }
}

async function hostWithAgentPane() {
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
    getDefaultWorkspaceSession()
  )
  const agentRuns: { command?: string; tabId?: string; leafId?: string }[] = []
  let nextPty = 0
  const spawn = vi.fn(async (opts: { command?: string; tabId?: string; leafId?: string }) => {
    agentRuns.push({ command: opts.command, tabId: opts.tabId, leafId: opts.leafId })
    return { id: `pty-${++nextPty}` }
  })
  const rows: AgentStatusIpcPayload[] = []
  const runtime = new OrcaRuntimeService(runtimeStore, undefined, {
    getAgentProviderSessionSnapshot: () => rows
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    // Why empty: the daemon that owned the agent is gone, so its successor lists nothing.
    listProcesses: async () => []
  })
  const listeners: { status?: (event: EnrichedAgentHookEventPayload) => void } = {}
  const host = installHeadlessSleepingAgentHost({
    server: {
      subscribeEnrichedStatus: (listener) => {
        listeners.status = listener
        return () => {
          listeners.status = undefined
        }
      },
      subscribePaneStatusClear: () => () => {},
      getStatusSnapshot: () => rows
    },
    store: { getWorktreeIdForTab: () => TEST_WORKTREE_ID },
    runtime
  })
  const agent = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: HEADLESS_LEAF_ID,
    command: 'claude',
    launchAgent: 'claude'
  })
  listeners.status?.(hookEvent())
  return { runtime, host, agent, agentRuns, getSession }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('headless sleeping-agent cold restore', () => {
  it('relaunches an agent lost with its daemon in the same pane with --resume', async () => {
    const { runtime, host, agent, agentRuns, getSession } = await hostWithAgentPane()
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      agent: 'claude',
      providerSession: { id: SESSION_ID },
      origin: 'live'
    })

    // How the daemon adapter reports a session its killed daemon took with it.
    await runtime.onPtyExit(agent.ptyId!, -1, undefined, { providerExitObserved: true })
    await settle()

    expect(agentRuns).toHaveLength(2)
    expect(agentRuns[1]).toMatchObject({ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID })
    expect(agentRuns[1]?.command).toMatch(new RegExp(`--resume'? '?${SESSION_ID}`))
    host.uninstall()
  })

  it('does not bring back an agent whose shell exited on its own', async () => {
    const { runtime, host, agent, agentRuns, getSession } = await hostWithAgentPane()

    await runtime.onPtyExit(agent.ptyId!, 0, undefined, { providerExitObserved: true })
    await settle()

    expect(agentRuns).toHaveLength(1)
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
    host.uninstall()
  })

  it.each([
    ['resumes a pane whose daemon session is gone', [], false, 1],
    ['leaves a pane whose daemon session survived', ['persisted-pty'], false, 0],
    ['never resurrects a tab another client closed', [], true, 0]
  ] as const)('after a restart, %s', async (_label, liveIds, closedOnAnotherClient, runs) => {
    // What a previous host process left behind: the pane, its PTY binding and its checkpoint.
    const paneKey = makePaneKey('host-tab', HEADLESS_LEAF_ID)
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        sleepingAgentSessionsByPaneKey: {
          [paneKey]: {
            paneKey,
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            agent: 'claude',
            providerSession: { key: 'session_id', id: SESSION_ID },
            prompt: '',
            state: 'done',
            capturedAt: 1,
            updatedAt: 1,
            origin: 'live'
          }
        }
      })
    )
    let ledger: string | null = null
    const ledgerStorage = { read: () => ledger, write: (next: string) => void (ledger = next) }
    if (closedOnAnotherClient) {
      new ClosedTerminalSurfaceLedger(ledgerStorage).recordClosedTabs(TEST_WORKTREE_ID, [
        'host-tab'
      ])
    }
    const runtime = new OrcaRuntimeService(runtimeStore, undefined, {
      closedTerminalSurfaceLedgerStorage: ledgerStorage
    })
    const agentRuns: { command?: string; tabId?: string }[] = []
    runtime.setPtyController({
      spawn: async (opts: { command?: string; tabId?: string }) => {
        agentRuns.push({ command: opts.command, tabId: opts.tabId })
        return { id: 'pty-resumed' }
      },
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => liveIds.map((id) => ({ id, cwd: '', title: 'shell' }))
    })
    const host = installHeadlessSleepingAgentHost({
      server: {
        subscribeEnrichedStatus: () => () => {},
        subscribePaneStatusClear: () => () => {},
        getStatusSnapshot: () => []
      },
      store: { getWorktreeIdForTab: () => TEST_WORKTREE_ID },
      runtime
    })

    await host.resumeAfterRestart()

    expect(agentRuns).toHaveLength(runs)
    if (runs === 1) {
      expect(agentRuns[0]?.tabId).toBe('host-tab')
      expect(agentRuns[0]?.command).toMatch(new RegExp(`--resume'? '?${SESSION_ID}`))
    }
    host.uninstall()
  })

  it('sleeps a workspace on the host and wakes its agents when a phone opens it', async () => {
    const { runtime, host, agent, agentRuns, getSession } = await hostWithAgentPane()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    // The park itself: the pane's PTY ends on purpose, which must not consume the capture.
    const sleep = vi.spyOn(runtime, 'sleepTerminalsForWorktree').mockImplementation(async () => {
      await runtime.onPtyExit(agent.ptyId!, 0, undefined, { providerExitObserved: true })
      return { stopped: 1, stoppedPtyIds: [agent.ptyId!], livePtyIds: [], postStopVerified: true }
    })

    await expect(runtime.sleepManagedWorktree(`id:${TEST_WORKTREE_ID}`)).resolves.toEqual({
      worktreeId: TEST_WORKTREE_ID
    })
    expect(sleep).toHaveBeenCalledWith(`id:${TEST_WORKTREE_ID}`, { preserveSurfaces: true })
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.origin).toBe('worktree-sleep')

    const woken = await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
      clientKind: 'mobile',
      navigation: 'caller'
    })
    expect(woken.sleepingAgentWake).toBe('requested')
    await settle()
    expect(agentRuns).toHaveLength(2)
    expect(agentRuns[1]?.command).toMatch(new RegExp(`--resume'? '?${SESSION_ID}`))
    host.uninstall()
  })
})
