import { describe, expect, it, vi } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import {
  MAX_TERMINAL_BOOKMARKS,
  TerminalMarkStore,
  type TerminalMarkAnchor
} from './terminal-mark-store'

type FakeAnchor = TerminalMarkAnchor & { line: number; isDisposed: boolean }

function anchorAt(line: number): FakeAnchor {
  const listeners: (() => void)[] = []
  const anchor: FakeAnchor = {
    line,
    isDisposed: false,
    onDispose: (listener) => {
      listeners.push(listener)
      return { dispose: () => {} }
    },
    dispose: () => {
      if (anchor.isDisposed) {
        return
      }
      anchor.isDisposed = true
      for (const listener of listeners) {
        listener()
      }
    }
  }
  return anchor
}

function writeSync(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('TerminalMarkStore', () => {
  it('records a full prompt → output → finished lifecycle', () => {
    const onCommandChanged = vi.fn()
    const store = new TerminalMarkStore<FakeAnchor>({ onCommandChanged })
    const prompt = store.addPrompt(anchorAt(3))
    store.markOutputStart(anchorAt(4))
    store.markCommandFinished(anchorAt(9), 2, false)

    expect(prompt).not.toBeNull()
    expect(store.commandMarks()).toHaveLength(1)
    const [command] = store.commandMarks()
    expect(command.output?.line).toBe(4)
    expect(command.outputEnd?.line).toBe(9)
    expect(command.exitCode).toBe(2)
    expect(onCommandChanged).toHaveBeenCalledTimes(3)
  })

  it('ignores a prompt repaint on the same line and disposes the duplicate anchor', () => {
    const store = new TerminalMarkStore<FakeAnchor>()
    store.addPrompt(anchorAt(5))
    const duplicate = anchorAt(5)
    expect(store.addPrompt(duplicate)).toBeNull()
    expect(duplicate.isDisposed).toBe(true)
    expect(store.commandMarks()).toHaveLength(1)
  })

  it('ignores D without C (empty Enter at a prompt) and C without a waiting prompt', () => {
    const store = new TerminalMarkStore<FakeAnchor>()
    const strayOutput = anchorAt(1)
    store.markOutputStart(strayOutput)
    expect(strayOutput.isDisposed).toBe(true)

    store.addPrompt(anchorAt(2))
    const strayEnd = anchorAt(3)
    store.markCommandFinished(strayEnd, 0, false)
    expect(strayEnd.isDisposed).toBe(true)
    expect(store.commandMarks()[0].exitCode).toBeUndefined()
  })

  it('reports a waiting shell prompt only between A and C', () => {
    const store = new TerminalMarkStore<FakeAnchor>()
    expect(store.isShellPromptAwaitingCommand()).toBe(false)
    store.addPrompt(anchorAt(0))
    expect(store.isShellPromptAwaitingCommand()).toBe(true)
    store.markOutputStart(anchorAt(1))
    expect(store.isShellPromptAwaitingCommand()).toBe(false)
    // Why: a main-screen program reading input after C gets submitted-input marks.
    expect(store.addSubmittedInput(anchorAt(4))?.source).toBe('submitted-input')
    expect(store.isShellPromptAwaitingCommand()).toBe(false)
  })

  it('drops a command and its secondary anchors when the prompt anchor is disposed', () => {
    const onCommandRemoved = vi.fn()
    const store = new TerminalMarkStore<FakeAnchor>({ onCommandRemoved })
    const prompt = anchorAt(0)
    const output = anchorAt(1)
    store.addPrompt(prompt)
    store.markOutputStart(output)
    prompt.dispose()
    expect(store.commandMarks()).toHaveLength(0)
    expect(output.isDisposed).toBe(true)
    expect(onCommandRemoved).toHaveBeenCalledOnce()
  })

  it('keeps prompt order when numbering restarts after a clear', () => {
    const store = new TerminalMarkStore<FakeAnchor>()
    store.addPrompt(anchorAt(40))
    store.addPrompt(anchorAt(2))
    expect(store.commandMarks().map((command) => command.prompt.line)).toEqual([2, 40])
  })

  it('finds the command owning a line and the latest finished output', () => {
    const store = new TerminalMarkStore<FakeAnchor>()
    store.addPrompt(anchorAt(0))
    store.markOutputStart(anchorAt(1))
    store.markCommandFinished(anchorAt(3), 0, false)
    store.addPrompt(anchorAt(3))
    expect(store.findCommandAtLine(2)?.prompt.line).toBe(0)
    expect(store.findCommandAtLine(7)?.prompt.line).toBe(3)
    expect(store.latestFinishedCommandWithOutput()?.prompt.line).toBe(0)
    expect(store.nextPromptLineAfter(store.commandMarks()[0])).toBe(3)
  })

  it('adds, dedupes, removes and caps bookmarks', () => {
    const onBookmarkRemoved = vi.fn()
    const store = new TerminalMarkStore<FakeAnchor>({ onBookmarkRemoved })
    const bookmark = store.addBookmark(anchorAt(8), 'npm test')
    expect(store.addBookmark(anchorAt(8), 'again')).toBeNull()
    expect(store.findBookmarkAtLine(8)?.label).toBe('npm test')
    store.removeBookmark(bookmark?.id ?? -1)
    expect(store.bookmarks()).toHaveLength(0)
    expect(onBookmarkRemoved).toHaveBeenCalledOnce()

    for (let line = 0; line <= MAX_TERMINAL_BOOKMARKS; line += 1) {
      store.addBookmark(anchorAt(line), `line ${line}`)
    }
    expect(store.bookmarks()).toHaveLength(MAX_TERMINAL_BOOKMARKS)
    expect(store.bookmarks()[0].anchor.line).toBe(1)
  })

  it('disposes every anchor on dispose and rejects later marks', () => {
    const store = new TerminalMarkStore<FakeAnchor>()
    const prompt = anchorAt(0)
    const bookmark = anchorAt(4)
    store.addPrompt(prompt)
    store.addBookmark(bookmark, 'x')
    store.dispose()
    expect(prompt.isDisposed).toBe(true)
    expect(bookmark.isDisposed).toBe(true)
    const late = anchorAt(9)
    expect(store.addPrompt(late)).toBeNull()
    expect(late.isDisposed).toBe(true)
  })

  it('forgets marks whose xterm lines were trimmed out of scrollback', async () => {
    const terminal = new HeadlessTerminal({
      cols: 20,
      rows: 3,
      scrollback: 5,
      allowProposedApi: true
    })
    const store = new TerminalMarkStore()
    await writeSync(terminal, 'first\r\n')
    const early = terminal.registerMarker(0)
    store.addPrompt(early)
    store.addBookmark(terminal.registerMarker(0), 'first')
    await writeSync(terminal, Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\r\n'))
    const late = terminal.registerMarker(0)
    store.addPrompt(late)

    expect(early.isDisposed).toBe(true)
    expect(store.commandMarks().map((command) => command.prompt)).toEqual([late])
    expect(store.bookmarks()).toHaveLength(0)
    terminal.dispose()
  })
})
