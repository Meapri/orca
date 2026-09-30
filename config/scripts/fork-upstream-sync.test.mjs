import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  classifyConflict,
  conflictsDifferOnlyBy,
  lockfileNormalizer,
  normalizeSourcePatchText,
  parseConflictSegments,
  parseRemoteHeads,
  parseUnmergedStages,
  pickSyncBranchName,
  resolveWithOurs
} from './fork-upstream-sync-conflicts.mjs'
import { ISSUE_MARKER, failedJobs, renderIssueBody } from './fork-upstream-sync-issue.mjs'
import { mergeUpstream, settleXtermPatches } from './fork-upstream-sync.mjs'
import { runProcessSync } from './script-child-process.mjs'

const HASH_OURS = 'a'.repeat(64)
const HASH_THEIRS = 'b'.repeat(64)
const HASH_OTHER = 'c'.repeat(64)

describe('sync branch naming', () => {
  it('suffixes a name already pushed today', () => {
    expect(pickSyncBranchName('2026-10-05', [])).toBe('sync/upstream-2026-10-05')
    expect(
      pickSyncBranchName('2026-10-05', ['sync/upstream-2026-10-05', 'sync/upstream-2026-10-05-2'])
    ).toBe('sync/upstream-2026-10-05-3')
    expect(() => pickSyncBranchName('10/05', [])).toThrow(/YYYY-MM-DD/)
  })

  it('reads ls-remote heads', () => {
    expect(
      parseRemoteHeads(`${HASH_OURS.slice(0, 40)}\trefs/heads/sync/upstream-2026-10-05\n`)
    ).toEqual(['sync/upstream-2026-10-05'])
  })
})

describe('conflict parsing', () => {
  const text = 'head\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> abc\ntail\n'

  it('keeps the fork side of each hunk', () => {
    expect(resolveWithOurs(parseConflictSegments(text))).toBe('head\nours\ntail\n')
  })

  it('rejects unterminated or diff3 markers', () => {
    expect(parseConflictSegments('<<<<<<< HEAD\nours\n')).toBeNull()
    expect(
      parseConflictSegments('<<<<<<< HEAD\na\n||||||| base\nb\n=======\nc\n>>>>>>> x\n')
    ).toBeNull()
  })

  it('reads unmerged stages', () => {
    const record = (stage, file) => `100644 ${'1'.repeat(40)} ${stage}\t${file}`
    const stages = parseUnmergedStages(
      [record(1, 'a'), record(2, 'a'), record(3, 'a'), record(2, 'b'), record(3, 'b')].join('\0')
    )
    expect(stages.get('a')).toEqual([1, 2, 3])
    expect(stages.get('b')).toEqual([2, 3])
  })

  it('treats source patch blob ids and new-side offsets as derived', () => {
    const conflict = (ours, theirs) =>
      parseConflictSegments(`<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> x\n`)
    expect(
      conflictsDifferOnlyBy(
        conflict(
          'index 111..222 100644\n@@ -5,3 +5,4 @@\n',
          'index 111..333 100644\n@@ -5,3 +9,4 @@\n'
        ),
        normalizeSourcePatchText
      )
    ).toBe(true)
    expect(
      conflictsDifferOnlyBy(
        conflict('@@ -5,3 +5,4 @@\n+a\n', '@@ -5,3 +5,4 @@\n+b\n'),
        normalizeSourcePatchText
      )
    ).toBe(false)
  })

  it('only forgives lockfile hashes that belong to xterm patches', () => {
    const normalize = lockfileNormalizer(new Set([HASH_OURS, HASH_THEIRS]))
    expect(normalize(`x: ${HASH_OURS}`)).toBe(normalize(`x: ${HASH_THEIRS}`))
    expect(normalize(`x: ${HASH_OURS}`)).not.toBe(normalize(`x: ${HASH_OTHER}`))
  })
})

describe('conflict classification', () => {
  const xterm = {
    generated: new Set(['config/patches/@xterm__xterm@1.patch']),
    sources: new Set(['config/patches/xterm-src/@xterm__xterm@1.src.patch']),
    lockfileHashes: new Set([HASH_OURS, HASH_THEIRS])
  }
  const marked = (ours, theirs) => `<<<<<<< HEAD\n${ours}\n=======\n${theirs}\n>>>>>>> x\n`

  it('regenerates generated patches regardless of content', () => {
    const conflict = classifyConflict({
      path: [...xterm.generated][0],
      stages: [1, 2, 3],
      text: 'x',
      xterm
    })
    expect(conflict.resolution).toBe('ours')
  })

  it('leaves real source conflicts, deletions, and other files to a human', () => {
    const source = [...xterm.sources][0]
    expect(
      classifyConflict({ path: source, stages: [1, 2, 3], text: marked('+a', '+b'), xterm })
        .resolution
    ).toBeNull()
    expect(classifyConflict({ path: source, stages: [1, 2], text: undefined, xterm }).kind).toBe(
      'deleted by upstream'
    )
    expect(
      classifyConflict({ path: 'src/a.ts', stages: [1, 2, 3], text: marked('a', 'b'), xterm })
        .resolution
    ).toBeNull()
  })

  it('accepts a lockfile that differs only in xterm hashes', () => {
    const ok = classifyConflict({
      path: 'pnpm-lock.yaml',
      stages: [1, 2, 3],
      text: marked(`  x: ${HASH_OURS}`, `  x: ${HASH_THEIRS}`),
      xterm
    })
    expect(ok.resolution).toBe('ours-hunks')
    const drift = classifyConflict({
      path: 'pnpm-lock.yaml',
      stages: [1, 2, 3],
      text: marked(`  x: ${HASH_OURS}`, `  y: ${HASH_THEIRS}`),
      xterm
    })
    expect(drift.resolution).toBeNull()
  })
})

describe('tracking issue', () => {
  const report = {
    date: '2026-10-05',
    baseSha: '1'.repeat(40),
    upstreamSha: '2'.repeat(40),
    headSha: '1'.repeat(40),
    branch: 'sync/upstream-2026-10-05',
    upstreamCommits: [{ sha: 'abc', subject: 'feat: thing' }]
  }

  it('lists unresolved conflicts and points xterm source conflicts at the 3-way procedure', () => {
    const body = renderIssueBody({
      report: {
        ...report,
        status: 'conflict',
        conflicts: [
          {
            path: 'config/patches/xterm-src/@xterm__xterm@1.src.patch',
            kind: 'both modified',
            resolution: null
          },
          {
            path: 'pnpm-lock.yaml',
            kind: 'both modified',
            resolution: 'ours-hunks',
            reason: 'hashes'
          }
        ]
      },
      needs: { merge: { result: 'success' } },
      runUrl: 'https://example.test/run'
    })
    expect(body.startsWith(ISSUE_MARKER)).toBe(true)
    expect(body).toContain('(1 unresolved)')
    expect(body).toContain('xterm 3-way merge')
    expect(body).toContain('git merge --no-ff 222222222222')
    expect(body).toContain('feat: thing')
  })

  it('reports failed checks and a refused fast-forward without re-merging', () => {
    const body = renderIssueBody({
      report: { ...report, status: 'merged', headSha: '3'.repeat(40) },
      needs: { static_checks: { result: 'failure' }, build: { result: 'skipped' } },
      runUrl: 'https://example.test/run',
      fastForward: 'main moved'
    })
    expect(body).toContain('typecheck and lint: **failure**')
    expect(body).not.toContain('build: **')
    expect(body).toContain('main moved')
    expect(body).not.toContain('git merge --no-ff')
  })

  it('only counts jobs that ran and failed', () => {
    expect(failedJobs({ a: { result: 'success' }, b: { result: 'cancelled' } })).toEqual([
      { name: 'b', label: 'b', result: 'cancelled' }
    ])
  })
})

// Real repositories: a bare fork remote, and upstream history the fork has merged before.
describe('merge driver', () => {
  const savedEnv = {}
  const isolatedEnv = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Sync test',
    GIT_AUTHOR_EMAIL: 'sync-test@example.com',
    GIT_COMMITTER_NAME: 'Sync test',
    GIT_COMMITTER_EMAIL: 'sync-test@example.com'
  }
  let root

  beforeAll(() => {
    for (const [key, value] of Object.entries(isolatedEnv)) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
    root = mkdtempSync(path.join(tmpdir(), 'fork-upstream-sync-'))
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  function git(cwd, ...args) {
    const result = runProcessSync({ program: 'git', args, cwd, timeoutMs: 60_000 })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout.trim()
  }

  function write(cwd, files) {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
      writeFileSync(path.join(cwd, file), content)
    }
  }

  function commit(cwd, files, message) {
    write(cwd, files)
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '--quiet', '-m', message)
  }

  const manifest = JSON.stringify({
    packages: [
      {
        name: '@xterm/xterm',
        version: '1',
        sourcePatch: 'config/patches/xterm-src/@xterm__xterm@1.src.patch',
        patch: 'config/patches/@xterm__xterm@1.patch'
      }
    ]
  })
  const lockfile = (hash) =>
    `lockfileVersion: '9.0'\n\npatchedDependencies:\n  '@xterm/xterm@1': ${hash}\n`
  const sourcePatch = (blob, body) =>
    `diff --git a/src/a.ts b/src/a.ts\nindex 1111111..${blob} 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n line\n${body}`

  // Fake generator: its behaviour is picked per test through the FAKE_REGENERATOR file.
  const fakeRegenerator = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const mode = process.argv.includes('--write') ? 'write' : 'check'
const plan = JSON.parse(readFileSync('FAKE_REGENERATOR', 'utf8'))
const failOnce = plan[mode] === 'fail-once' && !existsSync('FAKE_REGENERATOR.done')
if (failOnce) writeFileSync('FAKE_REGENERATOR.done', '')
if (plan[mode] === 'fail' || failOnce) { console.error('error: patch failed: src/a.ts:1'); process.exit(1) }
if (mode === 'write') writeFileSync('config/patches/@xterm__xterm@1.patch', 'regenerated\\n')
`

  function setup(name, { forkFiles, upstreamFiles }) {
    const dir = path.join(root, name)
    const origin = path.join(dir, 'origin.git')
    const work = path.join(dir, 'work')
    mkdirSync(work, { recursive: true })
    git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin)
    git(work, 'init', '--quiet', '-b', 'main')
    commit(
      work,
      {
        'README.md': 'base\n',
        'config/patches/xterm-upstream.json': manifest,
        'config/patches/@xterm__xterm@1.patch': 'bundle base\n',
        'config/patches/xterm-src/@xterm__xterm@1.src.patch': sourcePatch('2222222', '+base\n'),
        'pnpm-lock.yaml': lockfile(HASH_OTHER),
        'config/scripts/regenerate-xterm-patches.mjs': fakeRegenerator,
        FAKE_REGENERATOR: '{}',
        '.gitignore': 'FAKE_REGENERATOR*\n'
      },
      'base'
    )
    git(work, 'branch', 'upstream-main')
    commit(work, forkFiles, 'fork change')
    git(work, 'remote', 'add', 'origin', origin)
    git(work, 'push', '--quiet', 'origin', 'main')
    git(work, 'fetch', '--quiet', 'origin')
    git(work, 'switch', '--quiet', 'upstream-main')
    if (upstreamFiles) {
      commit(work, upstreamFiles, 'upstream change')
    }
    git(work, 'switch', '--quiet', '--detach', 'origin/main')
    return work
  }

  const merge = (cwd, date = '2026-10-05') =>
    mergeUpstream({ cwd, baseRef: 'origin/main', upstreamRef: 'upstream-main', date })

  it('reports up-to-date when upstream has nothing new', () => {
    const cwd = setup('up-to-date', { forkFiles: { 'fork.txt': 'x\n' } })
    expect(merge(cwd).status).toBe('up-to-date')
  })

  it('creates a real merge commit on a fresh branch name', () => {
    const cwd = setup('clean', {
      forkFiles: { 'fork.txt': 'x\n' },
      upstreamFiles: { 'up.txt': 'y\n' }
    })
    git(cwd, 'push', '--quiet', 'origin', 'HEAD:refs/heads/sync/upstream-2026-10-05')
    const report = merge(cwd)
    expect(report).toMatchObject({
      status: 'merged',
      branch: 'sync/upstream-2026-10-05-2',
      mergeInProgress: false
    })
    expect(git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
    expect(report.upstreamCommits.map((entry) => entry.subject)).toEqual(['upstream change'])
  })

  it('aborts on a human conflict and leaves the branch at fork main', () => {
    const cwd = setup('conflict', {
      forkFiles: { 'README.md': 'fork\n' },
      upstreamFiles: { 'README.md': 'upstream\n' }
    })
    const report = merge(cwd)
    expect(report.status).toBe('conflict')
    expect(report.conflicts).toEqual([
      { path: 'README.md', kind: 'both modified', resolution: null }
    ])
    expect(existsSync(path.join(cwd, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(report.headSha).toBe(report.baseSha)
  })

  const regenerableSides = {
    forkFiles: {
      'config/patches/@xterm__xterm@1.patch': 'bundle fork\n',
      'config/patches/xterm-src/@xterm__xterm@1.src.patch': sourcePatch('3333333', '+base\n'),
      'pnpm-lock.yaml': lockfile(HASH_OURS)
    },
    upstreamFiles: {
      'config/patches/@xterm__xterm@1.patch': 'bundle upstream\n',
      'config/patches/xterm-src/@xterm__xterm@1.src.patch': sourcePatch('4444444', '+base\n'),
      'pnpm-lock.yaml': lockfile(HASH_THEIRS),
      'up.txt': 'y\n'
    }
  }

  it('settles derived xterm conflicts by regenerating inside the merge commit', () => {
    const cwd = setup('regenerate', regenerableSides)
    const report = merge(cwd)
    expect(report).toMatchObject({ status: 'merged', mergeInProgress: true })
    expect(report.autoResolved.map((entry) => entry.resolution).sort()).toEqual([
      'ours',
      'ours-hunks',
      'ours-hunks'
    ])
    const settled = settleXtermPatches({ cwd, report, workDir: path.join(cwd, '..', 'xterm') })
    expect(settled.xterm).toMatchObject({ action: 'regenerated', steps: ['write', 'check'] })
    expect(git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
    expect(readFileSync(path.join(cwd, 'config/patches/@xterm__xterm@1.patch'), 'utf8')).toBe(
      'regenerated\n'
    )
    expect(git(cwd, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  })

  it('flags a source-level 3-way merge when the merged source patch will not apply', () => {
    const cwd = setup('source-merge', regenerableSides)
    writeFileSync(path.join(cwd, 'FAKE_REGENERATOR'), '{"write":"fail"}')
    const settled = settleXtermPatches({
      cwd,
      report: merge(cwd),
      workDir: path.join(cwd, '..', 'xterm')
    })
    expect(settled).toMatchObject({ status: 'xterm-failed', xterm: { sourceMergeNeeded: true } })
    expect(settled.headSha).toBe(settled.baseSha)
    expect(existsSync(path.join(cwd, '.git', 'MERGE_HEAD'))).toBe(false)
  })

  it('commits a regeneration on top of a clean merge whose check fails', () => {
    const cwd = setup('clean-regenerate', {
      forkFiles: { 'fork.txt': 'x\n' },
      upstreamFiles: { 'up.txt': 'y\n' }
    })
    // The first check fails; the write and its verifying check pass.
    writeFileSync(path.join(cwd, 'FAKE_REGENERATOR'), '{"check":"fail-once"}')
    const settled = settleXtermPatches({
      cwd,
      report: merge(cwd),
      workDir: path.join(cwd, '..', 'xterm')
    })
    expect(settled.xterm).toMatchObject({
      action: 'regenerated',
      steps: ['check', 'write', 'check']
    })
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe(
      'chore(xterm): regenerate patches for upstream sync 2026-10-05'
    )
  })
})
