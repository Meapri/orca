/**
 * Startup steps `orca serve` performs for a window-less host that orcad has to perform too.
 * See docs/reference/orcad-feature-parity.md.
 */
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { AgentHookServer } from '../agent-hooks/server'
import { installFirstWorkRenameSubscription } from '../agent-hooks/first-work-rename-subscription'
import { firstWorkRenameDeps } from '../agent-hooks/first-work-rename-runtime'
import { installHostAgentNotifications } from '../notifications/headless-agent-notification-host'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export function installOrcadHeadlessParity(options: {
  runtime: OrcaRuntimeService
  store: Store
  agentHookServer: Pick<AgentHookServer, 'subscribeEnrichedStatus' | 'subscribeStatusDrop'>
}): () => void {
  const { runtime, store, agentHookServer } = options
  // Same placeholder serve publishes: no renderer will ever publish a graph on this host.
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  const uninstallRename = installFirstWorkRenameSubscription(agentHookServer, () =>
    firstWorkRenameDeps(store, runtime)
  )
  const uninstallNotifications = installHostAgentNotifications({
    server: agentHookServer,
    store,
    runtime,
    // orcad cannot host a renderer, so this producer is the only one.
    isRendererAttached: () => false
  })
  return () => {
    uninstallNotifications()
    uninstallRename()
  }
}
