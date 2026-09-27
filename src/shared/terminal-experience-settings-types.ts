// Terminal input, rendering and navigation preferences, kept apart so GlobalSettings stays within max-lines.
export type TerminalExperienceSettings = {
  /** Comma-separated font stack tried after `terminalFontFamily` and before Orca's built-in fallbacks. */
  terminalFontFallbackFamily?: string
  /** Draw the IME preedit as terminal cells, not xterm's DOM overlay (the fallback); undefined means on. */
  terminalImePreeditInGrid?: boolean
  /** Enlarge CJK fallback glyphs toward their two cells and center wide glyphs; undefined means on. */
  terminalFitWideGlyphs?: boolean
  /** GPU cursor glide and blink fade (WebGL renderer only). Undefined means on. */
  terminalCursorAnimation?: boolean
  /** Animates wheel-notch, Shift+PageUp/PageDown and jump-to-latest scrolling in the scrollback; reduced-motion always wins. */
  terminalSmoothScroll: boolean
  /** Plain click on the input line moves the cursor via arrow keys; 'shell-prompt' needs OSC 133 prompt marks. Optional for older profiles. */
  terminalClickToMoveCursor?: 'shell-prompt' | 'input-line' | 'off'
  /** Terminal composer: press Enter after pasting the composed text. Optional for older profiles; default on. */
  terminalComposerSubmitOnSend?: boolean
  /** Gutter and scrollbar ticks for prompt / submitted-input marks (OSC 133); navigation works either way. Default on. */
  terminalCommandMarks?: boolean
}
