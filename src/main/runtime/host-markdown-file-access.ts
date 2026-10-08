import { randomUUID } from 'node:crypto'
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { hashMarkdownContent } from '../../shared/mobile-markdown-document'
import { renameFileWithWindowsRetryAsync } from '../codex-accounts/fs-utils'
import { isBinaryBuffer } from '../ipc/filesystem/filesystem-file-content-inspection'
import type { IFilesystemProvider } from '../providers/types'
import {
  HOST_MARKDOWN_CONFLICT_ERROR,
  type HostMarkdownFileAccess
} from './host-markdown-tab-document'
import { MOBILE_FILE_READ_MAX_BYTES } from './runtime-file-commands-mobile-file-list-limit'

async function readLocalMarkdownText(authorizedPath: string): Promise<string> {
  const fileStat = await stat(authorizedPath)
  if (fileStat.isDirectory()) {
    throw new Error('Cannot read a directory')
  }
  if (fileStat.size > MOBILE_FILE_READ_MAX_BYTES) {
    throw new Error('file_too_large')
  }
  const buffer = await readFile(authorizedPath)
  if (isBinaryBuffer(buffer)) {
    throw new Error('binary_file')
  }
  return buffer.toString('utf8')
}

/** `authorize` is the filesystem root check (`resolveAuthorizedPath`); it answers the real path. */
export function createLocalHostMarkdownFileAccess(
  filePath: string,
  authorize: (filePath: string) => Promise<string>
): HostMarkdownFileAccess {
  return {
    read: async () => readLocalMarkdownText(await authorize(filePath)),
    replaceIfUnchanged: async (expectedVersion, content) => {
      // Why: realpath target, so a symlinked note is written through instead of replaced.
      const target = await authorize(filePath)
      const original = await stat(target)
      const tempPath = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
      try {
        await writeFile(tempPath, content, { encoding: 'utf-8', flag: 'wx' })
        await chmod(tempPath, original.mode & 0o7777)
        // Why: checked again after the slow write so a disk edit landing meanwhile is not clobbered.
        if (hashMarkdownContent(await readLocalMarkdownText(target)) !== expectedVersion) {
          throw new Error(HOST_MARKDOWN_CONFLICT_ERROR)
        }
        await renameFileWithWindowsRetryAsync(tempPath, target)
      } finally {
        await rm(tempPath, { force: true }).catch(() => {})
      }
    }
  }
}

async function readRemoteMarkdownText(
  filePath: string,
  provider: IFilesystemProvider
): Promise<string> {
  const fileStat = await provider.stat(filePath)
  if (fileStat.size > MOBILE_FILE_READ_MAX_BYTES) {
    throw new Error('file_too_large')
  }
  const result = await provider.readFile(filePath)
  if (result.isBinary) {
    throw new Error('binary_file')
  }
  return result.content
}

/** SSH has no rename-if-unchanged; the re-check narrows the clobber window to one round trip. */
export function createRemoteHostMarkdownFileAccess(
  filePath: string,
  provider: IFilesystemProvider
): HostMarkdownFileAccess {
  return {
    read: () => readRemoteMarkdownText(filePath, provider),
    replaceIfUnchanged: async (expectedVersion, content) => {
      if (
        hashMarkdownContent(await readRemoteMarkdownText(filePath, provider)) !== expectedVersion
      ) {
        throw new Error(HOST_MARKDOWN_CONFLICT_ERROR)
      }
      await provider.writeFile(filePath, content)
    }
  }
}
