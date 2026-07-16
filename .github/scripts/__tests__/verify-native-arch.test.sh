#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFIER="$SCRIPT_DIR/verify-native-arch.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin"
cat > "$TMP_DIR/bin/file" <<'EOF'
#!/usr/bin/env bash
case "${MOCK_FILE_ARCH:?}" in
  x64) echo "$1: PE32+ executable for MS Windows, x86-64" ;;
  arm64) echo "$1: ELF 64-bit LSB shared object, ARM aarch64" ;;
  *) echo "$1: unknown architecture" ;;
esac
EOF
chmod +x "$TMP_DIR/bin/file"

make_windows_tree() {
  local root="$1"
  mkdir -p "$root/node_modules/node-pty/build/Release" "$root/node_modules/better-sqlite3/build/Release"
  : > "$root/node_modules/node-pty/build/Release/conpty.node"
  : > "$root/node_modules/node-pty/build/Release/conpty_console_list.node"
  : > "$root/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
}

make_windows_tree "$TMP_DIR/complete"
PATH="$TMP_DIR/bin:$PATH" MOCK_FILE_ARCH=x64 "$VERIFIER" --arch x64 --platform win --root "$TMP_DIR/complete"

mkdir -p "$TMP_DIR/missing/node_modules/node-pty/build/Release" "$TMP_DIR/missing/node_modules/better-sqlite3/build/Release"
: > "$TMP_DIR/missing/node_modules/node-pty/build/Release/conpty.node"
: > "$TMP_DIR/missing/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if output=$(PATH="$TMP_DIR/bin:$PATH" MOCK_FILE_ARCH=x64 "$VERIFIER" --arch x64 --platform win --root "$TMP_DIR/missing" 2>&1); then
  echo "expected missing ConPTY fixture to fail" >&2
  exit 1
fi
grep -Fq 'conpty_console_list.node not found' <<< "$output"

if output=$(PATH="$TMP_DIR/bin:$PATH" MOCK_FILE_ARCH=arm64 "$VERIFIER" --arch x64 --platform win --root "$TMP_DIR/complete" 2>&1); then
  echo "expected wrong-architecture fixture to fail" >&2
  exit 1
fi
grep -Fq 'is NOT built for x64' <<< "$output"

if output=$(PATH="$TMP_DIR/bin:$PATH" MOCK_FILE_ARCH=x64 "$VERIFIER" --arch arm64 --platform win --root "$TMP_DIR/complete" 2>&1); then
  echo "expected host-rebuilt-instead-of-target fixture to fail" >&2
  exit 1
fi
grep -Fq 'is NOT built for arm64' <<< "$output"

echo 'Native verifier fixtures passed.'
