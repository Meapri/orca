import { describe, expect, it } from 'vitest'
import { HostEditorTabStore, type HostEditorTabOpenRequest } from './host-editor-tab-store'

function memoryStorage(initial: string | null = null) {
  const state = { serialized: initial, writes: 0 }
  return {
    state,
    storage: {
      read: () => state.serialized,
      write: (serialized: string) => {
        state.serialized = serialized
        state.writes += 1
      }
    }
  }
}

const NOTES: HostEditorTabOpenRequest = {
  worktreeId: 'wt-1',
  relativePath: 'docs/notes.md',
  filePath: '/repo/docs/notes.md',
  view: 'markdown',
  mode: 'edit',
  language: 'markdown'
}

function sequentialIds(): () => string {
  let next = 0
  return () => `tab-${++next}`
}

describe('HostEditorTabStore', () => {
  it('reopens an already-open surface instead of minting a duplicate tab', () => {
    const store = new HostEditorTabStore(null, { mintId: sequentialIds() })

    const first = store.open(NOTES)
    const second = store.open(NOTES)
    const diff = store.open({ ...NOTES, view: 'file', mode: 'diff', diffSource: 'staged' })

    expect(first).toEqual({ tab: expect.objectContaining({ id: 'tab-1' }), created: true })
    expect(second).toEqual({ tab: expect.objectContaining({ id: 'tab-1' }), created: false })
    expect(diff.tab.id).toBe('tab-2')
    expect(store.list('wt-1').map((tab) => tab.id)).toEqual(['tab-1', 'tab-2'])
    expect(store.list('wt-2')).toEqual([])
  })

  it('persists opens and closes before answering, and reloads them after a restart', () => {
    const { storage, state } = memoryStorage()
    const store = new HostEditorTabStore(storage, { mintId: sequentialIds() })
    store.open(NOTES)
    store.open({ ...NOTES, relativePath: 'a.ts', filePath: '/repo/a.ts', view: 'file' })
    expect(state.writes).toBe(2)

    expect(store.close('wt-1', 'tab-1')?.relativePath).toBe('docs/notes.md')
    expect(store.close('wt-1', 'tab-1')).toBeNull()

    const restarted = new HostEditorTabStore(storage)
    expect(restarted.list('wt-1').map((tab) => tab.id)).toEqual(['tab-2'])
  })

  it('never lists an id the closed-surface ledger retired, even if a crash left it in the file', () => {
    const { storage } = memoryStorage()
    new HostEditorTabStore(storage, { mintId: () => 'retired-tab' }).open(NOTES)

    const restarted = new HostEditorTabStore(storage, { isRetired: (id) => id === 'retired-tab' })

    expect(restarted.list('wt-1')).toEqual([])
    expect(restarted.hasTabs()).toBe(false)
    // Reopening the file is a new surface, so it gets a fresh id rather than the retired one.
    expect(restarted.open(NOTES).created).toBe(true)
  })

  it('does not acknowledge an open it could not make durable', () => {
    const store = new HostEditorTabStore({
      read: () => null,
      write: () => {
        throw new Error('disk full')
      }
    })

    expect(() => store.open(NOTES)).toThrow('disk full')
    expect(store.list('wt-1')).toEqual([])
  })

  it('leaves a file from a newer schema untouched', () => {
    const newer = JSON.stringify({ schemaVersion: 99, tabs: [{ future: true }] })
    const { storage, state } = memoryStorage(newer)
    const store = new HostEditorTabStore(storage)

    store.open(NOTES)

    expect(store.list('wt-1')).toHaveLength(1)
    expect(state.serialized).toBe(newer)
  })

  it('drops one malformed row without losing the rest', () => {
    const { storage } = memoryStorage()
    new HostEditorTabStore(storage, { mintId: () => 'good' }).open(NOTES)
    const parsed = JSON.parse(storage.read() ?? '{}')
    parsed.tabs.push({ id: 'bad' })
    const store = new HostEditorTabStore({ ...storage, read: () => JSON.stringify(parsed) })

    expect(store.list('wt-1').map((tab) => tab.id)).toEqual(['good'])
  })
})
