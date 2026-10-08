// Pure decisions for the server-side fork stack sync (fork-stack-server-sync.mjs): exit codes,
// which checks run, which failures are regressions against upstream, and the short summary the
// server's notifier forwards. No I/O here, so every rule is unit-tested.

export const EXIT_CODES = Object.freeze({
  success: 0,
  'no-change': 10,
  conflict: 20,
  'checks-failed': 30,
  'environment-error': 40
})

const STATUS_LABEL = {
  success: '성공',
  'no-change': '변경 없음',
  conflict: '충돌',
  'checks-failed': '검사 실패',
  'environment-error': '환경 오류'
}

const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|mjs|js)$/
const SOURCE_FILE = /^(.*)\.(ts|tsx|mts|mjs|js)$/

/** `pnpm lint` as separate steps, so one known upstream failure does not hide the rest. */
export function parseLintSteps(lintScript) {
  return lintScript
    .split('&&')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((command) => {
      const run = /^pnpm run ([\w:.-]+)$/.exec(command)
      if (run) {
        return { name: run[1], args: ['run', run[1]] }
      }
      const [binary, ...rest] = command.split(/\s+/)
      return { name: command, args: ['exec', binary, ...rest] }
    })
}

function isUnitTest(file) {
  if (!TEST_FILE.test(file)) {
    return false
  }
  // e2e specs need Electron; their `.unit.test.ts` helpers run in the unit suite.
  return !file.startsWith('tests/e2e/') || file.endsWith('.unit.test.ts')
}

/**
 * Unit test files the fork's diff reaches: tests it changed, plus the sibling tests of every
 * source file it changed (`foo.ts` -> `foo.test.ts`, `foo.render.test.ts`). Mobile has its own
 * project and is checked separately.
 */
export function selectTargetedTests({ changedFiles, trackedFiles }) {
  const testsByDir = new Map()
  for (const file of trackedFiles) {
    if (!isUnitTest(file)) {
      continue
    }
    const dir = file.slice(0, file.lastIndexOf('/') + 1)
    testsByDir.set(dir, [...(testsByDir.get(dir) ?? []), file])
  }
  const selected = new Set()
  for (const file of changedFiles) {
    if (file.startsWith('mobile/')) {
      continue
    }
    if (isUnitTest(file)) {
      selected.add(file)
      continue
    }
    const source = SOURCE_FILE.exec(file)
    if (!source) {
      continue
    }
    const stem = source[1].slice(source[1].lastIndexOf('/') + 1)
    const dir = file.slice(0, file.lastIndexOf('/') + 1)
    for (const test of testsByDir.get(dir) ?? []) {
      if (test.slice(dir.length).startsWith(`${stem}.`)) {
        selected.add(test)
      }
    }
  }
  return [...selected].sort()
}

/** `auto` runs the whole unit suite once a week (Sunday, UTC); it takes ~95 min on rizi. */
export function shouldRunFullTests({ mode, date }) {
  if (mode === 'always') {
    return true
  }
  if (mode === 'never') {
    return false
  }
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 0
}

/** Type errors without their line/column, so moved-but-unchanged upstream errors still match. */
export function parseTscErrors(output) {
  const errors = new Set()
  for (const line of output.split('\n')) {
    const match = /^(\S+?)\(\d+,\d+\): (error TS\d+: .*)$/.exec(line.trim())
    if (match) {
      errors.add(`${match[1]}: ${match[2]}`)
    }
  }
  return [...errors].sort()
}

function plainText(output) {
  // Why: tools colour their output; dropping ESC leaves `[31m`-style runs the second pass strips.
  return output.replaceAll(String.fromCharCode(27), '').replace(/\[[0-9;]*m/g, '')
}

/**
 * Failed tests as `file > suite > test`, a file that failed as a whole as just `file`, and the
 * first line of each unhandled error. Test-level items keep a new failure in a file upstream
 * already fails from passing as known.
 */
export function parseVitestFailures(output) {
  const tests = new Set()
  const files = new Set()
  let inUnhandled = false
  for (const line of plainText(output).split('\n')) {
    const failed =
      /^\s*FAIL\s+(?:\|[\w-]+\|\s+)?(\S+\.(?:test|spec)\.\w+)(?: > (.+?))?(?: \[.*\])?\s*$/.exec(
        line
      )
    if (failed && !failed[1].includes('node_modules')) {
      if (failed[2]) {
        tests.add(`${failed[1]} > ${failed[2]}`)
      } else {
        files.add(failed[1])
      }
    }
    const listed = /^\s*❯\s+(?:\|[\w-]+\|\s+)?(\S+\.(?:test|spec)\.\w+)/.exec(line)?.[1]
    if (listed && !listed.includes('node_modules')) {
      files.add(listed)
    }
    if (/⎯ Unhandled (Rejection|Error)/.test(line)) {
      inUnhandled = true
      continue
    }
    const error = inUnhandled ? /^(\w*Error): (.+)$/.exec(line.trim()) : null
    if (error) {
      tests.add(`unhandled: ${error[1]}: ${error[2].slice(0, 120)}`)
      inUnhandled = false
    }
  }
  const testFiles = new Set([...tests].map((item) => item.split(' > ')[0]))
  return [...tests, ...[...files].filter((file) => !testFiles.has(file))].sort()
}

/** The test files behind parsed failures, to rerun them on the baseline checkout. */
export function failedTestFiles(items) {
  return [
    ...new Set(
      items.filter((item) => !item.startsWith('unhandled: ')).map((item) => item.split(' > ')[0])
    )
  ]
}

/**
 * Lint diagnostics as `step: file: message`, without line and column. A step that failed without
 * a parseable diagnostic is reported by its name alone.
 */
export function parseLintDiagnostics(step, output) {
  const diagnostics = new Set()
  for (const line of plainText(output).split('\n')) {
    const match = /^(\S+?):\d+:\d+: (?:warning|error) (.+)$/.exec(line.trim())
    if (match) {
      diagnostics.add(`${step}: ${match[1]}: ${match[2].split(' help: ')[0]}`)
    }
  }
  return diagnostics.size > 0 ? [...diagnostics].sort() : [step]
}

/**
 * A failed test that passes when its file runs again alone is flaky (usually a timeout under load):
 * reported, but not compared with upstream or counted as a regression.
 */
export function splitFlaky({ items, retryItems }) {
  const still = new Set(retryItems)
  return {
    stillFailing: items.filter((item) => still.has(item)),
    flaky: items.filter((item) => !still.has(item))
  }
}

/**
 * Splits a check's failures into regressions and failures upstream main shows too. A check that
 * failed without naming what failed (a crash, a timeout) is a regression: nothing proves it known.
 */
export function compareWithBaseline({ failed, items, baselineItems }) {
  if (!failed) {
    return { regressions: [], known: [] }
  }
  if (items.length === 0) {
    return { regressions: ['(the check failed without naming a failure; see its log)'], known: [] }
  }
  const baseline = new Set(baselineItems ?? [])
  return {
    regressions: items.filter((item) => !baseline.has(item)),
    known: items.filter((item) => baseline.has(item))
  }
}

/** The run's overall status from the restack result, the checks and the publish step. */
export function decideOutcome({
  restackStatus,
  topics = [],
  openPrTreeMatches,
  checks,
  publishError
}) {
  if (restackStatus === 'error') {
    return 'environment-error'
  }
  if (restackStatus === 'blocked') {
    return topics.some((topic) => topic.status === 'error') ? 'environment-error' : 'conflict'
  }
  if (restackStatus === 'up-to-date' || openPrTreeMatches) {
    return 'no-change'
  }
  if ((checks ?? []).some((check) => check.regressions.length > 0)) {
    return 'checks-failed'
  }
  return publishError ? 'environment-error' : 'success'
}

function topicLine(topic) {
  const dropped = (topic.steps ?? []).filter((step) => step.action === 'dropped').length
  const state =
    {
      reused: '그대로',
      restacked: '재구성',
      conflict: '충돌',
      'xterm-failed': 'xterm 재생성 실패',
      error: '오류',
      'not-run': '실행 안 함'
    }[topic.status] ?? topic.status
  return `${topic.name} ${state}${dropped > 0 ? ` (upstream 반영으로 ${dropped}개 제외)` : ''}`
}

function blockerLines(topics) {
  return topics
    .filter((topic) => topic.conflict || topic.error)
    .map((topic) =>
      topic.conflict
        ? `- 막힌 곳: ${topic.name} 스택의 \`${topic.conflict.sha.slice(0, 10)}\` ${topic.conflict.subject} (파일: ${(
            topic.conflict.files ?? []
          )
            .slice(0, 5)
            .map((file) => file.path ?? file)
            .join(', ')})`
        : `- 막힌 곳: ${topic.name} — ${topic.error}`
    )
}

function checkLine(check) {
  const mark = {
    passed: '통과',
    failed: '실패',
    'known-failure': '통과(기존 실패만)',
    skipped: '건너뜀'
  }
  const flaky =
    (check.flaky ?? []).length > 0 ? `, 재실행 때 통과한 간헐 실패 ${check.flaky.length}건` : ''
  const extra =
    check.regressions.length > 0
      ? ` — 새 실패 ${check.regressions.length}건: ${check.regressions.slice(0, 3).join('; ')}`
      : check.known.length > 0
        ? ` — upstream에도 있는 실패 ${check.known.length}건`
        : ''
  return `${check.label} ${mark[check.status] ?? check.status}${extra}${flaky}`
}

/** The few lines a person reads first (Telegram); the full English report sits next to it. */
export function renderServerSummary(summary) {
  const label = STATUS_LABEL[summary.status] ?? summary.status
  const mode = summary.dryRun ? ' · dry-run' : ''
  const lines = [`포크 동기화 ${summary.date}: ${label}${mode} (종료 코드 ${summary.exitCode})`]
  if (summary.message) {
    lines.push(`- ${summary.message}`)
  }
  if (summary.upstream?.sha) {
    lines.push(`- upstream: \`${summary.upstream.sha.slice(0, 10)}\``)
  }
  const topics = summary.restack?.topics ?? []
  if (topics.length > 0) {
    lines.push(`- 스택: ${topics.map(topicLine).join(', ')}`)
    lines.push(...blockerLines(topics))
  }
  if ((summary.checks ?? []).length > 0) {
    lines.push(`- 검사: ${summary.checks.map(checkLine).join(' / ')}`)
  }
  if (summary.pr?.url) {
    const superseded = (summary.pr.superseded ?? []).map((number) => `#${number}`).join(', ')
    lines.push(`- PR: ${summary.pr.url}${superseded ? ` (대체: ${superseded})` : ''}`)
  }
  if (summary.durationSec !== undefined) {
    const seconds = summary.durationSec
    lines.push(`- 걸린 시간: ${seconds < 60 ? `${seconds}초` : `${Math.round(seconds / 60)}분`}`)
  }
  if (summary.detailPath) {
    lines.push(`- 자세한 내용: ${summary.detailPath}`)
  }
  return `${lines.join('\n')}\n`
}

/** A lock whose owner process is gone (crash, reboot) must not block every later run. */
export function lockIsStale({ owner, isAlive }) {
  return !owner || !Number.isInteger(owner.pid) || !isAlive(owner.pid)
}
