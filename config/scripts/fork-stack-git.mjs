// Thin git runner for the fork stack sync, through the repository's child-process wrapper.
import { parseCommitRecords } from './fork-stack-restack-plan.mjs'
import { runProcessSync } from './script-child-process.mjs'

// rerere replays recorded resolutions; merge-style markers keep conflict parsing two-sided.
export const PICK_CONFIG = [
  '-c',
  'rerere.enabled=true',
  '-c',
  'rerere.autoupdate=true',
  '-c',
  'merge.conflictStyle=merge'
]
export const LOG_TAIL_LINES = 80

export function createGit(cwd) {
  const run = (args, { allowFailure = false, input } = {}) => {
    const result = runProcessSync({
      program: 'git',
      args,
      cwd,
      // runProcessSync spawns with encoding 'buffer', which rejects a string input.
      input: input === undefined ? undefined : Buffer.from(input, 'utf8'),
      timeoutMs: 30 * 60 * 1000,
      maxOutputBytes: 256 * 1024 * 1024
    })
    if (!allowFailure && result.code !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${result.code}):\n${result.stderr}`)
    }
    return result
  }
  return {
    cwd,
    run,
    text: (args, options) => run(args, options).stdout.trim(),
    ok: (args) => run(args, { allowFailure: true }).code === 0
  }
}

export const short = (sha) => sha.slice(0, 12)

export function tail(text, lines = LOG_TAIL_LINES) {
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

export function resolveCommit(git, revision) {
  const result = git.run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], {
    allowFailure: true
  })
  return result.code === 0 ? result.stdout.trim() : null
}

export function showAt(git, revision, filePath) {
  const result = git.run(['show', `${revision}:${filePath}`], { allowFailure: true })
  return result.code === 0 ? result.stdout : undefined
}

export function commitRecords(git, revisions) {
  return parseCommitRecords(
    git.run(['log', '--reverse', '--topo-order', '--format=%H%x1f%s%x1f%B%x1e', ...revisions])
      .stdout
  )
}

export function cleanCheckout(git) {
  git.run(['cherry-pick', '--abort'], { allowFailure: true })
  git.run(['merge', '--abort'], { allowFailure: true })
  git.run(['reset', '--quiet', '--hard', 'HEAD'])
}

/** Upstream PR states for every `Upstream-PR:` trailer in the manifest's stacks (one gh call). */
