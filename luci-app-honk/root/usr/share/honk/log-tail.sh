#!/bin/sh
# The viewer transfers a bounded tail, never the entire log.
[ ! -f /var/log/honk.log ] || tail -c 32768 /var/log/honk.log | tail -n 200
