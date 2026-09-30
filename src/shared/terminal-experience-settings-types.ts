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
  /** Draw the terminal cursor at the lone inverse cell a TUI paints as its caret while hiding the cursor. Undefined means on. */
  terminalAdoptAppCaret?: boolean
  /** Animates wheel-notch, Shift+PageUp/PageDown and jump-to-latest scrolling in the scrollback; reduced-motion always wins. */
  terminalSmoothScroll: boolean
  /** Plain click on the input line moves the cursor via arrow keys; 'shell-prompt' needs OSC 133 prompt marks. Optional for older profiles. */
  terminalClickToMoveCursor?: 'shell-prompt' | 'input-line' | 'off'
  /** GUI text-field editing of an input-line selection (replace, delete, Shift+Arrow, Cmd/Ctrl+Z). Undefined means on. */
  terminalInputSelectionEditing?: boolean
  /** Terminal composer: press Enter after pasting the composed text. Optional for older profiles; default on. */
  terminalComposerSubmitOnSend?: boolean
  /** Gutter and scrollbar ticks for prompt / submitted-input marks (OSC 133); navigation works either way. Default on. */
  terminalCommandMarks?: boolean
}
