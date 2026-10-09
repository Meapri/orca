import type { TerminalCopyRow } from './terminal-selection-cells'

// Box-drawing and block glyphs TUIs paint as frame sides. ASCII `|` is left out
// on purpose: it is far more often table or pipeline content than a frame.
const VERTICAL_SIDES = new Set(['│', '┃', '║', '╎', '╏', '┆', '┇', '┊', '┋', '▏', '▕', '▌', '▐'])
const LEFT_EDGE_CORNERS = new Set(['╭', '┌', '┏', '╔', '╒', '╓', '╰', '└', '┗', '╚', '╘', '╙'])
const LEFT_EDGE_TEES = new Set(['├', '┣', '╠', '╞', '╟'])
const RIGHT_EDGE_CORNERS = new Set(['╮', '┐', '┓', '╗', '╕', '╖', '╯', '┘', '┛', '╝', '╛', '╜'])
const RIGHT_EDGE_TEES = new Set(['┤', '┫', '╣', '╡', '╢'])
const HORIZONTAL_RULES = new Set(['─', '━', '═', '┄', '┅', '┈', '┉', '╌', '╍'])
const INTERIOR_JUNCTIONS = new Set([
  '┼',
  '┬',
  '┴',
  '╋',
  '┳',
  '┻',
  '╬',
  '╦',
  '╩',
  '╪',
  '╫',
  '┿',
  '╂'
])

/** A side of a detected frame: every row in the run has its border at these columns. */
export type TerminalTuiFrame = { left: number; right: number | null }

export type TerminalTuiFrameRow =
  | { kind: 'content'; frame: TerminalTuiFrame; runId: number }
  | { kind: 'edge'; frame: TerminalTuiFrame; runId: number; divider: boolean }

type FrameRowRole =
  | { kind: 'content'; left: number; right: number | null }
  | { kind: 'edge'; left: number; right: number | null; divider: boolean }

function isBlankCell(chars: string): boolean {
  return chars === '' || chars === ' '
}

function cellChars(row: TerminalCopyRow, x: number): string {
  return row.cells[x]?.chars ?? ''
}

function firstInkColumn(row: TerminalCopyRow): number {
  return row.cells.findIndex((cell) => cell.width > 0 && !isBlankCell(cell.chars))
}

function lastInkColumn(row: TerminalCopyRow): number {
  return row.cells.findLastIndex((cell) => cell.width > 0 && !isBlankCell(cell.chars))
}

function classifyRow(row: TerminalCopyRow): FrameRowRole | null {
  const left = firstInkColumn(row)
  if (left === -1) {
    return null
  }
  const leftChar = cellChars(row, left)
  const last = lastInkColumn(row)
  const lastChar = cellChars(row, last)
  if (VERTICAL_SIDES.has(leftChar)) {
    const right = last > left && VERTICAL_SIDES.has(lastChar) ? last : null
    return { kind: 'content', left, right }
  }
  const isCorner = LEFT_EDGE_CORNERS.has(leftChar)
  if (!isCorner && !LEFT_EDGE_TEES.has(leftChar)) {
    return null
  }
  // Why: tree glyphs like Codex's `└ output` start rows too; a frame edge is a rule line.
  if (!HORIZONTAL_RULES.has(cellChars(row, left + 1))) {
    return null
  }
  const closesRight =
    last > left && (isCorner ? RIGHT_EDGE_CORNERS.has(lastChar) : RIGHT_EDGE_TEES.has(lastChar))
  return { kind: 'edge', left, right: closesRight ? last : null, divider: !isCorner }
}

type Run = { left: number; right: number | null; rowIndexes: number[]; roles: FrameRowRole[] }

function sameFrame(run: Run, role: FrameRowRole): boolean {
  return run.left === role.left && run.right === role.right
}

function interiorSideColumns(row: TerminalCopyRow, frame: TerminalTuiFrame): number[] {
  const stop = frame.right ?? row.cells.length
  const columns: number[] = []
  for (let x = frame.left + 1; x < stop; x++) {
    if (VERTICAL_SIDES.has(cellChars(row, x))) {
      columns.push(x)
    }
  }
  return columns
}

function hasInteriorJunction(row: TerminalCopyRow, frame: TerminalTuiFrame): boolean {
  const stop = frame.right ?? row.cells.length
  for (let x = frame.left + 1; x < stop; x++) {
    if (INTERIOR_JUNCTIONS.has(cellChars(row, x))) {
      return true
    }
  }
  return false
}

// Why: a table's column separators line up like nested frame sides; copying a
// table cell-for-cell is safer than stripping part of its grid.
function looksLikeTable(rows: readonly TerminalCopyRow[], run: Run): boolean {
  const frame = { left: run.left, right: run.right }
  const seenSideColumns = new Set<number>()
  for (let index = 0; index < run.rowIndexes.length; index++) {
    const row = rows[run.rowIndexes[index]]
    if (run.roles[index].kind === 'edge') {
      if (hasInteriorJunction(row, frame)) {
        return true
      }
      continue
    }
    const columns = interiorSideColumns(row, frame)
    if (run.rowIndexes.length === 1 && columns.length > 0) {
      return true
    }
    for (const column of columns) {
      if (seenSideColumns.has(column)) {
        return true
      }
      seenSideColumns.add(column)
    }
  }
  return false
}

function isValidRun(rows: readonly TerminalCopyRow[], run: Run): boolean {
  const contentRows = run.roles.filter((role) => role.kind === 'content').length
  if (contentRows === 0) {
    return false
  }
  // Why: one left bar on one row is indistinguishable from content; a closed
  // box row, or a bar repeated down several rows, is a frame.
  if (run.right === null && contentRows < 2) {
    return false
  }
  if (run.right === null) {
    const sideChars = new Set(
      run.rowIndexes
        .filter((_rowIndex, index) => run.roles[index].kind === 'content')
        .map((rowIndex) => cellChars(rows[rowIndex], run.left))
    )
    if (sideChars.size !== 1) {
      return false
    }
  }
  return !looksLikeTable(rows, run)
}

/**
 * Finds runs of consecutive rows framed by the same TUI box sides. Rows that
 * belong to an xterm soft-wrap chain are never framed: a frame is painted per
 * screen row, so a wrapped row is ordinary text that happens to start with a bar.
 */
export function detectTerminalTuiFrames(
  rows: readonly TerminalCopyRow[]
): (TerminalTuiFrameRow | null)[] {
  const result: (TerminalTuiFrameRow | null)[] = rows.map(() => null)
  const runs: Run[] = []
  let current: Run | null = null
  rows.forEach((row, index) => {
    const inWrapChain = row.isWrapped || rows[index + 1]?.isWrapped === true
    const role = inWrapChain ? null : classifyRow(row)
    if (!role) {
      current = null
      return
    }
    if (current && sameFrame(current, role)) {
      current.rowIndexes.push(index)
      current.roles.push(role)
      return
    }
    current = { left: role.left, right: role.right, rowIndexes: [index], roles: [role] }
    runs.push(current)
  })
  runs.forEach((run, runId) => {
    if (!isValidRun(rows, run)) {
      return
    }
    const frame = { left: run.left, right: run.right }
    run.rowIndexes.forEach((rowIndex, index) => {
      const role = run.roles[index]
      result[rowIndex] =
        role.kind === 'edge'
          ? { kind: 'edge', frame, runId, divider: role.divider }
          : { kind: 'content', frame, runId }
    })
  })
  return result
}
