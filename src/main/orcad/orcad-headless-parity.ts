/**
 * Startup steps `orca serve` performs for a window-less host that orcad has to perform too.
 * See docs/reference/orcad-feature-parity.md.
 */
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { AgentHookServer } from '../agent-hooks/server'
import { installFirstWorkRenameSubscription } from '../agent-hooks/first-work-rename-subscription'
import {
  installHeadlessSleepingAgentHost,
  type HeadlessSleepingAgentStatusSource
} from '../agent-hooks/headless-sleeping-agent-host'
import { firstWorkRenameDeps } from '../agent-hooks/first-work-rename-runtime'
import {
  installManagedAgentHooks,
  resolveStartupManagedHookAction,
  shouldContinueManagedHookStartup
} from '../agent-hooks/managed-agent-hook-controls'
import { AutomationService } from '../automations/service'
import { createRuntimeHeadlessAutomationDispatcher } from '../automations/runtime-headless-dispatcher'
import { createRuntimeAutomationRunTerminalObserver } from '../automations/runtime-terminal-run-observer'
import { installHostAgentNotifications } from '../notifications/headless-agent-notification-host'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { scheduleAllPendingHistoryTreeRemovals } from '../terminal-history-deletion'
import { cancelHistoryGc, scheduleHistoryGc } from '../terminal-history-gc'
import { getKnownWorktreeIdsForHistoryGc } from '../window/history-gc-worktree-ids'
import { collectWorktreeTrashSweepRoots, sweepStaleWorktreeTrash } from '../worktree-trash'

export type OrcadHeadlessParity = {
  /** Serve arms these only once its RPC transport is up; orcad keeps that order. */
  startScheduledWork(): void
  uninstall(): void
}

export function installOrcadHeadlessParity(options: {
  runtime: OrcaRuntimeService
  store: Store
  agentHookServer: Pick<AgentHookServer, 'subscribeEnrichedStatus' | 'subscribeStatusDrop'> &
    HeadlessSleepingAgentStatusSource
}): OrcadHeadlessParity {
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
  // Why: without a service `automation.runNow` refuses and schedules never fire, although orcad
  // is the runtime authority that owns them. Usage stores are desktop accounts; runs omit usage.
  const automations = new AutomationService(store, {
    terminalObserver: createRuntimeAutomationRunTerminalObserver(runtime),
    onAutomationsChanged: (payload) => runtime.notifyAutomationsChanged(payload),
    allowRemoteHostScheduling: true,
    headlessDispatcher: createRuntimeHeadlessAutomationDispatcher(runtime)
  })
  runtime.setAutomationService(automations)
  // Why: nothing else records or replays an idle agent's resume identity on this host (#21743).
  const sleepingAgents = installHeadlessSleepingAgentHost({
    server: agentHookServer,
    store,
    runtime
  })
  let stopped = false
  return {
    startScheduledWork: () => {
      automations.start()
      // Why: a fresh host has no managed hook scripts, so agents report no status at all — no
      // notifications, rename or chat transcripts. Serve reconciles them at startup the same way.
      const settings = store.getSettings()
      if (resolveStartupManagedHookAction(settings) === 'install') {
        void installManagedAgentHooks(settings, {
          shouldHydrateShellPath: true,
          shouldContinue: (agent) =>
            shouldContinueManagedHookStartup(stopped, store.getSettings(), agent)
        }).catch((error: unknown) => {
          console.warn('[agent-hooks] failed to reconcile managed hooks on startup:', error)
        })
      }
      // A quit mid-delete leaves tombstoned history and trashed checkouts that only this reclaims.
      scheduleAllPendingHistoryTreeRemovals()
      // Same orphan-history GC the desktop arms from its main window, over the same live set.
      scheduleHistoryGc(async () => getKnownWorktreeIdsForHistoryGc(store))
      void sleepingAgents.resumeAfterRestart().catch((error: unknown) => {
        console.warn('[agent-resume] cold restore after restart failed:', error)
      })
      void sweepStaleWorktreeTrash(
        collectWorktreeTrashSweepRoots(store.getRepos(), store.getSettings())
      ).catch((error: unknown) => {
        console.warn('[worktrees] Failed to sweep leftover worktree directories:', error)
      })
    },
    uninstall: () => {
      stopped = true
      // Why first: shutdown's own PTY teardown must not read as agents to resume.
      sleepingAgents.uninstall()
      cancelHistoryGc()
      automations.stop()
      uninstallNotifications()
      uninstallRename()
    }
  }
}
