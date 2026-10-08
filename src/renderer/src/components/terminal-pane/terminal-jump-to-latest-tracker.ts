import type { IDisposable, IEvent } from '@xterm/xterm'

export type TerminalJumpToLatestView = {
  visible: boolean
  hasNewOutput: boolean
}

export type TerminalJumpToLatestTarget = {
  rows: number
  buffer: {
    active: { type: string; viewportY: number; baseY: number }
    onBufferChange: IEvent<unknown>
  }
  onScroll: IEvent<number>
  onLineFeed: IEvent<void>
  onResize: IEvent<unknown>
}

export const HIDDEN_JUMP_TO_LATEST_VIEW: TerminalJumpToLatestView = {
  visible: false,
  hasNewOutput: false
}

/**
 * Pure visibility rule: offer the jump once the reader is a full screen above
 * the bottom, or as soon as new output lands below a detached viewport.
 */
export function resolveTerminalJumpToLatestView(
  buffer: { type: string; viewportY: number; baseY: number },
  rows: number,
  hasNewOutput: boolean
): TerminalJumpToLatestView {
  const linesBelow = buffer.baseY - buffer.viewportY
  if (buffer.type !== 'normal' || linesBelow <= 0) {
    return HIDDEN_JUMP_TO_LATEST_VIEW
  }
  return {
    visible: hasNewOutput || linesBelow >= Math.max(1, rows),
    hasNewOutput
  }
}

/** Event-driven only: it never schedules frames or timers of its own. */
export function trackTerminalJumpToLatest(
  terminal: TerminalJumpToLatestTarget,
  onChange: (view: TerminalJumpToLatestView) => void
): IDisposable {
  let hasNewOutput = false
  let view = HIDDEN_JUMP_TO_LATEST_VIEW

  const publish = (): void => {
    const buffer = terminal.buffer.active
    if (buffer.type !== 'normal' || buffer.viewportY >= buffer.baseY) {
      hasNewOutput = false
    }
    const next = resolveTerminalJumpToLatestView(buffer, terminal.rows, hasNewOutput)
    if (next.visible !== view.visible || next.hasNewOutput !== view.hasNewOutput) {
      view = next
      onChange(next)
    }
  }

  const onLineFeed = (): void => {
    const buffer = terminal.buffer.active
    if (hasNewOutput || buffer.type !== 'normal' || buffer.viewportY >= buffer.baseY) {
      return
    }
    hasNewOutput = true
    publish()
  }

  const subscriptions = [
    terminal.onScroll(publish),
    terminal.onLineFeed(onLineFeed),
    terminal.onResize(publish),
    terminal.buffer.onBufferChange(publish)
  ]
  publish()
  return {
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.dispose()
      }
    }
  }
}
