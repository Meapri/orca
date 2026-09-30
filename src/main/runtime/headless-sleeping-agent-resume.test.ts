import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEnsureAgentSessionRequest } from '../../shared/agent-session-host-authority'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import { TERMINAL_SURFACE_RETIRED_ERROR } from '../../shared/terminal-surface-retirement-refusal'
import { HeadlessSleepingAgentCapture } from '../agent-hooks/headless-sleeping-agent-capture'
import { HeadlessSleepingAgentResume } from './headless-sleeping-agent-resume'
import type { SleepingAgentPaneLiveness } from './orca-runtime-sleeping-agent-resume-probes'

const WORKTREE_ID = 'repo-1::/srv/work/feature'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const LOST: TerminalExitCause = { kind: 'unknown', reason: 'stop_unverified' }

function record(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'claude-session-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    launchConfig: { agentArgs: '--model opus', agentEnv: {} },
    origin: 'live',
    ...overrides
  }
}

function harness(
  options: {
    records?: SleepingAgentSessionRecord[]
    liveness?: SleepingAgentPaneLiveness
    retired?: boolean
    ensure?: () => Promise<unknown>
    sleep?: () => Promise<unknown>
  } = {}
) {
  const records = new Map((options.records ?? [record()]).map((entry) => [entry.paneKey, entry]))
  const ensureAgentSession = vi.fn(async (_request: RuntimeEnsureAgentSessionRequest) =>
    options.ensure?.()
  )
  const sleepTerminalsForWorktree = vi.fn(async () => options.sleep?.())
  const runtime = {
    listLocalSleepingAgentSessions: () => [...records.values()],
    setLocalSleepingAgentSession: (paneKey: string, next: SleepingAgentSessionRecord | null) => {
      if (next) {
        records.set(paneKey, next)
      } else {
        records.delete(paneKey)
      }
    },
    isTerminalSurfaceRetired: () => options.retired === true,
    probeSleepingAgentPaneLiveness: async () =>
      options.liveness ?? { status: 'exited' as const, surfacePersisted: true },
    ensureAgentSession,
    sleepTerminalsForWorktree,
    getAgentLaunchConfigForPane: () => undefined,
    isLocalWorkspace: () => true,
    isPaneTerminalConnected: () => true
  }
  const capture = new HeadlessSleepingAgentCapture({
    runtime,
    resolveWorktreeIdForTab: () => WORKTREE_ID
  })
  const resume = new HeadlessSleepingAgentResume({ runtime, capture, readStatusRows: () => [] })
  return { resume, records, ensureAgentSession, sleepTerminalsForWorktree }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('HeadlessSleepingAgentResume', () => {
  it('relaunches an agent lost with its daemon in the same pane, with its resume identity', async () => {
    const { resume, ensureAgentSession } = harness()
    let retire = (): void => {}
    const retirement = new Promise<void>((resolve) => {
      retire = resolve
    })
    resume.observeTerminalExit({ paneKeys: [PANE_KEY], cause: LOST, retirement })
    await flush()
    // Why: the resume must land after the exit's own surface retirement, not be retired by it.
    expect(ensureAgentSession).not.toHaveBeenCalled()

    retire()
    await flush()
    expect(ensureAgentSession).toHaveBeenCalledWith({
      kind: 'explicit',
      worktree: `id:${WORKTREE_ID}`,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'claude-session-1' },
      agentArgs: '--model opus',
      presentation: 'background',
      placement: { tabId: TAB_ID, leafId: LEAF_ID }
    })
  })

  it.each<[string, TerminalExitCause]>([
    ['a proven exit', { kind: 'exited', exitCode: 0 }],
    ['a signal', { kind: 'signaled', signal: 9 }],
    ['an operator close', { kind: 'operator_close' }]
  ])('drops the checkpoint instead of resuming after %s', async (_label, cause) => {
    const { resume, records, ensureAgentSession } = harness()
    resume.observeTerminalExit({ paneKeys: [PANE_KEY], cause, retirement: undefined })
    await flush()

    expect(ensureAgentSession).not.toHaveBeenCalled()
    expect(records.size).toBe(0)
  })

  it('never resumes while the PTY is live or unverifiable', async () => {
    for (const status of ['live', 'unverifiable'] as const) {
      const { resume, records, ensureAgentSession } = harness({
        liveness: { status, surfacePersisted: true }
      })
      await resume.resumeAfterRestart()
      expect(ensureAgentSession).not.toHaveBeenCalled()
      expect(records.size).toBe(1)
    }
  })

  it('never resurrects a closed tab', async () => {
    const { resume, records, ensureAgentSession } = harness({ retired: true })
    await resume.resumeAfterRestart()

    expect(ensureAgentSession).not.toHaveBeenCalled()
    expect(records.size).toBe(0)
  })

  it('after a restart, resumes only panes the host session still lists', async () => {
    const { resume, records, ensureAgentSession } = harness({
      liveness: { status: 'exited', surfacePersisted: false }
    })
    await resume.resumeAfterRestart()

    expect(ensureAgentSession).not.toHaveBeenCalled()
    expect(records.size).toBe(0)
  })

  it('keeps the checkpoint when ownership is unknown, and drops it on a permanent refusal', async () => {
    const unknown = harness({
      ensure: async () => {
        throw new Error('agent_session_ownership_unknown')
      }
    })
    await unknown.resume.resumeAfterRestart()
    expect(unknown.records.size).toBe(1)

    const retired = harness({
      ensure: async () => {
        throw new Error(TERMINAL_SURFACE_RETIRED_ERROR)
      }
    })
    await retired.resume.resumeAfterRestart()
    expect(retired.records.size).toBe(0)
  })

  it('leaves slept panes to their wake, then resumes them and returns them to live', async () => {
    const { resume, records, ensureAgentSession } = harness({
      records: [record({ origin: 'worktree-sleep' })]
    })
    resume.observeTerminalExit({
      paneKeys: [PANE_KEY],
      cause: { kind: 'operator_close' },
      retirement: undefined
    })
    await resume.resumeAfterRestart()
    expect(ensureAgentSession).not.toHaveBeenCalled()
    expect(records.get(PANE_KEY)?.origin).toBe('worktree-sleep')

    expect(resume.wakeWorktree('repo-2::/other')).toBe(false)
    expect(resume.wakeWorktree(WORKTREE_ID)).toBe(true)
    await flush()
    expect(ensureAgentSession).toHaveBeenCalledTimes(1)
    expect(records.get(PANE_KEY)?.origin).toBe('live')
  })

  it('parks the workspace, and reverts the capture if the stop fails', async () => {
    const ok = harness()
    await ok.resume.sleepWorktree(WORKTREE_ID)
    expect(ok.sleepTerminalsForWorktree).toHaveBeenCalledWith(`id:${WORKTREE_ID}`)
    expect(ok.records.get(PANE_KEY)?.origin).toBe('worktree-sleep')

    const failing = harness({
      sleep: async () => {
        throw new Error('terminal_worktree_sleep_failed')
      }
    })
    await expect(failing.resume.sleepWorktree(WORKTREE_ID)).rejects.toThrow(
      'terminal_worktree_sleep_failed'
    )
    expect(failing.records.get(PANE_KEY)?.origin).toBe('live')
  })

  it('does nothing once stopped', async () => {
    const { resume, ensureAgentSession } = harness()
    resume.stop()
    await resume.resumeAfterRestart()
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })
})
