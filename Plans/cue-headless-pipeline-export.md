# Spec: Headless Pipeline Export and Server Deployment

| Field      | Value                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status     | Draft requirements, for review                                                                                                                                                                                     |
| Date       | 2026-09-24                                                                                                                                                                                                         |
| Scope      | Getting a Cue pipeline onto a machine with no desktop app, and running it there as a service                                                                                                                      |
| Tracks     | Action Item 6: headless pipeline export and server deployment                                                                                                                                                      |
| Written on | `cue-standalone/07-prettier-prepush` (#1642), the top of the standalone engine stack. Every path and line number below is cited at that commit.                                                                  |
| Builds on  | The standalone engine stack #1635 to #1642; the data-directory resolver from #1630, which this stack now includes; the maestro-lib launch RFC (`Plans/maestro-lib-launch-and-control.md`, branch `docs/maestro-lib-runner-design`) |

Requirement IDs (`BF-1`, `EN-3`, ...) are stable handles for review comments.
**MUST** / **SHOULD** / **MAY** carry their RFC 2119 meanings.

---

## 1. Summary

**Cue already runs without Electron.** The standalone engine stack added:

| Capability                                                                                                    | Where                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `maestro-cli cue engine start \| stop \| status \| inspect`, a real `CueEngine` outside Electron              | `src/cli/services/cue-standalone-engine.ts`, `src/cli/commands/cue-engine.ts` |
| Data directory resolved without Electron (`MAESTRO_USER_DATA`, else the platform default)                     | `resolveUserDataDir()` / `assertUserDataDirExists()` in `src/shared/userDataDir.ts` (#1630) |
| CLI bundle aliases `electron` to a shim, so the engine loads on a host with no Electron                       | #1636                                                                        |
| Output parsers registered in the standalone runner                                                            | #1637                                                                        |
| One engine per data directory: PID + boot time + 30 s heartbeat lock, atomic create                           | `src/main/cue/cue-engine-lock.ts` (#1635, #1638)                             |
| Clean recovery from an unclean restart (orphaned `running` rows, double `app.startup`, double heartbeat)      | #1639                                                                        |
| Generic `webhook.received` trigger: one loopback listener, per-subscription secret or HMAC, auth-header redaction, 1 MiB cap with a real 413 | `src/main/cue/cue-webhook-server.ts` (#1640)        |
| `cue trigger` reaches a standalone engine through a file inbox in the data directory                          | #1641                                                                        |

It was verified in a Docker `node:24-bookworm` container with no Electron:
all twelve trigger types, a 45-minute soak with no loss or duplication, and
recovery from `SIGKILL` mid-run (#1634).

**What is still missing** for "author a pipeline on my desktop, run it on a
server" is therefore narrower than a new daemon:

1. **A way to get a pipeline there.** The standalone engine reads the same data
   directory the desktop writes (`maestro-sessions.json`, agent configs, each
   project's `.maestro/cue.yaml`, `cue.db`). A fresh server has none of that,
   and a pipeline's subscriptions refer to agents by desktop UUID. This spec
   defines a portable **bundle** and the CLI verbs that export it and
   materialize it into a data directory the engine can run.
2. **Service operability.** `cue engine start` is a foreground process whose
   `SIGTERM` handler stops every active run immediately
   (`cue-engine.ts` command, lines 58-65); there is no drain, no health
   endpoint (the command's own module doc names a status endpoint as future
   work, lines 8-20), no readiness signal to a supervisor, and no secrets
   contract beyond the process environment.
3. **Packaging.** No container image or systemd unit.
4. **GitHub over webhooks, done safely.** The generic listener can already
   authenticate a GitHub delivery (`signature_header: X-Hub-Signature-256`),
   but webhook bodies skip SusFactor, repeated deliveries are not deduplicated,
   and a delivery does not feed the `github.*` triggers or their
   `cue_github_seen` dedupe.

The first draft of this spec proposed a new `maestro-server` daemon with its
own HTTP stack and host adapter. That is withdrawn: every requirement below
extends `maestro-cli cue engine` and the existing listener instead.

---

## 2. Background: what a pipeline is

This determines what an export has to collect, and it is unchanged by the
standalone work.

- A **subscription** is an entry in one project's `.maestro/cue.yaml`
  (`CueSubscription`, `src/shared/cue/contracts.ts`). Each project's engine
  session reads only its own file; there is no ancestor walk.
- A **pipeline** is not a file. It is every subscription with the same
  `pipeline_name` **across every project that takes part**. A multi-root
  pipeline is written as one `cue.yaml` per owning agent's cwd and stitched at
  run time by agent id (`agent_id`, `source_session_ids`, `fan_out_ids`).
- The pipeline's **layout** (nodes, edges, color) lives in
  `cue-pipeline-layout.json` in the data directory. The engine ignores it; it
  matters for round-tripping into the editor.
- Subscriptions name **agents by UUID** from `maestro-sessions.json`. The
  standalone engine resolves each one through `readSessions()`
  (`cue-standalone-engine.ts`), then the agent's binary through
  `getAgentCustomPath()` or `PATH` (it deliberately skips `AgentDetector`, see
  that file's module doc, point 1).
- `prompt_file` paths are resolved at load, relative to the project root and
  contained in it by `cue-config-normalizer.ts`.

So an export is: for each project the pipeline touches, the matching
subscriptions plus that file's `settings`, every prompt file they reference,
the layout entry, and a description of every agent they name.

---

## 3. Headless readiness, as of the base commit

| Area                     | State                                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron imports in Cue  | Four files, held by a shrink-only ratchet (`src/__tests__/main/cue/cue-electron-imports.test.ts`): the backup manager, the auth detector (type only), and the two notify modules. None of them is on the standalone engine's path. |
| Host wiring              | `buildStandaloneCueEngineDeps()` is the standalone counterpart of the `new CueEngine({...})` block in `src/main/index.ts`. Its `onCueRun` routing (notify, command, prompt) is a second copy of the desktop's; see EN-7.                         |
| Degraded on purpose      | No `AgentDetector` probe; `action: notify` becomes a log line; auth expiry logs instead of flipping the Settings pill.                                                                                                                            |
| Native modules           | `better-sqlite3` stays external to the CLI bundle and must be built for Node, not Electron; the desktop's `postinstall` rebuilds it for Electron.                                                                                                |
| Spawn policy             | The engine reuses the Cue executors, so it inherits the launch gaps in the maestro-lib launch RFC: an unresolved SSH remote runs locally (D1) and the inherited env is not stripped (D2). Both matter more unattended. See SEC-6.                   |

---

## 4. Goals and non-goals

### Goals

- A pipeline authored on the desktop runs under `maestro-cli cue engine start`
  on another machine with identical trigger, chain, fan-out, fan-in, queue, and
  template semantics, because it is the same engine.
- Bundles are reviewable (YAML and Markdown in a zip), reproducible, and carry
  no secrets.
- A bundle round-trips back into the desktop editor.
- The engine is operable as a service: supervised start, health, readiness,
  drain, logs.

### Non-goals (v1)

- A new daemon, HTTP framework, or host adapter. See section 1.
- A web UI for a remote engine.
- More than one engine per data directory (the lock forbids it by design).
- Windows servers. Linux first; macOS for local testing.
- Choosing the Claude interactive (maestro-p) token source automatically on a
  server.
- Live sync between a desktop and a server. Export is a snapshot.

---

## 5. Requirements

### 5.1 Bundle format (BF)

**BF-1. Zip, not tar.** A first brief suggested `.tar.gz`. Zip is chosen because
Cue backups and playbook import already use zip with a root `manifest.json`, and
`readZipArchive()` / `extractZipTo()` (`src/main/utils/zip-archive.ts`) already
handle zip bombs, unsafe entry names, and symlink escapes, which CLAUDE.md
requires for any zip read from disk. The central directory also lets
`inspect` read only the manifest. Extension: `.maestro-pipeline.zip`.

**BF-2. Layout.**

```
manifest.json
layout/pipeline.json                  # the pipeline's layout entry
workspaces/<key>/cue.yaml             # this project's subscriptions + its settings block
workspaces/<key>/<path>.md            # every referenced prompt, at its project-relative path
README.md                             # generated: what it does, what it needs
```

`<key>` is a readable slug chosen at export (`root`, `api`), not the cwd hash
the backup manager uses, because absolute paths mean nothing on the target.

**BF-3. Manifest.** A new shared type (`src/shared/cue-bundle-types.ts`),
modeled on `CueBackupManifest`:

```jsonc
{
	"kind": "maestro-pipeline",
	"bundleVersion": 1,
	"createdAt": "2026-09-24T10:00:00.000Z",
	"producer": { "app": "maestro", "version": "0.18.6" },
	"minEngineVersion": "0.18.0",
	"pipeline": { "id": "…", "name": "Daily Ops", "color": "#06b6d4" },
	"workspaces": [
		{
			"key": "root",
			"files": [{ "path": "cue.yaml", "sha256": "…", "size": 1234 }],
			"source": { "gitRemote": "git@github.com:acme/app.git", "gitRef": "a1b2c3d" }, // hint only
		},
	],
	"agents": [
		{
			"id": "5f0c…", // the UUID the YAML references; preserved (BF-6)
			"name": "Reviewer",
			"workspace": "root",
			"toolType": "claude-code",
			"model": "sonnet",
			"effort": "medium",
			"customArgs": "--max-turns 20",
			"tokenSource": "api",
			"env": { "required": ["ANTHROPIC_API_KEY"], "values": { "LOG_LEVEL": "info" } },
		},
	],
	"requirements": {
		"events": ["time.scheduled", "webhook.received", "agent.completed"],
		"tools": ["gh", "git"],
		"secrets": ["ANTHROPIC_API_KEY", "GITHUB_WEBHOOK_SECRET"],
	},
	"warnings": [],
}
```

`requirements.secrets` includes every `webhook.secret_env` name the
subscriptions use, since the listener reads those from the engine's
environment at delivery time.

**BF-4. Integrity.** Every file carries `sha256` and `size`; import MUST reject a
bundle whose files disagree with the manifest. Signing is deferred (Q3).

**BF-5. No secrets.** Agent env values are split with `isSecretEnvKey()`
(`src/shared/agentEnvironment.ts`): secret keys contribute only their name.
Parked values (`customEnvVarsDisabled`) are never exported. A literal
`webhook.secret` in YAML (the contract already calls it "discouraged") MUST
block export unless `--allow-inline-secrets` is passed. A general credential
scanner for YAML and prompt text does not exist yet; if added, it belongs in
`src/shared/` as a canonical utility.

**BF-6. Agent ids are preserved.** The YAML keeps `agent_id`,
`source_session_ids`, and `fan_out_ids` byte-for-byte, and import writes agents
into the target's `maestro-sessions.json` under those same ids. Rewriting ids
would touch every reference field and risks the "separate canvas nodes silently
collapse" bug CLAUDE-CUE.md warns about.

**BF-7. Reproducible.** Sorted entries, fixed timestamps; `--reproducible` pins
`createdAt`.

**BF-8. Round-trip.** Importing into a desktop reproduces the subscriptions,
prompts, and layout entry, including `pipeline_name`, `target_node_key`, and
`fan_out_node_keys`.

**BF-9. Versioning.** Readers refuse a higher `bundleVersion` with an actionable
message and ignore unknown fields; `minEngineVersion` makes a bundle that uses a
newer event type (as `webhook.received` is) fail at validate time.

### 5.2 Export, validate, import (EX)

**EX-1. Extend the existing verb.** `maestro-cli cue pipeline export <name>`
(`src/cli/commands/cue-pipeline.ts`) keeps printing the layout JSON. Bundle mode
is opt-in: `... export "Daily Ops" --bundle --output ./daily-ops.maestro-pipeline.zip`.

**EX-2. Works with the app closed.** Like `cue schedule` and `cue engine`,
export reads the data directory directly. Today the `pipeline` verbs go through
the desktop WebSocket; bundle mode MUST NOT require it.

**EX-3. Collection.** Resolve the pipeline in the layout file; load every
agent's `cue.yaml` and keep subscriptions whose `pipeline_name` matches; carry
each file's `settings` block; collect `prompt_file`, `output_prompt_file`, and
`fan_out_prompt_files` targets with the normalizer's containment check (an
escaping path is an export error); collect every agent named by `agent_id`,
`source_session_ids`, `fan_out_ids`, `settings.owner_agent_id`, and
`command.mode: cli` targets; derive `requirements` from event types, command
nodes, and `webhook.secret_env`.

**EX-4. Import into a data directory.** `maestro-cli cue pipeline import
<bundle> --data-dir <dir> --workspace <key>=<path> [--dry-run] [--force]`:

- writes each workspace's subscriptions into `<path>/.maestro/cue.yaml`, merging
  with other pipelines' subscriptions, never overwriting them;
- writes prompt files;
- adds agents to `<dir>/maestro-sessions.json` under their bundle ids with
  `cwd`/`projectRoot` set to the bound path. `src/cli/services/storage.ts` has
  readers for sessions but no writer, so this is new code; it MUST be an atomic
  write and MUST refuse while an engine or the desktop holds the Cue lock for
  that directory;
- writes per-provider `customPath` overrides through the existing
  `writeAgentConfigValue()` when `--agent-path <toolType>=<path>` is given;
- adds the layout entry.

It MUST refuse to replace an existing pipeline of the same name without
`--force`, and MUST read the zip through `readZipArchive()` / `extractZipTo()`.

**EX-5. Validate and inspect.** `validate` runs the manifest and hash checks,
`cue-config-validator.ts` on every YAML, and reports: dangling `source_session`
or `source_sub` references outside the pipeline, subscription names containing
`:` (they mis-key fan-in, CLAUDE-CUE.md gotcha 4), unknown event types,
sub-minute heartbeats (gotcha 8), and `webhook.received` subscriptions whose
`secret_env` is not listed in `requirements.secrets`. `inspect` prints the
manifest and README without extracting.

**EX-6.** Every new verb supports `--json` with the existing error envelope.

### 5.3 Engine as a service (EN)

**EN-1. Data directory is explicit.** `cue engine start` MUST accept
`--data-dir` as an alternative to `MAESTRO_USER_DATA`, and MUST log the resolved
directory at start. A standalone process cannot tell the packaged `Maestro`
from the unpackaged `maestro` directory name
(`Plans/cue-data-directory-without-electron.md`; `assertUserDataDirExists()` refuses rather than create an empty directory beside the real one), so a service unit should
always pass it.

**EN-2. Secrets.** Agent `env.required` names and webhook `secret_env` names are
read from the process environment today. The engine SHOULD also read them from
files under `$CREDENTIALS_DIRECTORY` (systemd `LoadCredential=`) and
`/run/secrets/` (Docker and Kubernetes), without copying values into the data
directory, logs, or `cue_events`.

**EN-3. Fail before start.** With `--require-ready`, `cue engine start` MUST
refuse to start while any subscription's agent binary, required secret, or
required tool (`gh` for `github.*`) is missing, listing every gap at once.
`inspect` already lists skipped subscriptions and why (#1641); this reuses that
check as a gate.

**EN-4. Drain on `SIGTERM`.** Today `SIGTERM` calls `engine.stop()`, which stops
every active run. The service mode MUST instead:

1. mark itself not-ready (EN-5) and stop the trigger sources;
2. let active runs finish up to `--drain-timeout` (default 90 s), queueing (not
   starting) chain successors, which `cue_event_queue` carries to the next
   start;
3. stop what remains through the existing stop path, so runs settle as
   `stopped` rather than being left `running` for #1639's orphan sweep to mark
   `failed`;
4. release the lock and exit 0.

A second signal skips to step 3.

**EN-5. Health and readiness.** A loopback status listener, enabled by
`--status-port`:

- `GET /healthz`: 200 while the event loop answers and the engine heartbeat in
  `cue.db` is fresh.
- `GET /readyz`: 200 after sessions initialized and EN-3 passed; 503 during
  startup, drain, or after the lock heartbeat reports the lock was lost.
- `GET /status`: the live counters `cue engine status` cannot see today (active
  runs, queue depth), which the command's module doc names as the intended
  follow-up.

It is a separate listener from the webhook server, which opens only while a
`webhook.received` subscription exists and must keep its refcounted lifecycle.

**EN-6. Supervisor readiness.** When `NOTIFY_SOCKET` is set, the engine SHOULD
send `READY=1` once ready and `WATCHDOG=1` from the existing lock heartbeat.
Node has no built-in `sd_notify`, so this is a datagram write or a small
dependency.

**EN-7. One `onCueRun` routing.** The notify/command/prompt routing exists twice,
inline in `src/main/index.ts` and in `buildOnCueRun()` in
`cue-standalone-engine.ts`. Before more behavior is added to either, it SHOULD
move into one shared function both hosts call with their own sinks.

**EN-8. Notify and auth sinks.** `action: notify` and auth-expiry detection
currently log. The service mode SHOULD also POST them to an optional
`--notify-webhook <url>`.

**EN-9. Structured logs.** `--log-format json` emits one JSON object per engine
log call with `runId`, `subscription`, `pipeline`, and `sessionId` where known.

**EN-10. `command.mode: cli`.** These nodes shell out to `maestro-cli dispatch`,
which targets a desktop agent tab over WebSocket and has nothing to reach on a
server. `validate` MUST flag them for a server target; resolving the target to
a server agent and running it as a prompt run is a possible follow-up (Q6).

**EN-11. Token source.** Server agents SHOULD default to the API token source;
the interactive source needs a logged-in Claude config directory, which the
operator must provide deliberately.

### 5.4 GitHub over webhooks (WH)

The generic listener already covers transport and authentication. What it does
not do:

**WH-1. SusFactor on webhook bodies.** GitHub issue and PR text is the reason
`cue-susfactor.ts` exists ("the only Cue inputs a third party can write"), but
`cue-webhook-trigger-source.ts` and `cue-webhook-server.ts` never call it, so a
PR body delivered by webhook reaches the prompt unscored while the same body
polled is scored. Webhook payloads from a third-party sender MUST go through
the same chunked scoring before dispatch. This applies to the desktop too.

**WH-2. Delivery dedupe.** The listener stamps a `deliveryId` from the vendor
header (`cue-webhook-server.ts:366`) and passes it through as `delivery_id`
(`cue-webhook-trigger-source.ts:51`) but does not remember it, so a GitHub
redelivery fires the subscription again. Delivery ids SHOULD be remembered for
24 h in `cue.db`.

**WH-3. Optional `github.*` feed.** A `github.pull_request`, `github.issue`, or
`github.label` subscription MAY opt into webhook delivery
(`delivery: webhook`, plus the existing `webhook` config block). The delivery
is translated into the same `CueEvent` payload the poller builds and goes
through the same `cue_github_seen` keys (`pr:<repo>:<n>`, `issue:<repo>:<n>`,
with `last_revision`), so a delivery and a poll of the same change fire once.
The poller keeps running at a reduced cadence as reconciliation.

**WH-4. Public exposure stays a proxy concern.** The listener binds loopback
unless `MAESTRO_CUE_WEBHOOK_HOST` says otherwise. The deployment docs MUST keep
that stance: front it with a reverse proxy or tunnel, never bind it to
`0.0.0.0` on a public host.

### 5.5 Packaging (PK)

**PK-1. Container image.** Base `node:24-bookworm-slim` (the image the stack was
verified on); multi-stage build compiling `better-sqlite3` for Node; `git`,
`gh`, and `tini` (signal forwarding and zombie reaping, since agents spawn
grandchildren); agent CLIs chosen by build arg; non-root user; the data
directory as a volume; `HEALTHCHECK` on `/healthz`. Document that
`docker stop`'s default 10 s grace is shorter than EN-4's drain.

**PK-2. systemd unit (template).**

```ini
[Unit]
Description=Maestro Cue engine
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/bin/maestro-cli cue engine start --data-dir /var/lib/maestro --status-port 7433 --require-ready --log-format json
User=maestro
StateDirectory=maestro
LoadCredential=ANTHROPIC_API_KEY:/etc/maestro/credentials/anthropic
LoadCredential=GITHUB_WEBHOOK_SECRET:/etc/maestro/credentials/github-webhook
KillMode=mixed
TimeoutStopSec=120
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/maestro /srv

[Install]
WantedBy=multi-user.target
```

`KillMode=mixed` sends `SIGTERM` to the engine only so it can drain its own
children, then `SIGKILL`s the cgroup at the timeout.

**PK-3. One engine per data directory, per PID namespace.** The lock tests
liveness with `process.kill(pid, 0)` (`cue-engine-lock.ts:84`), which only sees
the caller's PID namespace. Two containers mounting the same data volume, or a
host process and a container sharing one, can each read the other's PID as
dead and both take the lock. The docs MUST say one data volume per engine, and
the lock SHOULD record a namespace identity (for example the inode of
`/proc/self/ns/pid`) so a lock from another namespace is treated as live until
its heartbeat goes stale. Needs a test in two containers before it is
considered settled.

### 5.6 Security (SEC)

- **SEC-1.** Bundles are untrusted on import: zip reads through the hardened
  utilities, prompt paths revalidated against the target workspace.
- **SEC-2.** A bundle can contain shell commands that will run on the server.
  `import` MUST print every `command.mode: shell` node, and
  `--allow-shell-commands=false` MUST reject bundles that contain any.
- **SEC-3.** `sanitizeCustomEnvVars()` applies to imported agent env values, as it
  does to YAML-supplied env today.
- **SEC-4.** Secrets resolve only from EN-2 sources and are redacted from logs and
  `/status`.
- **SEC-5.** Cue runs agents in YOLO/batch mode (`cue-spawn-builder.ts` forces
  `yoloMode: true`). The docs MUST say so and recommend a dedicated user and a
  workspace holding nothing else.
- **SEC-6.** Before recommending unattended deployment, the launch RFC's D1
  (unresolved SSH runs locally) and D2 (inherited env not stripped) SHOULD be
  fixed for the Cue executors. On a server both fail silently with nobody
  watching.

### 5.7 Non-functional (NFR)

- **NFR-1.** Idle engine under 150 MB RSS and 1% CPU. The #1634 soak measured a
  flat ~30 MB live heap after GC, so this is a regression guard, not a target to
  reach.
- **NFR-2.** Webhook to dispatch start under 1 s at p95 on an idle engine.
- **NFR-3.** `kill -9` at any point loses no acknowledged event (a 202, or a
  persisted queue row) and never double-fires a GitHub item.
- **NFR-4.** No change to desktop behavior, except WH-1, which is a security fix
  for both.

---

## 6. Phased delivery

1. **Bundle format and export** (BF, EX-1 to EX-3, EX-5, EX-6). Desktop-side
   only. Exit: export then re-import into an empty data directory then
   re-export is byte-identical apart from `createdAt`.
2. **Import into a data directory** (EX-4, the sessions writer). Exit: an
   imported bundle runs under `cue engine start` in the verification container
   with no manual edits.
3. **Security prerequisites** (WH-1, SEC-6). These can start immediately, in
   parallel with 1 and 2.
4. **Service mode** (EN-1 to EN-9). Exit: a scheduled, chained, fan-in sample
   pipeline runs 24 h under systemd; `systemctl stop` drains; `kill -9` and
   restart replays the queue.
5. **Packaging** (PK). Exit: a fresh Debian VM runs a bundle from the docs alone;
   PK-3 verified with two containers.
6. **GitHub webhook feed** (WH-2, WH-3).

---

## 7. Open questions

**Q1. Who owns the workspace on the server?** Bundles carry pipeline
definitions, not repositories. Should the engine clone or fetch
`workspaces[].source` before runs, or is keeping the checkout current the
operator's job?

**Q2. Dependencies outside the pipeline.** Should export pull in subscriptions
that a pipeline's `source_sub` references but that belong to no pipeline, or
report them as dangling (EX-5)?

**Q3. Bundle signing** for teams distributing pipelines, in the spirit of the
plugin signing model (`CLAUDE-PLUGINS.md`). Deferred.

**Q4. Multi-tenant servers.** One engine per data directory already isolates
tenants if each gets its own directory, user, and unit. Is that sufficient, or
is per-pipeline credential isolation inside one engine needed?

**Q5. Desktop attach.** Should the desktop Cue dashboard read a remote engine's
`/status` and history? It widens EN-5 from loopback to an authenticated
network API.

**Q6. `command.mode: cli` on a server** (EN-10): run the target as a prompt run
on a server agent, or keep it desktop-only?
