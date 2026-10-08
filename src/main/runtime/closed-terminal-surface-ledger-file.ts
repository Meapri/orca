import { join } from 'node:path'
import type { ClosedTerminalSurfaceLedgerStorage } from './closed-terminal-surface-ledger'
import { createDurableTextFileStorage } from './durable-text-file-storage'

export const CLOSED_TERMINAL_SURFACE_LEDGER_FILE_NAME = 'closed-terminal-surfaces.json'

export function closedTerminalSurfaceLedgerPath(userDataPath: string): string {
  return join(userDataPath, CLOSED_TERMINAL_SURFACE_LEDGER_FILE_NAME)
}

/** Synchronous on purpose: the close must be durable before the host acknowledges it. */
export function createClosedTerminalSurfaceLedgerFileStorage(
  filePath: string
): ClosedTerminalSurfaceLedgerStorage {
  return createDurableTextFileStorage(filePath)
}
