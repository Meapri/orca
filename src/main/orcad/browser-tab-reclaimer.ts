import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import type { BrowserTabLimits } from './browser-tab-limits'

export type TabReclaimReason = 'capacity' | 'idle' | 'unresponsive'

export type ReclaimableBrowserTab = {
  publicPageId: string
  worktreeId?: string
}

/** Closes one tab in the provider and drops it from the provider's registry; may throw. */
export type BrowserTabRelease<P extends ReclaimableBrowserTab> = (
  page: P,
  reason: TabReclaimReason
) => Promise<void>

/**
 * Least-recently-used and idle reclamation for orcad's headless browser tabs (#14552).
 *
 * A reclaimed tab is closed and forgotten, so its renderer's memory is returned; a later command
 * naming it fails like any closed tab. The provider decides what "close" means (`release`).
 */
export class BrowserTabReclaimer<P extends ReclaimableBrowserTab> {
  private readonly lastUsedAtByPageId = new Map<string, number>()
  private host: RuntimeBrowserCommandHost | null = null
  private reclaimedCount = 0

  constructor(
    private readonly listPages: () => P[],
    private readonly release: BrowserTabRelease<P>,
    private readonly forgetPage: (page: P) => void,
    private readonly limits: BrowserTabLimits,
    private readonly now: () => number = Date.now
  ) {}

  /** Remember the runtime so timer-driven reclamation can republish tab lists. */
  noteHost(host: RuntimeBrowserCommandHost): void {
    this.host = host
  }

  touch(publicPageId: string): void {
    if (this.listPages().some((page) => page.publicPageId === publicPageId)) {
      this.lastUsedAtByPageId.set(publicPageId, this.now())
    }
  }

  totalReclaimed(): number {
    return this.reclaimedCount
  }

  /** Close least-recently-used tabs until one more fits under the cap. */
  async makeRoomForNewTab(): Promise<void> {
    const pages = this.pagesOldestFirst()
    const excess = pages.length + 1 - this.limits.maxTabs
    for (const page of pages.slice(0, Math.max(0, excess))) {
      await this.reclaim(page, 'capacity')
    }
  }

  async reclaimIdle(): Promise<void> {
    const idleMs = this.limits.idleMs
    if (idleMs === null) {
      return
    }
    const now = this.now()
    for (const page of this.pagesOldestFirst()) {
      if (now - this.lastUsedAt(page) < idleMs) {
        break
      }
      await this.reclaim(page, 'idle')
    }
  }

  async reclaim(page: P, reason: TabReclaimReason): Promise<void> {
    try {
      await this.release(page, reason)
    } catch {
      // Why forget anyway: a tab that cannot be closed is not usable either.
      this.forgetPage(page)
    }
    this.reclaimedCount++
    console.warn(`[orcad] Reclaimed browser tab ${page.publicPageId} (${reason}).`)
    this.forgotten(page)
  }

  /** Drop usage for a page the provider lost on its own (renderer crash, browser relaunch). */
  forgotten(page: P): void {
    this.lastUsedAtByPageId.delete(page.publicPageId)
    if (page.worktreeId) {
      this.host?.notifyHeadlessBrowserSessionTabsChanged?.(page.worktreeId)
    }
  }

  private lastUsedAt(page: P): number {
    // Why default to now: a page registered before its first touch is new, not idle.
    const at = this.lastUsedAtByPageId.get(page.publicPageId)
    if (at === undefined) {
      const now = this.now()
      this.lastUsedAtByPageId.set(page.publicPageId, now)
      return now
    }
    return at
  }

  private pagesOldestFirst(): P[] {
    return this.listPages()
      .map((page) => ({ page, at: this.lastUsedAt(page) }))
      .sort((left, right) => left.at - right.at)
      .map(({ page }) => page)
  }
}
