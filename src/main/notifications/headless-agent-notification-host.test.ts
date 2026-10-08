import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  installHostAgentNotifications,
  resolveHostNotificationLabels
} from './headless-agent-notification-host'
import { HEADLESS_TERMINAL_BELL_GRACE_MS } from './headless-agent-notifications'

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

describe('installHostAgentNotifications terminal bells', () => {
  it('announces a BEL that main parsed off a PTY on a host with no renderer', () => {
    vi.useFakeTimers()
    try {
      const settings = {
        workspaceDir: '/tmp/workspaces',
        notifications: { ...getDefaultNotificationSettings(), enabled: true, terminalBell: true }
      }
      const store = {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only notifications and workspaceDir are read.
        ...makeStore({ getSettings: () => settings as never }),
        getWorkspaceSession: () => getDefaultWorkspaceSession(),
        getRepos: () => []
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bell path reads settings and the headless graph only.
      const runtime = new OrcaRuntimeService(store as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      const dispatch = vi.spyOn(runtime, 'dispatchMobileNotification')
      const uninstall = installHostAgentNotifications({
        server: { subscribeEnrichedStatus: () => () => {}, subscribeStatusDrop: () => () => {} },
        store,
        runtime,
        isRendererAttached: () => false
      })

      runtime.onPtyData('pty-1', 'build done\x07', 1)
      vi.advanceTimersByTime(HEADLESS_TERMINAL_BELL_GRACE_MS)

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'terminal-bell', title: 'Bell in workspace' })
      )
      uninstall()
      runtime.onPtyData('pty-1', '\x07', 2)
      vi.advanceTimersByTime(HEADLESS_TERMINAL_BELL_GRACE_MS * 40)
      expect(dispatch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
