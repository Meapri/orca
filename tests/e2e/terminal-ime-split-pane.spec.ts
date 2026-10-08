/**
 * IME composition in a split terminal: the preedit, the helper textarea the OS anchors its
 * candidate window to, and the committed bytes all belong to the pane that has focus.
 *
 * Composition is driven through CDP `Input.imeSetComposition` (see terminal-ime-cdp-composition),
 * so this runs headless; the candidate window itself is the OS's, anchored at the focused
 * textarea's caret rect, which is what the geometry assertions read.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { commitImeText, setImeComposition } from './terminal-ime-cdp-composition'
import { focusActiveTerminalInput, getTerminalContent, waitForPaneCount } from './helpers/terminal'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWriteEntries
} from './helpers/terminal-pty-write-spy'

const isMac = process.platform === 'darwin'
const splitRightChord = isMac ? 'Meta+d' : 'Control+Shift+d'

type PaneGeometry = {
  paneId: number
  textareaFocused: boolean
  screen: { left: number; top: number; right: number; bottom: number }
  textarea: { left: number; top: number }
  expected: { left: number; top: number }
  cell: { width: number; height: number }
}

/** Where the focused pane's helper textarea sits, against its own cursor cell. */
async function activePaneGeometry(page: Page): Promise<PaneGeometry> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const manager = window.__paneManagers?.get(state?.activeTabId ?? '')
    const pane = manager?.getActivePane?.()
    const textarea = pane?.terminal.textarea
    const screen = pane?.container.querySelector('.xterm-screen')
    if (!pane || !textarea || !screen) {
      throw new Error('no active terminal pane')
    }
    const screenRect = screen.getBoundingClientRect()
    const cell = {
      width: screenRect.width / pane.terminal.cols,
      height: screenRect.height / pane.terminal.rows
    }
    const buffer = pane.terminal.buffer.active
    const textareaRect = textarea.getBoundingClientRect()
    return {
      paneId: pane.id,
      textareaFocused: document.activeElement === textarea,
      screen: {
        left: screenRect.left,
        top: screenRect.top,
        right: screenRect.right,
        bottom: screenRect.bottom
      },
      textarea: { left: textareaRect.left, top: textareaRect.top },
      expected: {
        left: screenRect.left + buffer.cursorX * cell.width,
        top: screenRect.top + (buffer.baseY + buffer.cursorY - buffer.viewportY) * cell.height
      },
      cell
    }
  })
}

async function activePaneTextAt(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const pane = window.__paneManagers?.get(state?.activeTabId ?? '')?.getActivePane?.()
    const buffer = pane?.terminal.buffer.active
    return buffer?.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? ''
  })
}

async function activePtyId(page: Page): Promise<string> {
  let ptyId = ''
  await expect
    .poll(
      async () => {
        ptyId = await page.evaluate(() => {
          const state = window.__store?.getState()
          const pane = window.__paneManagers?.get(state?.activeTabId ?? '')?.getActivePane?.()
          return pane?.container?.dataset?.ptyId ?? ''
        })
        return ptyId
      },
      { timeout: 15_000, message: 'the split pane never bound a PTY' }
    )
    .not.toBe('')
  return ptyId
}

async function splitRightAndFocus(page: Page): Promise<void> {
  await page.keyboard.press(splitRightChord)
  await waitForPaneCount(page, 2, 15_000)
  await focusActiveTerminalInput(page)
  await expect.poll(() => getTerminalContent(page), { timeout: 15_000 }).not.toBe('')
}

test.describe('Terminal IME in split panes', () => {
  test('composes into the focused split pane with the candidate anchored at its cursor', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      await installTerminalPtyWriteSpy(electronApp)
      const leftPty = arena.ptyId
      await splitRightAndFocus(orcaPage)
      const rightPty = await activePtyId(orcaPage)
      expect(rightPty).not.toBe(leftPty)

      await clearTerminalPtyWriteLog(electronApp)
      await setImeComposition(arena.session, '한')
      await expect.poll(() => activePaneTextAt(orcaPage)).not.toContain('한')
      const geometry = await activePaneGeometry(orcaPage)
      expect(geometry.textareaFocused).toBe(true)
      // The OS reads the focused textarea's rect: it must sit on this pane's cursor cell, inside
      // this pane's screen, not at the other pane's cursor or the window origin.
      expect(geometry.textarea.left).toBeGreaterThanOrEqual(geometry.screen.left - 1)
      expect(geometry.textarea.left).toBeLessThan(geometry.screen.right)
      expect(Math.abs(geometry.textarea.left - geometry.expected.left)).toBeLessThanOrEqual(1.5)
      expect(Math.abs(geometry.textarea.top - geometry.expected.top)).toBeLessThanOrEqual(1.5)

      await commitImeText(arena.session, '한')
      await expect
        .poll(async () =>
          (await readTerminalPtyWriteEntries(electronApp))
            .filter((entry) => entry.data.includes('한'))
            .map((entry) => entry.id)
        )
        .toEqual([rightPty])
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'split-pane-ime', !completed)
    }
  })

  test('a composition open when the other pane is clicked commits to the pane it was typed in', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      await installTerminalPtyWriteSpy(electronApp)
      const leftPty = arena.ptyId
      await splitRightAndFocus(orcaPage)
      const rightPty = await activePtyId(orcaPage)
      const right = await activePaneGeometry(orcaPage)

      await clearTerminalPtyWriteLog(electronApp)
      await setImeComposition(arena.session, '하')
      // Click the middle of the left pane: focus moves while the syllable is still composing.
      const leftPoint = await orcaPage.evaluate((rightPaneId) => {
        const state = window.__store?.getState()
        const manager = window.__paneManagers?.get(state?.activeTabId ?? '')
        const left = manager?.getPanes?.().find((pane) => pane.id !== rightPaneId)
        const rect = left?.container.querySelector('.xterm-screen')?.getBoundingClientRect()
        return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
      }, right.paneId)
      if (!leftPoint) {
        throw new Error('the left pane has no screen')
      }
      await orcaPage.mouse.click(leftPoint.x, leftPoint.y)
      await expect
        .poll(async () => (await activePaneGeometry(orcaPage)).paneId)
        .not.toBe(right.paneId)

      await expect
        .poll(async () =>
          (await readTerminalPtyWriteEntries(electronApp))
            .filter((entry) => entry.data.includes('하'))
            .map((entry) => entry.id)
        )
        .toEqual([rightPty])
      const leftWrites = (await readTerminalPtyWriteEntries(electronApp)).filter(
        (entry) => entry.id === leftPty && /[가-힣]/.test(entry.data)
      )
      expect(leftWrites).toEqual([])
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'split-pane-ime-focus', !completed)
    }
  })
})
