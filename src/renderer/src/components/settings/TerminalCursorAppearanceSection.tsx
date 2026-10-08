import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  NumberField,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { clampNumber } from '@/lib/terminal-theme'
import { translate } from '@/i18n/i18n'
import { resolveTerminalCursorAnimationEnabled } from '../../../../shared/terminal-cursor-animation-settings'
import { resolveTerminalAdoptAppCaretEnabled } from '../../../../shared/terminal-app-caret-settings'

type TerminalCursorAppearanceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalCursorAppearanceSection({
  settings,
  updateSettings
}: TerminalCursorAppearanceSectionProps): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.TerminalAppearanceSection.abcb4dd019',
          'Terminal Cursor'
        )}
      />

      <div className="ml-4 divide-y divide-border/40">
        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalAppearanceSection.db270cc9a9',
            'Cursor Shape'
          )}
          description={translate(
            'auto.components.settings.TerminalAppearanceSection.d455f2ef4f',
            'Default cursor appearance for Orca terminal panes.'
          )}
          keywords={['terminal', 'cursor', 'bar', 'block', 'underline']}
        >
          {/* Why: Bar/Block/Underline options convey the meaning; helper text pruned. */}
          <SettingsRow
            label={translate(
              'auto.components.settings.TerminalAppearanceSection.db270cc9a9',
              'Cursor Shape'
            )}
            control={
              <SettingsSegmentedControl
                ariaLabel={translate(
                  'auto.components.settings.TerminalAppearanceSection.db270cc9a9',
                  'Cursor Shape'
                )}
                value={settings.terminalCursorStyle}
                onChange={(option) => updateSettings({ terminalCursorStyle: option })}
                options={[
                  {
                    value: 'bar',
                    label: translate(
                      'auto.components.settings.TerminalAppearanceSection.e070e8aeba',
                      'Bar'
                    )
                  },
                  {
                    value: 'block',
                    label: translate(
                      'auto.components.settings.TerminalAppearanceSection.52854a5608',
                      'Block'
                    )
                  },
                  {
                    value: 'underline',
                    label: translate(
                      'auto.components.settings.TerminalAppearanceSection.2e5aec3cf6',
                      'Underline'
                    )
                  }
                ]}
              />
            }
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalAppearanceSection.74736cc9b1',
            'Blinking Cursor'
          )}
          description={translate(
            'auto.components.settings.TerminalAppearanceSection.2de6b5a699',
            'Uses the blinking variant of the selected cursor shape.'
          )}
          keywords={['terminal', 'cursor', 'blink']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.TerminalAppearanceSection.74736cc9b1',
              'Blinking Cursor'
            )}
            checked={settings.terminalCursorBlink}
            onChange={() => updateSettings({ terminalCursorBlink: !settings.terminalCursorBlink })}
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalAppearanceSection.0739c1f2b6',
            'Cursor Animation'
          )}
          description={translate(
            'auto.components.settings.TerminalAppearanceSection.ebde1c981e',
            'Glides the cursor as you type and fades its blink. Requires GPU rendering.'
          )}
          keywords={['terminal', 'cursor', 'animation', 'smooth', 'glide', 'motion', 'fade']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.TerminalAppearanceSection.0739c1f2b6',
              'Cursor Animation'
            )}
            description={translate(
              'auto.components.settings.TerminalAppearanceSection.ebde1c981e',
              'Glides the cursor as you type and fades its blink. Requires GPU rendering.'
            )}
            checked={resolveTerminalCursorAnimationEnabled(settings.terminalCursorAnimation)}
            onChange={() =>
              updateSettings({
                terminalCursorAnimation: !resolveTerminalCursorAnimationEnabled(
                  settings.terminalCursorAnimation
                )
              })
            }
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalAppearanceSection.b2ff21a421',
            'Terminal Cursor for App Carets'
          )}
          description={translate(
            'auto.components.settings.TerminalAppearanceSection.c9f01528ff',
            'When a terminal app hides the cursor and paints its own caret, draws the terminal cursor there with your shape, blink and animation.'
          )}
          keywords={['terminal', 'cursor', 'caret', 'tui', 'inverse', 'smooth']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.TerminalAppearanceSection.b2ff21a421',
              'Terminal Cursor for App Carets'
            )}
            description={translate(
              'auto.components.settings.TerminalAppearanceSection.c9f01528ff',
              'When a terminal app hides the cursor and paints its own caret, draws the terminal cursor there with your shape, blink and animation.'
            )}
            checked={resolveTerminalAdoptAppCaretEnabled(settings.terminalAdoptAppCaret)}
            onChange={() =>
              updateSettings({
                terminalAdoptAppCaret: !resolveTerminalAdoptAppCaretEnabled(
                  settings.terminalAdoptAppCaret
                )
              })
            }
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalAppearanceSection.b9f1804422',
            'Cursor Opacity'
          )}
          description={translate(
            'auto.components.settings.TerminalAppearanceSection.04cdf85dec',
            'Opacity of the terminal cursor.'
          )}
          keywords={['terminal', 'cursor', 'opacity', 'transparency']}
        >
          <NumberField
            label={translate(
              'auto.components.settings.TerminalAppearanceSection.b9f1804422',
              'Cursor Opacity'
            )}
            description=""
            value={settings.terminalCursorOpacity ?? 1}
            defaultValue={1}
            min={0}
            max={1}
            step={0.05}
            suffix="0-1"
            onChange={(value) =>
              updateSettings({
                terminalCursorOpacity: clampNumber(value, 0, 1)
              })
            }
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
