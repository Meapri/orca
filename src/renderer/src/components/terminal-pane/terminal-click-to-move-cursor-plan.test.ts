import { describe, expect, it } from 'vitest'
import {
  encodeTerminalClickToMoveArrows,
  encodeTerminalHorizontalArrow,
  planTerminalClickToMoveArrows,
  type ClickToMoveBuffer
} from './terminal-click-to-move-cursor-plan'

type FakeCell = { chars: string; width: number }

const COLS = 10

function isWide(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60)
  )
}

// Rows are written like a terminal would: wide glyphs take two cells, and a wide glyph that
// does not fit leaves an empty padding cell before wrapping.
function bufferFrom(text: string, options: { padCombining?: boolean } = {}): ClickToMoveBuffer {
  const rows: FakeCell[][] = [[]]
  const graphemes = options.padCombining
    ? Array.from(new Intl.Segmenter().segment(text), (part) => part.segment)
    : Array.from(text)
  for (const glyph of graphemes) {
    const width = isWide(glyph) ? 2 : 1
    let current = rows.at(-1) ?? []
    if (current.length + width > COLS) {
      while (current.length < COLS) {
        current.push({ chars: '', width: 1 })
      }
      current = []
      rows.push(current)
    }
    current.push({ chars: glyph, width })
    if (width === 2) {
      current.push({ chars: '', width: 0 })
    }
  }
  return {
    getLine: (y) => {
      const cells = rows[y]
      if (!cells) {
        return undefined
      }
      return {
        isWrapped: y > 0,
        getCell: (x) => {
          const cell = cells[x] ?? { chars: '', width: 1 }
          return { getChars: () => cell.chars, getWidth: () => cell.width }
        }
      }
    }
  }
}

function plan(
  buffer: ClickToMoveBuffer,
  cursor: { x: number; y: number },
  target: { x: number; y: number },
  inputStart: { x: number; y: number } | null = { x: 2, y: 0 }
): number | null {
  return planTerminalClickToMoveArrows({ buffer, cols: COLS, cursor, target, inputStart })
}

describe('planTerminalClickToMoveArrows', () => {
  it('counts one press per ASCII cell toward the click', () => {
    // "$ echo hi" with the cursor after "hi".
    const buffer = bufferFrom('$ echo hi')
    expect(plan(buffer, { x: 9, y: 0 }, { x: 4, y: 0 })).toBe(-5)
    expect(plan(buffer, { x: 4, y: 0 }, { x: 7, y: 0 })).toBe(3)
  })

  it('counts a wide CJK glyph as one press, not two cells', () => {
    // "$ 한글ab": 한 = cells 2-3, 글 = 4-5, a = 6, b = 7, cursor at end (8).
    const buffer = bufferFrom('$ 한글ab')
    expect(plan(buffer, { x: 8, y: 0 }, { x: 2, y: 0 })).toBe(-4)
    expect(plan(buffer, { x: 8, y: 0 }, { x: 4, y: 0 })).toBe(-3)
    expect(plan(buffer, { x: 2, y: 0 }, { x: 6, y: 0 })).toBe(2)
  })

  it('snaps a click on the right half of a wide glyph to its start', () => {
    const buffer = bufferFrom('$ 日本語')
    expect(plan(buffer, { x: 8, y: 0 }, { x: 5, y: 0 })).toBe(-2)
  })

  it('treats a cell carrying combining marks as one character', () => {
    // "é" as e + U+0301 occupies a single cell.
    const buffer = bufferFrom('$ café x', { padCombining: true })
    expect(plan(buffer, { x: 8, y: 0 }, { x: 5, y: 0 })).toBe(-3)
  })

  it('moves across the rows of a soft-wrapped input line', () => {
    // Row 0: "$ abcdefgh", row 1 (wrapped): "ij".
    const buffer = bufferFrom('$ abcdefghij')
    expect(plan(buffer, { x: 2, y: 1 }, { x: 4, y: 0 })).toBe(-8)
    expect(plan(buffer, { x: 4, y: 0 }, { x: 1, y: 1 })).toBe(7)
  })

  it('skips the padding cell left when a wide glyph wraps to the next row', () => {
    // Row 0: "$ abcdefg" + padding, row 1: "한x".
    const buffer = bufferFrom('$ abcdefg한x')
    expect(plan(buffer, { x: 3, y: 1 }, { x: 8, y: 0 })).toBe(-3)
  })

  it('clamps rightward clicks to the end of typed input', () => {
    const buffer = bufferFrom('$ ls')
    expect(plan(buffer, { x: 2, y: 0 }, { x: 9, y: 0 })).toBe(2)
  })

  it('stops before right-aligned prompt text separated by blank cells', () => {
    // "$ ab    ~" (RPROMPT at the far right).
    const buffer = bufferFrom('$ ab     ~')
    expect(plan(buffer, { x: 4, y: 0 }, { x: 9, y: 0 })).toBe(0)
    expect(plan(buffer, { x: 2, y: 0 }, { x: 9, y: 0 })).toBe(2)
  })

  it('never moves left of the input anchor into the prompt', () => {
    const buffer = bufferFrom('$ echo')
    expect(plan(buffer, { x: 6, y: 0 }, { x: 0, y: 0 })).toBe(-4)
  })

  it('refuses leftward moves when the input start is unknown', () => {
    const buffer = bufferFrom('$ echo')
    expect(plan(buffer, { x: 6, y: 0 }, { x: 3, y: 0 }, null)).toBeNull()
    expect(
      planTerminalClickToMoveArrows({
        buffer,
        cols: COLS,
        cursor: { x: 6, y: 0 },
        target: { x: 3, y: 0 },
        inputStart: null,
        allowLineStartFallback: true
      })
    ).toBe(-3)
  })

  it('ignores an anchor that lies right of the cursor', () => {
    const buffer = bufferFrom('$ echo')
    expect(plan(buffer, { x: 3, y: 0 }, { x: 2, y: 0 }, { x: 5, y: 0 })).toBeNull()
  })

  it('returns null for clicks outside the cursor logical line', () => {
    const buffer = bufferFrom('$ abc')
    expect(plan(buffer, { x: 5, y: 0 }, { x: 2, y: 1 })).toBeNull()
  })

  it('handles the pending-wrap cursor column', () => {
    // Row 0 is full; xterm reports cursorX === cols until the next glyph wraps.
    const buffer = bufferFrom('$ abcdefgh')
    expect(plan(buffer, { x: COLS, y: 0 }, { x: 5, y: 0 })).toBe(-5)
  })
})

describe('encodeTerminalClickToMoveArrows', () => {
  it('uses CSI arrows in normal cursor mode and SS3 in application mode', () => {
    const normal = { applicationCursorKeys: false, kittyKeyboardFlags: 0 }
    expect(encodeTerminalClickToMoveArrows(-2, normal)).toBe('\x1b[D\x1b[D')
    expect(encodeTerminalClickToMoveArrows(1, normal)).toBe('\x1b[C')
    expect(
      encodeTerminalClickToMoveArrows(-1, { applicationCursorKeys: true, kittyKeyboardFlags: 0 })
    ).toBe('\x1bOD')
    expect(encodeTerminalClickToMoveArrows(0, normal)).toBe('')
  })

  it('matches xterm kitty encoding, adding releases only when event types are reported', () => {
    expect(
      encodeTerminalHorizontalArrow('left', { applicationCursorKeys: true, kittyKeyboardFlags: 1 })
    ).toBe('\x1b[D')
    expect(
      encodeTerminalHorizontalArrow('right', {
        applicationCursorKeys: false,
        kittyKeyboardFlags: 3
      })
    ).toBe('\x1b[C\x1b[1;1:3C')
  })
})
