/**
 * CJK fallback glyphs must render inside their two cells under both renderers:
 * no ink bleeding into the neighbouring cell or row, and box-drawing frames that
 * stay connected when lineHeight > 1. Set ORCA_GLYPH_SCREENSHOT_DIR to also keep
 * PNG captures for manual review.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveTerminalManager } from './helpers/terminal'

type ProbeTerminal = {
  rows: number
  cols: number
  element?: HTMLElement
  options: Record<string, unknown>
  _core: {
    _renderService: {
      _isPaused: boolean
      _needsFullRefresh: boolean
      refreshRows: (start: number, end: number, immediate: boolean) => void
      dimensions: { css: { cell: { width: number; height: number } } }
    }
  }
  dispose: () => void
  loadAddon: (addon: ProbeWebglAddon) => void
  open: (element: HTMLElement) => void
  write: (data: string, callback: () => void) => void
}

type ProbeWebglAddon = {
  _renderer: {
    _canvas: HTMLCanvasElement
    dimensions: { device: { cell: { width: number; height: number } } }
  }
}

type PaneInternals = {
  terminal: ProbeTerminal & { constructor: new (options: Record<string, unknown>) => ProbeTerminal }
  webglAddon: (ProbeWebglAddon & { constructor: new () => ProbeWebglAddon }) | null
}

type CellInkReport = {
  label: string
  inkInside: number
  inkLeftNeighbour: number
  inkRightNeighbour: number
  inkRowAbove: number
  inkRowBelow: number
  inkBottomRow: number
}

type WebglProbeResult = {
  fontFamily: string
  lineHeight: number
  cellWidth: number
  cellHeight: number
  glyphs: CellInkReport[]
  boxGapRows: number
  dataUrl: string
}

type DomGlyphRect = { label: string; width: number; left: number; cellLeft: number }

type DomProbeResult = {
  lineHeight: number
  cellWidth: number
  glyphs: DomGlyphRect[]
}

// Why isolated rows: each probed glyph gets blank cells on both sides and blank rows
// above and below, so any ink found there is overflow from that glyph.
type ProbeGlyph = { label: string; glyph: string; cells: number }

const PROBE_GLYPHS: ProbeGlyph[] = [
  { label: 'latin H', glyph: 'H', cells: 1 },
  { label: 'hangul', glyph: '한', cells: 2 },
  { label: 'hangul', glyph: '글', cells: 2 },
  { label: 'hangul jamo', glyph: 'ㅎ', cells: 2 },
  { label: 'han', glyph: '漢', cells: 2 },
  { label: 'han simplified', glyph: '语', cells: 2 },
  { label: 'hiragana', glyph: 'か', cells: 2 },
  { label: 'katakana', glyph: 'カ', cells: 2 },
  { label: 'fullwidth A', glyph: 'Ａ', cells: 2 }
]

async function forceActivePaneWebgl(page: Page): Promise<void> {
  const tabId = await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    return state?.activeTabType === 'terminal'
      ? state.activeTabId
      : worktreeId
        ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
        : null
  })
  expect(tabId).toBeTruthy()
  await page.evaluate(
    (id) => window.__paneManagers?.get(id ?? '')?.setTerminalGpuAcceleration?.('on'),
    tabId
  )
  await page.waitForFunction(
    (id) =>
      (window.__paneManagers?.get(id ?? '')?.getRenderingDiagnostics?.() ?? []).some(
        (diagnostic) => diagnostic.hasWebgl
      ),
    tabId,
    { timeout: 15_000 }
  )
}

async function probeWebgl(page: Page, lineHeight: number): Promise<WebglProbeResult> {
  return page.evaluate(
    async ({ glyphs, lineHeight: probeLineHeight }) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId = worktreeId ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null) : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the e2e build exposes the pane manager; panes is its private pane map.
      const panes = (manager as unknown as { panes?: Map<number, PaneInternals> })?.panes
      const pane = [...(panes?.values() ?? [])][0]
      if (!pane?.webglAddon) {
        throw new Error('Active pane WebGL internals unavailable')
      }
      const fontFamily = String(pane.terminal.options.fontFamily)
      const host = document.createElement('div')
      host.style.cssText =
        'position:fixed;left:0;top:0;width:900px;height:900px;opacity:0.001;pointer-events:none;z-index:-1;background:#000'
      document.body.appendChild(host)
      const terminal = new pane.terminal.constructor({
        cols: 30,
        rows: glyphs.length * 2 + 8,
        fontSize: pane.terminal.options.fontSize,
        fontFamily,
        fontWeight: pane.terminal.options.fontWeight,
        fontWeightBold: pane.terminal.options.fontWeightBold,
        lineHeight: probeLineHeight,
        rescaleOverlappingGlyphs: true,
        cursorBlink: false,
        allowProposedApi: true,
        theme: { background: '#000000', foreground: '#ffffff', cursor: '#000000' }
      })
      terminal.open(host)
      const addon = new pane.webglAddon.constructor()
      terminal.loadAddon(addon)
      const write = (data: string): Promise<void> =>
        new Promise((resolve) => terminal.write(data, resolve))
      // Probe rows at 1, 3, 5…; each glyph starts at column 2.
      let content = '\x1b[?25l\r\n'
      for (const { glyph } of glyphs) {
        content += `  ${glyph}\r\n\r\n`
      }
      // Box frame: the vertical bars must stay connected across rows at any line height.
      content += '  ┌──┬──┐\r\n  │한│ab│\r\n  ├──┼──┤\r\n  │漢│か│\r\n  └──┴──┘\r\n'
      content += '  a한b漢cかd ①※→ ❤️1️⃣🥲'
      await write(content)
      await document.fonts.ready
      terminal._core._renderService._isPaused = false
      terminal._core._renderService.refreshRows(0, terminal.rows - 1, true)
      const source = addon._renderer._canvas
      const cellWidth = addon._renderer.dimensions.device.cell.width
      const cellHeight = addon._renderer.dimensions.device.cell.height
      const canvas = document.createElement('canvas')
      canvas.width = source.width
      canvas.height = source.height
      const context = canvas.getContext('2d')
      if (!context) {
        throw new Error('capture context unavailable')
      }
      context.drawImage(source, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      const isInk = (x: number, y: number): boolean => {
        const i = (y * canvas.width + x) * 4
        return pixels[i] + pixels[i + 1] + pixels[i + 2] > 96
      }
      const countInk = (x0: number, y0: number, x1: number, y1: number): number => {
        let count = 0
        for (
          let y = Math.max(0, Math.round(y0));
          y < Math.min(canvas.height, Math.round(y1));
          y++
        ) {
          for (
            let x = Math.max(0, Math.round(x0));
            x < Math.min(canvas.width, Math.round(x1));
            x++
          ) {
            if (isInk(x, y)) {
              count += 1
            }
          }
        }
        return count
      }
      const reports = glyphs.map(({ label, glyph, cells }, index) => {
        const row = 1 + index * 2
        const top = row * cellHeight
        const left = 2 * cellWidth
        const right = left + cells * cellWidth
        let inkBottomRow = -1
        for (
          let y = Math.round(top + cellHeight) - 1;
          y >= Math.round(top) && inkBottomRow < 0;
          y--
        ) {
          if (countInk(left, y, right, y + 1) > 0) {
            inkBottomRow = y - Math.round(top)
          }
        }
        return {
          label: `${label} ${glyph}`,
          inkInside: countInk(left, top, right, top + cellHeight),
          inkLeftNeighbour: countInk(left - cellWidth, top, left, top + cellHeight),
          inkRightNeighbour: countInk(right, top, right + cellWidth, top + cellHeight),
          inkRowAbove: countInk(left, top - cellHeight, right, top),
          inkRowBelow: countInk(left, top + cellHeight, right, top + 2 * cellHeight),
          inkBottomRow
        }
      })
      // Scan the frame's left bar (column 2) from the ┌ stroke down to the └ stroke.
      const boxTop = (1 + glyphs.length * 2) * cellHeight
      let boxGapRows = 0
      const barStart = Math.ceil(boxTop + cellHeight / 2) + 1
      const barEnd = Math.floor(boxTop + 4.5 * cellHeight) - 1
      for (let y = barStart; y < barEnd; y++) {
        if (countInk(2 * cellWidth, y, 3 * cellWidth, y + 1) === 0) {
          boxGapRows += 1
        }
      }
      const dataUrl = canvas.toDataURL('image/png')
      terminal.dispose()
      host.remove()
      return {
        fontFamily,
        lineHeight: probeLineHeight,
        cellWidth,
        cellHeight,
        glyphs: reports,
        boxGapRows,
        dataUrl
      }
    },
    { glyphs: PROBE_GLYPHS, lineHeight }
  )
}

async function probeDom(page: Page, lineHeight: number): Promise<DomProbeResult> {
  return page.evaluate(
    async ({ glyphs, lineHeight: probeLineHeight }) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId = worktreeId ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null) : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the e2e build exposes the pane manager; panes is its private pane map.
      const panes = (manager as unknown as { panes?: Map<number, PaneInternals> })?.panes
      const pane = [...(panes?.values() ?? [])][0]
      if (!pane) {
        throw new Error('Active pane unavailable')
      }
      const host = document.createElement('div')
      host.style.cssText =
        'position:fixed;left:0;top:0;width:900px;height:900px;opacity:0.001;pointer-events:none;z-index:-1'
      document.body.appendChild(host)
      const terminal = new pane.terminal.constructor({
        cols: 30,
        rows: glyphs.length + 2,
        fontSize: pane.terminal.options.fontSize,
        fontFamily: pane.terminal.options.fontFamily,
        fontWeight: pane.terminal.options.fontWeight,
        lineHeight: probeLineHeight,
        cursorBlink: false,
        allowProposedApi: true
      })
      terminal.open(host)
      await new Promise<void>((resolve) =>
        terminal.write(glyphs.map(({ glyph }) => `  ${glyph}  x`).join('\r\n'), resolve)
      )
      await document.fonts.ready
      terminal._core._renderService._isPaused = false
      terminal._core._renderService.refreshRows(0, terminal.rows - 1, true)
      const cellWidth = terminal._core._renderService.dimensions.css.cell.width
      const rows = [...(terminal.element?.querySelectorAll('.xterm-rows > div') ?? [])]
      const screenLeft =
        terminal.element?.querySelector('.xterm-rows')?.getBoundingClientRect().left ?? 0
      const rects = glyphs.map(({ label, glyph }, index) => {
        const row = rows[index]
        const walker = document.createTreeWalker(row ?? document.body, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node && !(node.textContent ?? '').includes(glyph)) {
          node = walker.nextNode()
        }
        const range = document.createRange()
        const offset = (node?.textContent ?? '').indexOf(glyph)
        if (node && offset !== -1) {
          range.setStart(node, offset)
          range.setEnd(node, offset + glyph.length)
        }
        const rect = range.getBoundingClientRect()
        return {
          label: `${label} ${glyph}`,
          width: rect.width,
          left: rect.left - screenLeft,
          cellLeft: 2 * cellWidth
        }
      })
      terminal.dispose()
      host.remove()
      return { lineHeight: probeLineHeight, cellWidth, glyphs: rects }
    },
    { glyphs: PROBE_GLYPHS, lineHeight }
  )
}

test.describe('terminal CJK glyph cell fit', () => {
  test('keeps CJK fallback glyphs inside their cells under WebGL and DOM', async ({ orcaPage }) => {
    await waitForActiveTerminalManager(orcaPage)
    await forceActivePaneWebgl(orcaPage)
    const screenshotDir = process.env.ORCA_GLYPH_SCREENSHOT_DIR

    for (const lineHeight of [1, 1.4]) {
      const webgl = await probeWebgl(orcaPage, lineHeight)
      if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true })
        writeFileSync(
          path.join(screenshotDir, `webgl-lh${lineHeight}.png`),
          Buffer.from(webgl.dataUrl.split(',')[1] ?? '', 'base64')
        )
        writeFileSync(
          path.join(screenshotDir, `webgl-lh${lineHeight}.json`),
          JSON.stringify({ ...webgl, dataUrl: undefined }, null, 2)
        )
      }
      for (const glyph of webgl.glyphs) {
        expect(glyph.inkInside, glyph.label).toBeGreaterThan(0)
        expect(glyph.inkLeftNeighbour, glyph.label).toBe(0)
        expect(glyph.inkRightNeighbour, glyph.label).toBe(0)
        expect(glyph.inkRowAbove, glyph.label).toBe(0)
        expect(glyph.inkRowBelow, glyph.label).toBe(0)
      }
      // customGlyphs (on by default in the WebGL addon) draws box bars edge to edge.
      expect(webgl.boxGapRows).toBe(0)

      const dom = await probeDom(orcaPage, lineHeight)
      if (screenshotDir) {
        writeFileSync(
          path.join(screenshotDir, `dom-lh${lineHeight}.json`),
          JSON.stringify(dom, null, 2)
        )
      }
      for (const [index, glyph] of dom.glyphs.entries()) {
        const cells = PROBE_GLYPHS[index]?.cells ?? 1
        expect(glyph.width, glyph.label).toBeGreaterThan(0)
        expect(glyph.width, glyph.label).toBeLessThanOrEqual(cells * dom.cellWidth + 0.5)
        expect(Math.abs(glyph.left - glyph.cellLeft), glyph.label).toBeLessThanOrEqual(1)
      }
    }
  })
})
