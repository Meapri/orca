import { describe, expect, it } from 'vitest'
import {
  EXIT_CODES,
  compareWithBaseline,
  decideOutcome,
  failedTestFiles,
  lockIsStale,
  parseLintDiagnostics,
  parseLintSteps,
  parseTscErrors,
  parseVitestFailures,
  renderServerSummary,
  selectTargetedTests,
  shouldRunFullTests,
  splitFlaky
} from './fork-stack-server-plan.mjs'

describe('exit codes', () => {
  it('gives each outcome its own code, success zero', () => {
    expect(EXIT_CODES).toEqual({
      success: 0,
      'no-change': 10,
      conflict: 20,
      'checks-failed': 30,
      'environment-error': 40
    })
  })
})

describe('lint steps', () => {
  it('splits pnpm lint into steps so one failure does not hide the rest', () => {
    expect(
      parseLintSteps('oxlint && pnpm run audit:anti-slop && pnpm run check:max-lines-ratchet')
    ).toEqual([
      { name: 'oxlint', args: ['exec', 'oxlint'] },
      { name: 'audit:anti-slop', args: ['run', 'audit:anti-slop'] },
      { name: 'check:max-lines-ratchet', args: ['run', 'check:max-lines-ratchet'] }
    ])
  })
})

describe('targeted tests', () => {
  const trackedFiles = [
    'src/a/foo.ts',
    'src/a/foo.test.ts',
    'src/a/foo.render.test.ts',
    'src/a/foobar.test.ts',
    'src/a/other.test.ts',
    'tests/e2e/terminal.spec.ts',
    'tests/e2e/wire.unit.test.ts',
    'mobile/src/x.test.ts',
    'config/scripts/tool.test.mjs'
  ]

  it('takes changed tests and the sibling tests of changed sources, never e2e specs or mobile', () => {
    expect(
      selectTargetedTests({
        changedFiles: [
          'src/a/foo.ts',
          'tests/e2e/terminal.spec.ts',
          'tests/e2e/wire.unit.test.ts',
          'mobile/src/x.test.ts',
          'config/scripts/tool.test.mjs',
          'docs/readme.md'
        ],
        trackedFiles
      })
    ).toEqual([
      'config/scripts/tool.test.mjs',
      'src/a/foo.render.test.ts',
      'src/a/foo.test.ts',
      'tests/e2e/wire.unit.test.ts'
    ])
  })
})

describe('full test schedule', () => {
  it('runs the whole suite on Sundays in auto mode, or as forced', () => {
    expect(shouldRunFullTests({ mode: 'auto', date: '2026-10-11' })).toBe(true)
    expect(shouldRunFullTests({ mode: 'auto', date: '2026-10-12' })).toBe(false)
    expect(shouldRunFullTests({ mode: 'always', date: '2026-10-12' })).toBe(true)
    expect(shouldRunFullTests({ mode: 'never', date: '2026-10-11' })).toBe(false)
  })
})

describe('output parsing', () => {
  it('reads type errors without positions so moved upstream errors still match', () => {
    const output = [
      "src/a.ts(3,5): error TS2322: Type 'x' is not assignable.",
      "src/a.ts(9,1): error TS2322: Type 'x' is not assignable.",
      'Found 2 errors.'
    ].join('\n')
    expect(parseTscErrors(output)).toEqual(["src/a.ts: error TS2322: Type 'x' is not assignable."])
  })

  it('reads failed tests, whole-file failures and unhandled errors from coloured vitest output', () => {
    const esc = String.fromCharCode(27)
    const output = [
      ` ${esc}[31m❯${esc}[39m |bun| src/main/a.test.ts (3 tests | 1 failed) 20ms`,
      ' FAIL  |node-runtime| src/main/b.test.ts > suite > case',
      ' ❯ src/main/b.test.ts:12:5',
      ' FAIL  |bun| config/scripts/c.test.mjs [ config/scripts/c.test.mjs ]',
      ' ❯ helper src/main/fixture.ts:3:1',
      'AssertionError: expected 1 to be 2',
      '⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯',
      'DevalueError: Cannot stringify arbitrary non-POJOs',
      ' ❯ node_modules/devalue/src/stringify.test.js:1:1'
    ].join('\n')
    const items = parseVitestFailures(output)
    expect(items).toEqual([
      'config/scripts/c.test.mjs',
      'src/main/a.test.ts',
      'src/main/b.test.ts > suite > case',
      'unhandled: DevalueError: Cannot stringify arbitrary non-POJOs'
    ])
    expect(failedTestFiles(items)).toEqual([
      'config/scripts/c.test.mjs',
      'src/main/a.test.ts',
      'src/main/b.test.ts'
    ])
  })

  it('reads lint diagnostics per file and rule, or falls back to the step name', () => {
    const output = [
      'mobile/src/a.ts:45:8: warning import(no-cycle): Dependency cycle detected help: Refactor.',
      'mobile/src/a.ts:9:1: warning import(no-cycle): Dependency cycle detected help: Refactor.'
    ].join('\n')
    expect(parseLintDiagnostics('audit:native', output)).toEqual([
      'audit:native: mobile/src/a.ts: import(no-cycle): Dependency cycle detected'
    ])
    expect(parseLintDiagnostics('oxlint', '  x some fancy report')).toEqual(['oxlint'])
  })
})

describe('baseline comparison', () => {
  it('passes a check that passed', () => {
    expect(compareWithBaseline({ failed: false, items: [], baselineItems: [] })).toEqual({
      regressions: [],
      known: []
    })
  })

  it('keeps a new failure in a step or file upstream already fails as a regression', () => {
    expect(
      compareWithBaseline({
        failed: true,
        items: ['native: a.ts: rule: old', 'native: b.ts: rule: new'],
        baselineItems: ['native: a.ts: rule: old']
      })
    ).toEqual({ regressions: ['native: b.ts: rule: new'], known: ['native: a.ts: rule: old'] })
  })

  it('counts only failures upstream main does not share', () => {
    expect(
      compareWithBaseline({ failed: true, items: ['a', 'b'], baselineItems: ['b', 'c'] })
    ).toEqual({ regressions: ['a'], known: ['b'] })
  })

  it('treats a failure that names nothing as a regression', () => {
    const { regressions } = compareWithBaseline({ failed: true, items: [], baselineItems: [] })
    expect(regressions).toHaveLength(1)
  })
})

describe('flaky tests', () => {
  it('keeps what still fails on a rerun and reports the rest as flaky', () => {
    expect(splitFlaky({ items: ['a > slow', 'b > broken'], retryItems: ['b > broken'] })).toEqual({
      stillFailing: ['b > broken'],
      flaky: ['a > slow']
    })
  })
})

describe('outcome', () => {
  const passed = [{ regressions: [] }]

  it('maps restack and check results to the five outcomes', () => {
    expect(decideOutcome({ restackStatus: 'up-to-date' })).toBe('no-change')
    expect(decideOutcome({ restackStatus: 'ready', openPrTreeMatches: true })).toBe('no-change')
    expect(decideOutcome({ restackStatus: 'blocked', topics: [{ status: 'conflict' }] })).toBe(
      'conflict'
    )
    expect(decideOutcome({ restackStatus: 'blocked', topics: [{ status: 'error' }] })).toBe(
      'environment-error'
    )
    expect(decideOutcome({ restackStatus: 'ready', checks: [{ regressions: ['x'] }] })).toBe(
      'checks-failed'
    )
    expect(decideOutcome({ restackStatus: 'ready', checks: passed })).toBe('success')
    expect(decideOutcome({ restackStatus: 'ready', checks: passed, publishError: 'push' })).toBe(
      'environment-error'
    )
  })
})

describe('summary', () => {
  it('names the blocked stack, commit and files in a few lines', () => {
    const text = renderServerSummary({
      date: '2026-10-09',
      status: 'conflict',
      exitCode: 20,
      dryRun: false,
      upstream: { sha: 'abcdef0123456789' },
      restack: {
        topics: [
          { name: 'terminal', status: 'restacked', steps: [{ action: 'dropped' }] },
          {
            name: 'distribution',
            status: 'conflict',
            conflict: {
              sha: '0123456789abcdef',
              subject: 'feat: own app id',
              files: [{ path: 'a.ts', kind: 'both modified' }, 'b.ts']
            }
          }
        ]
      },
      durationSec: 600
    })
    expect(text).toContain('포크 동기화 2026-10-09: 충돌 (종료 코드 20)')
    expect(text).toContain('terminal 재구성 (upstream 반영으로 1개 제외)')
    expect(text).toContain('distribution 스택의 `0123456789` feat: own app id (파일: a.ts, b.ts)')
    expect(text).toContain('걸린 시간: 10분')
  })

  it('names the stack whose integration merge conflicted', () => {
    const text = renderServerSummary({
      date: '2026-10-09',
      status: 'conflict',
      exitCode: 20,
      integration: {
        status: 'conflict',
        conflict: { topic: 'orcad-runtime', files: [{ path: 'src/a.ts', kind: 'both modified' }] }
      }
    })
    expect(text).toContain('막힌 곳: 통합 단계, orcad-runtime 스택을 병합할 때 (파일: src/a.ts)')
  })

  it('lists check results and the pull request', () => {
    const text = renderServerSummary({
      date: '2026-10-09',
      status: 'success',
      exitCode: 0,
      dryRun: true,
      checks: [
        { label: 'lint', status: 'known-failure', regressions: [], known: ['audit:x'] },
        { label: '모바일', status: 'passed', regressions: [], known: [], flaky: ['a > slow'] },
        { label: '타입체크', status: 'failed', regressions: ['src/a.ts: error TS1'], known: [] }
      ],
      pr: { url: 'https://github.com/o/r/pull/2', superseded: [1] }
    })
    expect(text).toContain('성공 · dry-run')
    expect(text).toContain('lint 통과(기존 실패만) — upstream에도 있는 실패 1건')
    expect(text).toContain('모바일 통과, 재실행 때 통과한 간헐 실패 1건')
    expect(text).toContain('타입체크 실패 — 새 실패 1건: src/a.ts: error TS1')
    expect(text).toContain('PR: https://github.com/o/r/pull/2 (대체: #1)')
  })
})

describe('lock', () => {
  it('takes over a lock whose owner is gone or unreadable', () => {
    const alive = (pid) => pid === 7
    expect(lockIsStale({ owner: { pid: 7 }, isAlive: alive })).toBe(false)
    expect(lockIsStale({ owner: { pid: 8 }, isAlive: alive })).toBe(true)
    expect(lockIsStale({ owner: null, isAlive: alive })).toBe(true)
  })
})
