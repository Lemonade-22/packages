#!/bin/bash
set -u
cd "$(dirname "$0")/../.."   # repo root, so the paths below are stable
rm -f /tmp/fn.sh
STUB_DIR="$(cd "$(dirname "$0")" && pwd)/stub"
export RETRY_SLEEP=0
export PATH="$STUB_DIR:$PATH"

# Guard: a silent fallback to the real curl would turn this test into a live
# network probe that fails for the wrong reason.
if [ "$(command -v curl)" != "$STUB_DIR/curl" ]; then
	echo "FATAL: stub curl not in effect (resolved: $(command -v curl))" >&2
	exit 1
fi
log(){ printf '[test] %s\n' "$*"; }
WORK=/tmp/w; rm -rf "$WORK"; mkdir -p "$WORK"
F=Scripts/ci-build.sh
for fn in sdk_identity archive_ok fetch_resume; do
	sed -n "/^$fn()/,/^}/p" "$F" >> /tmp/fn.sh
done
. /tmp/fn.sh
: > /tmp/fn.sh.check

fail=0
chk(){ if [ "$2" = "$3" ]; then printf 'ok   %-44s %s\n' "$1" "$2"; else printf 'FAIL %-44s got=[%s] want=[%s]\n' "$1" "$2" "$3"; fail=$((fail+1)); fi; }

# real zstd archive as the emulated remote object
head -c 200000 /dev/urandom > /tmp/raw.bin
zstd -q -f /tmp/raw.bin -o /tmp/remote.bin
SIZE=$(wc -c < /tmp/remote.bin)
MD5=$(md5sum < /tmp/remote.bin | cut -d' ' -f1)
export STUB_REMOTE=/tmp/remote.bin
echo "remote archive: $SIZE bytes"

# ---- A: cold start, connection drops every 20KB, must still finish
export STUB_CHUNK=20000
rm -f "$WORK/a.zst"
if fetch_resume "https://downloads.openwrt.org/x/sdk.tar.zst" "$WORK/a.zst" 40; then r=ok; else r=fail; fi
chk "resume finishes despite repeated drops" "$r" ok
chk "final size matches remote" "$(wc -c < "$WORK/a.zst" 2>/dev/null)" "$SIZE"
chk "content byte-identical" "$(md5sum < "$WORK/a.zst" 2>/dev/null | cut -d' ' -f1)" "$MD5"

# ---- B: an existing partial file must be continued, not restarted
rm -f "$WORK/b.zst"
head -c $((SIZE / 2)) /tmp/remote.bin > "$WORK/b.zst"
before=$(wc -c < "$WORK/b.zst")
fetch_resume "https://downloads.openwrt.org/x/sdk.tar.zst" "$WORK/b.zst" 40
chk "starts from existing $before bytes" "$(wc -c < "$WORK/b.zst")" "$SIZE"
chk "resumed file is byte-identical" "$(md5sum < "$WORK/b.zst" | cut -d' ' -f1)" "$MD5"

# ---- C: dead host abandoned quickly instead of burning 15 retries
start=$(date +%s)
fetch_resume "https://bad.invalid/x/sdk.tar.zst" "$WORK/c.zst" 15; rc=$?
el=$(( $(date +%s) - start ))
chk "dead host returns failure" "$rc" "1"
chk "dead host abandoned fast" "$([ "$el" -lt 20 ] && echo yes || echo no)" "yes"

# ---- D: a corrupt/garbage payload must not be accepted
head -c 200000 /dev/urandom > /tmp/garbage.bin
export STUB_REMOTE=/tmp/garbage.bin STUB_CHUNK=20000
rm -f "$WORK/d.zst"
fetch_resume "https://downloads.openwrt.org/x/garbage.zst" "$WORK/d.zst" 5; rc=$?
chk "non-archive payload rejected" "$rc" "1"

# ---- E: upstream rebuild mid-download must discard the partial file -------
# Bytes from build A and build B must never end up in the same archive.
head -c 150000 /dev/urandom > /tmp/rawA.bin; zstd -q -f /tmp/rawA.bin -o /tmp/buildA.bin
head -c 150000 /dev/urandom > /tmp/rawB.bin; zstd -q -f /tmp/rawB.bin -o /tmp/buildB.bin
sizeB=$(wc -c < /tmp/buildB.bin)
md5B=$(md5sum < /tmp/buildB.bin | cut -d' ' -f1)

export STUB_REMOTE=/tmp/buildA.bin STUB_ETAG=buildA STUB_CHUNK=40000
rm -f "$WORK/e.zst"
fetch_resume "https://downloads.openwrt.org/x/sdk.tar.zst" "$WORK/e.zst" 1 "buildA" >/dev/null 2>&1
partial=$(wc -c < "$WORK/e.zst" 2>/dev/null || echo 0)
chk "one attempt leaves a partial file" "$([ "$partial" -gt 0 ] && [ "$partial" -lt "$(wc -c < /tmp/buildA.bin)" ] && echo yes || echo no)" "yes"

# upstream rebuilds: new content, new ETag; caller still expects buildA
export STUB_REMOTE=/tmp/buildB.bin STUB_ETAG=buildB STUB_CHUNK=40000
if fetch_resume "https://downloads.openwrt.org/x/sdk.tar.zst" "$WORK/e.zst" 20 "buildA" > /tmp/e.log 2>&1; then r=ok; else r=fail; fi
chk "rebuild detected and download completes" "$r" ok
chk "partial from the old build was discarded" "$(wc -c < "$WORK/e.zst")" "$sizeB"
chk "result matches the new build, not a splice" "$(md5sum < "$WORK/e.zst" | cut -d' ' -f1)" "$md5B"
chk "log mentions the artifact change" "$(grep -c 'artifact changed' /tmp/e.log)" "1"

# ---- F: a valid cached archive must be used without any network access ----
export STUB_REMOTE=/tmp/remote.bin STUB_ETAG=cached STUB_CHUNK=20000
cp /tmp/remote.bin "$WORK/cached.zst"
ARCHIVE="$WORK/cached.zst"
SDK_SIZE=$(wc -c < /tmp/remote.bin)
export SDK_SIZE
if archive_ok; then r=ok; else r=fail; fi
chk "cached archive accepted when size and zstd match" "$r" ok

# ---- G: a truncated or wrong-sized archive must be rejected --------------
head -c 5000 /tmp/remote.bin > "$WORK/short.zst"
ARCHIVE="$WORK/short.zst"
if archive_ok; then r=bad; else r=ok; fi
chk "short archive rejected" "$r" ok

: > "$WORK/empty.zst"
ARCHIVE="$WORK/empty.zst"
if archive_ok; then r=bad; else r=ok; fi
chk "empty archive rejected" "$r" ok

echo "---"
[ "$fail" -eq 0 ] && echo "ALL PASS" || { echo "$fail FAILED"; exit 1; }
