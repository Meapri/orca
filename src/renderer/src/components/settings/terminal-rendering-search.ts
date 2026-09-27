import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTerminalRenderingSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.13a2502dfc', 'GPU Acceleration'),
    description: translate(
      'auto.components.settings.terminal.search.8f9f953de7',
      'Controls whether the terminal uses xterm.js WebGL rendering. Auto tries WebGL when the renderer is supported, with conservative fallback for software or unknown GPU renderers.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.db82cb13b0', 'gpu'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.4b4e80d850',
        'acceleration'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.6cddc858ba', 'webgl'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.fffa9ab980', 'renderer'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.bc7ae1f7c0', 'rendering'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.7d924d870d', 'graphics'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.1abcf4d7de', 'linux')
    ]
  },
  {
    title: translate(
      'auto.components.settings.terminal.search.minimumContrast.title',
      'Color Contrast'
    ),
    description: translate(
      'auto.components.settings.terminal.search.minimumContrast.description',
      'Improve text readability or preserve the colors chosen by terminal programs.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.minimumContrast.contrast',
        'contrast'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.minimumContrast.minimum',
        'minimum'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.minimumContrast.ratio',
        'ratio'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.minimumContrast.readability',
        'readability'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.minimumContrast.wcag',
        'wcag'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.minimumContrast.powerline',
        'powerline'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.minimumContrast.statusline',
        'statusline'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.minimumContrast.dim',
        'dim'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.minimumContrast.colors',
        'colors'
      )
    ]
  },
  {
    title: translate(
      'components.settings.TerminalRendering.imePreeditInGrid',
      'Draw IME Composition in Terminal Cells'
    ),
    description: translate(
      'components.settings.TerminalRendering.imePreeditInGridDescription',
      'Render text being composed with an input method (Korean, Japanese, Chinese) as terminal cells at the cursor. Turn off to use the floating overlay instead.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('components.settings.TerminalRendering.search.ime', 'ime', {
        aliases: ['cjk']
      }),
      ...translateSearchKeyword(
        'components.settings.TerminalRendering.search.inputMethod',
        'input method'
      ),
      ...translateSearchKeyword(
        'components.settings.TerminalRendering.search.composition',
        'composition'
      ),
      ...translateSearchKeyword('components.settings.TerminalRendering.search.preedit', 'preedit'),
      ...translateSearchKeyword('components.settings.TerminalRendering.search.korean', 'korean', {
        aliases: ['hangul']
      }),
      ...translateSearchKeyword(
        'components.settings.TerminalRendering.search.japanese',
        'japanese'
      ),
      ...translateSearchKeyword('components.settings.TerminalRendering.search.chinese', 'chinese'),
      ...translateSearchKeyword('components.settings.TerminalRendering.search.overlay', 'overlay')
    ]
  },
  {
    title: translate(
      'components.settings.TerminalRendering.fitWideGlyphs',
      'Fit and Center Wide Characters'
    ),
    description: translate(
      'components.settings.TerminalRendering.fitWideGlyphsDescription',
      'Enlarge Korean, Chinese and Japanese characters drawn from a fallback font toward their two-cell width, never taller than the line, and center them so text does not look spaced out.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword(
        'components.settings.TerminalRendering.fitWideGlyphsSearch.wide',
        'wide'
      ),
      ...translateSearchKeyword(
        'components.settings.TerminalRendering.fitWideGlyphsSearch.cjk',
        'cjk'
      ),
      ...translateSearchKeyword(
        'components.settings.TerminalRendering.fitWideGlyphsSearch.korean',
        'korean'
      ),
      ...translateSearchKeyword(
        'components.settings.TerminalRendering.fitWideGlyphsSearch.hangul',
        'hangul'
      ),
      ...translateSearchKeyword(
        'components.settings.TerminalRendering.fitWideGlyphsSearch.chinese',
        'chinese'
      ),
      ...translateSearchKeyword(
        'components.settings.TerminalRendering.fitWideGlyphsSearch.japanese',
        'japanese'
      ),
      ...translateSearchKeyword(
        'components.settings.TerminalRendering.fitWideGlyphsSearch.fallback',
        'fallback'
      ),
      ...translateSearchKeyword(
        'components.settings.TerminalRendering.fitWideGlyphsSearch.spacing',
        'spacing'
      ),
      ...translateSearchKeyword(
        'components.settings.TerminalRendering.fitWideGlyphsSearch.center',
        'center'
      )
    ]
  }
])
