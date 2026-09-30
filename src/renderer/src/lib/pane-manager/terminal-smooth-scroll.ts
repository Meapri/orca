import type { IDisposable } from '@xterm/xterm'
import { syncTerminalScrollIntentFromViewport } from './terminal-scroll-intent'
import { TERMINAL_PIXEL_SCROLL_SETTLE_MS } from './terminal-pixel-scroll'

// Matches VS Code's terminal smooth-scroll duration (also xterm's scrollable).
export const TERMINAL_SMOOTH_SCROLL_DURATION_MS = 125
const SMOOTH_SCROLL_SETTLE_SLACK_MS = 48
const SMOOTH_SCROLL_SETTLE_POLL_MS = 32
const SMOOTH_SCROLL_SETTLE_MAX_CHECKS = 20
// Why: animating thousands of rows reads as a flash; jump to within this many
// screens of the target and animate only the tail.
const SMOOTH_SCROLL_MAX_ANIMATED_SCREENS = 2
const XTERM_SCROLLABLE_SELECTOR = '.xterm-scrollable-element'

export type TerminalSmoothScrollTarget = {
  options: { smoothScrollDuration?: number; pixelScroll?: boolean }
  element?: HTMLElement
  textarea?: HTMLTextAreaElement
  rows: number
  modes: { mouseTrackingMode: string }
  buffer: { active: { type: string; viewportY: number; baseY: number } }
  scrollToBottom: () => void
  scrollToLine: (line: number) => void
}

type SmoothScrollSettleGoal = 'up' | 'down' | 'bottom'

type SmoothScrollState = {
  isEnabled: () => boolean
  settleTimer: ReturnType<typeof setTimeout> | null
  settleGoal: SmoothScrollSettleGoal | null
  // baseY when the latest downward gesture started; landing there means "the bottom".
  settleBottomBaseY: number | null
  disposed: boolean
}

const smoothScrollStateByTerminal = new WeakMap<TerminalSmoothScrollTarget, SmoothScrollState>()
let reducedMotionQuery: MediaQueryList | null | undefined

function prefersReducedMotion(): boolean {
  if (reducedMotionQuery === undefined) {
    reducedMotionQuery =
      typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  }
  return reducedMotionQuery?.matches === true
}

function canAnimateViewport(
  terminal: TerminalSmoothScrollTarget,
  state: SmoothScrollState
): boolean {
  return (
    !state.disposed &&
    state.isEnabled() &&
    !prefersReducedMotion() &&
    terminal.buffer.active.type === 'normal' &&
    // Why: with mouse wheel reporting on, xterm's viewport does not own the wheel.
    terminal.modes.mouseTrackingMode === 'none'
  )
}

// Why: xterm lands a pixel-scrolled viewport on a whole row after the gesture, so intent must be
// sampled after that settle rather than from the fractional position.
function canPixelScrollViewport(
  terminal: TerminalSmoothScrollTarget,
  state: SmoothScrollState
): boolean {
  return (
    !state.disposed &&
    terminal.options.pixelScroll === true &&
    !prefersReducedMotion() &&
    terminal.buffer.active.type === 'normal' &&
    terminal.modes.mouseTrackingMode === 'none'
  )
}

function setSmoothScrollDuration(terminal: TerminalSmoothScrollTarget, duration: number): void {
  if ((terminal.options.smoothScrollDuration ?? 0) !== duration) {
    terminal.options.smoothScrollDuration = duration
  }
}

// Why: xterm animates every viewport scroll, including Orca's programmatic
// restores that read viewportY right after, while a duration is set. Keep it
// set only for the one user gesture xterm is dispatching.
function armForDispatch(
  terminal: TerminalSmoothScrollTarget,
  handlerNode: EventTarget | null | undefined,
  eventType: 'wheel' | 'keydown'
): void {
  setSmoothScrollDuration(terminal, TERMINAL_SMOOTH_SCROLL_DURATION_MS)
  const disarm = (): void => setSmoothScrollDuration(terminal, 0)
  // A listener appended now runs after xterm's handler on the same node.
  handlerNode?.addEventListener(eventType, disarm, { once: true })
  setTimeout(disarm, 0)
}

function finishSettle(terminal: TerminalSmoothScrollTarget, state: SmoothScrollState): void {
  const buffer = terminal.buffer.active
  const reachedOldBottom =
    state.settleBottomBaseY !== null && buffer.viewportY >= state.settleBottomBaseY
  // Why: output that lands mid-animation grows the scrollback past the
  // animation's target; a jump to latest, or a scroll that reached the old
  // bottom, means follow.
  if (
    buffer.type === 'normal' &&
    buffer.viewportY < buffer.baseY &&
    (state.settleGoal === 'bottom' || (state.settleGoal === 'down' && reachedOldBottom))
  ) {
    terminal.scrollToBottom()
  }
  state.settleGoal = null
  state.settleBottomBaseY = null
  // Why: intent sampling after a wheel runs before the animation lands.
  syncTerminalScrollIntentFromViewport(terminal)
}

function scheduleSettle(
  terminal: TerminalSmoothScrollTarget,
  state: SmoothScrollState,
  goal: SmoothScrollSettleGoal,
  motionMs = TERMINAL_SMOOTH_SCROLL_DURATION_MS
): void {
  state.settleGoal = goal
  state.settleBottomBaseY = goal === 'up' ? null : terminal.buffer.active.baseY
  if (state.settleTimer !== null) {
    clearTimeout(state.settleTimer)
  }
  let lastViewportY: number | null = null
  let checks = 0
  const check = (): void => {
    state.settleTimer = null
    if (state.disposed) {
      return
    }
    // Why: a busy renderer delays animation frames; settle once the viewport stops moving.
    const viewportY = terminal.buffer.active.viewportY
    if (viewportY !== lastViewportY && checks < SMOOTH_SCROLL_SETTLE_MAX_CHECKS) {
      lastViewportY = viewportY
      checks += 1
      state.settleTimer = setTimeout(check, SMOOTH_SCROLL_SETTLE_POLL_MS)
      return
    }
    finishSettle(terminal, state)
  }
  state.settleTimer = setTimeout(check, motionMs + SMOOTH_SCROLL_SETTLE_SLACK_MS)
}

/** Animates wheel notches and Shift+PageUp/PageDown in the scrollback by
 *  arming xterm's own smooth scrolling for just those gestures, and re-samples
 *  scroll intent once a pixel-scrolled wheel gesture settles on a row. */
export function attachTerminalSmoothScroll(
  terminal: TerminalSmoothScrollTarget,
  host: HTMLElement,
  isEnabled: () => boolean
): IDisposable {
  const state: SmoothScrollState = {
    isEnabled,
    settleTimer: null,
    settleGoal: null,
    settleBottomBaseY: null,
    disposed: false
  }
  smoothScrollStateByTerminal.set(terminal, state)

  const onWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0 || event.ctrlKey || event.defaultPrevented) {
      return
    }
    const animates = canAnimateViewport(terminal, state)
    const pixelScrolls = canPixelScrollViewport(terminal, state)
    if (!animates && !pixelScrolls) {
      return
    }
    if (animates) {
      armForDispatch(terminal, terminal.element?.querySelector(XTERM_SCROLLABLE_SELECTOR), 'wheel')
    }
    scheduleSettle(
      terminal,
      state,
      event.deltaY > 0 ? 'down' : 'up',
      pixelScrolls ? TERMINAL_PIXEL_SCROLL_SETTLE_MS : TERMINAL_SMOOTH_SCROLL_DURATION_MS
    )
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    const isPageKey = event.key === 'PageUp' || event.key === 'PageDown'
    if (
      !isPageKey ||
      !event.shiftKey ||
      event.target !== terminal.textarea ||
      !canAnimateViewport(terminal, state)
    ) {
      return
    }
    armForDispatch(terminal, terminal.textarea, 'keydown')
    scheduleSettle(terminal, state, event.key === 'PageDown' ? 'down' : 'up')
  }

  host.addEventListener('wheel', onWheel, { capture: true, passive: true })
  host.addEventListener('keydown', onKeyDown, true)
  return {
    dispose: () => {
      state.disposed = true
      if (state.settleTimer !== null) {
        clearTimeout(state.settleTimer)
        state.settleTimer = null
      }
      host.removeEventListener('wheel', onWheel, true)
      host.removeEventListener('keydown', onKeyDown, true)
      if (smoothScrollStateByTerminal.get(terminal) === state) {
        smoothScrollStateByTerminal.delete(terminal)
      }
    }
  }
}

/**
 * Animates a user-requested jump (scroll to top/bottom). Returns false when
 * the caller should scroll immediately instead; when true, the scroll intent
 * is re-sampled once the animation lands.
 */
export function smoothScrollTerminalTo(
  terminal: TerminalSmoothScrollTarget,
  target: 'top' | 'bottom'
): boolean {
  const state = smoothScrollStateByTerminal.get(terminal)
  if (!state || !canAnimateViewport(terminal, state)) {
    return false
  }
  const buffer = terminal.buffer.active
  const targetLine = target === 'top' ? 0 : buffer.baseY
  const distance = targetLine - buffer.viewportY
  if (distance === 0) {
    return false
  }
  const maxAnimatedRows = Math.max(1, terminal.rows) * SMOOTH_SCROLL_MAX_ANIMATED_SCREENS
  if (Math.abs(distance) > maxAnimatedRows) {
    terminal.scrollToLine(targetLine - Math.sign(distance) * maxAnimatedRows)
  }
  setSmoothScrollDuration(terminal, TERMINAL_SMOOTH_SCROLL_DURATION_MS)
  try {
    if (target === 'top') {
      terminal.scrollToLine(0)
    } else {
      terminal.scrollToBottom()
    }
  } finally {
    // xterm latched the duration when it started the animation.
    setSmoothScrollDuration(terminal, 0)
  }
  scheduleSettle(terminal, state, target === 'bottom' ? 'bottom' : 'up')
  return true
}
