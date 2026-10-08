import { describe, expect, it } from 'vitest'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'

// 10 cols x 5 rows of 8x16 CSS cells at the origin, scrolled to buffer row 40.
function terminalAt(pixelScrollOffset?: number) {
  return {
    cols: 10,
    rows: 5,
    buffer: { active: { viewportY: 40 } },
    element: {
      querySelector: () => ({
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 80, height: 80 })
      })
    },
    ...(pixelScrollOffset === undefined ? {} : { _core: { _renderService: { pixelScrollOffset } } })
  }
}

describe('getTerminalBufferPositionForMouseEvent', () => {
  it('maps a point to its 1-based buffer cell', () => {
    expect(
      getTerminalBufferPositionForMouseEvent(terminalAt(), { clientX: 17, clientY: 20 })
    ).toEqual({ x: 3, y: 42 })
  })

  it('reads a pixel-scroll offset, since each row is drawn that far above its cell', () => {
    // Drawn 10px higher, y 25 shows row 2 (cell y 32..47) and y 10 shows row 1.
    expect(
      getTerminalBufferPositionForMouseEvent(terminalAt(10), { clientX: 17, clientY: 25 })
    ).toEqual({ x: 3, y: 43 })
    expect(
      getTerminalBufferPositionForMouseEvent(terminalAt(10), { clientX: 17, clientY: 10 })
    ).toEqual({ x: 3, y: 42 })
  })

  it('clamps the revealed partial row to the last viewport row, as xterm does', () => {
    expect(
      getTerminalBufferPositionForMouseEvent(terminalAt(10), { clientX: 0, clientY: 79 })
    ).toEqual({ x: 1, y: 45 })
  })

  it('ignores a missing or malformed offset', () => {
    expect(
      getTerminalBufferPositionForMouseEvent(terminalAt(Number.NaN), { clientX: 0, clientY: 20 })
    ).toEqual({ x: 1, y: 42 })
  })

  it('rejects points outside the screen', () => {
    expect(
      getTerminalBufferPositionForMouseEvent(terminalAt(10), { clientX: 0, clientY: 80 })
    ).toBe(null)
  })
})
