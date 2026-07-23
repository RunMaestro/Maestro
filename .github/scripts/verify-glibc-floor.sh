#!/usr/bin/env bash
# verify-glibc-floor.sh - Fail the build if any shipped x86-64 native module
# requires a glibc symbol version newer than the supported floor.
#
# Why this exists: the Linux native modules (better-sqlite3, node-pty, ...) are
# compiled from source on the CI runner, so their glibc floor is whatever the
# runner's toolchain happens to provide. If the runner base image drifts to a
# newer glibc, the shipped .node files start requiring newer versioned symbols
# and silently fail to load on older-but-still-supported distros. That is what
# broke Ubuntu 22.04 (glibc 2.35): better_sqlite3.node ended up needing a
# GLIBC_2.38 symbol, so the Cue and stats databases failed to initialize.
#
# This guard is a cheap insurance net that runs regardless of which runner built
# the package: it inspects the actual packaged binaries and fails loudly if the
# floor was exceeded.
#
# Usage: ./verify-glibc-floor.sh <max-glibc> <search-dir>
#   max-glibc:  highest allowed glibc version, e.g. 2.35 (Ubuntu 22.04)
#   search-dir: directory scanned recursively for *.node files

set -euo pipefail

MAX_GLIBC="${1:?Usage: $0 <max-glibc> <search-dir>}"
SEARCH_DIR="${2:?Usage: $0 <max-glibc> <search-dir>}"

if ! command -v readelf >/dev/null 2>&1; then
	echo "✗ ERROR: readelf not found (install binutils)" >&2
	exit 1
fi
if [ ! -d "$SEARCH_DIR" ]; then
	echo "✗ ERROR: search dir not found: $SEARCH_DIR" >&2
	exit 1
fi

# ver_gt A B -> success (0) when A > B, using version-aware ordering.
ver_gt() {
	[ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]
}

mapfile -t NODES < <(find "$SEARCH_DIR" -name '*.node' -type f 2>/dev/null | sort)
if [ "${#NODES[@]}" -eq 0 ]; then
	echo "✗ ERROR: no .node files found under $SEARCH_DIR" >&2
	exit 1
fi

echo "Checking glibc floor (max allowed: GLIBC_${MAX_GLIBC}) across ${#NODES[@]} native module(s)..."
FAIL=0
CHECKED=0
for bin in "${NODES[@]}"; do
	rel="${bin#"$SEARCH_DIR"/}"
	# Only x86-64 ELF objects matter for the x64 glibc floor. Skip Windows PE
	# prebuilds and foreign-arch (arm64) prebuilds that node-pty bundles.
	info=$(file -b "$bin" 2>/dev/null || echo "")
	case "$info" in
		*ELF*x86-64* | *ELF*x86_64*) ;;
		*)
			echo "  - skip (not x86-64 ELF): $rel"
			continue
			;;
	esac
	# Highest GLIBC_x.y[.z] versioned symbol this binary requires. Empty for
	# musl-linked or statically linked objects (no glibc symbol versioning).
	max_req=$(readelf -V "$bin" 2>/dev/null \
		| grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' \
		| sed 's/^GLIBC_//' \
		| sort -V \
		| tail -n1 || true)
	if [ -z "$max_req" ]; then
		echo "  - skip (no glibc symbol versions, musl/static): $rel"
		continue
	fi
	CHECKED=$((CHECKED + 1))
	if ver_gt "$max_req" "$MAX_GLIBC"; then
		echo "  ✗ $rel requires GLIBC_${max_req} (> floor GLIBC_${MAX_GLIBC})"
		FAIL=1
	else
		echo "  ✓ $rel: max GLIBC_${max_req} (<= GLIBC_${MAX_GLIBC})"
	fi
done

if [ "$CHECKED" -eq 0 ]; then
	echo "✗ ERROR: no x86-64 glibc-linked .node files were inspected under $SEARCH_DIR" >&2
	exit 1
fi

if [ "$FAIL" -ne 0 ]; then
	echo ""
	echo "✗ One or more native modules exceed the GLIBC_${MAX_GLIBC} floor."
	echo "  This package would fail to load on Ubuntu 22.04 (glibc 2.35) with a"
	echo "  \"version 'GLIBC_x.y' not found\" error at native-module load time."
	echo "  Fix: build the native modules against an older glibc - pin the release"
	echo "  runner to ubuntu-22.04 or build inside an older-glibc container."
	exit 1
fi

echo "All x86-64 native modules are within the GLIBC_${MAX_GLIBC} floor."
