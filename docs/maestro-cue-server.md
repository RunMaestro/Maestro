---
title: Running Cue on a Server
description: Run Maestro Cue pipelines unattended on a Linux server or in a container, without the desktop app.
icon: server
---

Build a pipeline in the desktop app, export it as a bundle, and run it on a server with `maestro-cli cue engine`. The engine runs the same triggers, agents and chains as the desktop, with no window and no one logged in.

There are two ways to install it: a Linux VM with systemd, or a container. Both use the same server bundle and the same engine flags.

## Before you start

- **Agents run unattended with full permissions.** Cue always runs agents in YOLO mode, and on a server nobody watches the run. Give the engine its own machine or container, the dedicated `maestro` user both installs create, and workspaces that hold nothing else.
- **Use agents in API mode.** Put the provider's API key in the environment (for example `ANTHROPIC_API_KEY`). Claude's TUI mode is not available on a server.
- **One engine per data directory.** Do not point two servers or containers at the same data directory or volume.
- **Export the pipeline from the desktop app** with `maestro-cli bundle export --pipeline <name> --output pipeline.zip`. See the [CLI reference](./cli-reference) for `bundle export` and `bundle import`.

## Build the server bundle

From a Maestro checkout:

```bash
npm run build:server
```

This writes `dist/maestro-server-<version>.tgz`: the CLI, the prompt files it loads, the systemd unit, and the installer. The SQLite driver the engine needs is installed on the target, so the bundle works on both x86_64 and arm64.

The container build runs this step itself.

## Option 1: Linux VM with systemd

Debian 12, Ubuntu 22.04, or newer.

```bash
scp dist/maestro-server-<version>.tgz my-server:
ssh my-server
tar -xzf maestro-server-<version>.tgz
sudo ./maestro-server/install.sh
```

The installer adds git and the GitHub CLI, creates the `maestro` user, and picks one Node.js for everything: the one on PATH when it is 22 or newer and the `maestro` user can run it, otherwise Node.js 24 from nodejs.org. With that Node.js it installs Claude Code, the SQLite driver and the CLI, then installs the `maestro-cue` service without starting it. Run it with `--help` for its options: `--enable` starts the service, `--agent-cli <npm package>` picks the agent CLIs instead of Claude Code (repeat it, for example `--agent-cli @openai/codex`), `--no-agent-cli` installs none, and `--skip-gh` leaves out the GitHub CLI.

| Path                                      | What it holds                                                      |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `/opt/maestro`                            | The CLI and its SQLite driver                                      |
| `/usr/local/bin/maestro-cli`              | Wrapper that runs the CLI against the server's data directory      |
| `/var/lib/maestro`                        | Home of the `maestro` user: agent logins, `gh` config              |
| `/var/lib/maestro/data`                   | The Maestro data directory: agents, playbooks, `cue.db`            |
| `/srv/maestro`                            | Workspaces                                                         |
| `/etc/maestro/maestro.env`                | API keys and other environment variables (root and `maestro` only) |
| `/etc/maestro/credentials`                | Secret files for `LoadCredential=` (root only)                     |
| `/etc/systemd/system/maestro-cue.service` | The service                                                        |

Then set it up as the `maestro` user. Each workspace in the bundle (`bundle inspect` lists their keys) is bound to a folder that must already exist, usually a clone of the project. The wrapper refuses to run as root, because files root writes into the data directory are unreadable to the engine.

```bash
# 1. API keys
sudo nano /etc/maestro/maestro.env        # ANTHROPIC_API_KEY=...

# 2. The workspace (the project the agents work in), then the pipeline
sudo -H -u maestro git clone https://github.com/acme/app.git /srv/maestro/proj
sudo -H -u maestro maestro-cli bundle import pipeline.zip --workspace proj=/srv/maestro/proj

# 3. GitHub, for github.* triggers (or set GH_TOKEN in the env file)
sudo -H -u maestro gh auth login

# 4. Check every subscription has its agent binary, secrets and tools
sudo -H -u maestro maestro-cli cue engine check

# 5. Start
sudo systemctl enable --now maestro-cue
journalctl -u maestro-cue -f
```

`cue engine check` also reports an empty data directory as ready, so confirm it lists your agents (`--json` has `agents` and `subscriptions`).

**How the service behaves:**

- It is ready (`systemctl status` shows `active`) once agents are loaded, the lock is held and triggers are armed. With `--require-ready`, which the unit passes, a missing agent binary, secret or `gh` stops the start and the log lists every gap. Start-up may take up to 60 seconds.
- A watchdog restarts it if the engine stops answering for 30 seconds, or loses its lock to another engine, and it restarts after a crash.
- `systemctl stop` drains: new events are queued, active runs get up to 90 seconds to finish, and whatever is queued runs after the next start. The unit allows 120 seconds in total. A script that stops it with `maestro-cli cue engine stop` should pass `--wait-ms 120000`, since that waits only 5 seconds by default.
- It runs with a read-only system. Only `/var/lib/maestro` and `/srv/maestro` are writable. For workspaces elsewhere, add a drop-in with `sudo systemctl edit maestro-cue`:

```ini
[Service]
ReadWritePaths=/home/me/projects
```

**Secrets as files.** A secret can live in `/etc/maestro/credentials/<NAME>` instead of the env file, and be passed in by name:

```ini
[Service]
LoadCredential=GH_WEBHOOK_SECRET:/etc/maestro/credentials/GH_WEBHOOK_SECRET
LoadCredential=ANTHROPIC_API_KEY:/etc/maestro/credentials/ANTHROPIC_API_KEY
```

The engine looks for each secret in this order: the credentials directory, `/run/secrets/<NAME>`, then the environment. A file is the safer channel: it is not visible in the process environment, and each agent receives only the secrets its bundle declared. Shell command steps receive none; name a variable in `MAESTRO_SERVER_ENV_ALLOW` if a step needs it.

The same lookup covers a webhook's `secret_env` and the token Cue's own `gh` calls use: a `GH_TOKEN` (or `GITHUB_TOKEN`) credential is handed to `gh` alone, never to agents, and is read again on every poll, so a rotated file takes effect without a restart. A token file takes precedence over `gh auth login`.

**Upgrading.** Unpack a newer bundle and run its `install.sh` again. The data directory, workspaces, env file and credentials are kept, and a running service is restarted on the new version. The installer replaces the unit file, so keep your changes in drop-ins.

## Option 2: Container

Build the image from the repository root:

```bash
docker build -f packaging/server/Dockerfile -t maestro-cue .
```

| Build argument | Default                     | What it does                                                                                    |
| -------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `AGENT_CLIS`   | `@anthropic-ai/claude-code` | Agent CLIs to install, as npm package names separated by spaces. Add `@openai/codex` and so on. |
| `NODE_VERSION` | `24`                        | Node.js major version of the base image                                                         |

The image runs as the `maestro` user under `tini`, with git and the GitHub CLI. It has two volumes: `/var/lib/maestro` (the user's home and the data directory) and `/srv/maestro` (workspaces).

Clone the workspace and import the pipeline into the volumes, then start the engine:

```bash
docker run --rm -v maestro-work:/srv/maestro --entrypoint git \
  maestro-cue clone https://github.com/acme/app.git /srv/maestro/proj

docker run --rm \
  -v maestro-home:/var/lib/maestro -v maestro-work:/srv/maestro \
  -v "$PWD/pipeline.zip:/tmp/pipeline.zip:ro" \
  maestro-cue bundle import /tmp/pipeline.zip --workspace proj=/srv/maestro/proj

docker run -d --name maestro-cue --restart unless-stopped --stop-timeout 120 \
  --env-file maestro.env \
  -v maestro-home:/var/lib/maestro -v maestro-work:/srv/maestro \
  -p 127.0.0.1:17997:17997 \
  maestro-cue
```

`maestro.env` holds `KEY=value` lines such as `ANTHROPIC_API_KEY=...` and `GH_TOKEN=...`. To log `gh` in interactively instead, run `docker exec -it maestro-cue gh auth login`; the login is kept in the `maestro-home` volume.

With Docker Compose, `packaging/server/compose.yaml` has the same setup: `docker compose up -d --build` from that folder.

**Things to know:**

- **Stop timeout.** The engine drains active runs for up to 90 seconds on stop, but `docker stop` waits only 10 seconds by default. Use `--stop-timeout 120` (or `docker stop -t 120`), or `stop_grace_period: 120s` in Compose. The image runs `tini` without `-g`, so the stop signal reaches the engine alone and runs in flight can finish.
- **Restart after a hard kill.** If the engine is killed without stopping (`docker kill`, out of memory, a host crash), its lock stays behind. A new container cannot tell that lock from one held by another container on the same volume, so it waits for the lock to go quiet: the engine refuses to start for up to 3 minutes, and a restart policy brings it back after that.
- **Health.** The image's health check calls `/healthz` on the engine's status port, 7433, inside the container. `docker ps` shows `healthy` once it answers.
- **Secrets as files.** Docker and Compose secrets mounted at `/run/secrets/<NAME>` are read by name before the environment, like systemd credentials, and each agent receives only the secrets its bundle declared. A `GH_TOKEN` secret authenticates Cue's GitHub triggers.
- **Webhook port.** Inside the container the webhook listener listens on all interfaces so the port can be published. Publish it to the host's loopback (`127.0.0.1:17997:17997`) and put a reverse proxy or tunnel in front of it.

## Health and status

The engine answers on `127.0.0.1:7433`, reachable only from the same host (or, for the container, from inside it):

| Endpoint       | Answers                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz` | `200` while the engine holds its lock and responds; `503` once it lost the lock (restart it)                         |
| `GET /readyz`  | `200` once it is running with no readiness gap; `503` while starting, draining, after losing its lock, or with a gap |
| `GET /status`  | Phase, active runs, queue depth and readiness                                                                        |

`maestro-cli cue engine status` and `maestro-cli cue engine inspect` report the engine's lock, heartbeat and recent runs from the data directory.

## Logs

The engine logs one JSON object per line. On a VM they go to the journal (`journalctl -u maestro-cue`), in a container to `docker logs maestro-cue`.

## Webhooks

`webhook.received` subscriptions, and GitHub triggers that take webhooks, listen on port `17997`, bound to loopback. Do not expose the port directly: put a reverse proxy (nginx, Caddy) or a tunnel (cloudflared, ngrok) in front of `http://127.0.0.1:17997/cue/<path>`. See `webhook.received` and GitHub webhooks in [Cue Event Types](./maestro-cue-events).

**What a `2xx` means.** Maestro acknowledges a delivery (answers `2xx`) only after it has handled it: its run has started or is queued, or it was dropped on purpose (a `filter` that does not match, or a SusFactor block, which is recorded). Once a sender has a `2xx`:

- A crash (`kill -9`, out of memory, a host reboot) followed by a restart loses nothing. A queued delivery runs after the restart; a run that was in progress is marked failed at the next start.
- `systemctl stop` and `docker stop` drain: a delivery still being checked when the stop begins is finished and queued for the next start, within the drain timeout.
- A redelivery of the same id fires nothing for 24 hours, and a GitHub change seen by both a webhook and a poll fires once.

Before the `2xx`, nothing is recorded. A crash while Maestro is still checking a delivery leaves the sender without an answer, and its retry fires once. GitHub does not retry on its own; the GitHub trigger's poll finds the change instead, or use **Redeliver**.

**Limits:**

- While Cue is off or stopping, including after a second stop signal cuts the drain short, a delivery is answered `503` with `Retry-After: 30` and nothing is recorded, so the sender should retry. A stopped engine has no listener at all, and the connection is refused.
- The SusFactor check runs before the answer, so a slow 0DIN call delays it (each call gives up after 3 to 5 seconds). A sender that stops waiting first (GitHub waits 10 seconds) records a failure although the delivery runs; its retry is then a duplicate and fires nothing.
- A full queue drops its oldest event, and `queue_size: 0` drops a delivery that arrives while the agent is busy. A subscription with no prompt, or a fan-out target that does not exist, does not run. Each of these is logged, and the delivery still counts as handled.
- After a crash (not a drain), a queued delivery that has waited longer than its subscription's `timeout_minutes` by the time Maestro is back is dropped as stale and shown as timed out in the activity log. A drain stamps the queue so that rule does not apply.
- The delivery id is recorded in the same step that hands the delivery on. A crash at exactly that instant can let one redelivery fire again.
- A sender that sends no delivery id header (`X-GitHub-Delivery`, `X-Request-Id` or `X-Maestro-Delivery`) gets no protection against repeats.
