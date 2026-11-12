#!/bin/sh
# maestro-p installer (Linux + macOS)
#
# Installs the `maestro-p` wrapper, which lets callers use `claude -p` semantics
# while the underlying session runs through Claude Code's interactive TUI (so it
# draws on your Claude Max quota instead of API billing).
#
# Usage (copy-paste):
#   curl -fsSL https://runmaestro.ai/install/maestro-p.sh | sh
#
# What it does (system-wide install, accessible to all users):
#   1. Verifies Node.js >= 20, Bun, and the `claude` CLI are present.
#   2. Downloads maestro-p.js + a pinned package.json into /usr/local/lib/maestro-p.
#   3. Runs `bun install` there so Bun fetches the correct node-pty prebuild
#      for this OS/arch (no C++ toolchain needed).
#   4. Installs a `maestro-p` shim into /usr/local/bin.
#   5. Marks everything world-readable/executable so any user can run it.
#
# Uses sudo automatically when /usr/local is not writable by the current user.
#
# Override the download host with MAESTRO_BASE_URL, the runtime dir with
# MAESTRO_P_HOME, or the shim dir with MAESTRO_P_BIN, before piping into sh.

set -eu

BASE_URL="${MAESTRO_BASE_URL:-https://runmaestro.ai/install}"
INSTALL_DIR="${MAESTRO_P_HOME:-/usr/local/lib/maestro-p}"
SHIM_DIR="${MAESTRO_P_BIN:-/usr/local/bin}"
MIN_NODE_MAJOR=20

# ---- pretty output -------------------------------------------------------
if [ -t 1 ]; then
	C_RESET=$(printf '\033[0m'); C_BOLD=$(printf '\033[1m')
	C_GREEN=$(printf '\033[32m'); C_YELLOW=$(printf '\033[33m'); C_RED=$(printf '\033[31m')
else
	C_RESET=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''
fi
info()  { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$1"; }
ok()    { printf '%s  ok%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn()  { printf '%swarn%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
die()   { printf '%serror%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; exit 1; }

# ---- privilege elevation -------------------------------------------------
# System dirs (/usr/local/...) usually need root. Resolve a runner up front:
# nothing if already root, `sudo` if available, else fail with a clear message.
# `as_root <cmd...>` runs a single command with that runner.
SUDO=""
need_root_for() { # need_root_for <dir> -> exits 0 if elevation needed
	d="$1"
	while [ ! -d "$d" ]; do d="$(dirname "$d")"; done
	[ ! -w "$d" ]
}
if need_root_for "$INSTALL_DIR" || need_root_for "$SHIM_DIR"; then
	if [ "$(id -u)" -eq 0 ]; then
		SUDO=""
	elif command -v sudo >/dev/null 2>&1; then
		SUDO="sudo"
		info "Elevated permissions are required for ${INSTALL_DIR} / ${SHIM_DIR}; using sudo."
	else
		die "Need write access to ${INSTALL_DIR} and ${SHIM_DIR} but sudo is unavailable. Re-run as root, or set MAESTRO_P_HOME/MAESTRO_P_BIN to writable paths."
	fi
fi
as_root() { if [ -n "$SUDO" ]; then $SUDO "$@"; else "$@"; fi; }

# ---- platform ------------------------------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
	Linux|Darwin) ;;
	*) die "Unsupported OS '$OS'. This script targets Linux and macOS; use the PowerShell installer on Windows." ;;
esac

# ---- prerequisites: node -------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
	die "Node.js is not installed. Install Node >= ${MIN_NODE_MAJOR} (https://nodejs.org) and re-run."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
	die "Node.js $(node -v) is too old. maestro-p needs Node >= ${MIN_NODE_MAJOR}."
fi
ok "Node.js $(node -v)"

if ! command -v bun >/dev/null 2>&1; then
	die "Bun is not installed. Install Bun (https://bun.sh) and re-run."
fi
ok "Bun $(bun --version)"

# ---- prerequisite: claude (warn-only) ------------------------------------
if command -v claude >/dev/null 2>&1; then
	ok "claude $(claude --version 2>/dev/null | head -n1)"
else
	warn "The 'claude' CLI was not found on PATH."
	warn "maestro-p drives Claude Code, so install + log in to it before use."
	warn "See official Claude Code install docs, then run: claude"
fi

# ---- download tool -------------------------------------------------------
download() { # download <url> <dest>
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$1" -o "$2"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "$2" "$1"
	else
		die "Neither curl nor wget is available to download files."
	fi
}

# ---- stage in a user-writable temp dir -----------------------------------
# All network + Bun package work happens here as the current (non-root) user,
# so node-pty's install scripts never run under sudo. The finished tree is then
# atomically moved into the system location with elevated permissions.
STAGE="$(mktemp -d 2>/dev/null || mktemp -d -t maestro-p)"
cleanup() { rm -rf "$STAGE" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

info "Staging maestro-p"
mkdir -p "$STAGE/bin"

info "Downloading maestro-p.js"
download "$BASE_URL/maestro-p.js" "$STAGE/bin/maestro-p.js"
chmod 0755 "$STAGE/bin/maestro-p.js"
ok "maestro-p.js"

info "Downloading package.json"
download "$BASE_URL/maestro-p.package.json" "$STAGE/package.json"
ok "package.json"

info "Fetching node-pty prebuild via Bun (no compiler needed)"
( cd "$STAGE" && bun install --production --no-progress ) \
	|| die "bun install failed while staging."
node -e "require('$STAGE/node_modules/node-pty')" \
	|| die "node-pty failed to load after install."
ok "node-pty ready"

# World-readable, dirs traversable, before we copy into place.
chmod -R a+rX "$STAGE"

# ---- move into system location -------------------------------------------
info "Installing into ${INSTALL_DIR}"
as_root mkdir -p "$INSTALL_DIR"
# Replace any prior install so stale node_modules can't linger.
as_root rm -rf "$INSTALL_DIR/bin" "$INSTALL_DIR/node_modules" \
	"$INSTALL_DIR/package.json" "$INSTALL_DIR/package-lock.json"
# `cp -R <dir>/.` copies contents into the existing target on every POSIX cp.
as_root cp -R "$STAGE/." "$INSTALL_DIR/"
as_root chmod -R a+rX "$INSTALL_DIR"
ok "runtime installed"

# ---- shim ----------------------------------------------------------------
SHIM_PATH="$SHIM_DIR/maestro-p"
SHIM_TMP="$STAGE/maestro-p.shim"
cat > "$SHIM_TMP" <<EOF
#!/bin/sh
exec node "$INSTALL_DIR/bin/maestro-p.js" "\$@"
EOF
chmod 0755 "$SHIM_TMP"
as_root mkdir -p "$SHIM_DIR"
as_root cp "$SHIM_TMP" "$SHIM_PATH"
as_root chmod 0755 "$SHIM_PATH"
ok "shim installed at ${SHIM_PATH}"

# ---- verify --------------------------------------------------------------
INSTALLED_VERSION="$(node "$INSTALL_DIR/bin/maestro-p.js" --version 2>/dev/null || echo '?')"
ok "maestro-p ${INSTALLED_VERSION}"

printf '\n%sInstalled for all users.%s\n' "$C_BOLD" "$C_RESET"
case ":$PATH:" in
	*":$SHIM_DIR:"*) printf '  Run: %smaestro-p --help%s\n' "$C_BOLD" "$C_RESET" ;;
	*)
		printf '  %s%s is not on your PATH.%s Add it:\n' "$C_YELLOW" "$SHIM_DIR" "$C_RESET"
		printf '    echo '"'"'export PATH="%s:$PATH"'"'"' >> ~/.profile && . ~/.profile\n' "$SHIM_DIR"
		printf '  Then run: %smaestro-p --help%s\n' "$C_BOLD" "$C_RESET"
		;;
esac
