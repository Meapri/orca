import { join } from 'node:path'
import {
  closedTerminalSurfaceLedgerPath,
  createClosedTerminalSurfaceLedgerFileStorage
} from './closed-terminal-surface-ledger-file'
import { createDurableTextFileStorage } from './durable-text-file-storage'

export const HOST_EDITOR_TAB_STORE_FILE_NAME = 'host-editor-tabs.json'

/** The durable host-authored records a production runtime keeps in its data root. */
export function createRuntimeHostRecordStorages(userDataPath: string) {
  return {
    closedTerminalSurfaceLedgerStorage: createClosedTerminalSurfaceLedgerFileStorage(
      closedTerminalSurfaceLedgerPath(userDataPath)
    ),
    hostEditorTabStorage: createDurableTextFileStorage(
      join(userDataPath, HOST_EDITOR_TAB_STORE_FILE_NAME)
    )
  }
}
