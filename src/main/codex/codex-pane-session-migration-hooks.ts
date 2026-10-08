import type { CodexHomePtySpawnedLifecycleArgs } from '../ipc/pty/host-env/types'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import type { CodexSessionMigrationScheduler } from './codex-session-migration-scheduler'
import {
  getCodexPaneAccount,
  isCodexPaneHomeRouteProvenAwayFromSharedHome
} from './codex-pane-account-registry'

export type CodexPaneSessionMigrationHooks = {
  onCodexHomePtySpawned: (args: CodexHomePtySpawnedLifecycleArgs) => void
  onPtyExit: (id: string, exitSequence: number) => void
}

/** Tells the shared-home session migration which Codex panes may still be writing rollouts. */
export function createCodexPaneSessionMigrationHooks(deps: {
  getRuntimeHome: () => CodexRuntimeHomeService | null
  getSessionMigration: () => CodexSessionMigrationScheduler | null
}): CodexPaneSessionMigrationHooks {
  return {
    onCodexHomePtySpawned: (args) => {
      const sessionMigration = deps.getSessionMigration()
      // Why: only shared or ambiguous retained shells can create rollout logs that still need publication.
      if (args.reattached && args.startedSequence !== undefined) {
        const paneAccount = getCodexPaneAccount(args.id)
        const homeRoute =
          args.reattachedHomeRoute !== undefined
            ? (args.reattachedHomeRoute ?? undefined)
            : paneAccount?.homeRoute
        if (sessionMigration && isCodexPaneHomeRouteProvenAwayFromSharedHome(homeRoute)) {
          sessionMigration.ignoreLaunch(args.id, args.startedSequence)
          return
        }
      }
      const fullScanRequired =
        deps.getRuntimeHome()?.beginHostSystemDefaultSessionMigrationLaunch(args.codexHomePath, {
          reattached: args.reattached,
          launchEnv: args.launchEnv
        }) ?? null
      if (fullScanRequired !== null) {
        sessionMigration?.beginLaunch(
          args.id,
          args.reattached === true || fullScanRequired,
          args.startedAt,
          args.startedSequence
        )
      }
    },
    onPtyExit: (id, exitSequence) => {
      deps.getSessionMigration()?.finishLaunch(id, exitSequence)
    }
  }
}
