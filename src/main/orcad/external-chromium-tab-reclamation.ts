import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import type { ExternalChromiumBrowserSession } from './external-chromium-browser-session'
import type { ExternalChromiumPageRecord } from './external-chromium-tab-projection'
import type { ExternalChromiumTabLimits } from './external-chromium-tab-limits'
import type { ExternalChromiumTabRegistry } from './external-chromium-tab-registry'

// Why short: releasing a tab must not hold the command queue for the 90s command budget.
const RELEASE_TIMEOUT_MS = 5_000

export type TabReclaimReason = 'capacity' | 'idle' | 'unresponsive'

/**
 * Least-recently-used and idle reclamation for orcad's external Chromium tabs.
 *
 * A reclaimed tab is closed in Chromium and forgotten, so its renderer's memory is returned;
 * a later command naming it fails with `browser_tab_closed` like any closed tab. The last tab
 * is blanked instead of closed, because the driver needs one page to stay attached.
 */
export class ExternalChromiumTabReclaimer {
  private readonly lastUsedAtByPageId = new Map<string, number>()
  private host: RuntimeBrowserCommandHost | null = null
  private reclaimedCount = 0

  constructor(
    private readonly session: ExternalChromiumBrowserSession,
    private readonly tabs: ExternalChromiumTabRegistry,
    private readonly limits: ExternalChromiumTabLimits,
    private readonly now: () => number = Date.now
  ) {}

  /** Remember the runtime so timer-driven reclamation can republish tab lists. */
  noteHost(host: RuntimeBrowserCommandHost): void {
    this.host = host
  }

  touch(page: ExternalChromiumPageRecord): void {
    this.lastUsedAtByPageId.set(page.publicPageId, this.now())
  }

  touchById(publicPageId: string): void {
    if (this.tabs.hasPage(publicPageId)) {
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
      await this.release(page, 'capacity')
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
      await this.release(page, 'idle')
    }
  }

  async reclaimUnresponsive(page: ExternalChromiumPageRecord): Promise<void> {
    await this.release(page, 'unresponsive')
  }

  /** Forget every page after the browser itself was lost; its tabs no longer exist. */
  forgetAll(): void {
    const worktreeIds = new Set(this.tabs.listPages().flatMap((page) => page.worktreeId ?? []))
    this.tabs.clear()
    this.lastUsedAtByPageId.clear()
    for (const worktreeId of worktreeIds) {
      this.host?.notifyHeadlessBrowserSessionTabsChanged?.(worktreeId)
    }
  }

  /** Drop pages whose Chromium tab vanished (renderer crash reload, browser relaunch). */
  forgetVanished(liveAgentPageIds: ReadonlySet<string>): void {
    for (const page of this.tabs.listPages()) {
      if (!liveAgentPageIds.has(page.agentPageId)) {
        this.forget(page)
      }
    }
  }

  private lastUsedAt(page: ExternalChromiumPageRecord): number {
    // Why default to now: a page registered before its first touch is new, not idle.
    const at = this.lastUsedAtByPageId.get(page.publicPageId)
    if (at === undefined) {
      const now = this.now()
      this.lastUsedAtByPageId.set(page.publicPageId, now)
      return now
    }
    return at
  }

  private pagesOldestFirst(): ExternalChromiumPageRecord[] {
    return this.tabs
      .listPages()
      .map((page) => ({ page, at: this.lastUsedAt(page) }))
      .sort((left, right) => left.at - right.at)
      .map(({ page }) => page)
  }

  private async release(page: ExternalChromiumPageRecord, reason: TabReclaimReason): Promise<void> {
    const isLastTab = this.tabs.listPages().length === 1 && !this.tabs.hasParkedBlankPage()
    try {
      if (isLastTab && reason !== 'unresponsive') {
        await this.session.run(['tab', page.agentPageId], RELEASE_TIMEOUT_MS)
        await this.session.run(['open', 'about:blank'], RELEASE_TIMEOUT_MS)
        this.tabs.parkBlankPage(page)
        this.lastUsedAtByPageId.delete(page.publicPageId)
        this.announce(page)
      } else {
        if (isLastTab) {
          // A wedged last tab cannot be blanked; open a spare first so one page stays attached.
          await this.parkSpareTab()
        }
        await this.session.run(['tab', 'close', page.agentPageId], RELEASE_TIMEOUT_MS)
        this.forget(page)
      }
    } catch {
      // Why forget anyway: a tab that cannot be closed or blanked is not usable either.
      this.forget(page)
    }
    this.reclaimedCount++
    console.warn(`[orcad] Reclaimed browser tab ${page.publicPageId} (${reason}).`)
  }

  private async parkSpareTab(): Promise<void> {
    const created = await this.session.run(['tab', 'new', 'about:blank'], RELEASE_TIMEOUT_MS)
    if (
      typeof created === 'object' &&
      created !== null &&
      'tabId' in created &&
      typeof created.tabId === 'string'
    ) {
      this.tabs.parkAgentPage(created.tabId)
    }
  }

  private forget(page: ExternalChromiumPageRecord): void {
    this.tabs.forgetPage(page)
    this.lastUsedAtByPageId.delete(page.publicPageId)
    this.announce(page)
  }

  private announce(page: ExternalChromiumPageRecord): void {
    if (page.worktreeId) {
      this.host?.notifyHeadlessBrowserSessionTabsChanged?.(page.worktreeId)
    }
  }
}
