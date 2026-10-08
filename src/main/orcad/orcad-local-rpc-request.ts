// One newline-framed request over a runtime's local socket, shared by the browser sidecar and the
// orcad self-probe so both read keepalives, size caps and id mismatches the same way.
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { z } from 'zod'
import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'

export type LocalRuntimeRpcFailureKind =
  | 'no_transport'
  | 'connect_failed'
  | 'closed'
  | 'too_large'
  | 'invalid_json'
  | 'invalid_response'
  | 'timeout'

export type LocalRuntimeRpcFailure =
  | { kind: LocalRuntimeRpcFailureKind }
  | { kind: 'rpc_error'; code: string; message: string }

const RuntimeResponse = z.discriminatedUnion('ok', [
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }).passthrough(),
  z
    .object({
      id: z.string(),
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string() }).passthrough()
    })
    .passthrough()
])

export async function sendLocalRuntimeRpcRequest(options: {
  metadata: RuntimeMetadata
  method: string
  params: unknown
  timeoutMs: number
  maxResponseBytes: number
  toError: (failure: LocalRuntimeRpcFailure) => Error
}): Promise<unknown> {
  const { metadata, method, params, timeoutMs, maxResponseBytes, toError } = options
  const transport = findTransport(metadata, 'unix', 'named-pipe')
  if (!transport) {
    throw toError({ kind: 'no_transport' })
  }
  return await new Promise((resolve, reject) => {
    const socket = createConnection(transport.endpoint)
    const requestId = randomUUID()
    let buffer = ''
    let retainedBytes = 0
    let settled = false
    const finish = (failure: LocalRuntimeRpcFailure | null, result?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.end()
      if (failure) {
        reject(toError(failure))
      } else {
        resolve(result)
      }
    }
    const timer = setTimeout(() => {
      socket.destroy()
      finish({ kind: 'timeout' })
    }, timeoutMs)
    timer.unref?.()
    socket.setEncoding('utf8')
    socket.once('error', () => finish({ kind: 'connect_failed' }))
    socket.once('close', () => finish({ kind: 'closed' }))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      retainedBytes += Buffer.byteLength(chunk, 'utf8')
      if (retainedBytes > maxResponseBytes) {
        socket.destroy()
        finish({ kind: 'too_large' })
        return
      }
      // The retained tail has no newline; avoid flattening it for each partial chunk.
      if (!chunk.includes('\n')) {
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline !== -1 && !settled) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        retainedBytes = Buffer.byteLength(buffer, 'utf8')
        newline = buffer.indexOf('\n')
        if (!line.trim()) {
          continue
        }
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          finish({ kind: 'invalid_json' })
          return
        }
        if (raw && typeof raw === 'object' && '_keepalive' in raw) {
          timer.refresh()
          continue
        }
        const parsed = RuntimeResponse.safeParse(raw)
        if (!parsed.success || parsed.data.id !== requestId) {
          finish({ kind: 'invalid_response' })
          return
        }
        if (!parsed.data.ok) {
          finish({
            kind: 'rpc_error',
            code: parsed.data.error.code,
            message: parsed.data.error.message
          })
          return
        }
        finish(null, parsed.data.result)
      }
    })
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ id: requestId, authToken: metadata.authToken, method, params })}\n`
      )
    })
  })
}
