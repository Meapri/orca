import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastSuccess = vi.fn()
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: {} }) }
}))

const { createSettledTerminalCopyFeedback, showTerminalCopyFeedback } =
  await import('./terminal-copy-feedback')
const { copyTerminalSelection } = await import('./terminal-selection-copy')
const { runTerminalCopy } = await import('./terminal-copy-rejection-guards')

describe('terminal copy feedback', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses one short-lived toast for repeated copies', () => {
    showTerminalCopyFeedback()
    showTerminalCopyFeedback()
    expect(toastSuccess).toHaveBeenCalledTimes(2)
    const [first, second] = toastSuccess.mock.calls
    expect(first[1]).toEqual(second[1])
    expect(first[1].duration).toBeLessThanOrEqual(2000)
  })

  it('confirms copy-on-select once the drag settles', () => {
    const feedback = createSettledTerminalCopyFeedback(300)
    feedback.schedule()
    vi.advanceTimersByTime(200)
    feedback.schedule()
    vi.advanceTimersByTime(200)
    expect(toastSuccess).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    feedback.schedule()
    feedback.cancel()
    vi.advanceTimersByTime(1000)
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it('confirms only copies whose clipboard write succeeded', async () => {
    const onCopied = vi.fn()
    const terminal = { getSelection: () => 'text', clearSelection: vi.fn() }
    await copyTerminalSelection({ terminal, writeClipboardText: async () => {}, onCopied })
    expect(onCopied).toHaveBeenCalledTimes(1)
    await expect(
      copyTerminalSelection({
        terminal,
        writeClipboardText: () => Promise.reject(new Error('denied')),
        onCopied
      })
    ).rejects.toThrow('denied')
    await copyTerminalSelection({
      terminal: { getSelection: () => '', clearSelection: vi.fn() },
      writeClipboardText: async () => {},
      onCopied
    })
    expect(onCopied).toHaveBeenCalledTimes(1)
  })

  it('does not confirm a failed context-menu copy', async () => {
    const onCopied = vi.fn()
    const focus = vi.fn()
    await runTerminalCopy({
      selection: 'text',
      writeClipboardText: () => Promise.reject(new Error('denied')),
      focus,
      onCopied
    })
    expect(onCopied).not.toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
  })
})
