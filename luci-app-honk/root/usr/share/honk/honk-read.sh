#!/bin/sh
case "$1" in
    nodes|providers|groups|group|runtime|config|operation) exec /usr/share/honk/honk-api.sh "$@" ;;
    *) echo 'Read-only API action required' >&2; exit 1 ;;
esac
