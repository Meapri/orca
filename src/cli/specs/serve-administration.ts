import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const HOST_ONLY_NOTE =
  'Administers the Orca runtime running on this machine (desktop app, `orca serve`, or orcad) over its owner-only local socket. Paired clients cannot call it, and --environment / --pairing-code are rejected.'
const TARGET_NOTE =
  'The target is --data-root, else $ORCA_USER_DATA, else $ORCA_USER_DATA_PATH, otherwise the first data root with a running runtime: orcad (`$XDG_DATA_HOME/Orca` or `~/.orca`), then the desktop profile.'

export const SERVE_ADMINISTRATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['serve', 'pairing'],
    aliases: [['serve', 'pairing', 'show']],
    summary: 'Reprint the startup pairing link and QR code of a running orcad server',
    usage: 'orca serve pairing [show] [--rotate] [--data-root <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'rotate', 'data-root'],
    notes: [
      'Prints the same unused, unexpired pairing offer the server printed at startup, without restarting it; once a device uses it or it expires, it prints a fresh one with the same lifetime (--pairing-expires, default 15m).',
      '--rotate revokes that unused offer (for example, one that leaked) and mints a new one. A device that already paired is never touched.',
      'To mint an additional offer (a second client, a phone, a custom lifetime or name) use `orca serve pairing new`.',
      'orcad only, and on the server host only; paired clients cannot mint pairing offers.'
    ],
    examples: [
      'orca serve pairing',
      'orca serve pairing show --json',
      'orca serve pairing --rotate'
    ]
  },
  {
    path: ['serve', 'devices', 'list'],
    summary: 'List paired devices and pending pairing offers on this Orca runtime',
    usage: 'orca serve devices list [--data-root <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'data-root'],
    notes: [
      HOST_ONLY_NOTE,
      TARGET_NOTE,
      'Never prints credentials: rows show id, scope, state, last use, offer expiry and open connections.'
    ],
    examples: ['orca serve devices list', 'orca serve devices list --json']
  },
  {
    path: ['serve', 'devices', 'revoke'],
    destructive: true,
    summary: 'Revoke one paired device or pending offer and close its live connections',
    usage: 'orca serve devices revoke <device-id> [--data-root <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'device', 'data-root'],
    positionalArgs: ['device'],
    notes: [
      HOST_ONLY_NOTE,
      'Takes effect immediately: sockets that credential already authenticated are closed and it cannot reconnect, including after a restart. Other devices, accounts and sessions are untouched.'
    ],
    examples: ['orca serve devices revoke 6f1c2a4e-0000-4000-8000-000000000000']
  },
  {
    path: ['serve', 'devices', 'rotate'],
    destructive: true,
    summary: 'Replace a runtime grant credential and print its new pairing URL',
    usage:
      'orca serve devices rotate <device-id> [--pairing-address <host>] [--data-root <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'device', 'pairing-address', 'data-root'],
    positionalArgs: ['device'],
    notes: [
      HOST_ONLY_NOTE,
      'The device keeps its id and history; its old credential stops working at once and open connections close. Re-add the environment on the client with the printed URL.',
      'Mobile pairings cannot be rotated in place; revoke them and pair again.'
    ],
    examples: ['orca serve devices rotate 6f1c2a4e-0000-4000-8000-000000000000']
  },
  {
    path: ['serve', 'pairing', 'new'],
    summary: 'Mint a new pairing offer against the running Orca runtime',
    usage:
      'orca serve pairing new [--mobile [--relay] | --runtime] [--pairing-address <host>] [--expires <duration>] [--name <label>] [--data-root <path>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'mobile',
      'relay',
      'runtime',
      'pairing-address',
      'expires',
      'name',
      'data-root'
    ],
    notes: [
      HOST_ONLY_NOTE,
      TARGET_NOTE,
      'Defaults to a runtime (environment) offer; --mobile mints a phone offer. Both kinds can be minted at any time, so one server can pair phones and peer hosts without a restart.',
      'The offer expires unclaimed after --expires (default 15m, 1m to 7d) and becomes that device once a client first connects with it. Unclaimed offers are listed as pending and can be revoked.',
      '--mobile needs --pairing-address set to the LAN, Tailscale, or reverse-proxy address the phone dials; it pairs on the direct path without Orca Relay.',
      '--mobile --relay also carries an Orca Relay invite, so the phone reaches a host with no open port; it needs orcad started with --relay and signed in (`orca serve relay sign-in`). --pairing-address is then optional: the phone tries it first and falls back to the relay.'
    ],
    examples: [
      'orca serve pairing new',
      'orca serve pairing new --pairing-address 100.64.1.20 --expires 1h',
      'orca serve pairing new --mobile --pairing-address wss://orca.example.com',
      'orca serve pairing new --mobile --relay'
    ]
  },
  {
    path: ['serve', 'relay', 'status'],
    summary: 'Show whether this orcad serves phones through Orca Relay',
    usage: 'orca serve relay status [--data-root <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'data-root'],
    notes: [
      HOST_ONLY_NOTE,
      TARGET_NOTE,
      'Reports the --relay flag, the Orca account this host is signed in to, where that session is stored, and the relay connection. The host connects to the relay only while a phone is paired through it, so standby is the normal idle state.'
    ],
    examples: ['orca serve relay status', 'orca serve relay status --json']
  },
  {
    path: ['serve', 'relay', 'sign-in'],
    summary: 'Sign this orcad in to an Orca account so phones can reach it through Orca Relay',
    usage: 'orca serve relay sign-in [--data-root <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'data-root'],
    notes: [
      HOST_ONLY_NOTE,
      'Prints a sign-in URL to open in any browser. The browser returns to a loopback port on this host, so from another machine forward that port over SSH as printed. Waits up to 5 minutes; --json prints the URL and returns at once (poll `orca serve relay status`).',
      "Without an OS keyring the session is kept in an owner-only file in the data root, like this host's device tokens."
    ],
    examples: ['orca serve relay sign-in']
  },
  {
    path: ['serve', 'relay', 'sign-out'],
    destructive: true,
    summary: 'Sign this orcad out of Orca Relay and tell relay-paired phones',
    usage: 'orca serve relay sign-out [--data-root <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'data-root'],
    notes: [
      HOST_ONLY_NOTE,
      'Closes the relay connection and unlinks the account. Phones paired through the relay are told the host signed out; direct pairings keep working.'
    ],
    examples: ['orca serve relay sign-out']
  }
]
