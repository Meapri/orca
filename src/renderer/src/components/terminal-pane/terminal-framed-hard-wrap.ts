import type { TerminalCopyRow } from './terminal-selection-cells'

/** A content row of a closed TUI frame; `ink` is measured on the full row, in cells. */
export type FramedCopyRow = {
  row: TerminalCopyRow
  text: string
  ink: { indent: number; end: number } | null
  innerFrom: number
  innerTo: number
}

const LIST_MARKER = /^(?:[-*•◦▪‣+]|\d+[.)])\s+/
const BLOCK_START = /^(?:[-*•◦▪‣+>#]\s|\d+[.)]\s|```|[│┃║╭╰├└┌])/
// Why: rows ending like code statements are lines a program printed, not prose a TUI wrapped.
const CODE_LINE_END = /[;{}[\]()\\]$/
// Han, Hiragana, Katakana: scripts written without spaces between words.
const SPACELESS_SCRIPT = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/

function firstWordWidth(row: FramedCopyRow): number {
  if (!row.ink) {
    return 0
  }
  let width = 0
  for (let x = row.ink.indent; x < row.innerTo; x++) {
    const cell = row.row.cells[x]
    if (cell.width === 0) {
      continue
    }
    if (cell.chars === '' || cell.chars === ' ') {
      break
    }
    width += cell.width
  }
  return width
}

function inkCell(row: FramedCopyRow, edge: 'first' | 'last'): { chars: string; width: number } {
  const x = edge === 'first' ? row.ink!.indent : row.ink!.end - 1
  const cell = row.row.cells[x]
  // Why: the last ink column of a wide glyph is its width-0 spacer.
  return cell.width === 0 ? row.row.cells[x - 1] : cell
}

function continuationIndent(row: FramedCopyRow): number {
  const marker = LIST_MARKER.exec(row.text.trimStart())
  return row.ink!.indent + (marker ? marker[0].length : 0)
}

function looksCharWrapped(text: string): boolean {
  const body = text.trim()
  if (!/\s/.test(body)) {
    return true
  }
  const lastToken = body.slice(body.search(/\S+$/))
  return lastToken.includes('://') || (lastToken.length >= 8 && /[\\/]/.test(lastToken))
}

function wrapEdge(rows: readonly FramedCopyRow[]): number | null {
  let padLeft = Number.POSITIVE_INFINITY
  let trailingGap = Number.POSITIVE_INFINITY
  let innerTo: number | null = null
  for (const row of rows) {
    if (!row.ink) {
      continue
    }
    padLeft = Math.min(padLeft, row.ink.indent - row.innerFrom)
    trailingGap = Math.min(trailingGap, row.innerTo - row.ink.end)
    innerTo = row.innerTo
  }
  return innerTo === null ? null : innerTo - Math.min(padLeft, trailingGap)
}

/**
 * Rejoins rows a TUI greedily word-wrapped at its frame width. Row B continues
 * row A only when B's first word could not have fit after A (the defining
 * property of a greedy wrap), B keeps A's paragraph indent, B does not open a
 * new list item, quote, heading or fence, and A does not end like code.
 * Rows run together without a space only when A filled the frame and was
 * split mid-token (a URL, a path) or mid-sentence in a spaceless script.
 */
export function joinTerminalFramedHardWraps(rows: readonly FramedCopyRow[]): string[] {
  const edge = wrapEdge(rows)
  const lines: string[] = []
  let previous: FramedCopyRow | null = null
  let indent = 0
  for (const row of rows) {
    if (!row.ink || edge === null) {
      lines.push(row.text)
      previous = null
      continue
    }
    const startsBlock = BLOCK_START.test(row.text.trimStart())
    const firstCell = inkCell(row, 'first')
    const couldNotFit = previous !== null && previous.ink!.end + 1 + firstWordWidth(row) > edge
    if (
      previous &&
      couldNotFit &&
      !startsBlock &&
      row.ink.indent === indent &&
      !CODE_LINE_END.test(previous.text.trimEnd())
    ) {
      const lastCell = inkCell(previous, 'last')
      const filled = previous.ink!.end >= edge - (firstCell.width > 1 ? 1 : 0)
      const spaceless =
        filled &&
        (looksCharWrapped(previous.text) ||
          (SPACELESS_SCRIPT.test(lastCell.chars) && SPACELESS_SCRIPT.test(firstCell.chars)))
      const joined = `${lines.pop()!.trimEnd()}${spaceless ? '' : ' '}${row.text.trimStart()}`
      lines.push(joined)
    } else {
      lines.push(row.text)
      indent = continuationIndent(row)
    }
    previous = row
  }
  return lines
}
