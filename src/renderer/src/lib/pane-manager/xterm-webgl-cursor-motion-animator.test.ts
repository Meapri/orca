import { describe, expect, it } from 'vitest'
import {
  CURSOR_BLINK_FADE_DURATION_MS,
  CURSOR_MOTION_DURATION_MS,
  CURSOR_MOTION_INPUT_WINDOW_MS,
  CursorMotionAnimator,
  watchPrefersReducedMotion,
  type ICursorMotionLines,
  type ICursorMotionSample
} from '@xterm/addon-webgl/src/CursorMotionAnimator'

// The animator ships inside Orca's addon-webgl source patch; these tests pin its snap rules.

function createLines(count = 40): ICursorMotionLines & { shift(): void } {
  let rows = Array.from({ length: count }, () => ({}))
  return {
    get: (index) => rows[index],
    // Scrollback trim: every row now holds the line that used to sit below it.
    shift: () => {
      rows = [...rows.slice(1), {}]
    }
  }
}

function createHarness() {
  let now = 1_000
  const animator = new CursorMotionAnimator(() => now)
  animator.setEnabled(true)
  const lines = createLines()
  const sample = (
    x: number,
    row: number,
    overrides: Partial<ICursorMotionSample> = {}
  ): ICursorMotionSample => ({ x, row, width: 1, style: 'block', lines, ...overrides })
  return {
    animator,
    lines,
    sample,
    advance: (ms: number) => {
      now += ms
    },
    update: (s: ICursorMotionSample | undefined, blinkOn = true, focused = true) =>
      animator.update(s, blinkOn, focused)
  }
}

describe('CursorMotionAnimator glide', () => {
  it('glides a typed one-cell move and settles on the target', () => {
    const h = createHarness()
    h.update(h.sample(4, 10))
    h.animator.notifyUserInput()
    h.advance(16)
    expect(h.update(h.sample(5, 10)).isAnimating).toBe(true)

    h.advance(CURSOR_MOTION_DURATION_MS / 2)
    const mid = h.update(h.sample(5, 10))
    expect(mid.isAnimating).toBe(true)
    expect(mid.x).toBeGreaterThan(4)
    expect(mid.x).toBeLessThan(5)

    h.advance(CURSOR_MOTION_DURATION_MS)
    const settled = h.update(h.sample(5, 10))
    expect(settled.isAnimating).toBe(false)
    expect(settled.x).toBe(5)
  })

  it('animates width for wide CJK cells', () => {
    const h = createHarness()
    h.update(h.sample(4, 10))
    h.animator.notifyUserInput()
    h.update(h.sample(6, 10, { width: 2 }))
    h.advance(CURSOR_MOTION_DURATION_MS / 2)
    const mid = h.update(h.sample(6, 10, { width: 2 }))
    expect(mid.width).toBeGreaterThan(1)
    expect(mid.width).toBeLessThan(2)
  })

  it('keeps glides continuous when retargeted mid-flight', () => {
    const h = createHarness()
    h.update(h.sample(0, 10))
    h.animator.notifyUserInput()
    h.update(h.sample(10, 10))
    h.advance(CURSOR_MOTION_DURATION_MS / 2)
    const before = h.update(h.sample(10, 10)).x
    h.animator.notifyUserInput()
    const after = h.update(h.sample(11, 10))
    expect(after.isAnimating).toBe(true)
    expect(after.x).toBeCloseTo(before)
  })

  it('snaps cursor moves that no local input armed', () => {
    const h = createHarness()
    h.update(h.sample(4, 10))
    expect(h.update(h.sample(5, 10)).isAnimating).toBe(false)
  })

  it('snaps once the input window has passed', () => {
    const h = createHarness()
    h.update(h.sample(4, 10))
    h.animator.notifyUserInput()
    h.advance(CURSOR_MOTION_INPUT_WINDOW_MS + 1)
    expect(h.update(h.sample(5, 10)).isAnimating).toBe(false)
  })

  it('snaps TUI churn beyond the glides one input allows', () => {
    const h = createHarness()
    h.update(h.sample(4, 10))
    h.animator.notifyUserInput()
    expect(h.update(h.sample(5, 10)).isAnimating).toBe(true)
    expect(h.update(h.sample(6, 10)).isAnimating).toBe(true)
    expect(h.update(h.sample(7, 10)).isAnimating).toBe(false)
  })

  it('glides a next-row move but snaps multi-row jumps', () => {
    const h = createHarness()
    h.update(h.sample(30, 10))
    h.animator.notifyUserInput()
    expect(h.update(h.sample(0, 11)).isAnimating).toBe(true)

    const jump = createHarness()
    jump.update(jump.sample(4, 10))
    jump.animator.notifyUserInput()
    expect(jump.update(jump.sample(4, 12)).isAnimating).toBe(false)
    expect(jump.update(jump.sample(4, 0)).isAnimating).toBe(false)
  })

  it('snaps alt-screen switches and cursor style changes', () => {
    const h = createHarness()
    h.update(h.sample(4, 10))
    h.animator.notifyUserInput()
    expect(h.update(h.sample(5, 10, { lines: createLines() })).isAnimating).toBe(false)

    const style = createHarness()
    style.update(style.sample(4, 10))
    style.animator.notifyUserInput()
    expect(style.update(style.sample(5, 10, { style: 'bar' })).isAnimating).toBe(false)
  })

  it('snaps when content shifted under the old row', () => {
    const h = createHarness()
    h.update(h.sample(20, 39))
    h.animator.notifyUserInput()
    // Enter at the bottom of a full scrollback: the row index stays, the content moved up.
    h.lines.shift()
    expect(h.update(h.sample(0, 39)).isAnimating).toBe(false)
  })

  it('never animates while disabled, unfocused, or under reduced motion', () => {
    const disabled = createHarness()
    disabled.animator.setEnabled(false)
    disabled.update(disabled.sample(4, 10))
    disabled.animator.notifyUserInput()
    expect(disabled.update(disabled.sample(5, 10)).isAnimating).toBe(false)

    const unfocused = createHarness()
    unfocused.update(unfocused.sample(4, 10), true, false)
    unfocused.animator.notifyUserInput()
    expect(unfocused.update(unfocused.sample(5, 10), true, false).isAnimating).toBe(false)

    const reduced = createHarness()
    reduced.animator.setReducedMotion(true)
    reduced.update(reduced.sample(4, 10))
    reduced.animator.notifyUserInput()
    expect(reduced.update(reduced.sample(5, 10)).isAnimating).toBe(false)
    expect(reduced.update(reduced.sample(5, 10), false).isAnimating).toBe(false)
  })

  it('stops an in-flight glide when reduced motion turns on', () => {
    const h = createHarness()
    h.update(h.sample(4, 10))
    h.animator.notifyUserInput()
    h.update(h.sample(5, 10))
    h.animator.setReducedMotion(true)
    expect(h.animator.isAnimating).toBe(false)
    expect(h.update(h.sample(5, 10)).isAnimating).toBe(false)
  })

  it('glides from the last visible position after a brief hide', () => {
    const h = createHarness()
    h.update(h.sample(4, 10))
    h.animator.notifyUserInput()
    expect(h.update(undefined).isAnimating).toBe(false)
    expect(h.update(h.sample(5, 10)).isAnimating).toBe(true)
  })

  it('snaps after reset, as on resize', () => {
    const h = createHarness()
    h.update(h.sample(4, 10))
    h.animator.notifyUserInput()
    h.animator.reset()
    expect(h.update(h.sample(5, 10)).isAnimating).toBe(false)
  })

  it('needs no further frames while idle', () => {
    const h = createHarness()
    for (let i = 0; i < 5; i++) {
      h.advance(16)
      expect(h.update(h.sample(4, 10)).isAnimating).toBe(false)
    }
    h.animator.notifyUserInput()
    h.update(h.sample(5, 10))
    h.advance(CURSOR_MOTION_DURATION_MS)
    for (let i = 0; i < 5; i++) {
      h.advance(16)
      expect(h.update(h.sample(5, 10)).isAnimating).toBe(false)
    }
  })
})

describe('CursorMotionAnimator blink fade', () => {
  it('fades blink out and back in instead of toggling', () => {
    const h = createHarness()
    h.update(h.sample(4, 10))
    const start = h.update(h.sample(4, 10), false)
    expect(start.isAnimating).toBe(true)
    expect(start.opacity).toBe(1)

    h.advance(CURSOR_BLINK_FADE_DURATION_MS / 2)
    const mid = h.update(h.sample(4, 10), false)
    expect(mid.opacity).toBeGreaterThan(0)
    expect(mid.opacity).toBeLessThan(1)

    h.advance(CURSOR_BLINK_FADE_DURATION_MS)
    const off = h.update(h.sample(4, 10), false)
    expect(off.isAnimating).toBe(false)
    expect(off.opacity).toBe(0)

    expect(h.update(h.sample(4, 10), true).isAnimating).toBe(true)
    h.advance(CURSOR_BLINK_FADE_DURATION_MS)
    const on = h.update(h.sample(4, 10), true)
    expect(on.isAnimating).toBe(false)
    expect(on.opacity).toBe(1)
  })

  it('shows the cursor at full opacity immediately when it moves', () => {
    const h = createHarness()
    h.update(h.sample(4, 10))
    h.update(h.sample(4, 10), false)
    h.advance(CURSOR_BLINK_FADE_DURATION_MS / 2)
    h.update(h.sample(4, 10), false)
    const moved = h.update(h.sample(5, 10), true)
    expect(moved.opacity).toBe(1)
    expect(moved.isAnimating).toBe(false)
  })

  it('hard-toggles blink when disabled', () => {
    const h = createHarness()
    h.animator.setEnabled(false)
    h.update(h.sample(4, 10))
    const off = h.update(h.sample(4, 10), false)
    expect(off.isAnimating).toBe(false)
    expect(off.opacity).toBe(0)
  })
})

describe('watchPrefersReducedMotion', () => {
  it('reports the current preference and follows changes until disposed', () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    const query = {
      matches: true,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener)
    }
    const seen: boolean[] = []
    const watcher = watchPrefersReducedMotion(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watcher only reads matches and (un)subscribes.
      { matchMedia: () => query as unknown as MediaQueryList },
      (reduced) => seen.push(reduced)
    )
    expect(seen).toEqual([true])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listener only reads matches.
    listeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent))
    expect(seen).toEqual([true, false])
    watcher.dispose()
    expect(listeners.size).toBe(0)
  })

  it('treats a missing matchMedia as no preference', () => {
    const seen: boolean[] = []
    watchPrefersReducedMotion({}, (reduced) => seen.push(reduced)).dispose()
    expect(seen).toEqual([false])
  })
})
