# Running orcad

`orcad` is the Orca runtime served from plain Node. This is the contract between it and
whatever supervises it: what it binds, what it owns on disk, who restarts what, and what its
readiness payload actually proves.

## Two long-lived processes, not one

A deployment is **orcad** plus **the terminal daemon**.

|            | orcad                            | terminal daemon                       |
| ---------- | -------------------------------- | ------------------------------------- |
| Started by | the supervisor                   | orcad, detached                       |
| Owns       | RPC, git, worktrees, persistence | every local PTY                       |
| Lifetime   | one supervised run               | detached from orcad, not its service  |
| Endpoint   | `ws://<bind>:<port>`             | `<data-root>/daemon/daemon-v<N>.sock` |

orcad detaches the daemon and calls `disconnectDaemon()`, never `shutdownDaemon()`. The
built-in remote deployment path stops only the recorded orcad PID, so the daemon and its PTYs
survive. The successor adopts the current endpoint and routes supported previous protocol
versions through legacy adapters. This makes a PID-scoped update, rollback or restart
non-destructive to live work.

Process detachment is not service isolation. A daemon that orcad launches directly, and every
PTY it owns, remain in the same systemd service cgroup. `KillMode=mixed` does **not** preserve
them: it sends the graceful stop signal only to the main process, then sends `SIGKILL` to every
process remaining in the cgroup the moment that main process exits — `TimeoutStopSec` never gets
the chance to apply. `KillMode=control-group` is destructive too. `KillMode=process` leaves
service-owned processes unmanaged and is not a supported preservation mechanism.

Service-restart survival therefore requires a separately supervised cgroup, and orcad now asks
for one: on Linux it launches the daemon through `systemd-run --user --scope`, which places the
daemon and its PTYs in their own transient `orca-daemon-<launch-nonce>.scope` unit under the
user slice instead of the caller's service cgroup. A stop or restart of the service unit then
leaves that scope — and the live terminals in it — running, and the successor adopts the
endpoint as it always has.

A newly launched private daemon scope also follows the daemon's own lifetime. A small
detached shell holds an input pipe from the daemon; after that pipe closes and `/proc`
confirms the daemon PID is gone, it asks the user manager to stop that exact scope.
Systemd sends remaining processes SIGTERM and escalates after five seconds. This includes
children that double-forked or called `setsid` and can no longer be found by parent PID.
Disconnecting or restarting the runtime does not close the pipe: the daemon owns it.

The cleanup only arms on a fresh scoped launch with a matching launch nonce. Adopted
legacy scopes can contain GUI processes and are never armed retroactively. Unscoped
launches and children deliberately moved into another systemd unit remain outside this
cleanup. `nohup`, `disown`, and `tmux` alone do not move a process out of its cgroup, so
those children now end when their terminal daemon dies. Work intended to outlive that
daemon needs its own service or scope.

The scope is requested only where it can work. All of these must hold:

- **Linux with systemd as PID 1** (`/run/systemd/system` exists).
- **A reachable user bus** — a connectable `bus` socket in the per-UID runtime dir
  (`/run/user/<uid>`, or whatever `XDG_RUNTIME_DIR` points at). For a service account that is
  not otherwise logged in, that means `loginctl enable-linger <user>`; a unit whose
  `RuntimeDirectory=` hardening moves `XDG_RUNTIME_DIR` off the per-UID path is handled, because
  the real per-UID path is probed first.
- **`systemd-run` on `PATH`** and answering `--version`.

Any of those missing, or a `StartTransientUnit` call that fails anyway, falls back to the
direct launch — and in that unscoped fallback case the paragraph above still describes reality:
the daemon shares the service cgroup and a combined-unit stop ends live terminals. Read the
`cgroupUnit` field in the daemon health payload to tell the two cases apart on a running host;
it is populated from `/proc/self/cgroup`, so it reports the isolation the daemon actually has
rather than what the launcher intended.

## Bind policy

`--bind <literal-ip>`, **default `127.0.0.1`**.

Only literal IPs are accepted; hostnames are refused because DNS would decide which
interface got bound. `localhost` maps to `127.0.0.1`. `0.0.0.0` / `::` are the explicit
opt-ins to network reach, and the startup log says so on every launch.

The bind is **pinned**, not defaulted. Two things widen the desktop's listener on their own —
`orca serve`'s wide default, and a startup where some device has connected before — and an
unattended host's exposure must be exactly what the operator asked for on every launch. A
mobile pairing offer, which normally rebinds to all interfaces, is refused while the bind is
pinned to loopback and reports `network_exposure_failed` rather than advertising an endpoint
nothing can reach.

Under the shipping design a client reaches a remote orcad over an SSH local port-forward, so
loopback is the correct default and the pairing credential travels over SSH.

A `--port` is pinned too. If that port cannot be bound (in use, privileged, or an address this
host does not own), orcad exits 78 and names the port. It never falls back to a persisted or
OS-assigned port, because every client would then dial a port nothing listens on. Without
`--port`, orcad tries the default `6768` and keeps the older fallback behavior.

### Pairing endpoints

`--pairing-address` may be given more than once. The first value is the advertised `endpoint`,
exactly as before. Every other place the listener is reachable goes into the offer's optional
`alternateEndpoints`, in the order a client should try them:

1. further `--pairing-address` values;
2. with `--bind 0.0.0.0` / `::`, the host's interface addresses: tailnet (100.64.0.0/10,
   fd7a:115c:a1e0::/48) first, then IPv4, then IPv6, virtual bridges last;
3. with a specific-IP bind, that IP.

A loopback bind adds nothing, since only an SSH forward reaches it. At most 8 alternates are
offered. A desktop client stores each as an endpoint of the same pairing; when a connect to the
preferred one goes unanswered it prefers the next, and whichever connects stays preferred. Older
clients ignore the field and dial `endpoint`.

## Transport over the internet

Every frame is E2EE ciphertext, so these behaviours are about the WebSocket carrying it:

- **Keepalive.** The host pings authenticated sockets every 15 s and reaps one only after
  3 consecutive unanswered probes; clients ping every 10 s and reset after 25 s of silence. Both
  sides use a 4-byte ping payload: an empty ping makes the peer auto-pong an empty frame, and an
  empty write fails with `EFAULT` on Electron/Linux ARM64 hosts (39-bit VA, e.g. Raspberry Pi),
  which was the ~15 s close-1006 cycle. `ws` is also patched to write empty frames in one call.
- **Compression.** permessage-deflate is negotiated with any client that offers it (desktop and
  browsers do), Huffman-only and without context takeover. Ciphertext does not compress, so the
  gain is base64's overhead on text frames, about 25%; binary frames are never deflated.
- **State streams under a thin link.** `session.tabs` streams keep one frame in flight per
  subscription: after each frame the host sends a delivery ping, and later changes park as the
  newest frame per worktree until the pong proves the peer has read it. Interactive replies on
  the same socket therefore wait behind at most one snapshot instead of the whole backlog. A clear
  link still carries every change immediately.
- **Discarded terminal frames** close the socket with 1013 so the client reconnects and
  resubscribes, rather than leaving it attached to a multiplex that no longer exists.
- **Resume.** On OS resume or network online the desktop probes every remote-runtime socket with
  an 8 s deadline and restarts reconnect backoff from 250 ms.

## Data root and the instance lock

The data root is `$ORCA_USER_DATA`, else `$XDG_DATA_HOME/Orca`, else `~/.orca`.

Before the profile index or the store is touched, orcad takes `<data-root>/orcad.lock`.
It refuses to start when:

| Code                                   | Meaning                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| `orcad_data_root_wrong_owner`          | the root is owned by another uid (POSIX)                      |
| `orcad_data_root_shared`               | the root is group/world accessible and could not be tightened |
| `orcad_instance_lock_held`             | another live orcad owns this root                             |
| `orcad_instance_lock_foreign_identity` | the lock belongs to a different identity                      |
| `orcad_data_root_unusable`             | the root cannot be created, stat'd or written                 |

A root that is merely too permissive and that we own is tightened to `0700` rather than
refused — orcad stores credentials there unsealed (no OS keyring on this host), so the goal
is a private root, and refusing when we could just fix it helps nobody. We refuse when the
permissions are not ours to fix. Windows is exempt from the owner and mode checks: ACLs are
not expressible as a POSIX mode, and `statSync().mode` there reports a synthesized one.

A dead holder's record is reclaimed (PID plus process start time, so a recycled PID does not
read as alive). A record belonging to a different identity is never reclaimed.

**The lock scopes one role — who is the runtime.** It deliberately says nothing about the
daemon, which lives under `<data-root>/daemon` and fences its own endpoint with its own PID
record. A lock that asked "is any process using this root" would refuse exactly the restarts
a live daemon makes worthwhile.

## Supervision

### Process-scoped and cgroup-wide stops

The built-in remote updater performs a PID-scoped stop and keeps the daemon's install version
pinned while it owns sessions. A combined-unit systemd stop or restart is different: unless the
daemon holds a durable cgroup scope of its own (see
[Two long-lived processes, not one](#two-long-lived-processes-not-one)), it reaps the daemon and
every live terminal after the graceful window. Treat a stop as destructive unless
`health.terminalDaemon.cgroupUnit` names an `orca-daemon-*.scope` on that host.

Before a cgroup-wide stop, obtain a fresh `orca-ide terminal list --json` result using the same OS
account and home as the daemon. Invoke the installer's absolute launcher path so `sudo`'s
`secure_path` cannot hide a per-user registration (for example,
`sudo -Hu orca /home/orca/.local/bin/orca-ide terminal list --json`). Replace both `orca` and
`/home/orca` with the service account and home used by the unit; an extracted deployment may use
its absolute `resources/bin/orca-ide` launcher instead. A safe empty census is untruncated, has an explicit `hostScope`, covers every
execution host affected by the stop, and lists no terminals on those hosts. Every
`omittedHostIds` entry must be explicitly accounted for outside the target service's execution
boundary. A separately paired runtime is outside that boundary; local execution and SSH hosts
reached through this runtime are not. An affected or unknown omission, missing scope,
truncation, a failed request or lost contact makes the result `unverifiable`: defer the stop. Do
not admit new work after the census. Orca does not yet provide an atomic census-and-stop fence.

### Who supervises orcad

An external supervisor (systemd, launchd, a process manager). orcad conforms to it:

- **Readiness.** One JSON line on stdout (`--json`), `type: "orca_server_ready"`, published
  after the listener is bound and the daemon verdict is in. The line is the primary signal.
  Set the supervisor's start timeout generously — the daemon launch has its own retries and
  can take tens of seconds on a cold host.
- **systemd notify.** When `NOTIFY_SOCKET` is set (Linux only), orcad also sends `READY=1`
  right after the readiness line, `WATCHDOG=1` every `WATCHDOG_USEC / 2` while its
  [self-watchdog](#self-watchdog) reports the runtime live, a `STATUS=` line on every verdict
  change, and `STOPPING=1` when a graceful stop begins. It sends them through the
  `systemd-notify` binary (the notify socket is a Unix datagram socket, which neither Node nor
  Bun can open), so the unit needs `NotifyAccess=all`. orcad removes `NOTIFY_SOCKET` and
  `WATCHDOG_*` from its environment before launching the daemon, so no PTY can signal the unit.
  A wedged runtime stops pinging, and systemd restarts the unit after `WatchdogSec`:

  ```ini
  [Service]
  Type=notify
  NotifyAccess=all
  WatchdogSec=60
  Restart=on-failure
  RestartPreventExitStatus=78
  ```

  Behind the bundled launcher, systemd's main PID is the launcher and the runtime is its child.
  orcad accepts `WATCHDOG_PID` naming either one. Without `NOTIFY_SOCKET`, none of this runs.

- **Shutdown.** `SIGTERM` or `SIGINT` starts one graceful stop. Repeated signals share
  that stop because a supervisor may signal both the launcher and its child. A 15s deadline
  exits with code 1 if teardown stalls. The bundled runtime also stops gracefully if its
  launcher's IPC channel closes. On POSIX, both the launcher and runtime ignore `SIGHUP`,
  so terminal hangups do not stop a headless host. Use `SIGTERM` or `SIGINT` to stop it.
- **Exit codes.**

  | Code | Meaning                                                                   | Supervisor should    |
  | ---- | ------------------------------------------------------------------------- | -------------------- |
  | 0    | clean shutdown                                                            | restart per policy   |
  | 1    | startup or shutdown failure                                               | restart with backoff |
  | 78   | configuration fault (bind address, pinned port, data root, instance lock) | **not** restart      |

  78 is `EX_CONFIG`. Put it in systemd's `RestartPreventExitStatus`: restarting on a data
  root owned by someone else is a restart-spin, not a recovery.

- **Logs.** orcad writes human-readable diagnostics to **stderr** and its readiness contract
  to **stdout**; the supervisor owns capture and rotation. The daemon, being detached, writes
  its own NDJSON lifecycle log to `<data-root>/logs/daemon.log` (suppressed by
  `ORCA_DIAGNOSTICS_DISABLED=1`). That file rotates by size: at 5 MB it becomes
  `daemon.log.1`, the previous `.1` becomes `.2`, and the oldest is dropped, so the family
  never exceeds three files (~15 MB). Rotation reads the file's on-disk size and takes a
  short `daemon.log.rotate-lock`, so it stays bounded across daemon restarts and while two
  daemon generations append to the same file. (A daemon forked from a build before this
  change keeps its own per-process counter; it is still bounded, but only by that counter.) A failed write (for example `ENOSPC`)
  pauses daemon logging for 60 s instead of for the rest of the daemon's life.

### orcad supervising the daemon

- **Launch.** On Linux, through `systemd-run --user --scope` so the daemon gets its own
  transient cgroup and survives a service-unit restart; everywhere else, and wherever that
  scope is unavailable, forked detached. Either way it runs `daemon-entry.js` beside
  `orcad.js` with its own PID record, token and socket under `<data-root>/daemon`.
- **Adoption before spawn.** A daemon already answering the endpoint is adopted, not
  replaced, unless it is unhealthy, foreign, or built from a superseded bundle _and_ owns no
  live sessions. Replacing a healthy daemon kills its PTYs, so code freshness always defers
  to live work.
- **Restart.** The adapter respawns the daemon on death, transparently to callers.
- **Sessions lost with a killed daemon.** A daemon that dies takes its PTYs' exit events with
  it. orcad's adapter records each session's shell PID; when the respawned daemon's inventory no
  longer lists a session and that PID is gone from this host's process table, the session exits
  (`terminal read` reports `exited`). That check runs right after the respawn and twice more 5 s
  apart, then on every later inventory. A PID that still exists or cannot be queried is not
  proof of either verdict and is left for the next check. The desktop app does not opt in: its
  panes remount and cold-restore instead. An agent pane that exits this way is relaunched in the
  same pane with its provider's resume command, and so is one whose daemon was already gone when
  orcad started (see [orcad-feature-parity.md](./orcad-feature-parity.md)); a plain shell is not.
- **Crash-loop containment.** At most **5 launches per 60s rolling window** per orcad run;
  past that, launches are refused with `daemon_crash_loop` and terminals fail with that
  message instead of the process forking forever. The window slides, so a repaired host
  recovers without restarting orcad. An operator-initiated daemon restart clears it — that
  is the deliberate "try again".
- **No macOS login-session watch.** That watch retires the daemon when the spawning GUI login
  session dies. An orcad daemon must survive its SSH session ending.
- **Shutdown.** orcad never stops the daemon. A daemon that was never adopted retires itself
  after its adoption window; an adopted one stays resident (see Decommissioning).

### Decommissioning

After a PID-scoped stop, an adopted daemon stays resident so the next orcad can reattach. A
combined-unit systemd stop also leaves a scope-isolated daemon resident, but kills one that
fell back to the service cgroup. To retire a process-scoped deployment, apply the census rule
above, stop orcad, then stop the daemon named by `health.terminalDaemon.pid`.
Only report it `exited` after verification on the execution host; loss of contact is
`unverifiable`.

### Self-managed hosts

`config/orcad-host/orcad-install.sh` applies this contract on a host that runs orcad under
its own systemd unit instead of the SSH deploy (setup in
[Headless Linux Server](./headless-linux-server.md#orcad-on-a-linux-host)). It installs the
same versioned directories and activation record, and delegates every decision to the SSH
deploy's own policy code, bundled as `orcad-host-install.js`:

- a unit stop proceeds only when every live daemon's `/proc/<pid>/cgroup` names an
  `orca-daemon-*.scope`, or the census above is safe and empty; `--force` never waives it;
- activation is gated on the readiness health payload, including the unit's main PID;
- rollback restores the pre-activation snapshot and follows `assessOrcadRollback`;
- uninstall retires the daemon, so it always requires an empty census.

The unit templates it installs set `RestartPreventExitStatus=78`, `TimeoutStopSec` above the
15s shutdown deadline, and `KillMode=mixed` — which preserves nothing by itself; the daemon's
scope does. They carry, commented out, the optional [systemd notify](#who-supervises-orcad)
lines exactly as orcad implements them (`Type=notify`, `NotifyAccess=all`, `WatchdogSec=60`),
[resource-limit](#resource-governance) examples as `Environment=` lines, and `Nice=` with the
`LimitNICE=` it needs. Further orcad flags — `--limit key=value`, `--pairing-expires`, extra
`--pairing-address` values — go in `ORCAD_EXTRA_ARGS` in `orcad.env`.

The readiness line (it carries the startup pairing credential) goes to
`$XDG_RUNTIME_DIR/orcad/readiness.json` (`/run/orcad/readiness.json` for the system unit). The
units set `RuntimeDirectoryMode=0700`, and `orcad-install.sh run` creates the file `0600` under a
subshell `umask 077` before orcad writes to it, tightening a directory it owns that an older
install left permissive. The umask never reaches orcad itself, because its daemon and every PTY
inherit orcad's.

## Health

The readiness payload carries a `health` object:

```
buildHash    sha256 (16 hex) of the running orcad bundle — build identity that a version
             string cannot give, so a rollback that did not replace the file is visible
buildVersion ORCA_VERSION
nodeVersion  / nodeAbi   process.versions.node / .modules — the ABI native addons must match
platform / arch / pid
terminalDaemon:
  state              live | degraded | absent
  ownsFreshSessions  whether NEW terminals are daemon-owned; this supports PID-scoped
                     restart recovery, not supervisor or service-cgroup isolation
  pid                the live daemon's pid, from its own PID record
  buildVersion       the build the LIVE daemon was forked from (may legitimately predate
                     this orcad after an update — reporting orcad's version for both would
                     hide exactly that)
  entryPath / protocolVersion
  cgroupUnit         the systemd scope the daemon found itself in, or null (unscoped)
  selfTest { ok, coverage, verdict, durationMs }
degradations[]     see below; optional, so an older reader treats absence as "not reported"
watchdog           the self-watchdog snapshot (server.health only; the readiness payload
                   precedes the first probe)
```

### What the self-test proves

`selfTest` runs `checkDaemonHealth` against the daemon's socket. It is green only when the
daemon **opened its socket, completed the protocol handshake, and ran `ptySpawnHealth` — a
real short-lived PTY spawned inside the daemon's own process**. It therefore spans both
processes: orcad drives it, the daemon performs it, the verdict crosses the socket.

- `coverage: 'pty-spawn'` — the full round trip above.
- `coverage: 'handshake'` — **win32 only**, where `checkPtySpawnHealth` returns without
  spawning anything. A green verdict there covers the handshake and nothing more. It is
  reported separately rather than folded into `ok` so nobody reads it as a PTY round trip.

`state` is `live` only when the self-test passed **and** `ownsFreshSessions` is true. A
daemon that answers but has fallen back to local spawning for new terminals is `degraded`,
because those terminals die with orcad. A daemon that answered and then failed its spawn
probe is also `degraded`, not `absent`: it still holds live sessions, and calling those
exited would be the verdict `ssh-execution-boundary.md` forbids guessing.

## Resource governance

A small VPS must survive runaway agent work and months of unattended disk growth. Every knob is an
environment variable (for a systemd unit's `Environment=`) and also an orcad flag,
`--limit <key>=<value>` (repeatable), which sets the same variable before anything reads it.
Invalid values are logged and ignored rather than guessed at.

| `--limit` key              | Environment variable                   | Default     |
| -------------------------- | -------------------------------------- | ----------- |
| `terminal-memory-high`     | `ORCA_TERMINAL_MEMORY_HIGH`            | unset       |
| `terminal-memory-max`      | `ORCA_TERMINAL_MEMORY_MAX`             | unset       |
| `terminal-tasks-max`       | `ORCA_TERMINAL_TASKS_MAX`              | unset       |
| `terminal-cpu-weight`      | `ORCA_TERMINAL_CPU_WEIGHT`             | unset       |
| `terminal-nice`            | `ORCA_TERMINAL_NICE`                   | reset to 0  |
| `terminal-oom-score-adj`   | `ORCA_TERMINAL_OOM_SCORE_ADJ`          | 200 (Linux) |
| `history-retention-days`   | `ORCA_TERMINAL_HISTORY_RETENTION_DAYS` | 7           |
| `history-max-exited-mb`    | `ORCA_TERMINAL_HISTORY_MAX_EXITED_MB`  | 2048        |
| `browser-max-tabs`         | `ORCA_BROWSER_MAX_TABS`                | 8           |
| `browser-tab-idle-minutes` | `ORCA_BROWSER_TAB_IDLE_MINUTES`        | 30          |

### Terminal and agent limits (Linux, systemd)

The four `terminal-*` cgroup limits are systemd properties (`MemoryHigh=`, `MemoryMax=`,
`TasksMax=`, `CPUWeight=`, same value syntax: `4G`, `80%`, `infinity`, `idle`) applied to the
daemon's `orca-daemon-*.scope`. That scope holds the daemon and every PTY it owns, so a limit
bounds **all terminal and agent work on the host together**, not each terminal. Prefer
`MemoryHigh` (throttle and reclaim) with `MemoryMax` a little above it as the hard stop.

- **Fresh daemon.** The limits are passed to `systemd-run --scope` at launch. Every fresh scope
  also asks for `OOMPolicy=continue`: with systemd's default (`stop`), one OOM-killed agent would
  make systemd stop the whole scope and every terminal in it. If systemd rejects the properties
  (for example an older systemd without scope `OOMPolicy`), the launch retries a bare scope, then
  falls back to the unscoped launch exactly as before.
- **Adopted daemon.** orcad restarts adopt the running daemon, so on every start orcad also runs
  `systemctl --user set-property --runtime <scope> …` for the configured limits. Changing a limit
  and restarting orcad takes effect without touching live terminals. It is never applied to a
  legacy `app-orca-*` scope, which can contain desktop GUI processes.
- **Not in force.** Configured limits that are not enforced — no systemd user manager, a daemon
  that fell back to the unscoped launch, rejected properties, a failed `set-property` — are
  published in `status.get` as a `terminal_resource_limits_unavailable` degradation naming the
  missing assignments. Terminals keep working either way.

Per-terminal limits (one sub-scope per PTY) are deliberately not provided: moving a PTY into its
own unit takes it out of the daemon scope that is stopped when the daemon dies, so its
descendants would outlive the daemon.

### PTY priority and OOM preference

- **Niceness (#14639).** A PTY child used to inherit orcad's nice level. A niced daemon now resets
  each new PTY child to 0; `ORCA_TERMINAL_NICE=inherit` keeps inheritance and an integer pins a
  level. Lowering niceness needs `RLIMIT_NICE`: in the unit, `Nice=10` plus `LimitNICE=20` lets
  the service run niced while terminals run at 0. Without it the reset is refused and children
  keep the inherited level.
- **OOM preference (Linux).** Each new PTY child's `oom_score_adj` is raised to 200 (never
  lowered; `0` disables), so under memory pressure the kernel kills a runaway agent before the
  daemon that owns every other terminal. Descendants inherit it.

Both are applied by the daemon at spawn, from the environment it was launched with, so they reach
terminals created by a daemon launched after the setting changed. They, and the launch-time scope
properties above, live in the shared daemon launch path, so a Linux desktop gets them too.

### Terminal history retention

Each daemon-backed terminal keeps a history tree (checkpoint plus incremental log, up to hundreds
of MB) under `<data-root>/terminal-history/`. Ten seconds after start orcad runs the desktop's
orphan GC, which removes the trees of workspaces the profile no longer knows (it refuses to run on
an empty or unreadable live set). It also sweeps exited sessions two minutes after start and every
six hours:

- Only sessions whose PTY exit was **observed** are collectible: `meta.json` records `endedAt`
  and a numeric `exitCode`. That is the `exited` verdict of
  [ssh-execution-boundary.md](./ssh-execution-boundary.md). A session still marked running (it may
  be live, or crash-restorable), one a shutdown marked ended without an exit code, one with
  unreadable metadata, and one a daemon adapter still writes are kept, whatever their age.
- Exited sessions older than `history-retention-days`, then the oldest exited sessions until the
  rest fit `history-max-exited-mb`, are tombstoned and removed off the critical path. Nothing that
  ended less than ten minutes ago is collected. `off` disables either rule.
- Nothing reads an exited session's tree (cold restore requires a session that did not end), so
  collection only drops scrollback of terminals whose process is gone.

orcad runs no private `CODEX_HOME` (the Codex account flows are desktop-only), so Codex's own
`sessions/` under the user's `~/.codex` is third-party data and is never touched.

### Headless browser tabs

Each browser tab is a renderer process. Both orcad browser providers — the installed Orca Electron
app driven as a `--serve` sidecar, and an operator-supplied Chromium via `ORCA_BROWSER_EXECUTABLE`
— now bound them (#14552):

- **Cap.** Creating a tab beyond `browser-max-tabs` first closes the least recently used one.
- **Idle.** A tab no command has touched for `browser-tab-idle-minutes` (`off` disables) is closed
  by a once-a-minute maintenance pass. With external Chromium the last tab is blanked instead,
  because the driver needs one attached page.
- A command naming a reclaimed tab fails like any closed tab, and the tab list is republished.

The browser runs in its own process tree, so its death never takes orcad down (#16084); what
changed is that orcad now recovers it instead of staying broken:

- **External Chromium.** A tab whose renderer stopped answering (a command timed out and a 5 s URL
  probe also failed) is closed with `browser_tab_closed`. Two consecutive driver failures mark the
  browser crashed: its tabs are forgotten, `status.get` reports `browser_unavailable` /
  `provider_unhealthy`, and it is relaunched on the next command or maintenance pass.
- **Electron sidecar.** A sidecar whose process exited is relaunched by the maintenance pass.
- Relaunches are spaced at least 5 s apart and capped at 5 per 10 minutes, the same containment
  the terminal daemon uses, so a host that cannot keep a browser up stops forking one.

## Continuous health

The readiness payload is a snapshot. A running orcad keeps the same verdict up to date. It
re-runs `collectOrcadHealth()` once a minute, because the daemon self-test spawns a real PTY and
running it on every probe would make the probe the load. Each probe then combines that cached
result with the live self-watchdog. There are three ways to read it.

### `/healthz` and `/readyz`

These are plain HTTP `GET`/`HEAD` paths on orcad's existing WebSocket listener, so they are
loopback-only unless `--bind` widened the listener. They need no pairing credential, so their
bodies carry verdict words and degradation codes only. They never include PIDs, paths,
versions or messages.

| Path       | 200                                     | 503                                                                                     |
| ---------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| `/healthz` | `{"status":"ok"}`                       | `{"status":"wedged"}` — the self-watchdog tripped                                       |
| `/readyz`  | `{"status":"ready","degradations":[…]}` | `starting` before the readiness line; `not_ready` while a `critical` degradation stands |

`degradations` here is `[{ "code", "severity" }]`. Liveness says "restart me". Readiness says
"route no new work here". A host with only `warning` degradations is ready.

### `server.health` and `orca serve status`

`server.health` (params `{ fresh?: boolean }`) is an authenticated RPC method that returns the
full picture: `state`, `live`, `boundEndpoint`, `checkedAt`, the `health` object above with
`degradations` and `watchdog`, and `stats` (`startedAt`, `uptimeSeconds`, memory, CPU,
`connectedClients`, `pairedDevices`, `localTerminals`). A count that could not be verified is
`null`, never `0`. `fresh: true` re-runs the daemon self-test first. The wire types are in
`src/shared/orcad-server-health-contract.ts`.

Only orcad registers `server.*`. The desktop app, and orcad builds from before this surface,
answer `method_not_found`. Treat that as "not reported", never as "down".

`orca serve status` prints it, one line per degradation as `[severity] component/code (reason):
message`, and exits 1 when the host is not ready, is wedged, or does not answer. On the host it
dials the data root every `orca serve` command shares (see [Operator CLI](#operator-cli)). With
`--environment <id>`, it asks a paired server instead.

### `degradations[]`

Each entry is `{ code, severity: critical | warning, component, message, reason? }`. `code` is
an open vocabulary: render `message`, and never switch on `code` exhaustively.

| Code                                   | Severity | Meaning                                                                                                                                                                                                         |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal_daemon_unhealthy`            | critical | The daemon failed its self-test. Its sessions are `unverifiable`, not `exited`.                                                                                                                                 |
| `terminal_unavailable`                 | critical | This host cannot spawn PTYs (from `status.get`).                                                                                                                                                                |
| `runtime_unresponsive`                 | critical | The self-probe over the runtime's own socket failed three times in a row.                                                                                                                                       |
| `threadpool_stalled`                   | critical | Filesystem calls stopped completing (a hung mount or a saturated I/O pool).                                                                                                                                     |
| `terminal_daemon_absent`               | warning  | No daemon. Terminals run inside orcad and end when it restarts.                                                                                                                                                 |
| `terminal_daemon_not_durable`          | warning  | The daemon answers, but new terminals are not daemon-owned.                                                                                                                                                     |
| `terminal_daemon_unscoped`             | warning  | Under a systemd service on Linux, the daemon shares the service cgroup.                                                                                                                                         |
| `event_loop_lagging`                   | warning  | The event loop stalled at least 1s within the last minute.                                                                                                                                                      |
| `watchdog_probe_unavailable`           | warning  | A self-watchdog probe has never succeeded, so it cannot detect a wedge.                                                                                                                                         |
| `browser_unavailable`                  | warning  | No browser backend (from `status.get`); `reason` says why, e.g. `unconfigured`, `electron_start_failed`, or `provider_unhealthy` for a browser that stopped answering.                                          |
| `terminal_resource_limits_unavailable` | warning  | Configured [terminal limits](#terminal-and-agent-limits-linux-systemd) are not in force; `reason` is `systemd_scope_unavailable`, `scope_properties_rejected` or `set_property_failed`. Terminals keep working. |

Every entry comes from one registry, `deriveOrcadDegradations` in
`src/main/orcad/orcad-degradations.ts`: the daemon verdict, the self-watchdog, and whatever
`status.get` reports (browser, PTY and resource-limit degradations), so the readiness line,
`/readyz`, `server.health` and `orca serve status` never disagree. A runtime degradation takes
its `component` from its capability (`terminal.*` or `browser.*`), and only `terminal_unavailable`
among them is `critical`.

### Self-watchdog

This addresses a listener that stays bound while the runtime stops answering (#23072). orcad
measures event-loop timer drift every 500 ms. Every 10 s, it also sends a real request over its
own local socket, and it stats its data root to exercise the I/O thread pool. A probe that
fails, or has not settled within 5 s, counts as a failure. Three failures in a row, after that
probe has succeeded at least once, make the host `wedged`: `/healthz` returns 503,
`server.health` reports `live: false`, and systemd watchdog pings stop. The next successful
probe clears it. A probe that has never succeeded is a probe fault, not proof that the runtime
stopped, so it only raises `watchdog_probe_unavailable`. Withholding pings on it would put a
host that was never wedged into a restart loop.

A synchronous stall cannot be seen from inside while it is happening. Timers do not fire until
it ends, and it is then reported as lag. That is why the systemd watchdog, an outside observer,
is the restart mechanism.

## Pairing and credential administration

Every paired client holds its own bearer token in `<data-root>/orca-devices.json` (mode `0600`),
scoped `runtime` (the full RPC surface, used by desktops, the web client and peer hosts) or
`mobile` (the phone allowlist). A pairing URL carries the endpoint, that token and the host's E2EE
public key from `<data-root>/orca-e2ee-keypair.json`. **Whoever holds the URL is that device**, so
treat it like a password.

### Offers expire unclaimed

The offer orcad prints in its readiness payload, and every offer minted with `orca serve pairing
new`, is a standalone pending entry that stops authenticating after its lifetime (default 15
minutes; `--pairing-expires <dur>` on orcad, `--expires <dur>` on the CLI, 1m to 7d). Readiness
reports it as `pairing.expiresAt` (additive). The first client that authenticates with an offer
claims it: the entry becomes a paired device and no longer expires. Expired offers are dropped on
startup, on `devices list` and on the next mint.

Claiming is not cryptographic single use. The protocol has no token exchange, so after the claim
the same URL remains that device's credential; a copy used later is indistinguishable from the
device. Revoke or rotate a grant whose URL leaked. The desktop's own QR and access-link flows keep
their open-ended, coalescing offer and never adopt, extend or rotate away a minted one.

### Administering a running server

Every command below acts only on the Orca runtime on the machine it runs on, over its owner-only
local socket (the same `0600` metadata token every local CLI command uses). A paired client of any
scope is refused, and `--environment` / `--pairing-code` are rejected rather than ignored. See
[Operator CLI](#operator-cli) for how the target data root is chosen.

| Command                                                                                 | Effect                                                                                                         |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `orca serve pairing [show] [--rotate]`                                                  | orcad only: reprints the startup offer (below); `--rotate` revokes that unused offer and mints a new one       |
| `orca serve pairing new [--mobile\|--runtime] [--pairing-address] [--expires] [--name]` | mints an additional offer against the live server; the startup offer is untouched                              |
| `orca serve devices list [--json]`                                                      | ids, scope, pending/paired, last use, offer expiry, open connections and the server key fingerprint; no tokens |
| `orca serve devices revoke <id>`                                                        | removes the grant, closes every socket it authenticated, and refuses it on reconnect, including after restart  |
| `orca serve devices rotate <id>`                                                        | runtime grants only: new token for the same device id, old one refused at once; prints the new URL             |

**The startup offer.** `orca serve pairing` (and its alias `orca serve pairing show`) re-serves
the exact offer the readiness line printed — same device id, same `expiresAt`, same
`alternateEndpoints` — while it is unclaimed and unexpired, so reprinting it never mints a
credential. Once a client claims it or it expires, the next call mints a fresh one with the same
`--pairing-expires` lifetime. `--rotate` revokes the unused offer first (a `pairing.superseded`
security event) and refuses to mint a replacement if that revocation could not be persisted; a
device that already claimed an offer is never touched by a rotation.

Runtime and mobile offers can coexist: pairing scope is chosen per offer, not per process, so a
server can take a phone and be saved as an environment by a peer host without a restart
(`--mobile-pairing` on `orca serve` still only picks which scope the startup offer uses). A mobile
offer needs `--pairing-address` set to what the phone dials, and pairs on the direct path without
Orca Relay. On a loopback-pinned orcad the address vouches for a reverse proxy or tunnel; the bind
is never widened. Mobile pairings cannot be rotated in place because the token also keys the
phone's Relay and push identity: revoke and pair again.

### Security log

With a data root, orcad appends NDJSON to `<data-root>/logs/security.log`, rotated by size (5 MB,
five files: `security.log.1` … `.4`). Events: `pairing.offered`, `pairing.consumed` (a device was
added), `pairing.expired`, `pairing.superseded`, `device.revoked`, `device.rotated`, `auth.failed`
(E2EE refusals and bad local-socket tokens, at most 20 records a minute) and
`auth.failed.suppressed` (how many were dropped). Records carry ids, scope, label and fixed reason
strings, never tokens or pairing URLs. The desktop app does not write this log.

## Operator CLI

One command family administers a server from its own host:

| Command                                                                                 | Answers from                                       |
| --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `orca serve status [--fresh] [--json]`                                                  | `server.health` (orcad); `--environment` allowed   |
| `orca serve doctor [--bind] [--port] [--json]`                                          | host probes, plus `server.health` when orcad is up |
| `orca serve pairing [show] [--rotate] [--json]`                                         | `server.pairingOffer` (orcad)                      |
| `orca serve pairing new [--mobile\|--runtime] [--pairing-address] [--expires] [--name]` | `pairing.create` (any runtime)                     |
| `orca serve devices list\|revoke <id>\|rotate <id>`                                     | `devices.*` (any runtime)                          |

All of them, except `status --environment`, dial one local data root, resolved the same way:
`--data-root`, else `$ORCA_USER_DATA` (orcad's own override), else `$ORCA_USER_DATA_PATH` (set
inside an Orca terminal), else the first default root with runtime metadata — orcad's
(`$XDG_DATA_HOME/Orca` or `~/.orca`) before the desktop profile — and orcad's root when neither
has one. Pass `--data-root` when a desktop app and orcad both run on one machine. They run in one
CLI handler group, and a packaged `orca-ide serve status|doctor|pairing|devices …` is handed to
the CLI instead of starting a second server against the same profile. `server.*` methods exist
only on orcad, so against the desktop app `status` and `pairing` say the runtime does not
publish that surface rather than reporting it down.

`doctor` checks data-root ownership and mode, the Unix socket path length (the CLI cannot dial
past `sun_path`), the instance lock, whether the listener can bind (a pinned port in use fails,
because orcad would exit 78), the systemd user bus and linger that keep the daemon's scope alive
across logouts and service restarts, daemon cgroup isolation, the glibc floor, the Node ABI (from
the running orcad), and free disk space. Checks that need the running server are skipped when it
is down. It exits 1 on any failure.

## Feature parity with `orca serve`

Which paired-client features orcad still lacks relative to the Electron-hosted `orca serve`, and
which startup steps it now performs the same way, is tracked in
[orcad-feature-parity.md](./orcad-feature-parity.md).

## What is not covered

Named here so nothing reads as implemented that is not:

- **Per-terminal resource limits.** Limits cover the daemon scope as a whole (see
  [Resource governance](#resource-governance)); one terminal can still use the whole budget.
- **Browser processes orphaned by a killed driver.** If the external Chromium provider's
  `agent-browser` daemon itself is killed, the Chromium tree it launched is re-parented and keeps
  running; the relaunched driver starts a new browser and nothing reaps the old one.
- **Resource governance on the desktop app.** Exited-history retention and the live
  `set-property` apply are wired into orcad only; the desktop keeps its previous behavior.
- **Health probes without a WebSocket listener.** `/healthz` and `/readyz` share the WebSocket
  listener. When that listener fails to start without a pinned `--port`, orcad serves over its
  local socket only, and `orca serve status` still works, but there is no HTTP probe.
- **systemd notify verified on a real host.** The `sd_notify` path is covered by unit tests
  with fakes. It has not been exercised against a real systemd manager in CI. Older
  `systemd-notify` builds can exit before systemd attributes the message to the unit. If the
  unit never leaves `activating`, use `Type=exec` and probe `/readyz` instead.
- **Supervision of an unscoped fallback daemon.** When the durable `systemd-run --user --scope`
  launch is unavailable (see [above](#two-long-lived-processes-not-one)) orcad and its daemon
  share one service cgroup, and a combined-unit stop cannot preserve live terminals. There is
  no mechanism that re-isolates such a daemon after the fact.
- **libc slot.** There is no honest health value to publish until native libc detection owns
  it.
- **A fast start beside a stalled desktop app.** orcad resolves its browser provider before it
  publishes readiness. Where an installed Orca desktop app exists (macOS `/Applications`, Linux
  `orca-ide`), it is started as a sidecar and waited on for up to 120 s; one that never answers
  (seen on macOS under a fresh, empty `HOME`) delays readiness by that long and then reports
  `browser_unavailable` (`electron_start_failed`). There is no switch to skip the sidecar.
- **An `unverifiable` terminal status.** `terminal read` reports `running`, `exited` or
  `unknown`; the wire has no `unverifiable`. A session lost with its daemon whose shell PID still
  exists (an orphan that survived the hangup) or cannot be queried keeps its last status rather
  than being guessed `exited`. A reused PID is treated as "still exists", since no process start
  time is recorded per session.
- **Alternate endpoints on later offers.** Only the startup offer (and its reprints) carries
  `alternateEndpoints`; `orca serve pairing new` and `devices rotate` encode the one endpoint
  named by their `--pairing-address`.
- **Strict single-use pairing offers.** A claimed offer's URL stays the device's bearer
  credential; closing that needs a protocol-level token exchange that old clients do not speak.
- **Rotating the host E2EE identity** or a mobile pairing in place, and administering credentials
  from a paired client (host-only by design).
- **Reconciling `webClientUrl` with reachability** under the loopback default.
- **State-schema rollback rules.**
- **A census without the Orca CLI.** The self-managed installer reads live terminals through
  `terminal list --json` from an Orca CLI. A host with no CLI can prove a stop safe only
  through daemon scope isolation; an unscoped daemon there cannot be stopped by the installer.
- **Published standalone release assets.** `pnpm pack:orcad-release` builds the tarball and
  installer, but the release workflow does not publish them.
- **Terminal stream resumption.** A reconnect always re-subscribes and receives a full snapshot;
  there is no replay from the last acknowledged sequence.
- **Relay pairing for orcad.** The cloud relay is wired only in the desktop app; orcad offers
  direct endpoints only.
- **Endpoint failover and resume probing outside the desktop.** The web client and mobile app do
  not read `alternateEndpoints`, and the web client has no resume-triggered probe.
- **Compress-before-encrypt.** JSON state is not compressed before encryption, so the stream
  itself stays roughly as large as its plaintext.
