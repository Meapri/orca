/**
 * What this process could prove about the terminal resource limits an operator asked for,
 * read back by `status.get` as a degradation. Silence means "none requested or all applied".
 */

import {
  TERMINAL_RESOURCE_LIMITS_DEGRADATION_CAPABILITY,
  TERMINAL_RESOURCE_LIMITS_UNAVAILABLE_CODE,
  type RuntimeDegradation,
  type RuntimeTerminalResourceLimitsReason as TerminalResourceLimitsUnavailableReason
} from '../../shared/runtime-types'

export type TerminalResourceLimitsShortfall = {
  reason: TerminalResourceLimitsUnavailableReason
  /** The `Name=value` assignments that are not in force. */
  limits: string[]
  detail?: string
}

let shortfall: TerminalResourceLimitsShortfall | null = null

export function setTerminalResourceLimitsShortfall(
  next: TerminalResourceLimitsShortfall | null
): void {
  shortfall = next
}

export function terminalResourceLimitsShortfall(): TerminalResourceLimitsShortfall | null {
  return shortfall
}

const SHORTFALL_MESSAGES: Record<TerminalResourceLimitsUnavailableReason, string> = {
  systemd_scope_unavailable:
    'Terminal resource limits are configured but not enforced: this host has no reachable systemd user manager, so the terminal daemon runs without its own cgroup scope.',
  scope_properties_rejected:
    "Terminal resource limits are configured but not enforced: systemd rejected them when the terminal daemon's scope was created, so it runs in a scope without limits.",
  set_property_failed:
    "Terminal resource limits are configured but could not be applied to the running terminal daemon's scope."
}

/** The `status.get` degradation for the recorded shortfall, or null when nothing is missing. */
export function terminalResourceLimitsDegradation(): RuntimeDegradation | null {
  if (!shortfall) {
    return null
  }
  return {
    code: TERMINAL_RESOURCE_LIMITS_UNAVAILABLE_CODE,
    capability: TERMINAL_RESOURCE_LIMITS_DEGRADATION_CAPABILITY,
    message: `${SHORTFALL_MESSAGES[shortfall.reason]} (${shortfall.limits.join(', ')})`,
    reason: shortfall.reason,
    ...(shortfall.detail ? { detail: shortfall.detail } : {})
  }
}
