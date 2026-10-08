/**
 * Finds the browser client shipped in orcad's install directory, the counterpart of the desktop's
 * `getBundledWebClientRoot()` for `orca serve`.
 *
 * Only release tarballs carry it (ORCAD_RELEASE_ONLY_PAYLOADS); SSH-managed slots do not.
 * Why size checks and not hashes: the tarball is checksum-verified before install, and the
 * installer writes `.install-complete` only after every file landed. Stat catches a torn or
 * hand-edited tree without re-hashing ~50 MB on every start.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ORCAD_WEB_CLIENT_DIR,
  ORCAD_WEB_CLIENT_MANIFEST_FILENAME,
  parseOrcadWebClientManifest
} from '../../shared/orcad-artifacts'

export type OrcadWebClientRoot = { root: string } | { root: null; reason: string }

export async function resolveOrcadWebClientRoot(installRoot: string): Promise<OrcadWebClientRoot> {
  let manifestText: string
  try {
    manifestText = await readFile(join(installRoot, ORCAD_WEB_CLIENT_MANIFEST_FILENAME), 'utf8')
  } catch {
    return { root: null, reason: 'this build ships no web client bundle' }
  }
  let files
  try {
    files = parseOrcadWebClientManifest(manifestText)
  } catch (error) {
    return { root: null, reason: error instanceof Error ? error.message : String(error) }
  }
  const root = join(installRoot, ORCAD_WEB_CLIENT_DIR)
  const stats = await Promise.all(
    files.map((file) => stat(join(root, ...file.path.split('/'))).catch(() => null))
  )
  const torn = files.find((file, index) => {
    const actual = stats[index]
    return !actual?.isFile() || actual.size !== file.size
  })
  return torn
    ? { root: null, reason: `web client file ${torn.path} is missing or incomplete` }
    : { root }
}
