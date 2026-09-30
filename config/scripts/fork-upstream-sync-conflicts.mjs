// Pure decisions for the fork's upstream sync: branch naming and which merge conflicts the
// xterm generator can settle. Git I/O lives in fork-upstream-sync.mjs.
import { readLockfilePatchHash } from './regenerate-xterm-patches.mjs'

export const XTERM_MANIFEST_PATH = 'config/patches/xterm-upstream.json'
export const LOCKFILE_PATH = 'pnpm-lock.yaml'

export function syncBranchBaseName(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Sync date must be YYYY-MM-DD, got ${JSON.stringify(date)}`)
  }
  return `sync/upstream-${date}`
}

/** Never reuse a pushed name: a rerun on the same day gets `-2`, `-3`, ... */
export function pickSyncBranchName(date, existingBranches) {
  const base = syncBranchBaseName(date)
  const taken = new Set(existingBranches)
  if (!taken.has(base)) {
    return base
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) {
      return candidate
    }
  }
}

/** `git ls-remote --heads` output to bare branch names. */
export function parseRemoteHeads(output) {
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((ref) => ref?.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
}

/** `git ls-files -u -z` output to a map of path -> sorted stage numbers. */
export function parseUnmergedStages(output) {
  const stages = new Map()
  for (const record of output.split('\0').filter(Boolean)) {
    const match = /^\d+ [0-9a-f]+ ([123])\t(.+)$/s.exec(record)
    if (!match) {
      throw new Error(`Unrecognised git ls-files -u record: ${JSON.stringify(record)}`)
    }
    const [, stage, filePath] = match
    stages.set(filePath, [...(stages.get(filePath) ?? []), Number(stage)].sort())
  }
  return stages
}

export function conflictKind(stages) {
  const key = stages.join('')
  if (key === '123') {
    return 'both modified'
  }
  if (key === '23') {
    return 'both added'
  }
  if (key === '12') {
    return 'deleted by upstream'
  }
  if (key === '13') {
    return 'deleted by fork'
  }
  return `stages ${key}`
}

/**
 * Splits a file that holds `merge`-style conflict markers (no diff3 base section) into
 * plain text and conflict segments. Returns null when the markers are malformed.
 */
export function parseConflictSegments(text) {
  const segments = []
  let state = 'plain'
  let current = { ours: [], theirs: [] }
  let plain = []
  for (const line of text.split(/(?<=\n)/)) {
    if (state === 'plain' && line.startsWith('<<<<<<< ')) {
      segments.push({ plain: plain.join('') })
      plain = []
      state = 'ours'
    } else if (state === 'ours' && /^=======\r?\n?$/.test(line)) {
      state = 'theirs'
    } else if (state === 'theirs' && line.startsWith('>>>>>>> ')) {
      segments.push({ ours: current.ours.join(''), theirs: current.theirs.join('') })
      current = { ours: [], theirs: [] }
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

export function resolveWithOurs(segments) {
  return segments.map((segment) => segment.plain ?? segment.ours).join('')
}

/** True when every conflict hunk is identical on both sides once `normalize` is applied. */
export function conflictsDifferOnlyBy(segments, normalize) {
  const conflicts = segments.filter((segment) => segment.plain === undefined)
  return (
    conflicts.length > 0 &&
    conflicts.every((segment) => normalize(segment.ours) === normalize(segment.theirs))
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
 * Decides whether one unmerged path can be settled by taking the fork's side and letting
 * `regenerate-xterm-patches.mjs --write` rederive it. `resolution` is null when a human
 * has to merge it.
 */
export function classifyConflict({ path: filePath, stages, text, xterm }) {
  const kind = conflictKind(stages)
  const unresolved = { path: filePath, kind, resolution: null }
  if (kind !== 'both modified' || !xterm) {
    return unresolved
  }
  if (xterm.generated.has(filePath)) {
    return { path: filePath, kind, resolution: 'ours', reason: 'generated xterm patch' }
  }
  const segments = text === undefined ? null : parseConflictSegments(text)
  if (!segments) {
    return unresolved
  }
  if (xterm.sources.has(filePath) && conflictsDifferOnlyBy(segments, normalizeSourcePatchText)) {
    return {
      path: filePath,
      kind,
      resolution: 'ours-hunks',
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
      resolution: 'ours-hunks',
      reason: 'lockfile differs only in xterm patch hashes'
    }
  }
  return unresolved
}
