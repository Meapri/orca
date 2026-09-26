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
  `ORCA_DIAGNOSTICS_DISABLED=1`). Rotation of that file is not implemented — see
  [What is not covered](#what-is-not-covered).

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

`orca serve status` prints it and exits 1 when the host is not ready, is wedged, or does not
answer. On the host, it reads the orcad data root (`--data-root`, else `$ORCA_USER_DATA`, else
`$ORCA_USER_DATA_PATH`, else whichever default root has runtime metadata). With
`--environment <id>`, it asks a paired server instead.

### `degradations[]`

Each entry is `{ code, severity: critical | warning, component, message, reason? }`. `code` is
an open vocabulary: render `message`, and never switch on `code` exhaustively.

| Code                          | Severity | Meaning                                                                         |
| ----------------------------- | -------- | ------------------------------------------------------------------------------- |
| `terminal_daemon_unhealthy`   | critical | The daemon failed its self-test. Its sessions are `unverifiable`, not `exited`. |
| `terminal_unavailable`        | critical | This host cannot spawn PTYs (from `status.get`).                                |
| `runtime_unresponsive`        | critical | The self-probe over the runtime's own socket failed three times in a row.       |
| `threadpool_stalled`          | critical | Filesystem calls stopped completing (a hung mount or a saturated I/O pool).     |
| `terminal_daemon_absent`      | warning  | No daemon. Terminals run inside orcad and end when it restarts.                 |
| `terminal_daemon_not_durable` | warning  | The daemon answers, but new terminals are not daemon-owned.                     |
| `terminal_daemon_unscoped`    | warning  | Under a systemd service on Linux, the daemon shares the service cgroup.         |
| `event_loop_lagging`          | warning  | The event loop stalled at least 1s within the last minute.                      |
| `watchdog_probe_unavailable`  | warning  | A self-watchdog probe has never succeeded, so it cannot detect a wedge.         |
| `browser_unavailable`         | warning  | No browser backend (from `status.get`).                                         |

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

## Operator CLI

These commands run on the server host, or against it with `--environment`:

- `orca serve status [--fresh] [--json]` shows the verdict and stats above.
- `orca serve doctor [--data-root] [--bind] [--port] [--json]` is a preflight with a fix for
  each finding. It checks data-root ownership and mode, the Unix socket path length (the CLI
  cannot dial past `sun_path`), the instance lock, whether the listener can bind (a pinned port
  in use fails, because orcad would exit 78), the systemd user bus and linger that keep the
  daemon's scope alive across logouts and service restarts, daemon cgroup isolation, the glibc
  floor, the Node ABI (from the running orcad), and free disk space. Checks that need the
  running server are skipped when it is down. It exits 1 on any failure. It runs locally only.
- `orca serve pairing [--rotate] [--json]` reprints the running server's pairing link and a
  terminal QR code without a restart. The server re-serves its unused pending offer, the same
  one the readiness line printed, until a device uses it. `--rotate` revokes that offer and mints
  a new one. It runs locally only: `server.pairingOffer` refuses paired (remote) callers, and no
  new credential type exists.

## What is not covered

Named here so nothing reads as implemented that is not:

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
- **Credential administration** (list / revoke / rotate devices, expiring pending offers,
  structured security logging).
- **Reconciling `webClientUrl` with reachability** under the loopback default.
- **State-schema rollback rules.**
- **Daemon log rotation.** `<data-root>/logs/daemon.log` grows unbounded.
