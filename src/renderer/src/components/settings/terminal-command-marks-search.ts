import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export function getTerminalCommandMarksSettingTitle(): string {
  return translate('components.settings.TerminalCommandMarks.title', 'Show Command Marks')
}

export function getTerminalCommandMarksSettingDescription(): string {
  return translate(
    'components.settings.TerminalCommandMarks.description',
    'Mark each prompt and submitted line in the terminal gutter and scrollbar, with failed commands in red. Jumping between prompts works either way.'
  )
}

export const getTerminalCommandMarksSearchEntries = createLocalizedCatalog(() => [
  {
    title: getTerminalCommandMarksSettingTitle(),
    description: getTerminalCommandMarksSettingDescription(),
    keywords: [
      ...translateSearchKeyword('components.settings.TerminalCommandMarks.search.prompt', 'prompt'),
      ...translateSearchKeyword('components.settings.TerminalCommandMarks.search.marks', 'marks'),
      ...translateSearchKeyword(
        'components.settings.TerminalCommandMarks.search.command',
        'command'
      ),
      ...translateSearchKeyword('components.settings.TerminalCommandMarks.search.jump', 'jump'),
      ...translateSearchKeyword('components.settings.TerminalCommandMarks.search.gutter', 'gutter'),
      ...translateSearchKeyword(
        'components.settings.TerminalCommandMarks.search.scrollbar',
        'scrollbar'
      ),
      // englishOnly: an escape-sequence name; localizing it would index a word nobody types.
      ...translateSearchKeyword(
        'components.settings.TerminalCommandMarks.search.osc133',
        'osc 133',
        {
          englishOnly: true
        }
      ),
      ...translateSearchKeyword(
        'components.settings.TerminalCommandMarks.search.shellIntegration',
        'shell integration'
      )
    ]
  }
])
