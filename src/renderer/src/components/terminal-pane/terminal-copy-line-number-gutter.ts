// Line-number gutters (bat, `cat -n`, diff viewers inside agent boxes) are only
// stripped when the shape is unambiguous, because a numbered column is
// sometimes the content itself (a counted list, `seq` output).

// `  12 │ code`, with blank-number rows for a viewer's own wrapped continuation.
const SEPARATED_GUTTER = /^( *)(\d*) *[│┃▏|→]/
// `     1  code` as `cat -n`/`nl` print it once the tab is expanded.
const SPACED_GUTTER = /^( *)(\d+)( {2,}|$)/

const MIN_SEPARATED_NUMBERED_LINES = 2
const MIN_SPACED_NUMBERED_LINES = 3

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

function strictlyIncreasing(numbers: readonly number[], consecutive: boolean): boolean {
  for (let index = 1; index < numbers.length; index++) {
    const step = numbers[index] - numbers[index - 1]
    if (consecutive ? step !== 1 : step <= 0) {
      return false
    }
  }
  return true
}

function stripSeparatedGutter(lines: readonly string[]): string[] | null {
  let separatorIndex: number | null = null
  const numbers: number[] = []
  let contentLines = 0
  for (const line of lines) {
    if (isBlank(line)) {
      continue
    }
    const match = SEPARATED_GUTTER.exec(line)
    if (!match) {
      return null
    }
    const index = match[0].length - 1
    if (separatorIndex !== null && index !== separatorIndex) {
      return null
    }
    separatorIndex = index
    if (match[2]) {
      numbers.push(Number.parseInt(match[2], 10))
    }
    if (line.slice(index + 1).trim()) {
      contentLines++
    }
  }
  if (
    separatorIndex === null ||
    numbers.length < MIN_SEPARATED_NUMBERED_LINES ||
    contentLines === 0 ||
    !strictlyIncreasing(numbers, false)
  ) {
    return null
  }
  const cut = separatorIndex + 1
  return lines.map((line) => {
    if (isBlank(line)) {
      return ''
    }
    const rest = line.slice(cut)
    return rest.startsWith(' ') ? rest.slice(1) : rest
  })
}

function stripSpacedGutter(lines: readonly string[]): string[] | null {
  let numberEnd: number | null = null
  let cut = Number.POSITIVE_INFINITY
  const numbers: number[] = []
  let contentLines = 0
  for (const line of lines) {
    if (isBlank(line)) {
      continue
    }
    const match = SPACED_GUTTER.exec(line)
    if (!match) {
      return null
    }
    const end = match[1].length + match[2].length
    if (numberEnd !== null && end !== numberEnd) {
      return null
    }
    numberEnd = end
    numbers.push(Number.parseInt(match[2], 10))
    if (match[3]) {
      contentLines++
      cut = Math.min(cut, end + match[3].length)
    }
  }
  // Why: a column of bare numbers (`seq 1 200`) is content, not a gutter.
  if (
    numbers.length < MIN_SPACED_NUMBERED_LINES ||
    contentLines * 2 < numbers.length ||
    !Number.isFinite(cut) ||
    !strictlyIncreasing(numbers, true)
  ) {
    return null
  }
  return lines.map((line) => (isBlank(line) ? '' : line.slice(cut)))
}

/** Returns the lines without their line-number gutter, or null when there is no unambiguous one. */
export function stripTerminalCopyLineNumberGutter(lines: readonly string[]): string[] | null {
  return stripSeparatedGutter(lines) ?? stripSpacedGutter(lines)
}
