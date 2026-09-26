import { stripTerminalSelectionGutter } from '../../../../shared/terminal-selection-gutter'
import { stripTerminalCopyLineNumberGutter } from './terminal-copy-line-number-gutter'
import {
  terminalCopyRowText,
  type TerminalCopyRow,
  type TerminalCopySelection
} from './terminal-selection-cells'
import {
  detectTerminalTuiFrames,
  type TerminalTuiFrame,
  type TerminalTuiFrameRow
} from './terminal-tui-frame'
import { joinTerminalFramedHardWraps, type FramedCopyRow } from './terminal-framed-hard-wrap'

type Block = string[]

function rowSpan(
  selection: TerminalCopySelection,
  index: number
): { from: number; to: number; partial: boolean } {
  const row = selection.rows[index]
  const from = index === 0 ? selection.startX : 0
  const to = index === selection.rows.length - 1 ? selection.endX : row.cells.length
  return { from, to, partial: from > 0 || to < row.cells.length }
}

function inkBounds(
  row: TerminalCopyRow,
  from: number,
  to: number
): { indent: number; end: number } | null {
  let indent = -1
  let end = -1
  for (let x = from; x < to; x++) {
    const cell = row.cells[x]
    if (cell.width === 0 || cell.chars === '' || cell.chars === ' ') {
      continue
    }
    if (indent === -1) {
      indent = x
    }
    end = x + cell.width
  }
  return indent === -1 ? null : { indent, end }
}

function framePadding(
  selection: TerminalCopySelection,
  indexes: readonly number[],
  frames: readonly (TerminalTuiFrameRow | null)[]
): number {
  let padding = Number.POSITIVE_INFINITY
  for (const index of indexes) {
    const frameRow = frames[index]
    if (frameRow?.kind !== 'content') {
      continue
    }
    const row = selection.rows[index]
    const innerFrom = frameRow.frame.left + 1
    const ink = inkBounds(row, innerFrom, frameRow.frame.right ?? row.cells.length)
    if (ink) {
      padding = Math.min(padding, ink.indent - innerFrom)
    }
  }
  return Number.isFinite(padding) ? padding : 0
}

function framedContentRow(
  selection: TerminalCopySelection,
  index: number,
  frame: TerminalTuiFrame,
  padding: number
): FramedCopyRow | null {
  const row = selection.rows[index]
  const innerFrom = frame.left + 1
  const innerTo = frame.right ?? row.cells.length
  const span = rowSpan(selection, index)
  // Why: padding is measured on whole rows, so a drag starting mid-row still loses it.
  const from = Math.max(span.from, innerFrom + padding)
  const to = Math.min(span.to, innerTo)
  // Why: a drag that starts on the right border or ends on the left one
  // selected no content on that row; xterm would have copied a lone bar.
  if (from >= to && span.partial) {
    return null
  }
  return {
    row,
    text: from < to ? terminalCopyRowText(row, from, to) : '',
    ink: inkBounds(row, innerFrom, innerTo),
    innerFrom,
    innerTo
  }
}

function buildFramedBlock(
  selection: TerminalCopySelection,
  indexes: number[],
  frames: (TerminalTuiFrameRow | null)[]
): Block {
  const padding = framePadding(selection, indexes, frames)
  const segments: (FramedCopyRow | 'break')[] = []
  for (const index of indexes) {
    const frameRow = frames[index]!
    if (frameRow.kind === 'edge') {
      if (frameRow.divider) {
        segments.push('break')
      }
      continue
    }
    const content = framedContentRow(selection, index, frameRow.frame, padding)
    if (content) {
      segments.push(content)
    }
  }
  const lines: string[] = []
  let paragraph: FramedCopyRow[] = []
  const flush = (): void => {
    if (paragraph.length > 0) {
      const physical = paragraph.map((row) => row.text)
      const withoutNumbers = stripTerminalCopyLineNumberGutter(physical)
      const frame = frames[indexes[0]]!.frame
      // Why: numbered rows are code or diff lines; joining them would merge statements.
      const joined =
        withoutNumbers ?? (frame.right === null ? physical : joinTerminalFramedHardWraps(paragraph))
      lines.push(...joined)
    }
    paragraph = []
  }
  for (const segment of segments) {
    if (segment === 'break') {
      flush()
      lines.push('')
      continue
    }
    paragraph.push(segment)
  }
  flush()
  return trimBlankEdges(lines)
}

function buildUnframedBlock(selection: TerminalCopySelection, indexes: number[]): Block {
  const lines: string[] = []
  indexes.forEach((index, position) => {
    const { from, to } = rowSpan(selection, index)
    const text = terminalCopyRowText(selection.rows[index], from, to)
    // Why: xterm joins soft-wrapped rows; keep their boundary spaces, which a
    // per-row right trim would glue into one word.
    if (position > 0 && selection.rows[index].isWrapped) {
      lines[lines.length - 1] += text
    } else {
      lines.push(text)
    }
  })
  return stripTerminalCopyLineNumberGutter(lines) ?? lines
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start].trim()) {
    start++
  }
  while (end > start && !lines[end - 1].trim()) {
    end--
  }
  return lines.slice(start, end)
}

function groupBlocks(
  selection: TerminalCopySelection,
  frames: (TerminalTuiFrameRow | null)[]
): Block[] {
  const blocks: Block[] = []
  let indexes: number[] = []
  let currentRun: number | null = null
  const flush = (): void => {
    if (indexes.length > 0) {
      blocks.push(
        currentRun === null
          ? buildUnframedBlock(selection, indexes)
          : buildFramedBlock(selection, indexes, frames)
      )
    }
    indexes = []
  }
  selection.rows.forEach((_row, index) => {
    const runId = frames[index]?.runId ?? null
    if (runId !== currentRun) {
      flush()
      currentRun = runId
    }
    indexes.push(index)
  })
  flush()
  return blocks
}

/**
 * GUI-style text for a terminal selection: TUI frame borders and padding are
 * dropped, rows a framed TUI hard-wrapped are rejoined, unambiguous line-number
 * gutters are removed, soft wraps are joined without losing their boundary
 * spaces, and trailing cell padding is trimmed.
 */
export function buildTerminalSmartCopyText(
  selection: TerminalCopySelection,
  newline: string
): string {
  const frames = detectTerminalTuiFrames(selection.rows)
  const lines = groupBlocks(selection, frames).flatMap((block) =>
    // Why per block: a box's padding and the agent gutter around it differ, so
    // one shared indent would cancel both.
    block.length === 0 ? [] : stripTerminalSelectionGutter(block.join('\n')).split('\n')
  )
  return lines.map((line) => line.trimEnd()).join(newline)
}
