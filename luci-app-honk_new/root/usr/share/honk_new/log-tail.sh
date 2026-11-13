#!/bin/sh
# The viewer transfers a bounded tail, never the entire log.
[ ! -f /var/log/honk_new.log ] || tail -c 32768 /var/log/honk_new.log | tail -n 200
