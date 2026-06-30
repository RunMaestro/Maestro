# Plugin Platform + Encore Uplift — build plan

Goal: make the plugin system a **complete extension surface** for Maestro, **lift each Encore feature
into a plugin**, and **surface plugins as "Encore Features"** in a tiled marketplace (category filters ·
details view with install/uninstall/configure · "only installed" toggle). Built across parallel
worktrees and merged back.

## Security model (decided — no OS sandbox)

Plugins run tier-1 code in a process-isolated Electron `utilityProcess` (crash isolation, empty env, an
in-child `vm`). The trust boundary is **ed25519 signing + per-capability user consent** — the same model
VS Code / Obsidian / JetBrains use (install = a trust decision; extensions get host privileges). The
high-power verbs (`agents:dispatch`, `process:spawn`) are gated on **trusted-signed + consent + the
Pianola risk gate**, not on OS-level confinement. This is the baseline; nothing below depends on a
kernel sandbox.

## What blocks the Encore lifts today

With the sandbox out of scope, the lifts are **feasible** but blocked on concrete platform work: the
high-power verbs are inert, `ui:command` is a stub, there's no persistent background service, storage is
KV-only, the host-API is read/notify-heavy, several contribution buckets aren't consumed, and there's no
registry or rich-UI host. Those become the workstreams below.

## Workstreams (layered; each WS = one worktree/branch + an acceptance test that extends the e2e harness)

### P0 — Contracts (lands FIRST, single owner = main; everyone rebases)

Pure additive contract changes so feature worktrees build against stable types.

- **WS-contracts**: capability vocab (`history:read`, `sessions:create`, `sessions:write`, `tabs:manage`,
  `transcripts:write`, `decisions:write`, `shell:openExternal`, `storage:sql`, `fs:watch`,
  `power:preventSleep`, `background:service`) in `permissions.ts`; matching HOST_API methods in
  `rpc-protocol.ts`; event topics + richer payloads (`history.entryAdded`, `agent.completed` w/ output,
  chain lineage / token totals / provider session id / queue depth) in `events.ts`; optional manifest
  `category` field; bump `HOST_API_VERSION`; re-vendor `@maestro/plugin-sdk` + drift test.
  _Acceptance:_ drift test green; contract unit tests; no behavior yet.

### P1 — Foundations (parallel worktrees, buildable now, independent)

- **WS-ui-command**: renderer command registry shared by the palette + plugin IPC; replace
  `runUiCommand: () => false` (index.ts:1320). _Acceptance:_ harness `ui:command` probe flips INERT→PASS
  invoking a real palette command; palette still works.
- **WS-keybindings**: consumer that binds each `KeybindingContribution` chord→command.
  _Acceptance:_ e2e chord dispatches the plugin command.
- **WS-settings-ui**: render `SettingContribution`s + bidirectional write bridge to `plugins.<id>.*`.
  _Acceptance:_ e2e settings round-trip via the panel.
- **WS-grant-ledger**: inject the OS-keyring freshness anchor into `createAuthorizationStore` → persistent
  grants. _Acceptance:_ e2e relaunch — grants survive, no re-consent.
- **WS-hot-reload**: plugins-dir watcher → reload sandbox on change (dev mode).
  _Acceptance:_ edit fixture → reload observed.
- **WS-sdk-dist**: publish `@maestro/plugin-sdk` to npm; CLI `install`/`publish`/`update`.
  _Acceptance:_ CLI installs a packed plugin; SDK importable standalone.
- **WS-render-host**: `ui:render-unsafe` renderer host (broker-gated `WebContentsView`) + consume the
  agent registry (render contributed agents in the Left Bar; spawn path lands with P2 act-verbs).
  _Acceptance:_ a contributed agent appears; a render-unsafe panel renders gated.
- **WS-marketplace-ui** (headline UI; see below). _Acceptance:_ e2e lists/filters/installs/uninstalls/
  enables/configures.

### P2 — High-power act verbs (parallel after P0; trust+consent+risk-gated, no sandbox)

- **WS-act-verbs**: wire the `agents:dispatch` + `process:spawn` host handlers (inject `deps.dispatch` /
  `deps.spawn`) gated on trusted-signed + consent + the Pianola risk gate; `process:spawn` scoped to a
  declared cwd + minimal env. _Acceptance:_ trusted+granted plugin dispatches a prompt / runs a scoped
  command (harness matrix flips these INERT→PASS-when-trusted); untrusted/ungranted denied.
- **WS-scheduler-sink** (after act-verbs): wire the scheduler auto-send dispatch + runtime-session
  addressing so `cueTrigger`s act, not just notify. _Acceptance:_ an eligible cueTrigger auto-dispatches.

### P3 — Host-API breadth (parallel after P0; the act parts after P2)

- **WS-sessions-tabs**: `sessions.create`/modify + `tabs:manage`. _Acceptance:_ plugin creates a session/tab.
- **WS-history-transcripts**: global `history:read` + `transcripts:write`/`decisions:write` +
  `history.entryAdded` event. _Acceptance:_ plugin reads cross-session history + receives entryAdded.
- **WS-events-rich**: emit the richer payload fields. _Acceptance:_ payloads carry lineage/tokens.
- **WS-storage-sql / fs-watch / power**: brokered SQLite-backed store (out-of-vm, host-owned, per-plugin
  file), file-watch, prevent-sleep. _Acceptance:_ plugin opens a SQL store / watches a dir / holds a wake-lock.
- **WS-background-service**: persistent background-worker registration (beyond the 30s poll scheduler) with
  crash-restart + health. _Acceptance:_ a plugin background service survives + restarts.

### P4 — Feature lifts (each gated on its prereqs; parallel across features once unblocked)

1. **E-directorNotes** ← P1(ui-command, settings-ui, render-host) + P3(history-transcripts) +
   a read-only batch-agent dispatch sink (P2). Lift AI Overview + Unified History.
2. **E-pianola** ← P2(act-verbs) + P3(sessions-tabs, history-transcripts, background-service).
3. **E-maestroCue** ← P2(act-verbs, scheduler-sink) + P3(storage-sql, fs-watch, power, events-rich,
   background-service).
4. **E-symphony** ← P2(process:spawn) + P3(sessions-tabs, sessions:write, history) + render-host +
   marketplace registry + `shell:openExternal`.
5. **E-usageStats** ← dashboard UI host + `stats.*` read verbs + storage-sql + **historical backfill**
   (data migration); coupled to E-maestroCue lineage.

Each lift keeps a thin host shim where required and ships the feature behind its plugin; the legacy Encore
flag becomes a "first-party plugin" entry in the marketplace.

## The "Encore Features" marketplace UI (WS-marketplace-ui — buildable now)

Unified Extensions surface listing built-in Encore features **and** plugins as tiles. Data/actions already
exist via `window.maestro.plugins.*` + the `encoreFeatures` flags.

- **Tiled grid** (`ExtensionsGrid`): card per entry — icon, name, one-line desc, **category badge**, state
  pill (Not installed / Installed / Enabled), tier + trust (signed/unsigned) badge. First-party Encore
  features toggle their `encoreFeatures.<flag>`; plugins come from `plugins.list()`.
- **Category filter bar**: All · Automation · Agents · UI/Themes · Data/Insights · Dev Tools (from the new
  manifest `category` field, fallback derived from a plugin's dominant contribution bucket; Encore features
  get fixed categories).
- **"Only installed" toggle** + search + sort.
- **Details view** (`ExtensionDetails`): full desc, version, author, **trust/signature**, **requested
  permissions with risk colors** (`getPermissions`), contributions summary (`contributions()` by pluginId).
  Actions: Install · Uninstall (`plugins:uninstall`) · Enable/Disable (`setEnabled`) · Configure
  (`requestConsent` + the contributed settings) · Revoke (`revokeGrants`).
- Promoted from the current Encore section (`Settings/tabs/EncoreTab.tsx` + `PluginsPanel.tsx`) to its own
  Extensions view.
- _Acceptance:_ extend `e2e/plugins.spec.ts` — seed 2 plugins, assert grid render, category filter,
  only-installed toggle, details permissions list, install→enable→configure→uninstall round-trip.

## Worktree decomposition + merge strategy

- **Integration branch**: `feat/autonomous-manager-agent` (current).
- **Order**: P0 contracts → merge → rebase. Then P1 + P3(read-only parts) + marketplace-ui in **parallel
  worktrees**; P2 act-verbs after P0; P4 lifts per-feature as prereqs land.
- **Collision hotspots** (contracts-first minimizes them): `src/main/index.ts` (HostHandlerDeps wiring —
  each WS adds one dep line), `permissions.ts`, `rpc-protocol.ts`, `events.ts`, `host-api.ts`. WS-contracts
  lands all vocab/method/event additions first; feature worktrees only _consume_ them.
- **Per-worktree contract**: branch from integration; skip project-wide gates; extend the e2e harness with
  its acceptance probe; PR back; **Linux CI is the merge gate**.
- **Regression spine**: the e2e plugin harness is the living regression suite — every new capability gets a
  fixture probe (PASS/INERT/DENY), every event a delivery test, every UI piece an e2e.

## First wave (executing now)

1. **WS-contracts** (P0) — land on the branch first (main owns it).
2. Parallel worktrees: **WS-ui-command**, **WS-marketplace-ui**, **WS-settings-ui**, **WS-keybindings**,
   **WS-grant-ledger**, **WS-act-verbs**.
3. Integrate each (verify with the harness) and merge back.
