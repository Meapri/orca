# Multi-client state authority

Several clients — desktops, phones, the web client — can pair to one host (`orcad` or a desktop
running `orca serve`). This page says who decides what, so the clients converge instead of each
re-imposing its own copy. It covers terminal tabs, agent resumes and PTY geometry; it builds on
[remote-wire-compatibility.md](./remote-wire-compatibility.md) and uses the verdict vocabulary of
[ssh-execution-boundary.md](./ssh-execution-boundary.md) (`live` / `unverifiable` / `exited`).

## The rule

**The host is the authority for every surface it executes.** A client's persisted copy — the
desktop's local profile, a phone's cache — is a view that may be arbitrarily stale: a laptop can
sleep for a week while another client closes half its tabs. Client-local state that the host never
executes (selection, scroll position, layout of client-hosted browser pages) stays client-owned.

A client never re-injects a host surface from its own copy. It asks the host, and the host answers
from what it recorded.

## Closed tabs stay closed: the closed-surface ledger

A reconnecting client re-mounts the panes it remembers and asks the host to create a terminal at
each remembered tab/leaf id. Before this ledger the host adopted any well-formed hinted id, so a tab
closed on client A while client B was offline came back when B reconnected (#21341, #22038, #21066),
and B's cold restore could even `--resume` the closed tab's agent (#21235).

`ClosedTerminalSurfaceLedger` (`src/main/runtime/closed-terminal-surface-ledger.ts`) is a durable
record, in `<data-root>/closed-terminal-surfaces.json`, of every surface a committed host close
retired:

| Recorded by                                                                   | Entry                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------ |
| a committed tab close (`commitHeadlessTerminalTabRetirement`)                 | tab id                                     |
| a committed session-tab close of one split leaf, `terminal.close` of one leaf | tab + leaf id                              |
| removing a worktree or folder workspace                                       | every terminal tab id the host knew for it |

- **Revisions.** Each record carries a host-issued, strictly increasing revision that survives
  restart. `horizonRevision` names the newest entry retention has since evicted.
- **Retention.** The same TTL as the client-side tombstones (30 days) and a 4096-entry cap, newest
  kept. Beyond that horizon the pre-ledger behaviour returns; tab ids are uuids, so the cost is a
  possible resurrection of a very old tab, never a refusal of a new one.
- **Durability.** Written with fsync + rename before the close is acknowledged. A file written by a
  newer schema, or one that could not be read, is honoured for refusals and never overwritten.
  Hosts constructed without storage (tests) keep the ledger in memory.

**What consults it.** `createTerminal` (every `terminal.create`, `terminal.ensureAgentSession`,
`terminal.createAgentSession` placement), `terminal.adoptOrphans`, and the membership fence that
admits a publisher's terminal surfaces into the host's session-tab snapshot. A hit is refused with
`TERMINAL_SURFACE_RETIRED_ERROR` = `terminal_gone_surface_retired`.

**Wire compatibility.** The refusal is a new answer on existing methods (rule 3 of the wire doc),
deliberately spelled with the `terminal_gone` token: every released remote client already reads a
message containing it as "that terminal ended" and stops retrying, so an old client degrades to an
ended pane instead of looping. A client from this version also drops its stale local tab
(`dropHostRetiredLocalTerminalTab`) — locally only, since the host already retired it. The host
advertises `terminal.closed-surface-ledger.v1`; no client behaviour depends on the capability.

## One pane per agent session: resume dedupe

A resume names a provider session — a transcript on one machine. The claim registry
(`ClaimedAgentPtyOwnerRegistry`) only knows panes spawned through `terminal.ensureAgentSession`, so
a pane where the agent was launched fresh or typed by hand was invisible to it, and a second
client's cold restore spawned another `--resume` onto the same transcript (#13716).

Before the claim, the host asks its agent-status store which pane carries the requested provider
session on this execution host (`findAgentResumePaneHolder`) and grades that pane's PTY:

| Holder PTY                                  | `terminal.ensureAgentSession`                       | legacy `terminal.create` resume   |
| ------------------------------------------- | --------------------------------------------------- | --------------------------------- |
| `live`, same workspace                      | returns the existing pane, `disposition: 'adopted'` | plain shell at the requested pane |
| `live`, another workspace                   | `agent_session_conflict`                            | plain shell                       |
| `unverifiable` (lost contact, disconnected) | `agent_session_ownership_unknown`                   | plain shell                       |
| `exited` (host-delivered exit)              | resumes normally                                    | resumes normally                  |

Only positive exit evidence releases a session; loss of contact never does. The `adopted` result and
both refusal codes already exist and clients already handle them — `adopted` hands the provisional
tab off to the host's, and the refusals are rethrown rather than retried through the legacy path.
The plain-shell degrade is the one cold restore already takes when it cannot resume.

A host with no renderer resumes its own lost agent panes (orcad, see
[orcad-feature-parity.md](./orcad-feature-parity.md)) through this same `terminal.ensureAgentSession`
path, placed at the pane's own ids, so it is deduped against client cold restores and refused for a
retired surface exactly like theirs.

## Who drives a shared PTY's geometry

`RemoteDesktopTerminalFloor` (`src/main/runtime/remote-desktop-terminal-floor.ts`) holds one owner
per PTY; the owner's viewport is the PTY size, every other desktop stream is parked at that grid
(`fit-override-changed` with mode `remote-desktop-fit`, the owner sees `desktop-fit`). A phone driver
outranks all desktops (`RuntimeTerminalDriverController`).

- **Explicit claims win immediately**: `ClaimViewport`, and every `Resize` from a legacy client that
  did not negotiate `desktopViewportClaims`.
- **Input claims** (tmux `window-size latest`): desktop input on a stream queues a host-side claim
  ahead of the input, so a client that types without claiming no longer types at another client's
  width, and a stream whose last claim failed is re-admitted by its next keystroke.
- **Damping**: while the current owner — or the host's own window — typed within the last
  `REMOTE_DESKTOP_INPUT_CLAIM_QUIET_MS` (1.5 s), a second typist shares control at the owner's grid
  instead of flipping it on every keystroke. Repeated claims by the owner at the same size apply no
  layout, so they cannot feed a resize loop.

## Titles after a host restart

The terminal daemon outlives `orcad`, and keeps each PTY's last OSC title; the restarted runtime
did not, so surviving terminals came back untitled with unknown status (#22809). The first provider
snapshot read for such a PTY now seeds its title through the existing restore seam
(`applySeededAgentStatus`: seed semantics, no waiters, no fresh-activity stamp), then republishes the
session tabs. A title this process observed live, or a manual title, always outranks the seed.

## Not covered

- **Clients never report a base revision.** The host refuses retired ids regardless of what the
  client last saw, which is enough for resurrection; a stale client's other mutations
  (`session.tabs.move` / `setTabProps` on a still-open tab) are still last-writer-wins.
- **Non-terminal surfaces.** Browser, renderer-owned editor and structured-chat tabs are not
  tombstoned; closing them relies on the existing per-surface retirement paths. The exception is
  the host-owned editor tabs a renderer-less host keeps (`host-editor-tabs.ts`): their ids are
  host-minted uuids, and a close records the id in this ledger before it removes the row, so a
  row a crash left in `host-editor-tabs.json` is never listed, read or saved again. Reopening the
  same file mints a new id, so the ledger never refuses a legitimate open.
- **A tab whose shell exited on its own** is not tombstoned: a hibernated agent pane legitimately
  cold-restores at the same ids.
- **Client-side ghost retention.** `recoverWebSessionTerminalOrphansBeforeApply` in the renderer
  can still re-insert a host-omitted mirrored surface it cannot resolve (#21236, #9585); the host
  refuses to recreate it, but the ghost row is removed client-side only by the existing proofs.
- **Explicit-claim flapping.** Two current clients that both send `ClaimViewport` on activity flip
  ownership per claim; damping applies to host-side input claims only.
- **Status after restart.** Hook rows restored from `last-status.json` stay `restoredUnconfirmed`
  and are not shown as live status (by design, see
  [agent-status-store.md](./agent-status-store.md)); only the title-derived status is seeded, and
  only once a provider snapshot of that PTY is read.
- **Verification.** The ledger, resume dedupe and damping are covered by unit and runtime tests on
  macOS; none of it is platform-specific, but nothing here was exercised on a Linux host.
