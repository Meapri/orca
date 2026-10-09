/**
 * A local stand-in for the Orca Cloud account API a relay host talks to: the PKCE authorize
 * redirect, the session exchange, and the host-control relay token the relay verifies against
 * this server's JWKS. Tests and the orcad relay smoke use it so nothing ever reaches the
 * production endpoints. Only node builtins and erasable TypeScript, so plain `node` can load it.
 */
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'

export type FakeOrcaCloudApi = {
  url: string
  /** The issuer the relay must trust (`ORCA_RELAY_AUTH_ISSUER`); its JWKS is at `${issuer}/jwks`. */
  issuer: string
  /** Relay tokens minted so far, by relayHostId. */
  relayTokensIssued: () => string[]
  stop: () => Promise<void>
}

type Account = { userId: string; cloudProfileId: string; email: string }

const DEFAULT_ACCOUNT: Account = {
  userId: 'user-relay-smoke',
  cloudProfileId: 'cloud-profile-relay-smoke',
  email: 'relay-smoke@example.test'
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function signRelayToken(
  privateKey: KeyObject,
  issuer: string,
  account: Account,
  relayHostId: string
): string {
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: 'fake-cloud', typ: 'JWT' }))
  const payload = base64Url(
    JSON.stringify({
      iss: issuer,
      aud: 'orca-relay',
      sub: account.userId,
      prof: account.cloudProfileId,
      relayHostId,
      purpose: 'host-control',
      iat: now,
      exp: now + 600
    })
  )
  const signature = sign('SHA256', Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  })
  return `${header}.${payload}.${base64Url(signature)}`
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    request.setEncoding('utf-8')
    request.on('data', (chunk: string) => {
      raw += chunk
    })
    request.on('end', () => {
      try {
        const parsed: unknown = raw ? JSON.parse(raw) : {}
        resolve(typeof parsed === 'object' && parsed !== null ? { ...parsed } : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

export async function startFakeOrcaCloudApi(
  options: {
    tls?: { key: string; cert: string }
    account?: Account
    onRequest?: (method: string, path: string, status: number) => void
  } = {}
): Promise<FakeOrcaCloudApi> {
  const account = options.account ?? DEFAULT_ACCOUNT
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'fake-cloud',
    alg: 'ES256',
    use: 'sig'
  }
  const accessTokens = new Set<string>()
  const relayTokens: string[] = []
  let origin = ''

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', origin)
    const json = (status: number, body: unknown): void => {
      options.onRequest?.(request.method ?? '', url.pathname, status)
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.method === 'GET' && url.pathname === '/jwks') {
      json(200, { keys: [jwk] })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/desktop/auth/authorize') {
      // Why redirect straight back: the fake user has already consented.
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
      redirect.searchParams.set('code', `code-${randomUUID()}`)
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '')
      response.writeHead(302, { location: redirect.toString() })
      response.end()
      return
    }
    const authorization = request.headers.authorization ?? ''
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    const body = await readBody(request)
    if (
      url.pathname === '/v1/desktop/auth/session' ||
      url.pathname === '/v1/desktop/auth/refresh'
    ) {
      const accessToken = `access-${randomUUID()}`
      accessTokens.add(accessToken)
      json(200, {
        accessToken,
        refreshToken: `refresh-${randomUUID()}`,
        expiresAt: Date.now() + 3_600_000,
        cloud: { ...account, linkedAt: Date.now() },
        capabilities: { flags: { 'relay.use': true }, refreshedAt: Date.now() }
      })
      return
    }
    if (url.pathname === '/v1/desktop/auth/capabilities') {
      json(200, { capabilities: { flags: { 'relay.use': true }, refreshedAt: Date.now() } })
      return
    }
    if (url.pathname === '/v1/desktop/auth/logout') {
      accessTokens.delete(bearer)
      json(200, {})
      return
    }
    if (url.pathname === '/v1/desktop/auth/relay-token') {
      const relayHostId = typeof body.relayHostId === 'string' ? body.relayHostId : ''
      const hostKey = typeof body.hostPublicKeyB64 === 'string' ? body.hostPublicKeyB64 : ''
      const derived = createHash('sha256')
        .update(Buffer.from(hostKey, 'base64'))
        .digest('base64url')
        .slice(0, 16)
      // Why check the derivation: the real API binds the token to the host key the same way.
      if (!accessTokens.has(bearer) || relayHostId !== derived) {
        json(401, { error: 'unauthorized' })
        return
      }
      relayTokens.push(relayHostId)
      json(200, {
        relayToken: signRelayToken(privateKey, origin, account, relayHostId),
        expiresAt: Date.now() + 600_000
      })
      return
    }
    json(404, { error: 'not_found' })
  }

  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    handler(request, response).catch(() => {
      response.writeHead(500)
      response.end()
    })
  }
  const server: Server = options.tls
    ? createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, listener)
    : createHttpServer(listener)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('fake Orca Cloud API has no TCP address')
  }
  const port = address.port
  origin = `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`
  return {
    url: origin,
    issuer: origin,
    relayTokensIssued: () => relayTokens.slice(),
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
