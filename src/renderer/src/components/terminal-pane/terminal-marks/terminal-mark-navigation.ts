export type TerminalMarkNavigationDirection = 'previous' | 'next'

/** Viewport facts the reference line is derived from (absolute buffer rows). */
export type TerminalMarkViewport = {
  viewportY: number
  baseY: number
  cursorAbsoluteLine: number
}

/** The mark the last jump landed on, valid only while the viewport has not moved since. */
export type TerminalMarkJumpMemory = { line: number; viewportY: number } | null

/**
 * Line the next jump is measured from: the last jump target while the viewport
 * stayed put, the cursor row when following output (so "previous" reaches the
 * last finished command, not the top of the screen), else the viewport top.
 */
export function resolveMarkNavigationReference(
  viewport: TerminalMarkViewport,
  direction: TerminalMarkNavigationDirection,
  memory: TerminalMarkJumpMemory
): number {
  if (memory && memory.viewportY === viewport.viewportY) {
    return memory.line
  }
  if (direction === 'previous' && viewport.viewportY >= viewport.baseY) {
    return viewport.cursorAbsoluteLine
  }
  return viewport.viewportY
}

/** Closest mark strictly before/after `reference`; `lines` must be ascending. */
export function findAdjacentMarkLine(
  lines: readonly number[],
  reference: number,
  direction: TerminalMarkNavigationDirection
): number | null {
  if (direction === 'previous') {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i] < reference) {
        return lines[i]
      }
    }
    return null
  }
  for (const line of lines) {
    if (line > reference) {
      return line
    }
  }
  return null
}
