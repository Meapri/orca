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

type Anchor = { marker: AnchorMarker; x: number; exact: boolean }

type AnchorState = {
  phase: TerminalShellPromptPhase
  /** Most recent last; one per logical line, so a multi-row composer keeps each row's start. */
  anchors: Anchor[]
}

// Why: a composer's rows plus a few recent prompts; older lines are no longer being edited.
const MAX_ANCHORS = 8

const anchorStates = new WeakMap<ShellInputAnchorTerminal, AnchorState>()

function stateFor(terminal: ShellInputAnchorTerminal): AnchorState {
  let state = anchorStates.get(terminal)
  if (!state) {
    state = { phase: 'unknown', anchors: [] }
    anchorStates.set(terminal, state)
  }
  return state
}

function clearAnchors(state: AnchorState): void {
  for (const anchor of state.anchors.splice(0)) {
    anchor.marker.dispose()
  }
}

type AnchorPosition = { x: number; y: number }

function addAnchor(
  terminal: ShellInputAnchorTerminal,
  state: AnchorState,
  exact: boolean,
  position?: AnchorPosition
): void {
  const buffer = terminal.buffer.active
  const cursorRow = buffer.baseY + buffer.cursorY
  const marker = terminal.registerMarker(position ? position.y - cursorRow : 0)
  if (!marker) {
    return
  }
  state.anchors.push({ marker, x: position ? position.x : buffer.cursorX, exact })
  while (state.anchors.length > MAX_ANCHORS) {
    state.anchors.shift()?.marker.dispose()
  }
}

function isLive(anchor: Anchor | undefined): anchor is Anchor {
  return anchor !== undefined && !anchor.marker.isDisposed && anchor.marker.line >= 0
}

function anchorOnLine(
  buffer: ClickToMoveBuffer,
  state: AnchorState,
  row: number
): Anchor | undefined {
  const lineStart = logicalLineStartRow(buffer, row)
  for (let index = state.anchors.length - 1; index >= 0; index -= 1) {
    const anchor = state.anchors[index]
    if (isLive(anchor) && logicalLineStartRow(buffer, anchor.marker.line) === lineStart) {
      return anchor
    }
  }
  return undefined
}

function removeAnchor(state: AnchorState, anchor: Anchor): void {
  state.anchors = state.anchors.filter((candidate) => candidate !== anchor)
  anchor.marker.dispose()
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
    clearAnchors(state)
  } else if (kind === 'B') {
    // Why: B is emitted exactly where editable input begins, so it beats any learned guess.
    state.phase = 'prompt'
    clearAnchors(state)
    addAnchor(terminal, state, true)
  } else if (kind === 'C') {
    state.phase = 'running'
    clearAnchors(state)
  } else if (kind === 'D') {
    clearAnchors(state)
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
  const anchor = anchorOnLine(buffer, state, row)
  if (!anchor) {
    addAnchor(terminal, state, false, position)
    return
  }
  const isLeftOfAnchor = row < anchor.marker.line || (row === anchor.marker.line && x < anchor.x)
  if (!anchor.exact && isLeftOfAnchor) {
    removeAnchor(state, anchor)
    addAnchor(terminal, state, false, position)
  }
}

/** Every live learned input start, for inputs that span several rows. */
export function getTerminalShellInputAnchors(
  terminal: ShellInputAnchorTerminal
): { x: number; y: number }[] {
  const anchors = anchorStates.get(terminal)?.anchors ?? []
  return anchors.filter(isLive).map((anchor) => ({ x: anchor.x, y: anchor.marker.line }))
}

/** The input start learned on `row`'s logical line (default: the latest one learned). */
export function getTerminalShellInputAnchor(
  terminal: ShellInputAnchorTerminal,
  row?: number
): {
  phase: TerminalShellPromptPhase
  inputStart: { x: number; y: number } | null
} {
  const state = anchorStates.get(terminal)
  if (!state) {
    return { phase: 'unknown', inputStart: null }
  }
  const latest = state.anchors.at(-1)
  const anchor =
    row === undefined
      ? isLive(latest)
        ? latest
        : undefined
      : anchorOnLine(terminal.buffer.active, state, row)
  return {
    phase: state.phase,
    inputStart: anchor ? { x: anchor.x, y: anchor.marker.line } : null
  }
}
