import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// Why one id: back-to-back copies refresh one toast instead of stacking a column of them.
const TERMINAL_COPY_TOAST_ID = 'terminal-selection-copied'
const TERMINAL_COPY_TOAST_DURATION_MS = 1500
// Why: copy-on-select writes on every selection change of a drag; confirm once it settles.
export const TERMINAL_COPY_ON_SELECT_FEEDBACK_DELAY_MS = 300

/** Transient confirmation that a terminal selection reached the clipboard (#21843). */
export function showTerminalCopyFeedback(): void {
  toast.success(translate('components.terminalPane.copyFeedback.copied', 'Copied to clipboard'), {
    id: TERMINAL_COPY_TOAST_ID,
    duration: TERMINAL_COPY_TOAST_DURATION_MS
  })
}

export function createSettledTerminalCopyFeedback(
  delayMs = TERMINAL_COPY_ON_SELECT_FEEDBACK_DELAY_MS
): { schedule: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  return {
    schedule: () => {
      cancel()
      timer = setTimeout(() => {
        timer = null
        showTerminalCopyFeedback()
      }, delayMs)
    },
    cancel
  }
}
