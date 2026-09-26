import { describe, expect, it } from 'vitest'
import { findAdjacentMarkLine, resolveMarkNavigationReference } from './terminal-mark-navigation'
import {
  readTerminalLineRangeText,
  resolveCommandOutputRange,
  type TerminalTextLine
} from './terminal-command-output-range'
import type { TerminalCommandMark, TerminalMarkAnchor } from './terminal-mark-store'

const anchor = (line: number, isDisposed = false): TerminalMarkAnchor => ({
  line,
  isDisposed,
  onDispose: () => ({ dispose: () => {} }),
  dispose: () => {}
})

function command(overrides: Partial<TerminalCommandMark>): TerminalCommandMark {
  return {
    id: 1,
    source: 'shell-integration',
    prompt: anchor(0),
    output: null,
    outputEnd: null,
    outputEndsMidLine: false,
    exitCode: undefined,
    ...overrides
  }
}

describe('prompt navigation', () => {
  const lines = [2, 10, 30]

  it('finds the closest mark strictly before or after the reference', () => {
    expect(findAdjacentMarkLine(lines, 10, 'previous')).toBe(2)
    expect(findAdjacentMarkLine(lines, 10, 'next')).toBe(30)
    expect(findAdjacentMarkLine(lines, 2, 'previous')).toBeNull()
    expect(findAdjacentMarkLine(lines, 30, 'next')).toBeNull()
    expect(findAdjacentMarkLine([], 5, 'next')).toBeNull()
  })

  it('measures "previous" from the cursor while following output', () => {
    const viewport = { viewportY: 20, baseY: 20, cursorAbsoluteLine: 30 }
    expect(resolveMarkNavigationReference(viewport, 'previous', null)).toBe(30)
    expect(resolveMarkNavigationReference(viewport, 'next', null)).toBe(20)
  })

  it('continues from the last jump only while the viewport has not moved', () => {
    const viewport = { viewportY: 10, baseY: 40, cursorAbsoluteLine: 42 }
    expect(resolveMarkNavigationReference(viewport, 'next', { line: 12, viewportY: 10 })).toBe(12)
    expect(resolveMarkNavigationReference(viewport, 'next', { line: 12, viewportY: 3 })).toBe(10)
  })
})

describe('command output range', () => {
  it('spans C up to the line before D', () => {
    const mark = command({ output: anchor(4), outputEnd: anchor(9), exitCode: 0 })
    expect(resolveCommandOutputRange(mark, 9, 20)).toEqual({ start: 4, end: 8 })
  })

  it('includes the D line when output ended without a newline', () => {
    const mark = command({
      output: anchor(4),
      outputEnd: anchor(4),
      outputEndsMidLine: true,
      exitCode: 0
    })
    expect(resolveCommandOutputRange(mark, null, 20)).toEqual({ start: 4, end: 4 })
  })

  it('bounds a running command by the next prompt, else the cursor', () => {
    const mark = command({ output: anchor(4) })
    expect(resolveCommandOutputRange(mark, 7, 20)).toEqual({ start: 4, end: 6 })
    expect(resolveCommandOutputRange(mark, null, 11)).toEqual({ start: 4, end: 11 })
  })

  it('returns null for no output, empty output, or trimmed output', () => {
    expect(resolveCommandOutputRange(command({}), null, 5)).toBeNull()
    expect(
      resolveCommandOutputRange(command({ output: anchor(4), outputEnd: anchor(4) }), null, 5)
    ).toBeNull()
    expect(resolveCommandOutputRange(command({ output: anchor(4, true) }), null, 5)).toBeNull()
  })

  it('joins soft-wrapped rows and trims trailing blank lines', () => {
    const rows: TerminalTextLine[] = [
      { isWrapped: false, translateToString: (trim) => (trim ? 'hello' : 'hello   ') },
      { isWrapped: true, translateToString: () => 'world' },
      { isWrapped: false, translateToString: () => 'next' },
      { isWrapped: false, translateToString: () => '' }
    ]
    expect(readTerminalLineRangeText((row) => rows[row], { start: 0, end: 3 })).toBe(
      'hello   world\nnext'
    )
  })
})
