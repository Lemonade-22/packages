#!/bin/sh
# Fixed actions only. Repeated clicks attach to the task already in flight.
set -u
kind="${1:-}"
case "$kind" in geo|adblock|apply) ;; *) exit 1 ;; esac
base="/var/run/honk/task-$kind"
mkdir -p "$base"
if [ "${2:-}" = worker ]; then
 trap 'rmdir "$base/lock" 2>/dev/null' EXIT
 trap 'echo failed > "$base/status"; exit 1' HUP INT TERM
 case "$kind" in
  geo) /usr/share/honk/update-geo.sh ;;
  adblock) /usr/share/honk/update-adblock.sh ;;
  apply) /etc/init.d/honk reload ;;
 esac
 code=$?
 if [ "$code" -eq 0 ]; then echo succeeded; else echo failed; fi > "$base/status.new"
 mv "$base/status.new" "$base/status"
 exit "$code"
fi
if ! mkdir "$base/lock" 2>/dev/null; then
 if [ -s "$base/pid" ] && kill -0 "$(cat "$base/pid")" 2>/dev/null; then exit 0; fi
 # Missing PID may mean the other launcher has not yet written it.
 if [ ! -s "$base/pid" ]; then exit 0; fi
 rmdir "$base/lock" 2>/dev/null || exit 1
 mkdir "$base/lock" 2>/dev/null || exit 0
fi
echo "$$" > "$base/pid"
echo running > "$base/status"
: > "$base/log"
(trap '' HUP; exec /bin/sh "$0" "$kind" worker) </dev/null >"$base/log" 2>&1 &
echo "$!" > "$base/pid"
