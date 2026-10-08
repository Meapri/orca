import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Input } from '../ui/input'
import { SettingsRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { parseFontFamilyList } from '@/lib/monospace-font-family'
import { translate } from '@/i18n/i18n'

// Font names are literals, not UI copy.
const EXAMPLE_FALLBACK_STACK = 'D2Coding, Noto Sans CJK KR'

type TerminalFontFallbackSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  searchEntry?: { description: string; keywords: string[] }
}

/** Normalizes a typed stack so equivalent spellings don't trigger a terminal re-measure. */
function normalizeFallbackStack(value: string): string {
  return parseFontFamilyList(value).join(', ')
}

export function TerminalFontFallbackSetting({
  settings,
  updateSettings,
  searchEntry
}: TerminalFontFallbackSettingProps): React.JSX.Element {
  const persisted = settings.terminalFontFallbackFamily ?? ''
  const [draft, setDraft] = useState(persisted)
  const [prevPersisted, setPrevPersisted] = useState(persisted)
  if (persisted !== prevPersisted) {
    // Why: settings can change elsewhere (Ghostty import, another window); follow the source.
    setPrevPersisted(persisted)
    setDraft(persisted)
  }
  // Why commit on blur/Enter: each font-family write re-measures and repaints every pane.
  const commit = (): void => {
    const next = normalizeFallbackStack(draft)
    setDraft(next)
    if (next !== persisted) {
      updateSettings({ terminalFontFallbackFamily: next })
    }
  }
  const title = translate(
    'auto.components.settings.TerminalFontFallbackSetting.title',
    'Fallback Fonts'
  )
  const description = translate(
    'auto.components.settings.TerminalFontFallbackSetting.description',
    'Comma-separated fonts tried after Font Family for characters it lacks, such as Korean, Chinese, Japanese or symbols. Orca already falls back to your system’s CJK fonts.'
  )

  return (
    <SearchableSetting
      title={title}
      description={searchEntry?.description ?? description}
      keywords={searchEntry?.keywords ?? ['terminal', 'font', 'fallback', 'cjk', 'korean']}
    >
      <SettingsRow
        label={title}
        description={description}
        control={
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit()
              }
            }}
            placeholder={EXAMPLE_FALLBACK_STACK}
            aria-label={title}
            spellCheck={false}
            className="w-56"
          />
        }
      />
    </SearchableSetting>
  )
}
