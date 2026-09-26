// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TerminalComposer } from './TerminalComposer'
import { readTerminalComposerDraft, writeTerminalComposerDraft } from './terminal-composer-drafts'
import type { TerminalComposerSendResult } from './terminal-composer-send'

vi.mock('@/i18n/i18n', () => ({
  translate: vi.fn((_key: string, fallback: string) => fallback)
}))

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.replaceChildren()
  writeTerminalComposerDraft('pane-a', '')
})

type Rig = {
  textarea: HTMLTextAreaElement
  onSend: ReturnType<typeof vi.fn<(text: string) => Promise<TerminalComposerSendResult>>>
  onClose: ReturnType<typeof vi.fn<() => void>>
}

async function renderComposer(isMac = true): Promise<Rig> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const onSend = vi.fn<(text: string) => Promise<TerminalComposerSendResult>>(async () => 'sent')
  const onClose = vi.fn<() => void>()
  await act(async () => {
    root.render(
      <TooltipProvider>
        <TerminalComposer
          paneKey="pane-a"
          isMac={isMac}
          submitOnSend
          onSubmitOnSendChange={vi.fn()}
          isToggleChord={(event) => event.key === '>' && event.metaKey && event.shiftKey}
          onSend={onSend}
          onClose={onClose}
        />
      </TooltipProvider>
    )
  })
  const textarea = container.querySelector('textarea')
  if (!textarea) {
    throw new Error('composer textarea missing')
  }
  return { textarea, onSend, onClose }
}

async function type(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function keydown(textarea: HTMLTextAreaElement, init: KeyboardEventInit): Promise<boolean> {
  let notCanceled = true
  await act(async () => {
    notCanceled = textarea.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    )
  })
  return notCanceled
}

describe('TerminalComposer', () => {
  it('focuses the field and keeps plain Enter as a native newline', async () => {
    const rig = await renderComposer()
    expect(document.activeElement).toBe(rig.textarea)
    await type(rig.textarea, 'line one')
    expect(await keydown(rig.textarea, { key: 'Enter' })).toBe(true)
    expect(rig.onSend).not.toHaveBeenCalled()
  })

  it('sends on Cmd+Enter on macOS and Ctrl+Enter elsewhere', async () => {
    const mac = await renderComposer(true)
    await type(mac.textarea, 'echo hi')
    await keydown(mac.textarea, { key: 'Enter', ctrlKey: true })
    expect(mac.onSend).not.toHaveBeenCalled()
    await keydown(mac.textarea, { key: 'Enter', metaKey: true })
    expect(mac.onSend).toHaveBeenCalledWith('echo hi')

    const other = await renderComposer(false)
    await type(other.textarea, 'echo hi')
    await keydown(other.textarea, { key: 'Enter', ctrlKey: true })
    expect(other.onSend).toHaveBeenCalledWith('echo hi')
  })

  it('waits for the IME to commit before sending a chord pressed mid-composition', async () => {
    const rig = await renderComposer()
    await type(rig.textarea, '안녕')
    await keydown(rig.textarea, { key: 'Enter', metaKey: true, isComposing: true })
    expect(rig.onSend).not.toHaveBeenCalled()
    await type(rig.textarea, '안녕하')
    await act(async () => {
      rig.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      await Promise.resolve()
    })
    expect(rig.onSend).toHaveBeenCalledWith('안녕하')
  })

  it('closes on Escape and the toggle chord, keeping the draft', async () => {
    const rig = await renderComposer()
    await type(rig.textarea, 'half written')
    await keydown(rig.textarea, { key: 'Escape', isComposing: true })
    expect(rig.onClose).not.toHaveBeenCalled()
    await keydown(rig.textarea, { key: 'Escape' })
    expect(rig.onClose).toHaveBeenCalledTimes(1)
    await keydown(rig.textarea, { key: '>', metaKey: true, shiftKey: true })
    expect(rig.onClose).toHaveBeenCalledTimes(2)
    expect(readTerminalComposerDraft('pane-a')).toBe('half written')
  })

  it('restores the pane draft and clears it only after a successful send', async () => {
    writeTerminalComposerDraft('pane-a', 'saved draft')
    const rig = await renderComposer()
    expect(rig.textarea.value).toBe('saved draft')
    rig.onSend.mockResolvedValueOnce('failed')
    await keydown(rig.textarea, { key: 'Enter', metaKey: true })
    expect(readTerminalComposerDraft('pane-a')).toBe('saved draft')
    await keydown(rig.textarea, { key: 'Enter', metaKey: true })
    expect(readTerminalComposerDraft('pane-a')).toBe('')
  })

  it('does not send an empty draft', async () => {
    const rig = await renderComposer()
    await type(rig.textarea, '   ')
    await keydown(rig.textarea, { key: 'Enter', metaKey: true })
    expect(rig.onSend).not.toHaveBeenCalled()
  })
})
