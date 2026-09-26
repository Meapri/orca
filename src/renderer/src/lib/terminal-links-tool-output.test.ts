import { describe, expect, it } from 'vitest'
import { extractTerminalFileLinkCandidates, extractTerminalFileLinks } from './terminal-links'

type Expected = [displayText: string, pathText: string, line: number | null, column: number | null]

function links(lineText: string): Expected[] {
  return extractTerminalFileLinks(lineText).map((link) => [
    lineText.slice(link.startIndex, link.endIndex),
    link.pathText,
    link.line,
    link.column
  ])
}

// Real output lines from the tools agents run; each must link exactly the path
// (plus its location) so the provider's existence probe can resolve it.
const TOOL_OUTPUT_CASES: [name: string, lineText: string, expected: Expected[]][] = [
  [
    'tsc --pretty false',
    'src/app.ts(12,5): error TS2322: Type string is not assignable',
    [['src/app.ts(12,5)', 'src/app.ts', 12, 5]]
  ],
  [
    'tsc pretty',
    'src/app.ts:12:5 - error TS2322: Type',
    [['src/app.ts:12:5', 'src/app.ts', 12, 5]]
  ],
  [
    'MSBuild with a Windows path',
    'C:\\Users\\me\\proj\\src\\App.cs(12,5): warning CS0168',
    [['C:\\Users\\me\\proj\\src\\App.cs(12,5)', 'C:\\Users\\me\\proj\\src\\App.cs', 12, 5]]
  ],
  [
    'line-only paren location',
    'src\\App.cs(7): error',
    [['src\\App.cs(7)', 'src\\App.cs', 7, null]]
  ],
  [
    'Windows colon location',
    'C:\\Users\\me\\proj\\src\\app.ts:12:5',
    [['C:\\Users\\me\\proj\\src\\app.ts:12:5', 'C:\\Users\\me\\proj\\src\\app.ts', 12, 5]]
  ],
  [
    'Python traceback',
    '  File "/home/me/proj/app.py", line 42, in <module>',
    [['/home/me/proj/app.py', '/home/me/proj/app.py', 42, null]]
  ],
  [
    'pytest failure location',
    'tests/test_app.py:17: AssertionError',
    [['tests/test_app.py:17', 'tests/test_app.py', 17, null]]
  ],
  [
    'pytest node id',
    'tests/test_app.py::test_login FAILED',
    [['tests/test_app.py', 'tests/test_app.py', null, null]]
  ],
  ['go vet', 'app.go:12:3: undefined: foo', [['app.go:12:3', 'app.go', 12, 3]]],
  ['rustc arrow', ' --> src/main.rs:4:18', [['src/main.rs:4:18', 'src/main.rs', 4, 18]]],
  [
    'node stack frame',
    '    at Object.<anonymous> (/Users/me/proj/src/app.ts:12:5)',
    [['/Users/me/proj/src/app.ts:12:5', '/Users/me/proj/src/app.ts', 12, 5]]
  ],
  [
    'eslint compact',
    '/Users/me/proj/src/app.ts: line 3, col 9, Error - no-undef',
    [['/Users/me/proj/src/app.ts', '/Users/me/proj/src/app.ts', null, null]]
  ],
  [
    'GitHub-style anchor',
    'See `src/app.ts#L12C3` for details',
    [['src/app.ts#L12C3', 'src/app.ts', 12, 3]]
  ],
  ['anchor range', 'src/app.ts#L12-L20', [['src/app.ts#L12-L20', 'src/app.ts', 12, null]]],
  ['Claude Code tool call', '⏺ Update(src/app.ts)', [['src/app.ts', 'src/app.ts', null, null]]],
  [
    'Claude Code tool result',
    '  ⎿  Read 42 lines from src/renderer/app.tsx',
    [['src/renderer/app.tsx', 'src/renderer/app.tsx', null, null]]
  ],
  ['Codex edit summary', '• Edited src/app.ts (+3 -1)', [['src/app.ts', 'src/app.ts', null, null]]],
  [
    'git status short',
    ' M src/renderer/app.tsx',
    [['src/renderer/app.tsx', 'src/renderer/app.tsx', null, null]]
  ],
  [
    'git diff header',
    'diff --git a/src/foo.ts b/src/bar.ts',
    [
      ['src/foo.ts', 'src/foo.ts', null, null],
      ['src/bar.ts', 'src/bar.ts', null, null]
    ]
  ],
  ['git diff old file', '--- a/src/foo.ts', [['src/foo.ts', 'src/foo.ts', null, null]]],
  ['git diff new file', '+++ b/src/foo.ts', [['src/foo.ts', 'src/foo.ts', null, null]]]
]

describe('terminal file links in tool output', () => {
  it.each(TOOL_OUTPUT_CASES)('%s', (_name, lineText, expected) => {
    expect(links(lineText)).toEqual(expected)
  })

  it('keeps route segments in parentheses as part of the path', () => {
    expect(links('app/(shop)/products/[id]/page.tsx:3')).toEqual([
      ['app/(shop)/products/[id]/page.tsx:3', 'app/(shop)/products/[id]/page.tsx', 3, null]
    ])
  })

  it('does not read a parenthesised count after prose as a location', () => {
    expect(links('see src/app.ts (12 changes)')).toEqual([['src/app.ts', 'src/app.ts', null, null]])
  })

  it('ignores a Python-style line suffix on an unquoted path', () => {
    expect(links('app/models.py", line 7')).toEqual([
      ['app/models.py', 'app/models.py', null, null]
    ])
  })

  it('keeps spaced paths that carry no location suffix', () => {
    expect(links('/Users/me/My Project/src/app.ts')).toEqual([
      ['/Users/me/My Project/src/app.ts', '/Users/me/My Project/src/app.ts', null, null]
    ])
  })

  it('exposes the same locations to the hover candidate pass', () => {
    const candidate = extractTerminalFileLinkCandidates('src/app.ts(12,5): error')[0]
    expect(candidate).toMatchObject({ pathText: 'src/app.ts', line: 12, column: 5 })
  })

  it('does not treat prose dashes as a diff header', () => {
    expect(links('--- see a/src/foo.ts')).toEqual([['a/src/foo.ts', 'a/src/foo.ts', null, null]])
  })
})
