/**
 * Agent "finished" / "needs input" notifications for hosts with no renderer.
 *
 * On the desktop the renderer's completion coordinator decides when a turn ended and calls
 * `notifications:dispatch`, whose delivery service fans out to paired phones. A headless host
 * (`orca serve`, orcad) has no renderer, so phones registered for push never heard anything
 * (#20706). This derives the same two events from the hook server's status tap and hands them to
 * the same mobile fan-out, and does the same for terminal bells. It stands down whenever a
 * renderer is attached, so the desktop keeps a single producer.
 */
import { agentMainAgentVerdict } from '../../shared/agent-main-agent-verdict'
import { buildAgentNotificationId } from '../../shared/agent-notification-id'
import { reserveNotificationCooldown } from '../../shared/notification-burst-cooldown'
import type { NotificationSettings } from '../../shared/notification-settings-types'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import type { MobileNotificationDispatchEvent } from '../runtime/runtime-mobile-notification-controller'
import {
  buildNotificationText,
  untranslatedNotificationText,
  type NotificationTextTranslator
} from './agent-notification-text'

// Matches the renderer coordinator: a `done` followed by more work within this window is a milestone, not a finish.
export const HEADLESS_AGENT_DONE_QUIET_MS = 1_500
// Matches the renderer's BEL delay, so a same-burst agent completion wins over the bell.
export const HEADLESS_TERMINAL_BELL_GRACE_MS = 250
const MAX_TRACKED_PANES = 500

/** A BEL main parsed off a PTY, with the attribution the runtime resolved for it. */
export type HeadlessTerminalBell = { paneKey?: string; tabId?: string; worktreeId?: string }

export type HeadlessAgentNotificationDeps = {
  subscribeStatus: (listener: (event: EnrichedAgentHookEventPayload) => void) => () => void
  subscribeTerminalBells?: (listener: (bell: HeadlessTerminalBell) => void) => () => void
  subscribeStatusDrop: (listener: (paneKey: string) => void) => () => void
  dispatchMobileNotification: (event: MobileNotificationDispatchEvent) => void
  readNotificationSettings: () => NotificationSettings | undefined
  resolveWorktreeIdForTab: (tabId: string) => string | undefined
  resolveWorkspaceLabels: (worktreeId: string) => { repoLabel?: string; worktreeLabel?: string }
  /** True while a renderer owns notification dispatch, so this producer must stay silent. */
  isRendererAttached: () => boolean
  translate?: NotificationTextTranslator
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => { cancel(): void }
}

type PaneState = {
  workingObserved: boolean
  lastCompletionIdentity: string | null
  lastAttentionToken: string | null
  notifiedTurnCompletedAt: number | null
  pendingDone: { cancel(): void } | null
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function eventIdentity(event: EnrichedAgentHookEventPayload, timestamp: number): string {
  return [event.payload.state, event.payload.agentType ?? '', String(Math.trunc(timestamp))].join(
    ':'
  )
}

function defaultSchedule(run: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(run, delayMs)
  // Why: a pending quiet window must never hold a stopping host open.
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export function installHeadlessAgentNotifications(deps: HeadlessAgentNotificationDeps): () => void {
  const panes = new Map<string, PaneState>()
  const recentMobileNotifications = new Map<string, number>()
  const lastAgentDispatchAtByWorktree = new Map<string, number>()
  const pendingBells = new Map<string, { cancel(): void }>()
  const now = deps.now ?? Date.now
  const schedule = deps.schedule ?? defaultSchedule
  const translate = deps.translate ?? untranslatedNotificationText

  const paneState = (paneKey: string): PaneState => {
    let state = panes.get(paneKey)
    if (!state) {
      if (panes.size >= MAX_TRACKED_PANES) {
        forgetPane(panes.keys().next().value ?? '')
      }
      state = {
        workingObserved: false,
        lastCompletionIdentity: null,
        lastAttentionToken: null,
        notifiedTurnCompletedAt: null,
        pendingDone: null
      }
      panes.set(paneKey, state)
    }
    return state
  }

  function forgetPane(paneKey: string): void {
    panes.get(paneKey)?.pendingDone?.cancel()
    panes.delete(paneKey)
  }

  function dispatch(
    event: EnrichedAgentHookEventPayload,
    agentState: 'done' | 'waiting' | 'blocked'
  ): void {
    if (deps.isRendererAttached()) {
      return
    }
    const tabWorktreeId = event.tabId ? deps.resolveWorktreeIdForTab(event.tabId) : undefined
    const worktreeId = tabWorktreeId ?? event.worktreeId
    const settings = deps.readNotificationSettings()
    // Same policy as the desktop delivery service: disabled host notifications still reach
    // connected sockets as desktop-disallowed, which the push leg then declines.
    const desktopAllowed = settings ? settings.enabled && settings.agentTaskComplete : true
    const emittedAt = now()
    const cooldownKey = JSON.stringify([
      desktopAllowed,
      'agent-task-complete',
      agentState,
      worktreeId ?? 'global'
    ])
    if (!reserveNotificationCooldown(recentMobileNotifications, cooldownKey, emittedAt)) {
      return
    }
    lastAgentDispatchAtByWorktree.set(worktreeId ?? 'global', emittedAt)
    const payload = event.payload
    const agentTurnOutcome = agentMainAgentVerdict(payload)
    const text = buildNotificationText(
      {
        source: 'agent-task-complete',
        worktreeId,
        paneKey: event.paneKey,
        ...(worktreeId ? deps.resolveWorkspaceLabels(worktreeId) : {}),
        agentType: payload.agentType,
        agentState,
        agentPrompt: payload.prompt,
        agentToolName: payload.toolName,
        agentToolInput: payload.toolInput,
        agentLastAssistantMessage: payload.lastAssistantMessage,
        ...(agentTurnOutcome ? { agentTurnOutcome } : {})
      },
      translate
    )
    const notificationId = buildAgentNotificationId({
      worktreeId,
      paneKey: event.paneKey,
      stateStartedAt: event.stateStartedAt
    })
    deps.dispatchMobileNotification({
      type: 'notification',
      emittedAt,
      source: 'agent-task-complete',
      ...(!desktopAllowed ? { desktopAllowed: false } : {}),
      title: text.title,
      body: text.body,
      ...(worktreeId ? { worktreeId } : {}),
      ...(notificationId ? { notificationId } : {}),
      agentState
    })
  }

  function observe(event: EnrichedAgentHookEventPayload): void {
    // Only live observations announce anything: replays, restored rows and resume-identity
    // refreshes describe work a previous process already saw.
    if (event.isReplay || event.restoredUnconfirmed || event.providerSessionOnly) {
      return
    }
    const state = paneState(event.paneKey)
    const payload = event.payload
    if (payload.state === 'working') {
      const turnCompletedAt = finiteNumber(payload.turnCompletedAt)
      if (turnCompletedAt === undefined) {
        state.pendingDone?.cancel()
        state.pendingDone = null
        state.workingObserved = true
        state.lastCompletionIdentity = null
        state.lastAttentionToken = null
        return
      }
      // A lead turn ended while background work keeps the pane `working`: that is the finish.
      if (state.workingObserved && state.notifiedTurnCompletedAt !== turnCompletedAt) {
        state.notifiedTurnCompletedAt = turnCompletedAt
        dispatch(event, 'done')
      }
      return
    }
    if (payload.state === 'waiting' || payload.state === 'blocked') {
      state.pendingDone?.cancel()
      state.pendingDone = null
      const token = eventIdentity(event, event.stateStartedAt)
      if (!state.workingObserved || token === state.lastAttentionToken) {
        return
      }
      state.lastAttentionToken = token
      dispatch(event, payload.state)
      return
    }
    if (payload.state !== 'done' || payload.sessionBoundary === true || !state.workingObserved) {
      return
    }
    const turnCompletedAt = finiteNumber(payload.turnCompletedAt)
    if (turnCompletedAt !== undefined && turnCompletedAt === state.notifiedTurnCompletedAt) {
      state.workingObserved = false
      return
    }
    const identity = eventIdentity(event, turnCompletedAt ?? event.stateStartedAt)
    if (identity === state.lastCompletionIdentity) {
      return
    }
    state.lastCompletionIdentity = identity
    state.pendingDone?.cancel()
    state.pendingDone = schedule(() => {
      state.pendingDone = null
      state.workingObserved = false
      dispatch(event, 'done')
    }, HEADLESS_AGENT_DONE_QUIET_MS)
  }

  function dispatchBell(bell: HeadlessTerminalBell): void {
    if (deps.isRendererAttached() || (bell.paneKey && panes.get(bell.paneKey)?.pendingDone)) {
      // A pending agent completion is the richer notification for the same burst.
      return
    }
    const worktreeId =
      (bell.tabId ? deps.resolveWorktreeIdForTab(bell.tabId) : undefined) ?? bell.worktreeId
    const emittedAt = now()
    const agentDispatchedAt = lastAgentDispatchAtByWorktree.get(worktreeId ?? 'global')
    if (
      agentDispatchedAt !== undefined &&
      emittedAt - agentDispatchedAt < HEADLESS_AGENT_DONE_QUIET_MS
    ) {
      return
    }
    const settings = deps.readNotificationSettings()
    const desktopAllowed = settings ? settings.enabled && settings.terminalBell : true
    const cooldownKey = JSON.stringify([desktopAllowed, 'terminal-bell', worktreeId ?? 'global'])
    if (!reserveNotificationCooldown(recentMobileNotifications, cooldownKey, emittedAt)) {
      return
    }
    const text = buildNotificationText(
      {
        source: 'terminal-bell',
        worktreeId,
        paneKey: bell.paneKey,
        ...(worktreeId ? deps.resolveWorkspaceLabels(worktreeId) : {})
      },
      translate
    )
    deps.dispatchMobileNotification({
      type: 'notification',
      emittedAt,
      source: 'terminal-bell',
      ...(!desktopAllowed ? { desktopAllowed: false } : {}),
      title: text.title,
      body: text.body,
      ...(worktreeId ? { worktreeId } : {})
    })
  }

  function observeBell(bell: HeadlessTerminalBell): void {
    const key = bell.paneKey ?? bell.tabId ?? bell.worktreeId ?? 'global'
    if (deps.isRendererAttached() || pendingBells.has(key)) {
      return
    }
    pendingBells.set(
      key,
      schedule(() => {
        pendingBells.delete(key)
        dispatchBell(bell)
      }, HEADLESS_TERMINAL_BELL_GRACE_MS)
    )
  }

  const unsubscribeStatus = deps.subscribeStatus(observe)
  const unsubscribeDrop = deps.subscribeStatusDrop(forgetPane)
  const unsubscribeBells = deps.subscribeTerminalBells?.(observeBell) ?? (() => {})
  return () => {
    unsubscribeStatus()
    unsubscribeDrop()
    unsubscribeBells()
    for (const pending of pendingBells.values()) {
      pending.cancel()
    }
    pendingBells.clear()
    for (const paneKey of panes.keys()) {
      forgetPane(paneKey)
    }
  }
}
