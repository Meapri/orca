import type { IDisposable, Terminal } from '@xterm/xterm'
import {
  encodeTerminalClickToMoveArrows,
  planTerminalClickToMoveArrows
} from './terminal-click-to-move-cursor-plan'
import {
  getTerminalShellInputAnchor,
  observeTerminalUserInputPosition,
  type TerminalShellPromptPhase
} from './terminal-shell-input-anchor'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'
import { hasPendingTerminalImeComposition } from './terminal-ime-composition-route'

export type TerminalClickToMoveCursorMode = 'shell-prompt' | 'input-line' | 'off'

export const DEFAULT_TERMINAL_CLICK_TO_MOVE_CURSOR: TerminalClickToMoveCursorMode = 'input-line'

export function normalizeTerminalClickToMoveCursorMode(
  value: unknown
): TerminalClickToMoveCursorMode {
  return value === 'shell-prompt' || value === 'input-line' || value === 'off'
    ? value
    : DEFAULT_TERMINAL_CLICK_TO_MOVE_CURSOR
}

// Why: same budgets xterm uses for alt-click and Orca uses for link gestures.
const CLICK_MAX_DURATION_MS = 500
const CLICK_MAX_TRAVEL_PX = 4

export type ClickToMoveEligibilityInput = {
  mode: TerminalClickToMoveCursorMode
  /** Alt/Option-click: xterm's explicit move gesture, allowed outside detected prompts. */
  explicit: boolean
  phase: TerminalShellPromptPhase
  bufferType: 'normal' | 'alternate'
  mouseTrackingMode: string
  showCursor: boolean
  hadSelection: boolean
  hasSelection: boolean
  wasFocused: boolean
  linkHovered: boolean
  composing: boolean
}

export function isTerminalClickToMoveEligible(input: ClickToMoveEligibilityInput): boolean {
  if (input.mode === 'off' || input.bufferType !== 'normal') {
    return false
  }
  // Why: a mouse-reporting app owns clicks; a hidden cursor means the app draws its own caret.
  if (input.mouseTrackingMode !== 'none' || !input.showCursor) {
    return false
  }
  if (input.hadSelection || input.hasSelection || input.linkHovered || input.composing) {
    return false
  }
  if (input.explicit) {
    return true
  }
  // Why: the click that focuses a pane is a focus gesture, not an edit.
  if (!input.wasFocused) {
    return false
  }
  return input.mode === 'input-line' || input.phase === 'prompt'
}

type PendingClick = {
  clientX: number
  clientY: number
  timeStamp: number
  explicit: boolean
  wasFocused: boolean
  hadSelection: boolean
}

type ClickToMoveCursorOptions = {
  getMode: () => TerminalClickToMoveCursorMode
  getKittyKeyboardFlags: () => number
}

/**
 * Plain click on the cursor's input line moves the cursor with arrow presses. Takes over
 * xterm's cell-counting alt-click in the normal buffer so wide CJK glyphs count as one press.
 */
export function installTerminalClickToMoveCursor(
  terminal: Terminal,
  options: ClickToMoveCursorOptions
): IDisposable {
  const element = terminal.element
  const textarea = terminal.textarea
  if (!element) {
    return { dispose: () => undefined }
  }
  let pending: PendingClick | null = null

  const syncNativeAltClick = (): void => {
    // Why: keep xterm's alt-click where it navigates rows (alt screen) or when the feature is off.
    const native = options.getMode() === 'off' || terminal.buffer.active.type !== 'normal'
    if (terminal.options.altClickMovesCursor !== native) {
      terminal.options.altClickMovesCursor = native
    }
  }

  const onMouseDown = (event: MouseEvent): void => {
    pending = null
    syncNativeAltClick()
    const noOtherModifiers = !event.metaKey && !event.ctrlKey && !event.shiftKey
    if (event.button !== 0 || event.detail > 1 || !noOtherModifiers) {
      return
    }
    pending = {
      clientX: event.clientX,
      clientY: event.clientY,
      timeStamp: event.timeStamp,
      explicit: event.altKey,
      wasFocused: textarea !== undefined && element.ownerDocument.activeElement === textarea,
      hadSelection: terminal.hasSelection()
    }
  }

  const onMouseUp = (event: MouseEvent): void => {
    const click = pending
    pending = null
    if (
      !click ||
      event.button !== 0 ||
      event.timeStamp - click.timeStamp > CLICK_MAX_DURATION_MS ||
      Math.hypot(event.clientX - click.clientX, event.clientY - click.clientY) > CLICK_MAX_TRAVEL_PX
    ) {
      return
    }
    const buffer = terminal.buffer.active
    const anchor = getTerminalShellInputAnchor(terminal)
    const eligible = isTerminalClickToMoveEligible({
      mode: options.getMode(),
      explicit: click.explicit,
      phase: anchor.phase,
      bufferType: buffer.type,
      mouseTrackingMode: terminal.modes.mouseTrackingMode,
      showCursor: terminal.modes.showCursor,
      hadSelection: click.hadSelection,
      hasSelection: terminal.hasSelection(),
      wasFocused: click.wasFocused,
      linkHovered: element.classList.contains('xterm-cursor-pointer'),
      composing: hasPendingTerminalImeComposition(element)
    })
    if (!eligible) {
      return
    }
    const position = getTerminalBufferPositionForMouseEvent(terminal, event)
    if (!position) {
      return
    }
    const count = planTerminalClickToMoveArrows({
      buffer,
      cols: terminal.cols,
      cursor: { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY },
      target: { x: position.x - 1, y: position.y - 1 },
      inputStart: anchor.inputStart,
      allowLineStartFallback: click.explicit
    })
    const data = count
      ? encodeTerminalClickToMoveArrows(count, {
          applicationCursorKeys: terminal.modes.applicationCursorKeysMode,
          kittyKeyboardFlags: options.getKittyKeyboardFlags()
        })
      : ''
    if (data) {
      terminal.input(data, true)
    }
  }

  const onUserInput = (): void => observeTerminalUserInputPosition(terminal)

  element.addEventListener('mousedown', onMouseDown, true)
  element.addEventListener('mouseup', onMouseUp)
  textarea?.addEventListener('keydown', onUserInput, true)
  textarea?.addEventListener('compositionstart', onUserInput, true)
  const bufferChange = terminal.buffer.onBufferChange(syncNativeAltClick)
  syncNativeAltClick()

  return {
    dispose: () => {
      pending = null
      element.removeEventListener('mousedown', onMouseDown, true)
      element.removeEventListener('mouseup', onMouseUp)
      textarea?.removeEventListener('keydown', onUserInput, true)
      textarea?.removeEventListener('compositionstart', onUserInput, true)
      bufferChange.dispose()
    }
  }
}
