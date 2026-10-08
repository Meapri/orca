import type { IMarker, Terminal } from '@xterm/xterm'
import {
  stepTerminalInputSelectionFocus,
  terminalInputSpanSelectArgs,
  type TerminalInputSelectionUnit
} from './terminal-input-selection-edit-plan'
import {
  registerTerminalInputSpanMarker,
  resolveTerminalInputEditSelection,
  type TerminalInputEditContext
} from './terminal-input-edit-context'

type SelectionKeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

export type TerminalInputSelectionStep = {
  direction: 'left' | 'right'
  unit: TerminalInputSelectionUnit
}

/**
 * Shift+Arrow grows a GUI selection by a character; with Option (macOS) or Ctrl (elsewhere) by a
 * word; Cmd+Shift+Arrow (macOS) and Shift+Home/End to the input's ends.
 */
export function resolveTerminalInputSelectionStep(
  event: SelectionKeyEvent,
  isMac: boolean
): TerminalInputSelectionStep | null {
  if (!event.shiftKey) {
    return null
  }
  if (event.key === 'Home' || event.key === 'End') {
    return event.metaKey || event.ctrlKey || event.altKey
      ? null
      : { direction: event.key === 'Home' ? 'left' : 'right', unit: 'line' }
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
    return null
  }
  const direction = event.key === 'ArrowLeft' ? 'left' : 'right'
  const only = (modifier: 'metaKey' | 'ctrlKey' | 'altKey'): boolean =>
    event[modifier] &&
    (['metaKey', 'ctrlKey', 'altKey'] as const).every(
      (other) => other === modifier || !event[other]
    )
  if (only(isMac ? 'altKey' : 'ctrlKey')) {
    return { direction, unit: 'word' }
  }
  if (isMac && only('metaKey')) {
    return { direction, unit: 'line' }
  }
  return event.metaKey || event.ctrlKey || event.altKey ? null : { direction, unit: 'character' }
}

type KeyboardSelectionState = {
  marker: IMarker
  anchor: number
  focus: number
  select: { column: number; row: number; length: number }
}

/** A selection grown from the cursor by keyboard, drawn with xterm's own selection. */
export class TerminalInputKeyboardSelection {
  private _state: KeyboardSelectionState | null = null

  constructor(private readonly _terminal: Terminal) {}

  reset(): void {
    this._state?.marker.dispose()
    this._state = null
  }

  extend(context: TerminalInputEditContext, step: TerminalInputSelectionStep): boolean {
    const { span } = context
    const terminal = this._terminal
    let state = this._state
    const live = terminal.getSelectionPosition()
    const stillOurs =
      state !== null &&
      !state.marker.isDisposed &&
      state.marker.line === span.startRow &&
      live?.start.y === state.select.row &&
      live.start.x === state.select.column
    if (!state || !stillOurs) {
      this.reset()
      const marker = registerTerminalInputSpanMarker(terminal, span)
      if (!marker) {
        return false
      }
      // Why: an existing input-line selection is extended from its end, like a GUI field.
      const range = resolveTerminalInputEditSelection(terminal, span)
      const anchor = range ? range.startIndex : span.cursorIndex
      const focus = range ? range.endIndex : span.cursorIndex
      state = { marker, anchor, focus, select: { column: 0, row: -1, length: 0 } }
    }
    state.focus = stepTerminalInputSelectionFocus(span, state.focus, step.direction, step.unit)
    if (state.focus === state.anchor) {
      terminal.clearSelection()
      state.marker.dispose()
      this._state = null
      return true
    }
    const startIndex = Math.min(state.anchor, state.focus)
    const endIndex = Math.max(state.anchor, state.focus)
    state.select = terminalInputSpanSelectArgs(span, { startIndex, endIndex })
    terminal.select(state.select.column, state.select.row, state.select.length)
    this._state = state
    return true
  }
}
