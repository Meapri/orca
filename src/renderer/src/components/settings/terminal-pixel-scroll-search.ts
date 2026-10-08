import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export function getTerminalPixelScrollSettingTitle(): string {
  return translate('components.settings.TerminalPixelScroll.title', 'Pixel Scrolling')
}

export function getTerminalPixelScrollSettingDescription(): string {
  return translate(
    'components.settings.TerminalPixelScroll.description',
    'Trackpad and wheel scrolling in the scrollback moves by pixels, then settles on a whole row. Requires GPU rendering; mouse-aware terminal apps and reduced motion keep row-by-row scrolling.'
  )
}

export const getTerminalPixelScrollSearchEntries = createLocalizedCatalog(() => [
  {
    title: getTerminalPixelScrollSettingTitle(),
    description: getTerminalPixelScrollSettingDescription(),
    keywords: [
      ...translateSearchKeyword('components.settings.TerminalPixelScroll.search.scroll', 'scroll'),
      ...translateSearchKeyword('components.settings.TerminalPixelScroll.search.pixel', 'pixel'),
      ...translateSearchKeyword('components.settings.TerminalPixelScroll.search.smooth', 'smooth'),
      ...translateSearchKeyword(
        'components.settings.TerminalPixelScroll.search.trackpad',
        'trackpad'
      ),
      ...translateSearchKeyword('components.settings.TerminalPixelScroll.search.wheel', 'wheel')
    ]
  }
])
