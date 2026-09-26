import { useEffect, useRef, useState } from 'react'
import { SendHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { translate } from '@/i18n/i18n'
import { readTerminalComposerDraft, writeTerminalComposerDraft } from './terminal-composer-drafts'
import type { TerminalComposerSendResult } from './terminal-composer-send'

type TerminalComposerProps = {
  paneKey: string
  isMac: boolean
  submitOnSend: boolean
  onSubmitOnSendChange: (submit: boolean) => void
  /** Whether a keydown is the (remappable) open-composer chord, which also closes it. */
  isToggleChord: (event: KeyboardEvent) => boolean
  onSend: (text: string) => Promise<TerminalComposerSendResult>
  onClose: () => void
}

export function TerminalComposer({
  paneKey,
  isMac,
  submitOnSend,
  onSubmitOnSendChange,
  isToggleChord,
  onSend,
  onClose
}: TerminalComposerProps): React.JSX.Element {
  const [text, setText] = useState(() => readTerminalComposerDraft(paneKey))
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Why: a send chord pressed mid-composition must wait for the IME to commit its text.
  const sendAfterCompositionRef = useRef(false)

  useEffect(() => {
    const textarea = textareaRef.current
    textarea?.focus()
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [])

  const updateText = (value: string): void => {
    setText(value)
    writeTerminalComposerDraft(paneKey, value)
  }

  const send = (): void => {
    const value = textareaRef.current?.value ?? text
    if (sending || !value.trim()) {
      return
    }
    setSending(true)
    void onSend(value).then((result) => {
      setSending(false)
      if (result === 'sent') {
        writeTerminalComposerDraft(paneKey, '')
      }
    })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const primaryModifier = isMac ? event.metaKey : event.ctrlKey
    if (event.key === 'Enter' && primaryModifier && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      if (isImeOwnedKeyboardEvent(event)) {
        sendAfterCompositionRef.current = true
        return
      }
      send()
      return
    }
    if (isImeOwnedKeyboardEvent(event)) {
      return
    }
    if (event.key === 'Escape' || isToggleChord(event.nativeEvent)) {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }

  const onCompositionEnd = (): void => {
    if (!sendAfterCompositionRef.current) {
      return
    }
    sendAfterCompositionRef.current = false
    // Why: the committed text lands in the value after compositionend returns.
    queueMicrotask(send)
  }

  const sendLabel = translate('components.terminalComposer.send', 'Send')
  return (
    <div
      data-terminal-composer-root=""
      data-pane-prevent-terminal-focus=""
      className="absolute inset-x-3 bottom-3 z-40 flex flex-col gap-2 rounded-lg border border-border bg-popover/95 p-2 text-popover-foreground shadow-floating backdrop-blur-sm"
    >
      <Textarea
        ref={textareaRef}
        value={text}
        rows={3}
        spellCheck
        aria-label={translate('components.terminalComposer.label', 'Terminal composer')}
        placeholder={translate(
          'components.terminalComposer.placeholder',
          'Compose input for the terminal. Enter adds a line.'
        )}
        className="max-h-60 resize-none"
        onChange={(event) => updateText(event.target.value)}
        onKeyDown={onKeyDown}
        onCompositionEnd={onCompositionEnd}
      />
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={submitOnSend}
            onCheckedChange={(checked) => onSubmitOnSendChange(checked === true)}
          />
          {translate('components.terminalComposer.submitOnSend', 'Press Enter after sending')}
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="ghost" size="xs" onClick={onClose}>
            {translate('components.terminalComposer.cancel', 'Cancel')}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="xs" disabled={sending || !text.trim()} onClick={send}>
                <SendHorizontal />
                {sendLabel}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              <span className="flex items-center gap-2">
                {sendLabel}
                <ShortcutKeyCombo keys={[isMac ? '⌘' : 'Ctrl', '↩']} />
              </span>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
