# Headless Linux Server

Use this guide to run Orca on a Linux machine without a desktop session, such as an
Ubuntu VPS or a remote build box, and connect to it from other devices.

There are two ways to do it:

- **orcad (recommended).** The Orca runtime served from a bundled Bun runtime. No
  Electron, no Xvfb, no GTK or X11 libraries. It is packaged as a versioned install
  directory with an on-host installer, systemd units and a container image, and the
  service contract it follows is [Running orcad](./orcad-operations.md).
- **Electron `orca serve` (legacy).** The desktop AppImage started without a window. It
  still needs Xvfb and the Electron shared libraries; see
  [Legacy: Electron AppImage with Xvfb](#legacy-electron-appimage-with-xvfb).

## orcad on a Linux host

### What it needs

- Linux on x86-64 or arm64. `glibc` builds cover Ubuntu 20.04+ and current Debian stable
  (glibc 2.31 floor, see [Linux glibc compatibility](./linux-glibc-compatibility.md));
  `musl` builds exist for Alpine-style hosts.
- `git`, `ca-certificates`, `tar`, `gzip`, and one of `sha256sum`, `shasum` or `openssl`.
- For terminals that survive a service restart: systemd as PID 1, `systemd-run` on
  `PATH`, and a running user manager for the service account (`loginctl enable-linger`).
  Without them orcad still runs, but every service stop ends live terminals — see
  [Terminal survival](#terminal-survival).

Nothing else: the release carries its own runtime, file watcher and ripgrep.

### Get a release

A release is three files per target plus the installer:

| File                                          | What it is                                                       |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `orcad-<version>-<target>.tar.gz`             | one `orcad-<version>/` install directory (the SSH deploy's own)  |
| `orcad-<version>-<target>.tar.gz.sha256`      | its checksum, `sha256sum -c` format                              |
| `orcad-<version>-<target>.json`               | version, target and both checksums                               |
| `orcad-install.sh`, `orcad-install.sh.sha256` | the installer, also shipped inside every tarball under `deploy/` |

`<version>` is content-hashed (`0.1.0+5f23baf0c093`), so two different builds never
share a name. `<target>` is `linux-x64-glibc`, `linux-arm64-glibc`, `linux-x64-musl` or
`linux-arm64-musl`. Build them from a checkout with:

```bash
pnpm install
pnpm pack:orcad-release --target linux-x64-glibc   # writes out/orcad-release/
```

The release workflow does not publish these assets yet, so copy them to the host
yourself (for example with `scp out/orcad-release/* vps:`).

Download, then verify, then run. Never pipe the installer into a shell:

```bash
sha256sum -c orcad-install.sh.sha256
sh orcad-install.sh install orcad-<version>-linux-x64-glibc.tar.gz
```

`install` refuses to proceed without a checksum (`--sha256 <hex>`, `--sha256-file <file>`,
or the `.sha256` file beside the tarball). It compares the checksum before it lists or
extracts anything, rejects archives with entries outside `orcad-<version>/`, absolute or
`..` paths, or symlinks, checks the build target against this host, and publishes the
version with one atomic rename. Installing an installed version is a no-op.

### Install as a user service

This is the recommended setup: the service runs as your own account, and its user
manager also hosts the terminal daemon's scope.

```bash
sudo loginctl enable-linger "$USER"      # once: the user manager outlives SSH logins
sh orcad-install.sh install orcad-<version>-linux-x64-glibc.tar.gz
sh orcad-install.sh service-install      # writes and enables ~/.config/systemd/user/orcad.service
sh orcad-install.sh activate <version>   # starts it and gates on its health
sh orcad-install.sh status
```

`upgrade <tarball>` is `install` followed by `activate`. The layout it maintains is the
same one the desktop's SSH deploy uses:

```text
~/.orca-remote/orcad-<version>/        immutable install, one per version
~/.orca-remote/orcad-current           symlink the unit starts through
~/.orca-remote/orcad-active.json       activation record: active, previous, snapshot
~/.orca-remote/orcad-state-snapshots/  pre-activation copies of the data root
~/.orca/                               the data root (ORCA_USER_DATA)
```

`service-install` renders this unit (paths filled in for your home):

```ini
# ~/.config/systemd/user/orcad.service
[Unit]
Description=Orca headless runtime (orcad)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
#Type=notify
#NotifyAccess=all
#WatchdogSec=60
Environment=ORCAD_BASE=/home/me/.orca-remote
Environment=ORCA_USER_DATA=/home/me/.orca
Environment=ORCAD_BIND=127.0.0.1
Environment=ORCAD_PORT=6768
Environment=ORCAD_READINESS_FILE=%t/orcad/readiness.json
#Environment=ORCA_TERMINAL_MEMORY_HIGH=3G
#Nice=10
#LimitNICE=20
EnvironmentFile=-/home/me/.config/orcad/orcad.env
RuntimeDirectory=orcad
RuntimeDirectoryMode=0700
ExecStart=/bin/sh /home/me/.orca-remote/orcad-current/deploy/orcad-install.sh run
Restart=always
RestartSec=5
RestartPreventExitStatus=78
TimeoutStartSec=180
TimeoutStopSec=30
KillMode=mixed

[Install]
WantedBy=default.target
```

Why each setting is what it is:

- **`ExecStart` runs `orcad-install.sh run`**, which resolves `orcad-current` to its real
  versioned directory and `exec`s the bundled runtime. The unit's main PID is orcad itself,
  and the daemon records the version directory it was forked from, which pruning keeps.
- **`RestartPreventExitStatus=78`.** 78 is orcad's configuration-fault exit (bind address,
  data root, instance lock). Restarting cannot fix it.
- **`Restart=always` with a 5-in-5-minutes start limit.** A crash or a clean exit comes
  back; a permanent fault stops instead of spinning. `systemctl --user reset-failed orcad`
  clears a tripped limit, and the installer does that before every start.
- **`TimeoutStartSec=180`.** The daemon launch retries on a cold host. It only matters once
  `Type=notify` is enabled.
- **`TimeoutStopSec=30`.** orcad's own graceful stop gives up after 15 seconds.
- **`KillMode=mixed`.** `SIGTERM` goes to orcad alone; whatever is left in the unit's cgroup
  is killed when it exits. Live terminals are **not** preserved by any `KillMode` — they are
  preserved because the daemon runs in its own `orca-daemon-*.scope`, outside this unit.
- **`Type=notify`, `NotifyAccess=all` and `WatchdogSec=` are commented out.** orcad sends
  `READY=1` and `WATCHDOG=1` through the `systemd-notify` binary from its own PID, so the unit
  needs `NotifyAccess=all` (see [systemd notify](./orcad-operations.md#who-supervises-orcad)).
  They stay optional because that path has not been exercised against a real systemd manager in
  CI; if the unit never leaves `activating`, keep `Type=simple` and probe `/readyz`.
- **Resource limits** are commented examples. Set them as `Environment=` lines, in `orcad.env`,
  or as `--limit <key>=<value>` in `ORCAD_EXTRA_ARGS` (see
  [Resource governance](./orcad-operations.md#resource-governance)). `Nice=` needs `LimitNICE=`
  so the daemon can reset each new terminal to nice 0.
- **`ORCAD_EXTRA_ARGS`** in `orcad.env` carries further orcad flags, split on whitespace — for
  example more `--pairing-address` values or `--pairing-expires 1h`.
- **No `UMask=`, no `NoNewPrivileges=`.** The daemon and every PTY inherit them, which would
  make files created in terminals private and break `sudo` inside them. orcad makes its data
  root `0700` itself.
- **Readiness goes to `$XDG_RUNTIME_DIR/orcad/readiness.json`**, not the journal. It holds the
  one `orca_server_ready` line, recreated on every start; stderr diagnostics stay in the
  journal (`journalctl --user -u orcad`). The line carries a pairing credential, so the
  directory is `0700` (`RuntimeDirectoryMode=0700`) and `orcad-install.sh run` creates the file
  `0600` before orcad writes to it.

Listener settings live in `~/.config/orcad/orcad.env` (`ORCAD_BIND`, `ORCAD_PORT`,
`ORCAD_PAIRING_ADDRESS`), which `service-install --bind/--port/--pairing-address` rewrites.

### Reach it from other devices

orcad binds `127.0.0.1` by default and accepts only literal IPs for `--bind` (see
[Bind policy](./orcad-operations.md#bind-policy)). Keep it that way on a public VPS and
choose one of:

- **SSH local forward (default, nothing exposed).** From the client:
  `ssh -N -L 6768:127.0.0.1:6768 you@vps`, then pair with the URL from
  `jq -r .pairing.url "$XDG_RUNTIME_DIR/orcad/readiness.json"` on the host. The pairing
  credential travels over SSH.
- **Tailscale (or another private overlay).** Bind the overlay address itself, not a
  wildcard, and advertise it:
  `sh orcad-install.sh service-install --bind 100.64.1.20 --pairing-address 100.64.1.20`,
  then `systemctl --user restart orcad`. Only tailnet peers can reach the port.

Never bind `0.0.0.0` on a host with a public interface. orcad logs a warning on every such
launch.

### Terminal survival

A service stop reaches every process in the unit's cgroup. Terminals survive it only when
the daemon launched itself through `systemd-run --user --scope` — which requires systemd as
PID 1, a reachable user bus and `systemd-run` on `PATH` (see
[Two long-lived processes, not one](./orcad-operations.md#two-long-lived-processes-not-one)).
`orcad-install.sh status` reads the daemon's own `/proc/<pid>/cgroup` and prints one of:

| Daemon state   | Meaning                                                          |
| -------------- | ---------------------------------------------------------------- |
| `isolated`     | every live daemon is in an `orca-daemon-*.scope`; stops are safe |
| `unscoped`     | a live daemon shares the unit's cgroup; a stop ends its PTYs     |
| `no-daemon`    | no recorded daemon is alive on this host                         |
| `unverifiable` | the cgroup could not be read (not Linux, torn record)            |

`health.terminalDaemon.cgroupUnit` in the readiness line reports the same fact.

### Upgrade and roll back

```bash
sh orcad-install.sh upgrade orcad-<new>-linux-x64-glibc.tar.gz
sh orcad-install.sh rollback
```

`activate` (and so `upgrade`) makes the same decisions as the SSH deploy, from the same
code:

1. **Stop safety.** If the daemon is `isolated`, stopping the unit is non-destructive.
   Otherwise the installer takes a fresh terminal census and applies the rule in
   [Running orcad](./orcad-operations.md#process-scoped-and-cgroup-wide-stops): the
   listing must be untruncated, carry a complete `hostScope`, and list no terminals. A
   missing, failed or incomplete census is `unverifiable` and the stop is refused.
   `--force` never overrides this.
2. **Update policy.** With the daemon preserved, live terminals still defer the update,
   because the host would run the new orcad against the old daemon until they exit.
   `--force` accepts that, and the outgoing version stays pinned while its daemon lives.
3. **Snapshot.** After the outgoing orcad has stopped, the data root's profile state is
   archived (the daemon's socket, token and PID record are never included).
4. **Switch and gate.** `orcad-current` is repointed and the unit started. The version is
   recorded active only after its readiness line proves the expected build hash, the unit's
   main PID, a bound endpoint, and a live daemon whose PTY self-test passed.
5. **Rejection.** A candidate that fails the gate is stopped. If it left profile state
   unchanged, the previous version is restarted; otherwise the service stays stopped with
   the snapshot retained, because an older build must not read state a newer one migrated.

`rollback` restores that snapshot and switches back to the recorded previous version. It
refuses when there is no previous version, the snapshot is gone, or terminals are live
that the snapshot predates.

The census comes from `ORCAD_CENSUS_COMMAND`, else `orca-ide`/`orca` on `PATH`, run as
`<command> terminal list --json` with `ORCA_USER_DATA_PATH` pointed at the data root so it
finds this orcad. A host with no Orca CLI has no census: an `isolated` host can still
upgrade with `--force`; an `unscoped` one cannot be stopped by the installer at all.

Exit codes: `0` done, `1` error, `2` usage, `20` refused by policy (nothing changed), `30`
the candidate failed its health gate.

Old versions are pruned after a successful activation. The active, previous, `orcad-current`
target, any version a live daemon was forked from, and incomplete installs are always kept;
`prune --dry-run` shows the rest.

### System service with a dedicated account

For a shared host, run orcad as its own account with root-owned, read-only versions:

```bash
sudo useradd --system --create-home --home-dir /var/lib/orca --shell /bin/bash orca
sudo loginctl enable-linger orca
export ORCAD_SERVICE=system ORCAD_SERVICE_USER=orca
sudo -E sh orcad-install.sh install orcad-<version>-linux-x64-glibc.tar.gz
sudo -E sh orcad-install.sh service-install
sudo -E sh orcad-install.sh activate <version>
```

Versions live in `/opt/orcad`, the data root is `/var/lib/orca/.orca`, the unit is
`/etc/systemd/system/orcad.service` with `User=orca`, and readiness is
`/run/orcad/readiness.json`. The daemon still escapes the unit through the `orca` account's
own user manager, which is why lingering is required. The census runs as `orca` via
`runuser`.

### Containers

`config/orcad-host/Dockerfile` builds an image from a verified release tarball:

```bash
docker build -f config/orcad-host/Dockerfile \
  --build-arg ORCAD_TARBALL=out/orcad-release/orcad-<version>-linux-x64-glibc.tar.gz -t orcad .
docker run -d --name orcad -p 127.0.0.1:6768:6768 -v orcad-data:/home/orca/.orca orcad
docker logs orcad | grep orca_server_ready
```

`tini` is PID 1, so exited PTY children are reaped, and `orcad-install.sh supervise`
restarts a crashed orcad beside the still-running daemon, which re-adopts every PTY.
Inside the container orcad binds `0.0.0.0` of the container's own network namespace; the
`-p 127.0.0.1:...` publish keeps it on the host's loopback.

**Daemon-scope caveat.** A container has no systemd user manager, so the daemon cannot get
its own scope (`cgroupUnit` is `null`). `docker stop`, `docker restart` and an image update
end the container's PID namespace and every terminal in it. Apply the census rule before
any of them.

### Remove it

```bash
sh orcad-install.sh uninstall              # keeps ~/.orca
sh orcad-install.sh uninstall --purge-data # also deletes the data root
```

Uninstall retires the daemon too, so it requires an empty census (or no live daemon)
regardless of scope isolation. It stops and removes the unit, stops the recorded daemon,
and deletes only orcad's entries under the install base; relay installs are untouched.

### Alongside the desktop's SSH deploy

The installer and the desktop's SSH deploy share the version directories and
`orcad-active.json`, so neither prunes the other's active or rollback version. They do not
share supervision: the SSH deploy stops the orcad recorded in a version directory's
`.orcad-pid`, which a systemd-managed install never writes, so an SSH deploy against a host
the installer manages refuses (`orcad_outgoing_stop_incomplete`) instead of fighting the
unit. Manage one account with one of them.

### Soak and chaos testing

`pnpm soak:orcad` (after `pnpm build:orcad && pnpm build:cli`) boots orcad on a throwaway
data root, runs heartbeat, throughput, full-screen redraw and echo terminals through a
paired client behind an in-process TCP fault proxy, and injects `kill -9` of orcad, a
frozen daemon, `SIGTERM` timing, restart under connected clients, link latency, partition
and reset, daemon death, and a long run that samples RSS and descriptors. It writes a JSON
report to `out/orcad-soak/`. The `orcad-soak` workflow runs it on Linux on demand.

## Legacy: Electron AppImage with Xvfb

The rest of this guide covers `orca serve` from the desktop AppImage. Prefer orcad for new
hosts.
Use this guide when you want to run `orca serve` on a Linux machine without a
desktop session, such as an Ubuntu VPS or a remote build box.

`orca serve` starts the Orca runtime without opening the desktop window. On
Linux, the packaged AppImage still needs the libraries that Electron expects at
startup. Current Orca builds start Xvfb automatically for `orca serve` when no
`DISPLAY` is set, but Xvfb must be installed first. A separate D-Bus session is
not required. When `DISPLAY` is set, Orca uses that display instead of starting
a competing Xvfb process, provided the display is usable: its socket must exist,
and if an X lock file is present it must name a running process. A `DISPLAY`
whose lock names a dead process is refused rather than replaced, and `orca serve`
exits — unset `DISPLAY` to let Orca start its own Xvfb. A socket published with
no lock at all (a container bind-mounting `/tmp/.X11-unix`, or WSLg) is accepted.

The supported deployment matrix covers Ubuntu 20.04, 22.04, and 24.04 and
current Debian stable — anything with glibc 2.31 or newer (see
[Linux glibc compatibility](./linux-glibc-compatibility.md)). Package names can
differ on other Debian-derived releases.

### Ubuntu and Debian prerequisites

Install the CLI tools, Xvfb, and the shared libraries Electron links against.
A minimal server or container image ships none of the Electron libraries, and
`orca serve` then fails before Electron starts:

```bash
sudo apt-get update
sudo apt-get install -y \
  curl file jq xvfb zlib1g-dev ca-certificates git \
  libgtk-3-0t64 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libgbm1 libasound2t64 \
  libxtst6 libcups2t64 libdrm2 libxkbcommon0 libpango-1.0-0 libcairo2 libatspi2.0-0t64 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxrender1 libx11-xcb1 \
  libxcb-dri3-0 libxss1
```

That command is for Ubuntu 24.04 and newer and Debian 13 and newer. Those
releases carried out the 64-bit `time_t` transition, which renamed six of the
packages with a `t64` suffix. On Ubuntu 20.04, Ubuntu 22.04, and Debian 12,
substitute the unsuffixed names:

- `libgtk-3-0t64` becomes `libgtk-3-0`
- `libatk1.0-0t64` becomes `libatk1.0-0`
- `libatk-bridge2.0-0t64` becomes `libatk-bridge2.0-0`
- `libasound2t64` becomes `libasound2`
- `libcups2t64` becomes `libcups2`
- `libatspi2.0-0t64` becomes `libatspi2.0-0`

The other names are identical on every supported release. The substitution is not
symmetric, so use the list that matches the release. A `t64` name on Ubuntu 20.04,
Ubuntu 22.04, or Debian 12 fails immediately with `E: Unable to locate package
libgtk-3-0t64`. In the other direction the old names mostly still resolve, because
each renamed package declares `Provides:` its unsuffixed name — except `libasound2`
on Ubuntu 24.04, where `liboss4-salsa-asound2` in `universe` claims that name too.
apt will not choose between two providers and exits with `E: Package 'libasound2'
has no installation candidate`, which aborts the entire install line and leaves none
of the libraries installed.

On Ubuntu 20.04 and 22.04, install `libfuse2` to execute the AppImage through
FUSE. On Ubuntu 24.04 and Debian 13 the package is `libfuse2t64`, though the plain
`libfuse2` name also resolves there because nothing else provides it. FUSE is
optional: without it, use the AppImage's supported extraction path. CLI
registration does this once automatically, so registered commands do not need
FUSE.

Download and make the AppImage executable:

```bash
sudo mkdir -p /opt/orca
sudo curl -L https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage \
  -o /opt/orca/orca-linux.AppImage
sudo chmod +x /opt/orca/orca-linux.AppImage
```

To extract it without FUSE, run the extraction as root because the installation
directory is root-owned:

```bash
cd /opt/orca
sudo ./orca-linux.AppImage --appimage-extract
sudo chmod -R a+rX /opt/orca/squashfs-root
/opt/orca/squashfs-root/AppRun serve --port 6768
```

The `chmod` is required whenever the extraction runs as a different user than
the server: `--appimage-extract` creates `squashfs-root` as `drwx------` owned by
the extracting user, so anyone else — including a dedicated service user — cannot
even traverse it, and the run fails before Electron starts.

Docker commonly has no FUSE device. Use `--appimage-extract` once or
`--appimage-extract-and-run`; neither requires a privileged container. The
extract-and-run wrapper can print extracted paths before Orca starts, so
automation that requires stdout to contain only the ready JSON should extract
once and invoke `squashfs-root/AppRun`.

If `Xvfb` was installed somewhere other than `/usr/bin`, confirm systemd can
find it later:

```bash
command -v Xvfb
```

### Run In The Foreground

Start with a foreground run before creating a service:

```bash
LIBGL_ALWAYS_SOFTWARE=1 /opt/orca/orca-linux.AppImage serve --port 6768
```

For remote clients, pass the address they should use to reach this server. A
Tailscale address is usually the safest option for private servers:

```bash
LIBGL_ALWAYS_SOFTWARE=1 /opt/orca/orca-linux.AppImage serve \
  --port 6768 \
  --pairing-address 100.64.1.20
```

`--pairing-address` is only the address advertised to clients. It does not
change the listener bind address. Orca binds its WebSocket listener, then
combines the actual bound port with the advertised host when the address omits
a port. Use a reachable LAN/Tailscale hostname or IP, or a complete reverse
proxy URL such as `https://orca.example.com/runtime` (`http(s)` is normalized
to `ws(s)`). Wildcard addresses such as `*`, `0.0.0.0`, and `::` cannot be
advertised.

The command writes one ready block to stdout after the listener bind and
pairing initialization complete:

```text
Orca server ready
Bound endpoint: ws://0.0.0.0:6768
Advertised endpoint: ws://100.64.1.20:6768
Pairing URL: orca://pair?code=...
```

For supervisors, request the versioned single-line JSON contract:

```bash
/opt/orca/orca-linux.AppImage serve --port 6768 \
  --pairing-address 100.64.1.20 --json
```

The actual output is one compact line; this example is pretty-printed for
readability:

```json
{
  "type": "orca_server_ready",
  "schemaVersion": 1,
  "runtimeId": "...",
  "endpoint": "ws://0.0.0.0:6768",
  "boundEndpoint": "ws://0.0.0.0:6768",
  "advertisedEndpoint": "ws://100.64.1.20:6768",
  "managedWslCliReconciliation": "settled",
  "pairing": {
    "available": true,
    "url": "orca://pair?code=...",
    "endpoint": "ws://100.64.1.20:6768",
    "deviceId": "...",
    "webClientUrl": "...",
    "scope": "runtime",
    "qr": null
  }
}
```

`endpoint` remains a compatibility alias for `boundEndpoint`; new automation
should use the explicit bound and advertised fields.

When the server remains usable but cannot mint an offer, `pairing` remains an
object with `available:false`, a stable `reason`, and operator `guidance`; it is
never silently omitted. `--recipe-json` is stricter and exits with that reason
because its contract requires a pairing URL. Stop a foreground server with
`Ctrl+C`. Stable reasons are `disabled_by_operator`, `websocket_unavailable`,
`device_registry_unavailable`, `e2ee_key_unavailable`, and
`invalid_advertised_endpoint`.

### Systemd Service

Create a dedicated service user and install directory. Run the service as this
user instead of root so the AppImage can keep Chromium's sandbox enabled. Keep
the install directory root-owned: the service needs to read and execute the
AppImage, but must not be able to replace it or the rollback artifacts.

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin orca
sudo chown root:root /opt/orca /opt/orca/orca-linux.AppImage
sudo chmod 755 /opt/orca /opt/orca/orca-linux.AppImage
# Only if you ran --appimage-extract: extraction leaves squashfs-root root-only.
sudo chmod -R a+rX /opt/orca/squashfs-root
```

The last line matters because the two halves of this guide combine badly without
it. `--appimage-extract` writes `squashfs-root` as `drwx------ root root`, so the
`orca` service user cannot read or traverse the extracted tree and the unit fails
at startup. `chmod 755 /opt/orca` alone does not reach into it.

For most hosts, one `orca serve` service is enough because Orca starts Xvfb on
display `:99` when no display exists:

```ini
# /etc/systemd/system/orca-serve.service
[Unit]
Description=Orca runtime server
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=orca
WorkingDirectory=/home/orca
Environment=LIBGL_ALWAYS_SOFTWARE=1
ExecStart=/opt/orca/orca-linux.AppImage serve --port 6768 --pairing-address 100.64.1.20
StandardOutput=journal
StandardError=journal
KillMode=mixed
Restart=on-failure
RestartPreventExitStatus=3
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace `100.64.1.20` with the LAN, Tailscale, tunnel, or public hostname that
clients should use.

`KillMode=mixed` sends the graceful stop signal only to Orca's main process,
then `SIGKILL`s whatever is still in the cgroup the instant that main process
exits — `TimeoutStopSec` only governs how long systemd waits for the main
process itself, never a grace window for the cgroup's remains. This lets Orca
keep its owned Xvfb alive until Electron disconnects cleanly.

The detached terminal daemon is preserved by a different mechanism: it is
launched through `systemd-run --user --scope`, so it and its PTYs live in their
own transient `orca-daemon-<launch-nonce>.scope` unit rather than in
`orca-serve.service`'s cgroup. A `systemctl stop` or `restart` of this unit
leaves that scope running, so live terminals and agent processes survive the
restart and the successor adopts them.

That requires a reachable systemd **user** manager for the service account.
With `User=orca` and no interactive login there is none by default, so enable
lingering once:

```bash
sudo loginctl enable-linger orca
```

Without it — or on a host without systemd as PID 1, or without `systemd-run`
on `PATH` — the daemon falls back to launching directly inside
`orca-serve.service`'s cgroup, and is then killed when the stop completes:
every `systemctl stop` or `restart` ends live terminals and agent processes,
even though their persisted layout and terminal history remain. Check which
case a running host is in with the `cgroupUnit` field of the daemon health
payload: a `orca-daemon-*.scope` value means isolated, `null` means the
unscoped fallback.

None of this applies inside a Docker container. There the capability probe
fails closed (no `/run/systemd/system`), but that is the least of it: a
`docker restart` tears down the container's PID namespace, so no in-container
setting — lingering, kill mode, or scope — preserves the daemon or its PTYs
across it. Run the container with `--init` so a real PID 1 reaps exited PTY
subprocesses; without it, Orca is PID 1 and those children accumulate as
zombies because nothing reaps them.

Exit status `3` means another process already owns this userData profile, so
`RestartPreventExitStatus=3` stops the unit instead of retrying a launch that
cannot succeed. Any other permanent startup fault is capped at 5 starts per
5 minutes; systemd's defaults (10s window, 5 starts) can never trip at
`RestartSec=5`, which is how one bad launch could restart thousands of times.
The start limit counts operator-initiated starts too, so once it trips systemd
refuses a plain `systemctl start` until the 5-minute window rolls over. Run
`sudo systemctl reset-failed orca-serve.service` first to clear it — the
[Upgrade](#upgrade-steps) and [Roll back](#roll-back) scripts already do.
On systemd older than 230 those two directives are spelled
`StartLimitInterval=`/`StartLimitBurst=` and belong in `[Service]`; Ubuntu
20.04, Orca's oldest supported base, ships systemd 245.

Enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orca-serve.service
sudo journalctl -u orca-serve.service -f
```

`journalctl -o cat` removes journal metadata but still mixes the service's
stdout and stderr. Parse each line as JSON and require the readiness type and
schema before treating the service as ready:

```bash
sudo journalctl -u orca-serve.service -o cat \
  | jq -Rrc 'fromjson? | select(.type == "orca_server_ready" and .schemaVersion == 1)'
```

A bounded health check should require that contract within its startup timeout;
otherwise inspect earlier diagnostics for the precise pairing reason, listener
error, or missing library.

### Managed Xvfb Service

If you prefer to own the virtual display lifecycle in systemd, run Xvfb as a
separate service and set `DISPLAY=:99` for Orca.

```ini
# /etc/systemd/system/orca-xvfb.service
[Unit]
Description=Virtual X display for Orca
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

If `command -v Xvfb` returned a different path, update `ExecStart` to that
absolute path.

Then add the display dependency to the Orca service:

```ini
# /etc/systemd/system/orca-serve.service
[Unit]
Description=Orca runtime server
After=network-online.target orca-xvfb.service
Wants=network-online.target orca-xvfb.service
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=orca
WorkingDirectory=/home/orca
Environment=DISPLAY=:99
Environment=LIBGL_ALWAYS_SOFTWARE=1
ExecStart=/opt/orca/orca-linux.AppImage serve --port 6768 --pairing-address 100.64.1.20
KillMode=mixed
Restart=on-failure
RestartPreventExitStatus=3
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`KillMode=mixed` matters as much here as in the single-service unit: without it
the unit silently defaults to `KillMode=control-group`, which `SIGTERM`s the
whole cgroup at once and then stalls the full `TimeoutStopSec` before the
`SIGKILL`.

Enable both units:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orca-xvfb.service orca-serve.service
```

### CLI Install Note

The registered Linux CLI command is `orca-ide`, not `orca`, to avoid shadowing
the GNOME Orca screen reader. Desktop-managed terminals receive a
terminal-scoped bare-`orca` shim. A packaged headless `orca serve` also makes a
best-effort dispatcher at `$HOME/.local/bin/orca` for the service user's own
shell, so the Claude Teams launcher can resolve its bare command; it does not
replace another user's `orca`. From an ordinary shell outside that service
user's managed environment, substitute `orca-ide` for `orca` in commands below.

On a headless host, you do not need to open the desktop UI just to run the
server. Invoke the AppImage directly:

```bash
/opt/orca/orca-linux.AppImage serve --help
```

Running an AppImage as root requires Chromium's `--no-sandbox` switch before
the command:

```bash
/opt/orca/orca-linux.AppImage --no-sandbox serve --port 6768
```

This disables a security boundary. Prefer a dedicated unprivileged service
user, especially when the listener is reachable beyond localhost.

The Linux CLI is named `orca-ide`, not `orca`, so it never shadows the GNOME
Orca screen reader at `/usr/bin/orca`. The `.deb` and `.rpm` packages put
`orca-ide` on `PATH` themselves at install time; with the AppImage it arrives
as `~/.local/bin/orca-ide` when the CLI is registered.

A packaged `orca serve` start also writes a bare `orca` into `~/.local/bin`
that execs the same launcher, which is why the skills commands below can be
typed as `orca`. It writes it while starting, so it is never the command that
starts the server — the first launch is `orca-ide serve`, or the AppImage
invoked directly as above. The write is best-effort: it is gated on a packaged
build, it is skipped when no bundled launcher resolves, and it is skipped when
a file Orca does not own already holds that name (ownership is a marker on the
second line of the file). A host that really does run the screen reader keeps
its own `orca`.

### Pairing troubleshooting

- A pairing offer is a capability containing a device credential and E2EE
  material. Share it only with the intended client and do not put it in proxy
  access logs.
- `boundEndpoint` is where the process listens; `advertisedEndpoint` is what a
  client dials. A valid-looking offer still cannot connect if DNS, firewall,
  Docker port publishing, Tailscale policy, or a reverse proxy does not route
  the advertised endpoint to the bound port.
- An omitted advertised port uses the actual bound port, including a fallback
  port selected after a collision. An explicit proxy port is preserved. A port
  mismatch therefore means the supplied external routing is wrong, not that
  Orca changes it.
- Reverse proxies must support WebSocket upgrade and route the advertised path.
  Use `wss://` or `https://` when TLS terminates at the proxy; do not advertise
  `ws://` through an HTTPS-only endpoint.
- Hostnames, IPv4, bracketed IPv6, and raw IPv6 literals are supported. IPv6
  still requires an IPv6-reachable listener/network path.
- Background push notifications to a paired phone fire from a headless server
  for "agent finished" and "agent needs input", derived from agent hook status
  (a finish is announced after a 1.5s quiet window). A pane with no hook status
  (hooks disabled, or an agent without managed hooks) produces none, and terminal
  bells are not pushed. The host's notification settings still apply: turning
  notifications off there also silences the phone.
- `xvfb-run` and `dbus-run-session -- xvfb-run` remain valid diagnostic launch
  shapes, but neither should be needed when `Xvfb` is installed and no display
  is configured. Repeated D-Bus messages without a ready block indicate startup
  did not reach serve mode; confirm the AppImage version and exact argument
  order, especially `--no-sandbox serve`.

If you later install the desktop CLI from Orca settings, use that CLI for normal
shell workflows. Keep the AppImage path in systemd so service restarts do not
depend on an interactive shell profile.

### Upgrade

`orca serve` never updates itself. In headless mode Orca wires up no auto-updater
at all — the built-in updater only runs in the desktop GUI, and no paired mobile
or web client can trigger it remotely. Upgrading is always a deliberate step:
replace the AppImage and restart the service.

Two facts make the persisted-state transition predictable:

- **State lives in the service user's home, not next to the binary.** Persisted
  data is under `/home/orca/.config/` (Orca uses both an `orca` and an `Orca`
  directory there), fully independent of `/opt/orca/orca-linux.AppImage`.
  Replacing the binary never touches projects, worktree metadata, terminal
  history, orchestration state, or paired-device keys — so mobile and web
  clients reconnect after an upgrade without re-pairing.
- **New builds migrate old state on load.** Orca loads older `orca-data.json`
  state into the current schema and writes it back in the current shape, so a
  forward upgrade needs no manual data step.

These guarantees preserve live processes only when the daemon is in its own
`orca-daemon-*.scope`, as reported by `health.terminalDaemon.cgroupUnit`. The
unscoped fallback remains destructive: a service restart kills every terminal
and agent in the service cgroup; an agent conversation may be resumable, but
its current process and any in-flight command are gone. Treat a stop as
destructive unless `health.terminalDaemon.cgroupUnit` names an
`orca-daemon-*.scope` on that host.

When `cgroupUnit` is `null` or unverifiable, immediately before stopping the
service, obtain a fresh census as the service's
OS account and home. Use the installer's absolute launcher path so `sudo`'s
`secure_path` cannot hide a per-user registration:
`sudo -Hu orca /home/orca/.local/bin/orca-ide terminal list --json`.
Replace both `orca` and `/home/orca` with the service account and home used by
your unit; for an extracted deployment, use its absolute `resources/bin/orca-ide`
launcher instead. Proceed only when the result is
untruncated, has an explicit `hostScope`, covers every execution host affected
by this service stop, and lists no terminals on those hosts. Every
`omittedHostIds` entry must be explicitly accounted for outside this service's
execution boundary. A separately paired runtime is outside that boundary; local
execution and SSH hosts reached through this runtime are not. An affected or
unknown omission, missing scope, failed request or lost connection is
`unverifiable`, so defer the restart. Do not allow new work between that census
and the stop; Orca does not yet provide an atomic census-and-stop fence.

Rolling back is the case that needs care — see [Roll back](#roll-back).

#### Record the version you deploy

The bundled CLI launcher prints the Orca build with `orca-ide --version`. For an
extracted deployment, that launcher is
`squashfs-root/resources/bin/orca-ide`; deb/rpm installs and CLI registration put
it on `PATH`. Do not use `orca-linux.AppImage --version` for this audit because
Electron owns the direct binary's version flags and may report its own runtime
version. For an AppImage service, choose a release tag explicitly and record it
next to the binary. The steps below keep that record in `/opt/orca/VERSION`.

#### Upgrade steps

Never download straight onto `/opt/orca/orca-linux.AppImage`. The AppImage is
FUSE-mounted, so overwriting it in place while the service runs can crash or
corrupt the live process — and even with the service stopped, a failed or partial
download would clobber the working binary. Instead download to a temporary name
on the same filesystem, verify it, then swap it in with an atomic rename.

Check capacity before starting:

```bash
sudo chown root:root /opt/orca
sudo chmod 755 /opt/orca
sudo test ! -L /opt/orca/orca-linux.AppImage
sudo chown root:root /opt/orca/orca-linux.AppImage
sudo chmod 755 /opt/orca/orca-linux.AppImage
# Clear predictable staging names left by an older attempt after locking the directory
sudo rm -f /opt/orca/orca-linux.AppImage.new /opt/orca/VERSION.new \
  /opt/orca/orca-linux.AppImage.recovering /opt/orca/VERSION.recovering
sudo du -sh /home/orca/.config
df -h /opt/orca /home/orca
```

`/opt/orca` needs room for the compressed Orca profile archive, the staged
build, and the rollback binary. A rollback extracts the old profile and preserves
the post-upgrade Orca profile directories, so `/home` needs room for both copies.

Run the following block as one Bash script so its fail-fast and recovery traps
remain active for the whole operation:

```bash
set -euo pipefail

# Replace this example with the release tag you intend to deploy
ORCA_VERSION=v1.4.147

# Select the release asset on the server where Orca runs
case "$(uname -m)" in
  x86_64)
    ORCA_ASSET=orca-linux.AppImage
    ORCA_FILE_MACHINE=x86-64
    ;;
  aarch64 | arm64)
    ORCA_ASSET=orca-linux-arm64.AppImage
    ORCA_FILE_MACHINE='ARM aarch64'
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

ORCA_ROLLBACK_NEW=
ORCA_ROLLBACK=
ORCA_SERVICE_STOPPED=0
ORCA_BINARY_PROMOTED=0
recover_failed_upgrade() {
  exit_status=$?
  trap - EXIT
  set +e
  if ((exit_status != 0)); then
    sudo rm -f /opt/orca/orca-linux.AppImage.new /opt/orca/VERSION.new \
      /opt/orca/orca-linux.AppImage.recovering /opt/orca/VERSION.recovering
  fi
  if ((exit_status != 0)) && [[ -n "$ORCA_ROLLBACK_NEW" ]] && \
    sudo test -d "$ORCA_ROLLBACK_NEW"; then
    sudo rm -rf -- "$ORCA_ROLLBACK_NEW"
  fi
  if ((exit_status != 0 && ORCA_SERVICE_STOPPED)); then
    recovery_ok=1
    if ((ORCA_BINARY_PROMOTED)); then
      if ! sudo cp -a "$ORCA_ROLLBACK/orca-linux.AppImage" \
        /opt/orca/orca-linux.AppImage.recovering || \
        ! sudo mv -f /opt/orca/orca-linux.AppImage.recovering \
          /opt/orca/orca-linux.AppImage; then
        recovery_ok=0
      fi
      if sudo test -f "$ORCA_ROLLBACK/VERSION"; then
        if ! sudo cp -a "$ORCA_ROLLBACK/VERSION" /opt/orca/VERSION.recovering || \
          ! sudo mv -f /opt/orca/VERSION.recovering /opt/orca/VERSION; then
          recovery_ok=0
        fi
      elif ! sudo rm -f /opt/orca/VERSION; then
        recovery_ok=0
      fi
    fi
    sudo rm -f /opt/orca/orca-linux.AppImage.recovering \
      /opt/orca/VERSION.recovering
    if ((recovery_ok)); then
      # A tripped StartLimitBurst refuses a plain start
      sudo systemctl reset-failed orca-serve.service || true
      sudo systemctl start orca-serve.service || true
    else
      echo 'Upgrade recovery failed; service remains stopped' >&2
    fi
  fi
  exit "$exit_status"
}
trap recover_failed_upgrade EXIT

# 1. Stage and verify the new build while the server stays online
sudo curl -fL --retry 3 "https://github.com/stablyai/orca/releases/download/${ORCA_VERSION}/${ORCA_ASSET}" \
  -o /opt/orca/orca-linux.AppImage.new
sudo chown root:root /opt/orca/orca-linux.AppImage.new
sudo chmod 755 /opt/orca/orca-linux.AppImage.new

# Both checks must match; either grep stops this fail-fast block otherwise
ORCA_FILE_INFO=$(LC_ALL=C file /opt/orca/orca-linux.AppImage.new)
grep 'ELF .* executable' <<<"$ORCA_FILE_INFO"
grep -F "$ORCA_FILE_MACHINE" <<<"$ORCA_FILE_INFO"

# 2. Assemble the prior binary and version in a root-only rollback bundle
ORCA_ROLLBACK_BASE=/opt/orca/orca-rollback-$(date +%F-%H%M%S-%N)
ORCA_ROLLBACK_NEW=${ORCA_ROLLBACK_BASE}.new
ORCA_ROLLBACK=${ORCA_ROLLBACK_BASE}.ready
sudo install -d -m 700 "$ORCA_ROLLBACK_NEW"
sudo cp -a /opt/orca/orca-linux.AppImage "$ORCA_ROLLBACK_NEW/orca-linux.AppImage"
if sudo test -f /opt/orca/VERSION; then
  sudo cp -a /opt/orca/VERSION "$ORCA_ROLLBACK_NEW/VERSION"
fi

# Stage the new version record before the stop window
printf '%s\n' "$ORCA_VERSION" | sudo tee /opt/orca/VERSION.new >/dev/null
sudo chown root:root /opt/orca/VERSION.new
sudo chmod 644 /opt/orca/VERSION.new

# 3. Stop the server so the profile backup is consistent
ORCA_SERVICE_STOPPED=1
sudo systemctl stop orca-serve.service

# Add only Orca-owned profile directories, then publish the complete bundle
ORCA_PROFILE_DIRS=()
for profile_dir in orca Orca; do
  if sudo test -L "/home/orca/.config/$profile_dir"; then
    echo "Refusing symlinked Orca profile: /home/orca/.config/$profile_dir" >&2
    exit 1
  fi
  if sudo test -d "/home/orca/.config/$profile_dir"; then
    if [[ "$profile_dir" == Orca ]] && \
      sudo test /home/orca/.config/orca -ef /home/orca/.config/Orca; then
      continue
    fi
    ORCA_PROFILE_DIRS+=("$profile_dir")
  fi
done
if ((${#ORCA_PROFILE_DIRS[@]} == 0)); then
  echo 'No Orca profile directory found under /home/orca/.config' >&2
  exit 1
fi
sudo tar czf "$ORCA_ROLLBACK_NEW/profile.tgz" \
  -C /home/orca/.config "${ORCA_PROFILE_DIRS[@]}"
sudo chmod 600 "$ORCA_ROLLBACK_NEW/profile.tgz"
sudo mv "$ORCA_ROLLBACK_NEW" "$ORCA_ROLLBACK"

# 4. Atomically replace the binary and version record, then start
ORCA_BINARY_PROMOTED=1
sudo mv -f /opt/orca/orca-linux.AppImage.new /opt/orca/orca-linux.AppImage
sudo mv -f /opt/orca/VERSION.new /opt/orca/VERSION
# Clears a start-limit hit left by the version being replaced
sudo systemctl reset-failed orca-serve.service
sudo systemctl start orca-serve.service
ORCA_SERVICE_STOPPED=0
trap - EXIT
```

The profile archive created in step 3 captures both Orca profile directory names
when present without rewinding unrelated tools under `/home/orca/.config`. The
`.ready` suffix is published only after the prior binary, version record, and
profile archive are complete. If you run the managed Xvfb unit, only
`orca-serve.service` needs restarting — leave `orca-xvfb.service` running.

#### Verify

```bash
sudo journalctl -u orca-serve.service -f
```

A healthy start prints one `Orca server ready` block with the actual bound and
advertised endpoints. Verify those values rather than assuming the configured
port, because a collision can select a fallback port.
Confirm a client reconnects before you discard the backup. The timestamped
rollback bundles are not pruned automatically. After the new version satisfies
your retention policy, select and inspect the newest complete bundle before
removing it:

```bash
shopt -s nullglob
ORCA_ROLLBACK_SETS=(/opt/orca/orca-rollback-*.ready)
((${#ORCA_ROLLBACK_SETS[@]} > 0))
ORCA_ROLLBACK=${ORCA_ROLLBACK_SETS[${#ORCA_ROLLBACK_SETS[@]} - 1]}
printf 'Removing rollback bundle: %s\n' "$ORCA_ROLLBACK"
sudo test -d "$ORCA_ROLLBACK"
sudo rm -rf -- "$ORCA_ROLLBACK"
```

Each `.ready` directory is a self-contained rollback generation; never combine
files from different bundles.

#### Roll back

A rollback is **not** binary-only safe. Once a newer build has started, it can
rewrite `orca-data.json` in the current schema. If an older build then writes
that file, it can discard fields it does not recognize. The rolling
`orca-data.json.bak.*` files are corruption-recovery snapshots, not a dedicated
pre-upgrade copy, and normal writes can rotate them away. To roll back cleanly,
restore the backup from step 3 **and** swap the binary back. Run this block as one
Bash script:

```bash
set -euo pipefail

# Select and validate one complete generation before taking the service offline
shopt -s nullglob
ORCA_ROLLBACK_SETS=(/opt/orca/orca-rollback-*.ready)
((${#ORCA_ROLLBACK_SETS[@]} > 0))
ORCA_ROLLBACK=${ORCA_ROLLBACK_SETS[${#ORCA_ROLLBACK_SETS[@]} - 1]}
sudo test -f "$ORCA_ROLLBACK/orca-linux.AppImage"
sudo tar tzf "$ORCA_ROLLBACK/profile.tgz" >/dev/null

# Extract and validate the old profile while the current server stays online
sudo test ! -L /home
ORCA_HOME_OWNER=$(sudo stat -c %u /home)
ORCA_HOME_MODE=$(sudo stat -c %a /home)
if [[ "$ORCA_HOME_OWNER" != 0 ]] || ((8#$ORCA_HOME_MODE & 0022)) || \
  sudo -u orca test -w /home; then
  echo 'Refusing rollback because /home is not root-controlled' >&2
  exit 1
fi
ORCA_RESTORE=$(sudo mktemp -d /home/.orca-restore.XXXXXX)
ORCA_SERVICE_STOPPED=0
ORCA_MOVED_CURRENT_DIRS=()
ORCA_INSTALLED_RESTORE_DIRS=()
ORCA_CURRENT_BINARY_MOVED=0
ORCA_CURRENT_VERSION_MOVED=0
ORCA_VERSION_REPLACEMENT_STARTED=0
ORCA_POST_UPGRADE=
ORCA_ROLLBACK_BINARY_STAGED=
ORCA_ROLLBACK_VERSION_STAGED=
ORCA_ROLLBACK_HAS_VERSION=0
restart_after_rollback_error() {
  exit_status=$?
  trap - EXIT
  set +e
  if ((exit_status != 0 && ORCA_SERVICE_STOPPED)); then
    recovery_ok=1
    if ((${#ORCA_INSTALLED_RESTORE_DIRS[@]})); then
      for profile_dir in "${ORCA_INSTALLED_RESTORE_DIRS[@]}"; do
        if sudo test -d "/home/orca/.config/$profile_dir"; then
          if ! sudo mv "/home/orca/.config/$profile_dir" \
            "$ORCA_RESTORE/$profile_dir.failed"; then
            recovery_ok=0
          fi
        fi
      done
    fi
    if ((${#ORCA_MOVED_CURRENT_DIRS[@]})); then
      for profile_dir in "${ORCA_MOVED_CURRENT_DIRS[@]}"; do
        if sudo test -d "$ORCA_POST_UPGRADE/$profile_dir"; then
          if ! sudo mv "$ORCA_POST_UPGRADE/$profile_dir" /home/orca/.config/; then
            recovery_ok=0
          fi
        elif ! sudo test -d "/home/orca/.config/$profile_dir"; then
          recovery_ok=0
        fi
      done
    fi
    if [[ -n "$ORCA_POST_UPGRADE" ]]; then
      sudo rmdir "$ORCA_POST_UPGRADE" 2>/dev/null || true
    fi
    if ((ORCA_CURRENT_BINARY_MOVED)); then
      if sudo test -f "$ORCA_CURRENT_BINARY"; then
        if ! sudo mv -f "$ORCA_CURRENT_BINARY" /opt/orca/orca-linux.AppImage; then
          recovery_ok=0
        fi
      elif ! sudo test -f /opt/orca/orca-linux.AppImage; then
        recovery_ok=0
      fi
    fi
    if ((ORCA_CURRENT_VERSION_MOVED)); then
      if sudo test -f "$ORCA_CURRENT_VERSION"; then
        if ! sudo mv -f "$ORCA_CURRENT_VERSION" /opt/orca/VERSION; then
          recovery_ok=0
        fi
      elif ! sudo test -f /opt/orca/VERSION; then
        recovery_ok=0
      fi
    elif ((ORCA_VERSION_REPLACEMENT_STARTED)); then
      if ! sudo rm -f /opt/orca/VERSION; then
        recovery_ok=0
      fi
    fi
    if ((recovery_ok)); then
      # A tripped StartLimitBurst refuses a plain start
      sudo systemctl reset-failed orca-serve.service || true
      sudo systemctl start orca-serve.service || true
    else
      echo 'Rollback recovery failed; service remains stopped' >&2
    fi
  fi
  if [[ -n "$ORCA_ROLLBACK_BINARY_STAGED" ]]; then
    sudo rm -f -- "$ORCA_ROLLBACK_BINARY_STAGED"
  fi
  if [[ -n "$ORCA_ROLLBACK_VERSION_STAGED" ]]; then
    sudo rm -f -- "$ORCA_ROLLBACK_VERSION_STAGED"
  fi
  sudo rm -rf -- "$ORCA_RESTORE"
  exit "$exit_status"
}
trap restart_after_rollback_error EXIT

if [[ "$(sudo stat -c %d "$ORCA_RESTORE")" != \
  "$(sudo stat -c %d /home/orca/.config)" ]]; then
  echo 'Refusing rollback because staging and the Orca profile are on different filesystems' >&2
  exit 1
fi
sudo tar xzf "$ORCA_ROLLBACK/profile.tgz" -C "$ORCA_RESTORE"
ORCA_RESTORE_DIRS=()
for profile_dir in orca Orca; do
  if sudo test -L "$ORCA_RESTORE/$profile_dir"; then
    echo "Rollback bundle contains a symlinked profile: $profile_dir" >&2
    exit 1
  fi
  if sudo test -d "$ORCA_RESTORE/$profile_dir"; then
    if [[ "$profile_dir" == Orca ]] && \
      sudo test "$ORCA_RESTORE/orca" -ef "$ORCA_RESTORE/Orca"; then
      continue
    fi
    ORCA_RESTORE_DIRS+=("$profile_dir")
  fi
done
if ((${#ORCA_RESTORE_DIRS[@]} == 0)); then
  echo "Rollback bundle has no Orca profile directories: $ORCA_ROLLBACK" >&2
  exit 1
fi
for profile_dir in "${ORCA_RESTORE_DIRS[@]}"; do
  sudo chown -R orca:orca "$ORCA_RESTORE/$profile_dir"
done

ORCA_ROLLBACK_STAMP=$(date +%F-%H%M%S-%N)
ORCA_ROLLBACK_BINARY_STAGED=/opt/orca/orca-linux.AppImage.rollback-staged-$ORCA_ROLLBACK_STAMP
sudo cp -a "$ORCA_ROLLBACK/orca-linux.AppImage" "$ORCA_ROLLBACK_BINARY_STAGED"
if sudo test -f "$ORCA_ROLLBACK/VERSION"; then
  ORCA_ROLLBACK_HAS_VERSION=1
  ORCA_ROLLBACK_VERSION_STAGED=/opt/orca/VERSION.rollback-staged-$ORCA_ROLLBACK_STAMP
  sudo cp -a "$ORCA_ROLLBACK/VERSION" "$ORCA_ROLLBACK_VERSION_STAGED"
fi

ORCA_SERVICE_STOPPED=1
sudo systemctl stop orca-serve.service

# Preserve and replace only Orca-owned profile directories
ORCA_CURRENT_DIRS=()
for profile_dir in orca Orca; do
  if sudo test -L "/home/orca/.config/$profile_dir"; then
    echo "Refusing symlinked Orca profile: /home/orca/.config/$profile_dir" >&2
    exit 1
  fi
  if sudo test -d "/home/orca/.config/$profile_dir"; then
    if [[ "$profile_dir" == Orca ]] && \
      sudo test /home/orca/.config/orca -ef /home/orca/.config/Orca; then
      continue
    fi
    ORCA_CURRENT_DIRS+=("$profile_dir")
  fi
done
ORCA_POST_UPGRADE=/home/orca/.config/orca-rollback-$ORCA_ROLLBACK_STAMP
sudo install -d -o orca -g orca -m 700 "$ORCA_POST_UPGRADE"
if ((${#ORCA_CURRENT_DIRS[@]})); then
  for profile_dir in "${ORCA_CURRENT_DIRS[@]}"; do
    ORCA_MOVED_CURRENT_DIRS+=("$profile_dir")
    sudo mv "/home/orca/.config/$profile_dir" "$ORCA_POST_UPGRADE/"
  done
fi
for profile_dir in "${ORCA_RESTORE_DIRS[@]}"; do
  ORCA_INSTALLED_RESTORE_DIRS+=("$profile_dir")
  sudo mv "$ORCA_RESTORE/$profile_dir" /home/orca/.config/
done

ORCA_CURRENT_BINARY=/opt/orca/orca-linux.AppImage.rollback-current-$ORCA_ROLLBACK_STAMP
ORCA_CURRENT_BINARY_MOVED=1
sudo mv /opt/orca/orca-linux.AppImage "$ORCA_CURRENT_BINARY"
sudo mv -f "$ORCA_ROLLBACK_BINARY_STAGED" /opt/orca/orca-linux.AppImage

ORCA_CURRENT_VERSION=/opt/orca/VERSION.rollback-current-$ORCA_ROLLBACK_STAMP
if sudo test -f /opt/orca/VERSION; then
  ORCA_CURRENT_VERSION_MOVED=1
  sudo mv /opt/orca/VERSION "$ORCA_CURRENT_VERSION"
fi
ORCA_VERSION_REPLACEMENT_STARTED=1
if ((ORCA_ROLLBACK_HAS_VERSION)); then
  sudo mv -f "$ORCA_ROLLBACK_VERSION_STAGED" /opt/orca/VERSION
else
  sudo rm -f /opt/orca/VERSION
fi
# The crash-looping build you are rolling back from tripped StartLimitBurst
sudo systemctl reset-failed orca-serve.service
sudo systemctl start orca-serve.service
ORCA_SERVICE_STOPPED=0
sudo rm -rf -- "$ORCA_RESTORE"
trap - EXIT
```

Restoring the backup is required, not optional: swapping only the binary leaves
the newer `orca-data.json` in place, where an older build can discard state it
does not understand. Keep the pre-upgrade backup until the new version is proven
on your host. The `orca-rollback-*` directory inside `.config` is also retained
deliberately. The post-upgrade binary and version record are retained in
`/opt/orca` with the same `rollback-current-<timestamp>` suffix. Inspect these
artifacts and remove them according to your retention policy after the rollback
is resolved.

### Troubleshooting

- `dlopen(): error loading libfuse.so.2`: install `libfuse2`.
- `Missing X server or $DISPLAY`: install `xvfb`, or start the managed Xvfb
  service and set `DISPLAY=:99`.
- `[serve] Xvfb failed to start` or `[serve] Could not start Xvfb`: confirm
  `command -v Xvfb` and that it is on the service `PATH`.
- GPU or DRI warnings on a VPS: keep `LIBGL_ALWAYS_SOFTWARE=1` in the service
  environment.
- Chromium sandbox errors: confirm the service is running as the non-root
  `orca` user and that `/opt/orca` is readable by that user, including
  `/opt/orca/squashfs-root` if you extracted the AppImage.
- Clients cannot connect: make sure `--pairing-address` is an address reachable
  from the client, and make sure firewalls allow the selected `--port`.
- Journal shows `Another Orca instance is already running for this userData
profile` and the unit exits `3`: another process already owns the profile, so
  `RestartPreventExitStatus=3` leaves the unit `failed` on purpose. Find the
  owner with `systemctl status orca-serve` and `pgrep -af orca`. Stop it (or
  keep it and leave the unit down), then run
  `sudo systemctl reset-failed orca-serve && sudo systemctl start orca-serve` —
  `reset-failed` clears the failed state and any start-limit counter. If no owner
  exists, the lock is stale (Chromium recorded a pid that
  has since been reused): remove `SingletonLock` and `SingletonSocket` from the
  userData directory and start again. If an earlier crash-loop already leaked
  AppImage mounts, list them with `findmnt -rn -t fuse.orca-linux.AppImage` and
  release only the ones with no live owner using `fusermount -uz <target>` (or
  `umount -l <target>`), leaving the running instance's mount alone.
- Service crash-loops right after an upgrade: use [Roll back](#roll-back) with
  the pre-upgrade `.ready` bundle. Do not rerun the upgrade first; doing so would
  make the crashing version the next rollback binary. The loop trips
  `StartLimitBurst`, so any manual `systemctl start` outside that script needs
  `sudo systemctl reset-failed orca-serve.service` first.
- Diagnosing other missing libraries: extract the AppImage without launching it
  with `./orca-linux.AppImage --appimage-extract`, then run
  `ldd squashfs-root/orca-ide` to list any shared libraries the host is missing.
  The Electron binary is `orca-ide`, not `orca`; `ldd` on a path that does not
  exist prints nothing and exits cleanly, which reads as a clean result in
  exactly the situation where you are hunting a missing library.

## Installing Agent Skills Without A Desktop

Orca's agent skills (CLI usage, orchestration, computer use, etc.) are normally
installed from Orca Settings, which pre-fills an `npx skills add ... --global`
command in a terminal for you to run. A headless host has no Settings UI, so
use `orca skills install` instead:

```bash
orca skills install                                      # list installable skills
orca skills install --skill orca-cli --skill orchestration # install globally (default)
orca skills install --skill orca-cli --local              # install into the current project only
orca skills install --all                                 # install every bundled skill
orca skills install --all --dry-run                       # print the npx command without running it
```

This resolves the same `npx skills add <repo> --skill <name> ...` command
Settings would show you (adding `--global` unless `--local` is passed), then
runs it and forwards its output and exit code. It requires `node`/`npx` on the
host; it does not need a running Orca runtime.

Unlike the command Settings shows, the spawned one adds `npx --yes` and `-y`.
Without them the `skills` CLI opens an interactive agent picker and blocks
forever on any allocated TTY — which includes a normal `ssh` session. Use
`--dry-run` to see the exact command that will run.

Settings keeps that picker deliberately, because choosing which agents get a
skill is a real decision. A headless run cannot answer it, so instead of dropping
the choice Orca makes it explicitly: it passes an `--agent` list built from the
coding agents it detects on the host, plus the shared `.agents/skills` directory
it reads itself. Left to decide on its own with no agent detected, the `skills`
CLI installs into all ~75 agents it knows and leaves a config directory for each.
Override the targets yourself, or narrow to the shared directory alone:

```bash
orca skills install --skill orca-cli --agent claude-code,codex
orca skills install --skill orca-cli --agent universal
```

If Orca detects no agent at all, `orca skills install` stops and asks for
`--agent` rather than guessing.

To refresh already-installed skills, `orca skills update` mirrors the same
selection flags (`--skill`, `--all`, `--local`, `--dry-run`) and resolves to
`npx skills update <names...>` with a matching scope flag — `--global`, or
`--project` when you pass `--local`:

```bash
orca skills update --all                                  # update every bundled skill globally
orca skills update --skill orca-cli --dry-run             # print the npx command without running it
```

`orca skills update` only refreshes skills that are already installed — it exits
0 without doing anything for a skill that is missing, so install it first. More
generally, a 0 exit means the `skills` CLI ran without erroring, not that it
wrote anything; read its output to confirm what changed.

`--json` covers the skill listing and `--dry-run`. A real run streams the
`skills` CLI's own non-JSON output and rejects `--json`.

Both commands install onto the machine that runs them. In an Orca SSH workspace
or the WSL bridge the `orca` shim forwards commands to the Orca host, so they
refuse to run there and print the command to run on the machine you want.
