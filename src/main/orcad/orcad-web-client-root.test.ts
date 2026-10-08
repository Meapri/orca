import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serializeOrcadWebClientManifest } from '../../shared/orcad-artifacts'
import { resolveOrcadWebClientRoot } from './orcad-web-client-root'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-web-client-root-'))
  roots.push(root)
  return root
}

function install(files: Record<string, string>, pinned: Record<string, string> = files): string {
  const root = tempRoot()
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, 'web', path)), { recursive: true })
    writeFileSync(join(root, 'web', path), contents)
  }
  writeFileSync(
    join(root, 'web', 'orcad-web-client.json'),
    serializeOrcadWebClientManifest(
      Object.entries(pinned).map(([path, contents]) => ({
        path,
        size: Buffer.byteLength(contents),
        sha256: createHash('sha256').update(contents).digest('hex')
      }))
    )
  )
  return root
}

describe('resolveOrcadWebClientRoot', () => {
  it('serves a bundle whose files all match the manifest', async () => {
    const root = install({ 'web-index.html': '<html>', 'assets/app.js': 'x' })
    await expect(resolveOrcadWebClientRoot(root)).resolves.toEqual({ root: join(root, 'web') })
  })

  it('declines a build that shipped no bundle', async () => {
    await expect(resolveOrcadWebClientRoot(tempRoot())).resolves.toMatchObject({ root: null })
  })

  it('declines a torn bundle rather than serving a page with missing assets', async () => {
    const root = install(
      { 'web-index.html': '<html>', 'assets/app.js': 'cut' },
      { 'web-index.html': '<html>', 'assets/app.js': 'the whole file' }
    )
    await expect(resolveOrcadWebClientRoot(root)).resolves.toEqual({
      root: null,
      reason: 'web client file assets/app.js is missing or incomplete'
    })
  })
})
