import type { Page } from '@stablyai/playwright-test'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const STREAMING_FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/streaming-scrollback-fixture.cjs'
)

type Viewport = { viewportY: number; baseY: number; topLine: string }

async function readViewport(page: Page): Promise<Viewport | null> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane?.terminal) {
      return null
    }
    const buffer = pane.terminal.buffer.active
    return {
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      topLine: buffer.getLine(buffer.viewportY)?.translateToString(true) ?? ''
    }
  })
}

/** Wheels once over the screen and records viewportY on every frame for 400ms. */
async function wheelAndSampleFrames(page: Page, deltaY: number): Promise<number[]> {
  const point = await page.evaluate(() => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabId ?? null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    const rect = screen?.getBoundingClientRect()
    if (!rect) {
      throw new Error('terminal screen unavailable')
    }
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  await page.mouse.move(point.x, point.y)
  const sampling = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const state = window.__store?.getState()
        const tabId = state?.activeTabId ?? null
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
        const samples: number[] = []
        const started = performance.now()
        const sample = (): void => {
          samples.push(pane?.terminal.buffer.active.viewportY ?? -1)
          if (performance.now() - started < 400) {
            requestAnimationFrame(sample)
          } else {
            resolve(samples)
          }
        }
        requestAnimationFrame(sample)
      })
  )
  await page.mouse.wheel(0, deltaY)
  return sampling
}

async function startScrollback(page: Page): Promise<string> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForActivePanePtyId(page)
  await execInTerminal(page, ptyId, `node "${STREAMING_FIXTURE_PATH}"`)
  await expect
    .poll(async () => {
      const viewport = await readViewport(page)
      return Boolean(viewport && viewport.baseY > 100 && viewport.viewportY === viewport.baseY)
    })
    .toBe(true)
  return ptyId
}

test.describe('terminal smooth scrolling', () => {
  test('a wheel notch animates through intermediate rows and settles', async ({ orcaPage }) => {
    await startScrollback(orcaPage)
    const before = await readViewport(orcaPage)
    const samples = await wheelAndSampleFrames(orcaPage, -360)

    const distinct = new Set(samples)
    const landed = samples.at(-1) ?? -1
    expect(landed).toBeLessThan(before?.viewportY ?? 0)
    // An immediate scroll shows two values (before, after); animation shows more.
    expect(distinct.size).toBeGreaterThan(2)
    // Idle after landing: the last frames all agree.
    expect(new Set(samples.slice(-5)).size).toBe(1)
  })

  test('jump to latest appears for new output and returns to following', async ({ orcaPage }) => {
    const ptyId = await startScrollback(orcaPage)
    await wheelAndSampleFrames(orcaPage, -1200)
    const pinned = await readViewport(orcaPage)
    if (!pinned) {
      throw new Error('terminal viewport unavailable')
    }
    expect(pinned.viewportY).toBeLessThan(pinned.baseY)
    const jump = orcaPage.getByRole('button', { name: 'Jump to latest' })

    // Phase-2 output streams below the reader without moving their lines.
    await sendToTerminal(orcaPage, ptyId, 'g')
    await expect(jump).toBeVisible()
    await expect(jump).toContainText('New output')
    await expect.poll(async () => (await readViewport(orcaPage))?.topLine).toBe(pinned.topLine)

    // Clicked while phase-2 output is still streaming, which outruns the animation.
    await jump.click()
    await expect
      .poll(async () => {
        const viewport = await readViewport(orcaPage)
        return viewport ? viewport.baseY - viewport.viewportY : -1
      })
      .toBe(0)
    await expect(jump).toBeHidden()
  })
})
