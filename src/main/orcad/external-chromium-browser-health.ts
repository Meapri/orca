import { BrowserError } from '../browser/browser-error'
import { AgentBrowserDriverError } from './external-chromium-browser-session'

// Why two: one failed driver call can be a transient spawn hiccup; two in a row is a lost browser.
const DRIVER_FAILURES_BEFORE_CRASH = 2
const MIN_RESTART_GAP_MS = 5_000
// Same containment the terminal daemon uses: a host that cannot keep Chromium up stops
// relaunching it in a loop, and the sliding window lets a repaired host recover on its own.
const RESTART_WINDOW_MS = 10 * 60 * 1000
const MAX_RESTARTS_PER_WINDOW = 5

/** A failure of the agent-browser driver or the Chromium it owns, not of one page command. */
export function isBrowserDriverFailure(error: unknown): boolean {
  return !(error instanceof BrowserError) || error instanceof AgentBrowserDriverError
}

/**
 * Crash bookkeeping for the external Chromium provider. The browser lives in its own process
 * tree, so a crash never reaches orcad; what it must not do is leave orcad advertising a dead
 * browser or relaunching one in a tight loop.
 */
export class ExternalChromiumBrowserHealth {
  private consecutiveDriverFailures = 0
  private restartAttempts: number[] = []
  private crashes = 0
  private lastCrashDetail: string | null = null

  constructor(private readonly now: () => number = Date.now) {}

  recordSuccess(): void {
    this.consecutiveDriverFailures = 0
  }

  /** True when this failure means the browser is gone and must be relaunched. */
  recordDriverFailure(error: unknown): boolean {
    this.consecutiveDriverFailures++
    if (this.consecutiveDriverFailures < DRIVER_FAILURES_BEFORE_CRASH) {
      return false
    }
    this.consecutiveDriverFailures = 0
    this.crashes++
    this.lastCrashDetail = error instanceof Error ? error.message : String(error)
    return true
  }

  /** Records a crash observed directly (e.g. the maintenance probe), not through failures. */
  recordCrash(detail: string): void {
    this.crashes++
    this.lastCrashDetail = detail
  }

  /** Claims a restart slot, or returns false while in backoff or past the crash-loop cap. */
  tryBeginRestart(): boolean {
    const now = this.now()
    this.restartAttempts = this.restartAttempts.filter((at) => now - at < RESTART_WINDOW_MS)
    const last = this.restartAttempts.at(-1)
    if (last !== undefined && now - last < MIN_RESTART_GAP_MS) {
      return false
    }
    if (this.restartAttempts.length >= MAX_RESTARTS_PER_WINDOW) {
      return false
    }
    this.restartAttempts.push(now)
    return true
  }

  crashCount(): number {
    return this.crashes
  }

  lastCrash(): string | null {
    return this.lastCrashDetail
  }
}
