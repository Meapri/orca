// Builds the paired browser client into an orcad artifact directory and pins it with a manifest.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import {
  ORCAD_WEB_CLIENT_DIR,
  ORCAD_WEB_CLIENT_INDEX,
  ORCAD_WEB_CLIENT_MANIFEST_FILENAME,
  isSafeOrcadWebClientPath,
  parseOrcadWebClientManifest,
  serializeOrcadWebClientManifest
} from '../../src/shared/orcad-artifacts.ts'
import { runProcessSync } from './script-child-process.mjs'

const ROOT = resolve(import.meta.dirname, '../..')

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

/** Describes every file under `webDir` in manifest form; refuses names the runtime would not serve. */
export function describeOrcadWebClientFiles(webDir) {
  return listFiles(webDir).map((path) => {
    const relativePath = relative(webDir, path).split(sep).join('/')
    if (!isSafeOrcadWebClientPath(relativePath)) {
      throw new Error(`[orcad-web-client] unsupported file name in the web bundle: ${relativePath}`)
    }
    return {
      path: relativePath,
      size: statSync(path).size,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  })
}

function run(script, args) {
  const result = runProcessSync({
    program: process.execPath,
    args: [join(ROOT, 'config/scripts', script), ...args],
    cwd: ROOT,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`[orcad-web-client] ${script} failed with exit ${result.code ?? 'unknown'}`)
  }
}

/** Why build here rather than copy out/web: a stale desktop projection must never ship in orcad. */
export function stageOrcadWebClient(outDir) {
  const webDir = join(outDir, ORCAD_WEB_CLIENT_DIR)
  run('run-vite-web-build.mjs', ['--outDir', webDir, '--emptyOutDir', '--logLevel', 'error'])
  run('verify-web-build.mjs', [join(webDir, ORCAD_WEB_CLIENT_INDEX)])
  const manifestPath = join(outDir, ORCAD_WEB_CLIENT_MANIFEST_FILENAME)
  const manifest = serializeOrcadWebClientManifest(describeOrcadWebClientFiles(webDir))
  writeFileSync(manifestPath, manifest)
  // Why re-parse: the runtime and the template verifier read it with this exact parser.
  return parseOrcadWebClientManifest(readFileSync(manifestPath, 'utf8'))
}
