/**
 * Sleeping-agent resume records for a host with no renderer (#21743).
 *
 * On the desktop the renderer keeps `sleepingAgentSessionsByPaneKey` current from every live
 * hook row, and its pane cold restore reads it back. orcad has no renderer, so this keeps the
 * same records, in the same field and format, from the hook server's store.
 */
import {
  agentProviderSessionsEqual,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../shared/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { recoveryRecordMatches } from '../../shared/sleeping-agent-record-equivalence'
import { buildSleepingAgentSessionRecord } from '../../shared/sleeping-agent-session-record'
import { parsePaneKey } from '../../shared/stable-pane-id'

export type SleepingAgentCaptureRuntime = {
  listLocalSleepingAgentSessions(): SleepingAgentSessionRecord[]
  setLocalSleepingAgentSession(paneKey: string, record: SleepingAgentSessionRecord | null): void
  getAgentLaunchConfigForPane(paneKey: string): SleepingAgentLaunchConfig | undefined
  isLocalWorkspace(worktreeId: string): boolean
  isPaneTerminalConnected(paneKey: string): boolean
}

export type SleepingAgentCaptureDeps = {
  runtime: SleepingAgentCaptureRuntime
  resolveWorktreeIdForTab: (tabId: string) => string | undefined
  now?: () => number
}

type CaptureOrigin = 'live' | 'worktree-sleep'

export class HeadlessSleepingAgentCapture {
  private readonly now: () => number

  constructor(private readonly deps: SleepingAgentCaptureDeps) {
    this.now = deps.now ?? Date.now
  }

  findRecord(paneKey: string): SleepingAgentSessionRecord | undefined {
    return this.deps.runtime
      .listLocalSleepingAgentSessions()
      .find((record) => record.paneKey === paneKey)
  }

  /** One live hook row: refresh that pane's checkpoint the way the renderer's live reducer does. */
  observeLiveRow(row: AgentStatusIpcPayload): void {
    if (row.restoredUnconfirmed || row.structuredHost) {
      // Restored rows describe a previous process; structured sessions restore themselves.
      return
    }
    const existing = this.findRecord(row.paneKey)
    if (existing?.origin === 'worktree-sleep') {
      // Why: an explicit sleep is the pane's only resume handle until its wake consumes it.
      return
    }
    const record = this.buildRecord(row, existing, 'live')
    if (!record) {
      if (existing && existing.agent !== row.agentType && !row.providerSessionOnly) {
        // A different, non-resumable agent now owns the pane; the old checkpoint names a stranger.
        this.deps.runtime.setLocalSleepingAgentSession(row.paneKey, null)
      }
      return
    }
    if (!recoveryRecordMatches(existing, record)) {
      this.deps.runtime.setLocalSleepingAgentSession(row.paneKey, record)
    }
  }

  /** The hook row went away. Only an agent that left a live shell ends its resume handle. */
  observeRowCleared(paneKey: string): void {
    const existing = this.findRecord(paneKey)
    if (existing?.origin !== 'live') {
      return
    }
    if (this.deps.runtime.isPaneTerminalConnected(paneKey)) {
      this.deps.runtime.setLocalSleepingAgentSession(paneKey, null)
    }
  }

  forget(paneKey: string): void {
    this.deps.runtime.setLocalSleepingAgentSession(paneKey, null)
  }

  /** Durable captures for an explicit workspace sleep; returns the panes it wrote. */
  captureForWorktreeSleep(worktreeId: string, rows: readonly AgentStatusIpcPayload[]): string[] {
    const captured: string[] = []
    for (const row of rows) {
      if (row.restoredUnconfirmed || row.structuredHost || row.connectionId) {
        continue
      }
      if (this.resolveWorktreeId(row) !== worktreeId) {
        continue
      }
      // Why interrupted:false: the sleep kills the PTY either way, so the record carries identity, not the dead turn.
      const record = this.buildRecord(
        { ...row, interrupted: false },
        this.findRecord(row.paneKey),
        'worktree-sleep'
      )
      if (record) {
        this.deps.runtime.setLocalSleepingAgentSession(row.paneKey, record)
        captured.push(row.paneKey)
      }
    }
    for (const record of this.deps.runtime.listLocalSleepingAgentSessions()) {
      if (
        record.worktreeId === worktreeId &&
        record.origin === 'live' &&
        !captured.includes(record.paneKey)
      ) {
        this.deps.runtime.setLocalSleepingAgentSession(record.paneKey, {
          ...record,
          origin: 'worktree-sleep'
        })
        captured.push(record.paneKey)
      }
    }
    return captured
  }

  /** A sleep that failed leaves the workspace awake, so its captures go back to live checkpoints. */
  revertWorktreeSleepCapture(paneKeys: readonly string[]): void {
    for (const paneKey of paneKeys) {
      const record = this.findRecord(paneKey)
      if (record?.origin === 'worktree-sleep') {
        this.deps.runtime.setLocalSleepingAgentSession(paneKey, { ...record, origin: 'live' })
      }
    }
  }

  private resolveWorktreeId(row: AgentStatusIpcPayload): string | undefined {
    const tabId = row.tabId ?? parsePaneKey(row.paneKey)?.tabId
    return (tabId ? this.deps.resolveWorktreeIdForTab(tabId) : undefined) ?? row.worktreeId
  }

  private buildRecord(
    row: AgentStatusIpcPayload,
    existing: SleepingAgentSessionRecord | undefined,
    origin: CaptureOrigin
  ): SleepingAgentSessionRecord | null {
    if (row.connectionId) {
      // Why: an SSH pane's PTY lives on its relay, which survives this host's daemon.
      return null
    }
    const worktreeId = this.resolveWorktreeId(row)
    if (!worktreeId || !this.deps.runtime.isLocalWorkspace(worktreeId)) {
      return null
    }
    const sameSessionLaunchConfig =
      existing &&
      existing.agent === row.agentType &&
      agentProviderSessionsEqual(existing.agent, existing.providerSession, row.providerSession)
        ? existing.launchConfig
        : undefined
    // Why: Pi publishes identity on metadata-only rows whose status fields are placeholders.
    const state = row.providerSessionOnly && existing ? existing.state : row.state
    // Why: a finished turn keeps its resume identity but not the spent prompt (renderer parity).
    const finished = state === 'done'
    return buildSleepingAgentSessionRecord({
      source: {
        paneKey: row.paneKey,
        agentType: row.agentType,
        providerSession: row.providerSession,
        connectionId: null,
        prompt: finished ? '' : row.prompt,
        state,
        updatedAt: row.receivedAt,
        ...(!finished && row.lastAssistantMessage
          ? { lastAssistantMessage: row.lastAssistantMessage }
          : {}),
        ...(row.interrupted ? { interrupted: true } : {})
      },
      worktreeId,
      tabId: row.tabId ?? parsePaneKey(row.paneKey)?.tabId,
      capturedAt: this.now(),
      launchConfig:
        this.deps.runtime.getAgentLaunchConfigForPane(row.paneKey) ?? sameSessionLaunchConfig,
      origin
    })
  }
}
