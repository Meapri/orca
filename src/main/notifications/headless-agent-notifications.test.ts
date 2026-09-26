import { beforeEach, describe, expect, it } from 'vitest'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import type { MobileNotificationDispatchEvent } from '../runtime/runtime-mobile-notification-controller'
import type { NotificationSettings } from '../../shared/notification-settings-types'
import { getDefaultNotificationSettings } from '../../shared/constants'
import {
  HEADLESS_AGENT_DONE_QUIET_MS,
  installHeadlessAgentNotifications
} from './headless-agent-notifications'

const WORKTREE_ID = 'repo-1::/srv/work/feature'
const PANE_KEY = 'tab-1:leaf-1'

type Harness = {
  emit: (event: EnrichedAgentHookEventPayload) => void
  drop: (paneKey: string) => void
  advance: (ms: number) => void
  dispatched: MobileNotificationDispatchEvent[]
  setRendererAttached: (attached: boolean) => void
  setSettings: (settings: NotificationSettings) => void
  uninstall: () => void
}

function createHarness(): Harness {
  let clock = 1_000_000
  let statusListener: ((event: EnrichedAgentHookEventPayload) => void) | null = null
  let dropListener: ((paneKey: string) => void) | null = null
  let rendererAttached = false
  let settings = getDefaultNotificationSettings()
  const timers: { at: number; run: () => void; cancelled: boolean }[] = []
  const dispatched: MobileNotificationDispatchEvent[] = []
  const uninstall = installHeadlessAgentNotifications({
    subscribeStatus: (listener) => {
      statusListener = listener
      return () => {
        statusListener = null
      }
    },
    subscribeStatusDrop: (listener) => {
      dropListener = listener
      return () => {
        dropListener = null
      }
    },
    dispatchMobileNotification: (event) => dispatched.push(event),
    readNotificationSettings: () => settings,
    resolveWorktreeIdForTab: (tabId) => (tabId === 'tab-1' ? WORKTREE_ID : undefined),
    resolveWorkspaceLabels: () => ({ repoLabel: 'orca', worktreeLabel: 'feature' }),
    isRendererAttached: () => rendererAttached,
    now: () => clock,
    schedule: (run, delayMs) => {
      const timer = { at: clock + delayMs, run, cancelled: false }
      timers.push(timer)
      return {
        cancel: () => {
          timer.cancelled = true
        }
      }
    }
  })
  return {
    emit: (event) => statusListener?.(event),
    drop: (paneKey) => dropListener?.(paneKey),
    advance: (ms) => {
      clock += ms
      for (const timer of timers.splice(0)) {
        if (timer.cancelled) {
          continue
        }
        if (timer.at <= clock) {
          timer.run()
        } else {
          timers.push(timer)
        }
      }
    },
    dispatched,
    setRendererAttached: (attached) => {
      rendererAttached = attached
    },
    setSettings: (next) => {
      settings = next
    },
    uninstall
  }
}

function status(
  state: EnrichedAgentHookEventPayload['payload']['state'],
  overrides: Partial<EnrichedAgentHookEventPayload> = {},
  payload: Partial<EnrichedAgentHookEventPayload['payload']> = {}
): EnrichedAgentHookEventPayload {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 100,
    ...overrides,
    payload: { state, prompt: 'Fix the flaky test', agentType: 'claude', ...payload }
  }
}

let harness: Harness

beforeEach(() => {
  harness = createHarness()
})

describe('installHeadlessAgentNotifications', () => {
  it('announces a finished turn after the quiet window', () => {
    harness.emit(status('working', { stateStartedAt: 100 }))
    harness.emit(status('done', { stateStartedAt: 200 }, { lastAssistantMessage: 'All green.' }))
    expect(harness.dispatched).toHaveLength(0)

    harness.advance(HEADLESS_AGENT_DONE_QUIET_MS)

    expect(harness.dispatched).toHaveLength(1)
    expect(harness.dispatched[0]).toMatchObject({
      type: 'notification',
      source: 'agent-task-complete',
      agentState: 'done',
      worktreeId: WORKTREE_ID,
      title: 'orca / feature - Claude finished',
      body: 'All green.'
    })
    expect(harness.dispatched[0]?.notificationId).toContain('agent:')
    expect(harness.dispatched[0]).not.toHaveProperty('desktopAllowed')
  })

  it('cancels the finish when work resumes inside the quiet window', () => {
    harness.emit(status('working'))
    harness.emit(status('done', { stateStartedAt: 200 }))
    harness.emit(status('working', { stateStartedAt: 300 }))
    harness.advance(HEADLESS_AGENT_DONE_QUIET_MS * 2)

    expect(harness.dispatched).toHaveLength(0)
  })

  it('never announces a done it did not see start working', () => {
    harness.emit(status('done', { stateStartedAt: 200 }))
    harness.advance(HEADLESS_AGENT_DONE_QUIET_MS)

    expect(harness.dispatched).toHaveLength(0)
  })

  it('ignores replays, restored rows, resume-identity rows and session boundaries', () => {
    harness.emit(status('working', { isReplay: true }))
    harness.emit(status('done', { isReplay: true, stateStartedAt: 200 }))
    harness.emit(status('working', { restoredUnconfirmed: true }))
    harness.emit(status('working', { providerSessionOnly: true }))
    harness.advance(HEADLESS_AGENT_DONE_QUIET_MS)
    expect(harness.dispatched).toHaveLength(0)

    harness.emit(status('working'))
    harness.emit(status('done', { stateStartedAt: 200 }, { sessionBoundary: true }))
    harness.advance(HEADLESS_AGENT_DONE_QUIET_MS)
    expect(harness.dispatched).toHaveLength(0)
  })

  it('announces needs-input once per prompt and again after new work', () => {
    harness.emit(status('working'))
    harness.emit(status('waiting', { stateStartedAt: 150 }, { toolName: 'Bash' }))
    harness.emit(status('waiting', { stateStartedAt: 150 }, { toolName: 'Bash' }))
    expect(harness.dispatched.map((event) => event.agentState)).toEqual(['waiting'])
    expect(harness.dispatched[0]?.title).toBe('orca / feature - Claude needs input')

    harness.advance(10_000)
    harness.emit(status('working', { stateStartedAt: 160 }))
    harness.emit(status('blocked', { stateStartedAt: 170 }))
    expect(harness.dispatched.map((event) => event.agentState)).toEqual(['waiting', 'blocked'])
  })

  it('announces a stamped lead-turn finish once, and not again on the all-clear done', () => {
    harness.emit(status('working', { stateStartedAt: 100 }))
    harness.emit(status('working', { stateStartedAt: 100 }, { turnCompletedAt: 180 }))
    harness.emit(status('working', { stateStartedAt: 100 }, { turnCompletedAt: 180 }))
    expect(harness.dispatched).toHaveLength(1)

    harness.emit(status('done', { stateStartedAt: 250 }, { turnCompletedAt: 180 }))
    harness.advance(HEADLESS_AGENT_DONE_QUIET_MS)
    expect(harness.dispatched).toHaveLength(1)
  })

  it('stays silent while a renderer owns dispatch', () => {
    harness.setRendererAttached(true)
    harness.emit(status('working'))
    harness.emit(status('done', { stateStartedAt: 200 }))
    harness.advance(HEADLESS_AGENT_DONE_QUIET_MS)

    expect(harness.dispatched).toHaveLength(0)
  })

  it('marks disabled host notifications as desktop-disallowed, like the desktop delivery path', () => {
    harness.setSettings({ ...getDefaultNotificationSettings(), enabled: false })
    harness.emit(status('working'))
    harness.emit(status('done', { stateStartedAt: 200 }))
    harness.advance(HEADLESS_AGENT_DONE_QUIET_MS)

    expect(harness.dispatched[0]).toMatchObject({ desktopAllowed: false })
  })

  it('forgets a dropped pane and stops listening once uninstalled', () => {
    harness.emit(status('working'))
    harness.drop(PANE_KEY)
    harness.emit(status('done', { stateStartedAt: 200 }))
    harness.advance(HEADLESS_AGENT_DONE_QUIET_MS)
    expect(harness.dispatched).toHaveLength(0)

    harness.emit(status('working', { stateStartedAt: 300 }))
    harness.emit(status('done', { stateStartedAt: 400 }))
    harness.uninstall()
    harness.advance(HEADLESS_AGENT_DONE_QUIET_MS)
    harness.emit(status('working', { stateStartedAt: 500 }))
    harness.emit(status('done', { stateStartedAt: 600 }))
    harness.advance(HEADLESS_AGENT_DONE_QUIET_MS)
    expect(harness.dispatched).toHaveLength(0)
  })
})
