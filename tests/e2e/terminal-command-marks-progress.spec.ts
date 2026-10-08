/** E2E coverage for OSC 133 command marks, prompt jumps, command-output copy and OSC 9;4 progress. */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePaneHookDescriptor,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { waitForTerminalPtyDataInjector } from './helpers/terminal-pty-injection'

type TerminalPtyDataInjectionWindow = Window & {
  __terminalPtyDataInjection?: {
    inject: (paneKey: string, data: string) => boolean
  }
}

async function injectPtyOutput(page: Page, paneKey: string, data: string): Promise<void> {
  const injected = await page.evaluate(
    ({ targetPaneKey, output }) => {
      const injectorWindow: TerminalPtyDataInjectionWindow = window
      return injectorWindow.__terminalPtyDataInjection?.inject(targetPaneKey, output) ?? false
    },
    { targetPaneKey: paneKey, output: data }
  )
  expect(injected).toBe(true)
}

async function readActiveBufferText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabId
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const buffer = pane?.terminal.buffer.active
    const lines: string[] = []
    for (let row = 0; buffer && row < buffer.length; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    return lines.join('\n')
  })
}

async function readActiveViewportY(page: Page): Promise<number> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabId
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane?.terminal.buffer.active.viewportY ?? -1
  })
}

const A = '\x1b]133;A\x07'
const C = '\x1b]133;C\x07'
const D = (code: number): string => `\x1b]133;D;${code}\x07`

test('marks prompts, jumps between them, copies command output and shows progress', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const { paneKey } = await waitForActivePaneHookDescriptor(orcaPage)
  await waitForTerminalPtyDataInjector(orcaPage, paneKey)

  const output = Array.from({ length: 240 }, (_, index) => `e2e-output-line-${index}`).join('\r\n')
  await injectPtyOutput(
    orcaPage,
    paneKey,
    `\r\n${A}$ e2e-first\r\n${C}${output}\r\n${D(3)}${A}$ e2e-second\r\n${C}done\r\n${D(0)}${A}$ `
  )

  // Why: xterm parses writes asynchronously; marks exist only once the last prompt landed.
  await expect.poll(() => readActiveBufferText(orcaPage)).toContain('$ e2e-second')

  await injectPtyOutput(orcaPage, paneKey, '\x1b]9;4;1;40\x07')
  const paneBar = orcaPage.locator('.pane .orca-terminal-progress').first()
  await expect(paneBar).toHaveAttribute('data-state', 'normal')
  await expect(paneBar).toHaveAttribute('aria-valuenow', '40')
  await expect(
    orcaPage.locator('[data-testid="sortable-tab"] .orca-terminal-progress')
  ).toHaveCount(1)
  await orcaPage.screenshot({ path: test.info().outputPath('terminal-marks-progress.png') })

  await focusActiveTerminalInput(orcaPage)
  const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
  const previousPrompt = isMac ? 'Meta+Alt+ArrowUp' : 'Control+Alt+ArrowUp'
  const bottomViewportY = await readActiveViewportY(orcaPage)
  // Why: the later prompts sit on the last page, so only the first one scrolls the viewport.
  for (let press = 0; press < 3; press += 1) {
    await orcaPage.keyboard.press(previousPrompt)
  }
  await expect.poll(() => readActiveViewportY(orcaPage)).toBeLessThan(bottomViewportY)
  await expect(orcaPage.locator('.xterm-decoration.orca-terminal-mark-flash').first()).toBeVisible()
  await expect(
    orcaPage.locator('.xterm-decoration.orca-terminal-mark[data-mark-kind="failed"]').first()
  ).toBeAttached()

  // Why not openTerminalContextMenu: it waits on a translated row, which fails under a non-English OS locale.
  await orcaPage
    .locator('.xterm:visible')
    .first()
    .click({
      button: isMac ? 'left' : 'right',
      position: { x: 40, y: 40 },
      modifiers: isMac ? ['Control'] : []
    })
  await expect(orcaPage.getByRole('menuitem', { name: 'Bookmark Line', exact: true })).toBeVisible()
  const copyOutput = orcaPage.getByRole('menuitem', { name: 'Copy Command Output', exact: true })
  await expect(copyOutput).toBeVisible()
  await copyOutput.click()
  await expect
    .poll(() => orcaPage.evaluate(() => window.api.ui.readClipboardText()), { timeout: 3_000 })
    .toContain('e2e-output-line-239')

  await injectPtyOutput(orcaPage, paneKey, '\x1b]9;4;0\x07')
  await expect(orcaPage.locator('.pane .orca-terminal-progress')).toHaveCount(0)
})
