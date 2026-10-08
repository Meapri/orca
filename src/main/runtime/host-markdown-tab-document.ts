import {
  hashMarkdownContent,
  isMarkdownContentByteLengthOverLimit,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES,
  type RuntimeMarkdownReadTabResult,
  type RuntimeMarkdownSaveTabResult
} from '../../shared/mobile-markdown-document'
import type { HostEditorTabRecord } from './host-editor-tab-store'

export const HOST_MARKDOWN_CONFLICT_ERROR = 'conflict'

/** Disk access for one markdown file on the host that holds it (local or SSH). */
export type HostMarkdownFileAccess = {
  /** Throws `file_too_large` / `binary_file` like the desktop editor's read. */
  read(): Promise<string>
  /** Replaces the file only while it still hashes to `expectedVersion`; throws `conflict`. */
  replaceIfUnchanged(expectedVersion: string, content: string): Promise<void>
}

export async function readHostMarkdownTab(
  tab: HostEditorTabRecord,
  file: HostMarkdownFileAccess
): Promise<RuntimeMarkdownReadTabResult> {
  const content = await file.read()
  const tooLarge = isMarkdownContentByteLengthOverLimit(content, MOBILE_MARKDOWN_EDIT_MAX_BYTES)
  return {
    tabId: tab.id,
    filePath: tab.filePath,
    relativePath: tab.relativePath,
    content,
    // Why: the host keeps no unsaved buffer; every save goes straight to disk.
    isDirty: false,
    version: hashMarkdownContent(content),
    source: 'file',
    editable: !tooLarge,
    ...(tooLarge ? { readOnlyReason: 'file_too_large' as const } : {})
  }
}

/**
 * The desktop bridge's save rules (mobile-markdown-bridge.ts), minus the renderer draft: a base
 * version that no longer matches disk is a conflict unless disk already holds this exact content,
 * and the write is verified by reading it back.
 */
export async function saveHostMarkdownTab(
  tab: HostEditorTabRecord,
  file: HostMarkdownFileAccess,
  baseVersion: string,
  content: string
): Promise<RuntimeMarkdownSaveTabResult> {
  if (isMarkdownContentByteLengthOverLimit(content, MOBILE_MARKDOWN_EDIT_MAX_BYTES)) {
    throw new Error('file_too_large')
  }
  const current = await file.read()
  const currentVersion = hashMarkdownContent(current)
  if (currentVersion !== baseVersion) {
    if (current === content) {
      // Why: a duplicate save tap racing behind the first successful write is not a conflict.
      return { tabId: tab.id, version: currentVersion, isDirty: false, content: current }
    }
    throw new Error(HOST_MARKDOWN_CONFLICT_ERROR)
  }
  await file.replaceIfUnchanged(baseVersion, content)
  const verified = await file.read()
  if (verified !== content) {
    throw new Error('save_verification_failed')
  }
  return {
    tabId: tab.id,
    version: hashMarkdownContent(verified),
    isDirty: false,
    content: verified
  }
}
