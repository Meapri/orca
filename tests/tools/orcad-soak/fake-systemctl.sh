#!/bin/sh
# Minimal systemctl stand-in for exercising orcad-install.sh where no systemd runs (macOS, CI
# containers). Supervises one unit: `start` runs $FAKE_SYSTEMCTL_EXEC in the background, `stop`
# sends SIGTERM to that main PID and waits. Every call is appended to $FAKE_SYSTEMCTL_STATE/calls.log.
set -eu
state=${FAKE_SYSTEMCTL_STATE:?FAKE_SYSTEMCTL_STATE is required}
mkdir -p "$state"
printf '%s\n' "$*" >>"$state/calls.log"
[ "${1:-}" = --user ] && shift
verb=${1:-}
shift || true
pid_file="$state/main.pid"

main_pid() {
  pid=$(cat "$pid_file" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    case "$(ps -o stat= -p "$pid" 2>/dev/null)" in Z*) return 1 ;; esac
    echo "$pid"
    return 0
  fi
  return 1
}

case "$verb" in
  is-active)
    if main_pid >/dev/null; then
      [ "${1:-}" = --quiet ] || echo active
      exit 0
    fi
    [ "${1:-}" = --quiet ] || echo inactive
    exit 3
    ;;
  start)
    if main_pid >/dev/null; then exit 0; fi
    : "${FAKE_SYSTEMCTL_EXEC:?FAKE_SYSTEMCTL_EXEC is required}"
    # shellcheck disable=SC2086 # the exec line is a deliberate word list
    nohup $FAKE_SYSTEMCTL_EXEC >>"$state/stdout.log" 2>>"$state/stderr.log" </dev/null &
    echo $! >"$pid_file"
    ;;
  stop)
    pid=$(main_pid) || exit 0
    kill -TERM "$pid" 2>/dev/null || true
    waited=0
    while main_pid >/dev/null && [ "$waited" -lt 300 ]; do
      sleep 0.1
      waited=$((waited + 1))
    done
    if main_pid >/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
    rm -f "$pid_file"
    ;;
  show)
    # Only `show -p MainPID --value <unit>` is used.
    main_pid || echo 0
    ;;
  reset-failed | daemon-reload | enable | disable) ;;
  *)
    echo "fake-systemctl: unsupported verb $verb" >&2
    exit 1
    ;;
esac
