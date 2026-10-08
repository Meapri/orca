/** Serve-readiness pieces shared by the desktop `--serve` host and orcad, so their stdout matches. */
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

// Shared so the `orca serve pairing` CLI renders the same QR without main's module graph.
export { renderTerminalPairingQr as renderServePairingQr } from '../../shared/terminal-pairing-qr'

/** The recipe line names this root, so it must be a real absolute directory. */
export function assertServeProjectRoot(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) {
    throw new Error(`--serve-project-root must be absolute: ${projectRoot}`)
  }
  if (!statSync(projectRoot).isDirectory()) {
    throw new Error(`--serve-project-root must be a directory: ${projectRoot}`)
  }
  return projectRoot
}
