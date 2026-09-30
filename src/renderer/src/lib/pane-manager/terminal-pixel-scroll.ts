// Orca's xterm patch (config/patches/xterm-src) adds this option; the published typings lack it.
declare module '@xterm/xterm' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- augmentation must merge into xterm's interface
  interface ITerminalOptions {
    /** Scroll the normal buffer by pixels, drawing the sub-row remainder as a WebGL offset. */
    pixelScroll?: boolean
  }
}

// Why on: only viewport gestures in the normal buffer move by pixels; TUIs, mouse-reporting apps,
// the DOM renderer and reduced motion keep whole-row stepping, and every gesture settles on a row.
export const DEFAULT_TERMINAL_PIXEL_SCROLL = true

// Mirrors PIXEL_SCROLL_SETTLE_DELAY_MS + PIXEL_SCROLL_SETTLE_DURATION_MS in the xterm patch
// (src/browser/PixelScroll.ts): how long after the last wheel event the viewport lands on a row.
export const TERMINAL_PIXEL_SCROLL_SETTLE_MS = 120 + 90

export function resolveTerminalPixelScroll(setting: boolean | undefined): boolean {
  return setting ?? DEFAULT_TERMINAL_PIXEL_SCROLL
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Any xterm Terminal; the offset itself lives on the private `_core` the patch extends. */
type PixelScrollTerminal = { readonly rows: number }

/** CSS pixels the patched renderer currently draws every row above its cell; 0 without an offset. */
export function getTerminalPixelScrollCssOffset(terminal: PixelScrollTerminal): number {
  const core: unknown = '_core' in terminal ? terminal._core : undefined
  const renderService: unknown = isRecord(core) ? core._renderService : undefined
  const offset = isRecord(renderService) ? renderService.pixelScrollOffset : undefined
  return typeof offset === 'number' && Number.isFinite(offset) && offset > 0 ? offset : 0
}
