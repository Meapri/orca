import type { IDisposable, Terminal } from '@xterm/xterm'
import {
  encodeTerminalClickToMoveArrows,
  terminalInputLineCharacterDistance
} from './terminal-click-to-move-cursor-plan'
import {
  encodeTerminalSelectionDelete,
  planTerminalSelectionDelete,
  terminalInputSpanText,
  type TerminalInputSpanRange
} from './terminal-input-selection-edit-plan'
import { encodeTerminalControlLetter } from './terminal-line-editing-chords'
import {
  hasPendingTerminalImeComposition,
  XTERM_COMPOSITION_SESSION_END_EVENT
} from './terminal-ime-composition-route'
import {
  registerTerminalInputSpanMarker,
  resolveTerminalInputEditContext,
  resolveTerminalInputEditSelection,
  type TerminalInputEditContext
} from './terminal-input-edit-context'
import { TerminalInputEditHistory } from './terminal-input-edit-history'
import {
  resolveTerminalInputSelectionStep,
  TerminalInputKeyboardSelection
} from './terminal-input-keyboard-selection'

export type TerminalInputEditingKeyEvent = Pick<
  KeyboardEvent,
  | 'type'
  | 'key'
  | 'code'
  | 'metaKey'
  | 'ctrlKey'
  | 'altKey'
  | 'shiftKey'
  | 'isComposing'
  | 'keyCode'
>

type InputEditingOptions = {
  isEnabled: () => boolean
  isMac: boolean
  getKittyKeyboardFlags: () => number
  writeClipboardText?: (text: string) => Promise<void> | void
}

const editingByTerminal = new WeakMap<Terminal, TerminalInputSelectionEditing>()

export function getTerminalInputSelectionEditing(
  terminal: Terminal | null | undefined
): TerminalInputSelectionEditing | undefined {
  return terminal ? editingByTerminal.get(terminal) : undefined
}

/** Lets a selection on the input line consume a keydown, cancelling the event when it does. */
export function consumeTerminalInputSelectionKeyDown(
  terminal: Terminal | null | undefined,
  event: KeyboardEvent
): boolean {
  if (!getTerminalInputSelectionEditing(terminal)?.handleKeyDown(event)) {
    return false
  }
  event.preventDefault()
  event.stopImmediatePropagation()
  return true
}

const MODIFIER_KEYS = new Set(['Shift', 'Meta', 'Control', 'Alt'])

function isPrintableKey(event: TerminalInputEditingKeyEvent): boolean {
  return (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.key !== 'Dead' &&
    Array.from(event.key).length === 1 &&
    event.key >= ' '
  )
}

function isDeleteKey(event: TerminalInputEditingKeyEvent): boolean {
  return (event.key === 'Backspace' || event.key === 'Delete') && !event.shiftKey
}

function compositionData(event: Event): string | null {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined
  return typeof detail === 'object' &&
    detail !== null &&
    'data' in detail &&
    typeof detail.data === 'string' &&
    detail.data.length > 0
    ? detail.data
    : null
}

/**
 * GUI text-field editing on the input line, translated into keys every captured line editor
 * accepts (Left/Right, Backspace, typed text; see terminal-input-editing-transcripts.test.ts):
 * a selection there is replaced by typing, IME commits and paste, removed by Backspace/Delete and
 * cut, collapsed by Left/Right and grown by Shift+Arrow; Cmd/Ctrl+Z reverses the last such edit.
 * Anything it cannot prove safe (resolveTerminalInputEditContext) is left to the terminal.
 */
export class TerminalInputSelectionEditing {
  private readonly _history = new TerminalInputEditHistory()
  private readonly _keyboardSelection: TerminalInputKeyboardSelection
  private readonly _disposables: IDisposable[] = []

  constructor(
    private readonly _terminal: Terminal,
    private readonly _options: InputEditingOptions
  ) {
    this._keyboardSelection = new TerminalInputKeyboardSelection(_terminal)
    const textarea = _terminal.textarea
    const element = _terminal.element
    const onCompositionStart = (): void => this.replaceSelectionBeforeInsert()
    const onCompositionEnd = (event: Event): void => {
      const data = compositionData(event)
      if (data) {
        this._history.noteInserted(data)
      }
    }
    const onMouseDown = (): void => {
      this._history.drop()
      this._keyboardSelection.reset()
    }
    textarea?.addEventListener('compositionstart', onCompositionStart, true)
    element?.addEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, onCompositionEnd)
    element?.addEventListener('mousedown', onMouseDown, true)
    this._disposables.push({
      dispose: () => {
        textarea?.removeEventListener('compositionstart', onCompositionStart, true)
        element?.removeEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, onCompositionEnd)
        element?.removeEventListener('mousedown', onMouseDown, true)
      }
    })
  }

  /** Window-level keydown hook, run before the shortcut policy. True when the key was consumed. */
  handleKeyDown(event: TerminalInputEditingKeyEvent): boolean {
    if (event.type !== 'keydown' || !this._options.isEnabled()) {
      return false
    }
    if (event.isComposing || event.keyCode === 229 || MODIFIER_KEYS.has(event.key)) {
      return false
    }
    const undo = this._undoDirection(event)
    if (undo) {
      return this._applyUndo(undo, event)
    }
    const step = resolveTerminalInputSelectionStep(event, this._options.isMac)
    if (step) {
      const context = this._context()
      if (!context) {
        this._keyboardSelection.reset()
        return false
      }
      this._history.drop()
      return this._keyboardSelection.extend(context, step)
    }
    const context = this._context()
    const range = context ? resolveTerminalInputEditSelection(this._terminal, context.span) : null
    if (!context || !range) {
      this._keyboardSelection.reset()
      if (isPrintableKey(event)) {
        this._history.noteInserted(event.key)
      } else {
        this._history.drop()
      }
      return false
    }
    if (isDeleteKey(event) || this._isCut(event)) {
      if (this._isCut(event)) {
        void this._options.writeClipboardText?.(terminalInputSpanText(context.span, range))
      }
      return this._deleteRange(context, range)
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !this._hasModifier(event)) {
      const target = event.key === 'ArrowLeft' ? range.startIndex : range.endIndex
      const { span } = context
      const arrows = terminalInputLineCharacterDistance(span, span.cursorIndex, target)
      this._clearSelection()
      this._history.drop()
      this._send(encodeTerminalClickToMoveArrows(arrows, context.modes))
      return true
    }
    // Why: xterm types the key itself right after; the deletion only has to reach the pty first.
    if (isPrintableKey(event) && this._deleteRange(context, range)) {
      this._history.noteInserted(event.key)
    }
    return false
  }

  /** Removes an input-line selection before text that replaces it is written (IME commit, paste). */
  replaceSelectionBeforeInsert(inserted?: string): void {
    if (!this._options.isEnabled() || hasPendingTerminalImeComposition(this._terminal.element)) {
      return
    }
    const context = this._context()
    const range = context ? resolveTerminalInputEditSelection(this._terminal, context.span) : null
    if (context && range && this._deleteRange(context, range) && inserted !== undefined) {
      this._history.noteInserted(inserted)
    }
  }

  dispose(): void {
    this._history.drop()
    this._keyboardSelection.reset()
    for (const disposable of this._disposables.splice(0)) {
      disposable.dispose()
    }
  }

  private _context(): TerminalInputEditContext | null {
    return resolveTerminalInputEditContext(this._terminal, this._options.getKittyKeyboardFlags())
  }

  private _hasModifier(event: TerminalInputEditingKeyEvent): boolean {
    return event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
  }

  private _isCut(event: TerminalInputEditingKeyEvent): boolean {
    const { metaKey, ctrlKey, altKey, shiftKey } = event
    return (
      this._options.isMac && metaKey && !ctrlKey && !altKey && !shiftKey && event.code === 'KeyX'
    )
  }

  private _undoDirection(event: TerminalInputEditingKeyEvent): 'undo' | 'redo' | null {
    const isMac = this._options.isMac
    const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    if (!primary || event.altKey) {
      return null
    }
    if (event.code === 'KeyZ') {
      return event.shiftKey ? 'redo' : 'undo'
    }
    return !isMac && event.code === 'KeyY' && !event.shiftKey ? 'redo' : null
  }

  private _send(data: string): void {
    if (data) {
      this._terminal.input(data, true)
    }
  }

  private _clearSelection(): void {
    this._terminal.clearSelection()
    this._keyboardSelection.reset()
  }

  private _deleteRange(context: TerminalInputEditContext, range: TerminalInputSpanRange): boolean {
    const plan = planTerminalSelectionDelete(context.span, range)
    const data = encodeTerminalSelectionDelete(plan, context.modes)
    if (data === null) {
      return false
    }
    this._clearSelection()
    const marker = registerTerminalInputSpanMarker(this._terminal, context.span)
    this._history.record(marker, context, range.startIndex, plan.deletedText)
    this._send(data)
    return true
  }

  /**
   * Reverses Orca's last selection edit when the line still proves it safe; otherwise Cmd+Z falls
   * back to the line editor's own undo (Ctrl+_, bound by readline, zle and Claude Code in the
   * captured transcripts) and Ctrl+Z stays SIGTSTP.
   */
  private _applyUndo(direction: 'undo' | 'redo', event: TerminalInputEditingKeyEvent): boolean {
    const reversal = this._history.reverse(this._context(), direction)
    if (reversal !== null) {
      this._clearSelection()
      this._send(reversal)
      return true
    }
    if (direction === 'undo' && this._options.isMac && !event.shiftKey) {
      this._history.drop()
      this._send(encodeTerminalControlLetter('_', this._options.getKittyKeyboardFlags()))
      return true
    }
    return false
  }
}

export function installTerminalInputSelectionEditing(
  terminal: Terminal,
  options: InputEditingOptions
): IDisposable {
  const editing = new TerminalInputSelectionEditing(terminal, options)
  editingByTerminal.set(terminal, editing)
  return {
    dispose: () => {
      if (editingByTerminal.get(terminal) === editing) {
        editingByTerminal.delete(terminal)
      }
      editing.dispose()
    }
  }
}
