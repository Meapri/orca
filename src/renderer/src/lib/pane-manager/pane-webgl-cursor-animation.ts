import type { WebglAddon } from '@xterm/addon-webgl'

declare module '@xterm/addon-webgl' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging into the addon class needs an interface.
  interface WebglAddon {
    /** Added by Orca's addon-webgl source patch; the published typings cannot declare it.
     *  Optional so a test double or an unpatched addon degrades to the upstream cursor. */
    setCursorAnimation?(enabled: boolean): void
  }
}

// Why module state: the setting is app-wide, and a WebGL addon can attach long after it was applied.
// Starts off so a pane attached before the first settings apply renders the upstream cursor.
let cursorAnimationEnabled = false
const liveAddons = new Set<WebglAddon>()

export function setTerminalCursorAnimationEnabled(enabled: boolean): void {
  if (cursorAnimationEnabled === enabled) {
    return
  }
  cursorAnimationEnabled = enabled
  for (const addon of liveAddons) {
    addon.setCursorAnimation?.(enabled)
  }
}

export function trackWebglCursorAnimation(addon: WebglAddon): void {
  liveAddons.add(addon)
  addon.setCursorAnimation?.(cursorAnimationEnabled)
}

export function untrackWebglCursorAnimation(addon: WebglAddon): void {
  liveAddons.delete(addon)
}
