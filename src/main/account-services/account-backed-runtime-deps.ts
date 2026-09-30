import type { GlobalSettings } from '../../shared/global-settings-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { ClaudeRuntimeAuthService } from '../claude-accounts/runtime-auth-service'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import type { CodexRuntimeHomeLaunchPreparation } from '../codex/codex-runtime-home-launch-preparation'
import { prepareCodexAiVaultSessionResume } from '../codex/codex-ai-vault-session-resume'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import type { AccountServices } from './account-service-composition'

type RuntimeDeps = NonNullable<ConstructorParameters<typeof OrcaRuntimeService>[2]>

export type AccountBackedRuntimeDeps = Pick<
  RuntimeDeps,
  | 'prepareClaudeAuth'
  | 'getAdditionalAiVaultCodexHomePaths'
  | 'prepareAiVaultSessionResume'
  | 'prepareCodexStructuredLaunch'
  | 'resolveCodexStructuredLaunchHome'
>

/**
 * The runtime hooks that route agent launches and session history through the selected
 * Claude/Codex account. Getters, because the desktop builds these services after the runtime.
 */
export function createAccountBackedRuntimeDeps(deps: {
  getClaudeRuntimeAuth: () => ClaudeRuntimeAuthService | null
  getCodexRuntimeHome: () => CodexRuntimeHomeService | null
  getSettings: () => GlobalSettings
  prepareCodexRuntimeHomeForLaunch: CodexRuntimeHomeLaunchPreparation
}): AccountBackedRuntimeDeps {
  return {
    prepareClaudeAuth: (target) => {
      const claudeRuntimeAuth = deps.getClaudeRuntimeAuth()
      if (!claudeRuntimeAuth) {
        throw new Error('Claude runtime auth service is not initialized')
      }
      return claudeRuntimeAuth.prepareForClaudeLaunch(target)
    },
    // Why: aiVault.listSessions must include managed-Codex sessions on every execution host.
    getAdditionalAiVaultCodexHomePaths: () =>
      deps.getCodexRuntimeHome()?.getHostCodexHomePathsForSessionDiscovery() ?? [],
    prepareAiVaultSessionResume: (args) =>
      prepareCodexAiVaultSessionResume(args, {
        runtimeHome: deps.getCodexRuntimeHome(),
        systemCodexHomePath: resolveHostCodexSessionSourceHome(deps.getSettings())
      }),
    prepareCodexStructuredLaunch: ({ launchEnv }) =>
      deps.prepareCodexRuntimeHomeForLaunch(undefined, launchEnv),
    // Why throw like prepare does: a null from an uninitialized service would
    // map to the system home and key a catalog read to the wrong account.
    resolveCodexStructuredLaunchHome: ({ launchEnv }) => {
      const runtimeHome = deps.getCodexRuntimeHome()
      if (!runtimeHome) {
        throw new Error('Codex runtime home service is not initialized')
      }
      return runtimeHome.resolveHostCodexHomePathForLaunchReadOnly(launchEnv)
    }
  }
}

/** Serves `accounts.*` and account-backed commit-message generation from these services. */
export function attachAccountServicesToRuntime(
  runtime: Pick<
    OrcaRuntimeService,
    'setAccountServices' | 'setCommitMessageAgentEnvironmentResolvers'
  >,
  services: Pick<
    AccountServices,
    'claudeAccounts' | 'codexAccounts' | 'rateLimits' | 'claudeRuntimeAuth'
  >,
  prepareCodexRuntimeHomeForLaunch: CodexRuntimeHomeLaunchPreparation
): void {
  const { claudeAccounts, codexAccounts, rateLimits, claudeRuntimeAuth } = services
  runtime.setAccountServices({ claudeAccounts, codexAccounts, rateLimits })
  runtime.setCommitMessageAgentEnvironmentResolvers({
    // Why: Codex hooks/auth live in Orca's managed runtime home even for the default path, so every launch must resolve CODEX_HOME via runtime-home.
    prepareForCodexLaunch: prepareCodexRuntimeHomeForLaunch,
    prepareForClaudeLaunch: (target) => claudeRuntimeAuth.prepareForClaudeLaunch(target)
  })
}
