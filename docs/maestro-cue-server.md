---
title: Running Cue on a Server
description: Run Maestro Cue pipelines and exported agents unattended on a Linux server or in a container, without the desktop app.
icon: server
---

Build a pipeline or an agent in the desktop app, export it as a bundle, and run it on a server. A pipeline runs under `maestro-cli cue engine`, with the same triggers, agents and chains as the desktop, with no window and no one logged in. An exported agent can also be run on demand with `maestro-cli send`, `playbook`, `run-doc` and `goal-run`.

This page goes in order: install, sign agents in, import, check, start, run an agent on demand, put webhooks behind a proxy, and operate the server.

## Before you start

- **Agents run unattended with full permissions.** Cue always runs agents in YOLO mode, and on a server nobody watches the run. Give the engine its own machine or container, the dedicated `maestro` user both installs create, and workspaces that hold nothing else.
- **Secrets never travel in a bundle.** A bundle carries the names of the secrets its agents and webhooks need, never the values. You supply each value on the server.
- **Sign agents in on the server.** Each provider is signed in on the server, either with an API key supplied as a secret or by running that provider's own login there, as the `maestro` user. Do not copy a login from your desktop.
- **Claude agents run in API mode.** The server bundle does not include the driver for Claude's TUI mode, so a Claude agent exported in TUI or Dynamic mode runs `claude --print` on the server.
- **Webhooks stay on loopback.** The webhook listener is never exposed directly. Public delivery goes through a reverse proxy or a tunnel (see [Webhooks behind a proxy](#webhooks-behind-a-proxy)).
- **One engine per data directory.** Do not point two servers or containers at the same data directory or volume.

On the desktop, export what the server will run:

```bash
maestro-cli bundle export --pipeline "Nightly Review" --output pipeline.zip
maestro-cli bundle export --agent "Coder" --output agent.zip
```

`maestro-cli bundle inspect pipeline.zip` lists the bundle's workspaces, agents and the secrets it needs. See [Sharing Pipelines and Agents](./maestro-cue-bundles) for what a bundle holds.

## Build the server bundle

From a Maestro checkout:

```bash
npm run build:server
```

This writes `dist/maestro-server-<version>.tgz`: the CLI, the prompt files it loads, the systemd unit, and the installer. The SQLite driver the engine needs is installed on the target, so the bundle works on both x86_64 and arm64.

The container build runs this step itself.

## Install

### Option 1: Linux VM with systemd

Debian 12, Ubuntu 22.04, or newer.

```bash
scp dist/maestro-server-<version>.tgz my-server:
ssh my-server
tar -xzf maestro-server-<version>.tgz
sudo ./maestro-server/install.sh
```

The installer adds git and the GitHub CLI, creates the `maestro` user, and picks one Node.js for everything: the one on PATH when it is 22 or newer and the `maestro` user can run it, otherwise Node.js 24 from nodejs.org. With that Node.js it installs Claude Code, the SQLite driver and the CLI, then installs the `maestro-cue` service without starting it.

| Option                      | What it does                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `--agent-cli <npm package>` | Agent CLI to install instead of Claude Code. Repeat it for several, for example `@openai/codex`. |
| `--no-agent-cli`            | Install no agent CLI                                                                             |
| `--skip-gh`                 | Leave out the GitHub CLI                                                                         |
| `--node-major <N>`          | Node.js major version to install when the one on PATH is not usable (default 24)                 |
| `--enable`                  | Enable and start the service once there is something to run (see [Check](#check))                |

The installer exits 0 when done, 1 on an error, and 3 when everything was installed but `--enable` was refused because nothing is imported yet.

| Path                                      | What it holds                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `/opt/maestro`                            | The CLI and its SQLite driver                                                       |
| `/usr/local/bin/maestro-cli`              | Wrapper that runs the CLI against the server's data directory                       |
| `/var/lib/maestro`                        | Home of the `maestro` user: provider logins, `gh` config                            |
| `/var/lib/maestro/data`                   | The Maestro data directory: agents, playbooks, `cue.db`                             |
| `/srv/maestro`                            | Workspaces                                                                          |
| `/etc/maestro/maestro.env`                | Environment variables for the service (readable by root and the `maestro` group)    |
| `/etc/maestro/credentials`                | Secret files for `LoadCredential=` (root only)                                      |
| `/etc/systemd/system/maestro-cue.service` | The service. The installer replaces it on upgrade, so keep your changes in drop-ins |

Run every `maestro-cli` command as the `maestro` user (`sudo -H -u maestro maestro-cli ...`). The wrapper refuses to run as root, because files root writes into the data directory are unreadable to the engine.

### Option 2: Container

Build the image from the repository root:

```bash
docker build -f packaging/server/Dockerfile -t maestro-cue .
```

| Build argument | Default                     | What it does                                                                                    |
| -------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `AGENT_CLIS`   | `@anthropic-ai/claude-code` | Agent CLIs to install, as npm package names separated by spaces. Add `@openai/codex` and so on. |
| `NODE_VERSION` | `24`                        | Node.js major version of the base image                                                         |

The image runs as the `maestro` user under `tini`, with git and the GitHub CLI. Its entrypoint is `maestro-cli`, so `docker run maestro-cue <verb>` runs one CLI command. It has two volumes:

| Volume             | What it holds                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `/var/lib/maestro` | Home of the `maestro` user (provider logins, `gh` config) and the data directory (`data/`) |
| `/srv/maestro`     | Workspaces                                                                                 |

Use named volumes (`maestro-home` and `maestro-work` below). They outlive the container, so logins and imported agents survive a rebuild of the image.

`packaging/server/compose.yaml` has the same setup for Docker Compose. Put `maestro.env` beside it and run `docker compose up -d --build` from that folder once the steps below are done.

## Sign agents in

Each agent needs its provider's credential on the server. There are three ways to supply one; the table under [Per provider](#per-provider) says which apply to each provider.

| Way                                 | When to use it                                                          | Who receives it                                        |
| ----------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| A secret the agent declares         | The agent had the key in its own environment variables on the desktop   | That agent only                                        |
| A variable server mode lets through | A provider key in `maestro.env` or the container's environment          | Every Cue agent, whatever its provider                 |
| The provider's own login            | The provider has a login that can finish on a machine without a browser | Every agent of that provider run as the `maestro` user |

### Declared secrets

When an agent sets a secret-looking variable on the desktop (a name containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH` or `SESSION`, or a value shaped like a known credential), the export keeps the name and drops the value. A Claude Code agent also declares every secret `${VAR}` its workspace's `.mcp.json` uses. `bundle inspect` lists them, and `bundle validate --check-env` on the server says which are set.

The engine looks each declared secret up in this order and gives the value to that agent alone:

1. `$CREDENTIALS_DIRECTORY/<NAME>`, a systemd credential (`LoadCredential=`)
2. `/run/secrets/<NAME>`, a Docker or Compose secret
3. the environment variable `<NAME>`

A file that exists is the answer even when it is empty or unreadable: the lookup reports the problem and does not fall back to the environment. The file name is exactly the variable name, and one trailing newline is dropped.

On a VM, put the value in a credential file and pass it to the service:

```bash
sudo install -m 0600 /dev/null /etc/maestro/credentials/ANTHROPIC_API_KEY
sudo nano /etc/maestro/credentials/ANTHROPIC_API_KEY
sudo systemctl edit maestro-cue
```

In the editor, add:

```ini
[Service]
LoadCredential=ANTHROPIC_API_KEY:/etc/maestro/credentials/ANTHROPIC_API_KEY
```

In a container, mount it as a secret at `/run/secrets/<NAME>` (see the commented `secrets:` block in `compose.yaml`), or pass it in the environment.

A credential file reaches only the agents that declare its name. A `/etc/maestro/credentials/ANTHROPIC_API_KEY` does nothing for an agent that did not declare `ANTHROPIC_API_KEY`; use a variable for that agent instead.

### Variables server mode lets through

The unit and the image set `MAESTRO_SERVER_MODE=1`, so a Cue agent does not inherit the service's whole environment, only:

- system variables (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR` and the like), proxy and TLS trust variables (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` and the like), and common toolchain homes;
- every name starting with `LC_`, `XDG_`, `SSH_` or `MAESTRO_`;
- the provider names Maestro knows: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `MAX_THINKING_TOKENS`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CODEX_HOME`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `FACTORY_API_KEY`, `FACTORY_PROJECT_DIR`, `FACTORY_DISABLE_KEYRING`, `FACTORY_LOG_FILE`, `COPILOT_HOME`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`;
- the names you list, comma separated, in `MAESTRO_SERVER_ENV_ALLOW`;
- the agent's declared secrets.

Everything else stays with the engine. A key that passes reaches the agents of every provider, not only its own. A provider key not in the list (for example an OpenCode `GEMINI_API_KEY`, or the AWS or Google credentials behind `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX`) needs a line such as:

```bash
MAESTRO_SERVER_ENV_ALLOW=GEMINI_API_KEY,AWS_PROFILE,AWS_REGION
```

On a VM these variables go in `/etc/maestro/maestro.env` (`sudo nano /etc/maestro/maestro.env`, one `KEY=value` per line). In a container they go in an env file passed with `--env-file maestro.env`, or `env_file` in Compose.

Cue `action: command` shell steps receive the same allowlist and no declared secrets. Name a variable in `MAESTRO_SERVER_ENV_ALLOW` if a step needs it.

### Provider logins

A login runs as the `maestro` user and is stored in its home, `/var/lib/maestro`. On a VM that directory survives restarts and upgrades; in a container it is the `maestro-home` volume, which survives rebuilds of the image.

On a VM, open a shell as the `maestro` user and run the login there:

```bash
sudo -iu maestro
claude          # then type /login and follow the link it prints
exit
```

In a container, run it against the home volume, before the engine starts or while it runs:

```bash
docker run --rm -it -v maestro-home:/var/lib/maestro --entrypoint claude maestro-cue
docker exec -it maestro-cue codex login --device-auth
```

A login suits a provider whose flow prints a link or a device code you can open on another computer. A flow that waits for a browser to call back to `localhost` cannot finish on a server you reach over SSH.

### Per provider

Cue can run every provider that has an output parser. Gemini CLI and Hermes have none: `cue engine check` reports an `unsupported-provider` gap for their agents, and the engine does not run them.

Readiness looks for each provider's binary on PATH; `bundle import --agent-path <agent id>=<path>` points it at another location.

| Provider (agent id)             | Binary      | Key or token                                                                                                                                 | Login on the server                                       | Login stored in                         |
| ------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------- |
| Claude Code (`claude-code`)     | `claude`    | `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` with `ANTHROPIC_AUTH_TOKEN` for a gateway                                                       | `claude`, then `/login`                                   | `~/.claude` (or `CLAUDE_CONFIG_DIR`)    |
| Codex (`codex`)                 | `codex`     | `OPENAI_API_KEY` (see the notes)                                                                                                             | `codex login --device-auth`                               | `~/.codex/auth.json` (or `CODEX_HOME`)  |
| OpenCode (`opencode`)           | `opencode`  | The key of the model provider it uses. `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` pass; any other `*_API_KEY` needs `MAESTRO_SERVER_ENV_ALLOW` | `opencode auth login`                                     | OpenCode's folder under `XDG_DATA_HOME` |
| Factory Droid (`factory-droid`) | `droid`     | `FACTORY_API_KEY`                                                                                                                            | Browser only (`droid`, then `/login`): use the key        | -                                       |
| Copilot-CLI (`copilot-cli`)     | `copilot`   | `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`                                                                                 | `copilot login`                                           | `~/.copilot` (or `COPILOT_HOME`)        |
| Antigravity CLI (`antigravity`) | `agy`       | Not verified                                                                                                                                 | Run `agy` once and sign in; later runs reuse that sign-in | Not verified                            |
| Qwen3 Coder (`qwen3-coder`)     | `qwen`      | Not verified                                                                                                                                 | `qwen`, then `/auth`                                      | Not verified                            |
| Pi (`pi`), Oh My Pi (`omp`)     | `pi`, `omp` | The model provider's key; which names they read is not verified                                                                              | None that Maestro knows of                                | -                                       |
| Grok CLI (`grok`)               | `grok`      | Not verified                                                                                                                                 | `grok login`                                              | Not verified                            |

Notes:

- **Claude Code.** An API key takes precedence over a login. For Bedrock or Vertex, set `CLAUDE_CODE_USE_BEDROCK=1` or `CLAUDE_CODE_USE_VERTEX=1` and add the cloud credentials' names to `MAESTRO_SERVER_ENV_ALLOW`. The installer and the image install Claude Code by default.
- **Codex.** Whether a given Codex version reads `OPENAI_API_KEY` from the environment on its own is not verified here. Codex documents storing a key with its login instead, `printenv OPENAI_API_KEY | codex login --with-api-key`, run as the `maestro` user (not verified here). Either way the result is kept in `~/.codex/auth.json`.
- **Copilot-CLI.** `GH_TOKEN` and `GITHUB_TOKEN` are also what `gh` and Cue's GitHub triggers use, and in `maestro.env` they reach every agent. Give Copilot its own `COPILOT_GITHUB_TOKEN`, and keep Cue's GitHub token in a credential file (next section).
- **Rows marked "Not verified".** Maestro knows the login command, but not which variable the CLI reads or where it stores the login. Check that provider's documentation, then prove the sign-in with one turn (see [Run an exported agent on demand](#run-an-exported-agent-on-demand)).

### GitHub for Cue triggers

`github.*` triggers call `gh`. Cue hands `gh` a token from `GH_TOKEN` or `GITHUB_TOKEN`, looked up the same way as a declared secret (credential file, `/run/secrets`, environment); without one, `gh` uses its own login.

- **A token file** keeps the token away from agents: `/etc/maestro/credentials/GH_TOKEN` with `LoadCredential=GH_TOKEN:/etc/maestro/credentials/GH_TOKEN`, or a `GH_TOKEN` Docker secret. It is read again on every poll, so a rotated file takes effect without a restart, and it takes precedence over `gh auth login`.
- **A login:** `sudo -iu maestro` then `gh auth login`, or `docker exec -it maestro-cue gh auth login`. It is kept in the `maestro` user's home.
- **`GH_TOKEN` in `maestro.env`** works too, but every agent receives it.

## Import

Each workspace in a bundle is bound to a folder that must already exist, usually a clone of the project. Each workspace needs its own folder: mapping two workspaces to the same folder (directly or through a symlink) is refused, since both would write the same `cue.yaml`. A workspace folder may sit inside another one's, as long as no two bundle files land on the same path. `bundle inspect` lists the workspace keys. `bundle import --dry-run` prints the plan, including every shell command the bundle runs, and writes nothing.

### Import on a VM

```bash
# The workspace the agents work in
sudo -H -u maestro git clone https://github.com/acme/app.git /srv/maestro/app

# A pipeline
sudo -H -u maestro maestro-cli bundle import /tmp/pipeline.zip --workspace app=/srv/maestro/app

# An agent, with its playbooks and Auto Run documents
sudo -H -u maestro maestro-cli bundle import /tmp/agent.zip --workspace app=/srv/maestro/app
```

The zip must be readable by the `maestro` user, so copy it somewhere like `/tmp` first.

### Import in a container

```bash
docker run --rm -v maestro-work:/srv/maestro --entrypoint git \
  maestro-cue clone https://github.com/acme/app.git /srv/maestro/app

docker run --rm \
  -v maestro-home:/var/lib/maestro -v maestro-work:/srv/maestro \
  -v "$PWD/pipeline.zip:/tmp/pipeline.zip:ro" \
  maestro-cue bundle import /tmp/pipeline.zip --workspace app=/srv/maestro/app

docker run --rm \
  -v maestro-home:/var/lib/maestro -v maestro-work:/srv/maestro \
  -v "$PWD/agent.zip:/tmp/agent.zip:ro" \
  maestro-cue bundle import /tmp/agent.zip --workspace app=/srv/maestro/app
```

Then list what landed:

```bash
sudo -H -u maestro maestro-cli list agents
sudo -H -u maestro maestro-cli list playbooks

docker run --rm -v maestro-home:/var/lib/maestro maestro-cue list agents
```

## Check

`cue engine check` checks everything the engine needs to run the imported subscriptions, without starting it: each agent's binary, declared secrets and workspace, `cue.yaml`, webhook secrets, `gh` and `git` for GitHub triggers, and that there is something to run. It lists every gap and exits 0 when ready, 1 when not.

```bash
# VM, with the service's env file loaded
sudo -H -u maestro sh -c 'set -a; . /etc/maestro/maestro.env; set +a; exec maestro-cli cue engine check'

# Container
docker run --rm --env-file maestro.env \
  -v maestro-home:/var/lib/maestro -v maestro-work:/srv/maestro \
  maestro-cue cue engine check
```

- **Secrets in credential files.** On a VM, `LoadCredential=` files are visible to the service alone, so a check from a shell reports them as missing. The service runs the same check when it starts (`--require-ready`) and logs every gap it still finds.
- **Disabled subscriptions are ignored.** A subscription with `enabled: false` adds no gap: it needs no `gh`, webhook secret, provider binary or target agent until it is enabled. A `cue.yaml` that does not parse is still reported.
- **One owner per workspace.** When several agents share a workspace, only the owner runs its unpinned subscriptions, so only the owner is checked for them: the agent named by `settings.owner_agent_id` (id, or display name), else the first agent listed. If `owner_agent_id` matches no agent there, or more than one by name, the engine runs none of them and the check reports it as a `cue-config` gap naming the setting and the workspace. A subscription with `agent_id` runs only on that agent, and only when the agent's own workspace holds it; one pinned to an agent in another workspace is reported as `unknown-agent`.
- **Nothing to run.** A data directory with no agents, or with agents but no enabled subscription on any of them, has a `nothing-to-run` gap: the check exits 1, `--require-ready` refuses to start, and `/readyz` answers 503. That is almost always a bundle that was never imported. An exported agent brings its own subscriptions, if it had any. A server that only runs agents on demand needs no engine: leave the service off.
- **`install.sh --enable`** runs the check before it enables the service. On `nothing-to-run` it still installs everything, leaves the service disabled, says why, and exits 3. Any other gap is left to the service, which judges secrets in its own environment.
- **Not checked:** whether a provider or `gh` is signed in. Run one turn to prove a sign-in (see [Run an exported agent on demand](#run-an-exported-agent-on-demand)).

## Start

### Start on a VM

```bash
sudo systemctl enable --now maestro-cue
journalctl -u maestro-cue -f
```

The unit runs `maestro-cli cue engine start --data-dir /var/lib/maestro/data --status-port 7433 --require-ready --log-format json --drain-timeout 90` as the `maestro` user, with `/etc/maestro/maestro.env` as its environment.

- It is ready (`systemctl status` shows `active`) once agents are loaded, the lock is held and triggers are armed. A missing agent binary, secret or `gh` stops the start, and the log lists every gap. Start-up may take up to 60 seconds.
- A watchdog restarts it if the engine stops answering for 30 seconds or loses its lock to another engine, and it restarts after a crash.
- It runs with a read-only system. Only `/var/lib/maestro` and `/srv/maestro` are writable. For workspaces elsewhere, add a drop-in with `sudo systemctl edit maestro-cue`:

```ini
[Service]
ReadWritePaths=/home/me/projects
```

### Start in a container

```bash
docker run -d --name maestro-cue --restart unless-stopped --stop-timeout 120 \
  --env-file maestro.env \
  -v maestro-home:/var/lib/maestro -v maestro-work:/srv/maestro \
  -p 127.0.0.1:17997:17997 \
  maestro-cue
```

The image starts the engine with the same flags as the unit and runs in server mode the same way.

- **Stop timeout.** The engine drains active runs for up to 90 seconds on stop, but `docker stop` waits only 10 seconds by default. Use `--stop-timeout 120` (or `docker stop -t 120`), or `stop_grace_period: 120s` in Compose. The image runs `tini` without `-g`, so the stop signal reaches the engine alone and runs in flight can finish.
- **One engine per volume.** A second engine started on the same data volume, in another container, sees the first one's lock while its heartbeat is fresh, logs `Another Cue engine (...) already holds the lock` and exits 1.
- **Restart after a hard kill.** If the engine is killed without stopping (`docker kill`, out of memory, a host crash), its lock stays behind. A new container waits for that lock to go quiet: the engine refuses to start for up to 3 minutes, and the restart policy brings it back after that.
- **Health.** The image's health check calls `/healthz` on the engine's status port, 7433, inside the container. `docker ps` shows `healthy` once it answers.
- **Webhook port.** Inside the container the webhook listener listens on all interfaces so the port can be published. Publish it to the host's loopback only (`127.0.0.1:17997:17997`), as above.

## Run an exported agent on demand

An imported agent can be run from the command line, with or without the engine running. These commands run one agent once and return; the engine runs subscriptions whenever their triggers fire.

| Command                                   | What it runs                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `send <agent> "<message>"`                | One turn in a new provider session. Prints JSON with `sessionId` and `response`                  |
| `send <agent> "<message>" --session <id>` | One more turn in that session                                                                    |
| `playbook <playbook-id>`                  | A saved playbook, including one the bundle brought                                               |
| `run-doc <docs...> --agent <agent>`       | Auto Run over one or more documents, without a saved playbook                                    |
| `goal-run <agent> "<goal>"`               | A goal-driven Auto Run. Leave out `--visible` and `--wait`: they hand the run to the desktop app |

`<agent>` is the agent's id or a unique id prefix (`list agents` shows them). `send --read-only` runs the turn in plan mode. `playbook`, `run-doc` and `goal-run` take `--json` for one JSON event per line, `--model` and `--effort` for this run only, and `--no-history` to write no history entry.

**On a VM**, a command you type gets your shell's environment, not the service's. This shell function runs `maestro-cli` as the `maestro` user with the env file loaded:

```bash
mrun() { sudo -H -u maestro sh -c 'set -a; . /etc/maestro/maestro.env; set +a; exec maestro-cli "$@"' maestro-cli "$@"; }

mrun send <agent> "Reply with the word OK" --read-only
mrun send <agent> "Now list the files you would change" --session <sessionId>
mrun list playbooks --agent <agent>
mrun playbook <playbook-id> --json
mrun run-doc /srv/maestro/app/docs/release-checklist.md --agent <agent> --json
mrun goal-run <agent> "Make the test suite pass" --exit-criteria "npm test exits 0" --max-iterations 5 --json
```

`mrun` lives in your shell session only; nothing installs it. The env file is read as shell code here, so quote any value in it that has spaces or `$`. An agent signed in with a provider login needs none of this.

**In a container**, `docker exec` runs with the container's environment and secrets:

```bash
docker exec maestro-cue maestro-cli send <agent> "Reply with the word OK" --read-only
docker exec maestro-cue maestro-cli playbook <playbook-id> --json
```

With no engine container running, use `docker run --rm` instead:

```bash
docker run --rm --env-file maestro.env \
  -v maestro-home:/var/lib/maestro -v maestro-work:/srv/maestro \
  maestro-cue send <agent> "Reply with the word OK" --read-only
```

How an on-demand run differs from an engine run:

- **Environment.** An on-demand run passes the command's whole environment to the agent; server mode filters only what the engine passes. Declared secrets are looked up the same way, but on a VM the service's `LoadCredential=` files are not visible to the command, so supply those as variables or use a provider login.
- **Records.** Each turn is recorded in the data directory's run ledger with its token usage. `playbook`, `run-doc` and `goal-run` also write history entries; `send` writes none.
- **No triggers.** Nothing fires on its own. To fire a subscription by hand while the engine runs, use `maestro-cli cue trigger <subscription-name>`.

## Webhooks behind a proxy

`webhook.received` subscriptions, and GitHub triggers that take webhooks, are served by one listener on `127.0.0.1:17997` at `/cue/<path>`. Do not expose that port. Put a reverse proxy or a tunnel in front of it that:

- forwards `POST /cue/...` to `http://127.0.0.1:17997` with the path unchanged;
- passes the body byte for byte, since signatures are computed over the raw body;
- passes the signature header (`X-Hub-Signature-256` for GitHub, or the `signature_header` the subscription names), `X-Maestro-Cue-Secret` or `Authorization` for senders that present the secret, and the delivery id headers `X-GitHub-Delivery`, `X-Request-Id` and `X-Maestro-Delivery`;
- does not set `X-Request-Id` itself. The listener uses it as the delivery id when the sender sends no `X-GitHub-Delivery`, and a new id on every request defeats the protection against repeats;
- allows a body of 1 MiB, the listener's cap (it answers `413` above that);
- waits long enough for the answer. The listener answers only after it has handled the delivery (see [What a 2xx means](#what-a-2xx-means)). 60 seconds is ample; GitHub itself gives up after 10.

See `webhook.received` and GitHub webhooks in [Cue Event Types](./maestro-cue-events) for the subscription side.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name hooks.example.com;
    ssl_certificate     /etc/letsencrypt/live/hooks.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hooks.example.com/privkey.pem;

    location /cue/ {
        proxy_pass http://127.0.0.1:17997;
        proxy_http_version 1.1;
        client_max_body_size 1m;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    location / {
        return 404;
    }
}
```

`proxy_pass` has no path after the port, so nginx passes the request path as the client sent it. nginx passes the request headers and the body unchanged by default.

### Caddy

```caddyfile
hooks.example.com {
	handle /cue/* {
		request_body {
			max_size 1MiB
		}
		reverse_proxy 127.0.0.1:17997 {
			transport http {
				response_header_timeout 60s
			}
		}
	}
	handle {
		respond 404
	}
}
```

Caddy gets and renews the certificate itself.

### A tunnel

With no public address, a tunnel carries deliveries to the loopback port. For a quick test with cloudflared or ngrok:

```bash
cloudflared tunnel --url http://127.0.0.1:17997
ngrok http 127.0.0.1:17997
```

Each prints a public https URL; the payload URL is that URL plus `/cue/<path>`. For a permanent setup, use a named cloudflared tunnel with an ingress rule from your hostname to `http://127.0.0.1:17997`. Their body limits are above 1 MiB, so the listener's `413` is the limit that applies.

### The container case

The container publishes the listener to the host's loopback (`127.0.0.1:17997:17997`), so a proxy or tunnel on the host uses the configurations above unchanged. A proxy running in another container on the same Compose network can reach `http://maestro-cue:17997` instead, and then the port need not be published at all.

### Test it

Sign a body with the subscription's secret and send it through the proxy:

```bash
SECRET='the value of the secret_env variable'
body='{"hello":"world"}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -i https://hooks.example.com/cue/<path> \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=$sig" \
  -H 'X-Maestro-Delivery: test-1' \
  --data-binary "$body"
```

For a subscription without `signature_header`, send the secret in `X-Maestro-Cue-Secret` (or `Authorization: Bearer <secret>`) instead of the signature.

| Answer | Meaning                                                                                   |
| ------ | ----------------------------------------------------------------------------------------- |
| `202`  | Handled: the run has started or is queued, or the delivery was dropped on purpose         |
| `200`  | That delivery id was already handled, so nothing fires. Use a new id to test again        |
| `401`  | The signature or secret does not match. Check the secret and that the body is unchanged   |
| `404`  | No subscription listens on that path                                                      |
| `405`  | Not a `POST`                                                                              |
| `413`  | The body is over 1 MiB                                                                    |
| `503`  | Cue is off or stopping. Nothing was recorded; retry after the `Retry-After` seconds       |
| `502`  | From the proxy: no listener, because the engine is stopped or has no webhook subscription |

### What a 2xx means

Maestro acknowledges a delivery (answers `2xx`) only after it has handled it: its run has started or is queued, or it was dropped on purpose (a `filter` that does not match, or a SusFactor block, which is recorded). Once a sender has a `2xx`:

- A crash (`kill -9`, out of memory, a host reboot) followed by a restart loses nothing. A queued delivery runs after the restart; a run that was in progress is marked failed at the next start.
- `systemctl stop` and `docker stop` drain: a delivery still being checked when the stop begins is finished and queued for the next start, within the drain timeout.
- A redelivery of the same id fires nothing for 24 hours, and a GitHub change seen by both a webhook and a poll fires once.

Before the `2xx`, nothing is recorded. A crash while Maestro is still checking a delivery leaves the sender without an answer, and its retry fires once. GitHub does not retry on its own; the GitHub trigger's poll finds the change instead, or use **Redeliver**.

### Limits

- While Cue is off or stopping, including after a second stop signal cuts the drain short, a delivery is answered `503` with `Retry-After: 30` and nothing is recorded, so the sender should retry. A stopped engine has no listener at all, and the connection is refused (a proxy answers `502`).
- The SusFactor check runs before the answer, so a slow 0DIN call delays it (each call gives up after 3 to 5 seconds). A sender that stops waiting first (GitHub waits 10 seconds) records a failure although the delivery runs; its retry is then a duplicate and fires nothing.
- A full queue drops its oldest event, and `queue_size: 0` drops a delivery that arrives while the agent is busy. A subscription with no prompt, or a fan-out target that does not exist, does not run. Each of these is logged, and the delivery still counts as handled.
- After a crash (not a drain), a queued delivery that has waited longer than its subscription's `timeout_minutes` by the time Maestro is back is dropped as stale and shown as timed out in the activity log. A drain stamps the queue so that rule does not apply.
- The delivery id is recorded in the same step that hands the delivery on. A crash at exactly that instant can let one redelivery fire again.
- A sender that sends no delivery id header (`X-GitHub-Delivery`, `X-Request-Id` or `X-Maestro-Delivery`) gets no protection against repeats.

## Operate

### Health and status

The engine answers on `127.0.0.1:7433`, reachable only from the same host (or, for the container, from inside it). Never proxy this port: its endpoints have no authentication.

| Endpoint       | Answers                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz` | `200` while the engine holds its lock and responds; `503` once it lost the lock (restart it)                         |
| `GET /readyz`  | `200` once it is running with no readiness gap; `503` while starting, draining, after losing its lock, or with a gap |
| `GET /status`  | Phase, active runs, queue depth and readiness                                                                        |

```bash
# VM
curl -s http://127.0.0.1:7433/readyz

# Container (the image has no curl)
docker exec maestro-cue node -e "fetch('http://127.0.0.1:7433/status').then(r=>r.text()).then(console.log)"
```

`maestro-cli cue engine status` and `maestro-cli cue engine inspect` report the engine's lock, heartbeat and event count from the data directory. They open the database read-only and change nothing on disk, so they are safe to run next to a live engine, as another user too. If the database cannot be read, they still show the lock and say why the figures are missing.

### Logs

The engine logs one JSON object per line. On a VM they go to the journal (`journalctl -u maestro-cue`), in a container to `docker logs maestro-cue`.

### Stop

`sudo systemctl stop maestro-cue` and `docker stop -t 120 maestro-cue` drain: new events are queued, active runs get up to 90 seconds to finish, and whatever is queued runs after the next start. A run still starting when it is stopped (loading, or waiting on its SSH connection) is cancelled and never starts its agent, and the engine waits for it before it exits. A second stop signal cuts the drain short. A script that stops the engine with `maestro-cli cue engine stop` should pass `--wait-ms 120000`, since that command waits only 5 seconds by default.

### Sleep and pause

If the host sleeps or the engine is paused (a VM suspend, a closed laptop lid, `kill -STOP`) for 2 minutes or more, the engine notices within 30 seconds of waking and catches up: each interval (`time.heartbeat`) and scheduled (`time.scheduled`) trigger that came due during the gap runs once, however many times it came due, and GitHub triggers poll straight away. The log shows one `Sleep detected` line with the length of the gap. A clock set backward catches up nothing, and neither does an engine that is stopping.

### Add or replace agents and pipelines

Stop the engine, import, check, and start it again:

```bash
# VM
sudo systemctl stop maestro-cue
sudo -H -u maestro maestro-cli bundle import /tmp/new.zip --workspace app=/srv/maestro/app
sudo -H -u maestro sh -c 'set -a; . /etc/maestro/maestro.env; set +a; exec maestro-cli cue engine check'
sudo systemctl start maestro-cue

# Container
docker stop -t 120 maestro-cue
docker run --rm \
  -v maestro-home:/var/lib/maestro -v maestro-work:/srv/maestro \
  -v "$PWD/new.zip:/tmp/new.zip:ro" \
  maestro-cue bundle import /tmp/new.zip --workspace app=/srv/maestro/app
docker start maestro-cue
```

An agent, subscription or file that already exists is a conflict: the import stops before writing and lists it. Run it again with `--force` to replace it with the bundle's version. Sign in any new provider before the start.

### Upgrade

**VM.** Unpack a newer bundle and run its `install.sh` again. The data directory, workspaces, env file, credentials and logins are kept, and a running service is restarted on the new version. The installer replaces the unit file, so keep your changes in drop-ins.

**Container.** Rebuild the image and replace the container; the volumes keep the data directory and the logins.

```bash
docker build -f packaging/server/Dockerfile -t maestro-cue .
docker stop -t 120 maestro-cue
docker rm maestro-cue
```

Then start it with the same `docker run -d` command as in [Start](#start-in-a-container). With Compose, `docker compose up -d --build` does both.
