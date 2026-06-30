# Plugin Platform + Encore Uplift — build plan

Goal (from the request): make the plugin system a **complete extension surface** for Maestro, **lift
each Encore feature into a plugin**, and **surface plugins as "Encore Features"** in a tiled
marketplace (category filters · details view with install/uninstall/configure · "only installed"
toggle). Parallelize the build across worktrees and merge back.

## Grounded reality (from the workflowz analysis)

The 5 Encore features cannot be plugins today:

| Feature       | Liftability        | Hard blockers                                                                                                                                                                               |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| directorNotes | **hard**           | inert `agents:dispatch`/`process:spawn` (no batch-agent sink); no global cross-session `history:read`; no `history.entryAdded` event; rich modal UI needs a host                            |
| usageStats    | **infeasible-now** | no dashboard UI host; no `stats.*` read verbs; live-only telemetry (no backfill); event payloads omit lineage/tokens; SQLite can't run in the vm sandbox; coupled to maestroCue             |
| symphony      | **infeasible-now** | `process:spawn` inert (git/gh is the whole backbone); no session-create/batch-run verbs; no `sessions:write` metadata; no arbitrary-UI host; no registry; needs `shell:openExternal`        |
| maestroCue    | **infeasible-now** | `process:spawn` + `agents:dispatch` inert; **OS sandbox** prerequisite; KV-only storage (needs SQL); no `fs:watch`; no persistent background engine; no `power:preventSleep`; richer events |
| pianola       | **infeasible-now** | `agents:dispatch` inert; no `sessions.create`; `sessions:read`/`transcripts:read` too thin (no live state/awaiting tail); no persistent background supervision; OS sandbox                  |

So the work splits into **(1) a platform build-out** (the 14 gaps below) that the lifts depend on,
plus **(2) the marketplace UI**, which is buildable now over existing IPC.

## The 14 complete-extension gaps → workstreams

Grouped into dependency layers. Each workstream (WS) = one worktree/branch, with an acceptance test
that extends the **existing e2e plugin harness** (`e2e/plugins.spec.ts` + `e2e/fixtures/plugin-harness.ts`).

### Layer P0 — Contracts (lands FIRST, single owner; everyone rebases)

Pure additive contract changes, no behavior, so feature worktrees have stable types to build against.

- **WS-contracts**: add capability vocab (`history:read`, `sessions:create`, `sessions:write`,
  `tabs:manage`, `transcripts:write`, `decisions:write`, `shell:openExternal`, `storage:sql`,
  `fs:watch`, `power:preventSleep`, `background:service`) to `permissions.ts`; matching HOST_API
  methods in `rpc-protocol.ts`; event topics + richer payloads (`history.entryAdded`,
  `agent.completed` w/ output, chain lineage / token totals / provider session id / queue depth) in
  `events.ts`; bump `HOST_API_VERSION`; re-vendor SDK + drift test.
  _Acceptance:_ drift test green; contract unit tests; no runtime behavior yet.

### Layer P1 — Foundations (parallel, buildable NOW, mostly independent)

- **WS-ui-command**: renderer command registry shared by the palette + plugin IPC; replace
  `runUiCommand: () => false`. _Acceptance:_ harness `ui:command` probe flips INERT→PASS invoking a real palette command; palette still works.
- **WS-keybindings**: consumer that binds each `KeybindingContribution` chord→command. _Acceptance:_ e2e — chord dispatches the plugin command.
- **WS-settings-ui**: render `SettingContribution`s + bidirectional write bridge to `plugins.<id>.*`. _Acceptance:_ e2e settings round-trip via the panel.
- **WS-grant-ledger**: inject the OS-keyring freshness anchor into `createAuthorizationStore` → persistent grants. _Acceptance:_ e2e relaunch — grants survive, no re-consent.
- **WS-hot-reload**: plugins-dir watcher → reload sandbox on change (dev mode). _Acceptance:_ edit fixture → reload observed in log.
- **WS-sdk-dist**: publish `@maestro/plugin-sdk` to npm; CLI `install`/`publish`/`update`; host-API typings channel. _Acceptance:_ CLI installs a packed plugin; SDK importable standalone.
- **WS-render-host**: `ui:render-unsafe` renderer host (broker-gated `WebContentsView`/webview partition) + consume the agent registry (render contributed agents in the Left Bar; NO spawn yet). _Acceptance:_ a contributed agent appears; a render-unsafe panel renders gated.
- **WS-marketplace-ui** (the headline UI; see next section). _Acceptance:_ e2e lists/filters/installs/uninstalls/enables/configures.

### Layer P2 — Security core (SEQUENTIAL; the long pole)

- **WS-os-sandbox** _(native tech decision REQUIRED — needs explicit approval; project default is
  TypeScript, but OS confinement is unavoidably native)_: a native helper exposing
  `confineSelf(profile)` (mac/linux, child startup) + `spawnConfined(opts)` (windows, host-side), with
  per-OS backends — macOS Seatbelt(SBPL) → Linux seccomp-bpf+Landlock → Windows AppContainer+restricted
  token+Job — and graceful degradation → trusted-only when confinement unavailable. Implementation
  options to decide: napi-rs (Rust), node-gyp (C/C++), or prebuilt per-platform helper binaries invoked
  out-of-process. Pick one with the user before starting.
  _Acceptance:_ confined child cannot read outside scope, cannot open sockets;
  per-OS smoke in CI.
- **WS-act-verbs** (after sandbox): wire `agents:dispatch` + `process:spawn` host handlers behind the
  sandbox + Pianola risk gate. _Acceptance:_ trusted+granted plugin dispatches a prompt / runs a scoped
  command; ungranted/untrusted denied (harness matrix flips these INERT→PASS-when-trusted).
- **WS-scheduler-sink** (after act-verbs): wire the scheduler auto-send dispatch + runtime-session
  addressing. _Acceptance:_ an eligible cueTrigger auto-dispatches.

### Layer P3 — Host-API breadth (parallel after P0; act parts after P2)

- **WS-sessions-tabs**: `sessions.create`/modify + `tabs:manage`. _Acceptance:_ plugin creates a session/tab.
- **WS-history-transcripts**: global `history:read` + `transcripts:write`/`decisions:write` + the
  `history.entryAdded` event. _Acceptance:_ plugin reads cross-session history + receives entryAdded.
- **WS-events-rich**: emit the richer payload fields. _Acceptance:_ payloads carry lineage/tokens.
- **WS-storage-sql / fs-watch / power**: relational storage capability (out-of-sandbox brokered SQLite
  or a journaled KV redesign), file-watch, prevent-sleep. _Acceptance:_ plugin opens a SQL store / watches a dir / holds a wake-lock.
- **WS-background-service**: persistent background-worker registration API (beyond the 30s poll
  scheduler) with crash-restart + health. _Acceptance:_ a plugin background service survives + restarts.

### Layer P4 — Feature lifts (each gated on its prereqs; parallel across features once unblocked)

Order by ascending prerequisite weight:

1. **E-directorNotes** ← P1(ui-command, settings-ui, render-host) + P3(history-transcripts) +
   a read-only batch-agent dispatch sink. Lift AI Overview + Unified History as a plugin.
2. **E-pianola** ← P2(act-verbs, os-sandbox) + P3(sessions-tabs, history-transcripts, background-service).
3. **E-maestroCue** ← P2(all) + P3(storage-sql, fs-watch, power, events-rich, background-service).
4. **E-symphony** ← P2(process:spawn) + P3(sessions-tabs, sessions:write, history) + render-host +
   marketplace registry + `shell:openExternal`.
5. **E-usageStats** ← dashboard UI host + `stats.*` read verbs + storage-sql + **historical backfill**
   (data migration) ; coupled to E-maestroCue lineage.

Each lift keeps a thin host shim where required and ships the feature behind its plugin; the legacy
Encore flag becomes a "first-party plugin" entry in the marketplace.

## The "Encore Features" marketplace UI (WS-marketplace-ui — buildable now)

A single unified Extensions surface that lists **both** built-in Encore features and installed plugins.
All data/actions already exist via `window.maestro.plugins.*` + the `encoreFeatures` flags.

- **Tiled grid** (`ExtensionsGrid`): a card per entry — icon, name, one-line description, **category
  badge**, state pill (Not installed / Installed / Enabled), tier + trust (signed/unsigned) badge.
  - First-party Encore features (directorNotes/usageStats/symphony/maestroCue/pianola) render as cards
    whose "enable" toggles the `encoreFeatures.<flag>`; plugins render from `plugins.list()`.
- **Category filter bar**: All · Automation · Agents · UI/Themes · Data/Insights · Dev Tools.
  Category source: optional `category` field added to the plugin manifest (P0 contract), with a derived
  fallback from a plugin's dominant contribution bucket; Encore features get fixed categories.
- **"Only installed" toggle** + **search box** + sort.
- **Details view** (`ExtensionDetails`, right pane or modal): full description, version, author,
  **trust/signature** status, **requested permissions with risk colors** (`getPermissions(id)`),
  contributions summary (`contributions()` filtered by pluginId). Actions:
  - **Install** (plugin: copy/registry-download once WS-marketplace registry lands; Encore: enable flag)
  - **Uninstall** (`plugins:uninstall`) / **Enable·Disable** (`setEnabled`)
  - **Configure** → opens consent (`requestConsent`) and the contributed settings (WS-settings-ui)
  - **Revoke grants** (`revokeGrants`)
- Lives where the current Encore Features section is (`Settings/tabs/EncoreTab.tsx` + `PluginsPanel.tsx`),
  promoted to its own "Extensions" view.
- _Acceptance:_ extend `e2e/plugins.spec.ts` — seed 2 plugins, assert grid render, category filter,
  only-installed toggle, details permissions list, install→enable→configure→uninstall round-trip.

## Worktree decomposition + merge strategy

- **Integration branch**: `feat/plugin-platform` (off `rc`), or continue on `feat/autonomous-manager-agent`.
- **Order**: P0 (contracts) → merge → everyone rebases. Then P1 + P3(read-only parts) + marketplace-ui
  in **parallel worktrees**. P2 runs in its own track (sequential internally; sandbox is multi-week,
  per-OS, CI-gated). P4 lifts start per-feature as their prereqs land.
- **Collision hotspots** (designate single owners / land in clearly separated blocks):
  `src/main/index.ts` (HostHandlerDeps wiring — every WS adds a dep), `permissions.ts`,
  `rpc-protocol.ts`, `events.ts`, `host-api.ts`. The **WS-contracts** owner lands all vocab/method/event
  additions first; feature worktrees only _consume_ them, minimizing index.ts churn to one dep line each.
- **Per-worktree contract**: branch from integration; do NOT run project-wide gates; extend the e2e
  harness with its acceptance probe; PR back; **Linux CI is the merge gate** (+ per-OS sandbox CI for P2).
- **Regression spine**: the e2e plugin harness is the platform's living regression suite — every new
  capability gets a fixture probe (PASS/INERT/DENY), every event a delivery test, every UI piece an e2e.

## Suggested first wave (no platform prerequisites; highest leverage)

Parallel worktrees, all buildable today, all verifiable with the harness:

1. **WS-contracts** (P0) — unblocks everything; land first.
2. **WS-ui-command** — the keystone (registry bridge).
3. **WS-marketplace-ui** — the headline Extensions view.
4. **WS-settings-ui**, **WS-keybindings**, **WS-grant-ledger** — independent foundations.

P2 (OS sandbox) should start in parallel as its own long-running track since it gates the heavy lifts.
