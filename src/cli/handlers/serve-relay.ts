import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { callServeHost } from '../serve-host-client'
import { formatRelayReport, formatRelaySignInStart } from '../serve-relay-format'
import {
  ORCAD_RELAY_SIGN_IN_METHOD,
  ORCAD_RELAY_SIGN_OUT_METHOD,
  ORCAD_RELAY_STATUS_METHOD,
  type OrcadRelayReport,
  type OrcadRelaySignInStart
} from '../../shared/orcad-relay-contract'

const RELAY_UNSUPPORTED = new RuntimeClientError(
  'relay_unsupported',
  'This runtime does not administer Orca Relay from the CLI: it is the desktop app (use Settings > Mobile) or an orcad older than this CLI. Update orcad on the server host.'
)

const REMOTE_SELECTION_SUFFIX =
  'serve relay; it signs this host in to Orca Relay. Run it on the server host (for example over SSH).'

// Why: matches the PKCE listener's own 5-minute deadline, plus slack for the final exchange.
const SIGN_IN_WAIT_MS = 5 * 60_000 + 15_000
const SIGN_IN_POLL_MS = 1_000

function callRelay<TResult>(flags: HandlerContext['flags'], method: string) {
  return callServeHost<TResult>(flags, method, undefined, RELAY_UNSUPPORTED)
}

async function waitForSignIn(flags: HandlerContext['flags']): Promise<OrcadRelayReport> {
  const deadline = Date.now() + SIGN_IN_WAIT_MS
  for (;;) {
    const { result } = await callRelay<OrcadRelayReport>(flags, ORCAD_RELAY_STATUS_METHOD)
    if (result.lastSignIn?.outcome !== 'pending' || Date.now() > deadline) {
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, SIGN_IN_POLL_MS))
  }
}

export const SERVE_RELAY_HANDLERS: Record<string, CommandHandler> = {
  'serve relay status': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(flags, REMOTE_SELECTION_SUFFIX)
    const response = await callRelay<OrcadRelayReport>(flags, ORCAD_RELAY_STATUS_METHOD)
    printResult(response, json, formatRelayReport)
  },
  'serve relay sign-in': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(flags, REMOTE_SELECTION_SUFFIX)
    const response = await callRelay<OrcadRelaySignInStart>(flags, ORCAD_RELAY_SIGN_IN_METHOD)
    const start = response.result
    if (!start.started) {
      throw new RuntimeClientError(start.reason, start.guidance)
    }
    // Why not wait under --json: automation reads the URL now and polls `serve relay status` itself.
    if (json) {
      printResult(response, true, () => '')
      return
    }
    console.log(formatRelaySignInStart(start))
    const report = await waitForSignIn(flags)
    console.log(formatRelayReport(report))
    if (report.lastSignIn?.outcome !== 'connected') {
      process.exitCode = 1
    }
  },
  'serve relay sign-out': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(flags, REMOTE_SELECTION_SUFFIX)
    const response = await callRelay<OrcadRelayReport>(flags, ORCAD_RELAY_SIGN_OUT_METHOD)
    printResult(response, json, formatRelayReport)
  }
}
