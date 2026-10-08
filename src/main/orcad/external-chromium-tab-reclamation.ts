import type { ExternalChromiumBrowserSession } from './external-chromium-browser-session'
import type { ExternalChromiumPageRecord } from './external-chromium-tab-projection'
import type { ExternalChromiumTabRegistry } from './external-chromium-tab-registry'
import type { BrowserTabLimits } from './browser-tab-limits'
import { BrowserTabReclaimer, type TabReclaimReason } from './browser-tab-reclaimer'

// Why short: releasing a tab must not hold the command queue for the 90s command budget.
const RELEASE_TIMEOUT_MS = 5_000

export type ExternalChromiumTabReclaimer = BrowserTabReclaimer<ExternalChromiumPageRecord>

async function parkSpareTab(
  session: ExternalChromiumBrowserSession,
  tabs: ExternalChromiumTabRegistry
): Promise<void> {
  const created = await session.run(['tab', 'new', 'about:blank'], RELEASE_TIMEOUT_MS)
  if (
    typeof created === 'object' &&
    created !== null &&
    'tabId' in created &&
    typeof created.tabId === 'string'
  ) {
    tabs.parkAgentPage(created.tabId)
  }
}

/**
 * agent-browser needs one page to stay attached, so the last tab is blanked rather than closed;
 * a wedged last tab cannot be blanked, so a spare is opened before it is closed.
 */
async function releaseExternalChromiumTab(
  session: ExternalChromiumBrowserSession,
  tabs: ExternalChromiumTabRegistry,
  page: ExternalChromiumPageRecord,
  reason: TabReclaimReason
): Promise<void> {
  const isLastTab = tabs.listPages().length === 1 && !tabs.hasParkedBlankPage()
  if (isLastTab && reason !== 'unresponsive') {
    await session.run(['tab', page.agentPageId], RELEASE_TIMEOUT_MS)
    await session.run(['open', 'about:blank'], RELEASE_TIMEOUT_MS)
    tabs.parkBlankPage(page)
    return
  }
  if (isLastTab) {
    await parkSpareTab(session, tabs)
  }
  await session.run(['tab', 'close', page.agentPageId], RELEASE_TIMEOUT_MS)
  tabs.forgetPage(page)
}

export function createExternalChromiumTabReclaimer(
  session: ExternalChromiumBrowserSession,
  tabs: ExternalChromiumTabRegistry,
  limits: BrowserTabLimits,
  now: () => number = Date.now
): ExternalChromiumTabReclaimer {
  return new BrowserTabReclaimer(
    () => tabs.listPages(),
    (page, reason) => releaseExternalChromiumTab(session, tabs, page, reason),
    (page) => tabs.forgetPage(page),
    limits,
    now
  )
}

/** Forget every page after the browser itself was lost; its tabs no longer exist. */
export function forgetAllExternalChromiumTabs(
  tabs: ExternalChromiumTabRegistry,
  reclaimer: ExternalChromiumTabReclaimer
): void {
  const pages = tabs.listPages()
  tabs.clear()
  for (const page of pages) {
    reclaimer.forgotten(page)
  }
}

/** Drop pages whose Chromium tab vanished (renderer crash reload, browser relaunch). */
export function forgetVanishedExternalChromiumTabs(
  tabs: ExternalChromiumTabRegistry,
  reclaimer: ExternalChromiumTabReclaimer,
  liveAgentPageIds: ReadonlySet<string>
): void {
  for (const page of tabs.listPages()) {
    if (!liveAgentPageIds.has(page.agentPageId)) {
      tabs.forgetPage(page)
      reclaimer.forgotten(page)
    }
  }
}
