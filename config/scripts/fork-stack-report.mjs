#!/usr/bin/env node
// Renders a fork stack sync report (JSON from fork-stack-sync.mjs) as Markdown for the job
// summary, the main-update PR, and failure comments. Node built-ins only, so the publishing and
// reporting jobs need no dependency install.
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const DOC = 'docs/reference/fork-upstream-sync.md'
const MAX_LISTED = 60

const JOB_LABELS = {
  restack: 're-stack and integrate',
  publish: 'push stack and integration branches',
  static_checks: 'typecheck and lint',
  unit_plan: 'unit test plan',
  unit_tests: 'unit tests',
  relay_integration: 'relay integration tests',
  xterm_patches: 'xterm patch check',
  build: 'build',
  pull_request: 'open the main-update PR'
}

const TOPIC_RESULT = {
  reused: 'unchanged (already on this upstream)',
  restacked: 're-stacked',
  conflict: '**blocked: conflict**',
  'xterm-failed': '**blocked: xterm regeneration failed**',
  error: '**blocked: error**',
  'not-run': 'not run'
}

const short = (sha) => (sha ? sha.slice(0, 12) : 'none')

/** Jobs that ran and did not pass; skipped jobs are downstream of the real failure. */
export function failedJobs(needs) {
  return Object.entries(needs ?? {})
    .filter(([, job]) => job?.result === 'failure' || job?.result === 'cancelled')
    .map(([name, job]) => ({ name, label: JOB_LABELS[name] ?? name, result: job.result }))
}

function fence(text) {
  return ['```text', text.replaceAll('```', "'''"), '```'].join('\n')
}

function limited(lines) {
  return lines.length > MAX_LISTED
    ? [...lines.slice(0, MAX_LISTED), `- … and ${lines.length - MAX_LISTED} more`]
    : lines
}

const KEPT_ACTIONS = new Set(['picked', 'kept', 'generated'])

function topicRow(topic) {
  const steps = topic.steps ?? []
  const kept = steps.filter((step) => KEPT_ACTIONS.has(step.action)).length
  const dropped = steps.filter((step) => step.action === 'dropped').length
  const ref =
    topic.newRef && topic.newRef !== topic.previousRef
      ? `\`${topic.previousRef}\` → \`${topic.newRef}\``
      : `\`${topic.previousRef}\``
  return `| ${topic.name} | ${TOPIC_RESULT[topic.status] ?? topic.status} | ${kept} | ${dropped} | ${ref} |`
}

function droppedLines(topics, reasons, describe) {
  return topics.flatMap((topic) =>
    (topic.steps ?? [])
      .filter((step) => step.action === 'dropped' && reasons.includes(step.reason))
      .map((step) => `- ${topic.name}: \`${short(step.sha)}\` ${step.subject} — ${describe(step)}`)
  )
}

/** Why upstream counts as having accepted a dropped commit. */
export function acceptedReason(step, repository) {
  if (step.reason === 'upstream-accepted') {
    const url = step.prUrl ?? `https://github.com/${repository}/pull/${step.pr}`
    return `[${repository}#${step.pr}](${url}) is merged${step.samePatch ? ' (identical patch)' : '; upstream changed it in review and its version wins'}`
  }
  if (step.reason === 'upstream-commit') {
    return `its cherry-picked source \`${short(step.upstreamCommit)}\` is now in upstream`
  }
  return 'an identical patch is now in upstream'
}

function droppedSection(topics, repository) {
  const lines = []
  const accepted = droppedLines(
    topics,
    ['upstream-accepted', 'upstream-commit', 'patch-equivalent'],
    (step) => acceptedReason(step, repository)
  )
  if (accepted.length > 0) {
    lines.push('### Dropped because upstream accepted the change', '', ...limited(accepted), '')
  }
  const empty = droppedLines(topics, ['empty'], () => 'nothing left to apply on the new upstream')
  if (empty.length > 0) {
    lines.push('### Dropped because they became empty', '', ...limited(empty), '')
  }
  return lines
}

function settledSection(report) {
  const lines = []
  for (const topic of report.topics) {
    for (const step of topic.steps ?? []) {
      if (step.rerere?.length) {
        lines.push(
          `- ${topic.name} \`${short(step.sha)}\`: ${step.rerere.map((file) => `\`${file}\``).join(', ')} (rerere)`
        )
      }
      if (step.xtermRegenerable?.length) {
        lines.push(
          `- ${topic.name} \`${short(step.sha)}\`: ${step.xtermRegenerable.map((file) => `\`${file}\``).join(', ')} (xterm, regenerated)`
        )
      }
    }
  }
  for (const entry of report.integration?.rerere ?? []) {
    lines.push(
      `- merge of ${entry.topic}: ${entry.paths.map((file) => `\`${file}\``).join(', ')} (rerere)`
    )
  }
  return lines.length > 0
    ? [
        '### Conflicts settled automatically',
        '',
        'Review these: they reuse a recorded resolution or regenerated xterm patches.',
        '',
        ...lines,
        ''
      ]
    : []
}

/** Exactly which topic and commit stopped the sync, and the files a human has to resolve. */
export function renderTopicBlocker(topic, report) {
  const lines = [`### ${topic.name} is blocked`, '']
  if (topic.conflict) {
    lines.push(
      `Commit \`${topic.conflict.sha}\` — ${topic.conflict.subject}`,
      '',
      '| Path | Conflict |',
      '| --- | --- |',
      ...topic.conflict.files.map((file) => `| \`${file.path}\` | ${file.kind} |`)
    )
  }
  if (topic.error) {
    lines.push(fence(topic.error))
  }
  if (topic.xtermLog) {
    lines.push(
      '`regenerate-xterm-patches.mjs --write` failed; follow "xterm patches" in the doc.',
      '',
      '<details><summary>Log tail</summary>',
      '',
      fence(topic.xtermLog),
      '',
      '</details>'
    )
  }
  const onto = topic.onto === 'integration' ? 'the new integration branch' : 'upstream/main'
  lines.push(
    '',
    `Re-stack it by hand onto ${onto} (rerere replays earlier resolutions):`,
    '',
    '```sh',
    'git fetch origin && git fetch upstream',
    `git switch -c restack/${topic.name} ${topic.onto === 'integration' ? `<integration>` : short(report.upstream.sha)}`,
    `git cherry-pick ${short(topic.previousBase)}..origin/${topic.previousRef}   # resolve, git cherry-pick --continue`,
    '```',
    ''
  )
  return lines.join('\n')
}

function integrationSection(integration) {
  if (integration?.status !== 'conflict') {
    return []
  }
  const conflict = integration.conflict
  return [
    `### Integration is blocked: merging ${conflict.topic} conflicts with earlier stacks`,
    '',
    '| Path | Conflict |',
    '| --- | --- |',
    ...conflict.files.map((file) => `| \`${file.path}\` | ${file.kind} |`),
    '',
    'Each stack re-stacked cleanly on its own; the stacks overlap each other. Move the',
    'overlapping change into the later topic, or record the merge resolution with rerere.',
    ''
  ]
}

function headline(report, failed) {
  if (report.status === 'up-to-date') {
    return '**Up to date**: fork main already equals upstream main plus every stack.'
  }
  if (report.status === 'blocked') {
    return '**Blocked**: nothing was pushed. Fix the topic below, then rerun.'
  }
  if (failed.length > 0) {
    return '**Checks failed** on the integration branch; main was not proposed for update.'
  }
  return '**Ready**: every stack re-stacked and the integration branch passed its checks.'
}

export function renderSyncReport({ report, needs = {}, runUrl, prUrl }) {
  const lines = [`## Fork stack sync ${report?.key ?? ''}`.trimEnd(), '']
  if (!report) {
    lines.push('The sync stopped before it wrote a report. Open the run log for the cause.')
    if (runUrl) {
      lines.push('', `Run: ${runUrl}`)
    }
    return `${lines.join('\n')}\n`
  }
  const failed = failedJobs(needs).filter(
    (job) => !(job.name === 'restack' && report.status === 'blocked')
  )
  lines.push(headline(report, failed), '')
  lines.push(
    `- **Upstream:** ${report.upstream.repository} \`${short(report.upstream.sha)}\``,
    `- **Fork main:** \`${short(report.mainSha)}\``
  )
  if (report.integration?.sha) {
    lines.push(
      `- **Integration:** \`${report.integration.branch}\` at \`${short(report.integration.sha)}\``
    )
  }
  if (report.mainUpdate?.sha) {
    lines.push(
      `- **Main update:** \`${report.mainUpdate.branch}\` at \`${short(report.mainUpdate.sha)}\``
    )
  }
  if (prUrl) {
    lines.push(`- **Pull request:** ${prUrl}`)
  }
  if (runUrl) {
    lines.push(`- **Run:** ${runUrl}`)
  }
  if (report.prLookup && !report.prLookup.ok) {
    lines.push(
      `- **Upstream PR lookup failed** (${report.prLookup.error}); no commit was dropped for a merged PR.`
    )
  }
  lines.push(
    '',
    '| Topic | Result | Kept | Dropped | Ref |',
    '| --- | --- | --- | --- | --- |',
    ...report.topics.map(topicRow),
    ''
  )
  for (const topic of report.topics) {
    if (['conflict', 'xterm-failed', 'error'].includes(topic.status)) {
      lines.push(renderTopicBlocker(topic, report))
    }
  }
  lines.push(...integrationSection(report.integration))
  lines.push(
    ...droppedSection(report.topics, report.upstream.repository),
    ...settledSection(report)
  )
  const empty = report.topics.filter(
    (topic) => topic.status === 'restacked' && topic.newTip === report.upstream.sha
  )
  if (empty.length > 0) {
    lines.push(
      '### Topics now fully upstream',
      '',
      ...empty.map((topic) => `- ${topic.name}: remove it from \`config/fork-stacks.json\`.`),
      ''
    )
  }
  if (failed.length > 0) {
    lines.push(
      '### Failed jobs',
      '',
      ...failed.map((job) => `- ${job.label}: **${job.result}**`),
      ''
    )
  }
  if (report.diffStat) {
    lines.push(
      '<details><summary>What changes on main</summary>',
      '',
      fence(report.diffStat),
      '',
      '</details>',
      ''
    )
  }
  lines.push(`Process and manual commands: \`${DOC}\`.`)
  return `${lines.join('\n').trimEnd()}\n`
}

export function renderPullRequestBody({ report, runUrl }) {
  const lines = [
    renderSyncReport({ report, runUrl }).trimEnd(),
    '',
    '### Merging',
    '',
    `The head commit's tree is exactly \`${report.integration.branch}\`, and its first parent is`,
    "main, so main moves by fast-forward. GitHub's merge button always adds a merge commit;",
    'to keep main linear, push the head instead (GitHub marks this PR merged):',
    '',
    '```sh',
    `git fetch origin ${report.mainUpdate.branch}`,
    `git push origin ${report.mainUpdate.sha}:main`,
    '```'
  ]
  return `${lines.join('\n')}\n`
}

/** `<sha>:refs/heads/<branch>` push specs for the requested kinds of published branches. */
export function pushRefspecs(report, kinds) {
  const wanted = new Set(kinds)
  return (report.refs ?? [])
    .filter((ref) => wanted.has(ref.kind))
    .map((ref) => `${ref.sha}:refs/heads/${ref.branch}`)
}

function main(argv) {
  const [command, ...rest] = argv
  const option = (name) =>
    rest.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  const reportPath = option('report')
  const report =
    reportPath && existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : undefined
  if (command === 'summary') {
    const needs = process.env.SYNC_NEEDS ? JSON.parse(process.env.SYNC_NEEDS) : {}
    process.stdout.write(
      renderSyncReport({ report, needs, runUrl: option('run-url'), prUrl: option('pr-url') })
    )
  } else if (command === 'pr-body') {
    process.stdout.write(renderPullRequestBody({ report, runUrl: option('run-url') }))
  } else if (command === 'refspecs') {
    if (!report) {
      throw new Error(`No report at ${reportPath}`)
    }
    const specs = pushRefspecs(report, (option('kinds') ?? '').split(','))
    process.stdout.write(specs.length > 0 ? `${specs.join('\n')}\n` : '')
  } else {
    throw new Error('Usage: fork-stack-report.mjs <summary|pr-body|refspecs> --report=<path>')
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
