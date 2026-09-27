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

| Feature                                        | serve                                          | orcad                                                                                                                                                                                                             | Status                     |
| ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Headless placeholder window graph              | `syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID)`  | Was never published: `graphStatus` stayed `unavailable`, `session.tabs.createTerminal` refused `runtime_unavailable`, `session.tabs.listAll` never answered (#17846, reproduced). Now published before RPC binds. | fixed                      |
| Agent hook server                              | started                                        | started (`orcad-entry.ts`)                                                                                                                                                                                        | parity                     |
| Managed agent-hook install/refresh             | at startup, gated on `agentStatusHooksEnabled` | Was never run. Now the same reconcile after RPC is up; never removes hooks                                                                                                                                        | fixed                      |
| Codex real-home hook grant                     | desktop account flow before hook reconcile     | Was not run. Now the same `ensureRealHomeCodexHookState` runs in Codex launch prep, before a system-default Codex pane spawns                                                                                     | fixed (at launch)          |
| Scheduled automations                          | `AutomationService` + headless dispatcher      | Was never constructed: `automation.runNow` refused, schedules never fired. Now the same dispatcher (`automations/runtime-headless-dispatcher.ts`), armed after RPC is up                                          | fixed                      |
| Automation run usage figures                   | Claude/Codex usage stores                      | Were not recorded. Now the same Claude/Codex usage stores, with the usage-scan worker shipped in the artifact                                                                                                     | fixed                      |
| History tombstone drain, worktree-trash sweep  | at startup                                     | Was skipped. Now at startup                                                                                                                                                                                       | fixed                      |
| Push service (gateway session, registrations)  | `startDesktopPushService`                      | `DesktopPushService` (`orcad-entry.ts`)                                                                                                                                                                           | parity                     |
| Web client static root / `webClientUrl`        | `webClientRoot: getBundledWebClientRoot()`     | Was never served. Now the bundle ships as `web/` pinned by `web/orcad-web-client.json`, served by the same static handler; runtime offers carry `webClientUrl` plus one link per alternate endpoint               | fixed                      |
| Mobile-scoped pairing offer, QR                | `--mobile-pairing`, QR in ready block          | Was always `scope: runtime`, `qr: null`. Now `--mobile-pairing` adds a phone offer and QR beside the runtime one (`mobilePairing`); `orca serve pairing --mobile` reprints it                                     | fixed                      |
| Claude auth / Codex runtime-home prep for PTYs | account-backed prep                            | Was unset. Now the same Claude auth, Codex runtime-home and Codex resume prep, from the shared composition (`src/main/account-services/`)                                                                         | fixed                      |
| Account services (`accounts.*`, rate limits)   | configured                                     | Threw "Account services are not configured on this runtime". Now the same composition; credentials stored as the desktop does per platform ([data root](./orcad-operations.md#data-root-and-the-instance-lock))   | fixed                      |
| Plugins, Artifact/Skill cloud, speech          | configured                                     | each RPC throws its "unavailable" error                                                                                                                                                                           | gap (low)                  |
| `orca` CLI and bare-`orca` dispatcher install  | installs into `~/.local/bin`                   | Was absent. The artifact ships the CLI; orcad puts it on every PTY `PATH` and in `~/.local/bin`, never over another `orca` ([details](./orcad-operations.md#the-orca-cli-on-orcad-hosts))                         | fixed                      |
| Persisted proxy settings                       | applied to Electron sessions                   | environment proxy variables only                                                                                                                                                                                  | gap (low)                  |
| Browser automation                             | offscreen `WebContents` when a display exists  | Electron sidecar or `ORCA_BROWSER_EXECUTABLE` Chromium (`orcad-browser-provider.ts`), started after readiness; `--browser` selects or disables it                                                                 | parity (different backend) |
| Serve→desktop promotion                        | `openable`                                     | `blocked`                                                                                                                                                                                                         | n/a                        |
| Telemetry, stats, crash sampling               | observers                                      | none                                                                                                                                                                                                              | n/a                        |

## Features a desktop renderer performs

On the desktop these run in the renderer. A headless host has none, on either entry point, so
each needs a host-side (or client-side) replacement.

| Feature                                                          | Headless behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| "Agent finished" / "needs input" notifications, phone push       | Was never produced (#20706). Now derived from hook status by `notifications/headless-agent-notifications.ts` on serve and orcad, into the existing mobile fan-out; stands down while a renderer is attached.                                                                                                                                                                                                                                                                                                              | fixed          |
| Terminal-bell notifications                                      | Was not produced. Now a BEL main parses off a PTY is announced by the same headless producer (`notifications/headless-agent-notifications.ts`) on serve and orcad, with the desktop's terminal-bell text, settings, 250 ms grace (a same-burst agent completion wins) and cooldown. OSC 9 / OSC 777 program text is still parsed only by a renderer, so the headless banner is the generic "Bell in _workspace_".                                                                                                         | fixed (BEL)    |
| First-work branch/workspace auto-rename                          | Was window-listener only (#17069). Now a hook-status subscription (`agent-hooks/first-work-rename-subscription.ts`) on desktop, serve and orcad.                                                                                                                                                                                                                                                                                                                                                                          | fixed          |
| Opening a file or diff as a tab (`files.open`, `files.openDiff`) | A client advertising `session-tabs.host-editor-tabs.v1` (current mobile, the CLI) gets a host-owned tab (`host-editor-tabs.ts`) on `session.tabs`, and its `tabId`. Other clients still get `renderer_unavailable`; mobile keeps its device-screen fallback for it (#14315, #22186).                                                                                                                                                                                                                                      | fixed (opt-in) |
| Markdown tab read/save (`markdown.readTab`/`saveTab`)            | Served for host-owned markdown tabs with the desktop bridge's rules (hash versions, stale base = `conflict` unless disk already matches, read-back check). A local save re-checks and swaps in a temp file; SSH re-checks before writing (one round trip). Other ids keep `renderer_unavailable`.                                                                                                                                                                                                                         | fixed          |
| Editor / markdown / diff session tabs                            | Kept in `<data-root>/host-editor-tabs.json`, durable before an open or close is acknowledged; every paired client lists and closes them. A close tombstones the uuid in the closed-surface ledger first. Active only with no renderer attached; a renderer stays the owner.                                                                                                                                                                                                                                               | fixed          |
| Sleeping-agent capture and resume (#21743)                       | Was renderer-only: an idle agent pane came back as a bare shell, or not at all, after its PTY was lost. orcad now keeps `sleepingAgentSessionsByPaneKey` from the hook-status store (`agent-hooks/headless-sleeping-agent-capture.ts`, same record format as the renderer) and relaunches the agent with its provider's resume command in the same pane (`runtime/headless-sleeping-agent-resume.ts`) when the daemon died under a running orcad or before a restart. See below. Serve still leaves this to its renderer. | fixed (orcad)  |
| `worktree.sleep`                                                 | Was a silent no-op. On orcad it now captures durable `worktree-sleep` records and parks the workspace's PTYs with history kept and tabs preserved (`pending-handle`), the host-side equivalent of the desktop flow; a phone activating the worktree wakes its agents (`sleepingAgentWake: 'requested'`). Serve still no-ops without a renderer.                                                                                                                                                                           | fixed (orcad)  |
| Orphan terminal-history GC                                       | Was armed from the main window only. orcad now arms the same `scheduleHistoryGc` over the same live set (worktree meta, folder workspaces, other profiles) after RPC is up, beside the exited-retention sweep.                                                                                                                                                                                                                                                                                                            | fixed          |

## Sleeping-agent cold restore on orcad

- **Capture.** Every live hook row for a local, resumable agent pane refreshes that pane's `live`
  checkpoint in the host's own workspace-session partition, the field and format the renderer
  writes. SSH panes are skipped: their PTYs live on the relay, which a daemon death does not reach.
  The checkpoint ends when the agent leaves a still-live shell, or when the pane's PTY exits with
  evidence (a proven exit, a signal, an operator close).
- **Resume.** A PTY that exits with an unconfirmed stop (how a session lost with its daemon exits)
  and has a checkpoint is relaunched in the same tab and leaf once its surface retirement settles.
  After a restart, each checkpointed pane the host session still lists is graded from the owning
  provider's inventory: `live` is left alone (a plain orcad restart keeps the daemon), `unverifiable`
  is retried on a later start, and only `exited` is resumed.
- **Guards.** Every resume is a `terminal.ensureAgentSession` with the pane as its placement, so the
  per-provider resume command, the resume dedupe (a live holder is adopted, `unverifiable` refuses)
  and the closed-surface ledger all apply; a closed tab's checkpoint is dropped, never resumed.
- **Launch inputs.** The checkpoint carries the pane's launch arguments; the launch environment and a
  custom agent command follow the host's current settings, since `ensureAgentSession` takes neither.
- **Wake.** `worktree-sleep` captures are consumed only by a wake. A phone opening a single parked
  agent tab before any worktree activation gets a plain shell there, not the agent.

## Wire compatibility of the fixes

No stream frames changed. The web client and phone offer add only optional fields: `pairing.webClientAlternateUrls` and `mobilePairing` in the readiness line, the same
alternates field on `server.pairingOffer`'s reply, and an optional `scope` param on that host-only
method. An older orcad strips `scope` and answers with its runtime offer, which the CLI detects from
the reply's own `scope`; an older CLI sends none and gets the runtime offer as before. Runtime
offers encode the same pairing URL as before; only its `webClientUrl` changed from `null` to a
link. The notification producer publishes the same `MobileNotificationDispatchEvent` shape the desktop delivery path already publishes, so
old clients see ordinary notifications; `terminal-bell` is a source every client already
handles. The mobile fallbacks key on an error code every existing headless host already sends,
and a desktop host never sends it. `accounts.*` on orcad now answers with the payloads serve
already publishes instead of an error, so every client that reads them from serve reads them from
orcad unchanged. What orcad now publishes differently uses existing values only: a slept
workspace's tabs read `pending-handle`, as a hibernated pane's already do; a phone wake answers
`sleepingAgentWake: 'requested'` instead of `unsupported-headless`; a resumed agent arrives as an
ordinary terminal at the pane's existing ids.

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

1. Interactive Claude/Codex logins on a headless host (accounts are added from a login already
   made on the host), and MiniMax / OpenCode Go cookie sign-in, which needs a Chromium cookie
   jar; their API-key paths work.
2. Sleeping-agent capture, cold restore and `worktree.sleep` on serve, which today defers them to a
   renderer it may never get.
3. Host-side OSC 9 / OSC 777 parsing, so headless bell notifications carry the program's text.
