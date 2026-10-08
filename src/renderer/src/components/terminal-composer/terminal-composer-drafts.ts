// Why: in-memory only — a draft survives closing the composer or switching tabs, not a relaunch.
const draftsByPaneKey = new Map<string, string>()

export function readTerminalComposerDraft(paneKey: string): string {
  return draftsByPaneKey.get(paneKey) ?? ''
}

export function writeTerminalComposerDraft(paneKey: string, text: string): void {
  if (text) {
    draftsByPaneKey.set(paneKey, text)
  } else {
    draftsByPaneKey.delete(paneKey)
  }
}
