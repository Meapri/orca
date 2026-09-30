import type { Page } from '@stablyai/playwright-test'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const STREAMING_FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/streaming-scrollback-fixture.cjs'
)

// Fractional, decaying deltas read as a trackpad to xterm's wheel classifier (no smooth animation).
const TRACKPAD_DELTAS = [-3.5, -6.25, -8.75, -7.5, -6.25, -5.5, -4.75, -3.25, -2.5, -1.75, -1.25]

type PixelScrollFrame = {
  viewportY: number
  cssOffset: number
  deviceOffset: number
  drawnOffset: number | undefined
}

type PixelScrollState = PixelScrollFrame & {
  baseY: number
  scrollTop: number
  cellHeight: number
  pixelScroll: boolean | undefined
  hasWebgl: boolean
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __pixelScrollProbe?: {
      read: () => PixelScrollState
      sampleFrames: (durationMs: number) => Promise<PixelScrollFrame[]>
      countRenders: (durationMs: number) => Promise<number>
      write: (data: string) => Promise<void>
    }
  }
}

async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Internals = {
      _core: {
        _renderService: {
          pixelScrollOffset: number
          _pixelScrollOffset: number
          dimensions: { css: { cell: { height: number } } }
          _renderer: {
            value?: {
              _pixelScrollOffset?: number
              setPixelScrollOffset?: unknown
            }
          }
        }
        _viewport: {
          _scrollableElement: {
            getScrollPosition: () => { scrollTop: number }
          }
        }
      }
    }
    const activePane = () => {
      const state = window.__store!.getState()
      const tabId =
        state.activeTabType === 'terminal'
          ? state.activeTabId
          : (state.activeTabIdByWorktree?.[state.activeWorktreeId ?? ''] ?? null)
      return window.__paneManagers!.get(tabId!)!.getActivePane()!
    }
    const internals = (): Internals['_core'] =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: e2e probe reads xterm's patched internals to observe the drawn offset.
      (activePane().terminal as unknown as Internals)._core
    const frame = (): PixelScrollFrame => {
      const core = internals()
      return {
        viewportY: activePane().terminal.buffer.active.viewportY,
        cssOffset: core._renderService.pixelScrollOffset,
        deviceOffset: core._renderService._pixelScrollOffset,
        drawnOffset: core._renderService._renderer.value?._pixelScrollOffset
      }
    }
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()))
    window.__pixelScrollProbe = {
      read: () => {
        const core = internals()
        const { terminal } = activePane()
        return {
          ...frame(),
          baseY: terminal.buffer.active.baseY,
          scrollTop: core._viewport._scrollableElement.getScrollPosition().scrollTop,
          cellHeight: core._renderService.dimensions.css.cell.height,
          pixelScroll: terminal.options.pixelScroll,
          hasWebgl: typeof core._renderService._renderer.value?.setPixelScrollOffset === 'function'
        }
      },
      sampleFrames: async (durationMs) => {
        const frames: PixelScrollFrame[] = []
        const start = performance.now()
        while (performance.now() - start < durationMs) {
          await nextFrame()
          frames.push(frame())
        }
        return frames
      },
      countRenders: async (durationMs) => {
        let renders = 0
        const subscription = activePane().terminal.onRender(() => renders++)
        await new Promise((resolve) => setTimeout(resolve, durationMs))
        subscription.dispose()
        return renders
      },
      write: (data) => new Promise<void>((resolve) => activePane().terminal.write(data, resolve))
    }
  })
}

async function forceWebgl(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store!.getState()
    window.__store!.setState({
      settings: {
        ...state.settings!,
        terminalGpuAcceleration: 'on',
        terminalCursorBlink: false
      }
    })
    const tabId =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : (state.activeTabIdByWorktree?.[state.activeWorktreeId ?? ''] ?? null)
    window.__paneManagers?.get(tabId!)?.setTerminalGpuAcceleration('on')
  })
  await expect
    .poll(() => page.evaluate(() => window.__pixelScrollProbe!.read().hasWebgl))
    .toBe(true)
}

function readState(page: Page): Promise<PixelScrollState> {
  return page.evaluate(() => window.__pixelScrollProbe!.read())
}

/** Dispatches a trackpad-like wheel burst over the screen while sampling every frame. */
async function trackpadScroll(page: Page, sampleMs: number): Promise<PixelScrollFrame[]> {
  const point = await page.evaluate(() => {
    const state = window.__store!.getState()
    const tabId = state.activeTabId
    const pane = window.__paneManagers?.get(tabId!)?.getActivePane()
    const rect = pane?.terminal.element
      ?.querySelector<HTMLElement>('.xterm-screen')
      ?.getBoundingClientRect()
    if (!rect) {
      throw new Error('terminal screen unavailable')
    }
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  await page.mouse.move(point.x, point.y)
  const sampling = page.evaluate((ms) => window.__pixelScrollProbe!.sampleFrames(ms), sampleMs)
  for (const deltaY of TRACKPAD_DELTAS) {
    await page.mouse.wheel(0, deltaY)
    await page.waitForTimeout(16)
  }
  return sampling
}

async function startScrollback(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await installProbe(page)
  await forceWebgl(page)
  const ptyId = await waitForActivePanePtyId(page)
  // Phase 1 prints 300 rows and then waits for stdin, so the buffer stays still.
  await execInTerminal(page, ptyId, `node "${STREAMING_FIXTURE_PATH}"`)
  await expect
    .poll(async () => {
      const state = await readState(page)
      return state.baseY > 100 && state.viewportY === state.baseY
    })
    .toBe(true)
}

test.describe('terminal pixel scrolling', () => {
  test('a trackpad gesture moves by pixels and settles on a whole row', async ({ orcaPage }) => {
    await startScrollback(orcaPage)
    const before = await readState(orcaPage)
    expect(before.pixelScroll).toBe(true)
    expect(before.cssOffset).toBe(0)

    const frames = await trackpadScroll(orcaPage, 1_000)
    const offsetFrames = frames.filter((frame) => frame.deviceOffset > 0)
    // Mid-gesture frames sit between rows, at more than one sub-row position.
    expect(offsetFrames.length).toBeGreaterThan(2)
    expect(new Set(offsetFrames.map((frame) => frame.deviceOffset)).size).toBeGreaterThan(2)
    for (const frame of offsetFrames) {
      expect(frame.cssOffset).toBeGreaterThan(0)
      expect(frame.cssOffset).toBeLessThan(before.cellHeight)
      // The WebGL renderer draws exactly the offset the viewport computed.
      expect(frame.drawnOffset).toBe(frame.deviceOffset)
    }
    expect(new Set(frames.map((frame) => frame.viewportY)).size).toBeGreaterThan(1)

    // Settled: whole rows, with the scroll position exactly on the drawn top row.
    const settled = await readState(orcaPage)
    expect(frames.at(-1)?.deviceOffset).toBe(0)
    expect(settled.deviceOffset).toBe(0)
    expect(settled.drawnOffset).toBe(0)
    expect(settled.viewportY).toBeLessThan(before.viewportY)
    expect(settled.scrollTop).toBeCloseTo(settled.viewportY * settled.cellHeight, 3)
    // Idle after settling: nothing keeps rendering.
    expect(await orcaPage.evaluate(() => window.__pixelScrollProbe!.countRenders(400))).toBe(0)
  })

  test('reduced motion and mouse-reporting apps keep whole-row scrolling', async ({ orcaPage }) => {
    await startScrollback(orcaPage)
    const session = await orcaPage.context().newCDPSession(orcaPage)

    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    const reduced = await trackpadScroll(orcaPage, 400)
    expect(new Set(reduced.map((frame) => frame.viewportY)).size).toBeGreaterThan(1)
    expect(reduced.every((frame) => frame.deviceOffset === 0)).toBe(true)
    await session.send('Emulation.setEmulatedMedia', { features: [] })

    // The app owns the wheel once it asks for mouse reports.
    await orcaPage.evaluate(() => window.__pixelScrollProbe!.write('\x1b[?1000h'))
    const reporting = await trackpadScroll(orcaPage, 400)
    expect(reporting.every((frame) => frame.deviceOffset === 0)).toBe(true)
    await session.detach()
  })
})
