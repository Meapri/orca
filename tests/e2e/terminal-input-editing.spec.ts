/**
 * GUI-grade input editing in a real shell: the composer box and click-to-move cursor.
 *
 * Bytes are asserted at the main-process pty:write boundary; the shell's own redraw is
 * asserted through the terminal buffer so the test proves the line editor really moved.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWrites
} from './helpers/terminal-pty-write-spy'

const isMac = process.platform === 'darwin'
const mod = isMac ? 'Meta' : 'Control'

type CellPoint = { x: number; y: number }

// Client coordinates of `needle`'s first cell on the cursor row of the active pane.
async function cursorRowCellPoint(page: Page, needle: string): Promise<CellPoint | null> {
  return page.evaluate((text) => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabId
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      return null
    }
    const buffer = pane.terminal.buffer.active
    const row = buffer.baseY + buffer.cursorY
    const line = buffer.getLine(row)
    if (!line) {
      return null
    }
    // Per cell, not one string: a non-BMP prompt glyph is two UTF-16 units in one cell.
    const cells: string[] = []
    for (let x = 0; x < pane.terminal.cols; x++) {
      cells.push(line.getCell(x)?.getChars() || ' ')
    }
    const column = cells.findIndex((_, x) => cells.slice(x).join('').startsWith(text))
    const screen = pane.container.querySelector('.xterm-screen')
    if (column === -1 || !screen) {
      return null
    }
    const rect = screen.getBoundingClientRect()
    const cellWidth = rect.width / pane.terminal.cols
    const cellHeight = rect.height / pane.terminal.rows
    return {
      x: rect.left + (column + 0.5) * cellWidth,
      y: rect.top + (row - buffer.viewportY + 0.5) * cellHeight
    }
  }, needle)
}

async function activeTerminalSelection(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const pane = window.__paneManagers?.get(state?.activeTabId ?? '')?.getActivePane?.()
    return pane?.terminal.getSelection() ?? ''
  })
}

async function cursorRowSnapshot(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const pane = window.__paneManagers?.get(state?.activeTabId ?? '')?.getActivePane?.()
    const buffer = pane?.terminal.buffer.active
    const line = buffer?.getLine(buffer.baseY + buffer.cursorY)
    return `${buffer?.baseY}:${buffer?.cursorY}:${buffer?.cursorX}:${line?.translateToString(true) ?? ''}`
  })
}

// Why: keys typed before the prompt settles are redrawn by zsh on a new row, which the
// click-to-move anchor correctly treats as unknown input start.
async function waitForSettledPrompt(page: Page): Promise<void> {
  let previous = ''
  await expect
    .poll(
      async () => {
        const current = await cursorRowSnapshot(page)
        const settled = current === previous && !current.endsWith(':0:')
        previous = current
        return settled
      },
      { timeout: 10_000, intervals: [300] }
    )
    .toBe(true)
}

test.describe.configure({ mode: 'serial' })
test.describe('Terminal input editing', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const hasPaneManager = await waitForActiveTerminalManager(orcaPage, 30_000)
      .then(() => true)
      .catch(() => false)
    test.skip(!hasPaneManager, 'Electron automation never mounted the live TerminalPane manager.')
    await waitForPaneCount(orcaPage, 1, 30_000)
  })

  test('composer sends multi-line text through the paste path and submits', async ({
    orcaPage,
    electronApp
  }) => {
    await installTerminalPtyWriteSpy(electronApp)
    await waitForActivePanePtyId(orcaPage)
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press(`${mod}+Shift+Period`)
    const composer = orcaPage.locator('[data-terminal-composer-root] textarea')
    await expect(composer).toBeFocused()

    const runId = Date.now().toString(36)
    await composer.pressSequentially(`echo COMPOSED_A_${runId}`)
    await orcaPage.keyboard.press('Enter')
    await composer.pressSequentially(`echo COMPOSED_B_${runId}`)
    await expect(composer).toHaveValue(`echo COMPOSED_A_${runId}\necho COMPOSED_B_${runId}`)

    await clearTerminalPtyWriteLog(electronApp)
    await orcaPage.keyboard.press(`${mod}+Enter`)
    await expect(composer).toBeHidden()
    // Twice per marker: the echoed command line plus the command's own output.
    for (const marker of [`COMPOSED_A_${runId}`, `COMPOSED_B_${runId}`]) {
      await expect
        .poll(async () => (await getTerminalContent(orcaPage)).split(marker).length - 1, {
          timeout: 10_000
        })
        .toBeGreaterThanOrEqual(2)
    }
    const writes = (await readTerminalPtyWrites(electronApp)).join('')
    expect(writes).toContain(`echo COMPOSED_A_${runId}\recho COMPOSED_B_${runId}`)
    expect(writes.endsWith('\r')).toBe(true)
  })

  test('Escape closes the composer and keeps the draft for the pane', async ({ orcaPage }) => {
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press(`${mod}+Shift+Period`)
    const composer = orcaPage.locator('[data-terminal-composer-root] textarea')
    await composer.pressSequentially('draft kept')
    await orcaPage.keyboard.press('Escape')
    await expect(composer).toBeHidden()
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press(`${mod}+Shift+Period`)
    await expect(composer).toHaveValue('draft kept')
    await composer.fill('')
    await orcaPage.keyboard.press('Escape')
  })

  test('clicking the prompt line moves the shell cursor by characters', async ({
    orcaPage,
    electronApp
  }) => {
    await installTerminalPtyWriteSpy(electronApp)
    const runId = Date.now().toString(36).toUpperCase()
    await focusActiveTerminalInput(orcaPage)
    await waitForSettledPrompt(orcaPage)
    await orcaPage.keyboard.type(`echo 한글Z${runId}`)
    await waitForTerminalOutput(orcaPage, `echo 한글Z${runId}`, 10_000)
    const target = await cursorRowCellPoint(orcaPage, '한')
    if (!target) {
      throw new Error('typed input not found on the cursor row')
    }

    await clearTerminalPtyWriteLog(electronApp)
    await orcaPage.mouse.click(target.x, target.y)
    // 한 and 글 are one press each even though each spans two cells.
    const expected = '\x1b[D'.repeat(3 + runId.length)
    await expect
      .poll(async () => (await readTerminalPtyWrites(electronApp)).join(''), { timeout: 5_000 })
      .toBe(expected)

    await orcaPage.keyboard.type('X')
    await expect
      .poll(async () => getTerminalContent(orcaPage, 4000), { timeout: 5_000 })
      .toContain(`echo X한글Z${runId}`)
    await orcaPage.keyboard.press(`Control+U`)
  })

  test('dragging over a word on the prompt and pressing Backspace deletes it, and undo restores it', async ({
    orcaPage,
    electronApp
  }) => {
    await installTerminalPtyWriteSpy(electronApp)
    const runId = Date.now().toString(36).toUpperCase()
    await focusActiveTerminalInput(orcaPage)
    await waitForSettledPrompt(orcaPage)
    const tail = ` gamma${runId}`
    await orcaPage.keyboard.type(`echo alpha beta${tail}`)
    await waitForTerminalOutput(orcaPage, `echo alpha beta${tail}`, 10_000)
    const start = await cursorRowCellPoint(orcaPage, 'beta')
    const after = await cursorRowCellPoint(orcaPage, tail)
    if (!start || !after) {
      throw new Error('typed input not found on the cursor row')
    }

    // From the left edge of "b" to the left edge of the space after "beta".
    const halfCell = (after.x - start.x) / 'beta'.length / 2
    await orcaPage.mouse.move(start.x - halfCell + 1, start.y)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(after.x - halfCell + 1, after.y, { steps: 6 })
    await orcaPage.mouse.up()
    await expect.poll(() => activeTerminalSelection(orcaPage)).toBe('beta')

    await clearTerminalPtyWriteLog(electronApp)
    await orcaPage.keyboard.press('Backspace')
    await expect
      .poll(async () => (await readTerminalPtyWrites(electronApp)).join(''), { timeout: 5_000 })
      .toBe(`${'\x1b[D'.repeat(tail.length)}${'\x7f'.repeat(4)}`)
    await expect
      .poll(async () => getTerminalContent(orcaPage, 4000), { timeout: 5_000 })
      .toContain(`echo alpha ${tail}`)

    await clearTerminalPtyWriteLog(electronApp)
    await orcaPage.keyboard.press(`${mod}+z`)
    await expect
      .poll(async () => (await readTerminalPtyWrites(electronApp)).join(''), { timeout: 5_000 })
      .toBe('beta')
    await expect
      .poll(async () => getTerminalContent(orcaPage, 4000), { timeout: 5_000 })
      .toContain(`echo alpha beta${tail}`)
    await orcaPage.keyboard.press(`Control+U`)
  })

  test('Shift+Arrow selects typed text and typing replaces it', async ({
    orcaPage,
    electronApp
  }) => {
    await installTerminalPtyWriteSpy(electronApp)
    const runId = Date.now().toString(36).toUpperCase()
    await focusActiveTerminalInput(orcaPage)
    await waitForSettledPrompt(orcaPage)
    await orcaPage.keyboard.type(`echo ${runId}abc`)
    await waitForTerminalOutput(orcaPage, `echo ${runId}abc`, 10_000)

    await clearTerminalPtyWriteLog(electronApp)
    for (let i = 0; i < 3; i++) {
      await orcaPage.keyboard.press('Shift+ArrowLeft')
    }
    await expect.poll(() => activeTerminalSelection(orcaPage)).toBe('abc')
    // The selection is Orca's; the shell never saw the Shift+Arrow presses.
    expect(await readTerminalPtyWrites(electronApp)).toEqual([])

    await orcaPage.keyboard.type('Z')
    await expect
      .poll(async () => (await readTerminalPtyWrites(electronApp)).join(''), { timeout: 5_000 })
      .toBe(`${'\x7f'.repeat(3)}Z`)
    await expect
      .poll(async () => getTerminalContent(orcaPage, 4000), { timeout: 5_000 })
      .toContain(`echo ${runId}Z`)
    await orcaPage.keyboard.press(`Control+U`)
  })
})
