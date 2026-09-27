/** Per-command flag help, kept out of the shared help chain it would crowd. */
const SERVE_DATA_ROOT_HELP =
  '--data-root <path>     Runtime data root (default: $ORCA_USER_DATA, else the running orcad or desktop runtime)'

const COMMAND_SCOPED_FLAG_HELP: Record<string, Record<string, string>> = {
  'serve status': {
    fresh: '--fresh                Re-run the terminal-daemon self-test before answering',
    'data-root': SERVE_DATA_ROOT_HELP
  },
  'serve doctor': {
    'data-root': SERVE_DATA_ROOT_HELP,
    bind: '--bind <ip>            Listener address orcad will use (default 127.0.0.1)',
    port: '--port <port>          Pinned port orcad will use (default 6768, not pinned)'
  },
  'serve pairing': {
    rotate: '--rotate               Revoke the unused startup pairing offer and mint a new one',
    'data-root': SERVE_DATA_ROOT_HELP
  },
  'serve pairing new': {
    relay:
      '--relay                With --mobile: add an Orca Relay invite (orcad --relay, signed in)',
    'data-root': SERVE_DATA_ROOT_HELP
  },
  'serve relay status': { 'data-root': SERVE_DATA_ROOT_HELP },
  'serve relay sign-in': { 'data-root': SERVE_DATA_ROOT_HELP },
  'serve relay sign-out': { 'data-root': SERVE_DATA_ROOT_HELP },
  'serve devices list': { 'data-root': SERVE_DATA_ROOT_HELP },
  'serve devices revoke': { 'data-root': SERVE_DATA_ROOT_HELP },
  'serve devices rotate': { 'data-root': SERVE_DATA_ROOT_HELP },
  'skills get': {
    full: '--full                 Print the full guide with bundled references',
    reference: '--reference <name>     Print one bundled reference by name',
    references: '--references           List the bundled reference names for a topic'
  },
  'skills install': {
    agent: '--agent <names>        Comma-separated install targets; default is detected agents'
  },
  search: {
    query: '--query <text>         Search text; also accepted as the positional argument',
    scope: '--scope <corpus>       conversation (user and assistant turns) or all (default)',
    fresh: '--fresh                Wait up to 5s for the host to reconcile its index first',
    limit: '--limit <n>            Hits per page (default 20, maximum 100)',
    cursor: '--cursor <cursor>      Opaque cursor printed by the previous page of this search',
    agent: '--agent <id>           Restrict to one agent; repeat for several',
    path: '--path <path>          Restrict to an execution-host path; repeat for several',
    since: '--since <iso>          Only sessions updated at or after this ISO 8601 timestamp',
    sort: '--sort <order>         relevance (default) or newest',
    debug: '--debug                Include the planner route the host used',
    'index-status': '--index-status         Report the index instead of searching'
  }
}

export function formatCommandScopedFlagHelp(command: string, flag: string): string | undefined {
  return COMMAND_SCOPED_FLAG_HELP[command]?.[flag]
}
