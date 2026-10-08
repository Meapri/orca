/**
 * Shared rig for the in-grid IME preedit tests: a DOM-rendered xterm with the patched
 * `imePreeditInGrid` option, synthetic composition events, and readers for what the renderer drew.
 */
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, vi } from 'vitest'

export type Rig = {
  container: HTMLElement
  terminal: Terminal
  sent: string[]
}

const openTerminals: Terminal[] = []

export function openTerminal(
  options: { cols?: number; rows?: number; inGrid?: boolean } = {}
): Rig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({
    cols: options.cols ?? 40,
    rows: options.rows ?? 6,
    allowProposedApi: true,
    imePreeditInGrid: options.inGrid ?? true
  })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  terminal.open(container)
  openTerminals.push(terminal)
  const sent: string[] = []
  terminal.onData((data) => sent.push(data))
  return { container, terminal, sent }
}

/** Registers the canvas stub and per-test disposal; call once at the top of a test file. */
export function installGridPreeditTestHooks(): void {
  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      const context: CanvasRenderingContext2D = Object.create(null)
      context.measureText = () => Object.assign(Object.create(null), { width: 10 })
      return context
    })
  })

  afterEach(() => {
    for (const terminal of openTerminals.splice(0)) {
      terminal.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })
}

export function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

export function nextRender(terminal: Terminal): Promise<void> {
  return new Promise((resolve) => {
    const listener = terminal.onRender(() => {
      listener.dispose()
      resolve()
    })
  })
}

export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

export function compositionEvent(type: string, data: string): CompositionEvent {
  const event = new CompositionEvent(type, { bubbles: true })
  Object.defineProperty(event, 'data', { value: data })
  return event
}

export function compose(terminal: Terminal, text: string): void {
  terminal.textarea!.dispatchEvent(compositionEvent('compositionstart', ''))
  update(terminal, text)
}

export function update(terminal: Terminal, text: string): void {
  terminal.textarea!.value = text
  terminal.textarea!.dispatchEvent(compositionEvent('compositionupdate', text))
}

export async function commit(terminal: Terminal, text: string): Promise<void> {
  terminal.textarea!.value = text
  terminal.textarea!.dispatchEvent(compositionEvent('compositionend', text))
  await settle()
}

export function renderedRow(container: HTMLElement, row: number): HTMLElement {
  const element = container.querySelectorAll<HTMLElement>('.xterm-rows > div')[row]
  if (!element) {
    throw new Error(`row ${row} is not rendered`)
  }
  return element
}

export function renderedText(container: HTMLElement, row: number): string {
  return (renderedRow(container, row).textContent ?? '').replace(/ /g, ' ').trimEnd()
}

/** The rendered text before the cursor element, i.e. which cells precede the drawn cursor. */
export function textBeforeCursor(container: HTMLElement, row: number): string | null {
  const element = renderedRow(container, row)
  const cursor = element.querySelector('.xterm-cursor')
  if (!cursor) {
    return null
  }
  let text = ''
  for (const span of Array.from(element.children)) {
    if (span === cursor) {
      return text.replace(/ /g, ' ')
    }
    text += span.textContent ?? ''
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** happy-dom lays nothing out, so give xterm's measured cell a width to position against. */
export function setCellWidth(terminal: Terminal, width: number): void {
  const core: unknown = '_core' in terminal ? terminal._core : undefined
  const renderService = isRecord(core) ? core._renderService : undefined
  const dimensions = isRecord(renderService) ? renderService.dimensions : undefined
  const css = isRecord(dimensions) ? dimensions.css : undefined
  const cell = isRecord(css) ? css.cell : undefined
  if (!isRecord(cell)) {
    throw new Error('xterm render dimensions are unavailable')
  }
  cell.width = width
}

export function bufferRow(terminal: Terminal, row: number): string {
  return terminal.buffer.active.getLine(row)?.translateToString(true) ?? ''
}

export async function composeRendered(terminal: Terminal, text: string): Promise<void> {
  const rendered = nextRender(terminal)
  compose(terminal, text)
  await rendered
}

/** The underlined cells of a rendered row: what the renderer draws as preedit. */
export function underlinedText(container: HTMLElement, row: number): string {
  return Array.from(
    renderedRow(container, row).querySelectorAll('.xterm-underline-1'),
    (span) => span.textContent
  ).join('')
}
