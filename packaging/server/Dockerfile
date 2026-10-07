# syntax=docker/dockerfile:1
#
# Maestro Cue engine, headless. Build from the repository root:
#
#   docker build -f packaging/server/Dockerfile -t maestro-cue .
#
# Agent CLIs are chosen at build time (npm package names, space separated):
#
#   docker build -f packaging/server/Dockerfile \
#     --build-arg AGENT_CLIS="@anthropic-ai/claude-code @openai/codex" -t maestro-cue .
#
# Running it, volumes, secrets and the stop timeout: docs/maestro-cue-server.md.

ARG NODE_VERSION=24

# 1. The server bundle: the CLI, its prompts, and a package.json pinning
#    better-sqlite3. This stage only runs esbuild, so install scripts are
#    skipped: the recipe's full `npm ci` (docs/agent-guides/CLI-HEADLESS.md)
#    also compiles build-only native devDependencies, and lzma-native has no
#    linux-arm64 prebuild and does not compile there. The runtime stage below
#    runs better-sqlite3's install script, and patch-package is run here when
#    the repo carries patches, as postinstall would.
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN if [ -d patches ]; then npx patch-package; fi && npm run build:server

# 2. better-sqlite3 for this Node and architecture: the recipe's runtime stage,
#    reduced to the one native module maestro-cli.js loads. It installs from a
#    prebuild on glibc x64 and arm64, so no compiler is needed.
FROM node:${NODE_VERSION}-bookworm-slim AS sqlite
WORKDIR /opt/maestro
COPY --from=build /src/dist/server/maestro-server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
	&& node -e "new (require('better-sqlite3'))(':memory:').close()"

# 3. Runtime.
FROM node:${NODE_VERSION}-bookworm-slim
ARG AGENT_CLIS="@anthropic-ai/claude-code"
ARG DEBIAN_FRONTEND=noninteractive

# git and gh for agents and github.* triggers (gh from GitHub's apt
# repository), tini to forward stop signals to the engine and reap zombies.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git openssh-client tini \
	&& install -m 0755 -d /etc/apt/keyrings \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
		-o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

RUN if [ -n "$AGENT_CLIS" ]; then \
		npm install -g --no-audit --no-fund $AGENT_CLIS && npm cache clean --force; \
	fi

# /var/lib/maestro is the maestro user's home (agent logins, gh config) and
# holds the data directory; /srv/maestro holds the workspaces.
RUN groupadd --system maestro \
	&& useradd --system --gid maestro --home-dir /var/lib/maestro --shell /bin/bash maestro \
	&& mkdir -p /var/lib/maestro/data /srv/maestro \
	&& chown -R maestro:maestro /var/lib/maestro /srv/maestro \
	&& chmod 0750 /var/lib/maestro

COPY --from=build /src/dist/server/maestro-server /opt/maestro
COPY --from=sqlite /opt/maestro/node_modules /opt/maestro/node_modules
RUN ln -s /opt/maestro/bin/maestro-cli /usr/local/bin/maestro-cli

# The webhook listener binds loopback by default, which is unreachable from
# outside the container's own network namespace. Inside the container it
# listens on all interfaces; what is exposed is decided when publishing the
# port (publish it to the host's loopback and put a proxy in front).
# Server mode: agents inherit only an allowlist of the container's environment
# (system variables, proxies, provider keys such as ANTHROPIC_API_KEY, and the
# names in MAESTRO_SERVER_ENV_ALLOW), plus the secrets their bundle declared.
ENV MAESTRO_USER_DATA=/var/lib/maestro/data \
	MAESTRO_CUE_WEBHOOK_HOST=0.0.0.0 \
	MAESTRO_SERVER_MODE=1

USER maestro
WORKDIR /var/lib/maestro
VOLUME ["/var/lib/maestro", "/srv/maestro"]
EXPOSE 17997

# Node rather than curl, so the probe does not depend on an extra tool.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:7433/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# The engine drains for up to 90 s on SIGTERM. `docker stop` waits only 10 s
# by default: use `docker stop -t 120` or compose's stop_grace_period.
STOPSIGNAL SIGTERM
# tini WITHOUT -g: agents share the engine's process group, so -g would hand
# docker stop's SIGTERM to every agent and kill the runs the drain is waiting
# for. tini still reaps zombies without it.
ENTRYPOINT ["/usr/bin/tini", "--", "maestro-cli"]
CMD ["cue", "engine", "start", "--data-dir", "/var/lib/maestro/data", "--status-port", "7433", "--require-ready", "--log-format", "json", "--drain-timeout", "90"]
