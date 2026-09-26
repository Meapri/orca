import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { TerminalComposer } from '../terminal-composer/TerminalComposer'
import {
  OPEN_TERMINAL_COMPOSER_EVENT,
  readOpenTerminalComposerDetail
} from '../terminal-composer/terminal-composer-open-event'
import { sendTerminalComposerText } from '../terminal-composer/terminal-composer-send'
import { createTerminalPanePasteExecution } from './terminal-pane-paste-execution'
import type { TerminalPaneController } from './use-terminal-pane-controller'

export function TerminalPaneComposerPortal({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const { tabId, managedPanes, paneKittyKeyboardModesRef, keybindings } = controller
  const [openPaneId, setOpenPaneId] = useState<number | null>(null)
  const submitOnSend = useAppStore(
    (state) => state.settings?.terminalComposerSubmitOnSend !== false
  )
  const updateSettings = useAppStore((state) => state.updateSettings)

  useEffect(() => {
    const onOpen = (event: Event): void => {
      const detail = readOpenTerminalComposerDetail(event)
      if (detail?.tabId === tabId) {
        setOpenPaneId((current) => (current === detail.paneId ? null : detail.paneId))
      }
    }
    window.addEventListener(OPEN_TERMINAL_COMPOSER_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_TERMINAL_COMPOSER_EVENT, onOpen)
  }, [tabId])

  const pane = managedPanes.find((candidate) => candidate.id === openPaneId)
  if (!pane) {
    return null
  }
  const platform = getShortcutPlatform()
  const paneKey = makePaneKey(tabId, pane.leafId)
  const close = (): void => {
    setOpenPaneId(null)
    pane.terminal.focus()
  }
  const send = (text: string): ReturnType<typeof sendTerminalComposerText> => {
    close()
    const execution = createTerminalPanePasteExecution(controller, platform)
    return sendTerminalComposerText(
      text,
      { submit: submitOnSend },
      {
        pasteText: (payload) => execution.executePanePasteText(pane, 'programmatic', null, payload),
        writeInput: (data) => pane.terminal.input(data, true),
        getKittyKeyboardFlags: () => paneKittyKeyboardModesRef.current.get(pane.id)?.flags ?? 0
      }
    )
  }

  return createPortal(
    <TerminalComposer
      key={paneKey}
      paneKey={paneKey}
      isMac={platform === 'darwin'}
      submitOnSend={submitOnSend}
      onSubmitOnSendChange={(submit) =>
        void updateSettings({ terminalComposerSubmitOnSend: submit })
      }
      isToggleChord={(event) =>
        keybindingMatchesAction('terminal.openComposer', event, platform, keybindings)
      }
      onSend={send}
      onClose={close}
    />,
    pane.container,
    `terminal-composer-${pane.id}`
  )
}
