import { describe, expect, it } from 'vitest'
import type {
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../shared/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { sleepingAgentSessionsByPaneKeySchema } from '../../shared/workspace-session-sleeping-agents'
import { HeadlessSleepingAgentCapture } from './headless-sleeping-agent-capture'

const WORKTREE_ID = 'repo-1::/srv/work/feature'
const TAB_ID = 'tab-1'
const PANE_KEY = `${TAB_ID}:11111111-1111-4111-8111-111111111111`
const LAUNCH: SleepingAgentLaunchConfig = {
  agentArgs: '--dangerously-skip-permissions',
  agentEnv: { CLAUDE_CODE_FLAG: '1' }
}

function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    connectionId: null,
    state: 'working',
    prompt: 'Fix the flaky test',
    agentType: 'claude',
    receivedAt: 500,
    stateStartedAt: 400,
    providerSession: { key: 'session_id', id: 'claude-session-1' },
    ...overrides
  }
}

function harness(options: { connected?: boolean; launch?: SleepingAgentLaunchConfig } = {}) {
  const records = new Map<string, SleepingAgentSessionRecord>()
  let connected = options.connected ?? true
  const capture = new HeadlessSleepingAgentCapture({
    runtime: {
      listLocalSleepingAgentSessions: () => [...records.values()],
      setLocalSleepingAgentSession: (paneKey, record) => {
        if (record) {
          records.set(paneKey, record)
        } else {
          records.delete(paneKey)
        }
      },
      getAgentLaunchConfigForPane: () => options.launch,
      isLocalWorkspace: (worktreeId) => worktreeId === WORKTREE_ID,
      isPaneTerminalConnected: () => connected
    },
    resolveWorktreeIdForTab: (tabId) => (tabId === TAB_ID ? WORKTREE_ID : undefined),
    now: () => 1_000
  })
  return {
    capture,
    records,
    setConnected: (next: boolean) => {
      connected = next
    }
  }
}

describe('HeadlessSleepingAgentCapture', () => {
  it('writes the record the renderer would, in a form its hydration schema accepts', () => {
    const { capture, records } = harness({ launch: LAUNCH })
    capture.observeLiveRow(row())

    const record = records.get(PANE_KEY)
    expect(record).toEqual({
      paneKey: PANE_KEY,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'claude-session-1' },
      connectionId: null,
      prompt: 'Fix the flaky test',
      state: 'working',
      capturedAt: 1_000,
      updatedAt: 500,
      launchConfig: LAUNCH,
      origin: 'live'
    })
    expect(sleepingAgentSessionsByPaneKeySchema.parse(Object.fromEntries(records))).toEqual(
      Object.fromEntries(records)
    )
  })

  it('keeps a finished turn resumable without its spent prompt', () => {
    const { capture, records } = harness()
    capture.observeLiveRow(row({ state: 'done', lastAssistantMessage: 'All green.' }))

    expect(records.get(PANE_KEY)).toMatchObject({ state: 'done', prompt: '', origin: 'live' })
    expect(records.get(PANE_KEY)).not.toHaveProperty('lastAssistantMessage')
  })

  it('ignores restored rows, SSH panes, other hosts and non-resumable agents', () => {
    const { capture, records } = harness()
    capture.observeLiveRow(row({ restoredUnconfirmed: true }))
    capture.observeLiveRow(row({ connectionId: 'ssh-1' }))
    capture.observeLiveRow(row({ tabId: 'tab-2', worktreeId: 'repo-2::/elsewhere' }))
    capture.observeLiveRow(row({ agentType: 'cursor' }))
    capture.observeLiveRow(row({ providerSession: undefined }))

    expect(records.size).toBe(0)
  })

  it('keeps the recorded launch arguments when the pane no longer reports them', () => {
    const { capture, records } = harness()
    records.set(PANE_KEY, {
      paneKey: PANE_KEY,
      worktreeId: WORKTREE_ID,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'claude-session-1' },
      prompt: '',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      launchConfig: LAUNCH,
      origin: 'live'
    })
    capture.observeLiveRow(row({ state: 'working', receivedAt: 900 }))

    expect(records.get(PANE_KEY)?.launchConfig).toEqual(LAUNCH)
  })

  it('ends the checkpoint when the agent leaves a live shell, not when the PTY itself was lost', () => {
    const { capture, records, setConnected } = harness()
    capture.observeLiveRow(row())
    setConnected(false)
    capture.observeRowCleared(PANE_KEY)
    expect(records.has(PANE_KEY)).toBe(true)

    setConnected(true)
    capture.observeRowCleared(PANE_KEY)
    expect(records.has(PANE_KEY)).toBe(false)
  })

  it('makes a workspace sleep durable and never lets a live row overwrite it', () => {
    const { capture, records } = harness()
    const captured = capture.captureForWorktreeSleep(WORKTREE_ID, [row({ interrupted: true })])

    expect(captured).toEqual([PANE_KEY])
    expect(records.get(PANE_KEY)).toMatchObject({ origin: 'worktree-sleep', state: 'working' })
    expect(records.get(PANE_KEY)).not.toHaveProperty('interrupted')

    capture.observeLiveRow(row({ state: 'done', receivedAt: 900 }))
    capture.observeRowCleared(PANE_KEY)
    expect(records.get(PANE_KEY)?.origin).toBe('worktree-sleep')

    capture.revertWorktreeSleepCapture(captured)
    expect(records.get(PANE_KEY)?.origin).toBe('live')
  })

  it('promotes a live checkpoint whose hook row is already gone when the workspace sleeps', () => {
    const { capture, records } = harness()
    capture.observeLiveRow(row())

    expect(capture.captureForWorktreeSleep(WORKTREE_ID, [])).toEqual([PANE_KEY])
    expect(records.get(PANE_KEY)?.origin).toBe('worktree-sleep')
  })
})
