#!/usr/bin/env bash
#
# Build luci-app-static-gw with an official OpenWrt SDK.
#
# Usage: ci-build.sh <ipk|apk> <sdk-index-url>
#   ipk -> OpenWrt 24.10 (opkg)
#   apk -> OpenWrt snapshot/main (apk-tools 3)
#
# The package is architecture independent (LuCI JS + JSON + i18n only), so the
# build always yields an "Architecture: all" package regardless of the SDK
# target used here.
set -euo pipefail

FORMAT="${1:?usage: ci-build.sh <ipk|apk> <sdk-index-url>}"
SDK_INDEX="${2:?usage: ci-build.sh <ipk|apk> <sdk-index-url>}"

WORK="${RUNNER_TEMP:-/tmp}/sdk-build"
OUT="${RUNNER_TEMP:-/tmp}/out"
rm -rf "$WORK" "$OUT"
mkdir -p "$WORK" "$OUT"

log() { printf '\n[ci-build] %s\n' "$*"; }

# ---------------------------------------------------------------- tooling ----
if ! command -v zstd >/dev/null 2>&1; then
	log "Installing zstd"
	sudo apt-get update -qq
	sudo apt-get install -y -qq zstd
fi

# ------------------------------------------------------------ sdk download ---
log "Resolving SDK archive from ${SDK_INDEX}"
SDK_FILE=""
for _ in 1 2 3; do
	SDK_FILE="$(curl -fsSL --retry 3 --retry-delay 5 "$SDK_INDEX" \
		| grep -oE 'openwrt-sdk-[^"<>]*\.tar\.zst' | head -n1 || true)"
	[ -n "$SDK_FILE" ] && break
	sleep 5
done
if [ -z "$SDK_FILE" ]; then
	echo "ERROR: could not discover a SDK archive at ${SDK_INDEX}" >&2
	exit 1
fi
log "SDK archive: ${SDK_FILE}"

curl -fL --retry 3 --retry-delay 5 -o "$WORK/sdk.tar.zst" "${SDK_INDEX}${SDK_FILE}"
log "SDK downloaded: $(du -h "$WORK/sdk.tar.zst" | cut -f1)"

zstd -dq "$WORK/sdk.tar.zst" -o "$WORK/sdk.tar"
mkdir -p "$WORK/sdk"
tar -xf "$WORK/sdk.tar" -C "$WORK/sdk" --strip-components=1
rm -f "$WORK/sdk.tar" "$WORK/sdk.tar.zst"
log "SDK extracted to $WORK/sdk"

# ---------------------------------------------------------------- package ----
cd "$WORK/sdk"
log "Updating feeds (this pulls the LuCI feed providing luci.mk / po2lmo)"
./scripts/feeds update -a
# Install everything so luci-base/host (po2lmo) and its lua host dependency
# resolve; fall back to the only packages we strictly need.
./scripts/feeds install -a || ./scripts/feeds install luci-base

mkdir -p package/custom
cp -a "${GITHUB_WORKSPACE:-$PWD/../../..}" package/custom/luci-app-static-gw
rm -rf package/custom/luci-app-static-gw/.git \
       package/custom/luci-app-static-gw/.github \
       package/custom/luci-app-static-gw/Scripts

log "Building luci-app-static-gw for ${FORMAT}"
make defconfig
if ! make package/custom/luci-app-static-gw/compile -j"$(nproc)" V=s; then
	log "Parallel build failed, retrying serially with full output"
	make package/custom/luci-app-static-gw/compile -j1 V=s
fi

# --------------------------------------------------------------- collect -----
log "Collecting ${FORMAT} artifacts"
# luci.mk splits the translations into their own luci-i18n-* packages, so the
# Simplified Chinese UI only works when that package is published too.
find bin -type f \( -name "luci-app-static-gw*" -o -name "luci-i18n-static-gw*" \) -print0 \
	| while IFS= read -r -d '' f; do
		case "$f" in
			*.ipk|*.apk) cp -v "$f" "$OUT"/ ;;
		esac
	done

shopt -s nullglob
pkgs=("$OUT"/*.ipk "$OUT"/*.apk)
if [ ${#pkgs[@]} -eq 0 ]; then
	echo "ERROR: the build produced no package file" >&2
	find bin -type f | head -50 >&2
	exit 1
fi

# The apk is signed with the SDK build key; a device does not trust it by
# default, so installing requires --allow-untrusted (or trusting the key
# manually). No key file is published as a release asset.

log "Result:"
ls -lh "$OUT"

# -------------------------------------------------------------------------
# Self-documentation only: dump package metadata into the log.
# This must never fail the job - the packages are already built and this is
# purely diagnostic. (It previously aborted the apk job because GNU tar
# cannot read the apk-tools 3 container directly and `set -o pipefail`
# turned that into a fatal error.)
# -------------------------------------------------------------------------
set +e
for p in "${pkgs[@]}"; do
	log "--- $p"
	case "$p" in
		*.ipk)
			# ipk = ar/tar with control.tar.gz inside
			tar -xzOf "$p" ./control.tar.gz 2>/dev/null \
				| tar -xzO ./control 2>/dev/null \
				| sed -n '1,15p'
			;;
		*.apk)
			# apk-tools 3 uses its own "ADBd" container, which GNU tar cannot
			# read; report the magic bytes instead of pretending to parse it.
			printf 'apk container: '; head -c 4 "$p" | od -An -c | tr -d '\n'; echo
			;;
	esac
	# Prove the package really is architecture independent.
	case "$p" in
		*.ipk)
			arch="$(tar -xzOf "$p" ./control.tar.gz 2>/dev/null \
				| tar -xzO ./control 2>/dev/null \
				| sed -n 's/^Architecture: //p')"
			log "Architecture: ${arch:-unknown}"
			[ "$arch" = "all" ] || log "WARNING: expected Architecture: all"
			;;
	esac
done
set -e

log "Done: ${#pkgs[@]} package(s) in $OUT"
