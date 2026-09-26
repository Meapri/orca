/**
 * Bounds on the tabs an agent can keep open in orcad's browser provider (external Chromium or
 * the installed Electron sidecar).
 *
 * Every tab is a renderer process (~100–300 MB). Agents open tabs and rarely close them, and a
 * headless host has no human to notice, so without a cap a long-running host accumulates
 * renderers until the kernel OOM-kills something (#14552).
 */

export const DEFAULT_BROWSER_MAX_TABS = 8
export const DEFAULT_BROWSER_TAB_IDLE_MS = 30 * 60 * 1000

export const BROWSER_MAX_TABS_ENV = 'ORCA_BROWSER_MAX_TABS'
export const BROWSER_TAB_IDLE_MINUTES_ENV = 'ORCA_BROWSER_TAB_IDLE_MINUTES'

export type BrowserTabLimits = {
  /** Most tabs open at once; creating one more reclaims the least recently used. */
  maxTabs: number
  /** Tabs untouched this long are reclaimed; null disables idle reclamation. */
  idleMs: number | null
}

function parsePositiveInteger(raw: string | undefined): number | null {
  const value = raw?.trim()
  if (!value || !/^\d+$/.test(value)) {
    return null
  }
  const parsed = Number(value)
  return parsed > 0 ? parsed : null
}

export function resolveBrowserTabLimits(env: NodeJS.ProcessEnv = process.env): BrowserTabLimits {
  const maxTabs = parsePositiveInteger(env[BROWSER_MAX_TABS_ENV]) ?? DEFAULT_BROWSER_MAX_TABS
  const idleRaw = env[BROWSER_TAB_IDLE_MINUTES_ENV]?.trim().toLowerCase()
  if (idleRaw === 'off') {
    return { maxTabs, idleMs: null }
  }
  const idleMinutes = parsePositiveInteger(idleRaw)
  return { maxTabs, idleMs: idleMinutes ? idleMinutes * 60 * 1000 : DEFAULT_BROWSER_TAB_IDLE_MS }
}
