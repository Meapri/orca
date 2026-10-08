import type { Terminal } from '@xterm/xterm'
import { getTerminalAdoptedAppCaret } from '@/lib/pane-manager/terminal-app-caret-adoption'
import { resolveAppDrawnImeCaret } from '@/lib/pane-manager/terminal-ime-anchor'
import type { ClickToMoveCellPosition } from './terminal-click-to-move-cursor-plan'

/**
 * Where a line editor takes input, in absolute buffer cells: the shown cursor, or the app-drawn
 * caret Orca adopted while the app hides it (cursor-agent). Null when neither is known, so no
 * edit is synthesized against a parked cursor.
 */
export function resolveTerminalInputEditCursor(terminal: Terminal): ClickToMoveCellPosition | null {
  const buffer = terminal.buffer.active
  if (terminal.modes.showCursor) {
    return { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY }
  }
  const caret = getTerminalAdoptedAppCaret(terminal)
  return caret ? { x: caret.x, y: buffer.baseY + caret.y } : null
}

/**
 * Position recorded when a key is pressed, to learn where input starts. Before adoption arms (the
 * first key), a hidden cursor's lone inverse cell is the best guess; a guess on another line is
 * ignored by every edit, so it cannot move anything by itself.
 */
export function resolveTerminalInputLearningCursor(
  terminal: Terminal
): ClickToMoveCellPosition | null {
  const cursor = resolveTerminalInputEditCursor(terminal)
  if (cursor) {
    return cursor
  }
  const buffer = terminal.buffer.active
  const caret = resolveAppDrawnImeCaret({
    buffer,
    rows: terminal.rows,
    cols: terminal.cols,
    cursorVisible: false
  })
  return caret ? { x: caret.column, y: buffer.baseY + caret.row } : null
}
