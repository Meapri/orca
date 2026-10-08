import { mkdtemp, readFile, rm, stat, writeFile, chmod, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashMarkdownContent } from '../../shared/mobile-markdown-document'
import { createLocalHostMarkdownFileAccess } from './host-markdown-file-access'
import type { HostEditorTabRecord } from './host-editor-tab-store'
import { readHostMarkdownTab, saveHostMarkdownTab } from './host-markdown-tab-document'

// The root check is the wiring's concern; these tests exercise the read and swap rules.
const authorize = async (pathValue: string): Promise<string> => pathValue

let dir: string
let filePath: string
let tab: HostEditorTabRecord

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-host-markdown-'))
  filePath = join(dir, 'notes.md')
  await writeFile(filePath, '# Notes\n', 'utf-8')
  tab = {
    id: 'tab-1',
    worktreeId: 'wt-1',
    relativePath: 'notes.md',
    filePath,
    view: 'markdown',
    mode: 'edit',
    language: 'markdown',
    openedAt: 1
  }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('host markdown tab documents', () => {
  it('reads the file with the version the desktop editor bridge would report', async () => {
    const read = await readHostMarkdownTab(
      tab,
      createLocalHostMarkdownFileAccess(filePath, authorize)
    )

    expect(read).toEqual({
      tabId: 'tab-1',
      filePath,
      relativePath: 'notes.md',
      content: '# Notes\n',
      isDirty: false,
      version: hashMarkdownContent('# Notes\n'),
      source: 'file',
      editable: true
    })
  })

  it('saves over the version the client read, keeping the file mode and leaving no temp file', async () => {
    if (process.platform !== 'win32') {
      await chmod(filePath, 0o640)
    }
    const access = createLocalHostMarkdownFileAccess(filePath, authorize)
    const { version } = await readHostMarkdownTab(tab, access)

    const saved = await saveHostMarkdownTab(tab, access, version, '# Notes\n\nmore\n')

    expect(saved).toEqual({
      tabId: 'tab-1',
      version: hashMarkdownContent('# Notes\n\nmore\n'),
      isDirty: false,
      content: '# Notes\n\nmore\n'
    })
    expect(await readFile(filePath, 'utf-8')).toBe('# Notes\n\nmore\n')
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o640)
    }
    expect(await readdir(dir)).toEqual(['notes.md'])
  })

  it('refuses with conflict when the disk changed after the client read it', async () => {
    const access = createLocalHostMarkdownFileAccess(filePath, authorize)
    const { version } = await readHostMarkdownTab(tab, access)
    await writeFile(filePath, '# Notes\n\nedited in a terminal\n', 'utf-8')

    await expect(saveHostMarkdownTab(tab, access, version, '# Mine\n')).rejects.toThrow('conflict')
    expect(await readFile(filePath, 'utf-8')).toBe('# Notes\n\nedited in a terminal\n')
  })

  it('refuses a disk edit that lands between the version check and the swap', async () => {
    const local = createLocalHostMarkdownFileAccess(filePath, authorize)
    const { version } = await readHostMarkdownTab(tab, local)
    const racing = {
      read: local.read,
      replaceIfUnchanged: async (expected: string, content: string) => {
        // Simulates another writer after saveHostMarkdownTab's own check passed.
        await writeFile(filePath, '# Raced\n', 'utf-8')
        await local.replaceIfUnchanged(expected, content)
      }
    }

    await expect(saveHostMarkdownTab(tab, racing, version, '# Mine\n')).rejects.toThrow('conflict')
    expect(await readFile(filePath, 'utf-8')).toBe('# Raced\n')
    expect(await readdir(dir)).toEqual(['notes.md'])
  })

  it('treats a duplicate save of content already on disk as success, not a conflict', async () => {
    const access = createLocalHostMarkdownFileAccess(filePath, authorize)
    const { version } = await readHostMarkdownTab(tab, access)
    await saveHostMarkdownTab(tab, access, version, '# Saved\n')

    await expect(saveHostMarkdownTab(tab, access, version, '# Saved\n')).resolves.toMatchObject({
      content: '# Saved\n',
      version: hashMarkdownContent('# Saved\n')
    })
  })

  it('refuses content over the mobile edit limit', async () => {
    const access = createLocalHostMarkdownFileAccess(filePath, authorize)
    const { version } = await readHostMarkdownTab(tab, access)

    await expect(
      saveHostMarkdownTab(tab, access, version, 'x'.repeat(256 * 1024 + 1))
    ).rejects.toThrow('file_too_large')
  })

  it('reports a binary file the way the desktop read does', async () => {
    await writeFile(filePath, Buffer.from([0x23, 0x00, 0x01]))

    await expect(
      readHostMarkdownTab(tab, createLocalHostMarkdownFileAccess(filePath, authorize))
    ).rejects.toThrow('binary_file')
  })
})
