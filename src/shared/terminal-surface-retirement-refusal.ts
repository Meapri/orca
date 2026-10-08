/**
 * The host's answer to a create/adopt that names a terminal tab or pane a committed close retired.
 *
 * Why the `terminal_gone` prefix: every released remote client already reads a message containing
 * `terminal_gone` as lifecycle evidence and stops retrying the pane, so an old client that asks to
 * resurrect a closed tab degrades to "that terminal ended" instead of looping or erroring loudly.
 */
export const TERMINAL_SURFACE_RETIRED_ERROR = 'terminal_gone_surface_retired'

export function isTerminalSurfaceRetiredError(message: string): boolean {
  return message.includes(TERMINAL_SURFACE_RETIRED_ERROR)
}
