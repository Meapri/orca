// Single reading of the default-on setting, matching resolveTerminalInlineImagesEnabled.
export function resolveTerminalCursorAnimationEnabled(value: boolean | null | undefined): boolean {
  return value !== false
}
