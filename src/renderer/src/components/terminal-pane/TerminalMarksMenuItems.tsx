import type { Terminal } from '@xterm/xterm'
import { Bookmark, BookmarkMinus, BookmarkPlus, ClipboardList, TextSelect } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { formatPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { getTerminalPaneMarks } from './terminal-marks/terminal-pane-marks'
import { runTerminalIdentityCopy } from './terminal-copy-rejection-guards'

type TerminalMarksMenuItemsProps = {
  getTerminal: () => Terminal | null
  keybindings: KeybindingOverrides
}

/** Command-output and bookmark rows; mounted only while the context menu is open. */
export function TerminalMarksMenuItems({
  getTerminal,
  keybindings
}: TerminalMarksMenuItemsProps): React.JSX.Element | null {
  const terminal = getTerminal()
  const marks = terminal ? getTerminalPaneMarks(terminal) : null
  if (!terminal || !marks) {
    return null
  }
  const line = marks.contextMenuLine() ?? undefined
  const commandOutput = marks.commandOutputAt(line) ?? marks.commandOutputAt()
  const bookmarkLine = line ?? terminal.buffer.active.baseY + terminal.buffer.active.cursorY
  const lineIsBookmarked = marks.hasBookmarkAtLine(bookmarkLine)
  const bookmarks = marks.listBookmarks()
  const bookmarkShortcut = formatPrimaryShortcutLabel('terminal.toggleBookmark', keybindings)

  const copyCommandOutput = (): void => {
    if (!commandOutput) {
      return
    }
    void runTerminalIdentityCopy({
      text: commandOutput.text,
      writeClipboardText: window.api.ui.writeTerminalClipboardText,
      onSuccess: () =>
        toast.success(
          translate('components.terminalPane.marks.commandOutputCopied', 'Command output copied')
        ),
      onError: () =>
        toast.error(
          translate(
            'components.terminalPane.marks.commandOutputCopyFailed',
            'Unable to copy command output'
          )
        ),
      focus: () => terminal.focus()
    })
  }

  return (
    <>
      <DropdownMenuSeparator />
      {commandOutput ? (
        <>
          <DropdownMenuItem onSelect={copyCommandOutput}>
            <ClipboardList />
            {translate('components.terminalPane.marks.copyCommandOutput', 'Copy Command Output')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              marks.selectCommandOutput(commandOutput.range.start)
              terminal.focus()
            }}
          >
            <TextSelect />
            {translate(
              'components.terminalPane.marks.selectCommandOutput',
              'Select Command Output'
            )}
          </DropdownMenuItem>
        </>
      ) : null}
      <DropdownMenuItem onSelect={() => marks.toggleBookmark(bookmarkLine)}>
        {lineIsBookmarked ? <BookmarkMinus /> : <BookmarkPlus />}
        {lineIsBookmarked
          ? translate('components.terminalPane.marks.removeBookmark', 'Remove Bookmark')
          : translate('components.terminalPane.marks.bookmarkLine', 'Bookmark Line')}
        {bookmarkShortcut !== 'Unassigned' ? (
          <DropdownMenuShortcut>{bookmarkShortcut}</DropdownMenuShortcut>
        ) : null}
      </DropdownMenuItem>
      {bookmarks.length > 0 ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Bookmark />
            {translate('components.terminalPane.marks.bookmarks', 'Bookmarks')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72">
            {bookmarks.map((bookmark) => (
              <DropdownMenuItem
                key={bookmark.id}
                onSelect={() => {
                  marks.jumpToBookmark(bookmark.id)
                  terminal.focus()
                }}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {bookmark.label ||
                    translate('components.terminalPane.marks.blankLine', 'Blank line')}
                </span>
                <DropdownMenuShortcut className="shrink-0">
                  {translate('components.terminalPane.marks.lineNumber', 'Line {{value0}}', {
                    value0: bookmark.line + 1
                  })}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      <DropdownMenuSeparator />
    </>
  )
}
