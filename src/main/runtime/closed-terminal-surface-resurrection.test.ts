/**
 * Replays the stale-client resurrection sequences against the real runtime:
 * client A closes a tab while client B is offline; B reconnects holding its old local copy and
 * re-mounts the pane, which asks the host to create a terminal at the remembered tab/leaf ids.
 * The host, not B's snapshot, decides — before and after a host restart.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DurableProfileStateMutation } from '../persistence/loading-store/store-runtime-state'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { TERMINAL_SURFACE_RETIRED_ERROR } from '../../shared/terminal-surface-retirement-refusal'
import type { ClosedTerminalSurfaceLedgerStorage } from './closed-terminal-surface-ledger'

const WT = 'repo-1::/tmp/stale-client'
const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'

function makeStore() {
  const session = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    runDurableMutation: async <T>(mutate: () => DurableProfileStateMutation<T>) => mutate().value,
    getRepos: vi.fn(() => [
      { id: 'repo-1', path: '/tmp/stale-client', displayName: 'r', badgeColor: '#000', addedAt: 0 }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

function terminalTab(parentTabId: string, leafId = LEAF): RuntimeMobileSessionTerminalTab {
  return {
    type: 'terminal',
    id: `${parentTabId}::${leafId}`,
    parentTabId,
    leafId,
    title: 'Terminal',
    isActive: false
  }
}

function snapshotOf(tabs: RuntimeMobileSessionTerminalTab[]): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: tabs[0]?.id ?? null,
    activeTabType: 'terminal',
    tabs
  }
}

type Internals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  closeHeadlessMobileTerminalTab: (
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab,
    options?: Record<string, unknown>
  ) => Promise<void>
  removeWorktreeMetadataAndHistory: (store: unknown, worktreeId: string) => void
  isMobileSessionSurfaceMembershipAllowed: (
    worktreeId: string,
    parentTabId: string,
    leafId: string,
    candidatePtyId: string | null
  ) => boolean
}

function makeHost(storage?: ClosedTerminalSurfaceLedgerStorage) {
  const store = makeStore()
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore covers the reads these flows drive.
    store as never,
    undefined,
    storage ? { closedTerminalSurfaceLedgerStorage: storage } : {}
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: protected close/removal paths are the host's own entry points.
  return { runtime, store, internals: runtime as unknown as Internals }
}

function memoryStorage(): ClosedTerminalSurfaceLedgerStorage {
  let stored: string | null = null
  return { read: () => stored, write: (next) => void (stored = next) }
}

async function createAt(runtime: OrcaRuntimeService, tabId: string, leafId = LEAF) {
  return runtime.createTerminal(`id:${WT}`, { tabId, leafId }).then(
    () => 'created',
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  )
}

async function closeOnClientA(
  host: ReturnType<typeof makeHost>,
  tab: RuntimeMobileSessionTerminalTab
) {
  const snapshot = snapshotOf([tab, terminalTab('tab-open')])
  host.internals.mobileSessionTabsByWorktree.set(WT, snapshot)
  await host.internals.closeHeadlessMobileTerminalTab(WT, snapshot, tab, {
    allowMissingPersistedTab: true,
    killPtys: false
  })
}

describe('a stale client cannot resurrect a tab the host closed', () => {
  it('refuses the closed tab id and still serves ids that are open', async () => {
    const host = makeHost(memoryStorage())
    await closeOnClientA(host, terminalTab('tab-closed'))

    expect(await createAt(host.runtime, 'tab-closed')).toBe(TERMINAL_SURFACE_RETIRED_ERROR)
    expect(await createAt(host.runtime, 'tab-closed', OTHER_LEAF)).toBe(
      TERMINAL_SURFACE_RETIRED_ERROR
    )
    // Negative: an open tab and a never-seen tab reach the normal create path.
    expect(await createAt(host.runtime, 'tab-open')).not.toBe(TERMINAL_SURFACE_RETIRED_ERROR)
    expect(await createAt(host.runtime, 'tab-brand-new')).not.toBe(TERMINAL_SURFACE_RETIRED_ERROR)
  })

  it('keeps refusing after the host process restarts', async () => {
    const storage = memoryStorage()
    await closeOnClientA(makeHost(storage), terminalTab('tab-closed'))

    const restarted = makeHost(storage)
    expect(await createAt(restarted.runtime, 'tab-closed')).toBe(TERMINAL_SURFACE_RETIRED_ERROR)
    expect(await createAt(restarted.runtime, 'tab-open')).not.toBe(TERMINAL_SURFACE_RETIRED_ERROR)
  })

  it('fences in memory without durable storage, and only durable storage survives a restart', async () => {
    const volatile = makeHost()
    await closeOnClientA(volatile, terminalTab('tab-closed'))
    expect(await createAt(volatile.runtime, 'tab-closed')).toBe(TERMINAL_SURFACE_RETIRED_ERROR)
    // A fresh process with no storage has no memory of it — the pre-ledger behavior, by design.
    expect(await createAt(makeHost().runtime, 'tab-closed')).not.toBe(
      TERMINAL_SURFACE_RETIRED_ERROR
    )
  })

  it('drops the closed surface from a stale publisher while licensing live ones', async () => {
    const host = makeHost(memoryStorage())
    await closeOnClientA(host, terminalTab('tab-closed'))
    expect(
      host.internals.isMobileSessionSurfaceMembershipAllowed(WT, 'tab-closed', LEAF, null)
    ).toBe(false)
    expect(host.internals.isMobileSessionSurfaceMembershipAllowed(WT, 'tab-open', LEAF, null)).toBe(
      true
    )
  })

  it('retires every terminal tab of a removed workspace', async () => {
    const host = makeHost(memoryStorage())
    host.internals.mobileSessionTabsByWorktree.set(
      WT,
      snapshotOf([terminalTab('tab-in-removed-1'), terminalTab('tab-in-removed-2')])
    )
    host.internals.removeWorktreeMetadataAndHistory(host.store, WT)

    expect(await createAt(host.runtime, 'tab-in-removed-1')).toBe(TERMINAL_SURFACE_RETIRED_ERROR)
    expect(await createAt(host.runtime, 'tab-in-removed-2')).toBe(TERMINAL_SURFACE_RETIRED_ERROR)
    expect(await createAt(host.runtime, 'tab-in-successor')).not.toBe(
      TERMINAL_SURFACE_RETIRED_ERROR
    )
  })
})
