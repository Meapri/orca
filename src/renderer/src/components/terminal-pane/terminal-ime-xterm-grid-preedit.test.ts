// @vitest-environment happy-dom
/**
 * In-grid IME preedit (`imePreeditInGrid`, Orca's xterm patch): the preedit is drawn by the
 * renderer as ordinary cells on the cursor row instead of a DOM overlay stacked above it. These
 * pin what the renderer shows against what the buffer, selection and pty must keep seeing.
 *
 * happy-dom can only drive xterm's DOM renderer; the WebGL renderer composes the same
 * `IImePreedit.composeLine` result, which the model-level assertions here cover.
 */
import { SerializeAddon } from '@xterm/addon-serialize'
import { describe, expect, it } from 'vitest'
import {
  isTerminalImePreeditInGrid,
  setTerminalImePreeditAnchor,
  setTerminalImePreeditHidesTail
} from '@/lib/pane-manager/terminal-ime-grid-preedit'
import {
  bufferRow,
  commit,
  compose,
  composeRendered,
  installGridPreeditTestHooks,
  nextRender,
  openTerminal,
  renderedText,
  setCellWidth,
  settle,
  textBeforeCursor,
  underlinedText,
  update,
  write
} from './terminal-ime-grid-preedit-test-rig'

installGridPreeditTestHooks()

describe('in-grid IME preedit', () => {
  it('draws the preedit into the cursor row without touching the buffer, overlay, or pty', async () => {
    const { container, terminal, sent } = openTerminal()
    await write(terminal, '$ ls')
    terminal.focus()
    await composeRendered(terminal, '한')

    expect(isTerminalImePreeditInGrid(terminal)).toBe(true)
    expect(renderedText(container, 0)).toBe('$ ls한')
    expect(bufferRow(terminal, 0)).toBe('$ ls')
    expect(sent).toEqual([])
    const view = container.querySelector<HTMLElement>('.composition-view')!
    expect(view.classList.contains('active')).toBe(false)
    expect(view.childNodes).toHaveLength(0)
    const serialize = new SerializeAddon()
    terminal.loadAddon(serialize)
    expect(serialize.serialize()).not.toContain('한')
  })

  it('underlines the preedit cells and nothing after them', async () => {
    const { container, terminal } = openTerminal()
    await write(terminal, 'ab')
    await composeRendered(terminal, '가')

    expect(underlinedText(container, 0)).toBe('가')
  })

  it('moves the drawn cursor to the caret after a wide preedit', async () => {
    const { container, terminal } = openTerminal()
    await write(terminal, 'ab')
    terminal.focus()
    await composeRendered(terminal, '한글')

    expect(textBeforeCursor(container, 0)).toBe('ab한글')
  })

  it('pushes the committed tail right when composing mid-line', async () => {
    const { container, terminal } = openTerminal()
    await write(terminal, 'abcdef\x1b[4G')
    await composeRendered(terminal, '한')

    expect(renderedText(container, 0)).toBe('abc한def')
    expect(bufferRow(terminal, 0)).toBe('abcdef')
  })

  it('hides a tail the embedder marks as a placeholder, and restores it', async () => {
    const { container, terminal } = openTerminal()
    await write(terminal, '> \x1b[2mAsk anything\x1b[0m\x1b[3G')
    compose(terminal, '한')
    const hidden = nextRender(terminal)
    setTerminalImePreeditHidesTail(terminal, true)
    await hidden
    expect(renderedText(container, 0)).toBe('> 한')

    const shown = nextRender(terminal)
    setTerminalImePreeditHidesTail(terminal, false)
    await shown
    expect(renderedText(container, 0)).toBe('> 한Ask anything')
  })

  it('end-aligns a preedit that reaches the right edge so the caret stays visible', async () => {
    const { container, terminal } = openTerminal({ cols: 10 })
    await write(terminal, '123456789')
    terminal.focus()
    await composeRendered(terminal, '한글')

    // 4 cells of preedit + 1 caret cell fit only from column 5.
    expect(renderedText(container, 0)).toBe('12345한글')
    expect(textBeforeCursor(container, 0)).toBe('12345한글')
  })

  it('keeps the newest text when the preedit is wider than the row', async () => {
    const { container, terminal } = openTerminal({ cols: 10 })
    await composeRendered(terminal, '가나다라마바')

    expect(renderedText(container, 0)).toBe('다라마바')
  })

  it('joins combining marks into one cell the way the buffer would', async () => {
    const { container, terminal } = openTerminal()
    await write(terminal, 'x')
    terminal.focus()
    await composeRendered(terminal, 'が')

    expect(renderedText(container, 0)).toBe('xが')
    expect(textBeforeCursor(container, 0)).toBe('xが')
  })

  it('draws at an embedder anchor instead of a hidden cursor row', async () => {
    const { container, terminal } = openTerminal()
    await write(terminal, '\x1b[3;1H→ \x1b[5;1H')
    compose(terminal, '한')
    const anchored = nextRender(terminal)
    setTerminalImePreeditAnchor(terminal, { row: 2, column: 2 })
    await anchored

    expect(renderedText(container, 2)).toBe('→ 한')
    expect(renderedText(container, 4)).toBe('')
  })

  it('ends the preedit on commit and sends the committed text exactly once', async () => {
    const { container, terminal, sent } = openTerminal()
    await write(terminal, '$ ')
    await composeRendered(terminal, '한')
    await commit(terminal, '한')

    expect(sent).toEqual(['한'])
    // Held, not underlined, until the pty echoes it (terminal-ime-xterm-grid-preedit-echo.test.ts).
    expect(renderedText(container, 0)).toBe('$ 한')
    expect(underlinedText(container, 0)).toBe('')
  })

  it('clears the preedit when an update empties it without sending anything', async () => {
    const { container, terminal, sent } = openTerminal()
    await write(terminal, '$ ')
    await composeRendered(terminal, '가')
    const cleared = nextRender(terminal)
    update(terminal, '')
    await cleared

    expect(renderedText(container, 0)).toBe('$')
    expect(sent).toEqual([])
  })

  it('anchors the textarea to the drawn preedit start for the OS candidate window', async () => {
    const { terminal } = openTerminal({ cols: 10 })
    await write(terminal, '123456789')
    setCellWidth(terminal, 8)
    compose(terminal, '한글')
    const textarea = terminal.textarea!

    expect(textarea.style.left).toBe('40px')
    expect(textarea.style.width).toBe('32px')
  })

  it('keeps the overlay path when the option is off', async () => {
    const { container, terminal } = openTerminal({ inGrid: false })
    await write(terminal, '$ ')
    compose(terminal, '한')

    expect(isTerminalImePreeditInGrid(terminal)).toBe(false)
    const view = container.querySelector<HTMLElement>('.composition-view')!
    expect(view.classList.contains('active')).toBe(true)
    expect(view.textContent).toContain('한')
    await settle()
    expect(renderedText(container, 0)).toBe('$')
  })

  it('draws the cursor at the end of a converting clause the IME reports as a selection', async () => {
    const { container, terminal } = openTerminal()
    await write(terminal, '> ')
    terminal.focus()
    compose(terminal, '日本語')
    const selectClause = async (start: number, end: number): Promise<void> => {
      update(terminal, '日本語')
      terminal.textarea!.setSelectionRange(start, end)
      const rendered = nextRender(terminal)
      await settle()
      await rendered
    }

    await selectClause(0, 1)
    expect(textBeforeCursor(container, 0)).toBe('> 日')
    await selectClause(1, 2)
    expect(textBeforeCursor(container, 0)).toBe('> 日本')
    await selectClause(2, 2)
    expect(textBeforeCursor(container, 0)).toBe('> 日本')
  })

  it('reports the path latched at compositionstart when the option flips mid-composition', async () => {
    const grid = openTerminal()
    compose(grid.terminal, '한')
    grid.terminal.options.imePreeditInGrid = false
    expect(isTerminalImePreeditInGrid(grid.terminal)).toBe(true)

    const overlay = openTerminal({ inGrid: false })
    compose(overlay.terminal, '한')
    overlay.terminal.options.imePreeditInGrid = true
    expect(isTerminalImePreeditInGrid(overlay.terminal)).toBe(false)

    await commit(grid.terminal, '한')
    expect(isTerminalImePreeditInGrid(grid.terminal)).toBe(false)
  })
})
