#!/usr/bin/env node
// Renders the single tracking issue the fork's upstream sync opens when it cannot finish.
// Node built-ins only, so the reporting job needs no dependency install.
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const ISSUE_MARKER = '<!-- fork-upstream-sync -->'
const MAX_LISTED_COMMITS = 50
const DOC = 'docs/reference/fork-upstream-sync.md'

const JOB_LABELS = {
  merge: 'merge and xterm patch check',
  publish: 'push sync branch',
  static_checks: 'typecheck and lint',
  unit_plan: 'unit test plan',
  unit_tests: 'unit tests',
  relay_integration: 'relay integration tests',
  build: 'build'
}

/** Jobs that ran and did not pass; skipped jobs are downstream of the real failure. */
export function failedJobs(needs) {
  return Object.entries(needs ?? {})
    .filter(([, job]) => job?.result === 'failure' || job?.result === 'cancelled')
    .map(([name, job]) => ({ name, label: JOB_LABELS[name] ?? name, result: job.result }))
}

const short = (sha) => (sha ? sha.slice(0, 12) : 'unknown')

function fence(text) {
  return ['```text', text.replaceAll('```', "'''"), '```'].join('\n')
}

function conflictSection(report) {
  const conflicts = report.conflicts ?? []
  const rows = conflicts.map(
    (conflict) =>
      `| \`${conflict.path}\` | ${conflict.kind} | ${conflict.resolution ? `auto (${conflict.reason})` : 'needs a human'} |`
  )
  const lines = [
    `### Merge conflicts (${conflicts.filter((conflict) => !conflict.resolution).length} unresolved)`,
    '',
    '| Path | Kind | Resolution |',
    '| --- | --- | --- |',
    ...rows
  ]
  if (
    conflicts.some(
      (conflict) => conflict.path.startsWith('config/patches/xterm-src/') && !conflict.resolution
    )
  ) {
    lines.push(
      '',
      'An xterm **source** patch conflicts. Do the source-level 3-way merge described in',
      `\`${DOC}\` ("xterm 3-way merge"), then regenerate. Never hand-merge the generated`,
      '`config/patches/@xterm__*.patch` files: take either side and run `--write`.'
    )
  }
  return lines.join('\n')
}

function xtermSection(report) {
  const xterm = report.xterm
  const lines = ['### xterm patches did not regenerate', '']
  lines.push(
    xterm.sourceMergeNeeded
      ? 'The merged source patch no longer applies to the pinned xterm commit: a **source-level 3-way merge** is needed.'
      : `\`regenerate-xterm-patches.mjs\` failed after: ${xterm.steps.join(' → ')}.`
  )
  lines.push(
    `Follow "xterm 3-way merge" in \`${DOC}\`.`,
    '',
    '<details><summary>Log tail</summary>',
    ''
  )
  lines.push(fence(xterm.log ?? '(no output)'), '', '</details>')
  return lines.join('\n')
}

function nextSteps(report) {
  const branch = report.branch ?? 'sync/upstream-<date>'
  const mergeCommitted =
    report.status === 'merged' ||
    (report.status === 'xterm-failed' && report.headSha !== report.baseSha)
  const lines = [
    '### Finish the sync',
    '',
    '```sh',
    'git fetch origin && git fetch upstream',
    `git switch -c ${branch} origin/${branch}`
  ]
  if (!mergeCommitted) {
    lines.push(
      `git merge --no-ff ${short(report.upstreamSha)}   # upstream/main at sync time; resolve, then commit`
    )
  }
  lines.push(
    'node config/scripts/regenerate-xterm-patches.mjs --check   # --write, pnpm install, --check if it fails',
    'pnpm tc && pnpm lint && pnpm test',
    `git push origin ${branch}`,
    `git push origin ${branch}:main   # fast-forward only; never --force`,
    '```',
    '',
    `The next successful sync closes this issue. Process: \`${DOC}\`.`
  )
  return lines.join('\n')
}

function commitList(report) {
  const commits = report.upstreamCommits ?? []
  if (commits.length === 0) {
    return ''
  }
  const listed = commits
    .slice(0, MAX_LISTED_COMMITS)
    .map((commit) => `- \`${commit.sha}\` ${commit.subject}`)
  if (commits.length > MAX_LISTED_COMMITS) {
    listed.push(`- … and ${commits.length - MAX_LISTED_COMMITS} more`)
  }
  return [
    `<details><summary>${commits.length} upstream commits</summary>`,
    '',
    ...listed,
    '',
    '</details>'
  ].join('\n')
}

export function renderIssueBody({ report, needs, runUrl, fastForward }) {
  const lines = [ISSUE_MARKER, `Automated upstream sync run: ${runUrl}`, '']
  if (!report) {
    lines.push('The sync stopped before it produced a report. Open the run log for the cause.')
    return lines.join('\n')
  }
  const commitCount = report.upstreamCommits?.length ?? 0
  lines.push(
    `- **Date:** ${report.date}`,
    `- **Fork main:** \`${short(report.baseSha)}\``,
    `- **Upstream main:** \`${short(report.upstreamSha)}\` (${commitCount} new first-parent commits)`,
    `- **Branch:** \`${report.branch ?? '(not created)'}\` at \`${short(report.headSha)}\`${report.headSha === report.baseSha ? ' — fork main before the merge' : ' — includes the merge commit'}`,
    ''
  )
  if (report.status === 'conflict') {
    lines.push(conflictSection(report), '')
  }
  if (report.status === 'xterm-failed') {
    lines.push(xtermSection(report), '')
  }
  const failed = failedJobs(needs).filter(
    (job) => !(job.name === 'merge' && report.status !== 'merged')
  )
  if (failed.length > 0) {
    lines.push(
      '### Failed checks',
      '',
      ...failed.map((job) => `- ${job.label}: **${job.result}**`),
      ''
    )
  }
  if (fastForward) {
    lines.push('### main was not fast-forwarded', '', fastForward, '')
  }
  lines.push(nextSteps(report), '', commitList(report))
  return `${lines.join('\n').trimEnd()}\n`
}

function main(argv) {
  const option = (name) =>
    argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  const reportPath = option('report')
  const report =
    reportPath && existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : undefined
  const needs = process.env.SYNC_NEEDS ? JSON.parse(process.env.SYNC_NEEDS) : {}
  process.stdout.write(
    renderIssueBody({
      report,
      needs,
      runUrl: option('run-url') ?? '(unknown run)',
      fastForward: process.env.SYNC_FAST_FORWARD ?? ''
    })
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
