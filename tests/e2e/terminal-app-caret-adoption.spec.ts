/**
 * Hidden-window check that the WebGL renderer draws its own cursor at a caret an app paints as a
 * lone inverse cell with the cursor hidden (cursor-agent's shape, see the IME transcripts), glides
 * it on a typed move, and clears the app's inverse only at that cell. Rows are written straight
 * to the emulator; a modifier keydown arms both the adoption and the glide without PTY bytes.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { focusActiveTerminalInput, waitForActiveTerminalManager } from './helpers/terminal'

/** Whether each cell's model carries the inverse flag the renderer draws swapped colors from. */
type CellInverse = { caret: boolean; box: boolean; highlight: boolean }

type AdoptionRun = {
  frames: { animating: boolean; x: number | undefined }[]
  settled: { x: number; y: number; style: string } | undefined
  inverse: CellInverse
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __appCaretProbe?: (adopt: boolean) => Promise<AdoptionRun>
  }
}

async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Renderer = {
      _cursorMotion: { isAnimating: boolean }
      _model: { cursor?: { x: number; y: number; style: string }; cells: Uint32Array }
    }
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()))
    window.__appCaretProbe = async (adopt) => {
      const state = window.__store!.getState()
      window.__store!.setState({ settings: { ...state.settings!, terminalAdoptAppCaret: adopt } })
      // The appearance effect applies settings after the store update.
      await nextFrame()
      await nextFrame()
      const tabId =
        state.activeTabType === 'terminal'
          ? state.activeTabId
          : (state.activeTabIdByWorktree?.[state.activeWorktreeId ?? ''] ?? null)
      const manager = window.__paneManagers!.get(tabId!)!
      const pane = manager.getActivePane()!
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: e2e probe reads the internal pane map to reach the live addon.
      const internals = manager as unknown as {
        panes: Map<number, { webglAddon: { _renderer?: Renderer } | null }>
      }
      const renderer = internals.panes.get(pane.id)?.webglAddon?._renderer
      if (!renderer) {
        throw new Error('Active pane has no WebGL renderer')
      }
      const { terminal } = pane
      terminal.options.cursorBlink = false
      // A bar never recolors its cell, so the caret cell's attributes are the app's alone.
      terminal.options.cursorStyle = 'bar'
      const write = (data: string): Promise<void> =>
        new Promise((resolve) => terminal.write(data, resolve))
      const box = (text: string): string =>
        `\x1b[2;1H\x1b[2K\x1b[48;5;233m > ${text}\x1b[7m \x1b[27m      \x1b[49m`
      const pressShift = (): void => {
        terminal.textarea!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', bubbles: true })
        )
      }
      await write(`\x1b[2J\x1b[H\x1b[7m menu \x1b[27m\x1b[?25l${box('ab')}\x1b[5;1H`)
      await nextFrame()
      // The first typed move arms adoption; the cursor appears there without a glide.
      pressShift()
      await write(`${box('abc')}\x1b[5;1H`)
      await new Promise((resolve) => setTimeout(resolve, 200))
      pressShift()
      await write(`${box('abcd')}\x1b[5;1H`)
      const frames: AdoptionRun['frames'] = []
      const start = performance.now()
      while (performance.now() - start < 300) {
        await nextFrame()
        frames.push({ animating: renderer._cursorMotion.isAnimating, x: renderer._model.cursor?.x })
      }
      // FG_OFFSET of the model cell, and FgFlags.INVERSE.
      const isInverseAt = (x: number, y: number): boolean =>
        (renderer._model.cells[(y * terminal.cols + x) * 4 + 2] & 0x4000000) !== 0
      const cursor = renderer._model.cursor
      return {
        frames,
        settled: cursor && { x: cursor.x, y: cursor.y, style: cursor.style },
        // " > abcd" puts the caret at column 7 of row 1; column 6 is the box around it.
        inverse: { caret: isInverseAt(7, 1), box: isInverseAt(6, 1), highlight: isInverseAt(1, 0) }
      }
    }
  })
}

async function forceWebglWithCursorAnimation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store!.getState()
    window.__store!.setState({
      settings: { ...state.settings!, terminalGpuAcceleration: 'on', terminalCursorAnimation: true }
    })
    const tabId =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : (state.activeTabIdByWorktree?.[state.activeWorktreeId ?? ''] ?? null)
    window.__paneManagers?.get(tabId!)?.setTerminalGpuAcceleration('on')
  })
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__store!.getState()
        const tabId =
          state.activeTabType === 'terminal'
            ? state.activeTabId
            : (state.activeTabIdByWorktree?.[state.activeWorktreeId ?? ''] ?? null)
        const diagnostics = window.__paneManagers?.get(tabId!)?.getRenderingDiagnostics?.() ?? []
        return diagnostics.some((diagnostic) => diagnostic.hasWebgl)
      })
    )
    .toBe(true)
}

test.describe('terminal app-drawn caret adoption', () => {
  test('draws and glides the WebGL cursor at a lone inverse caret, clearing only its inverse', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const session = await orcaPage.context().newCDPSession(orcaPage)
    // Hidden test windows never hold OS focus; the animator is gated on terminal focus.
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await forceWebglWithCursorAnimation(orcaPage)
    await focusActiveTerminalInput(orcaPage)
    await installProbe(orcaPage)

    const adopted = await orcaPage.evaluate(() => window.__appCaretProbe!(true))
    expect(adopted.settled).toEqual({ x: 7, y: 1, style: 'bar' })
    const inFlight = adopted.frames.filter((frame) => frame.animating)
    expect(inFlight.some((frame) => frame.x !== undefined && frame.x > 6 && frame.x < 7)).toBe(true)
    const xs = adopted.frames.flatMap((frame) => (frame.x === undefined ? [] : [frame.x]))
    expect(xs.every((x, index) => index === 0 || x >= xs[index - 1])).toBe(true)
    expect(adopted.frames.at(-1)?.animating).toBe(false)
    expect(adopted.inverse).toEqual({ caret: false, box: false, highlight: true })

    const appOwned = await orcaPage.evaluate(() => window.__appCaretProbe!(false))
    expect(appOwned.settled).toBeUndefined()
    expect(appOwned.inverse).toEqual({ caret: true, box: false, highlight: true })

    await session.detach()
  })
})
