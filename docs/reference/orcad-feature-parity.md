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
| Orca Relay for phones                          | not started (desktop app window only)          | Opt-in `--relay`: the desktop's `DesktopRelayService` behind `orcad-relay.ts`; sign-in with `orca serve relay sign-in`, relay offers with `orca serve pairing new --mobile --relay`                               | fixed (orcad only)           |
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
| Opening a file or diff as a tab (`files.open`, `files.openDiff`) | Host refuses `renderer_unavailable` (`orca-runtime-file-commands.ts`). Mobile now falls back to its device-side screens on that refusal: review screen for a changed file, file preview for a tapped path (#14315, #22186).                                                                                         | fixed (client) |
| Markdown tab read/save (`markdown.readTab`/`saveTab`)            | Host refuses `renderer_unavailable`; mobile already falls back to a read-only disk render. Editing markdown from a phone still needs a desktop.                                                                                                                                                                     | gap (medium)   |
| Editor / markdown / diff session tabs                            | Headless hosts have no editor-tab model, so these tabs never exist there and closing one refuses `runtime_unavailable` (`orca-runtime-close-mobile-session-tab.ts`).                                                                                                                                                | gap (medium)   |
| Sleeping-agent capture and resume (#21743)                       | `sleepingAgentSessionsByPaneKey` is written only by the renderer and read only by a renderer cold restore, so an idle agent pane comes back as a bare shell after a restart that loses its PTY. On orcad the daemon keeps PTYs alive across an orcad restart, so this bites only when the daemon or host goes down. | gap (medium)   |
| `worktree.sleep`                                                 | silent no-op that still returns the worktree id                                                                                                                                                                                                                                                                     | gap (low)      |
| Orphan terminal-history GC                                       | armed from the main window only                                                                                                                                                                                                                                                                                     | gap (low)      |

## Clients

| Feature                                       | Behavior                                                                                                                                                                | Status |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `alternateEndpoints` failover outside desktop | The web client and the phone store every offered address and fail over on an unanswered connect, keeping the last good one (`src/shared/pairing-endpoint-failover.ts`). | fixed  |
| Resume probe in the web client                | `online`, back/forward-cache restore and Page Lifecycle `resume` probe a live socket with the desktop's 8 s deadline or skip the remaining reconnect backoff.           | fixed  |

## Wire compatibility of the fixes

Relay pairing adds an optional `relay` key to the host-only `pairing.create` params (an older host
refuses it, which is the intended outcome for `--relay`) and orcad-only `server.relay.*` admin
methods whose presence is the capability; the phone-facing relay wire is the desktop's, unchanged.
Client failover only reads the existing optional `alternateEndpoints`. Otherwise no RPC params,
stream frames or capabilities changed. The notification producer publishes the
same `MobileNotificationDispatchEvent` shape the desktop delivery path already publishes, so
old clients see ordinary notifications. The mobile fallbacks key on an error code every
existing headless host already sends, and a desktop host never sends it.

## Follow-ups

1. Serve the bundled web client from orcad and reconcile `webClientUrl` with the loopback bind.
2. A host-side editor-tab model for markdown/file/diff tabs, including markdown save.
3. Sleeping-agent capture from hook status plus a headless cold-restore consumer (#21743).
4. Account-backed agent prep (Claude auth, Codex runtime home) behind a Node host port.
5. Mobile-scoped pairing offers and a QR in orcad's ready block.
