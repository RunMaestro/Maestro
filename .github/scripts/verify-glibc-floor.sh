#!/usr/bin/env bash
# verify-glibc-floor.sh - Fail the build if any shipped Linux native module
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
# Usage: ./verify-glibc-floor.sh <max-glibc> <search-dir> [x64|arm64] [extra-binary ...]
#   max-glibc:    highest allowed glibc version, e.g. 2.35 (Ubuntu 22.04)
#   search-dir:   directory scanned recursively for *.node files
#   arch:         x64 (default) or arm64; only ELF objects for this arch are checked
#   extra-binary: other shipped ELF executables to hold to the same floor
#                 (e.g. the Computer History helper, resources/native/maestro-computer-history).
#                 Each must exist; a missing one fails the check.

set -euo pipefail

USAGE="Usage: $0 <max-glibc> <search-dir> [x64|arm64] [extra-binary ...]"
MAX_GLIBC="${1:?$USAGE}"
SEARCH_DIR="${2:?$USAGE}"
shift 2
ARCH="x64"
case "${1:-}" in
	x64 | arm64)
		ARCH="$1"
		shift
		;;
esac
EXTRA_BINS=("$@")
case "$ARCH" in
	x64) ARCH_LABEL="x86-64" ;;
	arm64) ARCH_LABEL="aarch64" ;;
esac

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

# List candidate modules, failing closed on any scan error: a partial scan that
# silently drops a binary (e.g. a permission error on a subdir) must not let an
# over-floor module slip through undetected.
find_out="$(mktemp)"
find_err="$(mktemp)"
if ! find "$SEARCH_DIR" -name '*.node' -type f >"$find_out" 2>"$find_err" || [ -s "$find_err" ]; then
	echo "✗ ERROR: scanning $SEARCH_DIR for .node files failed:" >&2
	sed 's/^/    /' "$find_err" >&2
	rm -f "$find_out" "$find_err"
	exit 1
fi
mapfile -t NODES < <(sort "$find_out")
rm -f "$find_out" "$find_err"
if [ "${#NODES[@]}" -eq 0 ]; then
	echo "✗ ERROR: no .node files found under $SEARCH_DIR" >&2
	exit 1
fi
for extra in "${EXTRA_BINS[@]}"; do
	if [ ! -f "$extra" ]; then
		echo "✗ ERROR: extra binary not found: $extra" >&2
		exit 1
	fi
	NODES+=("$extra")
done

echo "Checking glibc floor (max allowed: GLIBC_${MAX_GLIBC}) across ${#NODES[@]} native module(s)..."
FAIL=0
CHECKED=0
for bin in "${NODES[@]}"; do
	rel="${bin#"$SEARCH_DIR"/}"
	# Only ELF objects for the target arch matter for its glibc floor. Skip Windows
	# PE prebuilds and the foreign-arch prebuilds that node-pty bundles.
	info=$(file -b "$bin" 2>/dev/null || echo "")
	if [ "$ARCH" = "arm64" ]; then
		case "$info" in *ELF*aarch64*) is_target=1 ;; *) is_target=0 ;; esac
	else
		case "$info" in *ELF*x86-64* | *ELF*x86_64*) is_target=1 ;; *) is_target=0 ;; esac
	fi
	case "$is_target" in
		1) ;;
		*)
			echo "  - skip (not $ARCH_LABEL ELF): $rel"
			continue
			;;
	esac
	# Read the ELF version info once, failing closed on a readelf error. A bare
	# `readelf ... || true` would turn a parse failure into an empty result and
	# skip the binary as "musl/static" - a target-arch .node we cannot inspect must
	# fail the guard instead of slipping through.
	if ! readelf_out=$(readelf -V "$bin" 2>&1); then
		echo "  ✗ ERROR: readelf failed on $rel (failing closed):" >&2
		printf '%s\n' "$readelf_out" | sed 's/^/      /' >&2
		FAIL=1
		continue
	fi
	# Highest GLIBC_x.y[.z] version this binary requires, taken ONLY from the
	# version-needs section (.gnu.version_r) so the symbol/def tables can't skew
	# the result. Empty for musl-linked or statically linked objects.
	max_req=$(printf '%s\n' "$readelf_out" \
		| awk "/Version needs section/{needs=1; next} /section '/{needs=0} needs" \
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
	echo "✗ ERROR: no $ARCH_LABEL glibc-linked .node files were inspected under $SEARCH_DIR" >&2
	exit 1
fi

if [ "$FAIL" -ne 0 ]; then
	echo ""
	echo "✗ One or more native modules exceed the GLIBC_${MAX_GLIBC} floor."
	echo "  This package would fail to load on Ubuntu 22.04 (glibc 2.35) with a"
	echo "  \"version 'GLIBC_x.y' not found\" error at native-module load time."
	echo "  Fix: build the native modules against an older glibc - pin the release"
	echo "  runner to ubuntu-22.04 / ubuntu-22.04-arm or build inside an older-glibc container."
	exit 1
fi

echo "All $ARCH_LABEL native modules are within the GLIBC_${MAX_GLIBC} floor."
