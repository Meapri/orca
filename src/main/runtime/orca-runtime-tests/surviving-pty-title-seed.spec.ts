import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { HEADLESS_LEAF_ID, TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'

/**
 * #22809: after a host restart, a terminal the daemon kept alive came back with no title and no
 * status because this process never saw its OSC title. The daemon's snapshot still carries it.
 */
type TitleInternals = {
  preferTrackedLastTitle: <T extends { lastTitle?: string }>(ptyId: string, snapshot: T) => T
  ptysById: Map<string, { lastOscTitle: string | null; title: string | null }>
}

async function restartedHostWithSurvivingPty() {
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'pty-survivor' })),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
    tabId: 'tab-survivor',
    leafId: HEADLESS_LEAF_ID
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: protected title seam driven exactly as the snapshot paths drive it.
  const internals = runtime as unknown as TitleInternals
  return { internals, ptyId: created.ptyId! }
}

describe('title of a PTY that survived a host restart', () => {
  it('is restored from the provider snapshot the first time one is read', async () => {
    const { internals, ptyId } = await restartedHostWithSurvivingPty()
    expect(internals.ptysById.get(ptyId)?.lastOscTitle).toBeNull()
    internals.preferTrackedLastTitle(ptyId, { lastTitle: 'build: npm test' })
    expect(internals.ptysById.get(ptyId)?.lastOscTitle).toBe('build: npm test')
  })

  it('never overrides a title this process already observed', async () => {
    const { internals, ptyId } = await restartedHostWithSurvivingPty()
    internals.preferTrackedLastTitle(ptyId, { lastTitle: 'first' })
    internals.preferTrackedLastTitle(ptyId, { lastTitle: 'stale daemon title' })
    expect(internals.ptysById.get(ptyId)?.lastOscTitle).toBe('first')
  })

  it('never overrides a manual title', async () => {
    const { internals, ptyId } = await restartedHostWithSurvivingPty()
    const pty = internals.ptysById.get(ptyId)!
    pty.title = 'My renamed tab'
    internals.preferTrackedLastTitle(ptyId, { lastTitle: 'daemon title' })
    expect(pty.lastOscTitle).toBeNull()
  })

  it('does nothing for a snapshot without a title', async () => {
    const { internals, ptyId } = await restartedHostWithSurvivingPty()
    internals.preferTrackedLastTitle(ptyId, {})
    expect(internals.ptysById.get(ptyId)?.lastOscTitle).toBeNull()
  })
})
