import { describe, expect, it } from 'vitest'
import {
  CURSOR_MOTION_DURATION_MS,
  CursorMotionAnimator,
  type ICursorMotionSample
} from '@xterm/addon-webgl/src/CursorMotionAnimator'

// The WebGL renderer feeds the animator the cursor it draws: the IME caret while composing, else
// the adopted app caret. These are the cells terminal-app-caret-adoption-render.test.ts asserts
// for cursor-agent's captured screen: caret on "b" (column 18), "가" composed and committed
// before it (column 20), then the echo repaints the caret there.
const ROW = 9
const FRAME_MS = 16

type Step = { input?: boolean; x: number | undefined; width?: number; frames: number }

function run(steps: Step[]): { xs: number[]; animated: boolean } {
  let now = 1_000
  const animator = new CursorMotionAnimator(() => now)
  animator.setEnabled(true)
  const line = {}
  const lines = { get: () => line }
  const xs: number[] = []
  let animated = false
  for (const step of steps) {
    if (step.input) {
      animator.notifyUserInput()
    }
    for (let i = 0; i < step.frames; i++) {
      const sample: ICursorMotionSample | undefined =
        step.x === undefined
          ? undefined
          : { x: step.x, row: ROW, width: step.width ?? 1, style: 'block', lines }
      const frame = animator.update(sample, true, true)
      animated ||= frame.isAnimating
      if (sample) {
        xs.push(frame.x)
      }
      now += FRAME_MS
    }
  }
  return { xs, animated }
}

function isNonDecreasing(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value >= values[index - 1])
}

describe('cursor motion over an adopted app caret', () => {
  it('glides from the adopted caret into the IME caret and on through the echo, forward only', () => {
    const settle = Math.ceil(CURSOR_MOTION_DURATION_MS / FRAME_MS) + 1
    const { xs, animated } = run([
      { x: 18, frames: 2 },
      // compositionstart/update: the preedit's caret after "가".
      { input: true, x: 20, frames: 3 },
      // compositionend: the held commit keeps the caret at its end.
      { input: true, x: 20, frames: 2 },
      // A repaint split across writes briefly shows no caret.
      { x: undefined, frames: 1 },
      // The echo: the app's caret, adopted again, lands where the held commit ended.
      { x: 20, frames: 2 },
      // The next syllable.
      { input: true, x: 22, frames: settle }
    ])

    expect(animated).toBe(true)
    expect(isNonDecreasing(xs)).toBe(true)
    expect(xs.at(-1)).toBe(22)
  })
})
