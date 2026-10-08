// Settles re-stack and integration conflicts that need no human: paths rerere resolved from a
// recorded resolution, and xterm files `regenerate-xterm-patches.mjs --write` rederives.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cleanCheckout, showAt, tail } from './fork-stack-git.mjs'
import { parseUnmergedStages, rerereResolvedPaths } from './fork-stack-restack-plan.mjs'
import {
  LOCKFILE_PATH,
  XTERM_MANIFEST_PATH,
  classifyConflict,
  parseConflictSegments,
  resolveWithTopic,
  xtermLockfileHashes,
  xtermManifestPaths
} from './fork-stack-xterm-conflicts.mjs'
import { runProcessSync } from './script-child-process.mjs'

const REGENERATOR = 'config/scripts/regenerate-xterm-patches.mjs'

function xtermContext(git, topicRevision) {
  const merged = { generated: new Set(), sources: new Set(), packageKeys: new Set() }
  for (const revision of ['HEAD', topicRevision]) {
    const text = showAt(git, revision, XTERM_MANIFEST_PATH)
    if (text === undefined) {
      continue
    }
    try {
      const paths = xtermManifestPaths(text)
      paths.generated.forEach((value) => merged.generated.add(value))
      paths.sources.forEach((value) => merged.sources.add(value))
      paths.packageKeys.forEach((value) => merged.packageKeys.add(value))
    } catch {
      // An unreadable manifest contributes nothing; its own conflict stays unresolved.
    }
  }
  const lockfiles = ['HEAD', topicRevision]
    .map((revision) => showAt(git, revision, LOCKFILE_PATH))
    .filter((text) => text !== undefined)
  return {
    generated: merged.generated,
    sources: merged.sources,
    lockfileHashes: xtermLockfileHashes(lockfiles, [...merged.packageKeys])
  }
}

/**
 * After a failed cherry-pick or merge: what rerere settled, and either the paths a human must
 * resolve (`blocked`) or the xterm-derived paths settled by taking the topic side.
 */
export function settleConflicts(git, output, { topicRevision, regenerateXterm }) {
  const rerere = rerereResolvedPaths(output)
  const stages = parseUnmergedStages(git.run(['ls-files', '-u', '-z']).stdout)
  if (stages.size === 0) {
    return rerere.length > 0 ? { rerere } : { blocked: true, files: [], error: tail(output) }
  }
  const xterm = regenerateXterm ? xtermContext(git, topicRevision) : null
  const conflicts = [...stages].map(([filePath, fileStages]) => {
    const absolute = path.join(git.cwd, filePath)
    const text = existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined
    return classifyConflict({ path: filePath, stages: fileStages, text, xterm })
  })
  if (conflicts.some((conflict) => conflict.resolution === null)) {
    return {
      blocked: true,
      rerere,
      files: conflicts.map((conflict) => ({ path: conflict.path, kind: conflict.kind }))
    }
  }
  for (const conflict of conflicts) {
    if (conflict.resolution === 'topic') {
      git.run(['checkout', '--theirs', '--', conflict.path])
    } else {
      const absolute = path.join(git.cwd, conflict.path)
      writeFileSync(
        absolute,
        resolveWithTopic(parseConflictSegments(readFileSync(absolute, 'utf8')))
      )
    }
    git.run(['add', '--', conflict.path])
  }
  return { rerere, xtermRegenerable: conflicts.map((conflict) => conflict.path) }
}

function runRegenerator(cwd, workDir) {
  const result = runProcessSync({
    program: process.execPath,
    args: [REGENERATOR, '--write', `--work-dir=${workDir}`],
    cwd,
    timeoutMs: 90 * 60 * 1000,
    maxOutputBytes: 256 * 1024 * 1024
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}` }
}

export function regenerateXterm(git, topic, workDir) {
  const write = runRegenerator(git.cwd, workDir)
  if (!write.ok) {
    cleanCheckout(git)
    return { ok: false, log: tail(write.output) }
  }
  const lockfile = existsSync(path.join(git.cwd, LOCKFILE_PATH)) ? [LOCKFILE_PATH] : []
  git.run(['add', '--all', '--', 'config/patches', ...lockfile])
  if (git.ok(['diff', '--cached', '--quiet', 'HEAD'])) {
    return { ok: true }
  }
  const subject = `chore(xterm): regenerate patches after re-stacking ${topic.name}`
  git.run(['commit', '--quiet', '--no-verify', '-F', '-'], {
    input: `${subject}\n\nFork-Topic: ${topic.name}\n`
  })
  return { ok: true, step: { sha: git.text(['rev-parse', 'HEAD']), subject, action: 'generated' } }
}

/**
 * Cherry-picks `<base>..<ref>` onto `ontoSha`, dropping commits upstream already has. Stops at
 * the first conflict a recorded resolution cannot settle and reports exactly that commit.
 */
