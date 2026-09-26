import { describe, expect, it } from 'vitest'
import { resolveHostNotificationLabels } from './headless-agent-notification-host'

function makeStore(overrides: Partial<Parameters<typeof resolveHostNotificationLabels>[0]> = {}) {
  return {
    getSettings: () => {
      throw new Error('unused')
    },
    getWorktreeIdForTab: () => undefined,
    getWorktreeMeta: () => undefined,
    getRepo: () => undefined,
    getFolderWorkspace: () => undefined,
    getProjectGroups: () => [],
    ...overrides
  } satisfies Parameters<typeof resolveHostNotificationLabels>[0]
}

describe('resolveHostNotificationLabels', () => {
  it('prefers the stored worktree display name and repo name', () => {
    const store = makeStore({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only displayName is read.
      getWorktreeMeta: () => ({ displayName: 'Fix login' }) as never,
      getRepo: (repoId: string) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only displayName is read.
        repoId === 'repo-1' ? ({ displayName: 'orca' } as never) : undefined
    })

    expect(resolveHostNotificationLabels(store, 'repo-1::/srv/work/snipefish')).toEqual({
      repoLabel: 'orca',
      worktreeLabel: 'Fix login'
    })
  })

  it('falls back to the worktree folder name when nothing is stored', () => {
    expect(resolveHostNotificationLabels(makeStore(), 'repo-1::C:\\work\\snipefish\\')).toEqual({
      repoLabel: undefined,
      worktreeLabel: 'snipefish'
    })
  })

  it('labels folder workspaces by folder and project group, not by a worktree path', () => {
    const store = makeStore({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only name and projectGroupId are read.
      getFolderWorkspace: () => ({ name: 'notes', projectGroupId: 'g1' }) as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only id and name are read.
      getProjectGroups: () => [{ id: 'g1', name: 'Personal' }] as never
    })

    expect(resolveHostNotificationLabels(store, 'folder:fw-1')).toEqual({
      repoLabel: 'Personal',
      worktreeLabel: 'notes'
    })
  })
})
