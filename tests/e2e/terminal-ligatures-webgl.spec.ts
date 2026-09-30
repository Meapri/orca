/**
 * Hidden-window proof that coding ligatures reach the live pane's WebGL renderer through the
 * setting: a ligated run is one model cell plus nulled followers and paints as one glyph, and it
 * falls back to per-cell glyphs under the cursor, across a selection edge, on an IME preedit row
 * and when the setting is off, while CJK glyphs beside it keep their fitted cells. The font is
 * generated so its ligatures are solid blocks; see terminal-ligature-probe-font.ts.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveTerminalManager } from './helpers/terminal'
import {
  buildLigatureProbeFont,
  LIGATURE_PROBE_FONT_FAMILY
} from './helpers/terminal-ligature-probe-font'

type Run = { label: string; row: number; col: number; cells: number }

type RunReport = Run & {
  /** Model: first cell carries the joined string, the rest are nulled. */
  joined: boolean
  /** Fraction of the run's cell box that is ink. */
  ink: number
}

type Probe = { runs: RunReport[]; dataUrl: string }

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __ligatureProbe?: {
      write: (data: string) => Promise<void>
      measure: (runs: Run[]) => Probe
      select: (col: number, row: number, length: number) => void
      clearSelection: () => void
      compose: (phase: 'start' | 'update' | 'cancel', data: string) => void
    }
  }
}

const RUNS: Run[] = [
  { label: '=>', row: 1, col: 2, cells: 2 },
  { label: '->', row: 1, col: 6, cells: 2 },
  { label: '!==', row: 1, col: 10, cells: 3 },
  { label: 'cjk =>', row: 3, col: 4, cells: 2 },
  { label: 'cjk 한', row: 3, col: 2, cells: 2 },
  { label: 'cjk 漢', row: 3, col: 6, cells: 2 }
]
const LIGATURES = new Set(['=>', '->', '!==', 'cjk =>'])
// A solid ligature block covers ~55% of its cell box; its strokes ~13%, ~21% with a bar cursor.
const LIGATED_INK = 0.4
const UNLIGATED_INK = 0.3

function report(probe: Probe, label: string): RunReport {
  const run = probe.runs.find((entry) => entry.label === label)
  if (!run) {
    throw new Error(`missing run ${label}`)
  }
  return run
}

function expectLigated(probe: Probe, label: string, ligated: boolean): void {
  const run = report(probe, label)
  expect(run.joined, `${label} joined`).toBe(ligated)
  if (ligated) {
    expect(run.ink, `${label} ink`).toBeGreaterThan(LIGATED_INK)
  } else {
    expect(run.ink, `${label} ink`).toBeLessThan(UNLIGATED_INK)
  }
}

async function forceActivePaneWebgl(page: Page): Promise<string | null> {
  const tabId = await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    return state?.activeTabType === 'terminal'
      ? state.activeTabId
      : worktreeId
        ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
        : null
  })
  if (!tabId) {
    return null
  }
  await page.evaluate(async () => {
    await window.__store!.getState().updateSettings({ terminalGpuAcceleration: 'on' })
  })
  return page
    .waitForFunction(
      (id) =>
        (window.__paneManagers?.get(id)?.getRenderingDiagnostics?.() ?? []).some(
          (diagnostic) => diagnostic.hasWebgl
        ),
      tabId,
      { timeout: 15_000 }
    )
    .then(() => tabId)
    .catch(() => null)
}

async function installProbe(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    type Renderer = {
      _canvas: HTMLCanvasElement
      _model: { cells: Uint32Array }
      dimensions: { device: { cell: { width: number; height: number } } }
    }
    type PaneInternals = {
      terminal: {
        cols: number
        buffer: { active: { viewportY: number } }
        textarea?: HTMLTextAreaElement
        select: (col: number, row: number, length: number) => void
        clearSelection: () => void
        write: (data: string, callback: () => void) => void
        _core: {
          _renderService: {
            refreshRows: (s: number, e: number, i: boolean) => void
          }
        }
      }
      webglAddon: { _renderer?: Renderer } | null
    }
    const manager = window.__paneManagers!.get(id)!
    const paneId = manager.getActivePane()!.id
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: e2e probe reads the internal pane map to reach the live addon.
    const internals = manager as unknown as {
      panes: Map<number, PaneInternals>
    }
    const pane = (): PaneInternals => internals.panes.get(paneId)!
    const COMBINED = 0x80000000
    window.__ligatureProbe = {
      write: (data) => new Promise((resolve) => pane().terminal.write(data, resolve)),
      select: (col, row, length) =>
        pane().terminal.select(col, pane().terminal.buffer.active.viewportY + row, length),
      clearSelection: () => pane().terminal.clearSelection(),
      compose: (phase, data) => {
        const textarea = pane().terminal.textarea
        if (!textarea) {
          throw new Error('terminal textarea unavailable')
        }
        const type =
          phase === 'start'
            ? 'compositionstart'
            : phase === 'update'
              ? 'compositionupdate'
              : 'compositionend'
        textarea.value = data
        const event = new CompositionEvent(type, { bubbles: true })
        Object.defineProperty(event, 'data', { value: data })
        textarea.dispatchEvent(event)
      },
      measure: (runs) => {
        const { terminal, webglAddon } = pane()
        const renderer = webglAddon?._renderer
        if (!renderer) {
          throw new Error('Active pane has no WebGL renderer')
        }
        // A WebGL canvas without preserveDrawingBuffer is only readable in the task that drew it.
        terminal._core._renderService.refreshRows(0, 30, true)
        const source = renderer._canvas
        const canvas = document.createElement('canvas')
        canvas.width = source.width
        canvas.height = source.height
        const context = canvas.getContext('2d')!
        context.drawImage(source, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        const background = [pixels[0], pixels[1], pixels[2]]
        const { width: cellWidth, height: cellHeight } = renderer.dimensions.device.cell
        const measured = runs.map((run) => {
          let ink = 0
          let total = 0
          for (let y = run.row * cellHeight; y < (run.row + 1) * cellHeight; y++) {
            for (let x = run.col * cellWidth; x < (run.col + run.cells) * cellWidth; x++) {
              const i = (y * canvas.width + x) * 4
              const delta =
                Math.abs(pixels[i] - background[0]) +
                Math.abs(pixels[i + 1] - background[1]) +
                Math.abs(pixels[i + 2] - background[2])
              ink += delta > 96 ? 1 : 0
              total++
            }
          }
          const cell = (col: number): number =>
            renderer._model.cells[(run.row * terminal.cols + col) * 4]
          const first = cell(run.col)
          let followersNulled = true
          for (let col = run.col + 1; col < run.col + run.cells; col++) {
            followersNulled &&= cell(col) === 0
          }
          return {
            ...run,
            joined: (first & COMBINED) !== 0 && run.cells > 1 && followersNulled,
            ink: total ? ink / total : 0
          }
        })
        return { runs: measured, dataUrl: canvas.toDataURL('image/png') }
      }
    }
  }, tabId)
}

async function measure(page: Page, runs: Run[]): Promise<Probe> {
  return page.evaluate((probeRuns) => window.__ligatureProbe!.measure(probeRuns), runs)
}

function saveEvidence(probe: Probe, name: string, outputPath: (name: string) => string): void {
  const targets = [outputPath(`${name}.png`)]
  const evidenceDir = process.env.ORCA_TERMINAL_EVIDENCE_DIR
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true })
    targets.push(path.join(evidenceDir, `ligatures-${name}.png`))
  }
  const png = Buffer.from(probe.dataUrl.split(',')[1] ?? '', 'base64')
  for (const target of targets) {
    writeFileSync(target, png)
  }
}

test.describe('terminal ligatures under WebGL', () => {
  test('joins coding ligatures into one glyph and breaks them at the cursor, selection and preedit', async ({
    orcaPage
  }, testInfo) => {
    await waitForActiveTerminalManager(orcaPage)
    const tabId = await forceActivePaneWebgl(orcaPage)
    if (!tabId) {
      test.skip(true, 'WebGL unavailable in this environment')
      return
    }
    const font = buildLigatureProbeFont()
    await orcaPage.evaluate(
      async ({ base64, family }) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
        const face = new FontFace(family, bytes)
        await face.load()
        document.fonts.add(face)
        await window.__store!.getState().updateSettings({
          terminalFontFamily: family,
          terminalLineHeight: 1,
          terminalCursorBlink: false,
          // A block cursor paints its cell solid, which the ink probe would read as a ligature.
          terminalCursorStyle: 'bar',
          terminalLigatures: 'on'
        })
      },
      { base64: font, family: LIGATURE_PROBE_FONT_FAMILY }
    )
    await orcaPage.waitForFunction(
      ({ id, family }) => {
        const manager = window.__paneManagers?.get(id)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: e2e probe reads the internal pane map.
        const internals = manager as unknown as {
          panes?: Map<
            number,
            {
              ligaturesAddon: unknown
              webglAddon: unknown
              terminal: { options: { fontFamily?: string } }
            }
          >
        }
        const pane = internals?.panes?.get(manager?.getActivePane()?.id ?? -1)
        return Boolean(
          pane?.ligaturesAddon &&
          pane.webglAddon &&
          String(pane.terminal.options.fontFamily).includes(family)
        )
      },
      { id: tabId, family: LIGATURE_PROBE_FONT_FAMILY },
      { timeout: 15_000 }
    )
    await installProbe(orcaPage, tabId)
    // Alternate screen keeps the shell's prompt out of the probed rows; the cursor parks on row 8.
    await orcaPage.evaluate(() =>
      window.__ligatureProbe!.write(
        '\x1b[?1049h\x1b[2J\x1b[H\r\n  =>  ->  !==  x\r\n\r\n  한=>漢\x1b[9;1H'
      )
    )

    const idle = await measure(orcaPage, RUNS)
    saveEvidence(idle, 'idle', (name) => testInfo.outputPath(name))
    for (const label of LIGATURES) {
      expectLigated(idle, label, true)
    }
    for (const label of ['cjk 한', 'cjk 漢']) {
      expect(report(idle, label).joined, label).toBe(false)
      expect(report(idle, label).ink, label).toBeGreaterThan(0.02)
    }

    // Cursor on the second cell of `=>`: only that run falls back to per-cell glyphs.
    await orcaPage.evaluate(() => window.__ligatureProbe!.write('\x1b[2;4H'))
    const underCursor = await measure(orcaPage, RUNS)
    saveEvidence(underCursor, 'cursor', (name) => testInfo.outputPath(name))
    expectLigated(underCursor, '=>', false)
    expectLigated(underCursor, '->', true)
    expectLigated(underCursor, '!==', true)

    // A selection that ends inside `!==` splits it; runs fully outside stay joined.
    await orcaPage.evaluate(() => window.__ligatureProbe!.write('\x1b[9;1H'))
    await orcaPage.evaluate(() => window.__ligatureProbe!.select(2, 1, 9))
    await expect.poll(async () => report(await measure(orcaPage, RUNS), '!==').joined).toBe(false)
    const selected = await measure(orcaPage, RUNS)
    saveEvidence(selected, 'selection', (name) => testInfo.outputPath(name))
    expect(report(selected, '=>').joined).toBe(true)
    expect(report(selected, '->').joined).toBe(true)
    expect(report(selected, '!==').joined).toBe(false)
    await orcaPage.evaluate(() => window.__ligatureProbe!.clearSelection())
    // Selection redraws are requested on the next frame.
    await expect.poll(async () => report(await measure(orcaPage, RUNS), '!==').joined).toBe(true)
    expectLigated(await measure(orcaPage, RUNS), '!==', true)

    // An in-grid preedit shifts its row's columns, so that row draws without joins.
    await orcaPage.evaluate(() => window.__ligatureProbe!.write('\x1b[2;16H'))
    await orcaPage.evaluate(() => {
      window.__ligatureProbe!.compose('start', '')
      window.__ligatureProbe!.compose('update', 'ㅎ')
    })
    const composing = await measure(orcaPage, RUNS)
    saveEvidence(composing, 'preedit', (name) => testInfo.outputPath(name))
    expect(report(composing, '=>').joined).toBe(false)
    expect(report(composing, 'cjk =>').joined).toBe(true)
    await orcaPage.evaluate(() => window.__ligatureProbe!.compose('cancel', ''))
    await orcaPage.evaluate(() => window.__ligatureProbe!.write('\x1b[9;1H'))

    // Turning the setting off rebuilds the atlas and drops the joiner without touching the grid.
    await orcaPage.evaluate(async () => {
      await window.__store!.getState().updateSettings({ terminalLigatures: 'off' })
    })
    await expect
      .poll(async () => report(await measure(orcaPage, RUNS), '=>').joined, {
        timeout: 10_000
      })
      .toBe(false)
    const off = await measure(orcaPage, RUNS)
    saveEvidence(off, 'off', (name) => testInfo.outputPath(name))
    for (const label of LIGATURES) {
      expectLigated(off, label, false)
    }
    await orcaPage.evaluate(() => window.__ligatureProbe!.write('\x1b[?1049l'))
  })
})
