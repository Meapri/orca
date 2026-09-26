import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SERVE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['serve'],
    summary: 'Start an Orca runtime server without opening a desktop window',
    usage:
      'orca serve [--port <port>] [--pairing-address <host>] [--mobile-pairing] [--no-pairing] [--project-root <path>] [--recipe-json] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'port',
      'pairing-address',
      'mobile-pairing',
      'no-pairing',
      'project-root',
      'recipe-json'
    ],
    notes: [
      'Runs in the foreground and prints the bound endpoint, advertised endpoint, and pairing status. Stop it with Ctrl+C.',
      '--pairing-address changes only the client-advertised address; use a reachable LAN, Tailscale, SSH-forward, or reverse-proxy endpoint.',
      'Use --recipe-json with --project-root from VM recipes to print the recipe result JSON and leave the server running.',
      'Use --mobile-pairing to print a mobile-scoped pairing QR/link instead of the default runtime-environment pairing link.',
      'When the web client bundle is available, the server also prints a browser URL with the pairing data embedded.'
    ],
    examples: [
      'orca serve',
      'orca serve --json',
      'orca serve --project-root /workspace/repo --pairing-address wss://sandbox.example.com --recipe-json',
      'orca serve --port 6768 --pairing-address 100.64.1.20',
      'orca serve --pairing-address 100.64.1.20 --mobile-pairing'
    ]
  },
  {
    path: ['serve', 'status'],
    summary: 'Show a running orcad server: health verdict, degradations, and live stats',
    usage: 'orca serve status [--fresh] [--data-root <path>] [--environment <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'fresh', 'data-root'],
    notes: [
      'Reports readiness, liveness, build, terminal-daemon verdict, degradations, uptime, memory, CPU, event-loop lag, connected clients and live terminals.',
      'Locally it reads the orcad data root ($ORCA_USER_DATA, else $XDG_DATA_HOME/Orca, else ~/.orca); --environment asks a paired server instead.',
      '--fresh re-runs the terminal-daemon self-test instead of reading the last minute-old verdict.',
      'Exits 1 when the server is not ready, not live, or does not answer.'
    ],
    examples: [
      'orca serve status',
      'orca serve status --json',
      'orca serve status --environment vps'
    ]
  },
  {
    path: ['serve', 'doctor'],
    summary: 'Preflight an orcad host and print a fix for each problem found',
    usage: 'orca serve doctor [--data-root <path>] [--bind <ip>] [--port <port>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'data-root', 'bind', 'port'],
    notes: [
      'Checks data-root ownership and mode, the instance lock, the listener bind, the systemd user bus and linger that keep terminals alive across service restarts, daemon cgroup isolation, the glibc floor, the Node ABI, and free disk space.',
      'Runs on the server host; checks that need the running server are skipped when it is down.',
      'Exits 1 when any check fails.'
    ],
    examples: ['orca serve doctor', 'orca serve doctor --port 6768 --json']
  },
  {
    path: ['serve', 'pairing'],
    summary: 'Reprint the pairing link and QR code of a running orcad server',
    usage: 'orca serve pairing [--rotate] [--data-root <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'rotate', 'data-root'],
    notes: [
      'Prints the same unused pairing offer the server printed at startup, without restarting it; after a device pairs, it prints a fresh one.',
      '--rotate invalidates the unused offer (for example, one that leaked) and mints a new one.',
      'Runs on the server host only; paired clients cannot mint pairing offers.'
    ],
    examples: ['orca serve pairing', 'orca serve pairing --rotate']
  }
]
