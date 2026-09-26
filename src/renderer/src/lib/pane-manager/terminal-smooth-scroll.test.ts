// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_SMOOTH_SCROLL_DURATION_MS,
  attachTerminalSmoothScroll,
  smoothScrollTerminalTo,
  type TerminalSmoothScrollTarget
} from './terminal-smooth-scroll'
import { getTerminalScrollIntentKind, markTerminalPinnedViewport } from './terminal-scroll-intent'

const reducedMotion = { matches: false }

beforeAll(() => {
  vi.stubGlobal('matchMedia', () => reducedMotion)
})

type FakeTerminal = TerminalSmoothScrollTarget & {
  host: HTMLElement
  scrollable: HTMLElement
  durationsSeenByXterm: number[]
}

function createTerminal(): FakeTerminal {
  const host = document.createElement('div')
  const element = document.createElement('div')
  const scrollable = document.createElement('div')
  scrollable.className = 'xterm-scrollable-element'
  const screen = document.createElement('div')
  const textarea = document.createElement('textarea')
  scrollable.appendChild(screen)
  element.append(scrollable, textarea)
  host.appendChild(element)
  document.body.appendChild(host)
  const terminal: FakeTerminal = {
    host,
    scrollable,
    durationsSeenByXterm: [],
    options: { smoothScrollDuration: 0 },
    element,
    textarea,
    rows: 10,
    modes: { mouseTrackingMode: 'none' },
    buffer: { active: { type: 'normal', viewportY: 100, baseY: 100 } },
    scrollToBottom: vi.fn(() => {
      terminal.durationsSeenByXterm.push(terminal.options.smoothScrollDuration ?? 0)
      terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    }),
    scrollToLine: vi.fn((line: number) => {
      terminal.durationsSeenByXterm.push(terminal.options.smoothScrollDuration ?? 0)
      terminal.buffer.active.viewportY = line
    })
  }
  // Stands in for xterm's own viewport and keyboard handlers.
  scrollable.addEventListener('wheel', () => {
    terminal.durationsSeenByXterm.push(terminal.options.smoothScrollDuration ?? 0)
  })
  textarea.addEventListener(
    'keydown',
    () => terminal.durationsSeenByXterm.push(terminal.options.smoothScrollDuration ?? 0),
    true
  )
  return terminal
}

function wheel(target: EventTarget, deltaY: number, { ctrlKey = false } = {}): void {
  const event = new WheelEvent('wheel', { bubbles: true, deltaY })
  // happy-dom drops modifier init fields on WheelEvent.
  Object.defineProperty(event, 'ctrlKey', { value: ctrlKey })
  target.dispatchEvent(event)
}

let disposers: (() => void)[] = []

function attach(terminal: FakeTerminal, enabled = true): void {
  const attachment = attachTerminalSmoothScroll(terminal, terminal.host, () => enabled)
  disposers.push(() => attachment.dispose())
}

beforeEach(() => {
  vi.useFakeTimers()
  reducedMotion.matches = false
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose()
  }
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('terminal smooth scroll', () => {
  it('arms xterm smooth scrolling only while xterm handles the wheel', () => {
    const terminal = createTerminal()
    attach(terminal)

    wheel(terminal.scrollable.firstElementChild!, -120)

    expect(terminal.durationsSeenByXterm).toEqual([TERMINAL_SMOOTH_SCROLL_DURATION_MS])
    expect(terminal.options.smoothScrollDuration).toBe(0)
  })

  it('arms Shift+PageUp on the terminal textarea only', () => {
    const terminal = createTerminal()
    attach(terminal)

    terminal.textarea!.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'PageUp', shiftKey: true })
    )
    terminal.textarea!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageUp' }))

    expect(terminal.durationsSeenByXterm).toEqual([TERMINAL_SMOOTH_SCROLL_DURATION_MS, 0])
    expect(terminal.options.smoothScrollDuration).toBe(0)
  })

  it.each([
    ['the setting is off', (terminal: FakeTerminal) => attach(terminal, false)],
    [
      'reduced motion is requested',
      (terminal: FakeTerminal) => {
        reducedMotion.matches = true
        attach(terminal)
      }
    ],
    [
      'the app reports mouse wheels',
      (terminal: FakeTerminal) => {
        terminal.modes.mouseTrackingMode = 'any'
        attach(terminal)
      }
    ],
    [
      'the alternate screen is active',
      (terminal: FakeTerminal) => {
        terminal.buffer.active.type = 'alternate'
        attach(terminal)
      }
    ]
  ])('never animates when %s', (_label, setup) => {
    const terminal = createTerminal()
    setup(terminal)

    wheel(terminal.scrollable, -120)
    expect(smoothScrollTerminalTo(terminal, 'top')).toBe(false)

    expect(terminal.durationsSeenByXterm).toEqual([0])
  })

  it('ignores pinch-zoom wheels', () => {
    const terminal = createTerminal()
    attach(terminal)

    wheel(terminal.scrollable, -120, { ctrlKey: true })

    expect(terminal.durationsSeenByXterm).toEqual([0])
  })

  it('follows output when a downward scroll lands on the bottom output outgrew', () => {
    const terminal = createTerminal()
    attach(terminal)
    terminal.buffer.active.viewportY = 90
    markTerminalPinnedViewport(terminal)

    wheel(terminal.scrollable, 120)
    // The animation reaches the old bottom while two new lines arrive.
    terminal.buffer.active.viewportY = 100
    terminal.buffer.active.baseY = 102
    vi.advanceTimersByTime(1_000)

    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1)
    expect(terminal.buffer.active.viewportY).toBe(102)
    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
  })

  it('keeps a reader pinned when a downward scroll stops above the bottom', () => {
    const terminal = createTerminal()
    attach(terminal)
    terminal.buffer.active.viewportY = 50
    markTerminalPinnedViewport(terminal)

    wheel(terminal.scrollable, 120)
    terminal.buffer.active.viewportY = 53
    terminal.buffer.active.baseY = 102
    vi.advanceTimersByTime(1_000)

    expect(terminal.scrollToBottom).not.toHaveBeenCalled()
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
  })

  it('animates only the last screens of a long jump', () => {
    const terminal = createTerminal()
    attach(terminal)
    terminal.buffer.active.viewportY = 5
    terminal.buffer.active.baseY = 500

    expect(smoothScrollTerminalTo(terminal, 'bottom')).toBe(true)

    expect(terminal.scrollToLine).toHaveBeenCalledWith(480)
    expect(terminal.durationsSeenByXterm).toEqual([0, TERMINAL_SMOOTH_SCROLL_DURATION_MS])
    expect(terminal.options.smoothScrollDuration).toBe(0)
  })

  it('declines a jump that is already there or detached from a pane', () => {
    const attached = createTerminal()
    attach(attached)
    expect(smoothScrollTerminalTo(attached, 'bottom')).toBe(false)

    const detached = createTerminal()
    detached.buffer.active.viewportY = 0
    expect(smoothScrollTerminalTo(detached, 'bottom')).toBe(false)
  })

  it('keeps following when a jump to latest is outrun by streaming output', () => {
    const terminal = createTerminal()
    attach(terminal)
    terminal.buffer.active.viewportY = 60
    vi.mocked(terminal.scrollToBottom).mockImplementationOnce(() => {
      // xterm starts the animation but output keeps growing the scrollback.
      terminal.durationsSeenByXterm.push(terminal.options.smoothScrollDuration ?? 0)
      terminal.buffer.active.viewportY = 80
      terminal.buffer.active.baseY = 130
    })

    expect(smoothScrollTerminalTo(terminal, 'bottom')).toBe(true)
    vi.advanceTimersByTime(1_000)

    expect(terminal.buffer.active.viewportY).toBe(130)
    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
  })

  it('waits for a delayed animation to stop before sampling intent', () => {
    const terminal = createTerminal()
    attach(terminal)
    terminal.buffer.active.viewportY = 90
    markTerminalPinnedViewport(terminal)

    wheel(terminal.scrollable, 120)
    vi.advanceTimersByTime(TERMINAL_SMOOTH_SCROLL_DURATION_MS + 50)
    terminal.buffer.active.viewportY = 96
    vi.advanceTimersByTime(40)
    terminal.buffer.active.viewportY = 100
    terminal.buffer.active.baseY = 103
    vi.advanceTimersByTime(1_000)

    expect(terminal.buffer.active.viewportY).toBe(103)
    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
  })
})
