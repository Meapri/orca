import type { Terminal } from '@xterm/xterm'
import {
  resolveTerminalInputLineSpan,
  type ClickToMoveKeyModes,
  type TerminalInputLineSpan
} from './terminal-click-to-move-cursor-plan'
import {
  encodeTerminalBackspaces,
  resolveTerminalInputSelection,
  type TerminalInputSpanRange
} from './terminal-input-selection-edit-plan'
import { getTerminalShellInputAnchor } from './terminal-shell-input-anchor'
import { resolveTerminalInputEditCursor } from './terminal-input-edit-cursor'
import { hasPendingTerminalImeComposition } from './terminal-ime-composition-route'

/** The cursor's input line and the key encoding a synthesized edit on it must use. */
export type TerminalInputEditContext = {
  span: TerminalInputLineSpan
  modes: ClickToMoveKeyModes
}

/**
 * Null wherever a synthesized edit could land somewhere else than the user sees: the alternate
 * screen or a mouse-reporting app (they own clicks and editing), an open IME composition, kitty's
 * report-all-keys mode, or a hidden cursor with no adopted app caret.
 */
export function resolveTerminalInputEditContext(
  terminal: Terminal,
  kittyKeyboardFlags: number
): TerminalInputEditContext | null {
  const buffer = terminal.buffer.active
  if (buffer.type !== 'normal' || terminal.modes.mouseTrackingMode !== 'none') {
    return null
  }
  if (
    hasPendingTerminalImeComposition(terminal.element) ||
    encodeTerminalBackspaces(0, kittyKeyboardFlags) === null
  ) {
    return null
  }
  const cursor = resolveTerminalInputEditCursor(terminal)
  if (!cursor) {
    return null
  }
  const span = resolveTerminalInputLineSpan({
    buffer,
    cols: terminal.cols,
    cursor,
    inputStart: getTerminalShellInputAnchor(terminal, cursor.y).inputStart
  })
  if (!span) {
    return null
  }
  const applicationCursorKeys = terminal.modes.applicationCursorKeysMode
  return { span, modes: { applicationCursorKeys, kittyKeyboardFlags } }
}

/** The terminal selection's editable part on the input line, if any. */
export function resolveTerminalInputEditSelection(
  terminal: Terminal,
  span: TerminalInputLineSpan
): TerminalInputSpanRange | null {
  const position = terminal.getSelectionPosition()
  return position ? resolveTerminalInputSelection(span, position) : null
}

/** Marker on the span's first row, so later checks follow scrollback. */
export function registerTerminalInputSpanMarker(terminal: Terminal, span: TerminalInputLineSpan) {
  const buffer = terminal.buffer.active
  return terminal.registerMarker(span.startRow - (buffer.baseY + buffer.cursorY))
}
