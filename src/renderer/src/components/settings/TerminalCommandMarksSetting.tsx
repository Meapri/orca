import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SettingsSwitchRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import {
  getTerminalCommandMarksSearchEntries,
  getTerminalCommandMarksSettingDescription,
  getTerminalCommandMarksSettingTitle
} from './terminal-command-marks-search'

export function TerminalCommandMarksSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const enabled = settings.terminalCommandMarks !== false
  const [entry] = getTerminalCommandMarksSearchEntries()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      <SettingsSwitchRow
        label={getTerminalCommandMarksSettingTitle()}
        description={getTerminalCommandMarksSettingDescription()}
        checked={enabled}
        onChange={() => updateSettings({ terminalCommandMarks: !enabled })}
      />
    </SearchableSetting>
  )
}
