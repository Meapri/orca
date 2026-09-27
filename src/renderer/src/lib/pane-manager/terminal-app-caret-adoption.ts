import type { IDisposable, Terminal } from '@xterm/xterm'
import { scanAppDrawnCarets, type AppDrawnCaretCell } from './terminal-app-drawn-caret'

/** A caret that moves this soon after local input arms adoption; the WebGL glide's input window. */
export const APP_CARET_ARMING_WINDOW_MS = 500

/** Screen cell (row relative to the active screen's top) the renderer draws the cursor at. */
export type AdoptedAppCaret = { x: number; y: number }

type AdoptedCaretSource = () => AdoptedAppCaret | undefined

type AdoptedCaretCore = {
  setAdoptedCaretSource: (source: AdoptedCaretSource | undefined) => void
}

// Only the fields the rule reads, so a headless terminal can drive it in tests.
type AdoptionTerminal = Pick<
  Terminal,
  'buffer' | 'modes' | 'rows' | 'cols' | 'onData' | 'onWriteParsed' | 'onResize'
>

/**
 * Decides whether the lone inverse cell an app paints (scanAppDrawnCarets) is its caret, so the
 * renderer can draw the terminal's own cursor there (style, blink, glide) instead.
 *
 * Guards, each from the captured transcripts (src/main/runtime/__fixtures__/*-ime-*.txt):
 * - DECTCEM hidden: cursor-agent sends one `?25l` and never shows the cursor again; Claude Code,
 *   Codex and Grok show it on their caret and paint no inverse cell at all.
 * - Normal buffer only: cursor-agent never enters the alternate screen, and no alt-screen capture
 *   paints a caret this way.
 * - Exactly one candidate: two lone inverse cells are ambiguous, so neither is adopted.
 * - Armed by input: every key in cursor-agent-ime-korean-typed moves the lone cell, while
 *   cursor-agent-ime-ready paints it before any input; so the first move in output parsed within
 *   APP_CARET_ARMING_WINDOW_MS of local input arms adoption until the cursor is shown again or
 *   the buffer switches, and a static inverse cell nobody typed at is never taken for a caret.
 *
 * Recomputed only when output was parsed (or the size or setting changed), and only when the
 * renderer asks, so a burst of writes costs at most one bounded scan per rendered frame.
 */
export class AppCaretAdoption {
  private _dirty = true
  private _armed = false
  private _lastInputAt = Number.NEGATIVE_INFINITY
  /** Output was parsed within the arming window of a key since the last scan. */
  private _echoedInput = false
  private _previous: AppDrawnCaretCell | null = null
  private _adopted: AdoptedAppCaret | undefined
  private readonly _disposables: IDisposable[]

  constructor(
    private readonly _terminal: AdoptionTerminal,
    private readonly _isEnabled: () => boolean,
    private readonly _now: () => number = () => performance.now()
  ) {
    const invalidate = (): void => this.invalidate()
    this._disposables = [
      _terminal.onWriteParsed(() => {
        // Judged when parsed, not when a frame next asks, so arming does not depend on frame timing.
        if (this._now() - this._lastInputAt <= APP_CARET_ARMING_WINDOW_MS) {
          this._echoedInput = true
        }
        this.invalidate()
      }),
      _terminal.onResize(invalidate),
      _terminal.buffer.onBufferChange(invalidate),
      _terminal.onData(() => this.noteInput())
    ]
  }

  noteInput(): void {
    this._lastInputAt = this._now()
  }

  invalidate(): void {
    this._dirty = true
  }

  /** The caret to draw the cursor at, or `undefined` to leave the app's rendering alone. */
  resolve(): AdoptedAppCaret | undefined {
    if (this._dirty) {
      this._dirty = false
      this._adopted = this._recompute()
    }
    return this._adopted
  }

  dispose(): void {
    for (const disposable of this._disposables.splice(0)) {
      disposable.dispose()
    }
  }

  private _recompute(): AdoptedAppCaret | undefined {
    const terminal = this._terminal
    const buffer = terminal.buffer.active
    const echoedInput = this._echoedInput
    this._echoedInput = false
    if (!this._isEnabled() || terminal.modes.showCursor || buffer.type !== 'normal') {
      this._armed = false
      this._previous = null
      return undefined
    }
    const scan = scanAppDrawnCarets({ buffer, rows: terminal.rows, cols: terminal.cols, limit: 2 })
    const candidate = scan.count === 1 ? scan.nearest : null
    if (candidate && echoedInput && !isSameCell(candidate, this._previous)) {
      this._armed = true
    }
    this._previous = candidate
    return this._armed && candidate ? { x: candidate.column, y: candidate.row } : undefined
  }
}

function isSameCell(a: AppDrawnCaretCell, b: AppDrawnCaretCell | null): boolean {
  return b !== null && a.row === b.row && a.column === b.column
}

// Why module state: the setting is app-wide and applies to terminals opened after it changed.
// Starts off so a pane opened before the first settings apply keeps the app's own rendering.
let adoptionEnabled = false
const liveTerminals = new Map<Terminal, AppCaretAdoption>()

export function setTerminalAppCaretAdoptionEnabled(enabled: boolean): void {
  if (adoptionEnabled === enabled) {
    return
  }
  adoptionEnabled = enabled
  for (const [terminal, adoption] of liveTerminals) {
    adoption.invalidate()
    terminal.refresh(0, terminal.rows - 1)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function adoptedCaretCore(terminal: Terminal): AdoptedCaretCore | null {
  const core: unknown = '_core' in terminal ? terminal._core : undefined
  if (!isRecord(core) || typeof core.setAdoptedCaretSource !== 'function') {
    return null
  }
  const setAdoptedCaretSource = core.setAdoptedCaretSource
  return {
    setAdoptedCaretSource: (source) => {
      setAdoptedCaretSource.call(core, source)
    }
  }
}

/**
 * Hands the patched xterm core (config/patches/xterm-src) the adopted caret for its renderers.
 * Returns a disposer, or null when the core lacks the hook (an unpatched or test build).
 */
export function installTerminalAppCaretAdoption(terminal: Terminal): (() => void) | null {
  const core = adoptedCaretCore(terminal)
  if (!core) {
    return null
  }
  const adoption = new AppCaretAdoption(terminal, () => adoptionEnabled)
  // Keys the embedder handles itself never reach onData but still move the caret.
  const textarea = terminal.textarea
  const onKeydown = (): void => adoption.noteInput()
  textarea?.addEventListener('keydown', onKeydown)
  liveTerminals.set(terminal, adoption)
  core.setAdoptedCaretSource(() => adoption.resolve())
  return () => {
    liveTerminals.delete(terminal)
    textarea?.removeEventListener('keydown', onKeydown)
    adoption.dispose()
    core.setAdoptedCaretSource(undefined)
  }
}
