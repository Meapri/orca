import type { IBuffer, IBufferCell, IBufferRange } from '@xterm/xterm'

/** One screen cell: `chars` is '' for a never-written cell; width 0 marks a wide char's spacer. */
export type TerminalCopyCell = { chars: string; width: number }

export type TerminalCopyRow = { cells: TerminalCopyCell[]; isWrapped: boolean }

/** Selected rows plus the selection's first-row start and last-row end (exclusive) columns. */
export type TerminalCopySelection = { rows: TerminalCopyRow[]; startX: number; endX: number }

// Why: smart copy walks every selected cell and copy-on-select reruns it per
// drag step; past this, xterm's own text is used so a huge drag cannot stall.
export const TERMINAL_SMART_COPY_MAX_ROWS = 3_000

const NON_BREAKING_SPACES = / /g

export function readTerminalCopySelection(
  buffer: Pick<IBuffer, 'getLine' | 'getNullCell'>,
  range: IBufferRange
): TerminalCopySelection | null {
  const { start, end } = range
  if (end.y < start.y || end.y - start.y + 1 > TERMINAL_SMART_COPY_MAX_ROWS) {
    return null
  }
  const rows: TerminalCopyRow[] = []
  const scratch: IBufferCell = buffer.getNullCell()
  for (let y = start.y; y <= end.y; y++) {
    const line = buffer.getLine(y)
    if (!line) {
      return null
    }
    const cells: TerminalCopyCell[] = []
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x, scratch)
      cells.push(
        cell ? { chars: cell.getChars(), width: cell.getWidth() } : { chars: '', width: 1 }
      )
    }
    rows.push({ cells, isWrapped: line.isWrapped })
  }
  return { rows, startX: start.x, endX: end.x }
}

/** Column after the last written cell, mirroring xterm's `BufferLine.getTrimmedLength`. */
export function terminalCopyRowTrimmedLength(row: TerminalCopyRow): number {
  for (let x = row.cells.length - 1; x >= 0; x--) {
    const cell = row.cells[x]
    if (cell.chars !== '') {
      return x + Math.max(cell.width, 1)
    }
  }
  return 0
}

/** Text of cells [startX, endX); unwritten cells read as spaces, trailing unwritten cells are dropped. */
export function terminalCopyRowText(row: TerminalCopyRow, startX: number, endX: number): string {
  const stop = Math.min(endX, terminalCopyRowTrimmedLength(row))
  let text = ''
  let x = Math.max(0, startX)
  while (x < stop) {
    const cell = row.cells[x]
    text += cell.chars || ' '
    x += cell.width || 1
  }
  return text.replace(NON_BREAKING_SPACES, ' ')
}

/**
 * Rebuilds xterm's linear `selectionText` from the same cells. A mismatch with
 * `terminal.getSelection()` means a mode this model does not describe (column
 * selection), so callers keep xterm's text instead of guessing.
 */
export function buildXtermLinearSelectionText(selection: TerminalCopySelection): string[] {
  const { rows, startX, endX } = selection
  const lines: string[] = []
  rows.forEach((row, index) => {
    const from = index === 0 ? startX : 0
    const to = index === rows.length - 1 ? endX : row.cells.length
    const text = terminalCopyRowText(row, from, to)
    if (index > 0 && row.isWrapped) {
      lines[lines.length - 1] += text
    } else {
      lines.push(text)
    }
  })
  return lines
}

/** Whitespace-insensitive, since xterm's row cache can trim a row's trailing spaces or not. */
export function matchesXtermSelectionText(
  selection: TerminalCopySelection,
  xtermText: string
): boolean {
  const strip = (value: string): string => value.replace(/\s+/g, '')
  return strip(buildXtermLinearSelectionText(selection).join('')) === strip(xtermText)
}
