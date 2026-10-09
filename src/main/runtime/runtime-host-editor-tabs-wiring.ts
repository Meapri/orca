import type { ExecutionHostId } from '../../shared/execution-host'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import type { Store } from '../persistence'
import type { DurableTextFileStorage } from './durable-text-file-storage'
import { HostEditorTabStore } from './host-editor-tab-store'
import { HostEditorTabs } from './host-editor-tabs'
import {
  createLocalHostMarkdownFileAccess,
  createRemoteHostMarkdownFileAccess
} from './host-markdown-file-access'
import { requireRuntimeFileProvider } from './runtime-file-command-target'

export type RuntimeHostEditorTabsPorts = {
  isRetired(tabId: string): boolean
  ownsEditorTabs(): boolean
  resolveFileTarget(worktreeId: string): Promise<{ executionHostId: ExecutionHostId }>
  requireStore(): Store
  publish(worktreeId: string): void
  retire(worktreeId: string, tabIds: readonly string[]): void
}

export function createRuntimeHostEditorTabs(
  storage: DurableTextFileStorage | null,
  ports: RuntimeHostEditorTabsPorts
): HostEditorTabs {
  return new HostEditorTabs(new HostEditorTabStore(storage, { isRetired: ports.isRetired }), {
    ownsEditorTabs: ports.ownsEditorTabs,
    openFileAccess: async (worktreeId, filePath) => {
      // Why: the workspace's own host routes the file, so SSH worktrees read and write remotely.
      const provider = requireRuntimeFileProvider(await ports.resolveFileTarget(worktreeId))
      return provider
        ? createRemoteHostMarkdownFileAccess(filePath, provider)
        : createLocalHostMarkdownFileAccess(filePath, (path) =>
            resolveAuthorizedPath(path, ports.requireStore())
          )
    },
    publish: ports.publish,
    retire: ports.retire
  })
}
