import { describe, expect, it } from 'vitest'
import type { ClickToMoveBuffer } from './terminal-click-to-move-cursor-plan'
import { resolveTerminalInputRowBlock } from './terminal-click-to-move-rows'

const COLS = 30

function screen(rows: string[], wrapped: number[] = []): ClickToMoveBuffer {
  return {
    getLine: (y) => {
      const text = rows[y]
      if (text === undefined) {
        return undefined
      }
      return {
        isWrapped: wrapped.includes(y),
        getCell: (x) => ({ getChars: () => text[x] ?? '', getWidth: () => 1 })
      }
    }
  }
}

function block(rows: string[], cursorRow: number, textColumn = 2, wrapped: number[] = []) {
  return resolveTerminalInputRowBlock({
    buffer: screen(rows, wrapped),
    cols: COLS,
    cursorRow,
    textColumn
  })
}

describe('resolveTerminalInputRowBlock', () => {
  const composer = ['output', '', '› alpha beta', '  delta', '  epsilon', '', '  footer']

  it('spans a prompt row and its indented continuation rows, stopping at a blank row', () => {
    expect(block(composer, 3)).toEqual({ top: 2, bottom: 4 })
    expect(block(composer, 2)).toEqual({ top: 2, bottom: 4 })
  })

  it('has no block below a shell prompt, whose next rows are blank', () => {
    expect(block(['$ echo hi', '', ''], 0)).toEqual({ top: 0, bottom: 0 })
  })

  it('refuses indented rows with no prompt row above them (command output)', () => {
    expect(block(['output', '  indented', '  more'], 2)).toBeNull()
  })

  it('refuses a prompt glyph glued to the text and a zero-width prefix', () => {
    expect(block(['$alpha', '  more'], 0, 1)).toBeNull()
    expect(block(['alpha', 'beta'], 1, 0)).toBeNull()
  })

  it('leaves terminal-wrapped rows to the logical-line path', () => {
    expect(block(['› alpha', '  beta'], 1, 2, [1])).toBeNull()
  })

  it('refuses a cursor outside the block', () => {
    expect(block(composer, 6)).toBeNull()
  })
})
