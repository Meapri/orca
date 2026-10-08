import { describe, expect, it } from 'vitest'
import {
  failedJobs,
  pushRefspecs,
  renderPullRequestBody,
  renderSyncReport,
  renderTopicBlocker
} from './fork-stack-report.mjs'

const sha = (digit) => String(digit).repeat(40)

const readyReport = {
  key: '2026-10-09',
  status: 'ready',
  upstream: { repository: 'stablyai/orca', branch: 'main', sha: sha(1) },
  mainSha: sha(2),
  prLookup: { ok: true },
  topics: [
    {
      name: 'terminal',
      onto: 'upstream',
      status: 'restacked',
      previousRef: 'stack/terminal',
      previousBase: sha(3),
      newRef: 'stack-sync/2026-10-09/terminal',
      newTip: sha(4),
      steps: [
        { sha: sha(5), subject: 'feat: keep', action: 'picked', rerere: ['src/a.ts'] },
        {
          sha: sha(6),
          subject: 'fix: scroll pin',
          action: 'dropped',
          reason: 'upstream-accepted',
          pr: 23334,
          prUrl: 'https://github.com/stablyai/orca/pull/23334',
          samePatch: false
        },
        {
          sha: sha(7),
          subject: 'build: ws arm64 patch',
          action: 'dropped',
          reason: 'upstream-commit',
          upstreamCommit: sha(8)
        },
        { sha: sha(9), subject: 'fix: same', action: 'dropped', reason: 'patch-equivalent' },
        { sha: sha(3), subject: 'fix: folded', action: 'dropped', reason: 'empty' }
      ]
    },
    {
      name: 'distribution',
      onto: 'upstream',
      status: 'restacked',
      previousRef: 'stack/distribution',
      previousBase: sha(3),
      newRef: 'stack-sync/2026-10-09/distribution',
      newTip: sha(1),
      steps: [{ sha: sha(5), subject: 'feat: gone', action: 'dropped', reason: 'patch-equivalent' }]
    }
  ],
  integration: {
    branch: 'integrate/fork-2026-10-09',
    status: 'built',
    sha: sha(4),
    rerere: [{ topic: 'distribution', paths: ['package.json'] }]
  },
  mainUpdate: { branch: 'main-update/fork-2026-10-09', sha: sha(5) },
  diffStat: ' a | 1 +\n 1 file changed',
  refs: [
    { kind: 'stack', branch: 'stack-sync/2026-10-09/terminal', sha: sha(4) },
    { kind: 'integration', branch: 'integrate/fork-2026-10-09', sha: sha(4) },
    { kind: 'main-update', branch: 'main-update/fork-2026-10-09', sha: sha(5) }
  ]
}

describe('sync report', () => {
  it('says why each commit was dropped and what was settled automatically', () => {
    const body = renderSyncReport({ report: readyReport, runUrl: 'https://run' })
    expect(body).toContain('**Ready**')
    expect(body).toContain('### Dropped because upstream accepted the change')
    expect(body).toContain(
      '[stablyai/orca#23334](https://github.com/stablyai/orca/pull/23334) is merged; upstream changed it'
    )
    expect(body).toContain(`its cherry-picked source \`${sha(8).slice(0, 12)}\` is now in upstream`)
    expect(body).toContain('fix: same — an identical patch is now in upstream')
    expect(body).toContain('### Dropped because they became empty')
    expect(body).toContain('`src/a.ts` (rerere)')
    expect(body).toContain('merge of distribution: `package.json` (rerere)')
    expect(body).toContain('| terminal | re-stacked | 1 | 4 |')
    expect(body).toContain('- distribution: remove it from `config/fork-stacks.json`.')
    expect(body).toContain('What changes on main')
  })

  it('names the blocking topic, commit, and files, and how to resume by hand', () => {
    const topic = {
      name: 'runtime-remote',
      onto: 'upstream',
      status: 'conflict',
      previousRef: 'stack/runtime-remote',
      previousBase: sha(3),
      steps: [],
      conflict: {
        sha: sha(6),
        subject: 'fix(remote): recover after sleep',
        files: [{ path: 'src/main/a.ts', kind: 'both modified' }]
      }
    }
    const report = {
      ...readyReport,
      status: 'blocked',
      topics: [readyReport.topics[0], topic],
      integration: { branch: 'integrate/fork-2026-10-09', status: 'not-run' },
      mainUpdate: undefined,
      diffStat: undefined
    }
    const body = renderSyncReport({
      report,
      needs: { restack: { result: 'failure' }, publish: { result: 'skipped' } }
    })
    expect(body).toContain('**Blocked**: nothing was pushed')
    expect(body).toContain(`Commit \`${sha(6)}\` — fix(remote): recover after sleep`)
    expect(body).toContain('| `src/main/a.ts` | both modified |')
    expect(body).toContain('**blocked: conflict**')
    expect(body).not.toContain('### Failed jobs')
    expect(renderTopicBlocker(topic, report)).toContain(
      `git cherry-pick ${sha(3).slice(0, 12)}..origin/stack/runtime-remote`
    )
  })

  it('reports an integration conflict, failed checks, a failed PR lookup, and a missing report', () => {
    const body = renderSyncReport({
      report: {
        ...readyReport,
        prLookup: { ok: false, error: 'HTTP 502' },
        integration: {
          branch: 'integrate/fork-2026-10-09',
          status: 'conflict',
          conflict: {
            topic: 'distribution',
            files: [{ path: 'package.json', kind: 'both modified' }]
          }
        }
      },
      needs: { static_checks: { result: 'failure' }, build: { result: 'skipped' } }
    })
    expect(body).toContain('merging distribution conflicts with earlier stacks')
    expect(body).toContain('typecheck and lint: **failure**')
    expect(body).not.toContain('build: **')
    expect(body).toContain('Upstream PR lookup failed** (HTTP 502)')
    expect(renderSyncReport({ report: undefined, runUrl: 'https://run' })).toContain(
      'stopped before it wrote a report'
    )
  })

  it('explains how to merge the main-update PR without a merge commit', () => {
    const body = renderPullRequestBody({ report: readyReport })
    expect(body).toContain(`git push origin ${sha(5)}:main`)
  })
})

describe('job results and push specs', () => {
  it('only counts jobs that ran and failed', () => {
    expect(failedJobs({ a: { result: 'success' }, unit_tests: { result: 'cancelled' } })).toEqual([
      { name: 'unit_tests', label: 'unit tests', result: 'cancelled' }
    ])
  })

  it('pushes only the requested kinds of branches', () => {
    expect(pushRefspecs(readyReport, ['stack', 'integration'])).toEqual([
      `${sha(4)}:refs/heads/stack-sync/2026-10-09/terminal`,
      `${sha(4)}:refs/heads/integrate/fork-2026-10-09`
    ])
    expect(pushRefspecs(readyReport, ['main-update'])).toEqual([
      `${sha(5)}:refs/heads/main-update/fork-2026-10-09`
    ])
  })
})
