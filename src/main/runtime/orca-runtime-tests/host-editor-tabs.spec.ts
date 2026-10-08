import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  HEADLESS_RUNTIME_WINDOW_ID,
  OrcaRuntimeService,
  RpcDispatcher
} from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'
import { FILE_METHODS } from '../rpc/methods/files'
import { SESSION_TAB_METHODS } from '../rpc/methods/session-tabs'
import { SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY } from '../../../shared/host-owned-surface-capabilities'
import { hashMarkdownContent } from '../../../shared/mobile-markdown-document'

type Runtime = InstanceType<typeof OrcaRuntimeService>

const WORKTREE = `id:${TEST_WORKTREE_ID}`
type Client = { clientKind: 'mobile' | 'runtime'; clientCapabilities: string[] }
const PHONE: Client = {
  clientKind: 'mobile',
  clientCapabilities: [SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY]
}
const WEB: Client = {
  clientKind: 'runtime',
  clientCapabilities: [SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY]
}
const OLD_PHONE: Client = { clientKind: 'mobile', clientCapabilities: [] }

let dir: string
let requestSeq = 0

function resultOf<T>(response: unknown, schema: z.ZodType<T>): T {
  return schema.parse(z.object({ ok: z.literal(true), result: z.unknown() }).parse(response).result)
}

function memoryFile(): { read: () => string | null; write: (serialized: string) => void } {
  let serialized: string | null = null
  return {
    read: () => serialized,
    write: (next) => {
      serialized = next
    }
  }
}

function headlessRuntime(deps?: ConstructorParameters<typeof OrcaRuntimeService>[2]): {
  runtime: Runtime
  dispatcher: InstanceType<typeof RpcDispatcher>
} {
  const runtime = new OrcaRuntimeService(store, undefined, deps)
  // The placeholder graph orcad and `orca serve` publish: headless authority, no renderer.
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  // The harness's worktree mocks name a fake path; route file reads to this test's real directory.
  Object.assign(runtime, {
    resolveRuntimeFileTarget: async () => ({
      worktree: { id: TEST_WORKTREE_ID, path: dir, repoId: 'repo-1' },
      executionHostId: 'local'
    })
  })
  return {
    runtime,
    dispatcher: new RpcDispatcher({ runtime, methods: [...FILE_METHODS, ...SESSION_TAB_METHODS] })
  }
}

async function call(
  dispatcher: InstanceType<typeof RpcDispatcher>,
  client: Client,
  method: string,
  params: unknown
) {
  return dispatcher.dispatch(
    { id: `req-${++requestSeq}`, authToken: 'tok', method, params },
    client
  )
}

async function editorRows(dispatcher: InstanceType<typeof RpcDispatcher>, client = WEB) {
  const listed = await call(dispatcher, client, 'session.tabs.list', { worktree: WORKTREE })
  expect(listed.ok).toBe(true)
  const { tabs } = resultOf(
    listed,
    z.object({ tabs: z.array(z.looseObject({ type: z.string() })) })
  )
  return tabs.filter((tab) => tab.type === 'markdown' || tab.type === 'file')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-host-editor-tabs-'))
  await writeFile(join(dir, 'notes.md'), '# Notes\n', 'utf-8')
  await writeFile(join(dir, 'app.ts'), 'export {}\n', 'utf-8')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('host-owned editor tabs on a renderer-less host', () => {
  it('opens on one client, lists on another, saves markdown, and tombstones the close', async () => {
    const { runtime, dispatcher } = headlessRuntime()

    const opened = await call(dispatcher, PHONE, 'files.open', {
      worktree: WORKTREE,
      relativePath: 'notes.md'
    })
    expect(opened).toMatchObject({ ok: true, result: { kind: 'markdown', opened: true } })
    const { tabId } = resultOf(opened, z.object({ tabId: z.string() }))

    // Client B (a web client) sees the phone's tab in the shared list.
    expect(await editorRows(dispatcher)).toEqual([
      expect.objectContaining({
        type: 'markdown',
        id: tabId,
        relativePath: 'notes.md',
        filePath: join(dir, 'notes.md'),
        sourceFileId: join(dir, 'notes.md')
      })
    ])
    // Opening the same file again activates the tab instead of duplicating it.
    await call(dispatcher, WEB, 'files.open', { worktree: WORKTREE, relativePath: 'notes.md' })
    expect(await editorRows(dispatcher)).toHaveLength(1)

    const read = await call(dispatcher, WEB, 'markdown.readTab', { worktree: WORKTREE, tabId })
    expect(read).toMatchObject({
      ok: true,
      result: { content: '# Notes\n', editable: true, version: hashMarkdownContent('# Notes\n') }
    })
    const saved = await call(dispatcher, PHONE, 'markdown.saveTab', {
      worktree: WORKTREE,
      tabId,
      baseVersion: hashMarkdownContent('# Notes\n'),
      content: '# Notes\n\nfrom the phone\n'
    })
    expect(saved).toMatchObject({ ok: true, result: { isDirty: false } })
    expect(await readFile(join(dir, 'notes.md'), 'utf-8')).toBe('# Notes\n\nfrom the phone\n')
    // Other viewers learn the document moved on.
    expect(await editorRows(dispatcher)).toEqual([
      expect.objectContaining({
        documentVersion: hashMarkdownContent('# Notes\n\nfrom the phone\n')
      })
    ])

    const closed = await call(dispatcher, PHONE, 'session.tabs.close', {
      worktree: WORKTREE,
      tabId,
      reason: 'user'
    })
    expect(closed).toMatchObject({ ok: true, result: { closed: true } })
    expect(await editorRows(dispatcher)).toEqual([])
    expect(runtime['closedTerminalSurfaceLedger'].findRetiredSurface(tabId)).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      scope: 'tab'
    })
    // A stale client addressing the retired id cannot read it back to life.
    const staleRead = await call(dispatcher, WEB, 'markdown.readTab', { worktree: WORKTREE, tabId })
    expect(staleRead.ok).toBe(false)
  })

  it('refuses a save that would clobber a concurrent disk edit', async () => {
    const { dispatcher } = headlessRuntime()
    const opened = await call(dispatcher, PHONE, 'files.open', {
      worktree: WORKTREE,
      relativePath: 'notes.md'
    })
    const { tabId } = resultOf(opened, z.object({ tabId: z.string() }))
    const read = await call(dispatcher, PHONE, 'markdown.readTab', { worktree: WORKTREE, tabId })
    const baseVersion = resultOf(read, z.object({ version: z.string() })).version
    await writeFile(join(dir, 'notes.md'), '# Notes\n\nagent edit\n', 'utf-8')

    const saved = await call(dispatcher, PHONE, 'markdown.saveTab', {
      worktree: WORKTREE,
      tabId,
      baseVersion,
      content: '# Mine\n'
    })

    expect(saved).toMatchObject({ ok: false, error: { message: 'conflict' } })
    expect(await readFile(join(dir, 'notes.md'), 'utf-8')).toBe('# Notes\n\nagent edit\n')
  })

  it('opens diff and code tabs as file tabs the phone renders from disk', async () => {
    const { dispatcher } = headlessRuntime()

    await call(dispatcher, PHONE, 'files.openDiff', {
      worktree: WORKTREE,
      relativePath: 'notes.md',
      staged: true
    })
    await call(dispatcher, PHONE, 'files.open', { worktree: WORKTREE, relativePath: 'app.ts' })

    expect(await editorRows(dispatcher, PHONE)).toEqual([
      expect.objectContaining({
        type: 'file',
        relativePath: 'notes.md',
        mode: 'diff',
        diffSource: 'staged'
      }),
      expect.objectContaining({
        type: 'file',
        relativePath: 'app.ts',
        mode: 'edit',
        language: 'typescript'
      })
    ])
  })

  it('republishes an editor-only workspace to fleet-wide lists after a host restart', async () => {
    const storage = {
      hostEditorTabStorage: memoryFile(),
      closedTerminalSurfaceLedgerStorage: memoryFile()
    }
    const before = headlessRuntime(storage)
    const opened = await call(before.dispatcher, PHONE, 'files.open', {
      worktree: WORKTREE,
      relativePath: 'app.ts'
    })
    const { tabId } = resultOf(opened, z.object({ tabId: z.string() }))

    // A fresh runtime over the same files is what a restarted orcad sees.
    const after = headlessRuntime(storage)
    const listed = await call(after.dispatcher, WEB, 'session.tabs.listAll', {})
    const { snapshots } = resultOf(
      listed,
      z.object({
        snapshots: z.array(
          z.looseObject({ worktree: z.string(), tabs: z.array(z.looseObject({ id: z.string() })) })
        )
      })
    )

    expect(snapshots.find((snapshot) => snapshot.worktree === TEST_WORKTREE_ID)?.tabs).toEqual([
      expect.objectContaining({ id: tabId, type: 'file', relativePath: 'app.ts' })
    ])
  })

  it('keeps the old refusal for a client that does not advertise host editor tabs', async () => {
    const { dispatcher } = headlessRuntime()

    for (const [method, params] of [
      ['files.open', { worktree: WORKTREE, relativePath: 'notes.md' }],
      ['files.openDiff', { worktree: WORKTREE, relativePath: 'notes.md', staged: false }]
    ] as const) {
      // Released phones fall back to their device screens on exactly this code.
      expect(await call(dispatcher, OLD_PHONE, method, params)).toMatchObject({
        ok: false,
        error: { message: 'renderer_unavailable' }
      })
    }
    expect(await editorRows(dispatcher, OLD_PHONE)).toEqual([])
  })

  it('leaves the renderer the owner when one is attached', async () => {
    const { runtime, dispatcher } = headlessRuntime()
    const openFile = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: files.open reaches only the notifier's openFile.
    runtime.setNotifier({ openFile } as never)

    const opened = await call(dispatcher, PHONE, 'files.open', {
      worktree: WORKTREE,
      relativePath: 'notes.md'
    })

    expect(opened).toMatchObject({ ok: true, result: { opened: true } })
    expect(resultOf(opened, z.looseObject({}))).not.toHaveProperty('tabId')
    expect(openFile).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      join(dir, 'notes.md'),
      'notes.md',
      undefined,
      undefined
    )
    expect(runtime['hostEditorTabs'].hasTabs()).toBe(false)
  })
})
