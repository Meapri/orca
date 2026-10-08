import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  buildXtermLinearSelectionText,
  readTerminalCopySelection,
  type TerminalCopySelection
} from './terminal-selection-cells'
import { buildTerminalSmartCopyText } from './terminal-smart-copy'

async function screen(lines: readonly string[] | string, cols = 40): Promise<Terminal> {
  const term = new Terminal({ cols, rows: 30, allowProposedApi: true })
  const data = typeof lines === 'string' ? lines : lines.join('\r\n')
  await new Promise<void>((resolve) => term.write(data, resolve))
  return term
}

function select(
  term: Terminal,
  start: { x: number; y: number },
  end: { x: number; y: number }
): TerminalCopySelection {
  const selection = readTerminalCopySelection(term.buffer.active, { start, end })
  if (!selection) {
    throw new Error('expected a readable selection')
  }
  return selection
}

function selectRows(term: Terminal, firstRow: number, lastRow: number): TerminalCopySelection {
  return select(term, { x: 0, y: firstRow }, { x: term.cols, y: lastRow })
}

async function smartCopy(lines: readonly string[] | string, cols = 40): Promise<string> {
  const term = await screen(lines, cols)
  const rowCount = typeof lines === 'string' ? term.buffer.active.length : lines.length
  let lastRow = rowCount - 1
  while (lastRow > 0 && !term.buffer.active.getLine(lastRow)?.translateToString(true)) {
    lastRow--
  }
  return buildTerminalSmartCopyText(selectRows(term, 0, lastRow), '\n')
}

describe('buildTerminalSmartCopyText frames', () => {
  it('drops a closed box, its padding and its edges', async () => {
    const box = [
      '╭──────────────────────────────╮',
      '│ Hello world                  │',
      '│   indented line              │',
      '╰──────────────────────────────╯'
    ]
    expect(await smartCopy(box)).toBe('Hello world\n  indented line')
  })

  it('keeps a titled edge out of the copy and splits sections at dividers', async () => {
    const box = [
      '┌─ Plan ──────────────┐',
      '│ first               │',
      '├─────────────────────┤',
      '│ second              │',
      '└─────────────────────┘'
    ]
    expect(await smartCopy(box)).toBe('first\n\nsecond')
  })

  it('strips only the frame when the selection starts inside the box', async () => {
    const term = await screen([
      '╭──────────────────╮',
      '│ alpha beta       │',
      '│ delta            │',
      '╰──────────────────╯'
    ])
    expect(buildTerminalSmartCopyText(select(term, { x: 8, y: 1 }, { x: 20, y: 2 }), '\n')).toBe(
      'beta\ndelta'
    )
  })

  it('strips an indented box nested in an agent gutter', async () => {
    const lines = [
      '  ⏺ Update(src/app.ts)',
      '    ╭────────────╮',
      '    │ const a    │',
      '    ╰────────────╯'
    ]
    expect(await smartCopy(lines)).toBe('⏺ Update(src/app.ts)\nconst a')
  })

  it('strips a repeated left bar but not a single one', async () => {
    expect(await smartCopy(['▌ first line', '▌ second line'])).toBe('first line\nsecond line')
    expect(await smartCopy(['│ lone bar'])).toBe('│ lone bar')
  })

  it('leaves tables untouched', async () => {
    const table = ['│ a   │ b   │', '├─────┼─────┤', '│ 1   │ 2   │']
    expect(await smartCopy(table)).toBe(table.join('\n'))
    const bordered = ['┌─────┬─────┐', '│ a   │ b   │', '└─────┴─────┘']
    expect(await smartCopy(bordered)).toBe(bordered.join('\n'))
  })

  it('does not treat tree glyphs as frame edges', async () => {
    const tree = ['• Ran git status', '  └ On branch main', '    nothing to commit']
    expect(await smartCopy(tree)).toBe(tree.join('\n'))
  })

  it('does not treat mismatched right borders as one frame', async () => {
    const rows = ['│ one │', '│ two   │']
    expect(await smartCopy(rows)).toBe('one\ntwo')
  })
})

describe('buildTerminalSmartCopyText hard wraps inside frames', () => {
  // Inner width 20 with one cell of padding each side: text wraps at column 20.
  const cellWidth = (text: string): number =>
    [...text].reduce((width, char) => width + (/[\u1100-\uffdc]/.test(char) ? 2 : 1), 0)
  const frame = (rows: string[]): string[] => [
    `╭${'─'.repeat(22)}╮`,
    ...rows.map((row) => `│ ${row}${' '.repeat(20 - cellWidth(row))} │`),
    `╰${'─'.repeat(22)}╯`
  ]

  it('rejoins greedy word wraps', async () => {
    const rows = frame(['The quick brown fox', 'jumps over the lazy', 'dog.'])
    expect(await smartCopy(rows)).toBe('The quick brown fox jumps over the lazy dog.')
  })

  it('keeps short lines that could have held the next word', async () => {
    const rows = frame(['Done.', 'Next step here'])
    expect(await smartCopy(rows)).toBe('Done.\nNext step here')
  })

  it('keeps list items and paragraph breaks apart', async () => {
    const rows = frame([
      '- install the long',
      '  dependency set',
      '- run the tests now',
      '',
      'Finally ok'
    ])
    expect(await smartCopy(rows)).toBe(
      '- install the long dependency set\n- run the tests now\n\nFinally ok'
    )
  })

  it('does not join rows that end like code', async () => {
    const rows = frame(['if (ready) { start()', 'return value;', 'const answer = 42;', 'x'])
    expect(await smartCopy(rows)).toBe('if (ready) { start()\nreturn value;\nconst answer = 42;\nx')
  })

  it('joins a URL split mid-token without a space', async () => {
    const rows = frame(['https://example.com/', 'a/b/c'])
    expect(await smartCopy(rows)).toBe('https://example.com/a/b/c')
  })

  it('joins spaceless CJK text without inserting spaces', async () => {
    // 10 wide glyphs fill the 20-cell interior exactly.
    const rows = frame(['日本語のテキストを折', 'り返す'])
    expect(await smartCopy(rows)).toBe('日本語のテキストを折り返す')
  })

  it('joins wrapped Korean words with a space', async () => {
    const rows = frame(['한글 문장이 여기서', '줄바꿈됩니다'])
    expect(await smartCopy(rows)).toBe('한글 문장이 여기서 줄바꿈됩니다')
  })

  it('never joins rows of a left-only bar', async () => {
    expect(await smartCopy(['▌ a sentence that stops', '▌ here'], 24)).toBe(
      'a sentence that stops\nhere'
    )
  })
})

describe('buildTerminalSmartCopyText soft wraps and cells', () => {
  it('keeps the space at a soft-wrap boundary', async () => {
    const term = await screen('abcd efgh ijkl', 5)
    const selection = selectRows(term, 0, 2)
    expect(buildTerminalSmartCopyText(selection, '\n')).toBe('abcd efgh ijkl')
  })

  it('does not insert a space for a wide glyph pushed to the next row', async () => {
    const term = await screen('한글한글한', 5)
    expect(buildTerminalSmartCopyText(selectRows(term, 0, 2), '\n')).toBe('한글한글한')
  })

  it('does not split wide glyph cells', async () => {
    expect(await smartCopy(['│ 한국어 테스트 │', '│ 中文         │'])).toBe('한국어 테스트\n中文')
  })

  it('trims trailing padding a TUI painted with spaces', async () => {
    expect(await smartCopy([`status: ok${' '.repeat(20)}`, `next${' '.repeat(30)}`])).toBe(
      'status: ok\nnext'
    )
  })

  it('uses the requested newline', async () => {
    const term = await screen(['one', 'two'])
    expect(buildTerminalSmartCopyText(selectRows(term, 0, 1), '\r\n')).toBe('one\r\ntwo')
  })

  it('matches xterm text for plain output', async () => {
    const term = await screen(['plain', 'text'])
    const selection = selectRows(term, 0, 1)
    expect(buildXtermLinearSelectionText(selection)).toEqual(['plain', 'text'])
    expect(buildTerminalSmartCopyText(selection, '\n')).toBe('plain\ntext')
  })
})

describe('buildTerminalSmartCopyText line-number gutters', () => {
  it('strips a bat-style separated gutter', async () => {
    const rows = [
      '   1 │ import x from "x"',
      '   2 │   run(x)',
      '     │   // wrapped',
      '   3 │ done()'
    ]
    expect(await smartCopy(rows)).toBe('import x from "x"\n  run(x)\n  // wrapped\ndone()')
  })

  it('strips a cat -n gutter but keeps code indentation', async () => {
    const rows = ['     1  def run():', '     2      return 1', '     3', '     4  run()']
    expect(await smartCopy(rows)).toBe('def run():\n    return 1\n\nrun()')
  })

  it('keeps a column of bare numbers', async () => {
    const rows = ['1', '2', '3', '4']
    expect(await smartCopy(rows)).toBe('1\n2\n3\n4')
  })

  it('keeps numbered prose that is not a gutter', async () => {
    expect(await smartCopy(['1 apple', '2 banana', '3 cherry'])).toBe('1 apple\n2 banana\n3 cherry')
    expect(await smartCopy(['10 │ a', '9 │ b'])).toBe('10 │ a\n9 │ b')
  })

  it('strips numbered rows inside a box without joining them', async () => {
    const rows = [
      `╭${'─'.repeat(22)}╮`,
      '│ 10  const first =    │',
      '│ 11  secondValue      │',
      '│ 12  third            │',
      `╰${'─'.repeat(22)}╯`
    ]
    expect(await smartCopy(rows)).toBe('const first =\nsecondValue\nthird')
  })
})
