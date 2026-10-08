import { describe, expect, it } from 'vitest'
import {
  classifyConflict,
  conflictsDifferOnlyBy,
  lockfileNormalizer,
  normalizeSourcePatchText,
  parseConflictSegments,
  resolveWithTopic
} from './fork-stack-xterm-conflicts.mjs'

const HASH_BASE = 'a'.repeat(64)
const HASH_TOPIC = 'b'.repeat(64)
const HASH_OTHER = 'c'.repeat(64)

describe('conflict parsing', () => {
  const text = 'head\n<<<<<<< HEAD\nbase side\n=======\ntopic side\n>>>>>>> abc\ntail\n'

  it('keeps the topic side of each hunk', () => {
    expect(resolveWithTopic(parseConflictSegments(text))).toBe('head\ntopic side\ntail\n')
  })

  it('rejects unterminated or diff3 markers', () => {
    expect(parseConflictSegments('<<<<<<< HEAD\nours\n')).toBeNull()
    expect(
      parseConflictSegments('<<<<<<< HEAD\na\n||||||| base\nb\n=======\nc\n>>>>>>> x\n')
    ).toBeNull()
  })

  it('treats source patch blob ids and new-side offsets as derived', () => {
    const conflict = (base, topic) =>
      parseConflictSegments(`<<<<<<< HEAD\n${base}=======\n${topic}>>>>>>> x\n`)
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
    const normalize = lockfileNormalizer(new Set([HASH_BASE, HASH_TOPIC]))
    expect(normalize(`x: ${HASH_BASE}`)).toBe(normalize(`x: ${HASH_TOPIC}`))
    expect(normalize(`x: ${HASH_BASE}`)).not.toBe(normalize(`x: ${HASH_OTHER}`))
  })
})

describe('conflict classification', () => {
  const xterm = {
    generated: new Set(['config/patches/@xterm__xterm@1.patch']),
    sources: new Set(['config/patches/xterm-src/@xterm__xterm@1.src.patch']),
    lockfileHashes: new Set([HASH_BASE, HASH_TOPIC])
  }
  const marked = (base, topic) => `<<<<<<< HEAD\n${base}\n=======\n${topic}\n>>>>>>> x\n`

  it('regenerates generated patches regardless of content', () => {
    const conflict = classifyConflict({
      path: [...xterm.generated][0],
      stages: [1, 2, 3],
      text: 'x',
      xterm
    })
    expect(conflict).toMatchObject({ resolution: 'topic', kind: 'both modified' })
  })

  it('leaves real conflicts, deletions, other files, and disabled regeneration to a human', () => {
    const source = [...xterm.sources][0]
    expect(
      classifyConflict({ path: source, stages: [1, 2, 3], text: marked('+a', '+b'), xterm })
        .resolution
    ).toBeNull()
    expect(classifyConflict({ path: source, stages: [1, 3], text: undefined, xterm }).kind).toBe(
      'deleted on the new base'
    )
    expect(
      classifyConflict({ path: 'src/a.ts', stages: [1, 2, 3], text: marked('a', 'b'), xterm })
        .resolution
    ).toBeNull()
    expect(
      classifyConflict({ path: [...xterm.generated][0], stages: [1, 2, 3], text: 'x', xterm: null })
        .resolution
    ).toBeNull()
  })

  it('accepts a lockfile that differs only in xterm hashes', () => {
    const ok = classifyConflict({
      path: 'pnpm-lock.yaml',
      stages: [1, 2, 3],
      text: marked(`  x: ${HASH_BASE}`, `  x: ${HASH_TOPIC}`),
      xterm
    })
    expect(ok.resolution).toBe('topic-hunks')
    const drift = classifyConflict({
      path: 'pnpm-lock.yaml',
      stages: [1, 2, 3],
      text: marked(`  x: ${HASH_BASE}`, `  y: ${HASH_TOPIC}`),
      xterm
    })
    expect(drift.resolution).toBeNull()
  })
})
