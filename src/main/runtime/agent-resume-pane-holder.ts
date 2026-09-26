/**
 * Which pane, if any, already holds an agent session a resume is about to launch.
 *
 * A resume names a provider session (a transcript). Two panes resuming one transcript race each
 * other's writes, so before the host spawns `--resume` it asks the hook store which panes carry that
 * session and grades each one's PTY with the fixed vocabulary: a live PTY holds it, a PTY the host
 * cannot currently reach is `unverifiable` — never "free" — and only a proven exit releases it.
 */
import { agentProviderSessionsEqual } from '../../shared/agent-session-resume'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import { parsePaneKey } from '../../shared/stable-pane-id'

export type AgentResumePaneHolder =
  | { status: 'none' }
  | {
      status: 'live'
      paneKey: string
      tabId: string
      leafId: string
      ptyId: string
      worktreeId: string
    }
  | { status: 'unverifiable'; paneKey: string; ptyId: string; reason: string }

export type AgentResumePaneHolderProbe = {
  rows: readonly AgentStatusIpcPayload[]
  getPtyForPaneKey: (
    paneKey: string
  ) => { ptyId: string; connected: boolean; worktreeId: string } | null
  getVerdict: (ptyId: string) => PtyLivenessVerdict | null
  /** Host-delivered exit recorded on the PTY itself — the other positive absence evidence. */
  isKnownExited: (ptyId: string) => boolean
  controllerKnowsLive: (ptyId: string) => boolean
}

export function findAgentResumePaneHolder(
  probe: AgentResumePaneHolderProbe,
  target: {
    agent: string
    providerSession: AgentProviderSessionMetadata
    /** Provider session ids name a transcript on one machine; another host's id is a stranger. */
    connectionId: string | null
    /** The pane this resume targets; re-ensuring it is the claim path's job, not a duplicate. */
    excludePaneKey?: string | null
  }
): AgentResumePaneHolder {
  let unverifiable: AgentResumePaneHolder | null = null
  const seen = new Set<string>()
  for (const row of probe.rows) {
    if (
      seen.has(row.paneKey) ||
      row.paneKey === target.excludePaneKey ||
      row.agentType !== target.agent ||
      (row.connectionId ?? null) !== target.connectionId ||
      !agentProviderSessionsEqual(target.agent, row.providerSession, target.providerSession)
    ) {
      continue
    }
    seen.add(row.paneKey)
    const pane = parsePaneKey(row.paneKey)
    const pty = pane ? probe.getPtyForPaneKey(row.paneKey) : null
    if (!pane || !pty) {
      continue
    }
    const verdict = probe.getVerdict(pty.ptyId)
    if (verdict?.status === 'exited' || probe.isKnownExited(pty.ptyId)) {
      continue
    }
    if (
      verdict?.status !== 'unverifiable' &&
      (pty.connected || probe.controllerKnowsLive(pty.ptyId))
    ) {
      return {
        status: 'live',
        paneKey: row.paneKey,
        tabId: pane.tabId,
        leafId: pane.leafId,
        ptyId: pty.ptyId,
        worktreeId: pty.worktreeId
      }
    }
    // Why keep scanning: a live holder elsewhere is a better answer than "cannot tell".
    unverifiable ??= {
      status: 'unverifiable',
      paneKey: row.paneKey,
      ptyId: pty.ptyId,
      reason:
        verdict?.status === 'unverifiable'
          ? verdict.reason
          : 'the pane holding this session lost contact with its PTY'
    }
  }
  return unverifiable ?? { status: 'none' }
}

type AgentResumeLaunchFields = {
  command?: string
  startupCommandDelivery?: unknown
  launchConfig?: unknown
  resumeProviderSession?: unknown
  launchToken?: string
  launchAgent?: string
}

/** A legacy create's launch with the resume removed, leaving a plain shell at the same pane. */
export function withoutAgentResumeLaunch<T extends AgentResumeLaunchFields>(
  launch: T
): Omit<T, keyof AgentResumeLaunchFields> & Partial<Pick<T, keyof AgentResumeLaunchFields>> {
  const {
    command: _command,
    startupCommandDelivery: _startupCommandDelivery,
    launchConfig: _launchConfig,
    resumeProviderSession: _resumeProviderSession,
    launchToken: _launchToken,
    launchAgent: _launchAgent,
    ...rest
  } = launch
  return rest
}
