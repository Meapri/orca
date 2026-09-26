import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnrichedAgentHookEventPayload } from './server/server-types'
import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'

// Why the mock: this file proves the subscription seam; the orchestrator's graph reaches git.
const { renameCalls } = vi.hoisted(() => {
  const calls: unknown[][] = []
  return { renameCalls: calls }
})
vi.mock('./first-work-branch-rename', () => ({
  maybeAutoRenameBranchOnFirstWork: (...args: unknown[]) => {
    renameCalls.push(args)
    return Promise.resolve()
  }
}))

import { installFirstWorkRenameSubscription } from './first-work-rename-subscription'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked orchestrator never reads its deps.
const deps = {} as FirstWorkBranchRenameDeps
let listener: ((event: EnrichedAgentHookEventPayload) => void) | null = null
const server = {
  subscribeEnrichedStatus: (next: (event: EnrichedAgentHookEventPayload) => void) => {
    listener = next
    return () => {
      listener = null
    }
  }
}

function event(
  overrides: Partial<EnrichedAgentHookEventPayload> = {}
): EnrichedAgentHookEventPayload {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'repo::/wt',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    payload: { state: 'working', prompt: 'Fix login', lastAssistantMessage: 'ok' },
    ...overrides
  }
}

beforeEach(() => {
  renameCalls.length = 0
  listener = null
})

describe('installFirstWorkRenameSubscription', () => {
  it('drives the rename from a live hook status with no window involved', () => {
    installFirstWorkRenameSubscription(server, () => deps)
    listener?.(event({ isReplay: false }))

    expect(renameCalls).toEqual([
      [
        {
          paneKey: 'tab-1:leaf-1',
          tabId: 'tab-1',
          worktreeId: 'repo::/wt',
          state: 'working',
          prompt: 'Fix login',
          assistantMessage: 'ok',
          isReplay: false
        },
        deps
      ]
    ])
  })

  it('skips structured, resume-identity and restored rows exactly as the window listener did', () => {
    installFirstWorkRenameSubscription(server, () => deps)
    listener?.(event({ structuredHost: 'owned' }))
    listener?.(event({ providerSessionOnly: true }))
    listener?.(event({ restoredUnconfirmed: true }))

    expect(renameCalls).toHaveLength(0)
  })

  it('does nothing before the store and runtime exist, and stops after uninstall', () => {
    const uninstall = installFirstWorkRenameSubscription(server, () => null)
    listener?.(event())
    expect(renameCalls).toHaveLength(0)

    uninstall()
    expect(listener).toBeNull()
  })
})
