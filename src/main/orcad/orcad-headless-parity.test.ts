import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'

vi.mock('../agent-hooks/first-work-rename-runtime', () => ({ firstWorkRenameDeps: () => ({}) }))

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
    }
  }
}

describe('installOrcadHeadlessParity', () => {
  it('publishes the headless placeholder graph so session-tab RPCs stop refusing (#17846)', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore returns every read the graph publish reaches.
    const store = makeStore() as never
    const runtime = new OrcaRuntimeService(store)
    expect(runtime.getStatus().graphStatus).not.toBe('ready')

    installOrcadHeadlessParity({ runtime, store, agentHookServer: makeAgentHookServer() })

    const status = runtime.getStatus()
    expect(status.graphStatus).toBe('ready')
    expect(status.authoritativeWindowId).toBe(HEADLESS_RUNTIME_WINDOW_ID)
  })

  it('subscribes the rename and notification consumers, and removes them on uninstall', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore returns every read the graph publish reaches.
    const store = makeStore() as never
    const server = makeAgentHookServer()

    const uninstall = installOrcadHeadlessParity({
      runtime: new OrcaRuntimeService(store),
      store,
      agentHookServer: server
    })
    expect(server.statusListeners.size).toBe(2)
    expect(server.dropListeners.size).toBe(1)

    uninstall()
    expect(server.statusListeners.size).toBe(0)
    expect(server.dropListeners.size).toBe(0)
  })
})
