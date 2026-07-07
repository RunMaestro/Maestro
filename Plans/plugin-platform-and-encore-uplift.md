# Plugin Platform + Encore Uplift — build plan

Goal: make the plugin system a **complete extension surface** for Maestro, **lift each Encore feature
into a plugin**, and **surface plugins as "Encore Features"** in a tiled marketplace (category filters ·
details view with install/uninstall/configure · "only installed" toggle). Built across parallel
worktrees and merged back.

## Security model (decided)

Current live model: **trusted-signed plugin + explicit per-capability consent + Pianola risk gate**.
Tier-1 plugin code still runs in an Electron `utilityProcess` with an empty env and an in-child `vm`;
that is crash isolation and defense-in-depth, not OS confinement. OS-level sandboxing remains future
hardening, so high-power verbs must price code-tier plugins as trusted code and keep every host effect
behind broker authorization, consent, risk gating, and audit-before-action.

## What blocks the Encore lifts today

The lifts are **feasible**. Wave 1 already landed the command bridge, keybindings, and Extensions
marketplace baseline. Remaining blockers are the persistent grant ledger, settings contribution writes,
hot reload, SDK distribution, rich render host, broader host APIs, intentionally gated high-power verbs,
and the Pianola first-party plugin lift.

## Workstreams (layered; each WS = one worktree/branch + an acceptance test that extends the e2e harness)

### P0 — Contracts (done; single owner = main; everyone rebases)

Pure additive contract changes are implemented so feature worktrees build against stable types.

- **WS-contracts**: DONE. Capability vocab (`history:read`, `sessions:create`, `sessions:write`,
  `tabs:manage`, `transcripts:write`, `decisions:write`, `shell:openExternal`, `storage:sql`,
  `fs:watch`, `power:preventSleep`, `background:service`) lives in `permissions.ts`; matching
  `HOST_API` methods live in `rpc-protocol.ts`; event topics + richer payloads (`history.entryAdded`,
  `agent.completed` w/ output, chain lineage / token totals / provider session id / queue depth) live in
  `events.ts`; optional manifest `category` is mirrored; `HOST_API_VERSION` is `1.7.0`; the
  `@maestro/plugin-sdk` mirror is re-vendored and drift-tested.
  _Acceptance verified:_ `bunx vitest run src/__tests__/shared/plugins/plugin-manifest.test.ts src/__tests__/shared/plugins/plugin-dispatch-gate.test.ts src/__tests__/main/plugins/plugin-host-handlers.test.ts src/__tests__/main/plugins/plugin-event-bus.test.ts src/__tests__/main/ipc/plugin-session-events.test.ts` (5 files, 73 tests passed) and `bunx vitest run --config vitest.config.ts src/__tests__/drift.test-d.ts src/__tests__/sdk.test.ts` in `packages/plugin-sdk` (2 files, 9 tests passed, type errors 0).

### P1 — Foundations (parallel worktrees, buildable now, independent)

- **WS-ui-command**: DONE. Renderer command registry + plugin `ui:command` bridge are integrated; the
  harness covers command dispatch and the palette still works.
- **WS-keybindings**: DONE. `KeybindingContribution` chords are consumed and dispatch plugin commands.
- **WS-marketplace-ui**: DONE baseline. Extensions surface lists Encore features/plugins with category,
  installed/enabled state, details, permissions, and lifecycle actions; keep extending its e2e probes as
  new capabilities land.
- **WS-settings-ui**: render `SettingContribution`s + bidirectional write bridge to `plugins.<id>.*`.
  _Acceptance:_ e2e settings round-trip via the Extensions details surface, including disabled-plugin denial.
- **WS-grant-ledger**: security state-machine hardening DONE. Missing/corrupt keyring freshness
  anchor with an existing sealed ledger now drops prior grants, reports `re-consent`, and does not
  bless a new anchor until explicit re-consent; refresh-time verification now disables any
  non-authorized result, including `not-authorized`. _Acceptance verified:_ `bun vitest run
src/__tests__/main/plugins/authorization-ledger.test.ts src/__tests__/main/plugins/plugin-manager-verify.test.ts` (2 files, 31 tests passed). Remaining
  acceptance: e2e relaunch - grants survive, revoke invalidates, corrupt anchor requires re-consent.
- **WS-hot-reload**: plugins-dir watcher → reload the plugin child on change (dev mode).
  _Acceptance:_ edit fixture → reload observed; manifest expansion cannot inherit new caps; removed plugins
  tear down handlers/services.
- **WS-sdk-dist**: archive-install sub-scope DONE. CLI pack now uses the shared archive packer;
  `PluginManager.install()` accepts `.tgz` / `.tar.gz`, safe-extracts to temp staging, rejects traversal
  - link entries, excludes unsigned `node_modules`, and installs through the same validated directory path.
    Publish/update support remains tracked by this broader workstream. _Acceptance verified:_
    `bun vitest run src/__tests__/main/plugins/plugin-manager-verify.test.ts src/__tests__/cli/commands/plugin.test.ts src/__tests__/main/plugins/plugin-manager-update.test.ts` (3 files, 27 tests passed).
- **WS-render-host**: current-scope rich UI host for trusted+consented plugins (isolated Chromium surface:
  no Node, contextIsolation, per-plugin partition, broker-only preload, navigation/egress lockdown) + consume
  the agent registry. _Acceptance:_ trusted+granted panel renders; untrusted/ungranted denied; contributed
  agent appears in the appropriate UI.

### P2 — High-power act verbs (parallel after P0; trust+consent+risk-gated)

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
   AgentRun ledger/dashboard projection DONE for the CLI orchestrator path: Pianola remains the
   orchestrator, while Pianola campaigns expose deterministic per-task `runId`s and `pianola orchestrate`
   writes `AgentRun` records/events for dispatched / completed / failed tasks. Legacy agent-bound tasks
   recover provider type from live `sessionId` lookup before ledger writes. The renderer now has a
   first-party AgentRun Dashboard modal opened from Quick Actions; it lists runs/campaigns, renders run
   detail and event timelines, can jump to a linked Maestro session/tab when `sessionId` data exists, and
   treats Pianola campaign/task projections as read-only visibility rather than Pianola execution authority.
   Manual smoke path: with `bun run dev`, create a run with `bun src/cli/index.ts agent-run record --file
<json> --json`, append a timeline event with `agent-run append-event <run-id> --type status_change
--status completed --message <msg> --json`, open Quick Actions → AgentRun Dashboard, refresh, select
   the run, and confirm detail/timeline refresh. Deferred: universal non-Pianola lifecycle capture and
   Interceptor-backed app smoke remain separate verification work when the Interceptor CLI is available.
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
