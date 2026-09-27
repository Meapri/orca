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

| Feature                                                          | Headless behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| "Agent finished" / "needs input" notifications, phone push       | Was never produced (#20706). Now derived from hook status by `notifications/headless-agent-notifications.ts` on serve and orcad, into the existing mobile fan-out; stands down while a renderer is attached.                                                                                                                                                                                                                                                                                                              | fixed          |
| Terminal-bell notifications                                      | Was not produced. Now a BEL main parses off a PTY is announced by the same headless producer (`notifications/headless-agent-notifications.ts`) on serve and orcad, with the desktop's terminal-bell text, settings, 250 ms grace (a same-burst agent completion wins) and cooldown. OSC 9 / OSC 777 program text is still parsed only by a renderer, so the headless banner is the generic "Bell in _workspace_".                                                                                                         | fixed (BEL)    |
| First-work branch/workspace auto-rename                          | Was window-listener only (#17069). Now a hook-status subscription (`agent-hooks/first-work-rename-subscription.ts`) on desktop, serve and orcad.                                                                                                                                                                                                                                                                                                                                                                          | fixed          |
| Opening a file or diff as a tab (`files.open`, `files.openDiff`) | Host refuses `renderer_unavailable` (`orca-runtime-file-commands.ts`). Mobile now falls back to its device-side screens on that refusal: review screen for a changed file, file preview for a tapped path (#14315, #22186).                                                                                                                                                                                                                                                                                               | fixed (client) |
| Markdown tab read/save (`markdown.readTab`/`saveTab`)            | Host refuses `renderer_unavailable`; mobile already falls back to a read-only disk render. Editing markdown from a phone still needs a desktop.                                                                                                                                                                                                                                                                                                                                                                           | gap (medium)   |
| Editor / markdown / diff session tabs                            | Headless hosts have no editor-tab model, so these tabs never exist there and closing one refuses `runtime_unavailable` (`orca-runtime-close-mobile-session-tab.ts`).                                                                                                                                                                                                                                                                                                                                                      | gap (medium)   |
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

No RPC params, stream frames or capabilities changed. The notification producer publishes the
same `MobileNotificationDispatchEvent` shape the desktop delivery path already publishes, so
old clients see ordinary notifications; `terminal-bell` is a source every client already
handles. The mobile fallbacks key on an error code every existing headless host already sends,
and a desktop host never sends it. What orcad now publishes differently uses existing values
only: a slept workspace's tabs read `pending-handle`, as a hibernated pane's already do; a phone
wake answers `sleepingAgentWake: 'requested'` instead of `unsupported-headless`; a resumed agent
arrives as an ordinary terminal at the pane's existing ids.

## Follow-ups

1. Serve the bundled web client from orcad and reconcile `webClientUrl` with the loopback bind.
2. A host-side editor-tab model for markdown/file/diff tabs, including markdown save.
3. Account-backed agent prep (Claude auth, Codex runtime home) behind a Node host port.
4. Mobile-scoped pairing offers and a QR in orcad's ready block.
5. Sleeping-agent capture, cold restore and `worktree.sleep` on serve, which today defers them to a
   renderer it may never get.
6. Host-side OSC 9 / OSC 777 parsing, so headless bell notifications carry the program's text.
