#!/usr/bin/env node
// Re-stacks the fork's topic stacks onto upstream main, merges them into an integration branch,
// and builds the main-update commit. Decisions live in the pure fork-stack-*.mjs modules; this
// file only talks to git and gh. See docs/reference/fork-upstream-sync.md.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  MANIFEST_PATH,
  parseManifest,
  pickSyncKey,
  pruneCandidates,
  serializeManifest,
  syncBranchNames,
  updateManifest
} from './fork-stack-manifest.mjs'
import { regenerateXterm, settleConflicts } from './fork-stack-conflict-settling.mjs'
import {
  PICK_CONFIG,
  cleanCheckout,
  commitRecords,
  createGit,
  resolveCommit,
  short,
  tail
} from './fork-stack-git.mjs'
import {
  learnMergeResolutions,
  mergeStacks,
  previousIntegration
} from './fork-stack-integration.mjs'
import {
  cherryPickSources,
  commitTreeArgs,
  mainUpdateMessage,
  parseCherryOutput,
  parseUpstreamPrStates,
  planTopicCommits,
  upstreamPrNumbers,
  upstreamPrQuery
} from './fork-stack-restack-plan.mjs'
import { runProcessSync } from './script-child-process.mjs'

const LOCAL_REF_PREFIX = 'refs/fork-sync/'

export function lookUpUpstreamPrs({ git, manifest, refPrefix, gh = 'gh' }) {
  const numbers = new Set()
  for (const topic of manifest.topics) {
    const tip = resolveCommit(git, `${refPrefix}${topic.ref}`)
    if (!tip || !resolveCommit(git, topic.base)) {
      continue
    }
    for (const commit of commitRecords(git, [tip, `^${topic.base}`])) {
      upstreamPrNumbers(commit.message, manifest.upstream.repository).forEach((number) =>
        numbers.add(number)
      )
    }
  }
  if (numbers.size === 0) {
    return { ok: true, prs: {} }
  }
  const result = runProcessSync({
    program: gh,
    args: [
      'api',
      'graphql',
      '-f',
      `query=${upstreamPrQuery(manifest.upstream.repository, [...numbers])}`
    ],
    timeoutMs: 120_000
  })
  let prs = {}
  try {
    prs = parseUpstreamPrStates(JSON.parse(result.stdout))
  } catch {
    // gh printed no JSON body; the error below says why.
  }
  if (result.code !== 0) {
    return { ok: false, error: tail(result.stderr || result.stdout, 5), prs }
  }
  return { ok: true, prs }
}

/** Manifest paths and xterm lockfile hashes on both sides of the conflict being settled. */
export function restackTopic({
  git,
  topic,
  ontoSha,
  upstreamSha,
  refPrefix,
  prStates,
  manifest,
  xtermWorkDir
}) {
  const result = {
    name: topic.name,
    onto: topic.onto,
    previousRef: topic.ref,
    previousBase: topic.base,
    steps: []
  }
  const tip = resolveCommit(git, `${refPrefix}${topic.ref}`)
  if (!tip) {
    return { ...result, status: 'error', error: `Branch ${refPrefix}${topic.ref} does not exist.` }
  }
  if (
    !resolveCommit(git, topic.base) ||
    !git.ok(['merge-base', '--is-ancestor', topic.base, tip])
  ) {
    return {
      ...result,
      status: 'error',
      error: `Manifest base ${short(topic.base)} is not an ancestor of ${topic.ref}. After rebuilding a stack by hand, record its new base in ${MANIFEST_PATH}.`
    }
  }
  const range = [tip, `^${topic.base}`, `^${ontoSha}`]
  const merges = git.text(['rev-list', '--merges', ...range])
  if (merges) {
    return {
      ...result,
      status: 'error',
      error: `${topic.ref} contains merge commits (${merges.split('\n').map(short).join(', ')}); a stack must be a linear series.`
    }
  }
  const records = commitRecords(git, range)
  if (topic.base === ontoSha) {
    const steps = records.map((commit) => ({
      sha: commit.sha,
      subject: commit.subject,
      action: 'kept'
    }))
    return { ...result, status: 'reused', newTip: tip, steps }
  }
  const upstreamSources = new Set(
    records
      .flatMap((commit) => cherryPickSources(commit.message))
      .filter(
        (sha) =>
          resolveCommit(git, sha) && git.ok(['merge-base', '--is-ancestor', sha, upstreamSha])
      )
  )
  const plan = planTopicCommits({
    commits: records,
    upstreamSources,
    cherry: parseCherryOutput(git.text(['cherry', ontoSha, tip, topic.base])),
    prStates,
    repository: manifest.upstream.repository,
    upstreamBranch: manifest.upstream.branch
  })
  git.run(['checkout', '--quiet', '--detach', ontoSha])
  let regenerate = false
  for (const step of plan) {
    const record = { sha: step.sha, subject: step.subject }
    if (step.action === 'drop') {
      result.steps.push({ ...step, action: 'dropped' })
      continue
    }
    const pick = git.run([...PICK_CONFIG, 'cherry-pick', '--no-commit', step.sha], {
      allowFailure: true
    })
    if (pick.code !== 0) {
      const settled = settleConflicts(git, `${pick.stdout}\n${pick.stderr}`, {
        topicRevision: step.sha,
        regenerateXterm: Boolean(xtermWorkDir)
      })
      if (settled.blocked) {
        cleanCheckout(git)
        return {
          ...result,
          status: settled.files.length > 0 ? 'conflict' : 'error',
          conflict: { ...record, files: settled.files },
          ...(settled.error ? { error: settled.error } : {})
        }
      }
      if (settled.rerere.length > 0) {
        record.rerere = settled.rerere
      }
      if (settled.xtermRegenerable) {
        record.xtermRegenerable = settled.xtermRegenerable
        regenerate = true
      }
    }
    if (git.ok(['diff', '--cached', '--quiet', 'HEAD'])) {
      cleanCheckout(git)
      result.steps.push({ ...record, action: 'dropped', reason: 'empty' })
      continue
    }
    // -C keeps the topic commit's author, message and trailers.
    git.run(['commit', '--quiet', '--no-verify', '-C', step.sha])
    result.steps.push({ ...record, action: 'picked', newSha: git.text(['rev-parse', 'HEAD']) })
  }
  if (regenerate) {
    const xterm = regenerateXterm(git, topic, xtermWorkDir)
    if (!xterm.ok) {
      return { ...result, status: 'xterm-failed', xtermLog: xterm.log }
    }
    if (xterm.step) {
      result.steps.push(xterm.step)
    }
  }
  return { ...result, status: 'restacked', newTip: git.text(['rev-parse', 'HEAD']) }
}

/** rerere-train for integration merges: records the resolutions main's last integration used. */
function remoteBranches(git, remote) {
  return git
    .text(['for-each-ref', '--format=%(refname)', `refs/remotes/${remote}/`])
    .split('\n')
    .filter(Boolean)
    .map((ref) => ref.slice(`refs/remotes/${remote}/`.length))
    .filter((branch) => branch !== 'HEAD')
}

function resetLocalRefs(git) {
  for (const ref of git
    .text(['for-each-ref', '--format=%(refname)', LOCAL_REF_PREFIX])
    .split('\n')) {
    if (ref) {
      git.run(['update-ref', '-d', ref])
    }
  }
}

function upstreamPrStatesWithAncestry(git, lookup, upstreamSha) {
  const states = {}
  for (const [number, state] of Object.entries(lookup?.prs ?? {})) {
    const inUpstream =
      Boolean(state.mergeCommit) &&
      Boolean(resolveCommit(git, state.mergeCommit)) &&
      git.ok(['merge-base', '--is-ancestor', state.mergeCommit, upstreamSha])
    states[number] = { ...state, inUpstream }
  }
  return states
}

/**
 * The whole sync on the current repository: re-stack every topic, merge them into the
 * integration commit, record the new manifest, and build the main-update commit. Leaves local
 * refs under refs/fork-sync/ for the caller to bundle and push; never pushes.
 */
export function runStackSync({
  cwd,
  manifestText,
  upstreamRef,
  mainRef,
  remote = 'origin',
  refPrefix = `${remote}/`,
  date,
  upstreamPrs,
  xtermWorkDir
}) {
  const git = createGit(cwd)
  if (git.text(['status', '--porcelain', '--untracked-files=no']).length > 0) {
    throw new Error('The working tree has uncommitted changes; the sync needs a clean checkout.')
  }
  const manifest = parseManifest(manifestText)
  const upstreamSha = git.text(['rev-parse', '--verify', `${upstreamRef}^{commit}`])
  const mainSha = git.text(['rev-parse', '--verify', `${mainRef}^{commit}`])
  const key = pickSyncKey(date, remoteBranches(git, remote))
  const names = syncBranchNames(
    key,
    manifest.topics.map((topic) => topic.name)
  )
  const prStates = upstreamPrStatesWithAncestry(git, upstreamPrs, upstreamSha)
  resetLocalRefs(git)
  const report = {
    key,
    date,
    upstream: { ...manifest.upstream, sha: upstreamSha },
    mainSha,
    prLookup: upstreamPrs ? { ok: upstreamPrs.ok, error: upstreamPrs.error } : undefined,
    topics: [],
    integration: { branch: names.integration, status: 'not-run' },
    refs: []
  }
  const upstreamTopics = manifest.topics.filter((topic) => topic.onto === 'upstream')
  for (const topic of upstreamTopics) {
    report.topics.push(
      restackTopic({
        git,
        topic,
        ontoSha: upstreamSha,
        upstreamSha,
        refPrefix,
        prStates,
        manifest,
        xtermWorkDir
      })
    )
  }
  const integrationTopics = manifest.topics.filter((topic) => topic.onto === 'integration')
  const notRun = (topic) => ({
    name: topic.name,
    onto: topic.onto,
    previousRef: topic.ref,
    previousBase: topic.base,
    status: 'not-run',
    steps: []
  })
  if (report.topics.some((topic) => !['restacked', 'reused'].includes(topic.status))) {
    report.topics.push(...integrationTopics.map(notRun))
    report.status = 'blocked'
    return report
  }
  // Merge messages and the manifest name the published refs, so assign them before merging.
  const assignRef = (topic, newBase) => {
    if (topic.status === 'restacked') {
      topic.newRef = names.stacks[topic.name]
      topic.newBase = newBase
    }
  }
  report.topics.forEach((topic) => assignRef(topic, upstreamSha))
  const learnFrom = previousIntegration(git, mainSha)
  if (learnFrom) {
    report.integration.learnedMerges = learnMergeResolutions({
      git,
      integrationSha: learnFrom,
      upstreamSha
    })
  }
  const merged = mergeStacks({
    git,
    upstreamSha,
    topics: report.topics,
    integrationBranch: names.integration
  })
  report.integration = { ...report.integration, ...merged }
  if (merged.status !== 'built') {
    report.topics.push(...integrationTopics.map(notRun))
    report.status = 'blocked'
    return report
  }
  for (const topic of integrationTopics) {
    const ontoSha = git.text(['rev-parse', 'HEAD'])
    const restacked = restackTopic({
      git,
      topic,
      ontoSha,
      upstreamSha,
      refPrefix,
      prStates,
      manifest,
      xtermWorkDir
    })
    assignRef(restacked, ontoSha)
    report.topics.push(restacked)
    if (!['restacked', 'reused'].includes(restacked.status)) {
      report.integration.status = 'not-run'
      report.status = 'blocked'
      return report
    }
    git.run(['checkout', '--quiet', '--detach', restacked.newTip])
  }
  for (const topic of report.topics) {
    if (topic.newRef) {
      report.refs.push({ kind: 'stack', branch: topic.newRef, sha: topic.newTip })
    }
  }
  mkdirSync(path.dirname(path.join(cwd, MANIFEST_PATH)), { recursive: true })
  writeFileSync(
    path.join(cwd, MANIFEST_PATH),
    serializeManifest(updateManifest(manifest, report.topics))
  )
  git.run(['add', '--', MANIFEST_PATH])
  if (!git.ok(['diff', '--cached', '--quiet', 'HEAD'])) {
    git.run(['commit', '--quiet', '--no-verify', '-F', '-'], {
      input: `chore(fork): record stack refs for sync ${key}\n\nFork-Topic: sync-automation\n`
    })
  }
  const integrationSha = git.text(['rev-parse', 'HEAD'])
  report.integration.sha = integrationSha
  report.refs.push({ kind: 'integration', branch: names.integration, sha: integrationSha })
  const tree = git.text(['rev-parse', `${integrationSha}^{tree}`])
  if (tree === git.text(['rev-parse', `${mainSha}^{tree}`])) {
    report.status = 'up-to-date'
    report.refs = []
    return report
  }
  const mainUpdateSha = git.text(commitTreeArgs({ tree, mainSha, integrationSha }), {
    input: mainUpdateMessage({
      key,
      integrationBranch: names.integration,
      upstreamSha,
      topics: report.topics
    })
  })
  report.mainUpdate = { branch: names.mainUpdate, sha: mainUpdateSha, tree }
  report.refs.push({ kind: 'main-update', branch: names.mainUpdate, sha: mainUpdateSha })
  report.diffStat = git.text(['diff', '--stat=100', '--stat-count=80', mainSha, integrationSha])
  for (const ref of report.refs) {
    git.run(['update-ref', `${LOCAL_REF_PREFIX}${ref.branch}`, ref.sha])
  }
  report.status = 'ready'
  return report
}

function writeOutputs(report) {
  const outputs = {
    status: report.status,
    key: report.key,
    main_sha: report.mainSha,
    integration_sha: report.integration?.sha ?? '',
    integration_branch: report.integration?.branch ?? '',
    main_update_sha: report.mainUpdate?.sha ?? '',
    main_update_branch: report.mainUpdate?.branch ?? ''
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

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

const USAGE = `Usage:
  fork-stack-sync.mjs upstream-prs --out=<json> [--manifest=${MANIFEST_PATH}] [--remote=origin]
  fork-stack-sync.mjs restack --report=<json> [--manifest=${MANIFEST_PATH}] [--upstream=upstream/main]
      [--main=origin/main] [--remote=origin] [--upstream-prs=<json>] [--xterm-work-dir=<dir>]
      [--bundle=<file>] [--date=YYYY-MM-DD]
  fork-stack-sync.mjs prune-plan [--manifest=${MANIFEST_PATH}] [--remote=origin] [--keep=7]`

function main(argv) {
  const { command, options } = parseArgs(argv)
  const cwd = path.resolve(options.cwd ?? '.')
  const remote = options.remote ?? 'origin'
  const manifestText = readFileSync(path.resolve(cwd, options.manifest ?? MANIFEST_PATH), 'utf8')
  const git = createGit(cwd)
  if (command === 'upstream-prs') {
    const lookup = lookUpUpstreamPrs({
      git,
      manifest: parseManifest(manifestText),
      refPrefix: `${remote}/`
    })
    writeJson(path.resolve(required(options, 'out')), lookup)
    if (!lookup.ok) {
      console.warn(`::warning::Upstream PR lookup failed: ${lookup.error}`)
    }
  } else if (command === 'restack') {
    const reportPath = path.resolve(required(options, 'report'))
    const prsPath = options['upstream-prs']
    const report = runStackSync({
      cwd,
      manifestText,
      upstreamRef: options.upstream ?? 'upstream/main',
      mainRef: options.main ?? `${remote}/main`,
      remote,
      date: options.date ?? new Date().toISOString().slice(0, 10),
      upstreamPrs:
        prsPath && existsSync(prsPath) ? JSON.parse(readFileSync(prsPath, 'utf8')) : undefined,
      xtermWorkDir: options['xterm-work-dir'] ? path.resolve(options['xterm-work-dir']) : undefined
    })
    writeJson(reportPath, report)
    if (options.bundle && report.status === 'ready') {
      mkdirSync(path.dirname(path.resolve(options.bundle)), { recursive: true })
      git.run([
        'bundle',
        'create',
        path.resolve(options.bundle),
        ...report.refs.map((ref) => `${LOCAL_REF_PREFIX}${ref.branch}`),
        '--not',
        report.mainSha
      ])
    }
    writeOutputs(report)
  } else if (command === 'prune-plan') {
    const branches = remoteBranches(git, remote)
    const candidates = pruneCandidates({
      branches,
      manifest: parseManifest(manifestText),
      keep: Number(options.keep ?? 7)
    })
    for (const branch of candidates) {
      console.info(`git push ${remote} --delete ${branch}`)
    }
  } else {
    throw new Error(USAGE)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
