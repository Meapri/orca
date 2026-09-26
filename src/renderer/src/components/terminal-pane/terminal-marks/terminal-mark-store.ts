/**
 * Per-pane bookkeeping for semantic command marks and user bookmarks.
 *
 * Anchors are xterm markers in production; the store only needs their line and
 * dispose lifecycle, so trimming/clearing (which disposes markers) drops records here.
 */

export type TerminalMarkAnchor = {
  readonly line: number
  readonly isDisposed: boolean
  onDispose: (listener: () => void) => { dispose: () => void }
  dispose: () => void
}

export type TerminalCommandMarkSource = 'shell-integration' | 'submitted-input'

export type TerminalCommandMark<A extends TerminalMarkAnchor = TerminalMarkAnchor> = {
  readonly id: number
  readonly source: TerminalCommandMarkSource
  readonly prompt: A
  output: A | null
  outputEnd: A | null
  /** OSC 133;D landed mid-line, so the end line still holds output (no trailing newline). */
  outputEndsMidLine: boolean
  /** undefined until the command finishes; null when the shell omitted the exit code. */
  exitCode: number | null | undefined
}

export type TerminalBookmark<A extends TerminalMarkAnchor = TerminalMarkAnchor> = {
  readonly id: number
  readonly anchor: A
  readonly label: string
}

export type TerminalMarkStoreObserver<A extends TerminalMarkAnchor> = {
  onCommandChanged?: (mark: TerminalCommandMark<A>) => void
  onCommandRemoved?: (mark: TerminalCommandMark<A>) => void
  onBookmarkAdded?: (bookmark: TerminalBookmark<A>) => void
  onBookmarkRemoved?: (bookmark: TerminalBookmark<A>) => void
}

// Why: scrollback trimming already bounds marks, but huge scrollback settings must not grow them unbounded.
export const MAX_TERMINAL_COMMAND_MARKS = 5_000
export const MAX_TERMINAL_BOOKMARKS = 200

export class TerminalMarkStore<A extends TerminalMarkAnchor> {
  private commands: TerminalCommandMark<A>[] = []
  private bookmarkList: TerminalBookmark<A>[] = []
  private nextId = 1
  private disposed = false

  constructor(private readonly observer: TerminalMarkStoreObserver<A> = {}) {}

  /** OSC 133;A — a new prompt. Returns null when the prompt only repainted in place. */
  addPrompt(anchor: A): TerminalCommandMark<A> | null {
    return this.addCommand(anchor, 'shell-integration')
  }

  /** Enter submitted from local input while no shell prompt is awaiting a command. */
  addSubmittedInput(anchor: A): TerminalCommandMark<A> | null {
    return this.addCommand(anchor, 'submitted-input')
  }

  /** OSC 133;C — attaches to the prompt that is waiting for a command. */
  markOutputStart(anchor: A): void {
    const latest = this.latestCommand()
    if (!latest || latest.source !== 'shell-integration' || latest.output) {
      anchor.dispose()
      return
    }
    latest.output = anchor
    this.observer.onCommandChanged?.(latest)
  }

  /** OSC 133;D — closes the running command; a bare D after an empty prompt is ignored. */
  markCommandFinished(anchor: A, exitCode: number | null, endsMidLine: boolean): void {
    const latest = this.latestCommand()
    if (!latest || !latest.output || latest.outputEnd || latest.exitCode !== undefined) {
      anchor.dispose()
      return
    }
    latest.outputEnd = anchor
    latest.outputEndsMidLine = endsMidLine
    latest.exitCode = exitCode
    this.observer.onCommandChanged?.(latest)
  }

  /** True while a shell prompt is showing, so its own OSC 133;C will mark the command. */
  isShellPromptAwaitingCommand(): boolean {
    const latest = this.latestCommand()
    return latest?.source === 'shell-integration' && latest.output === null
  }

  commandMarks(): readonly TerminalCommandMark<A>[] {
    return this.commands
  }

  /** The command whose prompt is the closest one at or above `line`. */
  findCommandAtLine(line: number): TerminalCommandMark<A> | null {
    let found: TerminalCommandMark<A> | null = null
    for (const command of this.commands) {
      if (command.prompt.line > line) {
        break
      }
      found = command
    }
    return found
  }

  /** The prompt line after `command`, used to bound output that never got a D. */
  nextPromptLineAfter(command: TerminalCommandMark<A>): number | null {
    const index = this.commands.indexOf(command)
    return index === -1 ? null : (this.commands[index + 1]?.prompt.line ?? null)
  }

  latestFinishedCommandWithOutput(): TerminalCommandMark<A> | null {
    for (let i = this.commands.length - 1; i >= 0; i -= 1) {
      const command = this.commands[i]
      if (command.output && command.exitCode !== undefined) {
        return command
      }
    }
    return null
  }

  bookmarks(): readonly TerminalBookmark<A>[] {
    return this.bookmarkList
  }

  findBookmarkAtLine(line: number): TerminalBookmark<A> | null {
    return this.bookmarkList.find((bookmark) => bookmark.anchor.line === line) ?? null
  }

  addBookmark(anchor: A, label: string): TerminalBookmark<A> | null {
    if (this.disposed || anchor.isDisposed || this.findBookmarkAtLine(anchor.line)) {
      anchor.dispose()
      return null
    }
    const bookmark: TerminalBookmark<A> = { id: this.nextId++, anchor, label }
    this.bookmarkList.push(bookmark)
    this.bookmarkList.sort((a, b) => a.anchor.line - b.anchor.line)
    anchor.onDispose(() => this.forgetBookmark(bookmark))
    this.observer.onBookmarkAdded?.(bookmark)
    if (this.bookmarkList.length > MAX_TERMINAL_BOOKMARKS) {
      this.bookmarkList[0].anchor.dispose()
    }
    return bookmark
  }

  removeBookmark(id: number): void {
    this.bookmarkList.find((bookmark) => bookmark.id === id)?.anchor.dispose()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const command of this.commands.slice()) {
      disposeCommandAnchors(command)
    }
    for (const bookmark of this.bookmarkList.slice()) {
      bookmark.anchor.dispose()
    }
    this.commands = []
    this.bookmarkList = []
  }

  private addCommand(anchor: A, source: TerminalCommandMarkSource): TerminalCommandMark<A> | null {
    const latest = this.latestCommand()
    if (this.disposed || anchor.isDisposed || latest?.prompt.line === anchor.line) {
      anchor.dispose()
      return null
    }
    const mark: TerminalCommandMark<A> = {
      id: this.nextId++,
      source,
      prompt: anchor,
      output: null,
      outputEnd: null,
      outputEndsMidLine: false,
      exitCode: undefined
    }
    // Why: a clear/reset can restart line numbering below older marks; keep prompt-line order.
    const insertAt = this.commands.findIndex((command) => command.prompt.line > anchor.line)
    if (insertAt === -1) {
      this.commands.push(mark)
    } else {
      this.commands.splice(insertAt, 0, mark)
    }
    anchor.onDispose(() => this.forgetCommand(mark))
    this.observer.onCommandChanged?.(mark)
    if (this.commands.length > MAX_TERMINAL_COMMAND_MARKS) {
      this.commands[0].prompt.dispose()
    }
    return mark
  }

  private latestCommand(): TerminalCommandMark<A> | undefined {
    return this.commands.at(-1)
  }

  private forgetCommand(mark: TerminalCommandMark<A>): void {
    const index = this.commands.indexOf(mark)
    if (index === -1) {
      return
    }
    this.commands.splice(index, 1)
    disposeCommandAnchors(mark)
    this.observer.onCommandRemoved?.(mark)
  }

  private forgetBookmark(bookmark: TerminalBookmark<A>): void {
    const index = this.bookmarkList.indexOf(bookmark)
    if (index === -1) {
      return
    }
    this.bookmarkList.splice(index, 1)
    this.observer.onBookmarkRemoved?.(bookmark)
  }
}

function disposeCommandAnchors(mark: TerminalCommandMark): void {
  mark.prompt.dispose()
  mark.output?.dispose()
  mark.outputEnd?.dispose()
}
