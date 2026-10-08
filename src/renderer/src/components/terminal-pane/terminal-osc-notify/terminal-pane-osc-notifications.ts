import type { IDisposable, Terminal } from '@xterm/xterm'
import { useAppStore } from '@/store'
import { guardParserHandler } from '../terminal-parser-handler-guard'
import { createTerminalAttentionSurface } from '../terminal-attention-surface'
import { AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS } from '../agent-task-complete-policy'
import {
  parseOsc777Payload,
  parseOsc9Payload,
  type TerminalOscNotification
} from './terminal-osc-notification-parse'
import { applyTerminalPaneProgress, clearTerminalPaneProgress } from './terminal-progress-store'
import { installTerminalPaneProgressBar } from './terminal-pane-progress-bar'

export type TerminalOscNotificationDispatch = (event: {
  source: 'terminal-bell'
  paneKey: string
  terminalNotification: TerminalOscNotification
}) => void

type InstallOptions = {
  terminal: { parser: Pick<Terminal['parser'], 'registerOscHandler'> }
  container: HTMLElement
  worktreeId: string
  tabId: string
  paneKey: string
  isReplaying: () => boolean
  dispatchNotification: TerminalOscNotificationDispatch
  markWorktreeUnread: (worktreeId: string) => void
  markTerminalTabUnread: (tabId: string, reason: 'terminal-bell') => void
  markTerminalPaneUnread: (paneKey: string, reason: 'terminal-bell') => void
}

/**
 * OSC 9 / OSC 777 notifications and OSC 9;4 progress for one pane. Notifications ride the
 * terminal-bell lane (same settings, unread markers and main-side per-worktree cooldown).
 */
export function installTerminalPaneOscNotifications(options: InstallOptions): IDisposable {
  const { terminal, paneKey, tabId, worktreeId } = options
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

  const notify = (notification: TerminalOscNotification): void => {
    const state = useAppStore.getState()
    // Why: the user is already looking at this exact pane; a banner would only echo it.
    if (
      createTerminalAttentionSurface(state).isSurfaceViewed({
        workspaceId: worktreeId,
        surfaceKey: paneKey
      })
    ) {
      return
    }
    options.markWorktreeUnread(worktreeId)
    options.markTerminalTabUnread(tabId, 'terminal-bell')
    if (state.settings?.experimentalTerminalAttention === true) {
      options.markTerminalPaneUnread(paneKey, 'terminal-bell')
    }
    // Why: agents often pair their own notification with a turn end; delaying like BEL lets the
    // richer agent-complete notification win main's per-worktree cooldown instead of doubling up.
    const timer = setTimeout(() => {
      pendingTimers.delete(timer)
      options.dispatchNotification({
        source: 'terminal-bell',
        paneKey,
        terminalNotification: notification
      })
    }, AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    pendingTimers.add(timer)
  }

  const osc9 = terminal.parser.registerOscHandler(
    9,
    guardParserHandler('osc-9-notify-progress', (payload) => {
      const event = parseOsc9Payload(payload)
      if (!event) {
        return false
      }
      // Why: replayed bytes restate history; old progress or banners would be stale news.
      if (options.isReplaying()) {
        return true
      }
      if (event.kind === 'progress') {
        applyTerminalPaneProgress(paneKey, tabId, event.progress)
      } else {
        notify(event.notification)
      }
      return true
    })
  )
  const osc777 = terminal.parser.registerOscHandler(
    777,
    guardParserHandler('osc-777-notify', (payload) => {
      const notification = parseOsc777Payload(payload)
      if (!notification) {
        // Why: Orca's own 777 shell markers and other extensions belong to other consumers.
        return false
      }
      if (!options.isReplaying()) {
        notify(notification)
      }
      return true
    })
  )
  const progressBar = installTerminalPaneProgressBar(options.container, paneKey)

  return {
    dispose: () => {
      osc9.dispose()
      osc777.dispose()
      progressBar.dispose()
      for (const timer of pendingTimers) {
        clearTimeout(timer)
      }
      pendingTimers.clear()
      clearTerminalPaneProgress(paneKey)
    }
  }
}
