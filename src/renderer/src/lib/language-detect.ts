import { detectLanguage as detectEditorLanguage } from '../../../shared/editor-language-detect'
import { detectMonacoFilenameLanguage } from './monaco-filename-language'

export function detectLanguage(filePath: string): string {
  return detectEditorLanguage(filePath, detectMonacoFilenameLanguage)
}
