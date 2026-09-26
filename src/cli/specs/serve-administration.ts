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
      'orca serve pairing new [--mobile | --runtime] [--pairing-address <host>] [--expires <duration>] [--name <label>] [--data-root <path>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'mobile',
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
      '--mobile needs --pairing-address set to the LAN, Tailscale, or reverse-proxy address the phone dials; it pairs on the direct path without Orca Relay.'
    ],
    examples: [
      'orca serve pairing new',
      'orca serve pairing new --pairing-address 100.64.1.20 --expires 1h',
      'orca serve pairing new --mobile --pairing-address wss://orca.example.com'
    ]
  }
]
