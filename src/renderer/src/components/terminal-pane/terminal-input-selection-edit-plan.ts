import { kittyReportsAllKeysAsEscapeCodes } from '../../../../shared/terminal-kitty-keyboard-flags'
import {
  encodeTerminalClickToMoveArrows,
  isTerminalInputLineRow,
  snapTerminalInputLineIndex,
  terminalInputLineCharacterDistance,
  terminalInputLineIndex,
  type ClickToMoveCellPosition,
  type ClickToMoveKeyModes,
  type TerminalInputLineSpan
} from './terminal-click-to-move-cursor-plan'

/** A selection in absolute buffer cells: start inclusive, end exclusive (xterm's convention). */
export type TerminalInputSelectionRange = {
  start: ClickToMoveCellPosition
  end: ClickToMoveCellPosition
}

/** Cell indexes into a TerminalInputLineSpan, start inclusive, end exclusive. */
export type TerminalInputSpanRange = { startIndex: number; endIndex: number }

export type TerminalSelectionDeletePlan = TerminalInputSpanRange & {
  /** Signed Left/Right presses that put the cursor at the range's end. */
  arrows: number
  /** Backspace presses that remove the range. */
  backspaces: number
  deletedText: string
}

/** Characters' cell index after `index`, skipping a wide glyph's spacer. */
function nextCharacterIndex(span: TerminalInputLineSpan, index: number): number {
  let next = index + 1
  while (next < span.cells.length && span.cells[next].width === 0) {
    next += 1
  }
  return next
}

function previousCharacterIndex(span: TerminalInputLineSpan, index: number): number {
  return snapTerminalInputLineIndex(span, index - 1)
}

/** Editable bounds; left of the cursor is only editable once the input start is known. */
export function terminalInputEditableBounds(span: TerminalInputLineSpan): {
  lower: number
  upper: number
} {
  return { lower: span.lowerIndex ?? span.cursorIndex, upper: span.upperIndex }
}

/** Clamps a buffer selection to the span's editable cells, or null when none of it is editable. */
export function resolveTerminalInputSelection(
  span: TerminalInputLineSpan,
  selection: TerminalInputSelectionRange
): TerminalInputSpanRange | null {
  // Why: a selection reaching another line cannot be removed with this line's keys.
  if (
    !isTerminalInputLineRow(span, selection.start.y) ||
    !isTerminalInputLineRow(span, selection.end.y)
  ) {
    return null
  }
  const { lower, upper } = terminalInputEditableBounds(span)
  const rawStart = terminalInputLineIndex(span, selection.start)
  let endIndex = Math.min(terminalInputLineIndex(span, selection.end), span.cells.length)
  // Why: a selection ending on a wide glyph's spacer still covers the glyph.
  while (endIndex < span.cells.length && span.cells[endIndex]?.width === 0) {
    endIndex += 1
  }
  const startIndex = Math.max(snapTerminalInputLineIndex(span, rawStart), lower)
  endIndex = Math.min(endIndex, upper)
  return endIndex > startIndex ? { startIndex, endIndex } : null
}

export function terminalInputSpanText(
  span: TerminalInputLineSpan,
  range: TerminalInputSpanRange
): string {
  let text = ''
  for (let index = range.startIndex; index < range.endIndex; index += 1) {
    const cell = span.cells[index]
    if (cell.width > 0) {
      text += cell.chars === '' ? ' ' : cell.chars
    }
  }
  return text
}

/** Arrow presses to the range's end, then one Backspace per character in it. */
export function planTerminalSelectionDelete(
  span: TerminalInputLineSpan,
  range: TerminalInputSpanRange
): TerminalSelectionDeletePlan {
  return {
    ...range,
    arrows: terminalInputLineCharacterDistance(span, span.cursorIndex, range.endIndex),
    backspaces: terminalInputLineCharacterDistance(span, range.startIndex, range.endIndex),
    deletedText: terminalInputSpanText(span, range)
  }
}

/**
 * Backspace as xterm encodes it for these modes, or null under kitty's report-all-keys mode,
 * where no captured transcript shows what a synthesized press must look like.
 */
export function encodeTerminalBackspaces(count: number, kittyKeyboardFlags: number): string | null {
  if (kittyReportsAllKeysAsEscapeCodes(kittyKeyboardFlags)) {
    return null
  }
  return '\x7f'.repeat(Math.max(count, 0))
}

export function encodeTerminalSelectionDelete(
  plan: Pick<TerminalSelectionDeletePlan, 'arrows' | 'backspaces'>,
  modes: ClickToMoveKeyModes
): string | null {
  const backspaces = encodeTerminalBackspaces(plan.backspaces, modes.kittyKeyboardFlags)
  if (backspaces === null) {
    return null
  }
  return encodeTerminalClickToMoveArrows(plan.arrows, modes) + backspaces
}

export type TerminalInputSelectionUnit = 'character' | 'word' | 'line'

function isWordCell(span: TerminalInputLineSpan, index: number): boolean {
  const cell = span.cells[index]
  return cell !== undefined && cell.width > 0 && cell.chars.trim() !== ''
}

/** Where a GUI caret lands after one Left/Right step of `unit`, kept inside the editable span. */
export function stepTerminalInputSelectionFocus(
  span: TerminalInputLineSpan,
  focus: number,
  direction: 'left' | 'right',
  unit: TerminalInputSelectionUnit
): number {
  const { lower, upper } = terminalInputEditableBounds(span)
  if (unit === 'line') {
    return direction === 'left' ? lower : upper
  }
  let index = Math.min(Math.max(focus, lower), upper)
  if (direction === 'right') {
    if (unit === 'character') {
      return Math.min(nextCharacterIndex(span, index), upper)
    }
    while (index < upper && !isWordCell(span, index)) {
      index = nextCharacterIndex(span, index)
    }
    while (index < upper && isWordCell(span, index)) {
      index = nextCharacterIndex(span, index)
    }
    return Math.min(index, upper)
  }
  if (index <= lower) {
    return lower
  }
  if (unit === 'character') {
    return Math.max(previousCharacterIndex(span, index), lower)
  }
  index = previousCharacterIndex(span, index)
  while (index > lower && !isWordCell(span, index)) {
    index = previousCharacterIndex(span, index)
  }
  while (index > lower && isWordCell(span, previousCharacterIndex(span, index))) {
    index = previousCharacterIndex(span, index)
  }
  return Math.max(index, lower)
}

/** The `terminal.select(column, row, length)` arguments that highlight a span range. */
export function terminalInputSpanSelectArgs(
  span: TerminalInputLineSpan,
  range: TerminalInputSpanRange
): { column: number; row: number; length: number } {
  return {
    column: range.startIndex % span.cols,
    row: span.startRow + Math.floor(range.startIndex / span.cols),
    length: range.endIndex - range.startIndex
  }
}
