import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { getTerminalClickToMoveCursorSearchEntry } from './terminal-pane-appearance-search'
import {
  normalizeTerminalClickToMoveCursorMode,
  type TerminalClickToMoveCursorMode
} from '../terminal-pane/terminal-click-to-move-cursor'

type TerminalClickToMoveCursorSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalClickToMoveCursorSetting({
  settings,
  updateSettings
}: TerminalClickToMoveCursorSettingProps): React.JSX.Element {
  const title = translate(
    'components.settings.TerminalInteraction.clickToMoveCursor',
    'Click to Move Cursor'
  )
  const description = translate(
    'components.settings.TerminalInteraction.clickToMoveCursorDescription',
    'Click on the line you are typing to move the cursor there. "At prompts" needs shell integration; "Any input line" also works in agent CLIs and REPLs.'
  )
  return (
    <SearchableSetting {...getTerminalClickToMoveCursorSearchEntry()}>
      <SettingsRow
        label={title}
        description={description}
        control={
          <SettingsSegmentedControl<TerminalClickToMoveCursorMode>
            ariaLabel={title}
            size="sm"
            value={normalizeTerminalClickToMoveCursorMode(settings.terminalClickToMoveCursor)}
            onChange={(value) => updateSettings({ terminalClickToMoveCursor: value })}
            options={[
              {
                value: 'off',
                label: translate('components.settings.TerminalInteraction.clickToMoveOff', 'Off')
              },
              {
                value: 'shell-prompt',
                label: translate(
                  'components.settings.TerminalInteraction.clickToMoveShellPrompt',
                  'At prompts'
                )
              },
              {
                value: 'input-line',
                label: translate(
                  'components.settings.TerminalInteraction.clickToMoveInputLine',
                  'Any input line'
                )
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
