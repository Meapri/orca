import type { TerminalCommandMark } from './terminal-mark-store'

export type TerminalLineRange = { start: number; end: number }

/**
 * Absolute buffer rows holding a command's output. A running command (no D yet)
 * is bounded by the next prompt or the cursor row; null when nothing was printed.
 */
export function resolveCommandOutputRange(
  command: TerminalCommandMark,
  nextPromptLine: number | null,
  cursorAbsoluteLine: number
): TerminalLineRange | null {
  const output = command.output
  if (!output || output.isDisposed) {
    return null
  }
  const start = output.line
  let end: number
  if (command.outputEnd && !command.outputEnd.isDisposed) {
    end = command.outputEndsMidLine ? command.outputEnd.line : command.outputEnd.line - 1
  } else {
    end = nextPromptLine !== null ? nextPromptLine - 1 : cursorAbsoluteLine
  }
  return end >= start ? { start, end } : null
}

/** The IBufferLine subset text extraction needs. */
export type TerminalTextLine = {
  readonly isWrapped: boolean
  translateToString: (trimRight?: boolean) => string
}

/** Joins buffer rows, gluing soft-wrapped rows back into their logical line. */
export function readTerminalLineRangeText(
  getLine: (row: number) => TerminalTextLine | undefined,
  range: TerminalLineRange
): string {
  const parts: string[] = []
  for (let row = range.start; row <= range.end; row += 1) {
    const line = getLine(row)
    if (!line) {
      break
    }
    const next = row < range.end ? getLine(row + 1) : undefined
    // Why: a wrapped row continues its predecessor, so trailing blanks are real content there.
    parts.push(line.translateToString(!next?.isWrapped))
    if (row < range.end && !next?.isWrapped) {
      parts.push('\n')
    }
  }
  return parts.join('').replace(/\n+$/, '')
}
