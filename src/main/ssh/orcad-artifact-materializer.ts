import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  orcadBunRuntimeFilename,
  orcadArtifactHashPrefix,
  ORCAD_TEMPLATE_TARGETS_DIR,
  ORCAD_VERSION,
  ORCAD_VERSION_FILENAME,
  ORCAD_RIPGREP_ARTIFACTS,
  orcadArtifactFilenames,
  orcadWebClientArtifactFilename
} from '../../shared/orcad-artifacts'
import type { OrcadBunTarget } from '../../shared/orcad-bun-runtime'
import { findOrcadCachePath } from './orcad-cache-path'
import {
  fileSha256,
  materializeCachedOrcadBunRuntime,
  type OrcadBunRuntimeMaterializeOptions
} from './orcad-bun-runtime-materializer'
import {
  readTemplateManifest,
  verifyTemplate,
  type OrcadTemplateManifest
} from './orcad-template-manifest'

type ArtifactSource = {
  filename: string
  path: string
  executable?: boolean
  /** Pinned by the web client manifest, which is itself hashed; kept out of the identity hash. */
  pinnedSha256?: string
}

type MaterializeOptions = OrcadBunRuntimeMaterializeOptions & {
  templateDir?: string
  cacheRoot?: string
}

const materializations = new Map<string, Promise<string>>()

export async function materializeOrcadArtifact(
  target: OrcadBunTarget,
  options: MaterializeOptions = {}
): Promise<string> {
  options.signal?.throwIfAborted()
  const templateDir = options.templateDir ?? resolveOrcadTemplateDir()
  const cacheRoot =
    options.cacheRoot ?? join(getAppEnvironment().getPath('userData'), 'orcad-artifacts')
  const key = `${templateDir}\0${cacheRoot}\0${target}`
  const existing = materializations.get(key)
  if (existing) {
    return waitForPromiseWithSignal(existing, options.signal)
  }
  // Cancellation detaches one caller; the bounded cache fill still serves other deployments.
  const pending = materializeOrcadArtifactInner(target, templateDir, cacheRoot, {
    fetcher: options.fetcher
  }).finally(() => materializations.delete(key))
  materializations.set(key, pending)
  return waitForPromiseWithSignal(pending, options.signal)
}

async function materializeOrcadArtifactInner(
  target: OrcadBunTarget,
  templateDir: string,
  cacheRoot: string,
  options: MaterializeOptions
): Promise<string> {
  const manifest = await readTemplateManifest(templateDir)
  await verifyTemplate(templateDir, target, manifest)
  const runtimePath = await materializeCachedOrcadBunRuntime(target, cacheRoot, options)
  return await assembleOrcadArtifact({ templateDir, cacheRoot, target, runtimePath, manifest })
}

export async function assembleOrcadArtifact(args: {
  templateDir: string
  cacheRoot: string
  target: OrcadBunTarget
  runtimePath: string
  manifest?: OrcadTemplateManifest
}): Promise<string> {
  const manifest = args.manifest ?? (await readTemplateManifest(args.templateDir))
  const webClientFiles = await verifyTemplate(args.templateDir, args.target, manifest)
  const sources: ArtifactSource[] = [
    ...artifactSources(args.templateDir, args.target, args.runtimePath, manifest),
    ...webClientFiles.map((file) => ({
      filename: orcadWebClientArtifactFilename(file),
      path: join(args.templateDir, orcadWebClientArtifactFilename(file)),
      pinnedSha256: file.sha256
    }))
  ]
  const { fullVersion, sourceHashes } = await computeArtifactIdentity(sources, args.target)
  const targetRoot = join(args.cacheRoot, args.target)
  const cached = await findOrcadCachePath(
    (attempt) => join(targetRoot, `${fullVersion}${attempt ? `.repair-${attempt}` : ''}`),
    (path) => isCompleteArtifact(path, fullVersion, sources, sourceHashes)
  )
  const targetDir = cached.path
  if (cached.verified) {
    return targetDir
  }
  await mkdir(targetRoot, { recursive: true })
  const stagingDir = join(targetRoot, `.staging-${process.pid}-${randomUUID()}`)
  try {
    for (const source of sources) {
      const destination = join(stagingDir, source.filename)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source.path, destination)
      if (source.executable && !args.target.startsWith('win32-')) {
        await chmod(destination, 0o755)
      }
    }
    await writeFile(join(stagingDir, ORCAD_VERSION_FILENAME), `${fullVersion}\n`, { mode: 0o600 })
    if (!(await isCompleteArtifact(stagingDir, fullVersion, sources, sourceHashes))) {
      throw new Error('Orcad artifact sources changed while copying')
    }
    try {
      await rename(stagingDir, targetDir)
    } catch (error) {
      if (!(await isCompleteArtifact(targetDir, fullVersion, sources, sourceHashes))) {
        throw new Error(`Orcad artifact cache entry is unavailable or corrupted: ${targetDir}`, {
          cause: error
        })
      }
    }
    return targetDir
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

function artifactSources(
  templateDir: string,
  target: OrcadBunTarget,
  runtimePath: string,
  manifest: OrcadTemplateManifest
): ArtifactSource[] {
  const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  const targetManifest = manifest.targets[target]
  if (!targetManifest) {
    throw new Error(`Packaged orcad template does not support ${target}`)
  }
  const required = orcadArtifactFilenames(target).map((filename) => ({
    filename,
    path:
      filename === orcadBunRuntimeFilename(target)
        ? runtimePath
        : filename === ORCAD_BUILD_TARGET_FILENAME
          ? join(targetDir, ORCAD_BUILD_TARGET_FILENAME)
          : filename.endsWith('watcher.node')
            ? join(targetDir, 'watcher.node')
            : join(templateDir, filename),
    executable:
      filename === orcadBunRuntimeFilename(target) ||
      ORCAD_RIPGREP_ARTIFACTS.some((artifact) => artifact === filename && artifact.endsWith('/rg'))
  }))
  if (!targetManifest.browserName) {
    return required
  }
  return [
    ...required,
    {
      filename: targetManifest.browserName,
      path: join(targetDir, targetManifest.browserName),
      executable: true
    }
  ]
}

async function computeArtifactIdentity(
  sources: ArtifactSource[],
  target: OrcadBunTarget
): Promise<{ fullVersion: string; sourceHashes: Map<string, string> }> {
  const hash = createHash('sha256').update(orcadArtifactHashPrefix(target))
  const sourceHashes = new Map<string, string>()
  for (const source of sources) {
    if (source.pinnedSha256) {
      // Why: matches build-orcad's version, which hashes the web client manifest, not each file.
      sourceHashes.set(source.filename, source.pinnedSha256)
      continue
    }
    const sourceHash = createHash('sha256')
    for await (const chunk of createReadStream(source.path)) {
      hash.update(chunk)
      sourceHash.update(chunk)
    }
    sourceHashes.set(source.filename, sourceHash.digest('hex'))
  }
  return {
    fullVersion: `${ORCAD_VERSION}+${hash.digest('hex').slice(0, 12)}`,
    sourceHashes
  }
}

async function isCompleteArtifact(
  dir: string,
  fullVersion: string,
  sources: { filename: string }[],
  sourceHashes: Map<string, string>
): Promise<boolean> {
  try {
    if ((await readFile(join(dir, ORCAD_VERSION_FILENAME), 'utf8')).trim() !== fullVersion) {
      return false
    }
    for (const source of sources) {
      if ((await fileSha256(join(dir, source.filename))) !== sourceHashes.get(source.filename)) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

export function getOrcadTemplateCandidates(): string[] {
  const candidates: string[] = []
  if (process.env.ORCA_ORCAD_TEMPLATE_PATH) {
    candidates.push(process.env.ORCA_ORCAD_TEMPLATE_PATH)
  }
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'orcad-template'))
  }
  const appPath = getAppEnvironment().getAppPath()
  candidates.push(
    join(appPath, 'out', 'orcad-template'),
    join(appPath, 'resources', 'orcad-template')
  )
  return [...new Set(candidates)]
}

function resolveOrcadTemplateDir(): string {
  const found = getOrcadTemplateCandidates().find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error('The packaged orcad deployment template is missing')
  }
  return found
}

export function resetOrcadArtifactMaterializationsForTests(): void {
  materializations.clear()
}
