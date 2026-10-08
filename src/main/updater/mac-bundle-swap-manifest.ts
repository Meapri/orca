import { parse } from 'yaml'

export type MacBundleSwapAsset = {
  version: string
  url: string
  fileName: string
  sha512: string
  size: number | null
}

type ManifestFile = { url?: unknown; sha512?: unknown; size?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Picks the zip for `arch` out of electron-builder's latest-mac.yml and resolves it against the
 * release it came from. Throws on anything that would make the checksum meaningless.
 */
export function selectMacBundleSwapAsset(options: {
  manifestText: string
  releaseDownloadUrl: string
  expectedVersion: string
  arch: string
}): MacBundleSwapAsset {
  const parsed: unknown = parse(options.manifestText)
  if (!isRecord(parsed)) {
    throw new Error('Update manifest is not a YAML mapping')
  }
  const version = typeof parsed.version === 'string' ? parsed.version : null
  if (version !== options.expectedVersion) {
    throw new Error(
      `Update manifest version ${version ?? 'missing'} does not match ${options.expectedVersion}`
    )
  }
  const files: ManifestFile[] = Array.isArray(parsed.files) ? parsed.files.filter(isRecord) : []
  const zips = files.filter(
    (file): file is ManifestFile & { url: string } =>
      typeof file.url === 'string' && file.url.toLowerCase().endsWith('.zip')
  )
  // Why mirror electron-updater's MacUpdater: arm64 zips carry "arm64"; the x64 zip may carry no arch.
  const isArm64Zip = (file: { url: string }): boolean => /arm64/i.test(file.url)
  const zip = options.arch === 'arm64' ? zips.find(isArm64Zip) : zips.find((f) => !isArm64Zip(f))
  if (!zip) {
    throw new Error(`Update manifest has no ${options.arch} zip`)
  }
  if (typeof zip.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(zip.sha512)) {
    throw new Error('Update manifest zip entry has no valid sha512')
  }
  const base = options.releaseDownloadUrl.endsWith('/')
    ? options.releaseDownloadUrl
    : `${options.releaseDownloadUrl}/`
  const resolved = new URL(zip.url, base)
  // Why: an absolute URL in the manifest must not redirect the download off this release.
  if (!resolved.href.startsWith(base)) {
    throw new Error('Update manifest zip URL points outside its release')
  }
  const fileName = decodeURIComponent(resolved.pathname.split('/').findLast(Boolean) ?? '')
  if (!fileName || fileName.includes('/') || fileName.startsWith('.')) {
    throw new Error('Update manifest zip URL has no usable file name')
  }
  return {
    version,
    url: resolved.href,
    fileName,
    sha512: zip.sha512,
    size: typeof zip.size === 'number' && Number.isSafeInteger(zip.size) ? zip.size : null
  }
}
