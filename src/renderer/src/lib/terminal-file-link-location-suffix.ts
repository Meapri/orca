import type { ParsedTerminalFileLink } from './terminal-links'

// Location shapes compilers and runners print beside a path that the
// `path:line:col` parser does not cover. Each only adds a line/column to a
// link the path detectors already found; none makes new text clickable.

// `src/app.ts(12,5)` — tsc --pretty false, MSBuild, C#, VS.
const PAREN_LOCATION_START = /^(.+\.[A-Za-z0-9_+-]+)\((\d+)$/
const PAREN_LOCATION_REST = /^(?:,(\d+))?\)/
// `File "app.py", line 42` — Python tracebacks.
const PYTHON_LINE_SUFFIX = /^", line (\d+)/
// `src/app.ts#L12`, `#L12C5`, `#L12-L20` — GitHub-style anchors agents echo.
const ANCHOR_LOCATION_SUFFIX = /^#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?/

function positive(value: string | undefined): number | null {
  if (value === undefined) {
    return null
  }
  const parsed = Number.parseInt(value, 10)
  return parsed >= 1 ? parsed : null
}

function withParenLocation(
  lineText: string,
  link: ParsedTerminalFileLink
): ParsedTerminalFileLink | null {
  const start = PAREN_LOCATION_START.exec(link.pathText)
  if (!start || link.line !== null) {
    return null
  }
  const rest = PAREN_LOCATION_REST.exec(lineText.slice(link.endIndex))
  const line = positive(start[2])
  if (!rest || line === null) {
    return null
  }
  const endIndex = link.endIndex + rest[0].length
  return {
    ...link,
    pathText: start[1],
    line,
    column: positive(rest[1]),
    endIndex,
    displayText: lineText.slice(link.startIndex, endIndex)
  }
}

function withTrailingLocation(
  lineText: string,
  link: ParsedTerminalFileLink
): ParsedTerminalFileLink | null {
  const after = lineText.slice(link.endIndex)
  const python = PYTHON_LINE_SUFFIX.exec(after)
  if (python && link.line === null && lineText[link.startIndex - 1] === '"') {
    // Why: the path stays the hover target; the quoted line number is context.
    return { ...link, line: positive(python[1]) }
  }
  const anchor = ANCHOR_LOCATION_SUFFIX.exec(after)
  if (anchor && link.line === null) {
    const endIndex = link.endIndex + anchor[0].length
    return {
      ...link,
      line: positive(anchor[1]),
      column: positive(anchor[2]),
      endIndex,
      displayText: lineText.slice(link.startIndex, endIndex)
    }
  }
  return null
}

/** Adds a line/column printed in a non-colon shape right after a detected path. */
export function applyTerminalFileLinkLocationSuffix(
  lineText: string,
  link: ParsedTerminalFileLink
): ParsedTerminalFileLink {
  return withParenLocation(lineText, link) ?? withTrailingLocation(lineText, link) ?? link
}
