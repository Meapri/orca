import type { IMarker } from '@xterm/xterm'
import { terminalInputLineCharacterDistance } from './terminal-click-to-move-cursor-plan'
import {
  encodeTerminalBackspaces,
  terminalInputEditableBounds,
  terminalInputSpanText
} from './terminal-input-selection-edit-plan'
import type { TerminalInputEditContext } from './terminal-input-edit-context'

/** The edit Cmd/Ctrl+Z can reverse: `removed` replaced by `inserted` at `startIndex`. */
type EditRecord = {
  marker: IMarker
  startIndex: number
  /** Editable text before the edit, which must be unchanged for a reversal to be safe. */
  prefix: string
  removed: string
  inserted: string
  undone: boolean
}

// Why: past this many typed characters the edit is no longer one GUI "replace" step.
const MAX_RECORDED_INSERT = 256

/**
 * One level of undo/redo for Orca's own selection edits. A reversal is sent only when the line
 * still reads exactly as the edit left it, with the cursor right after the inserted text.
 */
export class TerminalInputEditHistory {
  private _record: EditRecord | null = null

  record(
    marker: IMarker | undefined,
    context: TerminalInputEditContext,
    startIndex: number,
    removed: string
  ): void {
    this.drop()
    if (!marker) {
      return
    }
    const { lower } = terminalInputEditableBounds(context.span)
    const prefix = terminalInputSpanText(context.span, { startIndex: lower, endIndex: startIndex })
    this._record = { marker, startIndex, prefix, removed, inserted: '', undone: false }
  }

  /** Text the user typed right after the edit; anything else ends the record. */
  noteInserted(text: string): void {
    const record = this._record
    if (
      !record ||
      record.undone ||
      /[\r\n\t]/.test(text) ||
      record.inserted.length + text.length > MAX_RECORDED_INSERT
    ) {
      this.drop()
      return
    }
    record.inserted += text
  }

  drop(): void {
    this._record?.marker.dispose()
    this._record = null
  }

  /** Bytes that reverse (or redo) the edit, or null when the line no longer proves it safe. */
  reverse(context: TerminalInputEditContext | null, direction: 'undo' | 'redo'): string | null {
    const record = this._record
    if (!record || record.marker.isDisposed || record.undone !== (direction === 'redo')) {
      return null
    }
    if (!context || context.span.startRow !== record.marker.line) {
      return null
    }
    const { span } = context
    const { lower } = terminalInputEditableBounds(span)
    const current = direction === 'undo' ? record.inserted : record.removed
    const restored = direction === 'undo' ? record.removed : record.inserted
    const typed = terminalInputSpanText(span, {
      startIndex: record.startIndex,
      endIndex: span.cursorIndex
    })
    const prefix = terminalInputSpanText(span, { startIndex: lower, endIndex: record.startIndex })
    if (record.startIndex < lower || typed !== current || prefix !== record.prefix) {
      return null
    }
    const backspaces = encodeTerminalBackspaces(
      terminalInputLineCharacterDistance(span, record.startIndex, span.cursorIndex),
      context.modes.kittyKeyboardFlags
    )
    if (backspaces === null) {
      return null
    }
    record.undone = direction === 'undo'
    return backspaces + restored
  }
}
