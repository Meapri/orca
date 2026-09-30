import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { MacBundleSwapAsset } from './mac-bundle-swap-manifest'

export type MacBundleSwapFetch = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<Pick<Response, 'ok' | 'status' | 'headers' | 'body'>>

/** Downloads the zip and returns its path only when size and sha512 match the manifest. */
export async function downloadMacBundleSwapAsset(options: {
  asset: MacBundleSwapAsset
  destinationDir: string
  request: MacBundleSwapFetch
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}): Promise<string> {
  const { asset, destinationDir } = options
  await mkdir(destinationDir, { recursive: true })
  const finalPath = join(destinationDir, asset.fileName)
  const partialPath = `${finalPath}.partial`
  await rm(partialPath, { force: true })

  const response = await options.request(asset.url, { signal: options.signal })
  if (!response.ok || !response.body) {
    throw new Error(`Update download failed with HTTP ${response.status}`)
  }
  const headerLength = Number(response.headers.get('content-length'))
  const totalBytes = asset.size ?? (Number.isSafeInteger(headerLength) ? headerLength : null)
  const hash = createHash('sha512')
  let receivedBytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      receivedBytes += chunk.length
      if (totalBytes) {
        options.onProgress?.(Math.min(receivedBytes / totalBytes, 1))
      }
      callback(null, chunk)
    }
  })
  try {
    await pipeline(
      Readable.from(readWebStream(response.body)),
      meter,
      createWriteStream(partialPath)
    )
    if (asset.size !== null && receivedBytes !== asset.size) {
      throw new Error(`Update download size ${receivedBytes} does not match ${asset.size}`)
    }
    const digest = hash.digest('base64')
    if (digest !== asset.sha512) {
      throw new Error('Update download checksum does not match the release manifest')
    }
    await rename(partialPath, finalPath)
    return finalPath
  } catch (error) {
    await rm(partialPath, { force: true })
    throw error
  }
}

async function* readWebStream(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}
