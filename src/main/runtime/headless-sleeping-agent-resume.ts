/**
 * Headless cold restore for sleeping agents (#21743): relaunch an agent pane with its
 * provider's resume command after its PTY was lost, and implement `worktree.sleep`/wake,
 * on a host with no renderer to do either.
 *
 * Every resume goes through `ensureAgentSession`, so it reuses the per-provider resume
 * builders, the resume dedupe (a live holder is adopted, `unverifiable` refuses) and the
 * closed-surface ledger that `createTerminal` consults. See
 * docs/reference/multi-client-state-authority.md.
 */
import type { RuntimeEnsureAgentSessionRequest } from '../../shared/agent-session-host-authority'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { TERMINAL_SURFACE_RETIRED_ERROR } from '../../shared/terminal-surface-retirement-refusal'
import type { HeadlessSleepingAgentCapture } from '../agent-hooks/headless-sleeping-agent-capture'
import type {
  HeadlessAgentResumeHost,
  HeadlessAgentResumeTerminalExit
} from './headless-agent-resume-host'
import type { SleepingAgentPaneLiveness } from './orca-runtime-sleeping-agent-resume-probes'

export type HeadlessSleepingAgentResumeRuntime = {
  listLocalSleepingAgentSessions(): SleepingAgentSessionRecord[]
  setLocalSleepingAgentSession(paneKey: string, record: SleepingAgentSessionRecord | null): void
  isTerminalSurfaceRetired(tabId: string, leafId: string): boolean
  probeSleepingAgentPaneLiveness(
    worktreeId: string,
    paneKey: string
  ): Promise<SleepingAgentPaneLiveness>
  ensureAgentSession(request: RuntimeEnsureAgentSessionRequest): Promise<unknown>
  sleepTerminalsForWorktree(
    worktreeSelector: string,
    options: { preserveSurfaces?: boolean }
  ): Promise<unknown>
}

type ResumeReason = 'restart' | 'lost-pty' | 'wake'

// Why kept on these refusals: each says "cannot tell or not yet", never "gone"; a later pass retries.
const RETRYABLE_RESUME_REFUSALS = [
  'agent_session_ownership_unknown',
  'agent_session_legacy_required'
]

/** A retired surface or a session another workspace runs refuses the same way on every pass. */
function isPermanentResumeRefusal(message: string): boolean {
  if (RETRYABLE_RESUME_REFUSALS.some((code) => message.includes(code))) {
    return false
  }
  return message.includes(TERMINAL_SURFACE_RETIRED_ERROR) || message.startsWith('agent_session_')
}

function isLostWithHost(exit: HeadlessAgentResumeTerminalExit): boolean {
  // Why: a stop nobody confirmed is how a PTY lost with its daemon exits; a proven exit, a signal
  // or an operator close is the pane ending on purpose, and must not come back as an agent.
  return exit.cause.kind === 'unknown' && exit.cause.reason === 'stop_unverified'
}

export class HeadlessSleepingAgentResume implements HeadlessAgentResumeHost {
  private readonly inFlight = new Set<string>()
  private stopped = false

  constructor(
    private readonly deps: {
      runtime: HeadlessSleepingAgentResumeRuntime
      capture: HeadlessSleepingAgentCapture
      readStatusRows: () => readonly AgentStatusIpcPayload[]
    }
  ) {}

  stop(): void {
    this.stopped = true
  }

  observeTerminalExit(exit: HeadlessAgentResumeTerminalExit): void {
    for (const paneKey of exit.paneKeys) {
      const record = this.deps.capture.findRecord(paneKey)
      if (!record || record.origin === 'worktree-sleep') {
        // Why: a slept pane's own stop lands here too; only its wake may consume the capture.
        continue
      }
      if (!isLostWithHost(exit)) {
        this.deps.capture.forget(paneKey)
        continue
      }
      // Why wait: the exit retires the pane's surfaces asynchronously; a resume at the same
      // placement must land after that retirement, not be retired by it.
      void Promise.resolve(exit.retirement)
        .catch(() => {})
        .then(() => this.resume(record, 'lost-pty'))
    }
  }

  /** After a restart that lost the daemon, relaunch every agent pane the host still lists. */
  async resumeAfterRestart(): Promise<void> {
    const records = this.deps.runtime
      .listLocalSleepingAgentSessions()
      .filter((record) => record.origin !== 'worktree-sleep')
    for (const record of records) {
      await this.resume(record, 'restart')
    }
  }

  async sleepWorktree(worktreeId: string): Promise<void> {
    const captured = this.deps.capture.captureForWorktreeSleep(
      worktreeId,
      this.deps.readStatusRows()
    )
    try {
      await this.deps.runtime.sleepTerminalsForWorktree(`id:${worktreeId}`, {
        preserveSurfaces: true
      })
    } catch (error) {
      this.deps.capture.revertWorktreeSleepCapture(captured)
      throw error
    }
  }

  wakeWorktree(worktreeId: string): boolean {
    const records = this.deps.runtime
      .listLocalSleepingAgentSessions()
      .filter((record) => record.worktreeId === worktreeId && record.origin === 'worktree-sleep')
    if (records.length === 0) {
      return false
    }
    void (async () => {
      for (const record of records) {
        await this.resume(record, 'wake')
      }
    })()
    return true
  }

  private async resume(record: SleepingAgentSessionRecord, reason: ResumeReason): Promise<void> {
    const pane = parsePaneKey(record.paneKey)
    if (this.stopped || this.inFlight.has(record.paneKey)) {
      return
    }
    if (!pane || this.deps.runtime.isTerminalSurfaceRetired(pane.tabId, pane.leafId)) {
      // Why: a closed tab stays closed; its checkpoint must not outlive the close.
      this.deps.capture.forget(record.paneKey)
      return
    }
    this.inFlight.add(record.paneKey)
    try {
      const liveness = await this.deps.runtime.probeSleepingAgentPaneLiveness(
        record.worktreeId,
        record.paneKey
      )
      if (liveness.status !== 'exited') {
        // Live needs no resume; unverifiable is never proof the session is free.
        if (liveness.status === 'unverifiable') {
          console.warn(`[agent-resume] ${record.paneKey}: PTY unverifiable; not resuming yet`)
        }
        return
      }
      if (reason === 'restart' && !liveness.surfacePersisted) {
        // The host no longer lists this pane, so there is nothing to restore it into.
        this.deps.capture.forget(record.paneKey)
        return
      }
      if (this.stopped) {
        return
      }
      await this.deps.runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: `id:${record.worktreeId}`,
        agent: record.agent,
        providerSession: record.providerSession,
        ...(record.launchConfig?.ompResumeFilePath
          ? { ompResumeFilePath: record.launchConfig.ompResumeFilePath }
          : {}),
        ...(record.launchConfig ? { agentArgs: record.launchConfig.agentArgs } : {}),
        presentation: 'background',
        placement: { tabId: pane.tabId, leafId: pane.leafId }
      })
      console.warn(`[agent-resume] resumed ${record.agent} in ${record.paneKey} (${reason})`)
      if (record.origin === 'worktree-sleep') {
        this.deps.runtime.setLocalSleepingAgentSession(record.paneKey, {
          ...record,
          origin: 'live'
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[agent-resume] could not resume ${record.paneKey} (${reason}): ${message}`)
      if (isPermanentResumeRefusal(message)) {
        this.deps.capture.forget(record.paneKey)
      }
    } finally {
      this.inFlight.delete(record.paneKey)
    }
  }
}
