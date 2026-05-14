#!/usr/bin/env bash
# rebuild-and-verify-native.sh — Clean, rebuild, and verify native modules for a target architecture.
# Used by release.yml to prevent architecture contamination across x64/arm64 builds.
#
# Usage: ./rebuild-and-verify-native.sh <arch>
#   arch: x64 | arm64

set -euo pipefail

ARCH="${1:?Usage: $0 <x64|arm64>}"

# Architecture-specific grep patterns for the `file` command output.
# macOS: "Mach-O 64-bit bundle x86_64" / "Mach-O 64-bit bundle arm64"
# Linux: "ELF 64-bit LSB shared object, x86-64" / "ELF 64-bit LSB shared object, ARM aarch64"
case "$ARCH" in
  x64)  PATTERN="x86_64\|x86-64\|AMD64" ;;
  arm64) PATTERN="arm64\|ARM\|aarch64" ;;
  *) echo "ERROR: unsupported arch '$ARCH' (expected x64 or arm64)" >&2; exit 1 ;;
esac

NATIVE_MODULES=(
  "node-pty:pty.node"
  "better-sqlite3:better_sqlite3.node"
)

# --- Clean ---
for entry in "${NATIVE_MODULES[@]}"; do
  mod="${entry%%:*}"
  echo "Cleaning node_modules/$mod/{build,prebuilds}..."
  rm -rf "node_modules/$mod/build" "node_modules/$mod/prebuilds"
done

# --- Rebuild ---
echo "Rebuilding native modules for $ARCH..."
npx electron-rebuild --arch="$ARCH" --force

# --- Verify ---
for entry in "${NATIVE_MODULES[@]}"; do
  mod="${entry%%:*}"
  bin="${entry##*:}"
  echo "Verifying $mod binary architecture..."
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
