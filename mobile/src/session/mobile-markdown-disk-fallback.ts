import type { RpcFailure } from '../transport/types'
import { isRendererUnavailableRefusal } from '../transport/renderer-unavailable-refusal'

export function shouldReadMarkdownFromDiskAfterReadTabFailure(response: RpcFailure): boolean {
  return isRendererUnavailableRefusal(response)
}

// `truncated` is optional because the preview reader salvages it: an absent flag reads as not
// truncated here, which is the branch main took for a reply that omitted it.
export function buildMarkdownDiskFallbackDoc(args: {
  content: string
  truncated: boolean | undefined
  tabIsDirty: boolean
}) {
  const readOnlyReason = args.truncated
    ? 'File too large for mobile preview'
    : args.tabIsDirty
      ? 'Desktop has unsaved changes. Showing disk content.'
      : 'Editing needs Orca desktop running.'
  return {
    status: 'ready' as const,
    content: args.content,
    localContent: args.content,
    baseVersion: '',
    isDirty: false,
    editable: false,
    stale: args.tabIsDirty,
    readOnlyReason
  }
}
