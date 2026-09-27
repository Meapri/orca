import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { SpawnedProcess } from '../../shared/child-process/run-process'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { readRuntimeMetadata } from '../runtime/runtime-metadata'
import { sendOrcadSidecarRequest } from './orcad-sidecar-runtime-client'

const START_TIMEOUT_MS = 120_000
const RuntimeStatusResult = z.object({ capabilities: z.array(z.string()).optional() }).passthrough()

/** Polls the sidecar's runtime metadata until it answers `status.get` with browser.headless.v1. */
export async function waitForElectronServeSidecarReady(
  child: SpawnedProcess,
  userDataPath: string,
  signal?: AbortSignal
): Promise<RuntimeMetadata> {
  const deadline = Date.now() + START_TIMEOUT_MS
  let lastError: unknown = null
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('Installed Electron browser provider start was cancelled.')
    }
    const metadata = readRuntimeMetadata(userDataPath)
    if (metadata) {
      try {
        const status = RuntimeStatusResult.parse(
          await sendOrcadSidecarRequest(metadata, 'status.get', undefined, 5_000)
        )
        if (status.capabilities?.includes('browser.headless.v1')) {
          return metadata
        }
        lastError = new Error('Installed Electron app omitted browser.headless.v1.')
      } catch (error) {
        lastError = error
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      break
    }
    await delay(100)
  }
  throw new Error(
    `Installed Electron browser provider did not become ready: ${
      lastError instanceof Error ? lastError.message : 'no runtime metadata'
    }`
  )
}
