const MIN_RESTART_GAP_MS = 5_000
// Same containment the terminal daemon uses: a host that cannot keep a browser up stops
// relaunching it in a loop, and the sliding window lets a repaired host recover on its own.
const RESTART_WINDOW_MS = 10 * 60 * 1000
const MAX_RESTARTS_PER_WINDOW = 5

/** Crash count and relaunch backoff for an orcad browser provider's own process tree. */
export class BrowserProviderRestartBudget {
  private restartAttempts: number[] = []
  private crashes = 0
  private lastCrashDetail: string | null = null

  constructor(protected readonly now: () => number = Date.now) {}

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
