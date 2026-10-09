import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { extractTerminalFileLinks } from '@/lib/terminal-links'
import { buildFramedHardWrappedPathLogicalLineCandidates } from './framed-terminal-path-links'
import { buildCandidateLogicalLinesForBufferPosition } from './terminal-file-link-hit-testing'
import { rangeForParsedFileLink } from './wrapped-terminal-link-ranges'

async function screen(lines: string[]): Promise<Terminal> {
  const term = new Terminal({ cols: 40, rows: 12, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(lines.join('\r\n'), resolve))
  return term
}

function framedLinks(term: Terminal, bufferLineNumber: number) {
  return buildFramedHardWrappedPathLogicalLineCandidates(
    term.buffer.active,
    bufferLineNumber
  ).flatMap((logicalLine) =>
    extractTerminalFileLinks(logicalLine.text).map((link) => ({
      pathText: link.pathText,
      line: link.line,
      range: rangeForParsedFileLink(logicalLine, link.startIndex, link.endIndex)
    }))
  )
}

const WRAPPED_PATH_BOX = [
  '╭────────────────────────╮',
  '│ Edited /Users/me/proj/ │',
  '│ src/components/app.tsx │',
  '│ with two changes       │',
  '╰────────────────────────╯'
]

describe('buildFramedHardWrappedPathLogicalLineCandidates', () => {
  it('joins a path a TUI box hard-wrapped, keeping real screen columns', async () => {
    const term = await screen(WRAPPED_PATH_BOX)
    for (const bufferLineNumber of [2, 3]) {
      expect(framedLinks(term, bufferLineNumber)).toContainEqual({
        pathText: '/Users/me/proj/src/components/app.tsx',
        line: null,
        range: { start: { x: 10, y: 2 }, end: { x: 24, y: 3 } }
      })
    }
  })

  it('keeps a location suffix that lands on the continuation row', async () => {
    const term = await screen([
      '╭────────────────────────╮',
      '│ see ./packages/server/ │',
      '│ index.ts:12:4 for more │',
      '╰────────────────────────╯'
    ])
    expect(framedLinks(term, 3).map(({ pathText, line }) => [pathText, line])).toContainEqual([
      './packages/server/index.ts',
      12
    ])
  })

  it('is part of the shared candidate set used by hover and click', async () => {
    const term = await screen(WRAPPED_PATH_BOX)
    const texts = buildCandidateLogicalLinesForBufferPosition(term.buffer.active, 3).map(
      (logicalLine) => logicalLine.text
    )
    expect(texts.some((text) => text.includes('/Users/me/proj/src/components/app.tsx'))).toBe(true)
  })

  it('ignores rows outside a frame and table grids', async () => {
    const plain = await screen(['Edited /Users/me/proj/', 'src/components/app.tsx'])
    expect(buildFramedHardWrappedPathLogicalLineCandidates(plain.buffer.active, 1)).toEqual([])
    const table = await screen([
      '│ /Users/me/a │ x │',
      '├─────────────┼───┤',
      '│ src/b.ts    │ y │'
    ])
    expect(buildFramedHardWrappedPathLogicalLineCandidates(table.buffer.active, 1)).toEqual([])
  })

  it('does not join across the box edge into the next box', async () => {
    const term = await screen([
      '╭──────────────────╮',
      '│ /Users/me/proj/  │',
      '╰──────────────────╯',
      '╭──────────────────╮',
      '│ src/app.ts       │',
      '╰──────────────────╯'
    ])
    const texts = buildFramedHardWrappedPathLogicalLineCandidates(term.buffer.active, 5).map(
      (logicalLine) => logicalLine.text
    )
    expect(texts.some((text) => text.includes('/Users/me/proj/src'))).toBe(false)
  })
})
