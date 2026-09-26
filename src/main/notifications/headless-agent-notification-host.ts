import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getRepoIdFromWorktreeId, splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { installHeadlessAgentNotifications } from './headless-agent-notifications'

type AgentStatusTap = {
  subscribeEnrichedStatus(listener: (payload: EnrichedAgentHookEventPayload) => void): () => void
  subscribeStatusDrop(listener: (paneKey: string) => void): () => void
}

type NotificationLabelStore = Pick<
  Store,
  | 'getSettings'
  | 'getWorktreeIdForTab'
  | 'getWorktreeMeta'
  | 'getRepo'
  | 'getFolderWorkspace'
  | 'getProjectGroups'
>

/** Mirrors the renderer's workspace labels from what the host store knows. */
export function resolveHostNotificationLabels(
  store: NotificationLabelStore,
  workspaceId: string
): { repoLabel?: string; worktreeLabel?: string } {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const folder = store.getFolderWorkspace(scope.folderWorkspaceId)
    const group = folder
      ? store.getProjectGroups?.().find((candidate) => candidate.id === folder.projectGroupId)
      : undefined
    return { repoLabel: group?.name, worktreeLabel: folder?.name || undefined }
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const pathSegments = (splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? '')
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0)
  const pathLeaf = pathSegments.at(-1)
  return {
    repoLabel: store.getRepo(getRepoIdFromWorktreeId(worktreeId))?.displayName || undefined,
    worktreeLabel: store.getWorktreeMeta(worktreeId)?.displayName || pathLeaf
  }
}

export function installHostAgentNotifications(options: {
  server: AgentStatusTap
  store: NotificationLabelStore
  runtime: Pick<OrcaRuntimeService, 'dispatchMobileNotification'>
  isRendererAttached: () => boolean
}): () => void {
  const { server, store, runtime } = options
  return installHeadlessAgentNotifications({
    subscribeStatus: (listener) => server.subscribeEnrichedStatus(listener),
    subscribeStatusDrop: (listener) => server.subscribeStatusDrop(listener),
    dispatchMobileNotification: (event) => runtime.dispatchMobileNotification(event),
    readNotificationSettings: () => store.getSettings().notifications,
    resolveWorktreeIdForTab: (tabId) => store.getWorktreeIdForTab(tabId),
    resolveWorkspaceLabels: (worktreeId) => resolveHostNotificationLabels(store, worktreeId),
    isRendererAttached: options.isRendererAttached
  })
}
