import type { IBufferLine } from '@xterm/xterm'
import type { TerminalCopyCell, TerminalCopyRow } from './terminal-selection-cells'
import { detectTerminalTuiFrames } from './terminal-tui-frame'
import {
  buildHardWrappedPathLogicalLineCandidates,
  translateLineWithColumns,
  type WrappedLogicalLine
} from './wrapped-terminal-link-ranges'

type LinkBuffer = { getLine(y: number): IBufferLine | undefined }

// Matches the hard-wrapped path scan depth, so a framed path can span as many rows.
const MAX_FRAMED_PATH_ROWS = 20
const FRAME_SIDE_START = /^\s*[│┃║╎╏┆┇┊┋▏▕▌▐]/

function toCopyRow(line: IBufferLine): TerminalCopyRow {
  const { text, columns } = translateLineWithColumns(line)
  const cells: TerminalCopyCell[] = Array.from({ length: line.length }, () => ({
    chars: ' ',
    width: 1
  }))
  let index = 0
  while (index < text.length) {
    const column = columns[index]
    let end = index + 1
    while (end < text.length && columns[end] === column) {
      end++
    }
    const nextColumn = columns[end] ?? column + 1
    if (column < cells.length) {
      cells[column] = { chars: text.slice(index, end), width: nextColumn - column }
      for (let spacer = column + 1; spacer < nextColumn && spacer < cells.length; spacer++) {
        cells[spacer] = { chars: '', width: 0 }
      }
    }
    index = end
  }
  return { cells, isWrapped: line.isWrapped }
}

/** A buffer line showing only a frame's interior; border cells read as blanks at their own columns. */
function interiorLine(row: TerminalCopyRow, from: number, to: number): IBufferLine {
  const translateToString = (
    _trimRight?: boolean,
    startColumn = 0,
    endColumn = row.cells.length,
    outColumns?: number[]
  ): string => {
    if (outColumns) {
      outColumns.length = 0
    }
    let text = ''
    let x = startColumn
    while (x < endColumn) {
      const cell = row.cells[x]
      const chars = x >= from && x < to ? cell.chars || ' ' : ' '
      text += chars
      for (let unit = 0; unit < chars.length; unit++) {
        outColumns?.push(x)
      }
      x += (x >= from && x < to && cell.width) || 1
    }
    outColumns?.push(x)
    return text
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: link-range code reads only isWrapped, length and translateToString, and gets full columns so it never falls back to getCell.
  return { isWrapped: false, length: row.cells.length, translateToString } as unknown as IBufferLine
}

/**
 * Hard-wrapped path candidates for a row inside a TUI box: the frame's side
 * borders are blanked so the ordinary hard-wrap scan sees the path fragments
 * alone, while every fragment keeps its real screen columns for hit-testing.
 */
export function buildFramedHardWrappedPathLogicalLineCandidates(
  buffer: LinkBuffer,
  bufferLineNumber: number
): WrappedLogicalLine[] {
  const currentY = bufferLineNumber - 1
  const current = buffer.getLine(currentY)
  // Why: hover runs this for every row; only rows that start with a frame side can qualify.
  if (!current || !FRAME_SIDE_START.test(current.translateToString(true))) {
    return []
  }
  const firstY = Math.max(0, currentY - MAX_FRAMED_PATH_ROWS + 1)
  const rows: TerminalCopyRow[] = []
  for (let y = firstY; y < currentY + MAX_FRAMED_PATH_ROWS; y++) {
    const line = buffer.getLine(y)
    if (!line) {
      break
    }
    rows.push(toCopyRow(line))
  }
  const frames = detectTerminalTuiFrames(rows)
  const currentFrame = frames[currentY - firstY]
  if (currentFrame?.kind !== 'content') {
    return []
  }
  const interiors = new Map<number, IBufferLine>()
  frames.forEach((frameRow, index) => {
    if (frameRow?.kind === 'content' && frameRow.runId === currentFrame.runId) {
      const { left, right } = frameRow.frame
      const row = rows[index]
      interiors.set(firstY + index, interiorLine(row, left + 1, right ?? row.cells.length))
    }
  })
  return buildHardWrappedPathLogicalLineCandidates(
    { getLine: (y) => interiors.get(y) },
    bufferLineNumber,
    MAX_FRAMED_PATH_ROWS
  ).map((candidate) => ({ ...candidate, fingerprint: `framed:${candidate.fingerprint}` }))
}
