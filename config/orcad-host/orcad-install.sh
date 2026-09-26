#!/bin/sh
# Install, activate, roll back and remove orcad on a self-managed Linux host.
#
# Layout (same versioned-dir model as the SSH deploy, so both read one activation record):
#   $ORCAD_BASE/orcad-<fullVersion>/   immutable install, published by atomic rename
#   $ORCAD_BASE/orcad-current          symlink the service starts through
#   $ORCAD_BASE/orcad-active.json      activation record (active / previous / snapshot)
#   $ORCAD_BASE/orcad-state-snapshots/ pre-activation copies of the data root
#
# Every decision about live terminals, activation health, snapshots and rollback is made by
# orcad-host-install.js (bundled from the SSH deploy's own policy code) running under the
# install's bundled Bun. This script only moves files and drives the service manager.
# Reference: docs/reference/headless-linux-server.md
set -eu

ORCAD_SERVICE=${ORCAD_SERVICE:-user}
ORCAD_UNIT=${ORCAD_UNIT:-orcad.service}
ORCAD_SERVICE_USER=${ORCAD_SERVICE_USER:-}
if [ "$ORCAD_SERVICE" = system ]; then
  # Root-owned versions the service cannot rewrite; state in the service account's home.
  : "${ORCAD_SERVICE_USER:=orca}"
  service_home=$(getent passwd "$ORCAD_SERVICE_USER" 2>/dev/null | cut -d : -f 6 || true)
  : "${ORCAD_BASE:=/opt/orcad}"
  : "${ORCA_USER_DATA:=${service_home:-/var/lib/orca}/.orca}"
else
  : "${ORCAD_BASE:=$HOME/.orca-remote}"
  : "${ORCA_USER_DATA:=$HOME/.orca}"
fi
ORCAD_READY_TIMEOUT=${ORCAD_READY_TIMEOUT:-180}
ORCAD_CENSUS_COMMAND=${ORCAD_CENSUS_COMMAND:-}
ORCAD_SYSTEMCTL=${ORCAD_SYSTEMCTL:-systemctl}

EXIT_REFUSED=20
EXIT_REJECTED=30
LOCK_DIR=
WORK_DIR=

say() { printf 'orcad-install: %s\n' "$*" >&2; }
die() {
  say "$*"
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: orcad-install.sh <command> [options]

  install <tarball> [--sha256 HEX | --sha256-file FILE]   verify, then install a version
  activate <fullVersion> [--force]                        switch the service to an installed version
  upgrade <tarball> [--sha256 ...] [--force]              install + activate
  rollback                                                return to the previous version
  status                                                  record, link, service, daemon isolation
  prune [--dry-run]                                       delete versions nothing needs
  service-install [--port N] [--bind IP]                  write and enable the systemd unit
  uninstall [--purge-data]                                stop and remove (census-gated)
  run | supervise                                         start orcad in the foreground

Environment: ORCAD_BASE ORCA_USER_DATA ORCAD_SERVICE(user|system|none) ORCAD_UNIT
             ORCAD_SERVICE_USER ORCAD_CENSUS_COMMAND ORCAD_READY_TIMEOUT
EOF
  exit 2
}

cleanup() {
  if [ -n "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi
  if [ -n "$LOCK_DIR" ]; then rm -rf "$LOCK_DIR"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ---- primitives ----------------------------------------------------------------------------

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | sed 's/^.*= *//'
  else
    die 'no sha256 tool (sha256sum, shasum or openssl) is available'
  fi
}

host_target() {
  case "$(uname -s)" in
    Linux) host_os=linux ;;
    Darwin) host_os=darwin ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) host_arch=x64 ;;
    aarch64 | arm64) host_arch=arm64 ;;
    *) die "unsupported CPU: $(uname -m)" ;;
  esac
  if [ "$host_os" != linux ]; then
    echo "$host_os-$host_arch"
  elif { ldd --version 2>&1 || true; } | grep -qi musl; then
    echo "linux-$host_arch-musl"
  else
    echo "linux-$host_arch-glibc"
  fi
}

is_full_version() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\+[0-9a-f]+$'
}

version_dir() { printf '%s/orcad-%s\n' "$ORCAD_BASE" "$1"; }

take_lock() {
  mkdir -p "$ORCAD_BASE"
  chmod 700 "$ORCAD_BASE" 2>/dev/null || true
  lock="$ORCAD_BASE/.orcad-host-install.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    holder=$(cat "$lock/pid" 2>/dev/null || true)
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      die "another orcad-install (pid $holder) holds $lock"
    fi
    # A dead holder's lock is reclaimed; an unreadable one is not guessed at.
    [ -n "$holder" ] || die "$lock exists with no owner; remove it once no install is running"
    rm -rf "$lock"
    mkdir "$lock" || die "could not take $lock"
  fi
  echo $$ >"$lock/pid"
  LOCK_DIR=$lock
}

make_work_dir() {
  WORK_DIR=$(mktemp -d "$ORCAD_BASE/.orcad-work.XXXXXX")
}

# Run a policy verb from an installed version's bundled runtime. Prints its JSON line.
policy() {
  policy_dir=$1
  shift
  "$policy_dir/bun-runtime" "$policy_dir/orcad-host-install.js" "$@"
}

json_field() {
  # First occurrence of a string field in one compact JSON line; policy emits its own
  # decision fields before any nested detail.
  printf '%s\n' "$2" | awk -v key="\"$1\":\"" '{
    at = index($0, key)
    if (at) { value = substr($0, at + length(key)); sub(/".*/, "", value); print value; exit }
  }'
}

# ---- service manager ------------------------------------------------------------------------

svc() {
  case "$ORCAD_SERVICE" in
    user) "$ORCAD_SYSTEMCTL" --user "$@" ;;
    system) "$ORCAD_SYSTEMCTL" "$@" ;;
    none) return 0 ;;
    *) die "ORCAD_SERVICE must be user, system or none (got $ORCAD_SERVICE)" ;;
  esac
}

service_running() {
  [ "$ORCAD_SERVICE" != none ] && svc is-active --quiet "$ORCAD_UNIT"
}

readiness_file() {
  if [ -n "${ORCAD_READINESS_FILE:-}" ]; then
    echo "$ORCAD_READINESS_FILE"
  elif [ "$ORCAD_SERVICE" = system ]; then
    echo /run/orcad/readiness.json
  else
    echo "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/orcad/readiness.json"
  fi
}

stop_service() {
  svc stop "$ORCAD_UNIT"
  waited=0
  while svc is-active --quiet "$ORCAD_UNIT"; do
    [ "$waited" -lt 60 ] || die "$ORCAD_UNIT did not stop within 60s; nothing was changed"
    sleep 1
    waited=$((waited + 1))
  done
}

start_service() {
  rm -f "$(readiness_file)"
  svc reset-failed "$ORCAD_UNIT" 2>/dev/null || true
  svc start "$ORCAD_UNIT"
}

# Poll the service's readiness line through the activation gate for one version.
await_gate() {
  gate_version=$1
  gate_dir=$(version_dir "$gate_version")
  deadline=$(($(date +%s) + ORCAD_READY_TIMEOUT))
  while :; do
    main_pid=$(svc show -p MainPID --value "$ORCAD_UNIT" 2>/dev/null || echo 0)
    if gate_out=$(policy "$gate_dir" gate --base "$ORCAD_BASE" --candidate "$gate_version" \
      --readiness "$(readiness_file)" --main-pid "${main_pid:-0}"); then
      printf '%s\n' "$gate_out"
      return 0
    fi
    case "$gate_out" in
      *'"code":"orcad_activation_no_readiness"'*)
        if [ "$(date +%s)" -lt "$deadline" ] && svc is-active --quiet "$ORCAD_UNIT"; then
          sleep 1
          continue
        fi
        ;;
    esac
    printf '%s\n' "$gate_out"
    return 1
  done
}

# ---- census ---------------------------------------------------------------------------------

default_census_command() {
  for candidate in orca-ide orca "$HOME/.local/bin/orca-ide"; do
    if command -v "$candidate" >/dev/null 2>&1; then
      echo "$candidate terminal list --json"
      return 0
    fi
  done
  return 1
}

# Write a fresh terminal census to $1. No command, or a failing one, leaves it empty:
# the policy then reads the census as unverifiable, never as "no terminals".
take_census() {
  : >"$1"
  census_cmd=$ORCAD_CENSUS_COMMAND
  [ -n "$census_cmd" ] || census_cmd=$(default_census_command) || {
    say 'no terminal census command found (set ORCAD_CENSUS_COMMAND); census is unverifiable'
    return 0
  }
  if [ -n "$ORCAD_SERVICE_USER" ] && [ "$(id -u)" = 0 ]; then
    runuser -u "$ORCAD_SERVICE_USER" -- env ORCA_USER_DATA_PATH="$ORCA_USER_DATA" \
      /bin/sh -c "$census_cmd" >"$1" 2>/dev/null || : >"$1"
  else
    ORCA_USER_DATA_PATH=$ORCA_USER_DATA /bin/sh -c "$census_cmd" >"$1" 2>/dev/null || : >"$1"
  fi
}

# ---- current link ---------------------------------------------------------------------------

current_target() {
  readlink "$ORCAD_BASE/orcad-current" 2>/dev/null || true
}

point_current() {
  link_tmp="$ORCAD_BASE/.orcad-current.$$"
  rm -f "$link_tmp"
  ln -s "$1" "$link_tmp"
  # GNU mv -T replaces the link atomically; elsewhere fall back to ln -sfn.
  if ! mv -T "$link_tmp" "$ORCAD_BASE/orcad-current" 2>/dev/null; then
    rm -f "$link_tmp"
    ln -sfn "$1" "$ORCAD_BASE/orcad-current"
  fi
}

active_policy_dir() {
  target=$(current_target)
  [ -n "$target" ] || die "no active orcad install under $ORCAD_BASE"
  echo "$ORCAD_BASE/$target"
}


require_root_for_system() {
  if [ "$ORCAD_SERVICE" = system ] && [ "$(id -u)" != 0 ]; then
    die 'ORCAD_SERVICE=system manages a system unit and root-owned installs; run as root'
  fi
}

# ---- install --------------------------------------------------------------------------------

INSTALLED_VERSION=

# Checksum first, then list, then extract: nothing from an unverified file touches disk.
install_verified_tarball() {
  tarball=$1
  [ -n "$WORK_DIR" ] || make_work_dir
  listing="$WORK_DIR/listing"
  tar -tzf "$tarball" >"$listing" || die "$tarball is not a readable gzip tarball"
  top=$(sed -n '1{s#^\./##;s#/.*##;p;}' "$listing")
  version=${top#orcad-}
  { [ "$top" != "$version" ] && is_full_version "$version"; } ||
    die "$tarball does not contain an orcad-<version>/ install directory"
  if awk -v t="$top" '{ sub(/^\.\//, "") } $0 != t && $0 != t "/" && index($0, t "/") != 1 { bad = 1 } END { exit !bad }' "$listing"; then
    die "$tarball contains entries outside $top/"
  fi
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "$listing"; then
    die "$tarball contains absolute or parent-relative paths"
  fi
  tar -xzf "$tarball" -C "$WORK_DIR" --no-same-owner
  staged="$WORK_DIR/$top"
  [ -z "$(find "$staged" -type l)" ] || die "$tarball contains symlinks; refusing"
  built_for=$(cat "$staged/.build-target")
  [ "$built_for" = "$(host_target)" ] || die "$top was built for $built_for, but this host is $(host_target)"
  verify_out=$(policy "$staged" verify-bundle --dir "$staged") || die "bundle verification failed: $verify_out"
  final=$(version_dir "$version")
  INSTALLED_VERSION=$version
  if [ -f "$final/.install-complete" ]; then
    say "orcad $version is already installed"
    return 0
  fi
  if [ -e "$final" ]; then
    [ ! -e "$final/.install-lock" ] || die "$final is being installed by another client; retry later"
    # A torn dir from an interrupted install; the tombstone name is one GC already sweeps.
    tomb="$final.gc-tombstone.$$.$(date +%s)"
    mv "$final" "$tomb"
    rm -rf "$tomb"
  fi
  if [ "$ORCAD_SERVICE" = system ]; then chmod -R go-w,a+rX "$staged"; fi
  : >"$staged/.install-complete"
  mv "$staged" "$final"
  say "installed orcad $version at $final"
}

parse_checksum_flags() {
  EXPECTED_SHA=
  FORCE_FLAG=
  while [ $# -gt 0 ]; do
    case "$1" in
      --sha256)
        [ $# -ge 2 ] || usage
        EXPECTED_SHA=$2
        shift 2
        ;;
      --sha256-file)
        [ $# -ge 2 ] || usage
        EXPECTED_SHA=$(cut -d ' ' -f 1 <"$2")
        shift 2
        ;;
      --force)
        FORCE_FLAG=--force
        shift
        ;;
      *) usage ;;
    esac
  done
}

verify_checksum() {
  tarball=$1
  [ -f "$tarball" ] || die "no such file: $tarball"
  if [ -z "$EXPECTED_SHA" ] && [ -f "$tarball.sha256" ]; then
    EXPECTED_SHA=$(cut -d ' ' -f 1 <"$tarball.sha256")
  fi
  printf '%s\n' "$EXPECTED_SHA" | grep -Eq '^[0-9a-f]{64}$' ||
    die 'a sha256 is required: --sha256 HEX, --sha256-file FILE, or <tarball>.sha256 beside it'
  actual=$(sha256_of "$tarball")
  [ "$actual" = "$EXPECTED_SHA" ] || die "checksum mismatch for $tarball: expected $EXPECTED_SHA, got $actual"
}

cmd_install() {
  [ $# -ge 1 ] || usage
  tarball=$1
  shift
  parse_checksum_flags "$@"
  require_root_for_system
  verify_checksum "$tarball"
  take_lock
  install_verified_tarball "$tarball"
  echo "$INSTALLED_VERSION"
}

# ---- activate -------------------------------------------------------------------------------

restore_after_rejection() {
  candidate_dir=$1
  previous_link=$2
  svc stop "$ORCAD_UNIT" || true
  if [ -z "$previous_link" ]; then
    rm -f "$ORCAD_BASE/orcad-current"
    say 'no previous version was active; the service is stopped'
    return 0
  fi
  if abort=$(policy "$candidate_dir" abort-activation --base "$ORCAD_BASE" --data-root "$ORCA_USER_DATA"); then
    point_current "$previous_link"
    start_service
    if await_gate "${previous_link#orcad-}" >/dev/null; then
      say "restored ${previous_link#orcad-}"
    else
      say "${previous_link#orcad-} was restarted but has not proven healthy"
    fi
  else
    say "the service is stopped: $(json_field reason "$abort")"
  fi
}

activate_installed() {
  version=$1
  force=$2
  dir=$(version_dir "$version")
  [ -f "$dir/.install-complete" ] || die "orcad $version is not installed under $ORCAD_BASE"
  [ -f "$dir/orcad-host-install.js" ] || die "$dir has no installer policy; reinstall it from a release tarball"
  [ -n "$WORK_DIR" ] || make_work_dir
  running=0
  if service_running; then running=1; fi
  census="$WORK_DIR/census.json"
  : >"$census"
  if [ "$running" = 1 ]; then take_census "$census"; fi
  set +e
  # shellcheck disable=SC2086 # $force is empty or one flag
  plan=$(policy "$dir" preflight-activate --base "$ORCAD_BASE" --data-root "$ORCA_USER_DATA" \
    --candidate "$version" --census-file "$census" --service-running "$running" $force)
  plan_status=$?
  set -e
  case "$plan_status" in
    0) ;;
    10)
      say "orcad $version is already active"
      return 0
      ;;
    20)
      say "activation refused: $(json_field reason "$plan")"
      exit "$EXIT_REFUSED"
      ;;
    *) die "activation preflight failed: $plan" ;;
  esac
  previous_link=$(current_target)
  if [ "$running" = 1 ]; then stop_service; fi
  if ! policy "$dir" capture-snapshot --base "$ORCAD_BASE" --data-root "$ORCA_USER_DATA" \
    --candidate "$version" >/dev/null; then
    # Nothing new has run against the state yet, so the incumbent may come straight back.
    if [ "$running" = 1 ]; then start_service; fi
    die "could not snapshot $ORCA_USER_DATA; refusing to activate without a way back"
  fi
  point_current "orcad-$version"
  if [ "$ORCAD_SERVICE" = none ]; then
    policy "$dir" commit-activation --base "$ORCAD_BASE" --candidate "$version" >/dev/null
    say "orcad $version is current. No service manager is configured: start it (orcad-install.sh run) and check its readiness line before relying on it"
    return 0
  fi
  start_service
  if verdict=$(await_gate "$version"); then
    policy "$dir" commit-activation --base "$ORCAD_BASE" --candidate "$version" >/dev/null
    say "orcad $version is active ($(json_field coverage "$verdict") self-test)"
    policy "$dir" prune --base "$ORCAD_BASE" --data-root "$ORCA_USER_DATA" >/dev/null ||
      say 'prune failed; older versions were kept'
    return 0
  fi
  say "orcad $version was rejected: $(json_field reason "$verdict")"
  restore_after_rejection "$dir" "$previous_link"
  exit "$EXIT_REJECTED"
}

cmd_activate() {
  [ $# -ge 1 ] || usage
  version=$1
  shift
  parse_checksum_flags "$@"
  is_full_version "$version" || die "not an orcad version: $version"
  require_root_for_system
  take_lock
  activate_installed "$version" "$FORCE_FLAG"
}

cmd_upgrade() {
  [ $# -ge 1 ] || usage
  tarball=$1
  shift
  parse_checksum_flags "$@"
  require_root_for_system
  verify_checksum "$tarball"
  take_lock
  install_verified_tarball "$tarball"
  activate_installed "$INSTALLED_VERSION" "$FORCE_FLAG"
}

# ---- rollback -------------------------------------------------------------------------------

cmd_rollback() {
  require_root_for_system
  take_lock
  make_work_dir
  dir=$(active_policy_dir)
  running=0
  if service_running; then running=1; fi
  census="$WORK_DIR/census.json"
  : >"$census"
  if [ "$running" = 1 ]; then take_census "$census"; fi
  set +e
  plan=$(policy "$dir" preflight-rollback --base "$ORCAD_BASE" --data-root "$ORCA_USER_DATA" \
    --census-file "$census")
  plan_status=$?
  set -e
  if [ "$plan_status" != 0 ]; then
    say "rollback refused: $(json_field reason "$plan")"
    exit "$EXIT_REFUSED"
  fi
  target=$(json_field target "$plan")
  target_dir=$(version_dir "$target")
  [ -f "$target_dir/.install-complete" ] || die "rollback target $target is not installed"
  if [ "$running" = 1 ]; then stop_service; fi
  if ! policy "$dir" restore-snapshot --base "$ORCAD_BASE" --data-root "$ORCA_USER_DATA" >/dev/null; then
    die "snapshot restore failed and orcad is stopped. Do NOT start $target against this data root; re-activate ${dir##*/orcad-}, which can read it"
  fi
  if [ "$ORCAD_SERVICE" = system ]; then chown "$ORCAD_SERVICE_USER:" "$ORCA_USER_DATA"; fi
  point_current "orcad-$target"
  if [ "$ORCAD_SERVICE" = none ]; then
    policy "$target_dir" commit-rollback --base "$ORCAD_BASE" >/dev/null
    say "orcad $target is current; start it yourself"
    return 0
  fi
  start_service
  if verdict=$(await_gate "$target"); then
    policy "$target_dir" commit-rollback --base "$ORCAD_BASE" >/dev/null
    say "rolled back to orcad $target"
    return 0
  fi
  say "rollback target $target did not prove healthy: $(json_field reason "$verdict"). The data root holds its pre-activation state."
  exit "$EXIT_REJECTED"
}

# ---- status / prune -------------------------------------------------------------------------

cmd_status() {
  printf 'base: %s\ndata root: %s\ncurrent: %s\n' "$ORCAD_BASE" "$ORCA_USER_DATA" "$(current_target)"
  if [ "$ORCAD_SERVICE" != none ]; then
    printf 'service %s: %s\n' "$ORCAD_UNIT" "$(svc is-active "$ORCAD_UNIT" 2>/dev/null || true)"
  fi
  target=$(current_target)
  [ -n "$target" ] || return 0
  dir="$ORCAD_BASE/$target"
  printf 'record: %s\n' "$(policy "$dir" record --base "$ORCAD_BASE")"
  printf 'daemon: %s\n' "$(policy "$dir" daemon-isolation --data-root "$ORCA_USER_DATA")"
  readiness=$(readiness_file)
  if [ -s "$readiness" ]; then printf 'readiness: %s\n' "$(cat "$readiness")"; fi
}

cmd_prune() {
  dry=
  if [ "${1:-}" = --dry-run ]; then dry=--dry-run; fi
  take_lock
  dir=$(active_policy_dir)
  # shellcheck disable=SC2086 # $dry is empty or one flag
  policy "$dir" prune --base "$ORCAD_BASE" --data-root "$ORCA_USER_DATA" $dry
}

# ---- service unit ---------------------------------------------------------------------------

kit_file() {
  for kit in "$(dirname "$0")" "$ORCAD_BASE/orcad-current/deploy"; do
    if [ -f "$kit/$1" ]; then
      echo "$kit/$1"
      return 0
    fi
  done
  die "cannot find $1 beside this script or in $ORCAD_BASE/orcad-current/deploy"
}

assert_plain_path() {
  printf '%s\n' "$1" | grep -Eq '^/[A-Za-z0-9._/@+-]*$' || die "unsupported characters in path: $1"
}

cmd_service_install() {
  port=
  bind=
  pairing=
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || usage
    case "$1" in
      --port) port=$2 ;;
      --bind) bind=$2 ;;
      --pairing-address) pairing=$2 ;;
      *) usage ;;
    esac
    shift 2
  done
  assert_plain_path "$ORCAD_BASE"
  assert_plain_path "$ORCA_USER_DATA"
  case "$ORCAD_SERVICE" in
    user)
      template=$(kit_file orcad.service)
      config=${XDG_CONFIG_HOME:-$HOME/.config}
      unit_path="$config/systemd/user/$ORCAD_UNIT"
      env_path="$config/orcad/orcad.env"
      linger_user=$(id -un)
      ;;
    system)
      require_root_for_system
      template=$(kit_file orcad-system.service)
      unit_path="/etc/systemd/system/$ORCAD_UNIT"
      env_path=/etc/orcad/orcad.env
      linger_user=$ORCAD_SERVICE_USER
      id "$linger_user" >/dev/null 2>&1 || die "service user $linger_user does not exist"
      ;;
    *) die 'service-install needs ORCAD_SERVICE=user or system' ;;
  esac
  mkdir -p "$(dirname "$unit_path")" "$(dirname "$env_path")"
  sed -e "s|@ORCAD_BASE@|$ORCAD_BASE|g" -e "s|@ORCA_USER_DATA@|$ORCA_USER_DATA|g" \
    -e "s|@ORCAD_USER@|$ORCAD_SERVICE_USER|g" -e "s|@ORCAD_ENV_FILE@|$env_path|g" \
    "$template" >"$unit_path.partial"
  mv "$unit_path.partial" "$unit_path"
  if [ ! -f "$env_path" ] || [ -n "$port$bind$pairing" ]; then
    {
      echo '# orcad listener settings, read by the unit on every start.'
      echo "ORCAD_BIND=${bind:-127.0.0.1}"
      echo "ORCAD_PORT=${port:-6768}"
      echo "ORCAD_PAIRING_ADDRESS=$pairing"
    } >"$env_path.partial"
    mv "$env_path.partial" "$env_path"
  fi
  svc daemon-reload
  svc enable "$ORCAD_UNIT"
  say "wrote $unit_path and $env_path"
  if [ "$(loginctl show-user "$linger_user" -p Linger --value 2>/dev/null || true)" != yes ]; then
    say "lingering is off for $linger_user: the user manager and the terminal daemon's scope end at logout."
    say "enable it once with: sudo loginctl enable-linger $linger_user"
  fi
}

# ---- uninstall ------------------------------------------------------------------------------

stop_daemon_pid() {
  kill -TERM "$1" 2>/dev/null || return 0
  waited=0
  while kill -0 "$1" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$1" 2>/dev/null; then
    kill -KILL "$1" 2>/dev/null || true
    sleep 1
  fi
  if kill -0 "$1" 2>/dev/null; then
    say "terminal daemon $1 is still running after SIGKILL; stop it manually"
  fi
}

cmd_uninstall() {
  purge=0
  if [ "${1:-}" = --purge-data ]; then purge=1; fi
  require_root_for_system
  take_lock
  make_work_dir
  target=$(current_target)
  daemon_pids=
  if [ -n "$target" ] && [ -x "$ORCAD_BASE/$target/bun-runtime" ]; then
    dir="$ORCAD_BASE/$target"
    census="$WORK_DIR/census.json"
    take_census "$census"
    set +e
    plan=$(policy "$dir" preflight-stop --data-root "$ORCA_USER_DATA" --census-file "$census" --retire-daemon)
    plan_status=$?
    set -e
    if [ "$plan_status" != 0 ]; then
      say "uninstall refused: $(json_field reason "$plan")"
      exit "$EXIT_REFUSED"
    fi
    daemon_pids=$(policy "$dir" daemon-isolation --data-root "$ORCA_USER_DATA" |
      sed -n 's/.*"pids":\[\([0-9,]*\)\].*/\1/p' | tr ',' ' ')
  fi
  if [ "$ORCAD_SERVICE" != none ]; then
    svc stop "$ORCAD_UNIT" 2>/dev/null || true
    svc disable "$ORCAD_UNIT" 2>/dev/null || true
    for unit_path in "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$ORCAD_UNIT" "/etc/systemd/system/$ORCAD_UNIT"; do
      if [ -f "$unit_path" ] && grep -q '^# Managed by orcad-install.sh' "$unit_path"; then
        rm -f "$unit_path"
      fi
    done
    svc daemon-reload 2>/dev/null || true
  fi
  for pid in $daemon_pids; do stop_daemon_pid "$pid"; done
  for entry in "$ORCAD_BASE"/orcad-*; do
    case "${entry##*/}" in
      orcad-current | orcad-active.json | orcad-state-snapshots | orcad-[0-9]*) rm -rf "$entry" ;;
    esac
  done
  rm -f "$ORCAD_BASE/.orcad-pending-activation.json" "$(readiness_file)"
  if [ "$purge" = 1 ]; then
    [ -e "$ORCA_USER_DATA/orcad.lock" ] || [ -e "$ORCA_USER_DATA/orca-profile-index.json" ] ||
      die "$ORCA_USER_DATA does not look like an orcad data root; not deleting it"
    rm -rf "$ORCA_USER_DATA"
    say "removed orcad and its data root $ORCA_USER_DATA"
  else
    say "removed orcad; the data root $ORCA_USER_DATA was kept (use --purge-data to delete it)"
  fi
}

# ---- foreground run -------------------------------------------------------------------------

cmd_run() {
  dir=$(readlink -f "$ORCAD_BASE/orcad-current") || die "no orcad-current link under $ORCAD_BASE"
  [ -f "$dir/.install-complete" ] || die "$dir is not a complete orcad install"
  # Real versioned paths (not the link) so the daemon records which version it was forked from.
  ORCA_VERSION=$(cat "$dir/.version")
  export ORCA_VERSION ORCA_USER_DATA
  set -- "$dir/bun-runtime" "$dir/orcad.js" --json --bind "${ORCAD_BIND:-127.0.0.1}" --port "${ORCAD_PORT:-6768}"
  if [ -n "${ORCAD_PAIRING_ADDRESS:-}" ]; then set -- "$@" --pairing-address "$ORCAD_PAIRING_ADDRESS"; fi
  if [ -n "${ORCAD_READINESS_FILE:-}" ]; then
    mkdir -p "$(dirname "$ORCAD_READINESS_FILE")"
    exec "$@" >"$ORCAD_READINESS_FILE"
  fi
  exec "$@"
}

# Container PID-1 child: restart orcad in place so its crash does not end the container,
# which would take the detached daemon and every PTY with it.
cmd_supervise() {
  set +e
  child=
  stopping=0
  trap 'stopping=1; if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; fi' TERM INT
  while :; do
    sh "$0" run &
    child=$!
    wait "$child"
    status=$?
    if [ "$stopping" = 1 ]; then
      wait "$child" 2>/dev/null
      exit 0
    fi
    if [ "$status" = 78 ]; then
      say 'orcad reported a configuration fault (exit 78); not restarting'
      exit 78
    fi
    say "orcad exited with $status; restarting in 5s"
    sleep 5
  done
}

[ $# -ge 1 ] || usage
command=$1
shift
case "$command" in
  install) cmd_install "$@" ;;
  activate) cmd_activate "$@" ;;
  upgrade) cmd_upgrade "$@" ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  prune) cmd_prune "$@" ;;
  service-install) cmd_service_install "$@" ;;
  uninstall) cmd_uninstall "$@" ;;
  run) cmd_run ;;
  supervise) cmd_supervise ;;
  *) usage ;;
esac
