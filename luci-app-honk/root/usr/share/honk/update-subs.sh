#!/bin/sh
# Core owns subscription parsing and refresh; never delete the UCI snapshots.
exec /usr/share/honk/honk-api.sh providers
