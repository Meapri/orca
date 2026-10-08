import { getDaemonHistoryDir } from './daemon-launch-paths'
import { getDaemonProvider } from './daemon-provider-state'
import type { DaemonProvider } from './daemon-provider-routing'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { collectExitedTerminalHistory } from './terminal-history-exited-retention'
import {
  resolveExitedHistoryRetentionPolicy,
  type ExitedHistoryRetentionPolicy
} from './terminal-history-exited-retention-policy'

// Why delayed: startup reattach and cold restore read the same tree; stay out of their way.
const FIRST_SWEEP_DELAY_MS = 2 * 60 * 1000
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

let timer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> | null = null

function historyWriterIsOpen(provider: DaemonProvider | null, sessionId: string): boolean {
  if (!provider) {
    return false
  }
  const adapters =
    provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider
      ? provider.getAllAdapters()
      : [provider]
  return adapters.some((adapter) => adapter.getHistoryManager()?.hasWriter(sessionId) === true)
}

async function sweepOnce(policy: ExitedHistoryRetentionPolicy): Promise<void> {
  const result = await collectExitedTerminalHistory({
    basePath: getDaemonHistoryDir(),
    policy,
    isSessionInUse: (sessionId) => historyWriterIsOpen(getDaemonProvider(), sessionId)
  })
  if (result.collected > 0 || result.unverifiable > 0) {
    console.log(
      `[history:retention] scanned=${result.scanned} exited=${result.exited} ` +
        `collected=${result.collected} freedBytes=${result.collectedBytes} ` +
        `keptUnverifiable=${result.unverifiable}`
    )
  }
}

/** Arm the periodic exited-history sweep. Idempotent; a second call keeps the first schedule. */
export function scheduleExitedTerminalHistoryRetention(env: NodeJS.ProcessEnv = process.env): void {
  if (timer !== null) {
    return
  }
  const { policy, warnings } = resolveExitedHistoryRetentionPolicy(env)
  for (const warning of warnings) {
    console.warn(`[history:retention] ${warning}`)
  }
  if (policy.maxAgeMs === null && policy.maxTotalBytes === null) {
    return
  }
  const arm = (delayMs: number): void => {
    timer = setTimeout(() => {
      inFlight ??= sweepOnce(policy)
        .catch((error: unknown) => {
          console.warn(
            '[history:retention] sweep failed:',
            error instanceof Error ? error.message : String(error)
          )
        })
        .finally(() => {
          inFlight = null
        })
      arm(SWEEP_INTERVAL_MS)
    }, delayMs)
    timer.unref?.()
  }
  arm(FIRST_SWEEP_DELAY_MS)
}

export function cancelExitedTerminalHistoryRetention(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}
