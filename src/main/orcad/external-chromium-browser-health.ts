import { BrowserError } from '../browser/browser-error'
import { AgentBrowserDriverError } from './external-chromium-browser-session'
import { BrowserProviderRestartBudget } from './browser-provider-restart-budget'

// Why two: one failed driver call can be a transient spawn hiccup; two in a row is a lost browser.
const DRIVER_FAILURES_BEFORE_CRASH = 2

/** A failure of the agent-browser driver or the Chromium it owns, not of one page command. */
export function isBrowserDriverFailure(error: unknown): boolean {
  return !(error instanceof BrowserError) || error instanceof AgentBrowserDriverError
}

/**
 * Crash bookkeeping for the external Chromium provider. The browser lives in its own process
 * tree, so a crash never reaches orcad; what it must not do is leave orcad advertising a dead
 * browser or relaunching one in a tight loop.
 */
export class ExternalChromiumBrowserHealth extends BrowserProviderRestartBudget {
  private consecutiveDriverFailures = 0

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
    this.recordCrash(error instanceof Error ? error.message : String(error))
    return true
  }
}
