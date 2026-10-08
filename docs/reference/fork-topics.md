# Fork Topics

What this fork (`Meapri/orca`) carries on top of `stablyai/orca`, grouped into the topic stacks
that [`fork-upstream-sync.md`](./fork-upstream-sync.md) re-stacks every day. Read this before a
sync that needs a human: it says what each topic is for, which files it owns, and which commits
answer an open upstream PR.

The fork carries its upstream PRs indefinitely. Upstream has not reviewed them, so nothing here
assumes they will merge. If one does merge, the sync drops the matching commit on its own (by its
`Upstream-PR:` trailer, a `-x` cherry-pick source, or patch id) and says so in its report; update
the tables below when that happens.

The stacks were rebuilt on 2026-10-08 from the 223 fork commits (190 non-merge) that were on
`main` at `14b8692f79`, on top of upstream `7c50009ca4`.

| Order | Topic                | Branch                     | Commits (before → after) | Upstream PRs                                                   |
| ----- | -------------------- | -------------------------- | ------------------------ | -------------------------------------------------------------- |
| 1     | `terminal`           | `stack/terminal`           | 70 → 13                  | #23330 #23331 #23334 #23337 #23338 #23340 #23342               |
| 2     | `sync-automation`    | `stack/sync-automation`    | 1 → 12                   |                                                                |
| 3     | `runtime-remote`     | `stack/runtime-remote`     | 15 → 6                   | #23356 #23357 #23358 #23359 (+ upstream #26200, cherry-picked) |
| 4     | `accounts`           | `stack/accounts`           | 5 → 3                    |                                                                |
| 5     | `orcad-runtime`      | `stack/orcad-runtime`      | 91 → 15                  |                                                                |
| 6     | `distribution`       | `stack/distribution`       | 8 → 6                    |                                                                |
| 7     | `integration-fixups` | `stack/integration-fixups` | — → 2                    |                                                                |

Commit hashes below are the stack commits at the time of writing; the daily sync re-creates them
under `stack-sync/<date>/<topic>`, so look a commit up by subject when the hash has moved.

## terminal

**Purpose.** Everything the fork changes about how the terminal looks, scrolls, takes input and
copies text. This is the topic the fork exists for: no sync may drop any of it, and when upstream
reworks terminal code the fork's behaviour is ported onto the new structure.

**Owns.** `config/patches/xterm-src/*.src.patch` and the generated `config/patches/@xterm__*.patch`
bundles (regenerated with `config/scripts/regenerate-xterm-patches.mjs`, see
[`xterm-patch-regeneration.md`](./xterm-patch-regeneration.md)); `src/renderer/src/components/terminal-pane/**`,
`src/renderer/src/lib/pane-manager/**` (IME, wide glyphs, scrolling, input editing, copy, marks),
the terminal settings sections, `src/shared/terminal-*` settings types, the OSC branch of
`src/main/ipc/notification-options.ts`, agent PTY transcripts under `src/main/runtime/__fixtures__/`,
`config/scripts/capture-agent-pty-transcript.mjs`, `tests/e2e/terminal-*.spec.ts`, and the docs
[`xterm-patch-regeneration.md`](./xterm-patch-regeneration.md),
[`ime-regression-checklist.md`](./ime-regression-checklist.md),
[`agent-pty-transcript-capture.md`](./agent-pty-transcript-capture.md).

**Why the fork keeps it.** Korean/CJK input and rendering are the fork's main reason to exist, and
upstream has not taken the PRs. The xterm patches need source changes xterm.js does not offer
as extension points (composition hooks, renderer cell grid, viewport scrolling).

| Commit       | Subject                                                                             | Upstream PR            | Fork commits folded in                                                                                                                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `3c204ebf56` | build(xterm): carry the fork's xterm.js source patches and regenerated bundles      | #23330, #23338, #23342 | ab665759ab, c8a2db0240, fe7d8aa0cb, 36c6567c24, f52bcc64de, 1e1795f1b8, 6ccfa0760e, 46a45e436f, 559f443082, 75d0611ebb, 0cd2c309f8, e61422037a, dc3adfcd08, 2f598af73e, 50a8cacc1c                                                             |
| `a0f96bc11c` | fix(terminal): never send NaN mouse report coordinates to the PTY                   | #23330                 | ab665759ab, 0a2c571a97, bf6320ffce, 2d5f48c060                                                                                                                                                                                                 |
| `fe43a7f951` | fix(terminal): keep Cmd+C on a scrollback selection from jumping to bottom          | #23331                 | 3c231b57e5, 62cecacfed, a82d3ad72a                                                                                                                                                                                                             |
| `5e2fb56a4e` | fix(terminal): keep a pinned reading position anchored through trim and reflow      | #23334                 | 3fe6a6b6be, 2a361289b9, 2d5f48c060                                                                                                                                                                                                             |
| `effdf72eb8` | feat(terminal): add per-OS, locale-ordered CJK fallback fonts                       | #23337                 | a7fe505ec0, 01c2c7a525                                                                                                                                                                                                                         |
| `8f5d345417` | feat(settings): terminal experience settings model and shortcuts                    |                        | 61d5655083, c89b87488b, ca9615b9fc, 460e21a7a5, fc45263b93, fa5680079e, 6eb1307344, 848711eee6, 34dd15f232, 559f443082, d66a24a10e, e85d388981                                                                                                 |
| `779286924a` | feat(terminal): in-grid IME preedit and app-drawn caret anchoring                   | #23338, #23340         | c8a2db0240, ca9615b9fc, bb4e696d75, f52bcc64de, 2d5f48c060, 71c4247dc7, 1e1795f1b8, b11957dcb3, 34dd15f232, 0cd2c309f8, e2cfdde402, 54d1239150, c87a6c4ff4, f54e25f6da, 2f598af73e, 0645c6cbbf, 50a8cacc1c, ff0ef21376                         |
| `61b279a437` | feat(terminal): wide-glyph fit, emoji width, adopted caret and GPU cursor animation | #23342                 | 835bcbb288, 61d5655083, b8a4543976, ca9615b9fc, 36c6567c24, 460e21a7a5, b1a4904d03, 2d5f48c060, 34dd15f232, f8b826b6e8, 559f443082, 01c2c7a525, 0cd2c309f8, e61422037a, 6ef650bfe4, 8ea554aef7, b8844d9cc7, e85d388981                         |
| `5e0dfc5dce` | feat(terminal): smooth and pixel scrolling with a jump-to-latest pill               |                        | fc45263b93, 0581586b2a, d66a24a10e, e11ad555a5, f7d5e13f02, eea38e8876                                                                                                                                                                         |
| `b95391e409` | feat(terminal): GUI-style input-line editing and a multi-line composer              |                        | b0536b742c, c89b87488b, fa5680079e, 6eb1307344, 2d5f48c060, 848711eee6, bea35f8533, f54e25f6da, e85d388981, 170bbc80e7, ff0ef21376, c86fb14286, 14b8692f79                                                                                     |
| `40b11e922f` | feat(terminal): smart copy, Copy Raw, copy toast and links inside TUI boxes         |                        | 30212c6ff7, 14fd6238aa, d713156306, 5b9904a0ac, a9e81a3059, aef627df9d, 36058d0d93, 2d5f48c060                                                                                                                                                 |
| `6f1844fcde` | feat(terminal): command marks, prompt jumps and OSC 9/777 notifications             |                        | 14fd6238aa, 6eb1307344, c00f9c9bd0, 56ee79eb4f, 2d5f48c060                                                                                                                                                                                     |
| `c1fd31067b` | feat(terminal): wire the terminal features into panes, settings and locales         |                        | b0536b742c, 3c231b57e5, 14fd6238aa, a7fe505ec0, 61d5655083, c89b87488b, ca9615b9fc, 5b9904a0ac, 460e21a7a5, fc45263b93, 0581586b2a, fa5680079e, 6eb1307344, b11957dcb3, 34dd15f232, 559f443082, a82d3ad72a, 0cd2c309f8, d66a24a10e, e85d388981 |

The xterm commit carries the patch halves of #23330, #23338 and #23342; their Orca-side halves are
in the commits named for them. #23338, #23340 and #23342 were later extended by other fork work,
so if upstream merges one of them the sync drops only the matching part and the rest of the
feature commit stays: expect a conflict to resolve by hand the first time.

## sync-automation

**Purpose.** The daily re-stack (run on the fork owner's server by
`fork-stack-server-sync.mjs`; the Actions workflow is a manual fallback), its scripts and
manifest, and the guards that keep upstream-only workflows from running on the fork.

**Owns.** `.github/workflows/fork-upstream-sync.yml`, the `github.repository == 'stablyai/orca'`
guards in upstream-only workflows (`homebrew-bump`, `pullfrog`, `issue-os-labeler`,
`windows-signing-rehearsal`, `mobile-ios-release`, `agent-state-rules-publish`),
`config/fork-stacks.json`, `config/scripts/fork-stack-*.mjs` and their tests,
`docs/reference/fork-upstream-sync.md`, this file, and the `!docs/reference/` exception in
`.gitignore`.

**Why the fork keeps it.** Fork-only; upstream has no use for it.

| Commit        | Subject                                                                           | Upstream PR | Fork commits folded in |
| ------------- | --------------------------------------------------------------------------------- | ----------- | ---------------------- |
| `1a13dbb8f9`  | ci(fork): skip upstream-only workflows on the fork                                |             | 1bc0174c78             |
| `ee6a7929fe`  | feat(fork): re-stack fork topic stacks onto upstream main                         |             | 1bc0174c78             |
| `a0da21ae52`  | ci(fork): sync topic stacks daily and propose main updates by PR                  |             | 1bc0174c78             |
| `f4af5b44b2`  | docs(fork): document the topic patch stack sync                                   |             | 1bc0174c78             |
| `860db01f2c`  | fix(fork): read an Upstream-PR trailer split off by a Co-Authored-By paragraph    |             |                        |
| `8b7474b25c`  | docs(fork): record what each topic stack carries and which upstream PR it answers |             |                        |
| `970b35e01f`  | test(fork): let the checked-in manifest carry integration fixup topics            |             |                        |
| `d5392827c4`  | fix(fork): set the sync work directory in a step, not in job-level env            |             |                        |
| `8b2c199907`  | docs(fork): count the sync-automation commits in fork-topics                      |             |                        |
| `214e20c5d8`  | feat(fork): run the daily stack sync on the owner's server                        |             |                        |
| `adddfa803d`  | ci(fork): keep the Actions sync as a manual fallback only                         |             |                        |
| (this commit) | docs(fork): run the daily sync on the owner's server, Actions as fallback         |             |                        |

## runtime-remote

**Purpose.** Small fixes to upstream's existing remote-runtime code that the fork sent upstream
as PRs, plus the arm64 heartbeat fix.

**Owns.** Hunks in `src/main/runtime/rpc/**` (multiplex discard, bounded close,
`node-websocket-lifecycle.ts`), `src/main/runtime/orca-runtime-wait-for-session-tabs-inventory-publication.ts`,
`src/shared/remote-runtime-*` (liveness, resubscribe parking), `mobile/src/session/**` and
`mobile/src/source-control/**` (renderer-less host fallback), and `config/patches/ws@8.22.0.patch`.

**Why the fork keeps it.** Each fixes a reproducible failure (hangs, dropped connections after
sleep, clients dropped every heartbeat on arm64 Linux). The ws patch is a byte-identical
cherry-pick of upstream's unmerged #26200 (`ad6a1f12af`), so it disappears by itself when #26200
merges.

| Commit       | Subject                                                                                                                | Upstream PR                                | Fork commits folded in                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `66fd0b3431` | fix(remote-runtime): stop arm64 Linux servers dropping clients every heartbeat (empty WebSocket write EFAULT) (#26200) | upstream #26200 (cherry-pick `ad6a1f12af`) |                                                                                    |
| `767d87cb8b` | fix(runtime): refuse, never hang, a session tab inventory no graph publishes                                           | #23356                                     | 8844e56b48                                                                         |
| `564639ab14` | fix(mobile): render files and diffs on the device when the host has no renderer                                        | #23357                                     | 24317ec2b1, 1f04286e85, 3223088691, 44c79b3c4b                                     |
| `a690375399` | fix(runtime): close the connection when a multiplex frame is discarded (#20802)                                        | #23358                                     | 9b2df75b74, 3e1f8603ab                                                             |
| `c6e6b8d468` | fix(remote-runtime): recover a remote pane after sleep without a manual Reconnect (#9092)                              | #23359                                     | 519fd4411e, 4aa6517411, 17b318c2e0, d502bd193c, 597d10bc88, 9d9aadb37c, 468376346b |
| `806eb5f5da` | fix(runtime): probe remote-runtime sockets with a non-empty ping payload (#20673)                                      |                                            | 7d8c580e0c                                                                         |

## accounts

**Purpose.** Lets account and rate-limit services run without Electron, so an orcad host
(headless server) can serve Claude, Codex and rate-limit accounts and prepare agent launches
with the selected account.

**Owns.** The host-port swaps in `src/main/codex-accounts/**`, `src/main/rate-limits/**`,
`src/main/minimax/**`, `src/main/credentials/encrypted-api-key-file-store.ts`,
`src/main/zcode/zcode-plan-api-key-store.ts`; `src/main/account-services/**`;
`src/main/orcad/orcad-account-services.ts` and its wiring in `src/main/orcad/orcad-entry.ts`.

**Why the fork keeps it.** Upstream orcad still leaves Codex-home and Claude-auth preparation
unset. Upstream's own rewrite already removed Electron from `claude-accounts/`, so the fork only
swaps the files that still import it; drop the topic when upstream orcad serves these accounts.

| Commit       | Subject                                                                      | Upstream PR | Fork commits folded in             |
| ------------ | ---------------------------------------------------------------------------- | ----------- | ---------------------------------- |
| `37f8a4a026` | refactor(accounts): reach account and rate-limit services through host ports |             | 0faa97f5c6, bb18acefb2, a5c68fa095 |
| `a4f0d4a8ce` | refactor(accounts): compose account services without main-process state      |             | c75540f919                         |
| `db3d83af06` | feat(orcad): serve account services and account-backed agent prep            |             | af12ca2350                         |

## orcad-runtime

**Purpose.** Makes orcad (the headless server) a self-managed host on its own: Linux release
tarball, installer, systemd units and Dockerfile; continuous health, self-watchdog, `sd_notify`
and one degradation registry; `orca serve status|doctor|devices|pairing`; browser-provider
governance (tab caps, crash recovery, sidecar reaping, `--browser`); daemon resource limits,
log rotation and exited-history retention; host-owned editor/markdown/diff tabs, closed-surface
tombstones and sleeping-agent restore for renderer-less hosts; headless agent and bell
notifications; a cheaper internet transport (permessage-deflate, paced `session.tabs`,
compressed listings, stream resume, endpoint failover); the browser client, `orca` CLI and
Orca Relay on self-managed hosts; and the soak/chaos harness.

**Owns.** Fork-only modules under `src/main/orcad/` (host-install, health, doctor, browser
governance, relay, web client root, pairing offer, serve surfaces, parity hub), `src/main/daemon/`
resource-limit and log-rotation files, transport additions in `src/main/runtime/rpc/` and
`src/main/runtime/runtime-rpc/`, `src/cli/handlers/serve-*`, `config/orcad-host/`,
`config/scripts/pack-orcad-release.mjs`, `.github/workflows/orcad-release.yml`,
`tests/tools/orcad-soak/`, and the docs `orcad-operations.md`, `orcad-feature-parity.md`,
`headless-linux-server.md`, `multi-client-state-authority.md`, `remote-wire-compatibility.md`.

**Why the fork keeps it.** Upstream's orcad (pinned Node launcher, `OrcadRuntimeLifetime`, managed
SSH from Phase 3) is built for desktop-managed hosts; nothing upstream installs, supervises or
administers a standalone host. Where upstream already had the capability, upstream's code won and
the fork's copy was deleted on 2026-10-08: the headless window graph, scheduled automations,
the notification text module, the deferred browser provider, the web-client changes to the SSH
template, and a duplicate QR renderer. Fork behaviour that would break upstream's managed SSH is
opt-in: fail-closed `--port` needs `--require-port`, offer expiry needs `--pairing-expires`
(the installer passes both), endpoint failover never rotates `preferredEndpointId` for SSH or
managed environments, and the web client and `orca-cli.js` ship only in the release tarball,
outside `ORCAD_ARTIFACTS`. Re-check each against upstream on every sync: drop a part as soon as
upstream ships it.

| Commit       | Subject                                                                                                     | Upstream PR | Fork commits folded in                                                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `43a9c6e7e3` | feat(daemon): bound orcad's log, exited-history and resource use; exit terminals lost with a killed daemon  |             | 15f71db535, e06390d817, ae13aa9bb4, a99a2e9317, a2ffa0b977, 9504e818af, 77e8cff978, e689cde0fd                                                                                                             |
| `edbcf0856d` | feat(orcad): continuous health, self-watchdog, sd_notify and one degradation registry                       |             | 78d087b9de, df261b4404, 01b70276bb, a4f0edca3e                                                                                                                                                             |
| `24120c0b18` | feat(orcad): govern browser providers — tab caps, crash recovery, sidecar reaping, --browser                |             | 74d66dbca7, 2d2680d6df, e1c4cbeaba, daaae5f6b5, 9fb10b8927, 2d1fe209b0                                                                                                                                     |
| `bc1261984e` | feat(runtime): cheaper internet transport — deflate, paced session.tabs, compressed listings, stream resume |             | 4ee2f3aaac, e2bd87ba5d, 6c988cf7f4, b054385242, 1dd8fd7b12, c11d030475                                                                                                                                     |
| `f1acc11752` | feat(runtime): host-only pairing and device administration, security log, orca serve status/doctor          |             | ec17a2917a, 85159ba789, bb4e651c87, 65e1594e97, c9313425a1, eea48278c3, 04f8bcc37a, 8dfbe93d14, 6b27c5d2e0, 040dc5203f                                                                                     |
| `99fb2c6a43` | feat(pairing): offer every reachable endpoint and fail over between them                                    |             | 5cbe8b6417, 98679f9774, 42db79f7d9, 9240cfab8a                                                                                                                                                             |
| `c2f1695dc7` | feat(runtime): host-owned surfaces on renderer-less hosts — tombstones, editor tabs, sleeping agents        |             | 0f8a549384, 49d3d7b30f, 37c578cbf4, feae052cfd, f68b48b60b, 1ecf7c3006, 767b097da8, ff2c4756bf, 48ac8d06a3, 737d8ae1fa, a521d4395c, d86ea08443, d48127057b, 0482f89d7a                                     |
| `30140f1641` | feat(orcad): browser client, orca CLI and Orca Relay on self-managed hosts                                  |             | 5e5fbdf17d, c9ccb0dceb, 83aa3633a6, ecb226050a, 0879325e96, cb8a0e2bc6, f9f69c6f2e                                                                                                                         |
| `d04fe5f1cc` | feat(orcad): headless agent notifications, first-work rename, hook reconcile and disk reclamation           |             | f70b20cae0, 7659753b15, b81c3447e2, c9f21e423c, 749a5b2576, 7df28b50f2                                                                                                                                     |
| `7fd7d75a8d` | feat(orcad): Linux host packaging — release tarball, installer, systemd units, Dockerfile                   |             | cc17b0ec55, e302c8a238, 0fc41e578d, b24169c343, 2ee10dd163, 0dd8036e6f                                                                                                                                     |
| `8b8e934bc7` | test(orcad): soak and chaos harness with an in-process TCP fault proxy                                      |             | 86956aa9e5, ab1fa000a1, b6fb21d2d3                                                                                                                                                                         |
| `72752b5caf` | feat(orcad): wire the self-managed host features into orcad's entry                                         |             | c9f21e423c, 2d1fe209b0, 78d087b9de, 85159ba789, c9ccb0dceb, cb8a0e2bc6, ec17a2917a                                                                                                                         |
| `986b53e0c4` | docs(orcad): operations, parity, headless Linux, authority model and wire compatibility                     |             | de249b3c5c, 1ac556f65d, 3e46967284, 751abb672f, cdaaf9dee1, 5219df2359, a6f32420a6, 4f63eb64a2, 3ffb90dea9, 3a579bbb5f, 626b4ee603, a38ed8d1e2, b7f690b7ce, c280f87a05, 25de7cca7b, dfcd37f3d4, 54df4897d0 |
| `9dd8dbc346` | fix(runtime): report the desktop's text-deflate capability where routes read the handshake                  |             | b054385242                                                                                                                                                                                                 |
| `1667f8073a` | test(runtime): admit the sleeping-agent record writer to the session-writer ratchet                         |             | 48ac8d06a3                                                                                                                                                                                                 |

## distribution

**Purpose.** Ships the fork as its own product next to an installed official Orca: its own app
identity, CLI name, deep-link scheme, ports, secret storage and user data, its own update feed
(the fork's GitHub Releases), ad-hoc-signed macOS packaging and bundle-swap updates, and the
release workflow.

**Owns.** `src/shared/app-distribution.ts` and every place an identity-bearing value is read
(app id, protocol, ports, keychain/secret folders, CLI names, update URLs), `src/main/updater/**`,
`config/electron-builder.config.cjs` identity fields, `config/scripts/package-mac-adhoc.mjs`,
and the release workflow.

**Why the fork keeps it.** Fork-only. It integrates last because it renames values inside
files the other topics add; when upstream adds a new identity-bearing constant, add it here.

| Commit       | Subject                                                                              | Upstream PR | Fork commits folded in             |
| ------------ | ------------------------------------------------------------------------------------ | ----------- | ---------------------------------- |
| `0e1dcfa56a` | feat(distribution): ship the fork as its own app identity                            |             | 099bf02334                         |
| `1e9d8d6a9b` | feat(distribution): keep CLI, deep links, port, and secrets apart from official Orca |             | 27e29fb5d0, b7b2f7f285, 35ec151e83 |
| `dc16b45125` | feat(updater): check the distribution's own GitHub Releases for updates              |             | 754f02bae8, 35ec151e83             |
| `1d8542699f` | feat(updater): update ad-hoc signed macOS builds by swapping the app bundle          |             | f7134080ff, b7b2f7f285, 35ec151e83 |
| `3bca224367` | build(mac): package ad-hoc signed single-arch builds without a Developer ID          |             | 43ba9958b8                         |
| `dff7468134` | ci: publish distribution releases to the fork's GitHub Releases                      |             | 97b67e4836                         |

## integration-fixups

**Purpose.** Changes that only make sense with several topics present. The manifest marks this
topic `"onto": "integration"`: its commits are re-applied on top of the merged stacks, not on
upstream.

**Owns.** Single lines where one topic's test or code names a value another topic defines:
`src/cli/serve-data-root.test.ts` (orcad-runtime's data-root discovery with distribution's
data folder name) and `src/renderer/src/web/web-runtime-connection-heartbeat.ts` (orcad-runtime's
web heartbeat using runtime-remote's resume-probe constant).

Known overlap that is not a fixup: `.github/workflows/orcad-release.yml` was added by
orcad-runtime and already contains distribution's `workflow_call` trigger, because the file was
attributed to the topic that wrote most of it. Move that trigger into this topic if the two ever
need to be separated.

| Commit              | Subject                                                                                | Upstream PR | Fork commits folded in |
| ------------------- | -------------------------------------------------------------------------------------- | ----------- | ---------------------- |
| (rebuilt each sync) | test(fork): expect the distribution's desktop data folder in serve data-root discovery |             | 27e29fb5d0             |
| (rebuilt each sync) | refactor(fork): share the remote-runtime resume probe deadline with the web client     |             | 98679f9774, 4aa6517411 |

## Upstream PR candidates

Terminal changes not yet proposed upstream that would be worth a PR (none opened by this sync):

| Change                                                                                                                      | Fork commits                                               | Why it is a good candidate                                                                             |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Count VS16, keycap and post-Unicode-11 emoji as two cells                                                                   | 835bcbb288                                                 | A width bug fix every user hits; small and self-contained.                                             |
| Hold an IME commit in the grid until the PTY echoes it, and keep a space/punctuation/mark typed right after a Korean commit | 1e1795f1b8, 2f598af73e, 50a8cacc1c                         | Fixes lost or reordered Korean input; recorded agent PTY transcripts already prove it. Follows #23338. |
| OSC 9 / OSC 777 notifications and OSC 9;4 progress                                                                          | c00f9c9bd0                                                 | Standard escape sequences that other terminals support; maps onto upstream's notification options.     |
| Semantic prompt marks (OSC 133), prompt jumps and line bookmarks                                                            | 6eb1307344                                                 | Standard shell-integration protocol; no xterm patch needed.                                            |
| Ligatures for liga-only and Nerd Font families in the WebGL atlas                                                           | 6ef650bfe4, 8ea554aef7                                     | Bug fixes to an existing upstream feature.                                                             |
| Smart copy that strips TUI frames, gutters and hard wraps, plus Copy Raw                                                    | 30212c6ff7, 14fd6238aa                                     | Clear user value for agent TUIs; worth an issue first because it changes copy semantics.               |
| Pixel-precise scrolling and smooth scrollback scrolling                                                                     | dc3adfcd08, d66a24a10e, fc45263b93                         | Large and mostly an xterm.js patch; better proposed to xterm.js itself, then adopted by version bump.  |
| GUI-style input-line editing and the multi-line composer                                                                    | b0536b742c, c89b87488b, e85d388981, 170bbc80e7, fa5680079e | Large UX change; open an issue/discussion before a PR.                                                 |
