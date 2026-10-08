// Single reading of the default-on setting, matching resolveTerminalAdoptAppCaretEnabled.
export function resolveTerminalInputSelectionEditingEnabled(
  value: boolean | null | undefined
): boolean {
  return value !== false
}
