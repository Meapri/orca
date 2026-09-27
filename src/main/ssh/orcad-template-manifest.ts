import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  ORCAD_WEB_CLIENT_MANIFEST_FILENAME,
  orcadTemplateCommonFilenames,
  orcadWebClientArtifactFilename,
  parseOrcadWebClientManifest,
  type OrcadWebClientFile
} from '../../shared/orcad-artifacts'
import type { OrcadBunTarget } from '../../shared/orcad-bun-runtime'
import { verifyFileSha256 } from './orcad-bun-runtime-materializer'

const TemplateTargetSchema = z
  .object({
    targetSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    watcherSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    browserName: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
      .optional(),
    browserSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional()
  })
  .refine((target) => Boolean(target.browserName) === Boolean(target.browserSha256), {
    message: 'browserName and browserSha256 must either both be present or both be absent'
  })
const TemplateManifestSchema = z.object({
  schemaVersion: z.literal(2),
  commonSha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
  targets: z.record(z.string(), TemplateTargetSchema)
})

export type OrcadTemplateManifest = z.infer<typeof TemplateManifestSchema>

export async function readTemplateManifest(templateDir: string): Promise<OrcadTemplateManifest> {
  return TemplateManifestSchema.parse(
    JSON.parse(await readFile(join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME), 'utf8'))
  )
}

export async function verifyTemplate(
  templateDir: string,
  target: OrcadBunTarget,
  manifest: OrcadTemplateManifest
): Promise<OrcadWebClientFile[]> {
  const targetManifest = manifest.targets[target]
  if (!targetManifest) {
    throw new Error(`Packaged orcad template does not support ${target}`)
  }
  const commonFilenames = orcadTemplateCommonFilenames()
  for (const filename of commonFilenames) {
    const expected = manifest.commonSha256[filename]
    if (!expected) {
      throw new Error(`Packaged orcad template manifest omits ${filename}`)
    }
    await verifyFileSha256(join(templateDir, filename), expected, `orcad template ${filename}`)
  }
  const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  const targetIdentityPath = join(targetDir, ORCAD_BUILD_TARGET_FILENAME)
  await verifyFileSha256(targetIdentityPath, targetManifest.targetSha256, `${target} build target`)
  if ((await readFile(targetIdentityPath, 'utf8')).trim() !== target) {
    throw new Error(`Packaged orcad template target identity does not match ${target}`)
  }
  await verifyFileSha256(
    join(targetDir, 'watcher.node'),
    targetManifest.watcherSha256,
    `${target} watcher`
  )
  if (targetManifest.browserName && targetManifest.browserSha256) {
    await verifyFileSha256(
      join(targetDir, targetManifest.browserName),
      targetManifest.browserSha256,
      `${target} browser`
    )
  }
  // The manifest's own bytes were verified above as a common artifact.
  const webClientFiles = parseOrcadWebClientManifest(
    await readFile(join(templateDir, ORCAD_WEB_CLIENT_MANIFEST_FILENAME), 'utf8')
  )
  for (const file of webClientFiles) {
    await verifyFileSha256(
      join(templateDir, orcadWebClientArtifactFilename(file)),
      file.sha256,
      `orcad template web client ${file.path}`
    )
  }
  return webClientFiles
}
