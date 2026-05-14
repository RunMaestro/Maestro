#!/usr/bin/env bash
# verify-native-arch.sh — Verify native module binaries match the expected architecture.
# Lightweight counterpart to rebuild-and-verify-native.sh (verify only, no clean/rebuild).
#
# Usage: ./verify-native-arch.sh <arch>
#   arch: x64 | arm64

set -euo pipefail

ARCH="${1:?Usage: $0 <x64|arm64>}"

case "$ARCH" in
  x64)  PATTERN="x86_64\|x86-64\|AMD64" ;;
  arm64) PATTERN="arm64\|ARM\|aarch64" ;;
  *) echo "ERROR: unsupported arch '$ARCH' (expected x64 or arm64)" >&2; exit 1 ;;
esac

NATIVE_MODULES=(
  "node-pty:pty.node"
  "better-sqlite3:better_sqlite3.node"
)

for entry in "${NATIVE_MODULES[@]}"; do
  mod="${entry%%:*}"
  bin="${entry##*:}"
  echo "Checking $mod binary architecture..."
  BIN_PATH=$(find "node_modules/$mod" -name "$bin" -type f 2>/dev/null | head -1)
  if [ -z "$BIN_PATH" ]; then
    echo "✗ ERROR: $mod binary ($bin) not found!"
    exit 1
  fi
  file "$BIN_PATH"
  if file "$BIN_PATH" | grep -q "$PATTERN"; then
    echo "✓ $mod is correctly built for $ARCH"
  else
    echo "✗ ERROR: $mod is NOT built for $ARCH!"
    exit 1
  fi
done

echo "All native modules verified for $ARCH."
