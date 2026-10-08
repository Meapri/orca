/**
 * Startup steps the desktop performs that orcad has to perform too; the window graph and
 * automations come from headless-runtime-graph.ts and orcad-automations.ts.
 * See docs/reference/orcad-feature-parity.md.
 */
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
import { installHostAgentNotifications } from '../notifications/headless-agent-notification-host'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { scheduleAllPendingHistoryTreeRemovals } from '../terminal-history-deletion'
import { cancelHistoryGc, scheduleHistoryGc } from '../terminal-history-gc'
import { getKnownWorktreeIdsForHistoryGc } from '../window/history-gc-worktree-ids'
import { collectWorktreeTrashSweepRoots, sweepStaleWorktreeTrash } from '../worktree-trash'
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
  agentHookServer: Pick<AgentHookServer, 'subscribeEnrichedStatus' | 'subscribeStatusDrop'> &
    HeadlessSleepingAgentStatusSource
  /** Uninstalls before the final profile flush, so no scheduled step starts work it cannot record. */
  registerCleanup?: (cleanup: () => void) => void
}): OrcadHeadlessParity {
  const { runtime, store, agentHookServer } = options
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
  // Why: nothing else records or replays an idle agent's resume identity on this host (#21743).
  const sleepingAgents = installHeadlessSleepingAgentHost({
    server: agentHookServer,
    store,
    runtime
  })
  let stopped = false
  const parity: OrcadHeadlessParity = {
    startScheduledWork: () => {
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
      uninstallNotifications()
      uninstallRename()
    }
  }
  options.registerCleanup?.(() => parity.uninstall())
  return parity
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
