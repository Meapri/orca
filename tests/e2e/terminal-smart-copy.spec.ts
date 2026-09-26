import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const FIXTURE_PATH = path.join(process.cwd(), 'tests/e2e/fixtures/terminal-smart-copy-fixture.cjs')
const COPY_CHORD = process.platform === 'darwin' ? 'Meta+c' : 'Control+Shift+c'

declare global {
  // Main-process capture of terminal clipboard writes for this spec.
  var __smartCopyWrites: string[] | undefined
}

// Substitute only the terminal clipboard write; never overwrite the user's system clipboard.
async function captureTerminalClipboard(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }) => {
    const writes: string[] = []
    globalThis.__smartCopyWrites = writes
    ipcMain.removeHandler('clipboard:writeTerminalText')
    ipcMain.handle('clipboard:writeTerminalText', (_event, text: string) => {
      writes.push(text)
    })
  })
}

function readTerminalClipboardWrites(electronApp: ElectronApplication): Promise<string[]> {
  return electronApp.evaluate(() => globalThis.__smartCopyWrites ?? [])
}

/** Selects whole buffer rows from the row containing `firstText` through the row containing `lastText`. */
async function selectRowsBetween(
  page: Page,
  firstText: string,
  lastText: string,
  exact = false
): Promise<void> {
  await page.evaluate(
    ({ firstText, lastText, exact }) => {
      const matches = (text: string, target: string): boolean =>
        exact ? text.trim() === target : text.includes(target)
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId = worktreeId ? state?.activeTabIdByWorktree?.[worktreeId] : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        throw new Error('Active terminal pane unavailable')
      }
      const buffer = pane.terminal.buffer.active
      let first = -1
      let last = -1
      for (let y = buffer.length - 1; y >= 0; y--) {
        const text = buffer.getLine(y)?.translateToString(true) ?? ''
        if (last === -1 && matches(text, lastText)) {
          last = y
        }
        if (last !== -1 && matches(text, firstText)) {
          first = y
          break
        }
      }
      if (first === -1 || last === -1) {
        throw new Error('Fixture rows not found')
      }
      pane.terminal.selectLines(first, last)
    },
    { firstText, lastText, exact }
  )
}

function readViewport(page: Page): Promise<{ viewportY: number; baseY: number }> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId = worktreeId ? state?.activeTabIdByWorktree?.[worktreeId] : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    const buffer = pane.terminal.buffer.active
    return { viewportY: buffer.viewportY, baseY: buffer.baseY }
  })
}

test.describe('terminal smart copy', () => {
  test.beforeEach(async ({ electronApp, orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await captureTerminalClipboard(electronApp)
  })

  test('copies a TUI box as clean text and confirms it', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await execInTerminal(orcaPage, ptyId, `node ${JSON.stringify(FIXTURE_PATH)} box`)
    await waitForTerminalOutput(orcaPage, 'SMART_COPY_BOX_READY')

    await selectRowsBetween(orcaPage, '╭', '╰')
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press(COPY_CHORD)

    await expect
      .poll(() => readTerminalClipboardWrites(electronApp))
      .toEqual(['The quick brown fox jumps over the lazy dog.'])
    // Why the locator: the toast text follows the app locale, which follows the host's.
    await expect(orcaPage.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(1)
    await orcaPage.screenshot({ path: testInfo.outputPath('smart-copy-toast.png') })
  })

  test('Cmd/Ctrl+C on a scrollback selection keeps the viewport under kitty release reporting', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const inputLogPath = testInfo.outputPath('kitty-input.log')
    await execInTerminal(
      orcaPage,
      ptyId,
      `node ${JSON.stringify(FIXTURE_PATH)} kitty ${JSON.stringify(inputLogPath)}`
    )
    await waitForTerminalOutput(orcaPage, 'SMART_COPY_KITTY_READY')
    try {
      await orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        const tabId = worktreeId ? state?.activeTabIdByWorktree?.[worktreeId] : null
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
        pane?.terminal.scrollToLine(20)
      })
      await selectRowsBetween(orcaPage, 'scrollback line 25', 'scrollback line 26', true)
      await focusActiveTerminalInput(orcaPage)
      const before = await readViewport(orcaPage)
      expect(before.viewportY).toBeLessThan(before.baseY)

      // Why this order: the leak needs the modifier released before C, which is
      // also the only order in which macOS delivers C's keyup at all.
      const modifiers = process.platform === 'darwin' ? ['Meta'] : ['Control', 'Shift']
      for (const modifier of modifiers) {
        await orcaPage.keyboard.down(modifier)
      }
      await orcaPage.keyboard.down('c')
      for (const modifier of modifiers) {
        await orcaPage.keyboard.up(modifier)
      }
      await orcaPage.keyboard.up('c')
      await expect
        .poll(() => readTerminalClipboardWrites(electronApp))
        .toEqual([
          `scrollback line 25${process.platform === 'win32' ? '\r\n' : '\n'}scrollback line 26`
        ])
      await orcaPage.waitForTimeout(500)
      expect((await readViewport(orcaPage)).viewportY).toBe(before.viewportY)
      const received = existsSync(inputLogPath) ? readFileSync(inputLogPath, 'utf8') : ''
      expect(received).toBe('')
    } finally {
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
    }
  })
})
