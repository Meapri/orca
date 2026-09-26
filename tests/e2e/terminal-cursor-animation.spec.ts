import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { focusActiveTerminalInput, waitForActiveTerminalManager } from './helpers/terminal'

type CursorMotionRun = {
  focused: boolean
  frames: { animating: boolean; x: number | undefined }[]
  idleRenders: number
}

type ProbeWindow = Window & {
  __cursorMotionProbe?: (kind: 'typed' | 'untyped' | 'jump') => Promise<CursorMotionRun>
}

async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Renderer = {
      _cursorMotion: { isAnimating: boolean }
      _model: { cursor?: { x: number } }
      _coreBrowserService: { isFocused: boolean }
    }
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()))
    ;(window as ProbeWindow).__cursorMotionProbe = async (kind) => {
      const state = window.__store!.getState()
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
      await new Promise<void>((resolve) => terminal.write('\x1b[2J\x1b[H\x1b[?25h> abc', resolve))
      await nextFrame()
      await nextFrame()
      if (kind !== 'untyped') {
        // A modifier-only keydown arms the glide without sending bytes to the PTY.
        terminal.textarea!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', bubbles: true })
        )
      }
      await new Promise<void>((resolve) =>
        terminal.write(kind === 'jump' ? '\x1b[12;1H' : 'x', resolve)
      )
      const frames: CursorMotionRun['frames'] = []
      const start = performance.now()
      while (performance.now() - start < 300) {
        await nextFrame()
        frames.push({ animating: renderer._cursorMotion.isAnimating, x: renderer._model.cursor?.x })
      }
      let idleRenders = 0
      const subscription = terminal.onRender(() => idleRenders++)
      await new Promise((resolve) => setTimeout(resolve, 500))
      subscription.dispose()
      return { focused: renderer._coreBrowserService.isFocused, frames, idleRenders }
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

function runProbe(page: Page, kind: 'typed' | 'untyped' | 'jump'): Promise<CursorMotionRun> {
  return page.evaluate((probeKind) => (window as ProbeWindow).__cursorMotionProbe!(probeKind), kind)
}

test.describe('terminal cursor animation', () => {
  test('glides typed moves, snaps the rest, and stops scheduling frames when settled', async ({
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

    const typed = await runProbe(orcaPage, 'typed')
    expect(typed.focused).toBe(true)
    const inFlight = typed.frames.filter((frame) => frame.animating)
    expect(inFlight.length).toBeGreaterThan(0)
    // Mid-glide frames sit between the old and new cell.
    expect(inFlight.some((frame) => frame.x !== undefined && frame.x > 5 && frame.x < 6)).toBe(true)
    expect(typed.frames.at(-1)?.animating).toBe(false)
    expect(typed.idleRenders).toBe(0)

    const untyped = await runProbe(orcaPage, 'untyped')
    expect(untyped.frames.some((frame) => frame.animating)).toBe(false)

    const jump = await runProbe(orcaPage, 'jump')
    expect(jump.frames.some((frame) => frame.animating)).toBe(false)

    await session.detach()
  })
})
