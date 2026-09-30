import { KITTY_REPORT_EVENT_TYPES } from '../../../../shared/terminal-kitty-keyboard-flags'

type ClickToMoveCell = { getChars: () => string; getWidth: () => number }
type ClickToMoveLine = {
  readonly isWrapped: boolean
  getCell: (x: number) => ClickToMoveCell | undefined
}
export type ClickToMoveBuffer = {
  getLine: (y: number) => ClickToMoveLine | undefined
}

/** Absolute buffer coordinates (0-based), matching xterm's `baseY + cursorY` rows. */
export type ClickToMoveCellPosition = { x: number; y: number }

export type ClickToMovePlanInput = {
  buffer: ClickToMoveBuffer
  cols: number
  cursor: ClickToMoveCellPosition
  target: ClickToMoveCellPosition
  /** Where editable input begins; null means leftward moves are unsafe. */
  inputStart: ClickToMoveCellPosition | null
  /** Explicit (modifier) clicks may fall back to the logical line start like xterm's alt-click. */
  allowLineStartFallback?: boolean
}

// Why: a run this long separates typed input from right-aligned prompt text (zsh RPROMPT).
const INPUT_END_BLANK_RUN = 3

export type LinearCell = { chars: string; width: number }

export function logicalLineStartRow(buffer: ClickToMoveBuffer, row: number): number {
  let startRow = row
  while (startRow > 0 && buffer.getLine(startRow)?.isWrapped === true) {
    startRow -= 1
  }
  return startRow
}

function logicalLineRows(
  buffer: ClickToMoveBuffer,
  row: number
): { startRow: number; endRow: number } {
  const startRow = logicalLineStartRow(buffer, row)
  let endRow = row
  while (buffer.getLine(endRow + 1)?.isWrapped === true) {
    endRow += 1
  }
  return { startRow, endRow }
}

function readLinearCells(
  buffer: ClickToMoveBuffer,
  cols: number,
  startRow: number,
  endRow: number
): LinearCell[] {
  const cells: LinearCell[] = []
  for (let row = startRow; row <= endRow; row += 1) {
    const line = buffer.getLine(row)
    for (let x = 0; x < cols; x += 1) {
      const cell = line?.getCell(x)
      cells.push({ chars: cell?.getChars() ?? '', width: cell?.getWidth() ?? 1 })
    }
  }
  // Why: xterm leaves an empty cell at a wrapped row's end when the next wide glyph cannot fit.
  for (let row = startRow; row < endRow; row += 1) {
    const lastIndex = (row - startRow + 1) * cols - 1
    const next = cells[lastIndex + 1]
    if (cells[lastIndex].chars === '' && next && next.width === 2) {
      cells[lastIndex] = { chars: '', width: 0 }
    }
  }
  return cells
}

function isBlank(cell: LinearCell | undefined): boolean {
  return !cell || cell.chars === '' || cell.chars === ' '
}

/** Characters (not cells) before `index`: wide glyph tails and wrap padding count zero. */
function characterOffset(cells: readonly LinearCell[], index: number): number {
  let count = 0
  for (let i = 0; i < index && i < cells.length; i += 1) {
    if (cells[i].width > 0) {
      count += 1
    }
  }
  return count
}

function snapToCharacterStart(cells: readonly LinearCell[], index: number): number {
  let snapped = index
  while (snapped > 0 && cells[snapped]?.width === 0 && cells[snapped - 1]?.width === 2) {
    snapped -= 1
  }
  return snapped
}

function inputEndIndex(cells: readonly LinearCell[], from: number): number {
  let end = from
  let blankRun = 0
  for (let i = from; i < cells.length; i += 1) {
    if (isBlank(cells[i]) && cells[i].width !== 0) {
      blankRun += 1
      if (blankRun >= INPUT_END_BLANK_RUN) {
        break
      }
      continue
    }
    blankRun = 0
    end = i + 1
  }
  return end
}

/** A cursor's (possibly wrapped) logical line read as one run of cells, with its editable span. */
export type TerminalInputLineSpan = {
  cells: readonly LinearCell[]
  cols: number
  startRow: number
  endRow: number
  cursorIndex: number
  /** First editable cell index; null when leftward edits are unsafe. */
  lowerIndex: number | null
  /** Cell index just past the last input character. */
  upperIndex: number
}

export type TerminalInputLineSpanInput = Omit<ClickToMovePlanInput, 'target'>
// Why: xterm reports x === cols while a wrap is pending; that is the next row's first cell.
function normalizePosition(
  position: ClickToMoveCellPosition,
  cols: number
): ClickToMoveCellPosition {
  return position.x >= cols
    ? { x: 0, y: position.y + 1 }
    : { x: Math.max(position.x, 0), y: position.y }
}

export function resolveTerminalInputLineSpan(
  input: TerminalInputLineSpanInput
): TerminalInputLineSpan | null {
  const { buffer, cols, cursor } = input
  if (cols <= 0) {
    return null
  }
  const cursorCell = normalizePosition(cursor, cols)
  const rows = logicalLineRows(buffer, cursor.y)
  const endRow = Math.max(rows.endRow, cursorCell.y)
  const cells = readLinearCells(buffer, cols, rows.startRow, endRow)
  const span = { cells, cols, startRow: rows.startRow, endRow }
  const cursorIndex = terminalInputLineIndex(span, cursor)
  let lowerIndex: number | null = null
  const inputStart = input.inputStart
  if (inputStart && inputStart.y >= rows.startRow && inputStart.y <= endRow) {
    const startIndex = terminalInputLineIndex(span, inputStart)
    lowerIndex = startIndex >= 0 && startIndex <= cursorIndex ? startIndex : null
  }
  if (lowerIndex === null && input.allowLineStartFallback) {
    lowerIndex = 0
  }
  const upperIndex = Math.max(cursorIndex, inputEndIndex(cells, cursorIndex))
  return { ...span, cursorIndex, lowerIndex, upperIndex }
}

/** Linear cell index of an absolute buffer position within the span's rows. */
export function terminalInputLineIndex(
  span: Pick<TerminalInputLineSpan, 'cols' | 'startRow'>,
  position: ClickToMoveCellPosition
): number {
  const cell = normalizePosition(position, span.cols)
  return (cell.y - span.startRow) * span.cols + cell.x
}

export function isTerminalInputLineRow(
  span: Pick<TerminalInputLineSpan, 'startRow' | 'endRow'>,
  row: number
): boolean {
  return row >= span.startRow && row <= span.endRow
}

/** Characters (not cells) between two cell indexes; negative when `to` is left of `from`. */
export function terminalInputLineCharacterDistance(
  span: Pick<TerminalInputLineSpan, 'cells'>,
  from: number,
  to: number
): number {
  return characterOffset(span.cells, to) - characterOffset(span.cells, from)
}

export function snapTerminalInputLineIndex(
  span: Pick<TerminalInputLineSpan, 'cells'>,
  index: number
): number {
  return snapToCharacterStart(span.cells, Math.min(Math.max(index, 0), span.cells.length - 1))
}

/**
 * Signed arrow-key count that moves a line editor's cursor from `cursor` to the clicked cell,
 * or null when the click is outside the cursor's (possibly wrapped) logical line.
 * Clamped to the known input span so no press lands past either end and rings the bell.
 */
export function planTerminalClickToMoveArrows(input: ClickToMovePlanInput): number | null {
  const span = resolveTerminalInputLineSpan(input)
  if (!span || !isTerminalInputLineRow(span, input.target.y)) {
    return null
  }
  let targetIndex = snapTerminalInputLineIndex(span, terminalInputLineIndex(span, input.target))
  if (targetIndex < span.cursorIndex) {
    if (span.lowerIndex === null) {
      return null
    }
    targetIndex = Math.max(targetIndex, span.lowerIndex)
  } else {
    targetIndex = Math.min(targetIndex, span.upperIndex)
  }
  return terminalInputLineCharacterDistance(span, span.cursorIndex, targetIndex)
}

export type ClickToMoveKeyModes = { applicationCursorKeys: boolean; kittyKeyboardFlags: number }

/** One Left/Right press encoded the way xterm itself would for the pane's current key modes. */
export function encodeTerminalHorizontalArrow(
  direction: 'left' | 'right',
  modes: ClickToMoveKeyModes
): string {
  const letter = direction === 'left' ? 'D' : 'C'
  if (modes.kittyKeyboardFlags > 0) {
    // Why: xterm's kitty encoder ignores DECCKM and reports releases only with event types.
    const release = (modes.kittyKeyboardFlags & KITTY_REPORT_EVENT_TYPES) !== 0
    return `\x1b[${letter}${release ? `\x1b[1;1:3${letter}` : ''}`
  }
  return modes.applicationCursorKeys ? `\x1bO${letter}` : `\x1b[${letter}`
}

export function encodeTerminalClickToMoveArrows(count: number, modes: ClickToMoveKeyModes): string {
  if (count === 0) {
    return ''
  }
  return encodeTerminalHorizontalArrow(count < 0 ? 'left' : 'right', modes).repeat(Math.abs(count))
}
