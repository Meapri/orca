import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MANIFEST_PATH,
  branchNameProblem,
  compareSyncKeys,
  parseManifest,
  pickSyncKey,
  pruneCandidates,
  serializeManifest,
  syncBranchNames,
  syncKeyOfBranch,
  updateManifest
} from './fork-stack-manifest.mjs'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const manifestOf = (topics) =>
  JSON.stringify({
    version: 1,
    upstream: { repository: 'stablyai/orca', branch: 'main' },
    topics
  })
const topic = (name, extra = {}) => ({ name, ref: `stack/${name}`, base: SHA, ...extra })

describe('manifest parsing', () => {
  it('defaults onto to upstream and round-trips through serialize', () => {
    const parsed = parseManifest(
      manifestOf([topic('terminal'), topic('fixups', { onto: 'integration' })])
    )
    expect(parsed.topics.map((entry) => entry.onto)).toEqual(['upstream', 'integration'])
    expect(parseManifest(serializeManifest(parsed))).toEqual(parsed)
    expect(serializeManifest(parsed)).not.toContain('"onto": "upstream"')
  })

  it('lists every problem at once', () => {
    const text = JSON.stringify({
      version: 2,
      upstream: { repository: 'nope', branch: 'main' },
      topics: [
        { name: 'Bad Name', ref: 'refs/heads/x', base: 'abc', extra: true },
        topic('a'),
        topic('a')
      ]
    })
    let message = ''
    try {
      parseManifest(text)
    } catch (error) {
      message = error.message
    }
    expect(message).toContain('version must be 1')
    expect(message).toContain('upstream.repository')
    expect(message).toContain('topics[0].name')
    expect(message).toContain('topics[0].ref must be a bare branch name')
    expect(message).toContain('topics[0].base must be a full 40-character commit sha')
    expect(message).toContain('unknown field "extra"')
    expect(message).toContain('topic "a" is listed twice')
  })

  it('rejects refs git cannot hold together and misplaced integration topics', () => {
    expect(() =>
      parseManifest(manifestOf([topic('a', { ref: 'stack/a' }), topic('b', { ref: 'stack/a/b' })]))
    ).toThrow(/cannot both exist/)
    expect(() =>
      parseManifest(manifestOf([topic('a'), topic('f', { onto: 'integration' }), topic('b')]))
    ).toThrow(/must come after every upstream topic/)
    expect(() => parseManifest(manifestOf([topic('f', { onto: 'integration' })]))).toThrow(
      /first topic must build on upstream/
    )
    expect(() => parseManifest('{')).toThrow(/not valid JSON/)
  })

  it('applies git branch-name rules', () => {
    expect(branchNameProblem('stack-sync/2026-10-09/terminal')).toBeNull()
    for (const bad of ['a..b', 'a b', 'a/', '/a', 'a.lock', 'a/.b', 'a~1', 'a//b', '']) {
      expect(branchNameProblem(bad), bad).not.toBeNull()
    }
  })

  it('checks in the six fork topics in integration order, terminal first', () => {
    const text = readFileSync(path.join(import.meta.dirname, '..', 'fork-stacks.json'), 'utf8')
    const parsed = parseManifest(text)
    expect(MANIFEST_PATH).toBe('config/fork-stacks.json')
    const onUpstream = parsed.topics.filter((entry) => entry.onto === 'upstream')
    expect(onUpstream.map((entry) => entry.name)).toEqual([
      'terminal',
      'sync-automation',
      'runtime-remote',
      'accounts',
      'orcad-runtime',
      'distribution'
    ])
    expect(new Set(onUpstream.map((entry) => entry.base)).size).toBe(1)
    // Why: fixup topics sit on the merged stacks, so their base is that merge, not upstream.
    expect(
      parsed.topics.slice(onUpstream.length).every((entry) => entry.onto === 'integration')
    ).toBe(true)
    expect(serializeManifest(parsed)).toBe(text)
  })
})

describe('manifest updates', () => {
  it('moves only restacked topics', () => {
    const manifest = parseManifest(manifestOf([topic('a'), topic('b')]))
    const updated = updateManifest(manifest, [
      { name: 'a', newRef: 'stack-sync/2026-10-09/a', newBase: OTHER },
      { name: 'b', status: 'reused' }
    ])
    expect(updated.topics).toEqual([
      { name: 'a', ref: 'stack-sync/2026-10-09/a', base: OTHER, onto: 'upstream' },
      { name: 'b', ref: 'stack/b', base: SHA, onto: 'upstream' }
    ])
    expect(manifest.topics[0].ref).toBe('stack/a')
  })
})

describe('sync branch names', () => {
  it('never reuses a published key', () => {
    expect(pickSyncKey('2026-10-09', ['main', 'stack/terminal'])).toBe('2026-10-09')
    expect(
      pickSyncKey('2026-10-09', ['stack-sync/2026-10-09/terminal', 'main-update/fork-2026-10-09-2'])
    ).toBe('2026-10-09-3')
    expect(pickSyncKey('2026-10-09', ['integrate/fork-2026-10-09'])).toBe('2026-10-09-2')
    expect(() => pickSyncKey('10/09', [])).toThrow(/YYYY-MM-DD/)
  })

  it('names every published branch from one key', () => {
    expect(syncBranchNames('2026-10-09', ['terminal'])).toEqual({
      stacks: { terminal: 'stack-sync/2026-10-09/terminal' },
      integration: 'integrate/fork-2026-10-09',
      mainUpdate: 'main-update/fork-2026-10-09'
    })
    expect(syncKeyOfBranch('stack/terminal')).toBeNull()
    expect(syncKeyOfBranch('integrate/fork-manual')).toBeNull()
  })

  it('orders keys by date, then same-day suffix', () => {
    expect(
      ['2026-10-10', '2026-10-09-10', '2026-10-09', '2026-10-09-2'].sort(compareSyncKeys)
    ).toEqual(['2026-10-09', '2026-10-09-2', '2026-10-09-10', '2026-10-10'])
  })

  it('plans pruning of old automation branches only, keeping what the manifest uses', () => {
    const manifest = parseManifest(
      manifestOf([topic('a', { ref: 'stack-sync/2026-10-01/a' }), topic('b')])
    )
    const branches = [
      'main',
      'stack/b',
      'integrate/fork-2026-10-08',
      'stack-sync/2026-10-01/a',
      'stack-sync/2026-10-02/a',
      'main-update/fork-2026-10-02',
      'stack-sync/2026-10-03/a',
      'stack-sync/2026-10-04/a'
    ]
    expect(pruneCandidates({ branches, manifest, keep: 2 })).toEqual([
      'main-update/fork-2026-10-02',
      'stack-sync/2026-10-02/a',
      'stack-sync/2026-10-03/a'
    ])
  })
})
