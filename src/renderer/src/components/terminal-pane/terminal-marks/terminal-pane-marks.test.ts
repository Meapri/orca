// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { IDecoration, IDecorationOptions } from '@xterm/xterm'
import {
  getTerminalPaneMarks,
  installTerminalPaneMarks,
  type TerminalMarksHost
} from './terminal-pane-marks'

type FakeDecoration = IDecoration & {
  requested: IDecorationOptions
  dispose: ReturnType<typeof vi.fn<() => void>>
  renderKind: () => string | undefined
}

function createHarness(options: { decorationsEnabled?: boolean } = {}) {
  const headless = new HeadlessTerminal({
    cols: 30,
    rows: 4,
    scrollback: 100,
    allowProposedApi: true
  })
  const decorations: FakeDecoration[] = []
  const registerDecoration = vi.fn((requested: IDecorationOptions): IDecoration => {
    const renderListeners: ((element: HTMLElement) => void)[] = []
    const decoration: FakeDecoration = {
      requested,
      marker: requested.marker,
      element: undefined,
      options: {},
      isDisposed: false,
      onDispose: () => ({ dispose: () => {} }),
      onRender: (listener) => {
        renderListeners.push(listener)
        return { dispose: () => {} }
      },
      dispose: vi.fn<() => void>(),
      renderKind: () => {
        const element = document.createElement('div')
        for (const listener of renderListeners) {
          listener(element)
        }
        return element.dataset.markKind
      }
    }
    decorations.push(decoration)
    return decoration
  })
  const terminal: TerminalMarksHost = {
    parser: headless.parser,
    buffer: headless.buffer,
    get cols() {
      return headless.cols
    },
    get rows() {
      return headless.rows
    },
    element: undefined,
    registerMarker: (offset) => headless.registerMarker(offset),
    onData: (listener) => headless.onData(listener),
    scrollToLine: vi.fn((line: number) => headless.scrollToLine(line)),
    scrollToBottom: vi.fn(() => headless.scrollToBottom()),
    selectLines: vi.fn(),
    registerDecoration
  }
  const container = document.createElement('div')
  const disposable = installTerminalPaneMarks({
    terminal,
    container,
    resolveContextMenuLine: () => 7,
    decorationsEnabled: () => options.decorationsEnabled ?? true
  })
  const write = (data: string): Promise<void> =>
    new Promise((resolve) => headless.write(data, resolve))
  return { headless, terminal, container, decorations, disposable, write }
}

const harnesses: ReturnType<typeof createHarness>[] = []
function harness(options?: { decorationsEnabled?: boolean }) {
  const created = createHarness(options)
  harnesses.push(created)
  return created
}

afterEach(() => {
  for (const created of harnesses.splice(0)) {
    created.disposable.dispose()
    created.headless.dispose()
  }
})

const A = '\x1b]133;A\x07'
const C = '\x1b]133;C\x07'
const D = (code: number): string => `\x1b]133;D;${code}\x07`

describe('installTerminalPaneMarks', () => {
  it('marks OSC 133 prompts and flags a failed command', async () => {
    const { terminal, decorations, write } = harness()
    await write(`${A}$ false\r\n${C}${D(1)}${A}$ `)
    const marks = getTerminalPaneMarks(terminal)
    expect(marks).not.toBeNull()
    const kinds = decorations
      .filter((decoration) => decoration.requested.width === 1)
      .map((decoration) => decoration.renderKind())
    expect(kinds).toEqual(['prompt', 'failed', 'prompt'])
    // Why: the first tick is replaced, not stacked, when the exit code arrives.
    expect(decorations[0].dispose).toHaveBeenCalled()
  })

  it('jumps to the previous prompt and flashes it', async () => {
    const { terminal, headless, write } = harness()
    await write(`${A}$ seq 20\r\n${C}${Array.from({ length: 20 }, (_, i) => i).join('\r\n')}\r\n`)
    await write(`${D(0)}${A}$ `)
    const marks = getTerminalPaneMarks(terminal)
    expect(marks?.navigatePrompt('previous')).toBe(true)
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(0)
    expect(headless.buffer.active.viewportY).toBe(0)
    expect(marks?.navigatePrompt('previous')).toBe(false)
    expect(marks?.navigatePrompt('next')).toBe(true)
  })

  it('extracts and selects the output of a finished command', async () => {
    const { terminal, write } = harness()
    await write(`${A}$ printf\r\n${C}alpha\r\nbeta\r\n${D(0)}${A}$ `)
    const marks = getTerminalPaneMarks(terminal)
    expect(marks?.commandOutputAt(0)?.text).toBe('alpha\nbeta')
    expect(marks?.commandOutputAt()?.text).toBe('alpha\nbeta')
    expect(marks?.selectCommandOutput(0)).toBe(true)
    expect(terminal.selectLines).toHaveBeenCalledWith(1, 2)
  })

  it('marks submitted input when no shell prompt is waiting (generic fallback)', async () => {
    const { terminal, headless, write } = harness()
    await write('> hello')
    headless.input('\r', true)
    await write('\r\n> again')
    headless.input('\x1b[13u', true)
    const marks = getTerminalPaneMarks(terminal)
    expect(marks?.navigatePrompt('previous')).toBe(true)
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(0)
  })

  it('leaves Enter at a shell-integrated prompt to OSC 133', async () => {
    const { decorations, headless, write } = harness()
    await write(`${A}$ ls`)
    const before = decorations.length
    headless.input('\r', true)
    expect(decorations.length).toBe(before)
  })

  it('does not mark the alternate screen', async () => {
    const { decorations, headless, write } = harness()
    await write(`\x1b[?1049h${A}`)
    headless.input('\r', true)
    expect(decorations).toHaveLength(0)
  })

  it('tracks marks without decorations when the setting is off', async () => {
    const { terminal, decorations, write } = harness({ decorationsEnabled: false })
    await write(`${A}$ a\r\n${C}${D(0)}\r\n\r\n${A}$ `)
    expect(decorations).toHaveLength(0)
    expect(getTerminalPaneMarks(terminal)?.navigatePrompt('previous')).toBe(true)
  })

  it('toggles bookmarks and lists them with their line text', async () => {
    const { terminal, write } = harness()
    await write('build ok\r\nnext')
    const marks = getTerminalPaneMarks(terminal)
    expect(marks?.toggleBookmark(0)).toBe('added')
    expect(marks?.listBookmarks()).toEqual([{ id: expect.any(Number), line: 0, label: 'build ok' }])
    expect(marks?.toggleBookmark(0)).toBe('removed')
    expect(marks?.listBookmarks()).toEqual([])
  })

  it('captures the right-clicked row on mousedown, before the menu renders', () => {
    const { terminal, container } = harness()
    const marks = getTerminalPaneMarks(terminal)
    container.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
    expect(marks?.contextMenuLine()).toBeNull()
    container.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }))
    expect(marks?.contextMenuLine()).toBe(7)
  })

  it('stops observing and unregisters on dispose', async () => {
    const created = createHarness()
    created.disposable.dispose()
    expect(getTerminalPaneMarks(created.terminal)).toBeNull()
    await created.write(`${A}$ `)
    expect(created.decorations).toHaveLength(0)
    created.headless.dispose()
  })
})
