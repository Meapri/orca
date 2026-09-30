/**
 * The Claude/Codex account, runtime-auth and rate-limit service graph, wired the same way on
 * every host that owns execution: the desktop main process (including `orca serve`) and orcad.
 * Everything here reaches Electron only through host ports, so orcad can compose it too.
 */
import type { Store } from '../persistence'
import { RateLimitService } from '../rate-limits/service'
import { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import { CodexAccountService } from '../codex-accounts/service'
import { ClaudeRuntimeAuthService } from '../claude-accounts/runtime-auth-service'
import { ClaudeAccountService } from '../claude-accounts/service'
import {
  createCodexSessionMigrationScheduler,
  type CodexSessionMigrationScheduler
} from '../codex/codex-session-migration-scheduler'
import { startCodexSessionBackfillInBackground } from '../codex/codex-session-backfill'
import { startCodexSessionIndexHealInBackground } from '../codex/codex-session-index-heal'
import { startCodexStateDbBackfillRecoveryInBackground } from '../codex/codex-state-db-backfill-recovery'
import { getOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import { getInitialCodexRateLimitTarget } from '../rate-limits/codex-rate-limit-target'
import { getInitialClaudeRateLimitTarget } from '../rate-limits/claude-rate-limit-target'
import { getKimiRuntimeTarget, resolveKimiHome } from '../kimi/kimi-runtime-home'
import { readMiniMaxSessionCookie } from '../minimax/minimax-cookie-store'
import { readMiniMaxApiKey } from '../minimax/minimax-api-key-store'
import { createAccountRuntimeTargetSettingsSync } from '../rate-limits/account-runtime-target-sync'
import { normalizeCodexRuntimeSelection } from '../codex-accounts/runtime-selection'
import { normalizeClaudeRuntimeSelection } from '../claude-accounts/runtime-selection'
import { agentHookServer } from '../agent-hooks/server'
import { setSystemCodexHomeHookSweepSuppressed } from '../codex/hook-service'
import { shouldSuppressSystemCodexHomeHookSweep } from '../codex/codex-hook-legacy-cleanup'
import { isRealHomeCodexHookLaneUsable } from '../codex/codex-real-home-hook-install'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'

export type AccountServices = {
  rateLimits: RateLimitService
  codexRuntimeHome: CodexRuntimeHomeService
  codexSessionMigration: CodexSessionMigrationScheduler
  codexAccounts: CodexAccountService
  claudeRuntimeAuth: ClaudeRuntimeAuthService
  claudeAccounts: ClaudeAccountService
}

export function createAccountServices(options: {
  store: Store
  isQuitting: () => boolean
}): AccountServices {
  const { store } = options
  const rateLimits = new RateLimitService()
  const codexRuntimeHome = new CodexRuntimeHomeService(store)
  void startCodexStateDbBackfillRecoveryInBackground(getOrcaManagedCodexHomePath())
  // Why: an incapable trust-grant host must fall back to the managed home for
  // every consumer (PTY env, rate limits, commit messages) in one place.
  codexRuntimeHome.setRealHomeLaneGate(() => isRealHomeCodexHookLaneUsable())
  // Why: while the real-home lane owns ~/.codex/hooks.json, the legacy
  // system-home sweep inside managed installs would delete the entry the
  // real-home installer just appended. Flag OFF, hooks off (all or Codex), or an
  // incapable trust lane re-arms the sweep so downgrade, opt-out, and rollback converge.
  setSystemCodexHomeHookSweepSuppressed(() =>
    shouldSuppressSystemCodexHomeHookSweep({
      isHostSystemDefaultRealHome: codexRuntimeHome.isHostSystemDefaultRealHome(),
      settings: store.getSettings()
    })
  )
  const codexSessionMigration = createCodexSessionMigrationScheduler({
    isEligible: () => codexRuntimeHome.isHostSystemDefaultSessionMigrationEligible(),
    isQuitting: options.isQuitting,
    resolveSystemCodexHomePathOverride: () =>
      resolveHostCodexSessionSourceHome(store.getSettings()),
    prepareScheduledRun: (scanDates) =>
      codexRuntimeHome.prepareHostSystemDefaultSessionMigrationPass(scanDates),
    finishScheduledRun: () => codexRuntimeHome.finishHostSystemDefaultSessionMigrationPass(),
    startBackfill: startCodexSessionBackfillInBackground,
    startIndexHeal: startCodexSessionIndexHealInBackground
  })
  const codexAccounts = new CodexAccountService(store, rateLimits, codexRuntimeHome, {
    onHostSystemDefaultSelected: codexSessionMigration.requestRun
  })
  // Why: migrate historical shared-home sessions after startup; compatibility
  // launches re-arm the non-destructive pass for new rollouts (#4444, #8612, #12480).
  codexSessionMigration.scheduleInitialRun()
  const claudeRuntimeAuth = new ClaudeRuntimeAuthService(store)
  const claudeAccounts = new ClaudeAccountService(store, rateLimits, claudeRuntimeAuth)
  rateLimits.setCodexHomePathResolver((target) => codexRuntimeHome.prepareForRateLimitFetch(target))
  rateLimits.setCodexFetchTarget(getInitialCodexRateLimitTarget(store.getSettings()))
  // Why: Kimi's CLI refreshes its OAuth token in whichever runtime it runs in, so the
  // usage fetch must read the WSL-side credentials when that's the configured runtime (#12370).
  rateLimits.setKimiHomeResolver(() => resolveKimiHome(getKimiRuntimeTarget(store.getSettings())))
  rateLimits.setClaudeFetchTarget(getInitialClaudeRateLimitTarget(store.getSettings()))
  const syncAccountRuntimeTargets = createAccountRuntimeTargetSettingsSync(
    rateLimits,
    store.getSettings()
  )
  store.onSettingsChanged((updates, settings) => {
    // Why: auto is a live policy; retarget only providers whose settings-derived runtime changed.
    void syncAccountRuntimeTargets(updates, settings).catch((error) =>
      console.warn('[rate-limits] Failed to apply account runtime target:', error)
    )
    // Why: these three pick the MiniMax host and quota bucket, so a stale snapshot from the
    // previous endpoint would otherwise sit in the status bar until the next poll.
    if (
      'minimaxEndpoint' in updates ||
      'minimaxGroupId' in updates ||
      'minimaxUsageModels' in updates
    ) {
      rateLimits.invalidateMiniMaxCredentialState()
      void rateLimits.refresh().catch((error: unknown) => {
        console.warn(
          '[rate-limits] Failed to refresh MiniMax usage after a settings change:',
          error
        )
      })
    }
  })
  rateLimits.setClaudeAuthPreparationResolver((target) =>
    claudeRuntimeAuth.prepareForRateLimitFetch(target)
  )
  // Why: live Claude sessions stream usage windows through their statusLine command; feeding them here avoids OAuth usage-endpoint polling (and its 429s).
  agentHookServer.setClaudeStatusLineListener((event) => {
    rateLimits.ingestLiveClaudeRateLimits(event)
  })
  rateLimits.setOpenCodeGoConfigResolver(() => {
    const settings = store.getSettings()
    return {
      sessionCookie: settings.opencodeSessionCookie,
      workspaceIdOverride: settings.opencodeWorkspaceId,
      apiKey: settings.opencodeGoApiKey
    }
  })
  rateLimits.setMiniMaxConfigResolver(() => {
    const settings = store.getSettings()
    const apiKey = readMiniMaxApiKey() ?? ''
    return {
      sessionCookie: apiKey ? '' : (readMiniMaxSessionCookie() ?? ''),
      groupId: settings.minimaxGroupId,
      models: settings.minimaxUsageModels,
      endpoint: settings.minimaxEndpoint,
      apiKey
    }
  })
  rateLimits.setGeminiCliOAuthEnabledResolver(() => store.getSettings().geminiCliOAuthEnabled)
  rateLimits.setNetworkProxySettingsResolver(() => store.getSettings())
  rateLimits.setInactiveClaudeAccountsResolver(() => {
    const settings = store.getSettings()
    const selection = normalizeClaudeRuntimeSelection(settings)
    const activeIds = new Set([selection.host, ...Object.values(selection.wsl)].filter(Boolean))
    return settings.claudeManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        managedAuthPath: account.managedAuthPath,
        managedAuthRuntime: account.managedAuthRuntime,
        wslDistro: account.wslDistro,
        wslLinuxAuthPath: account.wslLinuxAuthPath
      }))
  })
  rateLimits.setInactiveCodexAccountsResolver(() => {
    const settings = store.getSettings()
    const selection = normalizeCodexRuntimeSelection(settings)
    const activeIds = new Set([selection.host, ...Object.values(selection.wsl)].filter(Boolean))
    return settings.codexManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        resolveHome: () => {
          const resolved = codexRuntimeHome.resolveCodexManagedAccountHomeForInactiveFetch(account)
          return resolved.kind === 'ready'
            ? { kind: 'ready' as const, managedHomePath: resolved.homePath }
            : { kind: 'skip' as const }
        }
      }))
  })
  return {
    rateLimits,
    codexRuntimeHome,
    codexSessionMigration,
    codexAccounts,
    claudeRuntimeAuth,
    claudeAccounts
  }
}
