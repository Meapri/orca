// Single reading of the default-on setting, matching resolveTerminalCursorAnimationEnabled.
export function resolveTerminalAdoptAppCaretEnabled(value: boolean | null | undefined): boolean {
  return value !== false
}
