import { SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY } from '../../../shared/host-owned-surface-capabilities'
import type { RpcContext } from './core'

/**
 * Whether a caller may be answered with a host-owned editor tab instead of `renderer_unavailable`.
 * The in-process caller (the `orca` CLI over the runtime socket) is this build; a paired client
 * must advertise it, because released phones fall back to device screens on the refusal.
 */
export function supportsHostEditorTabs(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY) === true
  )
}
