// Pure decisions about which re-stack conflicts the xterm patch generator can settle. A topic
// commit that conflicts only in files `regenerate-xterm-patches.mjs --write` rederives keeps the
// topic's side and is regenerated at the end of the topic.
import { readLockfilePatchHash } from './regenerate-xterm-patches.mjs'
import { conflictKind } from './fork-stack-restack-plan.mjs'

export const XTERM_MANIFEST_PATH = 'config/patches/xterm-upstream.json'
export const LOCKFILE_PATH = 'pnpm-lock.yaml'

/**
 * Splits a file that holds `merge`-style conflict markers (no diff3 base section) into
 * plain text and conflict segments. `base` is the side being built on, `topic` the side being
 * applied. Returns null when the markers are malformed.
 */
export function parseConflictSegments(text) {
  const segments = []
  let state = 'plain'
  let current = { base: [], topic: [] }
  let plain = []
  for (const line of text.split(/(?<=\n)/)) {
    if (state === 'plain' && line.startsWith('<<<<<<< ')) {
      segments.push({ plain: plain.join('') })
      plain = []
      state = 'base'
    } else if (state === 'base' && /^=======\r?\n?$/.test(line)) {
      state = 'topic'
    } else if (state === 'topic' && line.startsWith('>>>>>>> ')) {
      segments.push({ base: current.base.join(''), topic: current.topic.join('') })
      current = { base: [], topic: [] }
      state = 'plain'
    } else if (state === 'plain') {
      plain.push(line)
    } else if (line.startsWith('<<<<<<< ') || line.startsWith('||||||| ')) {
      return null
    } else {
      current[state].push(line)
    }
  }
  if (state !== 'plain') {
    return null
  }
  segments.push({ plain: plain.join('') })
  return segments
}

export function resolveWithTopic(segments) {
  return segments.map((segment) => segment.plain ?? segment.topic).join('')
}

/** True when every conflict hunk is identical on both sides once `normalize` is applied. */
export function conflictsDifferOnlyBy(segments, normalize) {
  const conflicts = segments.filter((segment) => segment.plain === undefined)
  return (
    conflicts.length > 0 &&
    conflicts.every((segment) => normalize(segment.base) === normalize(segment.topic))
  )
}

// `--write` re-diffs the source patch, so blob ids and new-side hunk offsets are rederived.
export function normalizeSourcePatchText(text) {
  return text
    .replace(/^index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$/gm, 'index <blobs>')
    .replace(/^@@ -(\d+(?:,\d+)?) \+\d+((?:,\d+)?) @@/gm, '@@ -$1 +<start>$2 @@')
}

// Only hashes pnpm derived from an xterm patch; any other lockfile drift needs a human.
export function lockfileNormalizer(xtermHashes) {
  return (text) =>
    text.replace(/[0-9a-f]{64}/g, (hash) => (xtermHashes.has(hash) ? '<xterm-patch-hash>' : hash))
}

export function xtermManifestPaths(manifestText) {
  const manifest = JSON.parse(manifestText)
  return {
    generated: new Set(manifest.packages.map((entry) => entry.patch)),
    sources: new Set(manifest.packages.map((entry) => entry.sourcePatch)),
    packageKeys: manifest.packages.map((entry) => `${entry.name}@${entry.version}`)
  }
}

export function xtermLockfileHashes(lockfileTexts, packageKeys) {
  const hashes = new Set()
  for (const lockfile of lockfileTexts) {
    for (const key of packageKeys) {
      try {
        hashes.add(readLockfilePatchHash(lockfile, key))
      } catch {
        // A side without this package version simply contributes no hash.
      }
    }
  }
  return hashes
}

/**
 * Decides whether one unmerged path can be settled by taking the topic's side and letting
 * `regenerate-xterm-patches.mjs --write` rederive it. `resolution` is null when a human
 * has to resolve it.
 */
export function classifyConflict({ path: filePath, stages, text, xterm }) {
  const kind = conflictKind(stages)
  const unresolved = { path: filePath, kind, resolution: null }
  if (kind !== 'both modified' || !xterm) {
    return unresolved
  }
  if (xterm.generated.has(filePath)) {
    return { path: filePath, kind, resolution: 'topic', reason: 'generated xterm patch' }
  }
  const segments = text === undefined ? null : parseConflictSegments(text)
  if (!segments) {
    return unresolved
  }
  if (xterm.sources.has(filePath) && conflictsDifferOnlyBy(segments, normalizeSourcePatchText)) {
    return {
      path: filePath,
      kind,
      resolution: 'topic-hunks',
      reason: 'xterm source patch differs only in blob ids or hunk offsets'
    }
  }
  if (
    filePath === LOCKFILE_PATH &&
    conflictsDifferOnlyBy(segments, lockfileNormalizer(xterm.lockfileHashes))
  ) {
    return {
      path: filePath,
      kind,
      resolution: 'topic-hunks',
      reason: 'lockfile differs only in xterm patch hashes'
    }
  }
  return unresolved
}
