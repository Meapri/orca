// Real repositories: a fake upstream, a bare fork remote holding two topic stacks, and the
// sync run against them end to end (no network, no push).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MANIFEST_PATH, parseManifest, serializeManifest } from './fork-stack-manifest.mjs'
import { runStackSync } from './fork-stack-sync.mjs'
import { runProcessSync } from './script-child-process.mjs'

const isolatedEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Sync test',
  GIT_AUTHOR_EMAIL: 'sync-test@example.com',
  GIT_COMMITTER_NAME: 'Sync test',
  GIT_COMMITTER_EMAIL: 'sync-test@example.com'
}
const savedEnv = {}
let root

beforeAll(() => {
  for (const [key, value] of Object.entries(isolatedEnv)) {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }
  root = mkdtempSync(path.join(tmpdir(), 'fork-stack-sync-'))
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
  expect(result.code, `git ${args.join(' ')}\n${result.stderr}`).toBe(0)
  return result.stdout.trim()
}

function commit(cwd, files, message) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
    writeFileSync(path.join(cwd, file), content)
  }
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '--quiet', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

const lines = (...values) => `${values.join('\n')}\n`

/** Upstream U0, fork main == U0, and stacks built on U0 by `buildStacks(work)`. */
function setup(name, buildStacks, baseFiles = {}) {
  const dir = path.join(root, name)
  const origin = path.join(dir, 'origin.git')
  const work = path.join(dir, 'work')
  mkdirSync(work, { recursive: true })
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin)
  git(work, 'init', '--quiet', '-b', 'main')
  const u0 = commit(
    work,
    {
      'README.md': lines('title', 'body'),
      'shared.txt': lines('one', 'two', 'three'),
      'merged.txt': lines('a'),
      'pr.txt': lines('pr'),
      'empty.txt': lines('e'),
      ...baseFiles
    },
    'upstream base'
  )
  git(work, 'branch', 'upstream-main')
  git(work, 'remote', 'add', 'origin', origin)
  const topics = buildStacks(work, u0)
  git(work, 'switch', '--quiet', 'main')
  git(work, 'push', '--quiet', 'origin', 'main', ...topics.map((topic) => topic.ref))
  git(work, 'fetch', '--quiet', 'origin')
  git(work, 'switch', '--quiet', '--detach', 'origin/main')
  const manifest = {
    version: 1,
    upstream: { repository: 'stablyai/orca', branch: 'main' },
    topics: topics.map((topic) => ({ ...topic, base: u0, onto: 'upstream' }))
  }
  return { work, u0, manifestText: serializeManifest(manifest) }
}

function stack(work, base, ref, commits) {
  git(work, 'switch', '--quiet', '-c', ref, base)
  return commits.map(([files, message]) => commit(work, files, message))
}

function advanceUpstream(work, changes) {
  git(work, 'switch', '--quiet', 'upstream-main')
  const shas = changes.map((change) =>
    typeof change === 'function' ? change() : commit(work, change[0], change[1])
  )
  git(work, 'switch', '--quiet', '--detach', 'origin/main')
  return shas
}

const sync = (work, manifestText, extra = {}) =>
  runStackSync({
    cwd: work,
    manifestText,
    upstreamRef: 'upstream-main',
    mainRef: 'origin/main',
    date: '2026-10-09',
    ...extra
  })

describe('fork stack sync on real repositories', () => {
  it('re-stacks, drops what upstream accepted, and builds a two-parent main-update commit', () => {
    let alpha = []
    let beta = []
    let pullSource
    const { work, u0, manifestText } = setup('happy', (repo, base) => {
      git(repo, 'switch', '--quiet', '-c', 'pr-source', base)
      pullSource = commit(repo, { 'shared.txt': lines('one', 'two', 'three', 'pr') }, 'pr work')
      alpha = stack(repo, base, 'stack/alpha', [
        [{ 'alpha.txt': lines('alpha') }, 'feat(alpha): add alpha'],
        [{ 'merged.txt': lines('a', 'b') }, 'fix: change upstream later takes verbatim'],
        [
          { 'pr.txt': lines('pr', 'fork version') },
          'fix: open upstream PR\n\nBody.\n\nFork-Topic: alpha\nUpstream-PR: stablyai/orca#7'
        ],
        [{ 'empty.txt': lines('e', 'x') }, 'fix: change upstream later folds into a bigger one']
      ])
      git(repo, 'cherry-pick', '-x', pullSource)
      alpha.push(git(repo, 'rev-parse', 'HEAD'))
      beta = stack(repo, base, 'stack/beta', [
        [{ 'beta.txt': lines('beta') }, 'feat(beta): add beta'],
        [{ 'README.md': lines('title', 'body', 'beta') }, 'docs(beta): mention beta']
      ])
      return [
        { name: 'alpha', ref: 'stack/alpha' },
        { name: 'beta', ref: 'stack/beta' }
      ]
    })
    const [, prMerge] = advanceUpstream(work, [
      [{ 'merged.txt': lines('a', 'b') }, 'upstream: same patch as the fork'],
      [{ 'pr.txt': lines('pr', 'upstream version') }, 'upstream: merge PR 7 (changed in review)'],
      [{ 'empty.txt': lines('e', 'x'), 'other.txt': lines('o') }, 'upstream: superset'],
      () => {
        git(work, 'merge', '--quiet', '--no-ff', '-m', 'upstream: merge pr-source', pullSource)
        return git(work, 'rev-parse', 'HEAD')
      }
    ])
    const upstreamSha = git(work, 'rev-parse', 'upstream-main')
    const report = sync(work, manifestText, {
      upstreamPrs: {
        ok: true,
        prs: { 7: { merged: true, baseRef: 'main', mergeCommit: prMerge, url: 'https://x/7' } }
      }
    })

    expect(report.status).toBe('ready')
    const [alphaResult, betaResult] = report.topics
    expect(alphaResult.status).toBe('restacked')
    expect(alphaResult.steps.map((step) => [step.sha, step.action, step.reason])).toEqual([
      [alpha[0], 'picked', undefined],
      [alpha[1], 'dropped', 'patch-equivalent'],
      [alpha[2], 'dropped', 'upstream-accepted'],
      [alpha[3], 'dropped', 'empty'],
      [alpha[4], 'dropped', 'upstream-commit']
    ])
    expect(alphaResult.steps[2]).toMatchObject({ pr: 7, samePatch: false })
    expect(betaResult.steps.map((step) => [step.sha, step.action])).toEqual([
      [beta[0], 'picked'],
      [beta[1], 'picked']
    ])
    expect(alphaResult.newRef).toBe('stack-sync/2026-10-09/alpha')
    expect(alphaResult.newBase).toBe(upstreamSha)
    expect(git(work, 'rev-parse', `${alphaResult.newTip}~1`)).toBe(upstreamSha)

    const integration = report.integration.sha
    const firstParents = git(
      work,
      'log',
      '--first-parent',
      '--format=%s',
      `${upstreamSha}..${integration}`
    )
    expect(firstParents.split('\n')).toEqual([
      'chore(fork): record stack refs for sync 2026-10-09',
      'Merge stack-sync/2026-10-09/beta into integrate/fork-2026-10-09',
      'Merge stack-sync/2026-10-09/alpha into integrate/fork-2026-10-09'
    ])
    const recorded = parseManifest(git(work, 'show', `${integration}:${MANIFEST_PATH}`))
    expect(recorded.topics.map((topic) => [topic.ref, topic.base])).toEqual([
      ['stack-sync/2026-10-09/alpha', upstreamSha],
      ['stack-sync/2026-10-09/beta', upstreamSha]
    ])

    const mainUpdate = report.mainUpdate.sha
    const mainSha = git(work, 'rev-parse', 'origin/main')
    expect(mainSha).toBe(u0)
    expect(git(work, 'rev-list', '--parents', '-n', '1', mainUpdate).split(' ').slice(1)).toEqual([
      mainSha,
      integration
    ])
    expect(git(work, 'rev-parse', `${mainUpdate}^{tree}`)).toBe(
      git(work, 'rev-parse', `${integration}^{tree}`)
    )
    expect(git(work, 'merge-base', '--is-ancestor', mainSha, mainUpdate)).toBe('')
    expect(report.refs.map((ref) => [ref.kind, ref.branch])).toEqual([
      ['stack', 'stack-sync/2026-10-09/alpha'],
      ['stack', 'stack-sync/2026-10-09/beta'],
      ['integration', 'integrate/fork-2026-10-09'],
      ['main-update', 'main-update/fork-2026-10-09']
    ])
    expect(git(work, 'rev-parse', 'refs/fork-sync/main-update/fork-2026-10-09')).toBe(mainUpdate)

    // main adopts the update; the same inputs are then up to date, and a rerun picks a new key.
    git(work, 'push', '--quiet', 'origin', `${mainUpdate}:refs/heads/main`)
    git(
      work,
      'push',
      '--quiet',
      'origin',
      ...report.refs.map((ref) => `${ref.sha}:refs/heads/${ref.branch}`)
    )
    git(work, 'fetch', '--quiet', 'origin')
    git(work, 'switch', '--quiet', '--detach', 'origin/main')
    const again = sync(work, readFileSync(path.join(work, MANIFEST_PATH), 'utf8'))
    expect(again.key).toBe('2026-10-09-2')
    expect(again.topics.map((topic) => topic.status)).toEqual(['reused', 'reused'])
    expect(again.status).toBe('up-to-date')
    expect(again.refs).toEqual([])
  })

  it('reports exactly which topic and commit conflict, and still re-stacks the others', () => {
    let beta = []
    const { work, manifestText } = setup('conflict', (repo, base) => {
      stack(repo, base, 'stack/alpha', [[{ 'alpha.txt': lines('alpha') }, 'feat(alpha): add']])
      beta = stack(repo, base, 'stack/beta', [
        [{ 'beta.txt': lines('beta') }, 'feat(beta): add beta'],
        [{ 'README.md': lines('fork title', 'body') }, 'docs(beta): retitle'],
        [{ 'beta.txt': lines('beta', 'more') }, 'feat(beta): more']
      ])
      return [
        { name: 'beta', ref: 'stack/beta' },
        { name: 'alpha', ref: 'stack/alpha' }
      ]
    })
    advanceUpstream(work, [[{ 'README.md': lines('upstream title', 'body') }, 'upstream: retitle']])
    const report = sync(work, manifestText)
    expect(report.status).toBe('blocked')
    expect(report.topics.map((topic) => [topic.name, topic.status])).toEqual([
      ['beta', 'conflict'],
      ['alpha', 'restacked']
    ])
    expect(report.topics[0].conflict).toEqual({
      sha: beta[1],
      subject: 'docs(beta): retitle',
      files: [{ path: 'README.md', kind: 'both modified' }]
    })
    expect(report.topics[0].steps.map((step) => step.sha)).toEqual([beta[0]])
    expect(report.integration.status).toBe('not-run')
    expect(report.refs).toEqual([])
    expect(git(work, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    expect(existsSync(path.join(work, '.git', 'CHERRY_PICK_HEAD'))).toBe(false)
  })

  it('reports an integration conflict between stacks, then replays its resolution from main', () => {
    const { work, u0, manifestText } = setup('integration', (repo, base) => {
      stack(repo, base, 'stack/alpha', [
        [{ 'shared.txt': lines('one', 'alpha', 'three') }, 'feat(alpha): shared']
      ])
      stack(repo, base, 'stack/beta', [
        [{ 'shared.txt': lines('one', 'beta', 'three') }, 'feat(beta): shared']
      ])
      return [
        { name: 'alpha', ref: 'stack/alpha' },
        { name: 'beta', ref: 'stack/beta' }
      ]
    })
    advanceUpstream(work, [[{ 'up.txt': lines('u1') }, 'upstream: unrelated']])
    const blocked = sync(work, manifestText)
    expect(blocked.status).toBe('blocked')
    expect(blocked.integration).toMatchObject({
      status: 'conflict',
      conflict: { topic: 'beta', files: [{ path: 'shared.txt', kind: 'both modified' }] }
    })

    // A human integrates by hand (on the old upstream, stacks unchanged) and main adopts it.
    git(work, 'switch', '--quiet', '--detach', u0)
    git(work, 'merge', '--quiet', '--no-ff', '-m', 'merge alpha', 'origin/stack/alpha')
    const manual = runProcessSync({
      program: 'git',
      args: ['merge', '--no-ff', '-m', 'merge beta', 'origin/stack/beta'],
      cwd: work
    })
    expect(manual.code).not.toBe(0)
    writeFileSync(path.join(work, 'shared.txt'), lines('one', 'alpha and beta', 'three'))
    git(work, 'add', 'shared.txt')
    git(work, 'commit', '--quiet', '--no-edit')
    const integration = git(work, 'rev-parse', 'HEAD')
    const mainUpdate = git(
      work,
      'commit-tree',
      `${integration}^{tree}`,
      '-p',
      u0,
      '-p',
      integration,
      '-m',
      'main update'
    )
    // Merged with GitHub's merge button: one more merge commit with the same tree.
    const buttonMerge = git(
      work,
      'commit-tree',
      `${mainUpdate}^{tree}`,
      '-p',
      u0,
      '-p',
      mainUpdate,
      '-m',
      'Merge pull request #1'
    )
    git(work, 'push', '--quiet', 'origin', `${buttonMerge}:refs/heads/main`)
    git(work, 'fetch', '--quiet', 'origin')
    git(work, 'switch', '--quiet', '--detach', 'origin/main')

    const replayed = sync(work, manifestText)
    expect(replayed.status).toBe('ready')
    expect(replayed.integration.learnedMerges).toBe(1)
    expect(replayed.integration.rerere).toEqual([{ topic: 'beta', paths: ['shared.txt'] }])
    expect(git(work, 'show', `${replayed.integration.sha}:shared.txt`)).toBe(
      lines('one', 'alpha and beta', 'three').trimEnd()
    )
  })

  it('refuses a dirty checkout and reports a manifest base that is not in the stack', () => {
    const { work, manifestText } = setup('invalid', (repo, base) => {
      stack(repo, base, 'stack/alpha', [[{ 'alpha.txt': lines('alpha') }, 'feat(alpha): add']])
      return [{ name: 'alpha', ref: 'stack/alpha' }]
    })
    const unrelated = advanceUpstream(work, [[{ 'up.txt': lines('u1') }, 'upstream: unrelated']])
    const wrongBase = manifestText.replace(/"base": "[0-9a-f]{40}"/, `"base": "${unrelated[0]}"`)
    const report = sync(work, wrongBase)
    expect(report.topics[0]).toMatchObject({ status: 'error' })
    expect(report.topics[0].error).toMatch(/is not an ancestor of stack\/alpha/)

    writeFileSync(path.join(work, 'README.md'), 'dirty\n')
    expect(() => sync(work, manifestText)).toThrow(/uncommitted changes/)
  })

  // Fake generator: FAKE_REGENERATOR picks pass or fail; a pass rewrites the generated bundle.
  const xtermBase = {
    'config/patches/xterm-upstream.json': JSON.stringify({
      packages: [
        {
          name: '@xterm/xterm',
          version: '1',
          sourcePatch: 'config/patches/xterm-src/@xterm__xterm@1.src.patch',
          patch: 'config/patches/@xterm__xterm@1.patch'
        }
      ]
    }),
    'config/patches/@xterm__xterm@1.patch': lines('bundle base'),
    'config/scripts/regenerate-xterm-patches.mjs': `
import { readFileSync, writeFileSync } from 'node:fs'
if (readFileSync('FAKE_REGENERATOR', 'utf8').trim() === 'fail') {
  console.error('error: patch failed: src/a.ts:1')
  process.exit(1)
}
writeFileSync('config/patches/@xterm__xterm@1.patch', 'regenerated\\n')
`,
    '.gitignore': lines('FAKE_REGENERATOR')
  }

  function xtermSetup(name, regenerator) {
    let picked = []
    const repo = setup(
      name,
      (work, base) => {
        picked = stack(work, base, 'stack/terminal', [
          [{ 'config/patches/@xterm__xterm@1.patch': lines('bundle fork') }, 'feat(xterm): patch']
        ])
        return [{ name: 'terminal', ref: 'stack/terminal' }]
      },
      xtermBase
    )
    advanceUpstream(repo.work, [
      [{ 'config/patches/@xterm__xterm@1.patch': lines('bundle upstream') }, 'upstream: xterm bump']
    ])
    writeFileSync(path.join(repo.work, 'FAKE_REGENERATOR'), regenerator)
    return { ...repo, picked }
  }

  it('settles a generated xterm patch conflict by regenerating at the end of the topic', () => {
    const { work, manifestText, picked } = xtermSetup('xterm', 'pass')
    const report = sync(work, manifestText, { xtermWorkDir: path.join(work, '..', 'xterm') })
    expect(report.status).toBe('ready')
    const steps = report.topics[0].steps
    expect(steps[0]).toMatchObject({
      sha: picked[0],
      action: 'picked',
      xtermRegenerable: ['config/patches/@xterm__xterm@1.patch']
    })
    expect(steps[1]).toMatchObject({
      action: 'generated',
      subject: 'chore(xterm): regenerate patches after re-stacking terminal'
    })
    expect(
      git(work, 'show', `${report.topics[0].newTip}:config/patches/@xterm__xterm@1.patch`)
    ).toBe('regenerated')
  })

  it('blocks the topic when xterm regeneration fails or is not enabled', () => {
    const failing = xtermSetup('xterm-fail', 'fail')
    const failed = sync(failing.work, failing.manifestText, {
      xtermWorkDir: path.join(failing.work, '..', 'xterm')
    })
    expect(failed.topics[0]).toMatchObject({ status: 'xterm-failed' })
    expect(failed.topics[0].xtermLog).toContain('patch failed')
    expect(git(failing.work, 'status', '--porcelain', '--untracked-files=no')).toBe('')

    const disabled = xtermSetup('xterm-off', 'pass')
    const blocked = sync(disabled.work, disabled.manifestText)
    expect(blocked.topics[0].conflict.files).toEqual([
      { path: 'config/patches/@xterm__xterm@1.patch', kind: 'both modified' }
    ])
  })
})
