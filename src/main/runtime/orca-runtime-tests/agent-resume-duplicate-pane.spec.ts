import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, makePaneKey } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  store
} from '../orca-runtime-test-fixtures.spec'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import { TERMINAL_SURFACE_RETIRED_ERROR } from '../../../shared/terminal-surface-retirement-refusal'
import {
  ClosedTerminalSurfaceLedger,
  type ClosedTerminalSurfaceLedgerStorage
} from '../closed-terminal-surface-ledger'

/**
 * Replays #13716 / #21235: the host already runs `claude` for session S in a pane it spawned
 * fresh (never through the claim registry), and a second client's cold restore asks for S again.
 */
const SESSION = { key: 'session_id' as const, id: 'claude-session-1' }
const LIVE_TAB = 'tab-live-agent'
const LIVE_PANE = makePaneKey(LIVE_TAB, HEADLESS_LEAF_ID)

function hookRow(paneKey: string, id = SESSION.id): AgentStatusIpcPayload {
  return {
    state: 'working',
    prompt: '',
    agentType: 'claude',
    paneKey,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    providerSession: { key: 'session_id', id }
  }
}

async function hostWithLiveAgentPane(
  rows: () => AgentStatusIpcPayload[],
  closedTerminalSurfaceLedgerStorage?: ClosedTerminalSurfaceLedgerStorage
) {
  let nextPty = 0
  const spawn = vi.fn(async () => ({ id: `pty-${++nextPty}` }))
  const runtime = new OrcaRuntimeService(store, undefined, {
    getAgentProviderSessionSnapshot: rows,
    ...(closedTerminalSurfaceLedgerStorage ? { closedTerminalSurfaceLedgerStorage } : {})
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const live = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
    tabId: LIVE_TAB,
    leafId: HEADLESS_LEAF_ID,
    command: 'claude'
  })
  return { runtime, spawn, live }
}

function resumeRequest(tabId: string, id = SESSION.id) {
  return {
    kind: 'explicit' as const,
    worktree: `id:${TEST_WORKTREE_ID}`,
    agent: 'claude' as const,
    providerSession: { key: 'session_id' as const, id },
    placement: { tabId, leafId: HEADLESS_SECOND_LEAF_ID }
  }
}

describe('agent resume while the session already has a live pane', () => {
  it('redirects the resume to the live pane instead of spawning a second agent', async () => {
    const { runtime, spawn, live } = await hostWithLiveAgentPane(() => [hookRow(LIVE_PANE)])
    const result = await runtime.ensureAgentSession(resumeRequest('tab-client-b'))
    expect(result.disposition).toBe('adopted')
    expect(result.terminal).toMatchObject({
      handle: live.handle,
      tabId: LIVE_TAB,
      paneKey: LIVE_PANE,
      isReattach: true
    })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('still resumes a different session', async () => {
    const { runtime, spawn } = await hostWithLiveAgentPane(() => [hookRow(LIVE_PANE)])
    await runtime
      .ensureAgentSession(resumeRequest('tab-client-b', 'claude-session-2'))
      .catch(() => {})
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('refuses rather than duplicates when the holder is unverifiable', async () => {
    const { runtime, spawn, live } = await hostWithLiveAgentPane(() => [hookRow(LIVE_PANE)])
    runtime.markPtyLivenessUnverifiable(live.ptyId!, 'relay dropped')
    await expect(runtime.ensureAgentSession(resumeRequest('tab-client-b'))).rejects.toThrow(
      'agent_session_ownership_unknown'
    )
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('degrades a legacy terminal.create resume to a plain shell only while a pane holds it', async () => {
    const { runtime } = await hostWithLiveAgentPane(() => [hookRow(LIVE_PANE)])
    const legacy = {
      launchAgent: 'claude' as const,
      resumeProviderSession: SESSION,
      tabId: 'tab-client-b',
      leafId: HEADLESS_SECOND_LEAF_ID
    }
    await expect(
      runtime.isAgentResumeHeldByAnotherPane(`id:${TEST_WORKTREE_ID}`, legacy)
    ).resolves.toBe(true)
    await expect(
      runtime.isAgentResumeHeldByAnotherPane(`id:${TEST_WORKTREE_ID}`, {
        ...legacy,
        resumeProviderSession: { key: 'session_id', id: 'claude-session-2' }
      })
    ).resolves.toBe(false)
  })

  it('does not auto-resume into a tab another client closed', async () => {
    // Client A's close, as the host recorded it before this process started.
    let stored: string | null = null
    const storage = { read: () => stored, write: (next: string) => void (stored = next) }
    new ClosedTerminalSurfaceLedger(storage).recordClosedTabs(TEST_WORKTREE_ID, ['tab-closed-on-a'])
    const { runtime, spawn } = await hostWithLiveAgentPane(() => [], storage)
    await expect(runtime.ensureAgentSession(resumeRequest('tab-closed-on-a'))).rejects.toThrow(
      TERMINAL_SURFACE_RETIRED_ERROR
    )
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
