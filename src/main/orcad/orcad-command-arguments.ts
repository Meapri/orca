import type { OrcadOptions } from './orcad-entry'
import { parseOrcadResourceLimit } from './orcad-resource-limit-flags'
import { parsePairingOfferLifetime } from '../../shared/pairing-offer-lifetime'

/**
 * orcad's flags. A value-taking flag consumes the next token whatever it looks
 * like, so `--bind --json` binds to the literal `--json`; only a missing token
 * is an error. Pinned by orcad-launch-contract.test.ts.
 */
export function parseArgs(argv: string[]): OrcadOptions {
  const options: OrcadOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') {
      const raw = argv[i + 1]
      const port = Number(raw)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`--port expects an integer 0-65535, got ${raw ?? "''"}`)
      }
      options.port = port
      i += 1
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--no-pairing') {
      options.noPairing = true
    } else if (arg === '--mobile-pairing') {
      options.mobilePairing = true
    } else if (arg === '--bind') {
      const value = argv[i + 1]
      if (value === undefined) {
        throw new Error('--bind expects a value')
      }
      options.bind = value
      i += 1
    } else if (arg === '--pairing-expires') {
      const parsed = parsePairingOfferLifetime(argv[i + 1] ?? '')
      if (!parsed.ok) {
        throw new Error(`--pairing-expires: ${parsed.message}`)
      }
      options.pairingExpiresInMs = parsed.ms
      i += 1
    } else if (arg === '--pairing-address') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('--pairing-address expects a value')
      }
      // Why repeatable: a VPS is often reachable several ways (tailnet, public DNS, LAN); the
      // first stays the advertised endpoint and the rest become the offer's alternates.
      options.pairingAddress ??= value
      options.pairingAddresses = [...(options.pairingAddresses ?? []), value]
      i += 1
    } else if (arg === '--limit') {
      const [envName, value] = parseOrcadResourceLimit(argv[i + 1] ?? '')
      options.resourceLimits = { ...options.resourceLimits, [envName]: value }
      i += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}
