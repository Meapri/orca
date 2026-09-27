/**
 * Startup steps `orca serve` performs for a window-less host that orcad has to perform too.
 * See docs/reference/orcad-feature-parity.md.
 */
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { AgentHookServer } from '../agent-hooks/server'
import { installFirstWorkRenameSubscription } from '../agent-hooks/first-work-rename-subscription'
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
import { collectWorktreeTrashSweepRoots, sweepStaleWorktreeTrash } from '../worktree-trash'
import type { OrcadAccountServices } from './orcad-account-services'
import { getAppEnvironment } from '../../shared/app-environment'
import { setHostCliResourcesPath } from '../cli/bundled-cli-launcher-path'
import { prepareOrcadCliLauncher } from './orcad-cli-launcher'
import { registerOrcadCli } from './orcad-cli-registration'

export type OrcadHeadlessParity = {
  /** Serve arms these only once its RPC transport is up; orcad keeps that order. */
  startScheduledWork(): void
  uninstall(): void
}

export function installOrcadHeadlessParity(options: {
  runtime: OrcaRuntimeService
  store: Store
  agentHookServer: Pick<AgentHookServer, 'subscribeEnrichedStatus' | 'subscribeStatusDrop'>
  accounts: Pick<OrcadAccountServices, 'claudeUsage' | 'codexUsage' | 'stop'>
}): OrcadHeadlessParity {
  const { runtime, store, agentHookServer, accounts } = options
  // Same placeholder serve publishes: no renderer will ever publish a graph on this host.
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  const dataRoot = getAppEnvironment().getPath('userData')
  // Why before RPC binds: the first PTY's PATH must already reach this runtime's `orca`.
  const cliResourcesPath = prepareOrcadCliLauncherSafely(dataRoot)
  setHostCliResourcesPath(cliResourcesPath)
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
  // is the runtime authority that owns them.
  const automations = new AutomationService(store, {
    claudeUsage: accounts.claudeUsage,
    codexUsage: accounts.codexUsage,
    terminalObserver: createRuntimeAutomationRunTerminalObserver(runtime),
    onAutomationsChanged: (payload) => runtime.notifyAutomationsChanged(payload),
    allowRemoteHostScheduling: true,
    headlessDispatcher: createRuntimeHeadlessAutomationDispatcher(runtime)
  })
  runtime.setAutomationService(automations)
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
      if (cliResourcesPath) {
        void registerOrcadCliAtStartup(dataRoot, cliResourcesPath)
      }
      // A quit mid-delete leaves tombstoned history and trashed checkouts that only this reclaims.
      scheduleAllPendingHistoryTreeRemovals()
      void sweepStaleWorktreeTrash(
        collectWorktreeTrashSweepRoots(store.getRepos(), store.getSettings())
      ).catch((error: unknown) => {
        console.warn('[worktrees] Failed to sweep leftover worktree directories:', error)
      })
    },
    uninstall: () => {
      stopped = true
      automations.stop()
      accounts.stop()
      uninstallNotifications()
      uninstallRename()
    }
  }
}

function prepareOrcadCliLauncherSafely(dataRoot: string): string | null {
  try {
    return prepareOrcadCliLauncher({
      platform: process.platform,
      dataRoot,
      installRoot: getAppEnvironment().getAppPath(),
      runtimePath: process.execPath
    })
  } catch (error) {
    console.warn('[orcad] orca CLI launcher unavailable:', error)
    return null
  }
}

async function registerOrcadCliAtStartup(dataRoot: string, resourcesPath: string): Promise<void> {
  try {
    const result = await registerOrcadCli({ platform: process.platform, dataRoot, resourcesPath })
    console.error(
      result.state === 'installed'
        ? `[orcad] orca CLI registered at ${result.commandPath}${result.pathConfigured === false ? ' (not on PATH)' : ''}`
        : `[orcad] orca CLI registration skipped: ${result.reason}`
    )
  } catch (error) {
    console.warn('[orcad] orca CLI registration failed:', error)
  }
}
