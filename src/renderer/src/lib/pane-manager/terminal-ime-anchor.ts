import type { IBuffer } from '@xterm/xterm'
import { scanAppDrawnCarets, type AppDrawnCaretCell } from './terminal-app-drawn-caret'

export type TerminalImeAnchor = AppDrawnCaretCell

/**
 * The caret an app draws itself after hiding the terminal cursor, nearest the parked cursor when
 * several qualify (see scanAppDrawnCarets). `null` when the cursor is shown, since that is where
 * the app takes input.
 */
export function resolveAppDrawnImeCaret(args: {
  buffer: IBuffer
  rows: number
  cols: number
  cursorVisible: boolean
}): TerminalImeAnchor | null {
  if (args.cursorVisible) {
    return null
  }
  return scanAppDrawnCarets(args).nearest
}
