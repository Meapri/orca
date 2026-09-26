import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm'

export type TerminalMarkDecorationKind = 'prompt' | 'failed' | 'bookmark'

export type TerminalMarkDecorationHost = Pick<
  Terminal,
  'element' | 'cols' | 'rows' | 'registerDecoration'
>

const MARK_CLASS = 'orca-terminal-mark'
const FLASH_CLASS = 'orca-terminal-mark-flash'
export const TERMINAL_MARK_FLASH_MS = 900

// Why: the overview ruler paints on canvas, so it needs resolved colors rather than var() references.
const RULER_TOKEN_BY_KIND: Record<TerminalMarkDecorationKind, string> = {
  prompt: '--muted-foreground',
  failed: '--destructive',
  bookmark: '--terminal-pane-locate'
}
function resolveRulerColor(
  terminal: TerminalMarkDecorationHost,
  kind: TerminalMarkDecorationKind
): string | null {
  const element = terminal.element
  if (!element || typeof getComputedStyle !== 'function') {
    return null
  }
  return getComputedStyle(element).getPropertyValue(RULER_TOKEN_BY_KIND[kind]).trim() || null
}

/** Gutter tick on the mark's row plus a matching tick on the scrollbar's overview ruler. */
export function decorateTerminalMark(
  terminal: TerminalMarkDecorationHost,
  marker: IMarker,
  kind: TerminalMarkDecorationKind
): IDecoration | undefined {
  const rulerColor = resolveRulerColor(terminal, kind)
  const decoration = terminal.registerDecoration({
    marker,
    x: 0,
    width: 1,
    layer: 'top',
    ...(rulerColor
      ? {
          overviewRulerOptions: {
            color: rulerColor,
            position: kind === 'bookmark' ? ('right' as const) : ('left' as const)
          }
        }
      : {})
  })
  decoration?.onRender((element) => {
    element.classList.add(MARK_CLASS)
    element.dataset.markKind = kind
  })
  return decoration
}

/** Brief row highlight so the eye finds the jump target after the viewport moves. */
export function flashTerminalRows(
  terminal: TerminalMarkDecorationHost,
  marker: IMarker,
  rows: number
): IDisposable {
  const decoration = terminal.registerDecoration({
    marker,
    x: 0,
    width: Math.max(1, terminal.cols),
    height: Math.max(1, Math.min(rows, terminal.rows)),
    layer: 'top'
  })
  if (!decoration) {
    return { dispose: () => {} }
  }
  decoration.onRender((element) => element.classList.add(FLASH_CLASS))
  const timer = setTimeout(() => decoration.dispose(), TERMINAL_MARK_FLASH_MS)
  return {
    dispose: () => {
      clearTimeout(timer)
      decoration.dispose()
    }
  }
}
