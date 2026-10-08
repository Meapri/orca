import { sweepProcessIdentities, type ProcessIdentityRow } from '../opencode/opencode-client-sweep'

const TERM_GRACE_MS = 3_000
const EXIT_POLL_MS = 100

export type ExternalChromiumOrphanReaperDeps = {
  sweep?: () => Promise<ProcessIdentityRow[]>
  signal?: (pid: number, signal: NodeJS.Signals) => void
  isAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  graceMs?: number
}

export type ExternalChromiumReapOutcome = {
  signalled: number[]
  killed: number[]
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/** True when this command line runs Chromium on exactly `profilePath`, not a sibling prefix. */
export function commandLineUsesChromiumProfile(commandLine: string, profilePath: string): boolean {
  const marker = `--user-data-dir=${profilePath}`
  let index = commandLine.indexOf(marker)
  while (index !== -1) {
    const next = commandLine.charAt(index + marker.length)
    if (next === '' || next === ' ' || next === '"') {
      return true
    }
    index = commandLine.indexOf(marker, index + 1)
  }
  return false
}

/**
 * Ends every Chromium process still running on this orcad's private profile once its
 * agent-browser driver can no longer close it (the driver was killed and the tree re-parented).
 * The profile lives under orcad's own state root, so a match is ownership proof; a live driver
 * has already closed its browser by the time this runs, so nothing wanted is left to match.
 */
export async function reapExternalChromiumProfileProcesses(
  profilePath: string,
  deps: ExternalChromiumOrphanReaperDeps = {}
): Promise<ExternalChromiumReapOutcome> {
  const sweep = deps.sweep ?? (() => sweepProcessIdentities())
  const signal = deps.signal ?? ((pid, name) => process.kill(pid, name))
  const isAlive = deps.isAlive ?? defaultIsAlive
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const graceMs = deps.graceMs ?? TERM_GRACE_MS
  const pids = (await sweep())
    .filter(
      (row) =>
        row.pid !== process.pid && commandLineUsesChromiumProfile(row.argv.join(' '), profilePath)
    )
    .map((row) => row.pid)
  const signalled: number[] = []
  for (const pid of pids) {
    try {
      signal(pid, 'SIGTERM')
      signalled.push(pid)
    } catch {
      // Already gone between the sweep and the signal.
    }
  }
  for (let waited = 0; waited < graceMs && signalled.some(isAlive); waited += EXIT_POLL_MS) {
    await sleep(EXIT_POLL_MS)
  }
  const killed: number[] = []
  for (const pid of signalled.filter(isAlive)) {
    try {
      signal(pid, 'SIGKILL')
      killed.push(pid)
    } catch {
      // Exited after the last poll.
    }
  }
  return { signalled, killed }
}
