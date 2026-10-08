import type { IDisposable, Terminal } from '@xterm/xterm'
import {
  encodeTerminalClickToMoveArrows,
  encodeTerminalVerticalArrows,
  planTerminalClickToMoveArrows,
  type ClickToMoveBuffer,
  type ClickToMoveCellPosition,
  type ClickToMoveKeyModes
} from './terminal-click-to-move-cursor-plan'
import { resolveTerminalInputEditCursor } from './terminal-input-edit-cursor'

type ComposerRowRole = 'blank' | 'prompt' | 'continuation' | 'other'

// Why: past this the app would have to repaint a row per press; no composer is this tall.
export const MAX_INPUT_ROWS = 40

function isBlankChars(chars: string): boolean {
  return chars === '' || chars === ' '
}

/**
 * A composer that renders its own rows (Codex inline, per codex-inline-input-edit-*.txt) paints a
 * prompt glyph, a separator and text on its first row, and blanks the same prefix on every
 * continuation row, hard newline or soft wrap alike.
 */
function composerRowRole(
  buffer: ClickToMoveBuffer,
  row: number,
  textColumn: number,
  cols: number
): ComposerRowRole {
  const line = buffer.getLine(row)
  if (!line || line.isWrapped) {
    return 'other'
  }
  let prefixText = false
  for (let x = 0; x < textColumn; x += 1) {
    if (!isBlankChars(line.getCell(x)?.getChars() ?? '')) {
      prefixText = true
    }
  }
  let bodyText = false
  for (let x = textColumn; x < cols && !bodyText; x += 1) {
    bodyText = !isBlankChars(line.getCell(x)?.getChars() ?? '')
  }
  if (!prefixText) {
    return bodyText ? 'continuation' : 'blank'
  }
  const separator = line.getCell(textColumn - 1)?.getChars() ?? ''
  return isBlankChars(separator) ? 'prompt' : 'other'
}

function firstTextColumn(buffer: ClickToMoveBuffer, row: number, cols: number): number {
  const line = buffer.getLine(row)
  for (let x = 0; x < cols; x += 1) {
    if (!isBlankChars(line?.getCell(x)?.getChars() ?? '')) {
      return x
    }
  }
  return -1
}

/**
 * Rows of the multi-row input block around the cursor: a prompt row, then continuation rows up to
 * the first blank one. Null unless the cursor sits in such a block, so a shell prompt (whose next
 * rows are blank) or output above it never becomes a target for Up/Down, which would recall history.
 */
export function resolveTerminalInputRowBlock(input: {
  buffer: ClickToMoveBuffer
  cols: number
  cursorRow: number
  textColumn: number
}): { top: number; bottom: number } | null {
  const { buffer, cols, cursorRow, textColumn } = input
  if (textColumn <= 0 || textColumn >= cols) {
    return null
  }
  const roleOf = (row: number): ComposerRowRole => composerRowRole(buffer, row, textColumn, cols)
  let top = cursorRow
  if (roleOf(cursorRow) === 'continuation') {
    while (top > 0 && cursorRow - top < MAX_INPUT_ROWS && roleOf(top - 1) === 'continuation') {
      top -= 1
    }
    top -= 1
  }
  if (top < 0 || roleOf(top) !== 'prompt') {
    return null
  }
  let bottom = top
  while (bottom - top < MAX_INPUT_ROWS && roleOf(bottom + 1) === 'continuation') {
    bottom += 1
  }
  return cursorRow <= bottom ? { top, bottom } : null
}

// Why: the captured composers repaint within tens of ms; past this the app did not follow.
const VERTICAL_SETTLE_MS = 400

/**
 * A click on another row of a multi-row input: Up/Down to that row (the captured composer keeps
 * the column), then, once the app has moved the cursor there, Left/Right within the row. Nothing
 * after the vertical presses is sent if the cursor lands anywhere else. `textColumns` are the
 * learned input starts nearby; the first column that frames a block holding both rows is used.
 */
export function moveTerminalCursorAcrossInputRows(input: {
  terminal: Terminal
  cursor: ClickToMoveCellPosition
  target: ClickToMoveCellPosition
  textColumns: readonly number[]
  modes: () => ClickToMoveKeyModes
}): IDisposable | null {
  const { terminal, cursor, target } = input
  if (target.y === cursor.y) {
    return null
  }
  const buffer = terminal.buffer.active
  // Why: a continuation row's own indent names the text column even before a key taught it.
  const indents = [cursor.y, target.y].map((row) => firstTextColumn(buffer, row, terminal.cols))
  const candidates = new Set([...input.textColumns, ...indents.filter((column) => column > 0)])
  const textColumn = [...candidates].find((column) => {
    const block = resolveTerminalInputRowBlock({
      buffer,
      cols: terminal.cols,
      cursorRow: cursor.y,
      textColumn: column
    })
    return block !== null && target.y >= block.top && target.y <= block.bottom
  })
  if (textColumn === undefined) {
    return null
  }
  let settled = false
  const finish = (): void => {
    settled = true
    parsed.dispose()
    window.clearTimeout(timer)
  }
  const parsed = terminal.onWriteParsed(() => {
    const landed = resolveTerminalInputEditCursor(terminal)
    if (settled || !landed || landed.y !== target.y) {
      return
    }
    finish()
    const count = planTerminalClickToMoveArrows({
      buffer: terminal.buffer.active,
      cols: terminal.cols,
      cursor: landed,
      target,
      inputStart: { x: textColumn, y: target.y }
    })
    const data = count ? encodeTerminalClickToMoveArrows(count, input.modes()) : ''
    if (data) {
      terminal.input(data, true)
    }
  })
  const timer = window.setTimeout(finish, VERTICAL_SETTLE_MS)
  terminal.input(encodeTerminalVerticalArrows(target.y - cursor.y, input.modes()), true)
  return { dispose: () => (settled ? undefined : finish()) }
}
