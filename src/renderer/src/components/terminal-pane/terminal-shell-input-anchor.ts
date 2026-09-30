import { logicalLineStartRow, type ClickToMoveBuffer } from './terminal-click-to-move-cursor-plan'

/** OSC 133 phase: 'prompt' after A/B until C; 'running' after C; 'unknown' without marks. */
export type TerminalShellPromptPhase = 'unknown' | 'prompt' | 'running'

type AnchorMarker = { readonly line: number; readonly isDisposed: boolean; dispose: () => void }

export type ShellInputAnchorTerminal = {
  buffer: {
    active: ClickToMoveBuffer & {
      readonly type: 'normal' | 'alternate'
      readonly cursorX: number
      readonly cursorY: number
      readonly baseY: number
    }
  }
  readonly cols: number
  registerMarker: (cursorYOffset?: number) => AnchorMarker | undefined
}

type AnchorState = {
  phase: TerminalShellPromptPhase
  anchor: { marker: AnchorMarker; x: number; exact: boolean } | null
}

const anchorStates = new WeakMap<ShellInputAnchorTerminal, AnchorState>()

function stateFor(terminal: ShellInputAnchorTerminal): AnchorState {
  let state = anchorStates.get(terminal)
  if (!state) {
    state = { phase: 'unknown', anchor: null }
    anchorStates.set(terminal, state)
  }
  return state
}

function clearAnchor(state: AnchorState): void {
  state.anchor?.marker.dispose()
  state.anchor = null
}

type AnchorPosition = { x: number; y: number }

function setAnchor(
  terminal: ShellInputAnchorTerminal,
  state: AnchorState,
  exact: boolean,
  position?: AnchorPosition
): void {
  const buffer = terminal.buffer.active
  const cursorRow = buffer.baseY + buffer.cursorY
  const marker = terminal.registerMarker(position ? position.y - cursorRow : 0)
  clearAnchor(state)
  if (marker) {
    state.anchor = { marker, x: position ? position.x : buffer.cursorX, exact }
  }
}

/** Feeds one OSC 133 payload (`A`, `B`, `C`, `D;0`, …) parsed at the current cursor position. */
export function observeTerminalShellIntegrationMark(
  terminal: ShellInputAnchorTerminal,
  data: string
): void {
  if (terminal.buffer.active.type !== 'normal') {
    return
  }
  const state = stateFor(terminal)
  const kind = data.split(';', 1)[0]
  if (kind === 'A') {
    state.phase = 'prompt'
    clearAnchor(state)
  } else if (kind === 'B') {
    // Why: B is emitted exactly where editable input begins, so it beats any learned guess.
    state.phase = 'prompt'
    setAnchor(terminal, state, true)
  } else if (kind === 'C') {
    state.phase = 'running'
    clearAnchor(state)
  } else if (kind === 'D') {
    clearAnchor(state)
  }
}

/**
 * Called on each user keystroke before the program echoes it: the cursor then sits inside the
 * editable span, so the leftmost such position on a logical line bounds where input starts.
 * `position` (absolute buffer cells) replaces the cursor when an app draws its own caret.
 */
export function observeTerminalUserInputPosition(
  terminal: ShellInputAnchorTerminal,
  position?: AnchorPosition | null
): void {
  const buffer = terminal.buffer.active
  if (position === null) {
    return
  }
  const x = position ? position.x : buffer.cursorX
  const row = position ? position.y : buffer.baseY + buffer.cursorY
  if (buffer.type !== 'normal' || x >= terminal.cols) {
    return
  }
  const state = stateFor(terminal)
  const anchor = state.anchor
  if (
    !anchor ||
    anchor.marker.isDisposed ||
    logicalLineStartRow(buffer, anchor.marker.line) !== logicalLineStartRow(buffer, row)
  ) {
    setAnchor(terminal, state, false, position)
    return
  }
  const isLeftOfAnchor = row < anchor.marker.line || (row === anchor.marker.line && x < anchor.x)
  if (!anchor.exact && isLeftOfAnchor) {
    setAnchor(terminal, state, false, position)
  }
}

export function getTerminalShellInputAnchor(terminal: ShellInputAnchorTerminal): {
  phase: TerminalShellPromptPhase
  inputStart: { x: number; y: number } | null
} {
  const state = anchorStates.get(terminal)
  if (!state) {
    return { phase: 'unknown', inputStart: null }
  }
  const anchor = state.anchor
  const inputStart =
    anchor && !anchor.marker.isDisposed && anchor.marker.line >= 0
      ? { x: anchor.x, y: anchor.marker.line }
      : null
  return { phase: state.phase, inputStart }
}
