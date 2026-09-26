import type { IMarker } from '@xterm/xterm'
import type { TerminalScrollIntent } from './terminal-scroll-intent-key-store'

export type TerminalScrollIntentAnchorTarget = {
  buffer?: {
    active?: {
      type?: string
      viewportY?: number
      baseY?: number
      cursorY?: number
    }
  }
  registerMarker?: (cursorYOffset?: number) => IMarker | undefined
}

type TerminalScrollIntentAnchor = {
  revision: number
  marker: IMarker
}

// Why: a pin stores an absolute buffer line, but trimming a full scrollback
// renumbers every line. An xterm marker follows its line through trims (and
// reflow), so a later restore lands on the content the user was reading.
const anchorByTerminal = new WeakMap<object, TerminalScrollIntentAnchor>()

function releaseTerminalScrollIntentAnchor(terminal: object): void {
  anchorByTerminal.get(terminal)?.marker.dispose()
  anchorByTerminal.delete(terminal)
}

export function anchorPinnedScrollIntent(
  terminal: TerminalScrollIntentAnchorTarget,
  intent: TerminalScrollIntent
): void {
  releaseTerminalScrollIntentAnchor(terminal)
  const buffer = terminal.buffer?.active
  if (
    intent.kind !== 'pinnedViewport' ||
    intent.bufferType !== 'normal' ||
    buffer?.type === 'alternate' ||
    typeof terminal.registerMarker !== 'function' ||
    typeof buffer?.baseY !== 'number' ||
    typeof buffer.cursorY !== 'number' ||
    intent.viewportY < 0 ||
    intent.viewportY > buffer.baseY
  ) {
    return
  }
  let marker: IMarker | undefined
  try {
    marker = terminal.registerMarker(intent.viewportY - (buffer.baseY + buffer.cursorY))
  } catch {
    return
  }
  if (marker && !marker.isDisposed && marker.line === intent.viewportY) {
    anchorByTerminal.set(terminal, { revision: intent.revision, marker })
  } else {
    marker?.dispose()
  }
}

/** The pinned line's current buffer index, following any trims since the pin was recorded. */
export function resolvePinnedViewportY(terminal: object, intent: TerminalScrollIntent): number {
  const anchor = anchorByTerminal.get(terminal)
  if (
    !anchor ||
    anchor.revision !== intent.revision ||
    anchor.marker.isDisposed ||
    anchor.marker.line < 0
  ) {
    return intent.viewportY
  }
  return anchor.marker.line
}
