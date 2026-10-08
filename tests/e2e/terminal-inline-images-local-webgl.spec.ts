/**
 * Hidden-window proof that a local pane on the WebGL renderer paints SIXEL, iTerm2 and Kitty
 * images from a real command, and that reattaching after a renderer reload restores clean text:
 * the daemon keeps no images, so they may go, but no payload may land in the grid and the same
 * PTY keeps working and painting images.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  assertInlineImagePixels,
  enableInlineImages,
  inlineImageProducer,
  readInlineImageState
} from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

/** The active pane's whole buffer as text, plus whether it currently renders through WebGL. */
async function readActivePane(page: Page): Promise<{ text: string; webgl: boolean }> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    const tabId =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : (state.activeTabIdByWorktree?.[state.activeWorktreeId ?? ''] ?? null)
    const manager = tabId ? window.__paneManagers?.get(tabId) : undefined
    const buffer = manager?.getActivePane()?.terminal.buffer.active
    const lines: string[] = []
    for (let row = 0; buffer && row < buffer.length; row++) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    return {
      text: lines.join('\n'),
      webgl: (manager?.getRenderingDiagnostics?.() ?? []).some((entry) => entry.hasWebgl)
    }
  })
}

function expectNoImagePayloadText(text: string): void {
  expect(text).not.toContain('1337;File')
  expect(text).not.toContain('Ga=T')
  // The PNG, SIXEL and Kitty payloads are long base64 / sixel-data runs; prose never is.
  expect(text).not.toMatch(/[A-Za-z0-9+/=~!#;-]{60,}/)
}

async function saveEvidence(source: string, name: string): Promise<void> {
  const evidenceDir = process.env.ORCA_TERMINAL_EVIDENCE_DIR
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true })
    copyFileSync(source, path.join(evidenceDir, `inline-images-${name}.png`))
  }
}

test('local WebGL pane paints inline images and reattaches to clean text after a reload', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ terminalGpuAcceleration: 'on' })
  })
  await enableInlineImages(orcaPage)
  await expect.poll(async () => (await readActivePane(orcaPage)).webgl).toBe(true)
  const ptyId = (await waitForPaneIdentitySnapshot(orcaPage, 1)).panes[0]?.ptyId
  if (!ptyId) {
    throw new Error('Terminal did not bind its PTY')
  }
  const producerPath = testInfo.outputPath('inline-image-producer.cjs')
  writeFileSync(producerPath, inlineImageProducer())

  await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producerPath, 'LOCAL_A']))
  await waitForTerminalOutput(orcaPage, 'IMAGE_PROOF_LOCAL_A', 30_000)
  const before = testInfo.outputPath('before-reload.png')
  await assertInlineImagePixels(orcaPage, before)
  await saveEvidence(before, 'before-reload')
  await expect
    .poll(() => readInlineImageState(orcaPage))
    .toMatchObject({ images: 3, pending: 0, decoderBytes: 0 })
  expectNoImagePayloadText((await readActivePane(orcaPage)).text)

  await orcaPage.reload()
  await orcaPage.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const reattached = await waitForPaneIdentitySnapshot(orcaPage, 1)
  expect(reattached.panes[0]?.ptyId).toBe(ptyId)
  await expect
    .poll(async () => (await readActivePane(orcaPage)).text, { timeout: 30_000 })
    .toContain('IMAGE_PROOF_LOCAL_A')
  expectNoImagePayloadText((await readActivePane(orcaPage)).text)
  const restored = testInfo.outputPath('after-reload.png')
  await orcaPage.screenshot({ path: restored })
  await saveEvidence(restored, 'after-reload')

  // The same PTY still takes input and the re-created addon paints the next images.
  await expect.poll(() => readInlineImageState(orcaPage), { timeout: 30_000 }).not.toBeNull()
  await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producerPath, 'LOCAL_B']))
  await waitForTerminalOutput(orcaPage, 'IMAGE_PROOF_LOCAL_B', 30_000)
  const after = testInfo.outputPath('after-reload-images.png')
  await assertInlineImagePixels(orcaPage, after)
  await saveEvidence(after, 'after-reload-images')
  await expect.poll(async () => (await readInlineImageState(orcaPage))?.images).toBe(3)
  expect((await readActivePane(orcaPage)).webgl).toBe(true)
})
