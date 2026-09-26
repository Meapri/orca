import type { ParsedTerminalFileLink } from './terminal-links'

// Why: git prints `a/` and `b/` pseudo-prefixes in diff headers; the real path
// is what follows, and linking the prefixed text would never resolve.
const DIFF_GIT_HEADER = /^diff --git a\/(\S+) b\/(\S+)\s*$/
const DIFF_FILE_HEADER = /^(?:---|\+\+\+) [ab]\/(\S+)\s*$/

function pathLink(lineText: string, pathText: string, from: number): ParsedTerminalFileLink {
  const startIndex = lineText.indexOf(pathText, from)
  return {
    pathText,
    line: null,
    column: null,
    startIndex,
    endIndex: startIndex + pathText.length,
    displayText: pathText
  }
}

/** Links for a git diff header line, or null when the line is not one. */
export function detectGitDiffHeaderFileLinks(lineText: string): ParsedTerminalFileLink[] | null {
  const gitHeader = DIFF_GIT_HEADER.exec(lineText)
  if (gitHeader) {
    const oldPath = pathLink(lineText, gitHeader[1], 'diff --git a/'.length)
    const newPath = pathLink(lineText, gitHeader[2], oldPath.endIndex + ' b/'.length)
    return [oldPath, newPath]
  }
  const fileHeader = DIFF_FILE_HEADER.exec(lineText)
  return fileHeader ? [pathLink(lineText, fileHeader[1], '--- a/'.length)] : null
}
