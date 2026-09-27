# orcad feature parity with `orca serve`

What a Linux VPS gives up by running `orcad` (plain Node/Bun) instead of the Electron-hosted
`orca serve` (Electron main process, no window, usually under Xvfb). Both serve the same
`OrcaRuntimeService`, so most RPC behaves identically; the differences come from startup steps
and host ports that only the Electron entry installs, and from features that only a desktop
renderer performs. Operations (supervision, health, bind, data root) are in
[orcad-operations.md](./orcad-operations.md).

Entry points compared: `launchServeMode` / `initializeReadyRuntimeServices`
(`src/main/startup/main-process-runtime-launch.ts`, `main-process-ready-runtime.ts`) versus
`startOrcadRuntime` (`src/main/orcad/orcad-entry.ts`) plus `installOrcadHeadlessParity`
(`src/main/orcad/orcad-headless-parity.ts`), the one place orcad performs serve's
window-less-host steps.

Status: **parity** — same behavior; **fixed** — was missing on orcad and is now in place;
**gap** — still missing or degraded; **n/a** — intentionally absent.

## Startup steps

| Feature                                        | serve                                          | orcad                                                                                                                                                                                                             | Status                       |
| ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Headless placeholder window graph              | `syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID)`  | Was never published: `graphStatus` stayed `unavailable`, `session.tabs.createTerminal` refused `runtime_unavailable`, `session.tabs.listAll` never answered (#17846, reproduced). Now published before RPC binds. | fixed                        |
| Agent hook server                              | started                                        | started (`orcad-entry.ts`)                                                                                                                                                                                        | parity                       |
| Managed agent-hook install/refresh             | at startup, gated on `agentStatusHooksEnabled` | Was never run. Now the same reconcile after RPC is up; never removes hooks                                                                                                                                        | fixed                        |
| Codex real-home hook grant                     | desktop account flow before hook reconcile     | not run                                                                                                                                                                                                           | n/a                          |
| Scheduled automations                          | `AutomationService` + headless dispatcher      | Was never constructed: `automation.runNow` refused, schedules never fired. Now the same dispatcher (`automations/runtime-headless-dispatcher.ts`), armed after RPC is up                                          | fixed                        |
| Automation run usage figures                   | Claude/Codex usage stores                      | no usage stores; runs record no usage                                                                                                                                                                             | gap (low)                    |
| History tombstone drain, worktree-trash sweep  | at startup                                     | Was skipped. Now at startup                                                                                                                                                                                       | fixed                        |
| Push service (gateway session, registrations)  | `startDesktopPushService`                      | `DesktopPushService` (`orcad-entry.ts`)                                                                                                                                                                           | parity                       |
| Web client static root / `webClientUrl`        | `webClientRoot: getBundledWebClientRoot()`     | not passed; no browser UI is served and pairing offers carry `webClientUrl: null`                                                                                                                                 | gap (high for browser users) |
| Mobile-scoped pairing offer, QR                | `--mobile-pairing`, QR in ready block          | always `scope: runtime`, `qr: null`                                                                                                                                                                               | gap (medium)                 |
| Claude auth / Codex runtime-home prep for PTYs | account-backed prep                            | none; an agent needing it fails with its own message                                                                                                                                                              | gap (medium)                 |
| Account services (`accounts.*`, rate limits)   | configured                                     | `accounts.*` throws "Account services are not configured on this runtime"                                                                                                                                         | gap (medium)                 |
| Plugins, Artifact/Skill cloud, speech          | configured                                     | each RPC throws its "unavailable" error                                                                                                                                                                           | gap (low)                    |
| `orca` CLI and bare-`orca` dispatcher install  | installs into `~/.local/bin`                   | none; agents that shell out to `orca` need the CLI on `PATH`                                                                                                                                                      | gap (medium)                 |
| Persisted proxy settings                       | applied to Electron sessions                   | environment proxy variables only                                                                                                                                                                                  | gap (low)                    |
| Browser automation                             | offscreen `WebContents` when a display exists  | Electron sidecar or `ORCA_BROWSER_EXECUTABLE` Chromium (`orcad-browser-provider.ts`)                                                                                                                              | parity (different backend)   |
| Serve→desktop promotion                        | `openable`                                     | `blocked`                                                                                                                                                                                                         | n/a                          |
| Telemetry, stats, crash sampling               | observers                                      | none                                                                                                                                                                                                              | n/a                          |

## Features a desktop renderer performs

On the desktop these run in the renderer. A headless host has none, on either entry point, so
each needs a host-side (or client-side) replacement.

| Feature                                                          | Headless behavior                                                                                                                                                                                                                                                                                                   | Status         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| "Agent finished" / "needs input" notifications, phone push       | Was never produced (#20706). Now derived from hook status by `notifications/headless-agent-notifications.ts` on serve and orcad, into the existing mobile fan-out; stands down while a renderer is attached.                                                                                                        | fixed          |
| Terminal-bell notifications                                      | not produced                                                                                                                                                                                                                                                                                                        | gap (low)      |
| First-work branch/workspace auto-rename                          | Was window-listener only (#17069). Now a hook-status subscription (`agent-hooks/first-work-rename-subscription.ts`) on desktop, serve and orcad.                                                                                                                                                                    | fixed          |
| Opening a file or diff as a tab (`files.open`, `files.openDiff`) | A client advertising `session-tabs.host-editor-tabs.v1` (current mobile, the CLI) gets a host-owned tab (`host-editor-tabs.ts`) on `session.tabs`, and its `tabId`. Other clients still get `renderer_unavailable`; mobile keeps its device-screen fallback for it (#14315, #22186).                                | fixed (opt-in) |
| Markdown tab read/save (`markdown.readTab`/`saveTab`)            | Served for host-owned markdown tabs with the desktop bridge's rules (hash versions, stale base = `conflict` unless disk already matches, read-back check). A local save re-checks and swaps in a temp file; SSH re-checks before writing (one round trip). Other ids keep `renderer_unavailable`.                   | fixed          |
| Editor / markdown / diff session tabs                            | Kept in `<data-root>/host-editor-tabs.json`, durable before an open or close is acknowledged; every paired client lists and closes them. A close tombstones the uuid in the closed-surface ledger first. Active only with no renderer attached; a renderer stays the owner.                                         | fixed          |
| Sleeping-agent capture and resume (#21743)                       | `sleepingAgentSessionsByPaneKey` is written only by the renderer and read only by a renderer cold restore, so an idle agent pane comes back as a bare shell after a restart that loses its PTY. On orcad the daemon keeps PTYs alive across an orcad restart, so this bites only when the daemon or host goes down. | gap (medium)   |
| `worktree.sleep`                                                 | silent no-op that still returns the worktree id                                                                                                                                                                                                                                                                     | gap (low)      |
| Orphan terminal-history GC                                       | armed from the main window only                                                                                                                                                                                                                                                                                     | gap (low)      |

## Wire compatibility of the fixes

The notification producer publishes the same `MobileNotificationDispatchEvent` shape the desktop
delivery path already publishes, so old clients see ordinary notifications. The mobile fallbacks
key on an error code every existing headless host already sends, and a desktop host never sends it.

Host-owned editor tabs are the one negotiated change:

- **New client capability `session-tabs.host-editor-tabs.v1`.** `files.open`/`files.openDiff`
  answer with a host tab only for a client that advertises it (or the in-process CLI). A released
  phone does not, so it still receives `renderer_unavailable` and opens its device screens. A new
  phone against an old host gets the same refusal and the same fallback.
- **`tabId` on the open reply** is an optional field (Rule 1), omitted whenever a renderer opened
  the tab, so desktop replies are byte-for-byte unchanged.
- **New content on `session.tabs` (Rule 3).** A headless host now publishes `markdown`/`file`
  rows, which it never did. Every released client already decodes those rows, because a desktop
  host publishes the same shapes, and each operation on them — `markdown.readTab`/`saveTab`,
  `session.tabs.close`, reading the file from disk — is an existing contract. An old client that
  sees a row another client opened can therefore read, edit and close it. The cross-version
  harness does not cover the session-tab channel; this is the recorded reasoning.

## Follow-ups

1. Serve the bundled web client from orcad and reconcile `webClientUrl` with the loopback bind.
2. Sleeping-agent capture from hook status plus a headless cold-restore consumer (#21743).
3. Account-backed agent prep (Claude auth, Codex runtime home) behind a Node host port.
4. Mobile-scoped pairing offers and a QR in orcad's ready block.
