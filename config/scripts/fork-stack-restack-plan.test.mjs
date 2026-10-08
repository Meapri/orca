import { describe, expect, it } from 'vitest'
import {
  cherryPickSources,
  commitTreeArgs,
  conflictKind,
  mainUpdateMessage,
  parseCherryOutput,
  parseCommitRecords,
  parseUnmergedStages,
  parseUpstreamPrStates,
  planTopicCommits,
  rerereResolvedPaths,
  trailerLines,
  upstreamPrNumbers,
  upstreamPrQuery
} from './fork-stack-restack-plan.mjs'

const sha = (digit) => String(digit).repeat(40)

describe('git output parsing', () => {
  it('reads git cherry marks', () => {
    const marks = parseCherryOutput(`+ ${sha(1)}\n- ${sha(2)} subject\n\n`)
    expect(marks.get(sha(1))).toBe('unique')
    expect(marks.get(sha(2))).toBe('equivalent')
  })

  it('reads log records with multi-line bodies', () => {
    const text = `${sha(1)}\x1ffeat: a\x1ffeat: a\n\nbody\n\x1e\n${sha(2)}\x1ffix: b\x1ffix: b\n\x1e\n`
    expect(parseCommitRecords(text)).toEqual([
      { sha: sha(1), subject: 'feat: a', message: 'feat: a\n\nbody' },
      { sha: sha(2), subject: 'fix: b', message: 'fix: b' }
    ])
  })

  it('reads rerere and unmerged-stage output', () => {
    expect(
      rerereResolvedPaths(
        "Resolved 'b.ts' using previous resolution.\nStaged 'a.ts' using previous resolution.\nCONFLICT (content): Merge conflict in c.ts\n"
      )
    ).toEqual(['a.ts', 'b.ts'])
    const record = (stage, file) => `100644 ${'1'.repeat(40)} ${stage}\t${file}`
    const stages = parseUnmergedStages(
      [record(1, 'a'), record(2, 'a'), record(3, 'a'), record(1, 'b'), record(3, 'b')].join('\0')
    )
    expect(conflictKind(stages.get('a'))).toBe('both modified')
    expect(conflictKind(stages.get('b'))).toBe('deleted on the new base')
    expect(conflictKind([1, 2])).toBe('deleted by topic')
    expect(() => parseUnmergedStages('garbage')).toThrow(/Unrecognised/)
  })
})

describe('upstream PR trailers', () => {
  const message = [
    'fix(terminal): keep scroll pinned',
    '',
    'Upstream-PR: stablyai/orca#1 in the body is not a trailer.',
    '',
    'Fork-Topic: terminal',
    'Upstream-PR: stablyai/orca#23334',
    'upstream-pr: https://github.com/StablyAI/orca/pull/23337',
    'Upstream-PR: someone/else#5',
    'Co-Authored-By: A <a@example.com>'
  ].join('\n')

  it('reads only the trailer block and only the upstream repository', () => {
    expect(trailerLines(message)).toHaveLength(5)
    expect(upstreamPrNumbers(message, 'stablyai/orca')).toEqual([23334, 23337])
    expect(
      upstreamPrNumbers('subject only\nUpstream-PR: stablyai/orca#9', 'stablyai/orca')
    ).toEqual([])
    expect(upstreamPrNumbers('a\n\nnot: a trailer block\nplain prose', 'stablyai/orca')).toEqual([])
  })

  it('asks GitHub about every PR in one query and reads the answer', () => {
    const query = upstreamPrQuery('stablyai/orca', [23337, 23334, 23337])
    expect(query.match(/pullRequest\(/g)).toHaveLength(2)
    expect(query).toContain('repository(owner: "stablyai", name: "orca")')
    const states = parseUpstreamPrStates({
      data: {
        repository: {
          pr23334: {
            number: 23334,
            url: 'https://github.com/stablyai/orca/pull/23334',
            merged: true,
            baseRefName: 'main',
            mergeCommit: { oid: sha(3) }
          },
          pr23337: {
            number: 23337,
            url: 'u',
            merged: false,
            baseRefName: 'main',
            mergeCommit: null
          },
          pr9: null
        }
      }
    })
    expect(states[23334]).toEqual({
      merged: true,
      baseRef: 'main',
      mergeCommit: sha(3),
      url: 'https://github.com/stablyai/orca/pull/23334'
    })
    expect(states[23337].merged).toBe(false)
    expect(Object.keys(states)).toHaveLength(2)
  })

  it('reads cherry-pick -x sources', () => {
    expect(cherryPickSources(`fix: x\n\n(cherry picked from commit ${sha(4)})\n`)).toEqual([sha(4)])
  })
})

describe('commit planning', () => {
  const commits = [
    { sha: sha(1), subject: 'feat: fork only', message: 'feat: fork only' },
    { sha: sha(2), subject: 'fix: same patch', message: 'fix: same patch' },
    {
      sha: sha(3),
      subject: 'fix: merged PR',
      message: 'fix: merged PR\n\nUpstream-PR: stablyai/orca#10'
    },
    {
      sha: sha(4),
      subject: 'fix: PR merged elsewhere',
      message: 'fix: PR merged elsewhere\n\nUpstream-PR: stablyai/orca#11'
    },
    {
      sha: sha(5),
      subject: 'fix: open PR',
      message: 'fix: open PR\n\nUpstream-PR: stablyai/orca#12'
    },
    {
      sha: sha(6),
      subject: 'fix: picked from an upstream PR',
      message: `fix: picked\n\n(cherry picked from commit ${sha(9)})`
    },
    {
      sha: sha(7),
      subject: 'fix: merged PR not in the fetched upstream yet',
      message: 'fix\n\nUpstream-PR: stablyai/orca#13'
    }
  ]
  const cherry = new Map([
    [sha(2), 'equivalent'],
    [sha(3), 'equivalent'],
    [sha(6), 'equivalent']
  ])
  const prStates = {
    10: { merged: true, baseRef: 'main', inUpstream: true, url: 'https://x/10' },
    11: { merged: true, baseRef: 'release', inUpstream: false },
    12: { merged: false, baseRef: 'main' },
    13: { merged: true, baseRef: 'main', inUpstream: false }
  }

  it('drops what upstream accepted and keeps the rest, with the reason', () => {
    const plan = planTopicCommits({
      commits,
      cherry,
      prStates,
      repository: 'stablyai/orca',
      upstreamBranch: 'main',
      upstreamSources: new Set([sha(9)])
    })
    expect(plan.map((step) => [step.action, step.reason])).toEqual([
      ['pick', undefined],
      ['drop', 'patch-equivalent'],
      ['drop', 'upstream-accepted'],
      ['pick', undefined],
      ['pick', undefined],
      ['drop', 'upstream-commit'],
      ['pick', undefined]
    ])
    expect(plan[2]).toMatchObject({ pr: 10, prUrl: 'https://x/10', samePatch: true })
    expect(plan[5]).toMatchObject({ upstreamCommit: sha(9) })
    expect(plan[4].prs).toEqual([12])
  })

  it('keeps everything when the PR lookup failed', () => {
    const plan = planTopicCommits({
      commits,
      cherry: new Map(),
      prStates: {},
      repository: 'stablyai/orca',
      upstreamBranch: 'main'
    })
    expect(plan.every((step) => step.action === 'pick')).toBe(true)
  })
})

describe('main-update commit', () => {
  it('takes the integration tree with main first and the integration second', () => {
    expect(commitTreeArgs({ tree: 't', mainSha: 'm', integrationSha: 'i' })).toEqual([
      'commit-tree',
      't',
      '-p',
      'm',
      '-p',
      'i',
      '-F',
      '-'
    ])
    const message = mainUpdateMessage({
      key: '2026-10-09',
      integrationBranch: 'integrate/fork-2026-10-09',
      upstreamSha: sha(5),
      topics: [
        { name: 'terminal', newRef: 'stack-sync/2026-10-09/terminal' },
        { name: 'distribution', previousRef: 'stack/distribution' }
      ]
    })
    expect(message.split('\n')[0]).toBe('chore(fork): update main to integrate/fork-2026-10-09')
    expect(message).toContain('- terminal: stack-sync/2026-10-09/terminal')
    expect(message).toContain('- distribution: stack/distribution')
  })
})
