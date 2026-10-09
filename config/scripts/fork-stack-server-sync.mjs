#!/usr/bin/env node
// Daily fork stack sync on the fork owner's server (rizi), the default runner since the fork has
// no FORK_SYNC_TOKEN: the owner's own `gh` login can push workflow changes, which the Actions
// GITHUB_TOKEN cannot. Re-stacks through fork-stack-sync.mjs, checks the integration against an
// upstream baseline, then pushes new branch names and opens the main-update PR. Never force-pushes
// and never touches main. See docs/reference/fork-upstream-sync.md ("Server sync").
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  closeSync
} from 'node:fs'
import path from 'node:path'
import {
  compareSyncKeys,
  MANIFEST_PATH,
  parseManifest,
  syncKeyOfBranch
} from './fork-stack-manifest.mjs'
import { createGit } from './fork-stack-git.mjs'
import { renderPullRequestBody, renderSyncReport, pushRefspecs } from './fork-stack-report.mjs'
import { lookUpUpstreamPrs, runStackSync } from './fork-stack-sync.mjs'
import { prepareCheckout, runChecks } from './fork-stack-server-checks.mjs'
import {
  EXIT_CODES,
  decideOutcome,
  lockIsStale,
  renderServerSummary,
  shouldRunFullTests
} from './fork-stack-server-plan.mjs'
import { runProcessSync } from './script-child-process.mjs'

const SCRIPT = 'config/scripts/fork-stack-server-sync.mjs'
const TOOLS_REFS = ['origin/main', 'origin/stack/sync-automation']
const MAIN_UPDATE_PREFIX = 'main-update/fork-'
const USAGE = `Usage: fork-stack-server-sync.mjs [--dry-run] [--full-tests=auto|always|never]
  [--date=YYYY-MM-DD] [--logs=<dir>] [--worktree=<dir>] [--baseline-worktree=<dir>]
  [--xterm-work-dir=<dir>] [--upstream-ref=<commit>] [--no-self-update]
  --upstream-ref re-stacks onto that upstream commit instead of the branch tip (reproduce a run).`

function parseArgs(argv) {
  const options = {}
  for (const argument of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(argument)
    if (!match) {
      throw new Error(`Unknown argument: ${argument}\n${USAGE}`)
    }
    options[match[1]] = match[2] ?? true
  }
  return options
}

function command(program, args, { cwd, timeoutMs = 10 * 60 * 1000 } = {}) {
  const result = runProcessSync({ program, args, cwd, timeoutMs, maxOutputBytes: 32 * 1024 * 1024 })
  return {
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  }
}

/** Runs the newest server script (main once it carries it, else the sync-automation stack). */
function selfUpdate(toolsDir, argv) {
  const git = createGit(toolsDir)
  git.run(['fetch', '--quiet', 'origin'])
  const target = TOOLS_REFS.find((ref) => git.ok(['cat-file', '-e', `${ref}:${SCRIPT}`]))
  if (!target) {
    return null
  }
  const sha = git.text(['rev-parse', `${target}^{commit}`])
  if (git.text(['rev-parse', 'HEAD']) === sha) {
    return null
  }
  if (git.text(['status', '--porcelain', '--untracked-files=no']).length > 0) {
    console.warn(`Tools checkout ${toolsDir} has local edits; running it as is.`)
    return null
  }
  git.run(['checkout', '--quiet', '--detach', sha])
  const child = runProcessSync({
    program: process.execPath,
    args: [path.join(toolsDir, SCRIPT), ...argv, '--no-self-update'],
    cwd: toolsDir,
    timeoutMs: null,
    maxOutputBytes: 64 * 1024 * 1024
  })
  process.stdout.write(child.stdout)
  process.stderr.write(child.stderr)
  return child.code ?? EXIT_CODES['environment-error']
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** One sync at a time; a lock left by a dead process is taken over. */
function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
      closeSync(fd)
      return { ok: true }
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error
      }
      let owner = null
      try {
        owner = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        // Unreadable lock: treat as stale below.
      }
      if (!lockIsStale({ owner, isAlive })) {
        return { ok: false, owner }
      }
      unlinkSync(file)
    }
  }
  return { ok: false, owner: null }
}

function releaseLock(file) {
  try {
    if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) {
      unlinkSync(file)
    }
  } catch {
    // Already gone.
  }
}

function forkRepository(git) {
  const url = git.text(['remote', 'get-url', 'origin'])
  const match = /github\.com[:/](.+?)(?:\.git)?$/.exec(url)
  if (!match) {
    throw new Error(`origin (${url}) is not a GitHub repository.`)
  }
  return match[1]
}

/** main's manifest once main adopted the stacks; before that, the newest main-update branch's. */
function manifestSource(git) {
  if (git.ok(['cat-file', '-e', `origin/main:${MANIFEST_PATH}`])) {
    return 'origin/main'
  }
  const branches = git
    .text([
      'for-each-ref',
      '--format=%(refname:strip=3)',
      `refs/remotes/origin/${MAIN_UPDATE_PREFIX}*`
    ])
    .split('\n')
    .filter((branch) => branch && syncKeyOfBranch(branch))
    .sort((left, right) => compareSyncKeys(syncKeyOfBranch(left), syncKeyOfBranch(right)))
  const newest = branches.at(-1)
  if (!newest || !git.ok(['cat-file', '-e', `origin/${newest}:${MANIFEST_PATH}`])) {
    throw new Error(`Neither origin/main nor a ${MAIN_UPDATE_PREFIX}* branch has ${MANIFEST_PATH}.`)
  }
  return `origin/${newest}`
}

function ensureWorktree(repoGit, dir, ref) {
  if (!existsSync(path.join(dir, '.git'))) {
    repoGit.run(['worktree', 'add', '--quiet', '--detach', dir, ref])
  }
  const git = createGit(dir)
  git.run(['checkout', '--quiet', '--detach', '--force', ref])
  git.run(['clean', '-fdq'])
  return git
}

function openMainUpdatePrs(forkRepo) {
  const result = command('gh', [
    'pr',
    'list',
    '-R',
    forkRepo,
    '--state',
    'open',
    '--base',
    'main',
    '--json',
    'number,url,headRefName',
    '--limit',
    '50'
  ])
  if (!result.ok) {
    throw new Error(`gh pr list failed: ${result.stderr}`)
  }
  return JSON.parse(result.stdout).filter((pr) => pr.headRefName.startsWith(MAIN_UPDATE_PREFIX))
}

function checksSection(checks) {
  if (checks.length === 0) {
    return ''
  }
  const rows = checks.map(
    (check) =>
      `| ${check.name} | ${check.status} | ${check.seconds}s | ${check.regressions.length} | ${check.known.length} | ${(check.flaky ?? []).length} |`
  )
  const listed = (title, items) =>
    items.length === 0
      ? []
      : [
          `- ${title}:`,
          ...items.slice(0, 20).map((item) => `  - \`${item}\``),
          ...(items.length > 20 ? [`  - … and ${items.length - 20} more`] : [])
        ]
  const details = checks.flatMap((check) => {
    const lines = [
      ...listed('regressions', check.regressions),
      ...listed('also failing on upstream main', check.known),
      ...listed('flaky (passed when rerun alone)', check.flaky ?? [])
    ]
    return lines.length === 0 ? [] : [`**${check.name}** (log: \`${check.log}\`)`, '', ...lines, '']
  })
  return [
    '### Server checks',
    '',
    'Failures upstream main also shows are not regressions (rerun on an upstream checkout). A test',
    'that passes when its file runs again alone is reported as flaky and not compared.',
    '',
    '| Check | Result | Time | Regressions | Also on upstream | Flaky |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...details
  ].join('\n')
}

function publish({ git, report, forkRepo, checks }) {
  git.run(['fetch', '--quiet', 'origin', 'main'])
  if (git.text(['rev-parse', 'origin/main']) !== report.mainSha) {
    throw new Error('main moved during the sync; the main-update commit no longer extends it.')
  }
  const specs = pushRefspecs(report, ['stack', 'integration', 'main-update'])
  git.run(['push', '--atomic', '--quiet', 'origin', ...specs])
  const body = `${renderPullRequestBody({ report }).trimEnd()}\n\n${checksSection(checks)}`
  const bodyFile = path.join(git.cwd, '..', `.fork-sync-pr-body-${process.pid}.md`)
  writeFileSync(bodyFile, body)
  const created = command('gh', [
    'pr',
    'create',
    '-R',
    forkRepo,
    '--base',
    'main',
    '--head',
    report.mainUpdate.branch,
    '--title',
    `chore(fork): update main to ${report.integration.branch}`,
    '--body-file',
    bodyFile
  ])
  unlinkSync(bodyFile)
  if (!created.ok) {
    throw new Error(`gh pr create failed: ${created.stderr}`)
  }
  const url = created.stdout.split('\n').at(-1)
  const superseded = []
  for (const pr of openMainUpdatePrs(forkRepo)) {
    if (pr.headRefName !== report.mainUpdate.branch) {
      command('gh', [
        'pr',
        'close',
        String(pr.number),
        '-R',
        forkRepo,
        '--comment',
        `Superseded by ${url}.`
      ])
      superseded.push(pr.number)
    }
  }
  return { url, superseded, action: 'opened' }
}

/** Failed checks in the shape the shared report renderer reads as failed jobs. */
function checkNeeds(checks) {
  return Object.fromEntries(
    checks
      .filter((check) => check.status === 'failed')
      .map((check) => [`check: ${check.label}`, { result: 'failure' }])
  )
}

function writeSummary({ logs, runDir, summary, report, checks }) {
  mkdirSync(runDir, { recursive: true })
  const detail = [
    report
      ? renderSyncReport({ report, needs: checkNeeds(checks) }).trimEnd()
      : `## Fork stack sync ${summary.date}\n\n${summary.message ?? ''}`,
    '',
    checksSection(checks)
  ].join('\n')
  summary.detailPath = path.join(logs, 'latest-detail.md')
  const files = {
    'summary.json': `${JSON.stringify(summary, null, 2)}\n`,
    'summary.md': renderServerSummary(summary),
    'detail.md': `${detail.trimEnd()}\n`
  }
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(runDir, name), text)
  }
  copyFileSync(path.join(runDir, 'summary.json'), path.join(logs, 'latest.json'))
  copyFileSync(path.join(runDir, 'summary.md'), path.join(logs, 'latest.md'))
  copyFileSync(path.join(runDir, 'detail.md'), path.join(logs, 'latest-detail.md'))
}

function sync({ options, toolsDir, summary, runDir }) {
  const repoGit = createGit(toolsDir)
  const repo = path.dirname(
    repoGit.text(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  )
  const workRoot = `${repo}-wt`
  const worktree = path.resolve(options.worktree ?? path.join(workRoot, '_sync'))
  const baselineWorktree = path.resolve(
    options['baseline-worktree'] ?? path.join(workRoot, '_sync-baseline')
  )
  const xtermWorkDir = path.resolve(options['xterm-work-dir'] ?? path.join(workRoot, '_sync-xterm'))
  for (const { program, args } of [
    { program: 'pnpm', args: ['--version'] },
    { program: 'bun', args: ['--version'] },
    { program: 'gh', args: ['auth', 'status'] }
  ]) {
    if (!command(program, args).ok) {
      return {
        status: 'environment-error',
        message: `${program} ${args.join(' ')} 실행 실패 (PATH, gh 로그인, XDG 설정 확인)`
      }
    }
  }
  const forkRepo = forkRepository(repoGit)
  repoGit.run(['fetch', '--quiet', '--prune', 'origin'])
  const source = manifestSource(repoGit)
  const manifestText = repoGit.text(['show', `${source}:${MANIFEST_PATH}`])
  const manifest = parseManifest(manifestText)
  if (!repoGit.ok(['remote', 'get-url', 'upstream'])) {
    repoGit.run([
      'remote',
      'add',
      'upstream',
      `https://github.com/${manifest.upstream.repository}.git`
    ])
  }
  repoGit.run(['fetch', '--quiet', '--no-tags', 'upstream', manifest.upstream.branch])
  const git = ensureWorktree(repoGit, worktree, 'origin/main')
  const upstreamPrs = lookUpUpstreamPrs({ git, manifest, refPrefix: 'origin/' })
  const report = runStackSync({
    cwd: worktree,
    manifestText,
    upstreamRef: options['upstream-ref'] ?? `upstream/${manifest.upstream.branch}`,
    mainRef: 'origin/main',
    date: summary.date,
    upstreamPrs,
    xtermWorkDir
  })
  writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  Object.assign(summary, {
    manifestSource: source,
    upstream: report.upstream,
    mainSha: report.mainSha,
    restack: { status: report.status, key: report.key, topics: report.topics },
    integration: report.integration,
    mainUpdate: report.mainUpdate
  })
  if (report.status !== 'ready') {
    return {
      status: decideOutcome({ restackStatus: report.status, topics: report.topics }),
      report
    }
  }
  const tree = report.mainUpdate.tree
  const treeOf = (ref) =>
    git
      .run(['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], { allowFailure: true })
      .stdout.trim()
  const sameAsOpen = openMainUpdatePrs(forkRepo).find(
    (pr) => treeOf(`origin/${pr.headRefName}`) === tree
  )
  if (sameAsOpen) {
    summary.pr = { url: sameAsOpen.url, action: 'unchanged' }
    return { status: 'no-change', message: `열린 PR과 내용이 같습니다: ${sameAsOpen.url}`, report }
  }
  const prepared = prepareCheckout({
    worktree,
    sha: report.integration.sha,
    logFile: path.join(runDir, 'install.log')
  })
  const checks = prepared.ok
    ? runChecks({
        worktree,
        baselineWorktree: ensureWorktree(repoGit, baselineWorktree, report.upstream.sha).cwd,
        upstreamSha: report.upstream.sha,
        logDir: runDir,
        xtermWorkDir,
        fullTests: shouldRunFullTests({ mode: options['full-tests'] ?? 'auto', date: summary.date })
      })
    : [
        {
          name: 'install',
          label: '의존성 설치',
          status: 'failed',
          seconds: 0,
          regressions: [prepared.error],
          known: [],
          log: path.join(runDir, 'install.log')
        }
      ]
  summary.checks = checks
  const status = decideOutcome({ restackStatus: report.status, checks })
  if (status !== 'success' || options['dry-run']) {
    return { status, report, checks }
  }
  summary.pr = publish({ git, report, forkRepo, checks })
  return { status, report, checks }
}

function main(argv) {
  const options = parseArgs(argv)
  const toolsDir = path.resolve(import.meta.dirname, '../..')
  if (!options['no-self-update']) {
    const code = selfUpdate(toolsDir, argv)
    if (code !== null) {
      return code
    }
  }
  const started = Date.now()
  const date = options.date ?? new Date().toISOString().slice(0, 10)
  const repo = path.dirname(
    createGit(toolsDir).text(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  )
  const logs = path.resolve(options.logs ?? `${repo}-sync-logs`)
  const runDir = path.join(
    logs,
    'runs',
    `${date}T${new Date().toISOString().slice(11, 19).replaceAll(':', '')}`
  )
  mkdirSync(runDir, { recursive: true })
  const summary = {
    version: 1,
    date,
    dryRun: Boolean(options['dry-run']),
    startedAt: new Date(started).toISOString(),
    runDir
  }
  const lockFile = path.join(logs, '.sync.lock')
  const lock = acquireLock(lockFile)
  let result
  if (!lock.ok) {
    result = {
      status: 'environment-error',
      message: `다른 동기화가 실행 중입니다 (pid ${lock.owner?.pid ?? '?'}).`
    }
  } else {
    try {
      result = sync({ options, toolsDir, summary, runDir })
    } catch (error) {
      result = {
        status: 'environment-error',
        message: error.message.split('\n').slice(0, 3).join(' ')
      }
    } finally {
      releaseLock(lockFile)
    }
  }
  Object.assign(summary, {
    status: result.status,
    exitCode: EXIT_CODES[result.status],
    message: result.message ?? summary.message,
    finishedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - started) / 1000)
  })
  writeSummary({ logs, runDir, summary, report: result.report, checks: summary.checks ?? [] })
  process.stdout.write(renderServerSummary(summary))
  return summary.exitCode
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  process.exitCode = EXIT_CODES['environment-error']
}
