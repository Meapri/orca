import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import type { ClosedTerminalSurfaceLedgerStorage } from './closed-terminal-surface-ledger'

export const CLOSED_TERMINAL_SURFACE_LEDGER_FILE_NAME = 'closed-terminal-surfaces.json'

export function closedTerminalSurfaceLedgerPath(userDataPath: string): string {
  return join(userDataPath, CLOSED_TERMINAL_SURFACE_LEDGER_FILE_NAME)
}

/** Synchronous on purpose: the close must be durable before the host acknowledges it. */
export function createClosedTerminalSurfaceLedgerFileStorage(
  filePath: string
): ClosedTerminalSurfaceLedgerStorage {
  return {
    read: () => {
      try {
        return readFileSync(filePath, 'utf-8')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return null
        }
        throw error
      }
    },
    write: (serialized) => {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
      writeFileDurableSync(durableWriteTempPath(filePath), filePath, serialized)
    }
  }
}
