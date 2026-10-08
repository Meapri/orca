import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/xterm'

export type AppDrawnCaretCell = {
  /** Screen row (0 = top of the active screen, not the scrolled viewport). */
  row: number
  column: number
}

export type AppDrawnCaretScan = {
  /** The candidate nearest the parked cursor row. */
  nearest: AppDrawnCaretCell | null
  /** Candidates seen, capped at `limit`. */
  count: number
}

/**
 * The one rule for a caret an app paints itself after hiding the terminal cursor (DECTCEM off):
 * a lone inverse-video cell. A run of inverse cells is a highlight (a selected menu row), never a
 * caret. The captured transcripts (src/main/runtime/__fixtures__/*-ime-*.txt) show cursor-agent
 * hiding the cursor, parking it at column 0 below its input box and painting the insertion point
 * as one SGR 7 cell, while Claude Code, Codex and Grok keep the real cursor shown on the caret.
 * `limit` stops the scan early once that many candidates are known.
 */
export function scanAppDrawnCarets(args: {
  buffer: IBuffer
  rows: number
  cols: number
  limit?: number
}): AppDrawnCaretScan {
  const { buffer } = args
  const limit = args.limit ?? Number.POSITIVE_INFINITY
  // Reused for every read: a full-screen scan must not allocate per cell.
  const work = buffer.getNullCell()
  let nearest: AppDrawnCaretCell | null = null
  let count = 0
  for (let row = 0; row < args.rows && count < limit; row++) {
    const line = buffer.getLine(buffer.baseY + row)
    if (!line) {
      continue
    }
    const cols = Math.min(line.length, args.cols)
    let previousInverse = false
    for (let column = 0; column < cols && count < limit; column++) {
      const cell = line.getCell(column, work)
      if (!cell || cell.getWidth() === 0) {
        continue
      }
      const inverse = isInverse(cell)
      const width = Math.max(cell.getWidth(), 1)
      if (inverse && !previousInverse && !isInverseAt(line, column + width, cols, work)) {
        count++
        nearest = nearerToCursor(nearest, { row, column }, buffer.cursorY)
      }
      previousInverse = inverse
    }
  }
  return { nearest, count }
}

function isInverse(cell: IBufferCell): boolean {
  return cell.isInverse() !== 0
}

function isInverseAt(line: IBufferLine, column: number, cols: number, work: IBufferCell): boolean {
  const cell = column < cols ? line.getCell(column, work) : undefined
  return cell !== undefined && isInverse(cell)
}

function nearerToCursor(
  current: AppDrawnCaretCell | null,
  candidate: AppDrawnCaretCell,
  cursorRow: number
): AppDrawnCaretCell {
  if (!current) {
    return candidate
  }
  return Math.abs(candidate.row - cursorRow) <= Math.abs(current.row - cursorRow)
    ? candidate
    : current
}
