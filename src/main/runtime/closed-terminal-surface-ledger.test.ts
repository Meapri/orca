import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS } from '../../shared/closed-terminal-tab-tombstones'
import {
  ClosedTerminalSurfaceLedger,
  type ClosedTerminalSurfaceLedgerStorage
} from './closed-terminal-surface-ledger'
import {
  closedTerminalSurfaceLedgerPath,
  createClosedTerminalSurfaceLedgerFileStorage
} from './closed-terminal-surface-ledger-file'

const WT = 'repo-1::/tmp/wt'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function memoryStorage(initial: string | null = null): ClosedTerminalSurfaceLedgerStorage & {
  contents: () => string | null
} {
  let stored = initial
  return {
    read: () => stored,
    write: (serialized) => {
      stored = serialized
    },
    contents: () => stored
  }
}

describe('ClosedTerminalSurfaceLedger', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  it('retires a closed tab id for every leaf, and nothing else', () => {
    const ledger = new ClosedTerminalSurfaceLedger(memoryStorage())
    ledger.recordClosedTabs(WT, ['tab-closed'])
    expect(ledger.findRetiredSurface('tab-closed')).toMatchObject({ scope: 'tab', worktreeId: WT })
    expect(ledger.findRetiredSurface('tab-closed', LEAF_A)).toMatchObject({ scope: 'tab' })
    expect(ledger.findRetiredSurface('tab-open')).toBeNull()
    expect(ledger.findRetiredSurface('tab-open', LEAF_A)).toBeNull()
  })

  it('retires a closed split leaf without retiring its surviving siblings', () => {
    const ledger = new ClosedTerminalSurfaceLedger(memoryStorage())
    ledger.recordClosedPane(WT, 'tab-split', LEAF_A)
    expect(ledger.findRetiredSurface('tab-split', LEAF_A)).toMatchObject({ scope: 'pane' })
    expect(ledger.findRetiredSurface('tab-split', LEAF_B)).toBeNull()
    expect(ledger.findRetiredSurface('tab-split')).toBeNull()
  })

  it('issues strictly increasing revisions that survive a host restart', () => {
    const storage = memoryStorage()
    const first = new ClosedTerminalSurfaceLedger(storage)
    expect(first.recordClosedTabs(WT, ['tab-1'])).toBe(1)
    expect(first.recordClosedPane(WT, 'tab-2', LEAF_A)).toBe(2)

    const restarted = new ClosedTerminalSurfaceLedger(storage)
    expect(restarted.findRetiredSurface('tab-1')).toMatchObject({ revision: 1 })
    expect(restarted.findRetiredSurface('tab-2', LEAF_A)).toMatchObject({ revision: 2 })
    expect(restarted.recordClosedTabs(WT, ['tab-3'])).toBe(3)
  })

  it('records nothing and issues no revision for an empty close', () => {
    const storage = memoryStorage()
    const ledger = new ClosedTerminalSurfaceLedger(storage)
    expect(ledger.recordClosedTabs(WT, [])).toBeNull()
    expect(ledger.getRevision()).toBe(0)
    expect(storage.contents()).toBeNull()
  })

  it('forgets entries past the retention TTL and moves the horizon past them', () => {
    let now = 1_000_000
    const ledger = new ClosedTerminalSurfaceLedger(memoryStorage(), () => now)
    ledger.recordClosedTabs(WT, ['tab-old'])
    now += CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS + 1
    expect(ledger.findRetiredSurface('tab-old')).toBeNull()
    ledger.recordClosedTabs(WT, ['tab-new'])
    expect(ledger.getHorizonRevision()).toBe(1)
    expect(ledger.findRetiredSurface('tab-new')).not.toBeNull()
  })

  it('bounds retention by count, evicting the oldest closes first', () => {
    let now = 1
    const ledger = new ClosedTerminalSurfaceLedger(memoryStorage(), () => now++, 2)
    ledger.recordClosedTabs(WT, ['tab-1'])
    ledger.recordClosedTabs(WT, ['tab-2'])
    ledger.recordClosedTabs(WT, ['tab-3'])
    expect(ledger.findRetiredSurface('tab-1')).toBeNull()
    expect(ledger.findRetiredSurface('tab-2')).not.toBeNull()
    expect(ledger.findRetiredSurface('tab-3')).not.toBeNull()
    expect(ledger.getHorizonRevision()).toBe(1)
  })

  it('starts empty on a corrupt file instead of refusing everything', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = memoryStorage('{not json')
    const ledger = new ClosedTerminalSurfaceLedger(storage)
    expect(ledger.findRetiredSurface('tab-1')).toBeNull()
    ledger.recordClosedTabs(WT, ['tab-1'])
    expect(new ClosedTerminalSurfaceLedger(storage).findRetiredSurface('tab-1')).not.toBeNull()
  })

  it('honors a newer schema for refusals without overwriting it', () => {
    const newer = JSON.stringify({
      schemaVersion: 99,
      revision: 7,
      horizonRevision: 0,
      tabs: { 'tab-future': { closedAt: Date.now(), worktreeId: WT, revision: 7, cause: 'moved' } },
      panes: {}
    })
    const storage = memoryStorage(newer)
    const ledger = new ClosedTerminalSurfaceLedger(storage)
    expect(ledger.findRetiredSurface('tab-future')).toMatchObject({ cause: 'tab-close' })
    ledger.recordClosedTabs(WT, ['tab-local'])
    expect(storage.contents()).toBe(newer)
    // The in-memory entry still fences this run.
    expect(ledger.findRetiredSurface('tab-local')).not.toBeNull()
  })

  it('keeps fencing in memory when the durable write fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ledger = new ClosedTerminalSurfaceLedger({
      read: () => null,
      write: () => {
        throw new Error('EROFS')
      }
    })
    ledger.recordClosedTabs(WT, ['tab-1'])
    expect(ledger.findRetiredSurface('tab-1')).not.toBeNull()
  })

  it('persists to and reloads from the data-root file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-closed-surfaces-'))
    dirs.push(dir)
    const path = closedTerminalSurfaceLedgerPath(join(dir, 'nested'))
    new ClosedTerminalSurfaceLedger(
      createClosedTerminalSurfaceLedgerFileStorage(path)
    ).recordClosedTabs(WT, ['tab-disk'])
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({ revision: 1 })
    const reloaded = new ClosedTerminalSurfaceLedger(
      createClosedTerminalSurfaceLedgerFileStorage(path)
    )
    expect(reloaded.findRetiredSurface('tab-disk')).not.toBeNull()
    expect(reloaded.findRetiredSurface('tab-other')).toBeNull()
  })

  it('reads an absent file as an empty ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-closed-surfaces-'))
    dirs.push(dir)
    const storage = createClosedTerminalSurfaceLedgerFileStorage(join(dir, 'missing.json'))
    expect(storage.read()).toBeNull()
    writeFileSync(join(dir, 'present.json'), '{}')
    expect(createClosedTerminalSurfaceLedgerFileStorage(join(dir, 'present.json')).read()).toBe(
      '{}'
    )
  })

  it('maps a committed session-tab close to a tab or a leaf tombstone', () => {
    const ledger = new ClosedTerminalSurfaceLedger(memoryStorage())
    const leafOf = (parentTabId: string, leafId: string) => ({
      type: 'terminal',
      parentTabId,
      leafId
    })
    ledger.recordSessionTabClose(WT, leafOf('tab-whole', LEAF_A), ['tab-whole::x', 'tab-whole'])
    ledger.recordSessionTabClose(WT, leafOf('tab-split', LEAF_A), ['tab-split::x'])
    ledger.recordSessionTabClose(WT, { type: 'browser' }, ['browser-1'])
    expect(ledger.findRetiredSurface('tab-whole', LEAF_B)).toMatchObject({ scope: 'tab' })
    expect(ledger.findRetiredSurface('tab-split', LEAF_A)).toMatchObject({ scope: 'pane' })
    expect(ledger.findRetiredSurface('tab-split', LEAF_B)).toBeNull()
    expect(ledger.findRetiredSurface('browser-1')).toBeNull()
    expect(ledger.getRevision()).toBe(2)
  })

  it('never overwrites a file it could not read', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const write = vi.fn()
    const ledger = new ClosedTerminalSurfaceLedger({
      read: () => {
        throw new Error('EACCES')
      },
      write
    })
    ledger.recordClosedTabs(WT, ['tab-1'])
    expect(write).not.toHaveBeenCalled()
    expect(ledger.findRetiredSurface('tab-1')).not.toBeNull()
  })
})
