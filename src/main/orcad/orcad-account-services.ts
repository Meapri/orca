/**
 * The Claude/Codex account services orcad serves, from the composition the desktop and
 * `orca serve` use. Managed credentials land where the desktop puts them on this platform:
 * files under the data root (`claude-accounts/`, `codex-accounts/`) on Linux, the login
 * keychain for Claude on macOS. See docs/reference/orcad-feature-parity.md.
 */
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { registerHeadlessPtyRuntime } from '../ipc/pty'
import { ClaudeUsageStore } from '../claude-usage/store'
import { CodexUsageStore } from '../codex-usage/store'
import {
  createAccountServices,
  type AccountServices
} from '../account-services/account-service-composition'
import {
  attachAccountServicesToRuntime,
  createAccountBackedRuntimeDeps,
  type AccountBackedRuntimeDeps
} from '../account-services/account-backed-runtime-deps'
import {
  createCodexRuntimeHomeLaunchPreparation,
  type CodexRuntimeHomeLaunchPreparation
} from '../codex/codex-runtime-home-launch-preparation'
import { createCodexSessionResumeLaunchPreparation } from '../codex/codex-session-resume-launch-preparation'
import { createCodexPaneSessionMigrationHooks } from '../codex/codex-pane-session-migration-hooks'

export type OrcadAccountServices = AccountServices & {
  claudeUsage: ClaudeUsageStore
  codexUsage: CodexUsageStore
  prepareCodexRuntimeHomeForLaunch: CodexRuntimeHomeLaunchPreparation
  /** Spread into the runtime's constructor deps. */
  runtimeDeps: AccountBackedRuntimeDeps
  stop(): void
}

export function createOrcadAccountServices(store: Store): OrcadAccountServices {
  let quitting = false
  const services = createAccountServices({ store, isQuitting: () => quitting })
  const prepareCodexRuntimeHomeForLaunch = createCodexRuntimeHomeLaunchPreparation({
    getRuntimeHome: () => services.codexRuntimeHome,
    getSettings: () => store.getSettings()
  })
  return {
    ...services,
    // Why here: automation runs read their token/cost figures from these, as on serve.
    claudeUsage: new ClaudeUsageStore(store),
    codexUsage: new CodexUsageStore(store),
    prepareCodexRuntimeHomeForLaunch,
    runtimeDeps: createAccountBackedRuntimeDeps({
      getClaudeRuntimeAuth: () => services.claudeRuntimeAuth,
      getCodexRuntimeHome: () => services.codexRuntimeHome,
      getSettings: () => store.getSettings(),
      prepareCodexRuntimeHomeForLaunch
    }),
    stop: () => {
      quitting = true
      services.rateLimits.stop()
    }
  }
}

/** `--serve`'s PTY registration: account-backed Codex home, Claude auth and resume prep. */
export async function registerAccountBackedPtyRuntime(
  runtime: OrcaRuntimeService,
  store: Store,
  accounts: OrcadAccountServices
): Promise<void> {
  attachAccountServicesToRuntime(runtime, accounts, accounts.prepareCodexRuntimeHomeForLaunch)
  await registerHeadlessPtyRuntime(
    runtime,
    accounts.prepareCodexRuntimeHomeForLaunch,
    () => store.getSettings(),
    (target) => accounts.claudeRuntimeAuth.prepareForClaudeLaunch(target),
    store,
    createCodexSessionResumeLaunchPreparation({
      getRuntimeHome: () => accounts.codexRuntimeHome,
      getSettings: () => store.getSettings()
    }),
    createCodexPaneSessionMigrationHooks({
      getRuntimeHome: () => accounts.codexRuntimeHome,
      getSessionMigration: () => accounts.codexSessionMigration
    })
  )
}
