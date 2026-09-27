import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'

/** A host-local record file. `null` read means absent; a throw from write is the caller's to log. */
export type DurableTextFileStorage = {
  read: () => string | null
  write: (serialized: string) => void
}

/** Synchronous on purpose: callers persist a mutation before the host acknowledges it. */
export function createDurableTextFileStorage(filePath: string): DurableTextFileStorage {
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
