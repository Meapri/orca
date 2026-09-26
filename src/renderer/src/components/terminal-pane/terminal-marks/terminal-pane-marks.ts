/**
 * Renderer-only semantic marks for one xterm pane: OSC 133 prompt/output boundaries,
 * a generic "submitted input" fallback for programs without shell integration, and
 * user bookmarks. Nothing here is persisted or published; marks live as long as the
 * xterm buffer lines they anchor to.
 */
import type { IDisposable, IMarker, Terminal } from '@xterm/xterm'
import { parseOsc133Payload } from '../../../../../shared/terminal-osc133-command-finished'
import { guardParserHandler } from '../terminal-parser-handler-guard'
import {
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport
} from '@/lib/pane-manager/terminal-scroll-intent'
import { TerminalMarkStore, type TerminalCommandMark } from './terminal-mark-store'
import {
  findAdjacentMarkLine,
  resolveMarkNavigationReference,
  type TerminalMarkJumpMemory,
  type TerminalMarkNavigationDirection
} from './terminal-mark-navigation'
import {
  readTerminalLineRangeText,
  resolveCommandOutputRange,
  type TerminalLineRange
} from './terminal-command-output-range'
import {
  decorateTerminalMark,
  flashTerminalRows,
  type TerminalMarkDecorationHost
} from './terminal-mark-decorations'

// Why: kitty "report all keys" mode encodes a bare Enter as CSI 13 u instead of CR.
const SUBMIT_INPUTS = new Set(['\r', '\x1b[13u', '\x1b[13;1u'])
const BOOKMARK_LABEL_MAX_LENGTH = 80

export type TerminalBookmarkSummary = { id: number; line: number; label: string }
export type TerminalCommandOutput = { range: TerminalLineRange; text: string }

export type TerminalPaneMarks = {
  navigatePrompt: (direction: TerminalMarkNavigationDirection) => boolean
  /** Buffer row of the latest right-click inside this pane, if still meaningful. */
  contextMenuLine: () => number | null
  toggleBookmark: (line?: number) => 'added' | 'removed' | null
  hasBookmarkAtLine: (line: number) => boolean
  listBookmarks: () => TerminalBookmarkSummary[]
  jumpToBookmark: (id: number) => void
  removeBookmark: (id: number) => void
  commandOutputAt: (line?: number) => TerminalCommandOutput | null
  selectCommandOutput: (line?: number) => boolean
}

/** The xterm surface marks use, narrowed so tests can drive a headless terminal. */
export type TerminalMarksHost = TerminalMarkDecorationHost &
  Pick<
    Terminal,
    'buffer' | 'onData' | 'registerMarker' | 'scrollToLine' | 'scrollToBottom' | 'selectLines'
  > & { parser: Pick<Terminal['parser'], 'registerOscHandler'> }

type InstallOptions = {
  terminal: TerminalMarksHost
  container: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>
  /** Buffer row (0-based) under a right-click, or null outside the grid. */
  resolveContextMenuLine: (event: MouseEvent) => number | null
  /** Gates passive decorations (gutter/ruler ticks); marks are still tracked. */
  decorationsEnabled: () => boolean
}

const marksByTerminal = new WeakMap<object, TerminalPaneMarks>()

export function getTerminalPaneMarks(terminal: object): TerminalPaneMarks | null {
  return marksByTerminal.get(terminal) ?? null
}

export function installTerminalPaneMarks({
  terminal,
  container,
  resolveContextMenuLine,
  decorationsEnabled
}: InstallOptions): IDisposable {
  const commandDecorations = new Map<number, IDisposable>()
  const bookmarkDecorations = new Map<number, IDisposable>()
  let jumpMemory: TerminalMarkJumpMemory = null
  let flash: IDisposable | null = null
  let contextLine: number | null = null

  const decorateCommand = (mark: TerminalCommandMark<IMarker>): void => {
    commandDecorations.get(mark.id)?.dispose()
    commandDecorations.delete(mark.id)
    if (!decorationsEnabled()) {
      return
    }
    const failed = typeof mark.exitCode === 'number' && mark.exitCode !== 0
    const decoration = decorateTerminalMark(terminal, mark.prompt, failed ? 'failed' : 'prompt')
    if (decoration) {
      commandDecorations.set(mark.id, decoration)
    }
  }

  const store = new TerminalMarkStore<IMarker>({
    onCommandChanged: (mark) => {
      // Why: only a new prompt or a finished status changes what the tick shows.
      if (mark.output === null || mark.exitCode !== undefined) {
        decorateCommand(mark)
      }
    },
    onCommandRemoved: (mark) => {
      commandDecorations.get(mark.id)?.dispose()
      commandDecorations.delete(mark.id)
    },
    onBookmarkAdded: (bookmark) => {
      const decoration = decorateTerminalMark(terminal, bookmark.anchor, 'bookmark')
      if (decoration) {
        bookmarkDecorations.set(bookmark.id, decoration)
      }
    },
    onBookmarkRemoved: (bookmark) => {
      bookmarkDecorations.get(bookmark.id)?.dispose()
      bookmarkDecorations.delete(bookmark.id)
    }
  })

  const isNormalBuffer = (): boolean => terminal.buffer.active.type === 'normal'
  const cursorAbsoluteLine = (): number =>
    terminal.buffer.active.baseY + terminal.buffer.active.cursorY
  const markCursorLine = (): IMarker | null =>
    isNormalBuffer() ? (terminal.registerMarker(0) ?? null) : null
  const markLine = (line: number): IMarker | null =>
    isNormalBuffer() ? (terminal.registerMarker(line - cursorAbsoluteLine()) ?? null) : null

  const oscDisposable = terminal.parser.registerOscHandler(
    133,
    guardParserHandler('osc-133-command-marks', (payload) => {
      const mark = parseOsc133Payload(payload)
      const anchor = mark && mark.kind !== 'command-start' ? markCursorLine() : null
      if (!mark || !anchor) {
        return false
      }
      if (mark.kind === 'prompt-start') {
        store.addPrompt(anchor)
      } else if (mark.kind === 'output-start') {
        store.markOutputStart(anchor)
      } else if (mark.kind === 'command-finished') {
        store.markCommandFinished(anchor, mark.exitCode, terminal.buffer.active.cursorX > 0)
      }
      // Why false: observe only; the command-lifecycle consumer and future observers still run.
      return false
    })
  )

  const dataDisposable = terminal.onData((data) => {
    if (!SUBMIT_INPUTS.has(data)) {
      return
    }
    // Why: at a shell prompt the shell's own OSC 133 marks the command; elsewhere (no
    // integration, or a main-screen program reading input) the submitted row is the mark.
    if (store.isShellPromptAwaitingCommand()) {
      return
    }
    const anchor = markCursorLine()
    if (anchor) {
      store.addSubmittedInput(anchor)
    }
  })

  // Why mousedown: React's root handler opens (and renders) the menu before a contextmenu
  // listener here would run, so the row must be captured one event earlier.
  const onMouseDown = (event: MouseEvent): void => {
    if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
      contextLine = resolveContextMenuLine(event)
    }
  }
  container.addEventListener('mousedown', onMouseDown, true)

  const jumpTo = (marker: IMarker, rows: number): void => {
    markTerminalPinnedViewport(terminal)
    terminal.scrollToLine(marker.line)
    syncTerminalScrollIntentFromViewport(terminal)
    jumpMemory = { line: marker.line, viewportY: terminal.buffer.active.viewportY }
    flash?.dispose()
    flash = flashTerminalRows(terminal, marker, rows)
  }

  const commandOutputAt = (line?: number): TerminalCommandOutput | null => {
    const command =
      line === undefined
        ? store.latestFinishedCommandWithOutput()
        : (store.findCommandAtLine(line) ?? null)
    if (!command) {
      return null
    }
    const range = resolveCommandOutputRange(
      command,
      store.nextPromptLineAfter(command),
      cursorAbsoluteLine()
    )
    if (!range) {
      return null
    }
    const buffer = terminal.buffer.active
    return { range, text: readTerminalLineRangeText((row) => buffer.getLine(row), range) }
  }

  const marks: TerminalPaneMarks = {
    navigatePrompt: (direction) => {
      const buffer = terminal.buffer.active
      if (buffer.type !== 'normal') {
        return false
      }
      const commands = store.commandMarks()
      const reference = resolveMarkNavigationReference(
        {
          viewportY: buffer.viewportY,
          baseY: buffer.baseY,
          cursorAbsoluteLine: cursorAbsoluteLine()
        },
        direction,
        jumpMemory
      )
      const targetLine = findAdjacentMarkLine(
        commands.map((command) => command.prompt.line),
        reference,
        direction
      )
      const target = commands.find((command) => command.prompt.line === targetLine)
      if (!target) {
        if (direction === 'next') {
          jumpMemory = null
          terminal.scrollToBottom()
          syncTerminalScrollIntentFromViewport(terminal)
        }
        return false
      }
      const nextPrompt = store.nextPromptLineAfter(target)
      jumpTo(target.prompt, nextPrompt === null ? 1 : Math.max(1, nextPrompt - target.prompt.line))
      return true
    },
    contextMenuLine: () => contextLine,
    toggleBookmark: (line) => {
      const targetLine = line ?? cursorAbsoluteLine()
      const existing = store.findBookmarkAtLine(targetLine)
      if (existing) {
        store.removeBookmark(existing.id)
        return 'removed'
      }
      const anchor = markLine(targetLine)
      if (!anchor) {
        return null
      }
      const text = terminal.buffer.active.getLine(targetLine)?.translateToString(true).trim() ?? ''
      return store.addBookmark(anchor, text.slice(0, BOOKMARK_LABEL_MAX_LENGTH)) ? 'added' : null
    },
    hasBookmarkAtLine: (line) => store.findBookmarkAtLine(line) !== null,
    listBookmarks: () =>
      store.bookmarks().map((bookmark) => ({
        id: bookmark.id,
        line: bookmark.anchor.line,
        label: bookmark.label
      })),
    jumpToBookmark: (id) => {
      const bookmark = store.bookmarks().find((candidate) => candidate.id === id)
      if (bookmark) {
        jumpTo(bookmark.anchor, 1)
      }
    },
    removeBookmark: (id) => store.removeBookmark(id),
    commandOutputAt,
    selectCommandOutput: (line) => {
      const output = commandOutputAt(line)
      if (!output) {
        return false
      }
      terminal.selectLines(output.range.start, output.range.end)
      return true
    }
  }
  marksByTerminal.set(terminal, marks)

  return {
    dispose: () => {
      marksByTerminal.delete(terminal)
      container.removeEventListener('mousedown', onMouseDown, true)
      oscDisposable.dispose()
      dataDisposable.dispose()
      flash?.dispose()
      for (const decoration of [...commandDecorations.values(), ...bookmarkDecorations.values()]) {
        decoration.dispose()
      }
      commandDecorations.clear()
      bookmarkDecorations.clear()
      store.dispose()
    }
  }
}
