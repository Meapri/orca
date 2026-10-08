// Runs the server sync's checks on the integration commit, then reruns whatever failed on
// upstream main so only regressions fail the sync. Decisions live in fork-stack-server-plan.mjs.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createGit } from './fork-stack-git.mjs'
import {
  compareWithBaseline,
  failedTestFiles,
  parseLintDiagnostics,
  parseLintSteps,
  parseTscErrors,
  parseVitestFailures,
  selectTargetedTests,
  splitFlaky
} from './fork-stack-server-plan.mjs'
import { runProcessSync } from './script-child-process.mjs'

const MINUTE = 60 * 1000
// Terminal behaviour is the fork's first priority, so its suites run on every sync.
const TERMINAL_TEST_DIRS = [
  'src/renderer/src/components/terminal-pane/',
  'src/renderer/src/lib/pane-manager/'
]

function run(cwd, logFile, program, args, { timeoutMs, env } = {}) {
  const started = Date.now()
  const result = runProcessSync({
    program,
    args,
    cwd,
    env: { ...process.env, HUSKY: '0', ORCA_BACKGROUND_LAUNCH: '1', ...env },
    timeoutMs,
    maxOutputBytes: 64 * 1024 * 1024
  })
  const output = `${result.stdout}\n${result.stderr}`
  writeFileSync(
    logFile,
    `$ ${program} ${args.join(' ')}\n(cwd ${cwd}; exit ${result.code}${result.timedOut ? '; timed out' : ''})\n\n${output}`,
    { flag: 'a' }
  )
  return { ok: result.code === 0, output, seconds: Math.round((Date.now() - started) / 1000) }
}

/** Checks out `sha` and installs exactly its lockfile (pnpm's shared store keeps this fast). */
export function prepareCheckout({ worktree, sha, logFile }) {
  const git = createGit(worktree)
  git.run(['checkout', '--quiet', '--detach', '--force', sha])
  git.run(['clean', '-fdq'])
  const steps = [
    ['pnpm', ['install', '--frozen-lockfile']],
    ['node', ['config/scripts/ensure-native-runtime.mjs', '--runtime=node']]
  ]
  for (const [program, args] of steps) {
    const result = run(worktree, logFile, program, args, { timeoutMs: 20 * MINUTE })
    if (!result.ok) {
      return { ok: false, error: `${program} ${args.join(' ')} failed; see ${logFile}` }
    }
  }
  const mobile = run(
    path.join(worktree, 'mobile'),
    logFile,
    'pnpm',
    ['install', '--frozen-lockfile'],
    {
      timeoutMs: 20 * MINUTE
    }
  )
  return mobile.ok ? { ok: true } : { ok: false, error: `mobile install failed; see ${logFile}` }
}

function vitest(cwd, logFile, files, timeoutMs) {
  return run(
    cwd,
    logFile,
    'node',
    ['config/scripts/run-vitest.mjs', 'run', '--config', 'config/vitest.config.ts', ...files],
    {
      timeoutMs
    }
  )
}

function mobileRun(cwd, logFile, files) {
  const mobile = path.join(cwd, 'mobile')
  const tsc = run(mobile, logFile, 'node', ['node_modules/typescript/bin/tsc', '--noEmit'], {
    timeoutMs: 20 * MINUTE
  })
  // `files: null` runs every mobile test; an empty list (a baseline rerun) runs none.
  const tests =
    files && files.length === 0
      ? { ok: true, output: '' }
      : run(mobile, logFile, 'node', ['node_modules/vitest/vitest.mjs', 'run', ...(files ?? [])], {
          timeoutMs: 30 * MINUTE
        })
  return {
    ok: tsc.ok && tests.ok,
    items: [...parseTscErrors(tsc.output), ...parseVitestFailures(tests.output)]
  }
}

/**
 * Each check: `run` on a checkout returns { ok, items }; `rerun` repeats only the failed items
 * on the baseline checkout. `rerun: null` means upstream has nothing comparable.
 */
function checkDefinitions({ worktree, upstreamSha, xtermWorkDir, fullTests }) {
  const git = createGit(worktree)
  const changed = git
    .text(['diff', '--name-only', '--diff-filter=AMR', upstreamSha, 'HEAD'])
    .split('\n')
  const tracked = git.text(['ls-files']).split('\n')
  const targeted = selectTargetedTests({ changedFiles: changed, trackedFiles: tracked })
  // Why each checkout's own script: a step only the fork has must never count as known on upstream.
  const lint = (cwd, log, items) => {
    const script = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts.lint
    const only = items && new Set(items.map((item) => item.split(': ')[0]))
    const failed = []
    for (const step of parseLintSteps(script).filter((s) => !only || only.has(s.name))) {
      const result = run(cwd, log, 'pnpm', step.args, { timeoutMs: 20 * MINUTE })
      if (!result.ok) {
        failed.push(...parseLintDiagnostics(step.name, result.output))
      }
    }
    return { ok: failed.length === 0, items: failed }
  }
  const unit = (files, timeoutMs) => (cwd, log, only) => {
    // Why: vitest with no file arguments runs the whole suite; nothing to rerun proves nothing known.
    if (only && only.length === 0) {
      return { ok: true, items: [] }
    }
    const result = vitest(cwd, log, only ?? files, timeoutMs)
    return { ok: result.ok, items: parseVitestFailures(result.output) }
  }
  const checks = [
    {
      name: 'tc',
      label: '타입체크',
      run: (cwd, log) => {
        const result = run(cwd, log, 'pnpm', ['tc'], { timeoutMs: 30 * MINUTE })
        return { ok: result.ok, items: parseTscErrors(result.output) }
      },
      rerun: (cwd, log) => {
        const result = run(cwd, log, 'pnpm', ['tc'], { timeoutMs: 30 * MINUTE })
        return { ok: result.ok, items: parseTscErrors(result.output) }
      }
    },
    {
      name: 'lint',
      label: 'lint',
      run: (cwd, log) => lint(cwd, log),
      rerun: (cwd, log, items) => lint(cwd, log, items)
    },
    {
      name: 'xterm',
      label: 'xterm 패치',
      run: (cwd, log) => ({
        ok: run(
          cwd,
          log,
          'node',
          ['config/scripts/regenerate-xterm-patches.mjs', '--check', `--work-dir=${xtermWorkDir}`],
          {
            timeoutMs: 40 * MINUTE
          }
        ).ok,
        items: []
      }),
      rerun: null
    },
    {
      name: 'unit',
      retry: true,
      label: `단위 테스트(영향 범위 ${targeted.length}개 + 터미널)`,
      run: unit([...targeted, ...TERMINAL_TEST_DIRS], 40 * MINUTE),
      rerun: (cwd, log, items) => unit([], 40 * MINUTE)(cwd, log, failedTestFiles(items))
    },
    {
      name: 'mobile',
      retry: true,
      label: '모바일',
      run: (cwd, log) => mobileRun(cwd, log, null),
      rerun: (cwd, log, items) =>
        mobileRun(
          cwd,
          log,
          failedTestFiles(items).map((f) => f.replace(/^mobile\//, ''))
        )
    }
  ]
  if (fullTests) {
    checks.push({
      name: 'unit-full',
      retry: true,
      label: '전체 단위 테스트(주 1회)',
      run: unit([], 180 * MINUTE),
      rerun: (cwd, log, items) => unit([], 60 * MINUTE)(cwd, log, failedTestFiles(items))
    })
  }
  return checks
}

/**
 * Runs every check on the integration checkout (already prepared), then, when something failed,
 * prepares `baselineWorktree` at upstream main and reruns the failed items there.
 */
export function runChecks({
  worktree,
  baselineWorktree,
  upstreamSha,
  logDir,
  xtermWorkDir,
  fullTests
}) {
  const definitions = checkDefinitions({ worktree, upstreamSha, xtermWorkDir, fullTests })
  const results = definitions.map((check) => {
    const log = path.join(logDir, `check-${check.name}.log`)
    const started = Date.now()
    let outcome = check.run(worktree, log)
    let flaky = []
    if (!outcome.ok && check.retry && outcome.items.length > 0) {
      const retry = check.rerun(
        worktree,
        path.join(logDir, `retry-${check.name}.log`),
        outcome.items
      )
      const split = splitFlaky({ items: outcome.items, retryItems: retry.items })
      flaky = split.flaky
      outcome = { ok: split.stillFailing.length === 0, items: split.stillFailing }
    }
    return { check, log, outcome, flaky, seconds: Math.round((Date.now() - started) / 1000) }
  })
  const needBaseline = results.some(
    (r) => !r.outcome.ok && r.check.rerun && r.outcome.items.length > 0
  )
  let baselineError = null
  if (needBaseline) {
    const prepared = prepareCheckout({
      worktree: baselineWorktree,
      sha: upstreamSha,
      logFile: path.join(logDir, 'baseline-install.log')
    })
    baselineError = prepared.ok ? null : prepared.error
  }
  return results.map(({ check, log, outcome, flaky, seconds }) => {
    let baselineItems = []
    if (!outcome.ok && check.rerun && outcome.items.length > 0 && !baselineError) {
      baselineItems = check.rerun(
        baselineWorktree,
        path.join(logDir, `baseline-${check.name}.log`),
        outcome.items
      ).items
    }
    const { regressions, known } = compareWithBaseline({
      failed: !outcome.ok,
      items: outcome.items,
      baselineItems
    })
    const status = outcome.ok ? 'passed' : regressions.length > 0 ? 'failed' : 'known-failure'
    return {
      name: check.name,
      label: check.label,
      status,
      seconds,
      regressions,
      known,
      flaky,
      log,
      ...(baselineError && !outcome.ok ? { baselineError } : {})
    }
  })
}
