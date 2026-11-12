#!/usr/bin/env bash
#
# Build luci-app-irqaffinity with an official OpenWrt SDK.
#
# Usage: ci-build.sh <ipk|apk> <sdk-index-url>
#   ipk -> OpenWrt 24.10 (opkg)
#   apk -> OpenWrt snapshot/main (apk-tools 3)
#
# The package is architecture independent (LuCI JS + JSON + shell helper only),
# so the build always yields an "Architecture: all" package regardless of the
# SDK target used here.
set -euo pipefail

FORMAT="${1:?usage: ci-build.sh <ipk|apk> <sdk-index-url>}"
SDK_INDEX="${2:?usage: ci-build.sh <ipk|apk> <sdk-index-url>}"

WORK="${RUNNER_TEMP:-/tmp}/sdk-build"
OUT="${RUNNER_TEMP:-/tmp}/out"
rm -rf "$WORK" "$OUT"
mkdir -p "$WORK" "$OUT"

log() { printf '\n[ci-build] %s\n' "$*"; }

# ---------------------------------------------------------------- tooling ----
for t in zstd curl; do
	if ! command -v "$t" >/dev/null 2>&1; then
		log "Installing $t"
		sudo apt-get update -qq
		sudo apt-get install -y -qq "$t"
	fi
done

# ------------------------------------------------------------ sdk download ---
# Snapshots are rebuilt in place, often mid-download: in run 42474599842 the
# SDK's Last-Modified flipped to 11:41:01Z while we were still fetching, the
# first ~145 MB stayed from the old build, the rest came from the new one, and
# zstd -t rejected the splice. Resuming blindly is therefore unsafe.
#
# Two protections:
#   1. a cache hit is used as-is (no network at all) after size + zstd checks;
#   2. every resume re-reads the upstream ETag/Content-Length and throws the
#      partial file away if the artifact changed underneath us.
#
# Environment (set by the workflow, all optional):
#   SDK_ARCHIVE  path to keep the .tar.zst (inside the cached directory)
#   SDK_ETAG     upstream fingerprint to expect
#   SDK_SIZE     upstream Content-Length to expect

ARCHIVE="${SDK_ARCHIVE:-$WORK/sdk.tar.zst}"
mkdir -p "$(dirname "$ARCHIVE")"

# sdk_identity <url> -> "<etag> <content-length>"
sdk_identity() {
	curl -sI --http1.1 --connect-timeout 30 --max-time 60 "$1" 2>/dev/null \
		| tr -d '\r' \
		| awk '
			tolower($1) == "etag:"           { gsub(/"/, "", $2); etag = $2 }
			tolower($1) == "content-length:" { len = $2 }
			END { print (etag == "" ? "none" : etag), (len == "" ? "0" : len) }'
}

archive_ok() {
	[ -f "$ARCHIVE" ] || return 1
	if [ -n "${SDK_SIZE:-}" ] && [ "$SDK_SIZE" != 0 ]; then
		[ "$(wc -c < "$ARCHIVE")" = "$SDK_SIZE" ] || return 1
	fi
	zstd -tq "$ARCHIVE" 2>/dev/null
}

# fetch_resume <url> <outfile> <tries> <expected-etag>
fetch_resume() {
	_url="$1"; _out="$2"; _tries="${3:-20}"; _expect="${4:-}"
	_n=0; _restarts=0; _sleep="${RETRY_SLEEP:-5}"
	while [ "$_n" -lt "$_tries" ]; do
		_n=$((_n + 1))

		if [ -n "$_expect" ] && [ "$_expect" != none ]; then
			_id=$(sdk_identity "$_url")
			_cur="${_id% *}"
			if [ -n "$_cur" ] && [ "$_cur" != "$_expect" ]; then
				_restarts=$((_restarts + 1))
				log "upstream artifact changed ($_expect -> $_cur); discarding partial download"
				rm -f "$_out"
				if [ "$_restarts" -gt 2 ]; then
					log "artifact keeps changing underneath us; giving up"
					return 1
				fi
				_expect="$_cur"
				continue
			fi
		fi

		_before=0
		[ -f "$_out" ] && _before=$(wc -c < "$_out")

		if curl -fL --http1.1 -C - \
			--connect-timeout 30 --speed-limit 2048 --speed-time 60 \
			-o "$_out" "$_url"; then
			if zstd -tq "$_out" 2>/dev/null; then
				return 0
			fi
			log "downloaded file failed integrity test; discarding"
			rm -f "$_out"
			return 1
		fi

		_after=0
		[ -f "$_out" ] && _after=$(wc -c < "$_out")

		if [ "$_after" -gt 0 ] && zstd -tq "$_out" 2>/dev/null; then
			return 0
		fi

		if [ "$_after" -le "$_before" ]; then
			log "attempt $_n made no progress (still $_after bytes); giving up"
			return 1
		fi

		log "attempt $_n interrupted at $_after bytes; resuming"
		sleep "$_sleep"
	done
	return 1
}

if archive_ok; then
	log "Using cached SDK archive ($(du -h "$ARCHIVE" | cut -f1)); skipping download"
else
	[ -f "$ARCHIVE" ] && rm -f "$ARCHIVE"

	log "Resolving SDK archive from ${SDK_INDEX}"
	SDK_FILE=""
	for _ in 1 2 3 4 5; do
		SDK_FILE="$(curl -fsSL --http1.1 --connect-timeout 30 --max-time 120 \
			--retry 3 --retry-all-errors --retry-delay 5 "$SDK_INDEX" \
			| grep -oE 'openwrt-sdk-[^"<>]*\.tar\.zst' | head -n1 || true)"
		[ -n "$SDK_FILE" ] && break
		sleep 5
	done
	if [ -z "$SDK_FILE" ]; then
		echo "ERROR: could not discover a SDK archive at ${SDK_INDEX}" >&2
		exit 1
	fi
	log "SDK archive: ${SDK_FILE}"

	SDK_URL="${SDK_INDEX}${SDK_FILE}"
	if [ -z "${SDK_ETAG:-}" ]; then
		_id=$(sdk_identity "$SDK_URL")
		SDK_ETAG="${_id% *}"
		SDK_SIZE="${_id#* }"
		log "upstream fingerprint: ${SDK_ETAG} (${SDK_SIZE} bytes)"
	fi

	if ! fetch_resume "$SDK_URL" "$ARCHIVE" 20 "${SDK_ETAG:-}"; then
		echo "ERROR: could not download a verifiable SDK archive from ${SDK_INDEX}" >&2
		exit 1
	fi

	if [ -n "${SDK_SIZE:-}" ] && [ "$SDK_SIZE" != 0 ]; then
		_have=$(wc -c < "$ARCHIVE")
		if [ "$_have" != "$SDK_SIZE" ]; then
			echo "ERROR: SDK size mismatch (have $_have, want $SDK_SIZE)" >&2
			exit 1
		fi
	fi
	log "SDK downloaded: $(du -h "$ARCHIVE" | cut -f1)"
fi

zstd -dq -f "$ARCHIVE" -o "$WORK/sdk.tar"
mkdir -p "$WORK/sdk"
tar -xf "$WORK/sdk.tar" -C "$WORK/sdk" --strip-components=1
rm -f "$WORK/sdk.tar"
log "SDK extracted to $WORK/sdk"

# ---------------------------------------------------------------- package ----
cd "$WORK/sdk"
log "Updating feeds (this pulls the LuCI feed providing luci.mk / po2lmo)"
./scripts/feeds update -a
# Install everything so luci-base/host (po2lmo) resolve; fall back to the
# minimum that must be present for this package to build.
./scripts/feeds install -a || ./scripts/feeds install luci-base

mkdir -p package/custom
cp -a "${GITHUB_WORKSPACE:-$PWD/../../..}" package/custom/luci-app-irqaffinity
rm -rf package/custom/luci-app-irqaffinity/.git \
       package/custom/luci-app-irqaffinity/.github \
       package/custom/luci-app-irqaffinity/Scripts

log "Building luci-app-irqaffinity for ${FORMAT}"
make defconfig
if ! make package/custom/luci-app-irqaffinity/compile -j"$(nproc)" V=s; then
	log "Parallel build failed, retrying serially with full output"
	make package/custom/luci-app-irqaffinity/compile -j1 V=s
fi

log "Collecting packages"
found=0
while IFS= read -r -d '' pkg; do
	cp -v "$pkg" "$OUT/" && found=$((found+1))
done < <(find bin/packages -type f \( -name 'luci-app-irqaffinity_*.ipk' \
		-o -name 'luci-app-irqaffinity-*.apk' \) -print0)

if [ "$found" = 0 ]; then
	echo "ERROR: build produced no package for format ${FORMAT}" >&2
	find bin/packages -type f | sed 's/^/  found: /' || true
	exit 1
fi
ls -lh "$OUT"
log "Done"
