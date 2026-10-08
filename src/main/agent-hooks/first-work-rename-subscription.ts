import type { EnrichedAgentHookEventPayload } from './server/server-types'
import {
  maybeAutoRenameBranchOnFirstWork,
  type FirstWorkBranchRenameDeps
} from './first-work-branch-rename'

type EnrichedStatusSource = {
  subscribeEnrichedStatus(listener: (payload: EnrichedAgentHookEventPayload) => void): () => void
}

/**
 * Arms first-work branch/workspace auto-rename from the agent-hook status tap.
 *
 * Why not the main-window listener: that slot only exists while a desktop window is open, so a
 * headless host (`orca serve`, orcad) never renamed anything (#17069). The rename needs only the
 * store and runtime, so it belongs on the multi-subscriber tap that fires in every host mode.
 */
export function installFirstWorkRenameSubscription(
  server: EnrichedStatusSource,
  resolveDeps: () => FirstWorkBranchRenameDeps | null
): () => void {
  return server.subscribeEnrichedStatus((event) => {
    // Same exclusions the window listener applied before the rename moved here: structured chats
    // rename through worktree.ps, resume-identity rows are not work, and a restored row is stale.
    if (event.structuredHost || event.providerSessionOnly || event.restoredUnconfirmed) {
      return
    }
    const deps = resolveDeps()
    if (!deps) {
      return
    }
    void maybeAutoRenameBranchOnFirstWork(
      {
        paneKey: event.paneKey,
        tabId: event.tabId,
        worktreeId: event.worktreeId,
        state: event.payload.state,
        prompt: event.payload.prompt,
        assistantMessage: event.payload.lastAssistantMessage,
        isReplay: event.isReplay
      },
      deps
    ).catch((error: unknown) => {
      // Why: the orchestrator records its own verdicts; this only keeps a bug from going unhandled.
      console.error('[auto-branch-rename] first-work rename failed:', error)
    })
  })
}
