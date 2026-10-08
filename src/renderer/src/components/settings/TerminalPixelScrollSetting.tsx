import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveTerminalPixelScroll } from '@/lib/pane-manager/terminal-pixel-scroll'
import { SettingsSwitchRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import {
  getTerminalPixelScrollSearchEntries,
  getTerminalPixelScrollSettingDescription,
  getTerminalPixelScrollSettingTitle
} from './terminal-pixel-scroll-search'

export function TerminalPixelScrollSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const enabled = resolveTerminalPixelScroll(settings.terminalPixelScroll)
  const [entry] = getTerminalPixelScrollSearchEntries()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      <SettingsSwitchRow
        label={getTerminalPixelScrollSettingTitle()}
        description={getTerminalPixelScrollSettingDescription()}
        checked={enabled}
        onChange={() => updateSettings({ terminalPixelScroll: !enabled })}
      />
    </SearchableSetting>
  )
}
