// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeCandidateAnchor } from './terminal-ime-candidate-anchor'
import { isTerminalImePreeditDrawn } from './terminal-ime-grid-preedit'

const FIXTURES = join(__dirname, '../../../../main/runtime/__fixtures__')
const CURSOR_AGENT_TYPED = readFileSync(join(FIXTURES, 'cursor-agent-ime-korean-typed.txt'), 'utf8')
// Its last frame repaints the input box; the same frame with one more syllable is the echo.
const CURSOR_AGENT_LAST_FRAME = CURSOR_AGENT_TYPED.slice(
  CURSOR_AGENT_TYPED.lastIndexOf(`${'\x1b[2K\x1b[1A'.repeat(5)}\x1b[2K\x1b[G`)
)

const openTerminals: Terminal[] = []

function openTerminal(
  inGrid: boolean,
  size = { cols: 40, rows: 8 }
): { terminal: Terminal; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ ...size, imePreeditInGrid: inGrid })
  terminal.open(container)
  openTerminals.push(terminal)
  return { terminal, container }
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40))
}

function compose(terminal: Terminal, text: string): void {
  const textarea = terminal.textarea!
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  textarea.value = text
  const update = new CompositionEvent('compositionupdate', { bubbles: true })
  Object.defineProperty(update, 'data', { value: text })
  textarea.dispatchEvent(update)
}

function commit(terminal: Terminal, text: string): void {
  const end = new CompositionEvent('compositionend', { bubbles: true })
  Object.defineProperty(end, 'data', { value: text })
  terminal.textarea!.dispatchEvent(end)
}

function renderedRow(container: HTMLElement, row: number): string {
  const element = container.querySelectorAll('.xterm-rows > div')[row]
  return (element?.textContent ?? '').replace(/ /g, ' ').trimEnd()
}

function screenRectReads(container: HTMLElement): ReturnType<typeof vi.fn> {
  const screen = container.querySelector<HTMLElement>('.xterm-screen')!
  const reads = vi.fn(() => new DOMRect(0, 0, 320, 136))
  screen.getBoundingClientRect = reads
  return reads
}

describe('installTerminalImeCandidateAnchor with in-grid preedit', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      const context: CanvasRenderingContext2D = Object.create(null)
      context.measureText = () => Object.assign(Object.create(null), { width: 10 })
      return context
    })
  })

  afterEach(() => {
    while (openTerminals.length > 0) {
      openTerminals.pop()?.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('leaves the ordinary cursor to xterm without measuring the screen', async () => {
    const { terminal, container } = openTerminal(true)
    await write(terminal, '$ ls')
    const reads = screenRectReads(container)
    installTerminalImeCandidateAnchor(terminal)
    compose(terminal, '한')
    await settle()

    expect(reads).not.toHaveBeenCalled()
    expect(renderedRow(container, 0)).toBe('$ ls한')
  })

  it('draws the preedit at the app-drawn caret of a captured cursor-agent screen', async () => {
    const { terminal, container } = openTerminal(true, { cols: 100, rows: 30 })
    await write(terminal, CURSOR_AGENT_TYPED)
    installTerminalImeCandidateAnchor(terminal)
    compose(terminal, '가')
    await settle()

    // The caret sat on "b"; the preedit goes there and pushes "b" right, not onto the parked row.
    expect(renderedRow(container, 9)).toBe('  → 안녕 하세요a한가b')
    expect(renderedRow(container, 14)).toBe('')
  })

  it('holds a cursor-agent commit at the caret until its repaint echoes it', async () => {
    const { terminal, container } = openTerminal(true, { cols: 100, rows: 30 })
    await write(terminal, CURSOR_AGENT_TYPED)
    installTerminalImeCandidateAnchor(terminal)
    compose(terminal, '가')
    commit(terminal, '가')
    await settle()

    expect(isTerminalImePreeditDrawn(terminal)).toBe(true)
    expect(renderedRow(container, 9)).toBe('  → 안녕 하세요a한가b')

    const echoed = CURSOR_AGENT_LAST_FRAME.replace('a한\x1b[7mb\x1b[27m  ', 'a한가\x1b[7mb\x1b[27m')
    expect(echoed).not.toBe(CURSOR_AGENT_LAST_FRAME)
    await write(terminal, echoed)
    await settle()

    expect(isTerminalImePreeditDrawn(terminal)).toBe(false)
    expect(renderedRow(container, 9)).toBe('  → 안녕 하세요a한가b')
  })

  it('follows the path the open composition started on when the option flips mid-way', async () => {
    const { terminal, container } = openTerminal(true, { cols: 100, rows: 30 })
    await write(terminal, CURSOR_AGENT_TYPED)
    const reads = screenRectReads(container)
    installTerminalImeCandidateAnchor(terminal)
    compose(terminal, '가')
    terminal.options.imePreeditInGrid = false
    const update = new CompositionEvent('compositionupdate', { bubbles: true })
    Object.defineProperty(update, 'data', { value: '각' })
    terminal.textarea!.value = '각'
    terminal.textarea!.dispatchEvent(update)
    await settle()

    expect(reads).not.toHaveBeenCalled()
    expect(renderedRow(container, 9)).toBe('  → 안녕 하세요a한각b')
  })

  it('keeps positioning the textarea itself on the overlay path', async () => {
    const { terminal, container } = openTerminal(false)
    await write(terminal, '$ ls')
    const reads = screenRectReads(container)
    installTerminalImeCandidateAnchor(terminal)
    compose(terminal, '한')

    expect(reads).toHaveBeenCalled()
    expect(terminal.textarea!.style.left).toBe('32px')
  })
})
