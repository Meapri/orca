#!/usr/bin/env node
// Merges upstream/main into a fork sync branch and settles the xterm patches.
// See docs/reference/fork-upstream-sync.md.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  XTERM_MANIFEST_PATH,
  LOCKFILE_PATH,
  classifyConflict,
  parseConflictSegments,
  parseRemoteHeads,
  parseUnmergedStages,
  pickSyncBranchName,
  resolveWithOurs,
  syncBranchBaseName,
  xtermLockfileHashes,
  xtermManifestPaths
} from './fork-upstream-sync-conflicts.mjs'
import { runProcessSync } from './script-child-process.mjs'

const REPORT_TAIL_LINES = 80
const REGENERATOR = 'config/scripts/regenerate-xterm-patches.mjs'
// git apply's wording when the merged source patch no longer applies to the pinned commit.
const SOURCE_APPLY_FAILURE = /patch failed|does not apply|corrupt patch|left the checkout unchanged/

function runGit(cwd, args, { allowFailure = false } = {}) {
  const result = runProcessSync({
    program: 'git',
    args,
    cwd,
    timeoutMs: 30 * 60 * 1000,
    maxOutputBytes: 256 * 1024 * 1024
  })
  if (!allowFailure && result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}):\n${result.stderr}`)
  }
  return result
}

const git = (cwd, args) => runGit(cwd, args).stdout.trim()

function showAt(cwd, revision, filePath) {
  const result = runGit(cwd, ['show', `${revision}:${filePath}`], { allowFailure: true })
  return result.code === 0 ? result.stdout : undefined
}

function tail(text, lines = REPORT_TAIL_LINES) {
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

function upstreamCommits(cwd, baseSha, upstreamSha) {
  const log = git(cwd, ['log', '--first-parent', '--format=%h%x09%s', `${baseSha}..${upstreamSha}`])
  return log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split('\t')
      return { sha, subject: subject.join('\t') }
    })
}

/** Manifest paths and xterm lockfile hashes across both parents and the merged tree. */
function xtermContext(cwd) {
  const manifests = [
    showAt(cwd, 'HEAD', XTERM_MANIFEST_PATH),
    showAt(cwd, 'MERGE_HEAD', XTERM_MANIFEST_PATH),
    existsSync(path.join(cwd, XTERM_MANIFEST_PATH))
      ? readFileSync(path.join(cwd, XTERM_MANIFEST_PATH), 'utf8')
      : undefined
  ]
  const merged = { generated: new Set(), sources: new Set(), packageKeys: new Set() }
  for (const text of manifests) {
    let paths
    try {
      paths = text === undefined ? undefined : xtermManifestPaths(text)
    } catch {
      // A conflicted manifest is itself an unresolved conflict; skip it here.
      paths = undefined
    }
    if (!paths) {
      continue
    }
    paths.generated.forEach((value) => merged.generated.add(value))
    paths.sources.forEach((value) => merged.sources.add(value))
    paths.packageKeys.forEach((value) => merged.packageKeys.add(value))
  }
  const lockfiles = ['HEAD', 'MERGE_HEAD']
    .map((revision) => showAt(cwd, revision, LOCKFILE_PATH))
    .filter((text) => text !== undefined)
  return {
    generated: merged.generated,
    sources: merged.sources,
    lockfileHashes: xtermLockfileHashes(lockfiles, [...merged.packageKeys])
  }
}

function classifyUnmerged(cwd) {
  const stages = parseUnmergedStages(runGit(cwd, ['ls-files', '-u', '-z']).stdout)
  const xterm = xtermContext(cwd)
  return [...stages].map(([filePath, fileStages]) => {
    const absolute = path.join(cwd, filePath)
    const text = existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined
    return classifyConflict({ path: filePath, stages: fileStages, text, xterm })
  })
}

function applyResolutions(cwd, conflicts) {
  for (const conflict of conflicts) {
    if (conflict.resolution === 'ours') {
      git(cwd, ['checkout', '--ours', '--', conflict.path])
    } else {
      const absolute = path.join(cwd, conflict.path)
      writeFileSync(
        absolute,
        resolveWithOurs(parseConflictSegments(readFileSync(absolute, 'utf8')))
      )
    }
    git(cwd, ['add', '--', conflict.path])
  }
}

export function mergeUpstream({ cwd, baseRef, upstreamRef, date, remote = 'origin' }) {
  const baseSha = git(cwd, ['rev-parse', '--verify', `${baseRef}^{commit}`])
  const upstreamSha = git(cwd, ['rev-parse', '--verify', `${upstreamRef}^{commit}`])
  const report = { date, baseSha, upstreamSha, upstreamRef }
  const ancestor = runGit(cwd, ['merge-base', '--is-ancestor', upstreamSha, baseSha], {
    allowFailure: true
  })
  if (ancestor.code === 0) {
    return { ...report, status: 'up-to-date', headSha: baseSha }
  }
  const heads = git(cwd, [
    'ls-remote',
    '--heads',
    remote,
    `refs/heads/${syncBranchBaseName(date)}*`
  ])
  const branch = pickSyncBranchName(date, parseRemoteHeads(heads))
  git(cwd, ['switch', '--quiet', '--no-track', '-C', branch, baseSha])
  const commits = upstreamCommits(cwd, baseSha, upstreamSha)
  const merge = runGit(
    cwd,
    [
      '-c',
      'merge.conflictStyle=merge',
      '-c',
      'rerere.enabled=false',
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      `Merge upstream/main into fork main (sync ${date})`,
      upstreamSha
    ],
    { allowFailure: true }
  )
  const merged = { ...report, branch, upstreamCommits: commits }
  if (merge.code === 0) {
    return {
      ...merged,
      status: 'merged',
      mergeInProgress: false,
      headSha: git(cwd, ['rev-parse', 'HEAD'])
    }
  }
  const conflicts = classifyUnmerged(cwd)
  if (conflicts.length === 0) {
    runGit(cwd, ['merge', '--abort'], { allowFailure: true })
    throw new Error(`git merge failed without conflicts:\n${merge.stdout}\n${merge.stderr}`)
  }
  if (conflicts.every((conflict) => conflict.resolution !== null)) {
    applyResolutions(cwd, conflicts)
    return {
      ...merged,
      status: 'merged',
      mergeInProgress: true,
      autoResolved: conflicts,
      headSha: baseSha
    }
  }
  git(cwd, ['merge', '--abort'])
  return { ...merged, status: 'conflict', conflicts, headSha: baseSha }
}

function runRegenerator(cwd, mode, workDir) {
  const result = runProcessSync({
    program: process.execPath,
    args: [REGENERATOR, `--${mode}`, `--work-dir=${workDir}`],
    cwd,
    timeoutMs: 90 * 60 * 1000,
    maxOutputBytes: 256 * 1024 * 1024
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}` }
}

function hasChanges(cwd) {
  return git(cwd, ['status', '--porcelain', '--untracked-files=no']).length > 0
}

/**
 * Brings the merged tree's xterm patches back in sync: `--check` for a clean merge, and the
 * documented `--write` then `--check` when the merge took the fork's side of a generated file.
 */
export function settleXtermPatches({ cwd, report, workDir }) {
  if (report.status !== 'merged') {
    return report
  }
  const steps = []
  if (!report.mergeInProgress) {
    const check = runRegenerator(cwd, 'check', workDir)
    steps.push('check')
    if (check.ok) {
      return { ...report, xterm: { action: 'checked', steps } }
    }
  }
  const write = runRegenerator(cwd, 'write', workDir)
  steps.push('write')
  const verified = write.ok ? runRegenerator(cwd, 'check', workDir) : write
  if (write.ok) {
    steps.push('check')
  }
  if (!verified.ok) {
    const failure = {
      action: 'failed',
      steps,
      sourceMergeNeeded: !write.ok && SOURCE_APPLY_FAILURE.test(write.output),
      log: tail(verified.output)
    }
    if (report.mergeInProgress) {
      git(cwd, ['merge', '--abort'])
      return {
        ...report,
        status: 'xterm-failed',
        mergeInProgress: false,
        headSha: report.baseSha,
        xterm: failure
      }
    }
    git(cwd, ['reset', '--quiet', '--hard', 'HEAD'])
    return { ...report, status: 'xterm-failed', xterm: failure }
  }
  git(cwd, ['add', '--', 'config/patches', LOCKFILE_PATH])
  const leftovers = runGit(cwd, ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true })
  if (leftovers.stdout.trim().length > 0) {
    throw new Error(`Unmerged paths remain after regeneration:\n${leftovers.stdout}`)
  }
  if (report.mergeInProgress) {
    git(cwd, ['commit', '--quiet', '--no-edit'])
  } else if (hasChanges(cwd)) {
    git(cwd, [
      'commit',
      '--quiet',
      '-m',
      `chore(xterm): regenerate patches for upstream sync ${report.date}`
    ])
  }
  return {
    ...report,
    mergeInProgress: false,
    headSha: git(cwd, ['rev-parse', 'HEAD']),
    xterm: { action: 'regenerated', steps }
  }
}

function writeOutputs(report) {
  const outputs = {
    status: report.status,
    branch: report.branch ?? '',
    base_sha: report.baseSha,
    upstream_sha: report.upstreamSha,
    head_sha: report.headSha
  }
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`)
  console.info(lines.join('\n'))
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (const argument of rest) {
    const match = /^--([a-z-]+)=(.*)$/s.exec(argument)
    if (!match) {
      throw new Error(`Unknown argument: ${argument}`)
    }
    options[match[1]] = match[2]
  }
  return { command, options }
}

function required(options, name) {
  if (!options[name]) {
    throw new Error(`--${name}=<value> is required`)
  }
  return options[name]
}

function main(argv) {
  const { command, options } = parseArgs(argv)
  const cwd = path.resolve(options.cwd ?? '.')
  const reportPath = path.resolve(required(options, 'report'))
  let report
  if (command === 'merge') {
    report = mergeUpstream({
      cwd,
      baseRef: options.base ?? 'origin/main',
      upstreamRef: options.upstream ?? 'upstream/main',
      date: options.date ?? new Date().toISOString().slice(0, 10),
      remote: options.remote ?? 'origin'
    })
  } else if (command === 'xterm') {
    report = settleXtermPatches({
      cwd,
      report: JSON.parse(readFileSync(reportPath, 'utf8')),
      workDir: path.resolve(required(options, 'work-dir'))
    })
  } else {
    throw new Error('Usage: fork-upstream-sync.mjs <merge|xterm> --report=<path> [options]')
  }
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  writeOutputs(report)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
