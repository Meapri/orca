import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import {
  findAgentResumePaneHolder,
  withoutAgentResumeLaunch,
  type AgentResumePaneHolderProbe
} from './agent-resume-pane-holder'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-live:${LEAF}`
const SESSION = { key: 'session_id' as const, id: 'claude-session-1' }

function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    state: 'working',
    prompt: '',
    agentType: 'claude',
    paneKey: PANE,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    providerSession: SESSION,
    ...overrides
  }
}

function probe(options: {
  rows?: AgentStatusIpcPayload[]
  connected?: boolean
  verdict?: PtyLivenessVerdict | null
  exited?: boolean
  controllerLive?: boolean
  noPty?: boolean
}): AgentResumePaneHolderProbe {
  return {
    rows: options.rows ?? [row()],
    getPtyForPaneKey: () =>
      options.noPty
        ? null
        : { ptyId: 'pty-live', connected: options.connected ?? true, worktreeId: 'wt' },
    getVerdict: () => options.verdict ?? null,
    isKnownExited: () => options.exited ?? false,
    controllerKnowsLive: () => options.controllerLive ?? false
  }
}

const target = { agent: 'claude', providerSession: SESSION, connectionId: null }

describe('findAgentResumePaneHolder', () => {
  it('names the live pane already running the session', () => {
    expect(findAgentResumePaneHolder(probe({}), target)).toEqual({
      status: 'live',
      paneKey: PANE,
      tabId: 'tab-live',
      leafId: LEAF,
      ptyId: 'pty-live',
      worktreeId: 'wt'
    })
  })

  it('ignores the pane the resume itself targets', () => {
    expect(findAgentResumePaneHolder(probe({}), { ...target, excludePaneKey: PANE })).toEqual({
      status: 'none'
    })
  })

  it('does not match another session, another agent, or another execution host', () => {
    expect(
      findAgentResumePaneHolder(probe({}), {
        ...target,
        providerSession: { key: 'session_id', id: 'other' }
      }).status
    ).toBe('none')
    expect(findAgentResumePaneHolder(probe({}), { ...target, agent: 'codex' }).status).toBe('none')
    expect(
      findAgentResumePaneHolder(probe({ rows: [row({ connectionId: 'ssh-1' })] }), target).status
    ).toBe('none')
  })

  it('releases the session only on positive exit evidence', () => {
    expect(findAgentResumePaneHolder(probe({ verdict: { status: 'exited' } }), target).status).toBe(
      'none'
    )
    expect(findAgentResumePaneHolder(probe({ exited: true }), target).status).toBe('none')
    expect(findAgentResumePaneHolder(probe({ noPty: true }), target).status).toBe('none')
  })

  it('reads lost contact as unverifiable, never as free', () => {
    expect(
      findAgentResumePaneHolder(
        probe({ verdict: { status: 'unverifiable', reason: 'relay dropped' } }),
        target
      )
    ).toMatchObject({ status: 'unverifiable', reason: 'relay dropped' })
    expect(findAgentResumePaneHolder(probe({ connected: false }), target).status).toBe(
      'unverifiable'
    )
    // The daemon controller still owning it is positive liveness evidence.
    expect(
      findAgentResumePaneHolder(probe({ connected: false, controllerLive: true }), target).status
    ).toBe('live')
  })

  it('prefers a live holder over an unverifiable one', () => {
    const rows = [row({ paneKey: `tab-lost:${LEAF}` }), row()]
    const mixed: AgentResumePaneHolderProbe = {
      ...probe({ rows }),
      getPtyForPaneKey: (paneKey) =>
        paneKey === PANE
          ? { ptyId: 'pty-live', connected: true, worktreeId: 'wt' }
          : { ptyId: 'pty-lost', connected: false, worktreeId: 'wt' }
    }
    expect(findAgentResumePaneHolder(mixed, target)).toMatchObject({
      status: 'live',
      ptyId: 'pty-live'
    })
  })
})

describe('withoutAgentResumeLaunch', () => {
  it('strips only the resume launch and keeps the pane identity', () => {
    expect(
      withoutAgentResumeLaunch({
        command: "claude '--resume' 'x'",
        launchAgent: 'claude',
        resumeProviderSession: SESSION,
        launchToken: 't',
        launchConfig: {},
        startupCommandDelivery: 'provider',
        tabId: 'tab-1',
        env: { A: '1' }
      })
    ).toEqual({ tabId: 'tab-1', env: { A: '1' } })
  })
})
