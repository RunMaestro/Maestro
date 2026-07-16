#!/usr/bin/env bash
# Verify required native binaries for a release target, optionally rebuilding first.
#
# Usage:
#   ./verify-native-arch.sh --arch <x64|arm64> --platform <win|linux|mac> [--root <dir>] [--rebuild]
#   ./verify-native-arch.sh --arch <x64|arm64> --platform <win|linux|mac> --modules <path[,path...]>
#
# Paths in --modules are relative to <root>/node_modules. The default module list
# intentionally keeps Windows ConPTY filenames distinct from Unix pty.node.

set -euo pipefail

ARCH=""
PLATFORM=""
ROOT="."
REBUILD=false
MODULES=""

usage() {
  echo "Usage: $0 --arch <x64|arm64> --platform <win|linux|mac> [--root <dir>] [--rebuild] [--modules <path[,path...]>]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --arch)
      ARCH="${2:-}"
      shift 2
      ;;
    --platform)
      PLATFORM="${2:-}"
      shift 2
      ;;
    --root)
      ROOT="${2:-}"
      shift 2
      ;;
    --modules)
      MODULES="${2:-}"
      shift 2
      ;;
    --rebuild)
      REBUILD=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      usage
      exit 1
      ;;
  esac
done

case "$ARCH" in
  x64) ARCH_PATTERN='x86_64|x86-64|AMD64' ;;
  arm64) ARCH_PATTERN='arm64|ARM|aarch64' ;;
  *)
    echo "ERROR: unsupported arch '$ARCH' (expected x64 or arm64)" >&2
    exit 1
    ;;
esac

case "$PLATFORM" in
  win|linux|mac) ;;
  *)
    echo "ERROR: unsupported platform '$PLATFORM' (expected win, linux, or mac)" >&2
    exit 1
    ;;
esac

if [ -z "$MODULES" ]; then
  case "$PLATFORM" in
    win)
      MODULES='node-pty/build/Release/conpty.node,node-pty/build/Release/conpty_console_list.node,better-sqlite3/build/Release/better_sqlite3.node'
      ;;
    linux|mac)
      MODULES='node-pty/build/Release/pty.node,better-sqlite3/build/Release/better_sqlite3.node'
      ;;
  esac
fi

if [ "$REBUILD" = true ]; then
  if [ "$ROOT" != "." ]; then
    echo "ERROR: --rebuild only supports the repository root" >&2
    exit 1
  fi

  echo "Rebuilding native modules for $PLATFORM/$ARCH..."
  bunx electron-rebuild --arch="$ARCH" --force
fi

IFS=',' read -r -a NATIVE_MODULES <<< "$MODULES"
for relative_path in "${NATIVE_MODULES[@]}"; do
  binary_path="$ROOT/node_modules/$relative_path"
  binary_name="${relative_path##*/}"

  echo "Checking $binary_name for $PLATFORM/$ARCH..."
  if [ ! -f "$binary_path" ]; then
    echo "✗ ERROR: $binary_name not found at $binary_path!" >&2
    exit 1
  fi

  file_output="$(file "$binary_path")"
  echo "$file_output"
  if grep -Eqi "$ARCH_PATTERN" <<< "$file_output"; then
    echo "✓ $binary_name is correctly built for $ARCH"
  else
    echo "✗ ERROR: $binary_name at $binary_path is NOT built for $ARCH!" >&2
    exit 1
  fi
done

echo "All native modules verified for $PLATFORM/$ARCH."
