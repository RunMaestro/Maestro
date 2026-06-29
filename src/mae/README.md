# `mae` — Maestro TUI on Oh My Pi (omp)

`mae` is a thin launcher over the host **`omp`** binary (Oh My Pi,
`@oh-my-pi/pi-coding-agent`) plus a first-party omp **extension** that makes an
omp session a first-class Maestro citizen: it appears in the Maestro desktop
session list, streams its lifecycle back to the app, and can be resumed.

`mae` does **not** fork or embed omp — it spawns the installed binary with a
Maestro profile, a bundled system prompt, an optional config overlay, and the
bridge extension. All Maestro integration lives in the extension + a loopback
ingest host owned by the desktop app.

The authoritative design spec, phase plan, security model, and acceptance
criteria live in [`Plans/mae-feature-complete-goal.md`](../../Plans/mae-feature-complete-goal.md).
This README is the module-local developer orientation.

## Usage

`mae` ships with the packaged Maestro app (root `bin.mae`); from a checkout it
is the built `dist/cli/mae.js` (`node scripts/build-mae.mjs` first). It requires
the host `omp` binary on `PATH` (override with `MAE_OMP_BIN`).

```sh
mae [prompt] [omp flags…]   # launch omp with the Maestro profile + bridge.
                            # Any omp flag passes through, e.g. mae -p "fix the bug" --model opus
mae resume [id|title] [omp flags…]   # resume a tracked Maestro session by id-prefix or title
                                     # (omit the query to resume the most recent)
mae --mae-dry-run [args…]   # print the resolved omp invocation + bridge wiring; do not spawn
mae --copy-omp-settings     # copy your existing omp config into the Maestro profile (no prompt)
mae --no-copy-omp-settings  # never prompt/copy omp config
```

Inside the session the agent gets Maestro reach-back tools (read/observe):
`maestro_sessions` (list sibling Maestro sessions), `maestro_playbook_list`
(available playbooks), `maestro_cue` (recent Cue activity), `maestro_notify`
(raise a desktop toast). Dispatch-equivalent verbs (spawning/dispatching other
agents) are **inert by design** until Phase 4 — see the goal doc.

**First-run config import.** On a fresh Maestro profile, if you already have an
omp setup (`~/.omp/agent`), `mae` offers to copy your declarative config
(`config.yml`, `settings.json`, `mcp.json`, `lsp.json`, and `skills/ rules/
prompts/ instructions/ commands/ hooks/ tools/ extensions/`) into the isolated
`~/.omp/profiles/maestro/agent`. The prompt appears only on a TTY (scripts skip
it), and existing profile files are backed up (`*.pre-mae-*`), never destroyed.
Your omp **login/auth is NOT copied** (separate store) — run `omp --profile
maestro` once to log the profile in. The copied config may include secrets you
set yourself (e.g. `mcp.json` keys). Use `--copy-omp-settings` to import
non-interactively, or `--no-copy-omp-settings` to skip.

When the Maestro desktop bridge is running, the session is tracked in the app's
session list and is reopenable from there or via `mae resume`. This live-tracking
path is implemented (`useMaeBridge`) but not yet verified end-to-end against the
running app. Without the desktop bridge, `mae` still launches omp and degrades
gracefully (the bridge reports "not connected").

## Architecture

```
mae (launcher, Node)  --spawn-->  omp (host binary, Bun)
        |                              |
        | per-run scoped token         | -e maestro-bridge.extension
        | + mae-bridge.json discovery  |
        v                              v
  Maestro desktop app  <--HTTP loopback--  maestro-bridge extension
  (bridge host, 127.0.0.1)   session.*      (reach-back tools + ingest)
```

- **Launcher** (`launcher.ts`, entry `bin/mae.ts`): resolves the `omp` binary,
  composes `omp --profile maestro -e <bridge> --append-system-prompt … [--config …]`,
  performs the best-effort per-run scoped-token handshake, and (on resume) maps
  a Maestro session id to the omp resume key.
- **Extension** (`extension/maestro-bridge.extension.ts`): registered into omp.
  Registers the read/observe Maestro tools (`maestro_sessions`,
  `maestro_playbook_list`, `maestro_cue`, `maestro_notify`) and the inert
  dispatch-equivalent tools (gated until Phase 4). Streams `session.register` /
  `session.event` / `session.end` to the ingest host and maintains the identity
  map for resume.
- **Bridge host** (`mae-bridge-host.ts`, `bridge-core.ts`): a loopback-only
  (`127.0.0.1`) `node:http` server wrapping the security/dispatch core
  (per-run scoped tokens, TTL expiry, runId binding, rate/concurrency caps,
  dispatch-equivalent refusal `403`, revoke-on-end). The desktop app hosts this;
  `reference-server.ts` is the dev/test implementation of the same contract.
- **Renderer** (`../renderer/hooks/session/useMaeBridge.ts`): subscribes to
  `window.maestro.mae`, validates payloads with the protocol guards, and upserts
  a synthetic `Session` into the store so external runs appear live in the GUI.

## File map

| File                        | Role                                                      |
| --------------------------- | --------------------------------------------------------- |
| `bin/mae.ts`                | CLI entry → `runMae`                                      |
| `launcher.ts`               | resolve omp, compose args, handshake, resume              |
| `protocol.ts`               | bridge contract: env handshake, wire shapes, parse guards |
| `bridge-core.ts`            | security/dispatch core (tokens, runId binding, caps)      |
| `mae-bridge-host.ts`        | loopback `node:http` host wrapping the core               |
| `reference-server.ts`       | dev/test implementation of the host contract              |
| `host-mappers.ts`           | pure Maestro-shape → bridge-metadata mappers              |
| `host-service.ts`           | `createMaeHandlers(deps)` — DI of real service callbacks  |
| `host-entry.ts`             | CJS bundle entry for the Electron main-process host       |
| `session-map.ts`            | `maestroSessionId ↔ ompSessionId ↔ cwd` identity map      |
| `paths.ts`                  | config-dir + discovery I/O (aligned with `getConfigDir`)  |
| `extension/…`               | the omp extension (reach-back tools + ingest)             |
| `harness/live-omp-smoke.ts` | live end-to-end smoke (needs real omp + provider auth)    |
| `assets/`                   | bundled system prompt + config overlay                    |
| `types/omp.d.ts`            | minimal ambient shim for the omp extension API            |

## Build & test

```sh
node scripts/build-mae.mjs     # → dist/cli/mae.js + dist/mae/maestro-bridge.extension.mjs + assets
bun test src/mae               # unit + integration (loopback host over real HTTP)
node …/tsc -p tsconfig.mae.json --noEmit   # typecheck (also tsconfig.main/lint/cli)
```

Repo wiring: root `bin.mae` → `dist/cli/mae.js`; `build:mae` in the build chain;
`typecheck:mae` in `lint`; a dedicated `test-mae` CI job (`bun`); `extraResources`
ships the launcher + extension; `build:main` emits the host CJS bundle.

## Status

**Implemented + verified here** (Bun side + main-process integration):
`bun test src/mae` 60 pass / 0 fail; `tsc` clean for mae/main/lint/cli; eslint
clean; `build:mae` artifacts build and the built launcher resolves them; the
host bundle runs under Node (start → token → verb → 403 refusal). The
main-process glue (`src/main/mae/`, `index.ts` bootstrap + quit), the preload
`mae` API, and the renderer consumption hook are wired and compile/lint-verified.

**Needs the running app (not verifiable from a headless checkout):** the 8-step
live acceptance demo; the renderer's runtime GUI behavior + process-less
interaction semantics; richer live-status rendering from the transcript METADATA
the events already carry (`{role,usage}`/`{toolName,status}` — raw transcript is
never streamed over the bridge per the metadata-only security model; the full
conversation loads app-side on open); the `sessions.list` GUI-session source for
cross-engine
resume; and Phase 4 dispatch verbs (deliberately inert). See the goal doc §10.
