#!/bin/sh
# Maestro Cue server installer (Debian or Ubuntu with systemd)
#
# Run it from the unpacked server bundle (`npm run build:server`):
#   tar -xzf maestro-server-<version>.tgz
#   sudo ./maestro-server/install.sh
#
# What it does:
#   1. Checks for root, systemd, apt, and an x86_64 or aarch64 CPU.
#   2. Installs git, certificates and the GitHub CLI (gh, from GitHub's apt
#      repository).
#   3. Creates the `maestro` system user (home /var/lib/maestro), the data
#      directory /var/lib/maestro/data, the workspace root /srv/maestro, and
#      /etc/maestro for the env file and credentials.
#   4. Picks the Node.js the service will run: the one on PATH when it is 22 or
#      newer and the maestro user can run it, otherwise Node.js from
#      nodejs.org (checksum verified) in /usr/local.
#   5. Installs the agent CLIs (Claude Code unless told otherwise) with that
#      Node.js, where the service finds them.
#   6. Copies the bundle to /opt/maestro, installs better-sqlite3 for that
#      Node.js, and links the `maestro-cli` wrapper into /usr/local/bin.
#   7. Installs the maestro-cue systemd unit. It is not started unless you pass
#      --enable: import a pipeline bundle first.
#
# Run it again with a newer bundle to upgrade. The data directory, workspaces,
# env file and credentials are kept, and a running service is restarted.
#
# Options:
#   --enable              enable and start maestro-cue after installing
#   --skip-gh             do not install the GitHub CLI
#   --agent-cli PACKAGE   agent CLI to install with npm (repeatable; replaces the
#                         default @anthropic-ai/claude-code), e.g. @openai/codex
#   --no-agent-cli        install no agent CLI
#   --node-major N        Node.js major version to install when needed (default 24)

set -eu

PREFIX=/opt/maestro
STATE_DIR=/var/lib/maestro
DATA_DIR=$STATE_DIR/data
WORK_DIR=/srv/maestro
CONF_DIR=/etc/maestro
UNIT_PATH=/etc/systemd/system/maestro-cue.service
MIN_NODE_MAJOR=22
NODE_MAJOR=24
ENABLE=0
INSTALL_GH=1
DEFAULT_AGENT_CLIS="@anthropic-ai/claude-code"
AGENT_CLIS=""
AGENT_CLIS_SET=0

# ---- output --------------------------------------------------------------
if [ -t 1 ]; then
	C_RESET=$(printf '\033[0m'); C_BOLD=$(printf '\033[1m')
	C_GREEN=$(printf '\033[32m'); C_YELLOW=$(printf '\033[33m'); C_RED=$(printf '\033[31m')
else
	C_RESET=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''
fi
info() { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$1"; }
ok()   { printf '%s  ok%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf '%swarn%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
die()  { printf '%serror%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; exit 1; }

usage() {
	sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
		--enable) ENABLE=1 ;;
		--skip-gh) INSTALL_GH=0 ;;
		--agent-cli)
			[ $# -ge 2 ] || die "--agent-cli needs an npm package name"
			AGENT_CLIS="$AGENT_CLIS $2"
			AGENT_CLIS_SET=1
			shift
			;;
		--no-agent-cli) AGENT_CLIS=""; AGENT_CLIS_SET=1 ;;
		--node-major)
			[ $# -ge 2 ] || die "--node-major needs a version"
			NODE_MAJOR=$2
			shift
			;;
		-h|--help) usage; exit 0 ;;
		*) die "unknown option: $1 (see --help)" ;;
	esac
	shift
done
[ "$AGENT_CLIS_SET" = 1 ] || AGENT_CLIS=$DEFAULT_AGENT_CLIS

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# ---- preflight -----------------------------------------------------------
[ "$(id -u)" = 0 ] || die "run it as root: sudo $0"
[ -f "$SCRIPT_DIR/maestro-cli.js" ] && [ -f "$SCRIPT_DIR/package.json" ] \
	|| die "run it from the unpacked server bundle (maestro-cli.js not found beside it)"
command -v apt-get >/dev/null 2>&1 || die "apt-get not found: this installer supports Debian and Ubuntu"
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] \
	|| die "systemd is not running on this host"
case "$(uname -m)" in
	x86_64) NODE_ARCH=x64 ;;
	aarch64|arm64) NODE_ARCH=arm64 ;;
	*) die "unsupported CPU: $(uname -m) (x86_64 and aarch64 are supported)" ;;
esac

# ---- system packages -----------------------------------------------------
info "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl git openssh-client tar gzip
ok "git $(git --version | cut -d' ' -f3)"

if [ "$INSTALL_GH" = 1 ]; then
	if command -v gh >/dev/null 2>&1; then
		ok "gh already installed"
	else
		install -m 0755 -d /etc/apt/keyrings
		curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
			-o /etc/apt/keyrings/githubcli-archive-keyring.gpg
		chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
		echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
			> /etc/apt/sources.list.d/github-cli.list
		apt-get update -q
		apt-get install -y -q --no-install-recommends gh
		ok "gh $(gh --version | head -n1 | cut -d' ' -f3)"
	fi
fi

# ---- user and directories ------------------------------------------------
info "Creating the maestro user and directories"
getent group maestro >/dev/null 2>&1 || groupadd --system maestro
if ! id maestro >/dev/null 2>&1; then
	useradd --system --gid maestro --home-dir "$STATE_DIR" --shell /bin/bash \
		--comment "Maestro Cue engine" maestro
fi
install -d -o maestro -g maestro -m 0750 "$STATE_DIR" "$DATA_DIR"
install -d -o maestro -g maestro -m 0750 "$WORK_DIR"
install -d -o root -g maestro -m 0750 "$CONF_DIR"
install -d -o root -g root -m 0700 "$CONF_DIR/credentials"
if [ ! -f "$CONF_DIR/maestro.env" ]; then
	install -o root -g maestro -m 0640 /dev/null "$CONF_DIR/maestro.env"
	cat > "$CONF_DIR/maestro.env" <<'EOF'
# Environment for the maestro-cue service. One KEY=value per line.
# Readable by root and the maestro group only.
#ANTHROPIC_API_KEY=
#OPENAI_API_KEY=
#GH_TOKEN=
EOF
fi
ok "user maestro, data $DATA_DIR, workspaces $WORK_DIR, config $CONF_DIR"

# ---- Node.js -------------------------------------------------------------
# One Node.js for everything: the version check, the SQLite driver build, the
# agent CLIs and the service. A node on root's PATH alone is not enough: under
# a version manager it may sit where the maestro user cannot reach it.

# Major version of $1 as the maestro user runs it, or 0 when it cannot.
node_major_as_maestro() {
	runuser -u maestro -- "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

NODE_BIN=$(command -v node 2>/dev/null || true)
if [ -n "$NODE_BIN" ] && [ "$(node_major_as_maestro "$NODE_BIN")" -ge "$MIN_NODE_MAJOR" ]; then
	ok "Node.js $("$NODE_BIN" -v) at $NODE_BIN"
else
	if [ -n "$NODE_BIN" ]; then
		warn "$NODE_BIN is older than Node.js $MIN_NODE_MAJOR or not usable by the maestro user"
	fi
	info "Installing Node.js $NODE_MAJOR from nodejs.org"
	tmp=$(mktemp -d)
	base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
	curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
	file=$(grep -o "node-v[0-9.]*-linux-$NODE_ARCH\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n1)
	[ -n "$file" ] || die "no Node.js $NODE_MAJOR build for linux-$NODE_ARCH on nodejs.org"
	curl -fsSL "$base/$file" -o "$tmp/$file"
	(cd "$tmp" && grep "  $file\$" SHASUMS256.txt | sha256sum -c - >/dev/null) \
		|| die "checksum mismatch for $file"
	tar -xzf "$tmp/$file" -C /usr/local --strip-components=1 --no-same-owner \
		--exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'
	rm -rf "$tmp"
	NODE_BIN=/usr/local/bin/node
	[ "$(node_major_as_maestro "$NODE_BIN")" -ge "$MIN_NODE_MAJOR" ] \
		|| die "the maestro user cannot run $NODE_BIN"
	ok "Node.js $("$NODE_BIN" -v) at $NODE_BIN"
fi
NODE_DIR=$(dirname "$NODE_BIN")
NPM_BIN="$NODE_DIR/npm"
[ -x "$NPM_BIN" ] || NPM_BIN=$(command -v npm) || die "npm not found next to $NODE_BIN"
# npm's own scripts call `node`: make it this one.
PATH="$NODE_DIR:$PATH"
export PATH

# ---- agent CLIs ----------------------------------------------------------
if [ -n "$AGENT_CLIS" ]; then
	info "Installing agent CLIs:$AGENT_CLIS"
	# shellcheck disable=SC2086 # one word per package
	"$NPM_BIN" install -g --no-audit --no-fund --loglevel=error $AGENT_CLIS
	ok "installed into $("$NPM_BIN" prefix -g)/bin"
else
	warn "no agent CLI installed; install the one your agents use where the service can run it"
fi

# ---- the bundle ----------------------------------------------------------
version=$("$NODE_BIN" -p "require('$SCRIPT_DIR/package.json').version")
info "Installing maestro-server $version to $PREFIX"
staging="$PREFIX.new"
rm -rf "$staging"
mkdir -p "$staging"
cp -R "$SCRIPT_DIR"/. "$staging"/
rm -rf "$staging/node_modules"
# The wrapper runs this Node.js, the one better-sqlite3 is built for below.
sed "s|^NODE=node\$|NODE=$NODE_BIN|" "$SCRIPT_DIR/bin/maestro-cli" > "$staging/bin/maestro-cli"
chmod 0755 "$staging/bin/maestro-cli"
chown -R root:root "$staging"

sqlite_install() {
	(cd "$staging" && MAESTRO_SERVER_INSTALL=1 "$NPM_BIN" install --omit=dev --no-audit --no-fund --loglevel=error)
}
if ! sqlite_install; then
	warn "no prebuilt better-sqlite3 for this system; installing a compiler to build it"
	apt-get install -y -q --no-install-recommends python3 make g++
	sqlite_install || die "could not install better-sqlite3"
fi
(cd "$staging" && runuser -u maestro -- "$NODE_BIN" -e "new (require('better-sqlite3'))(':memory:').close()") \
	|| die "better-sqlite3 does not load under $NODE_BIN"

rm -rf "$PREFIX.old"
if [ -d "$PREFIX" ]; then mv "$PREFIX" "$PREFIX.old"; fi
mv "$staging" "$PREFIX"
rm -rf "$PREFIX.old"
ln -sf "$PREFIX/bin/maestro-cli" /usr/local/bin/maestro-cli
ok "maestro-cli $(MAESTRO_ALLOW_ROOT=1 maestro-cli --version)"

# ---- systemd -------------------------------------------------------------
info "Installing the maestro-cue service"
install -m 0644 "$PREFIX/maestro-cue.service" "$UNIT_PATH"
systemctl daemon-reload
# An upgrade restarts a running engine, --enable or not: the bundle it runs
# from has just been replaced.
if systemctl is-active --quiet maestro-cue; then
	systemctl restart maestro-cue
	ok "maestro-cue restarted on the new version"
fi
if [ "$ENABLE" = 1 ]; then
	systemctl enable --now maestro-cue
	ok "maestro-cue enabled and running"
elif ! systemctl is-active --quiet maestro-cue; then
	ok "maestro-cue installed (not started)"
fi

cat <<EOF

${C_BOLD}Next steps${C_RESET}
  1. Put agent API keys in $CONF_DIR/maestro.env, for example ANTHROPIC_API_KEY=...
     Secrets a bundle declares can also be files in $CONF_DIR/credentials,
     passed in with LoadCredential= (sudo systemctl edit maestro-cue).
  2. Clone each workspace, then import a pipeline bundle exported from the desktop app:
       sudo -H -u maestro git clone <repo-url> $WORK_DIR/<name>
       sudo -H -u maestro maestro-cli bundle import pipeline.zip --workspace <key>=$WORK_DIR/<name>
  3. For github.* triggers, log gh in as the maestro user (or set GH_TOKEN in the env file):
       sudo -H -u maestro gh auth login
  4. Check that every subscription has what it needs (it also reports an empty
     data directory as ready, so confirm it lists your agents):
       sudo -H -u maestro maestro-cli cue engine check
  5. Start it and follow the log:
       sudo systemctl enable --now maestro-cue
       journalctl -u maestro-cue -f
EOF
