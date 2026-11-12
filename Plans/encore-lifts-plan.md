# Encore Lifts - every Encore feature becomes a managed first-party plugin

Status: COMPLETE (wave landed 2026-07-02).
Directive: ALL Encore features are plugins and are MANAGED as plugins.

## Workstream status (end of wave)

| WS  | Scope                                                                     | Status | Notes                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0  | Foundation: shared registry + generalized bridge + marketplace projection | LANDED | `src/shared/plugins/first-party.ts`, `src/main/plugins/first-party-bridge.ts`; clean cutover from the pianola-specific modules.                                                                                                                                                                                                 |
| L1  | Pianola lift + shared toggle routing                                      | LANDED | `plugins:first-party-set-enabled` IPC; marketplace toggle routes ALL five flags through the bridge; Background-services section on first-party details.                                                                                                                                                                         |
| L2  | Director's Notes lift                                                     | LANDED | Honest permissions (history/transcripts/sessions/settings/toast); no background services (all surfaces on-demand).                                                                                                                                                                                                              |
| L3  | Maestro Cue lift                                                          | LANDED | Supervised `cue.engine` (watchers/pollers/heartbeat) stops on disable.                                                                                                                                                                                                                                                          |
| L4  | Symphony lift                                                             | LANDED | Honest permissions incl. storage:read/write + sessions:create; no background services.                                                                                                                                                                                                                                          |
| L5  | Usage & Stats lift                                                        | LANDED | Supervised `stats.sampler`; startup arming gated on the flag.                                                                                                                                                                                                                                                                   |
| L6  | Management-surface completion                                             | LANDED | First-party permission disclosure on details ("Granted on enable"); EncoreTab section toggles replaced by state pill + "Manage in Extensions" (config stays); `statsCollectionEnabled` sync moved into the marketplace toggle; e2e covers all five tiles, bridge round-trip (flag + grant mint), service rows, disclosure rows. |

L6 refinement (recorded): the EncoreTab config sections KEEP their headers and
`data-setting-id` anchors (searchable-settings parity), but the header toggle
affordance is gone - state display + jump-to-tile only. Feature CONFIG
(cue settings, DN agent config, symphony registry URLs, wakatime) is untouched
and renders when the feature is enabled, exactly as before.

## The lift model (decided)

**First-party plugin-backed** - the pianola pattern, per the roadmap's own P4
note ("each lift keeps a thin host shim; the legacy Encore flag becomes a
first-party plugin entry in the marketplace"):

- Each feature declares **first-party plugin metadata**: stable plugin id,
  category, permission requests (honest disclosure of what it touches),
  background services, settings namespace.
- The **Extensions marketplace is the management surface**: enable/disable,
  permission visibility, status, configure - every feature is a tile with
  details, exactly like a community plugin.
- Lifecycle routes through a **host-owned bridge** (generalized from
  `pianola-plugin-bridge.ts`): enable = flag flip + first-party grant mint;
  disable/revoke = supervised work stops; grants gone = feature force-off.
- Implementation code stays first-party (no vm sandbox for built-ins), but
  every host effect it performs SHOULD flow through the same seams plugins
  use (event bus, background supervisor, decisions/audit) where they exist.
- **NOT in this model:** physically rewriting rich React UI (Director's Notes
  dashboards, Usage Stats charts) into sandboxed webview panels. The render
  host is for community plugins; first-party UI stays native. What changes is
  MANAGEMENT + metadata + lifecycle, and progressively the effect seams.

**Known constraint (recorded):** `agents:dispatch` cannot be declared in
static first-party metadata (FC2 allowlist requires exact targets; pianola +
cue dispatch to dynamic sessions). Dispatch authority stays host-owned per
feature until a runtime grant seam is designed. Documented in
`first-party-plugin.ts`.

## Workstreams

### L0 - Foundation (blocks all features)

- Generalize `src/shared/pianola/first-party-plugin.ts` into
  `src/shared/plugins/first-party.ts`: a `FirstPartyPluginDefinition`
  interface + a `FIRST_PARTY_PLUGINS` registry keyed by Encore flag
  (id, name, description, category, permissions, backgroundServices,
  settingsNamespace, encoreFlag). Pianola's metadata moves in as the first
  entry (keep a re-export at the old path until callers migrate - then remove).
- Generalize `src/main/pianola/pianola-plugin-bridge.ts` into
  `src/main/plugins/first-party-bridge.ts`: one bridge instance per
  definition; enable() mints the declared grants host-side (first-party =
  trusted by construction; the marketplace tile shows the permission list as
  disclosure), disable()/revoke() stop supervised services + clear the flag.
- `extensionModel.ts`: every BUILTIN_FEATURES entry becomes pluginBacked with
  its definition's id/category/permissions (pianola already is; extend to
  directorNotes, usageStats, symphony, maestroCue).
- ExtensionDetails for first-party tiles: show declared permissions +
  background-service status (FC5 `background.list` style), Configure jumps to
  the feature's config section.
- _Acceptance:_ unit tests for registry + bridge; extensionModel tests updated;
  every Encore flag flips correctly through the marketplace tile.

### L1..L5 - Per-feature lifts (parallel after L0)

| WS  | Feature          | Plugin id                  | Category   | Declared permissions (disclosure)                                                                      | Background services                                        |
| --- | ---------------- | -------------------------- | ---------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| L1  | Pianola          | com.maestro.pianola        | agents     | settings:read, agents:read, transcripts:read, decisions:write, notifications:toast, background:service | pianola.supervisor (exists)                                |
| L2  | Director's Notes | com.maestro.director-notes | insights   | history:read, transcripts:read, sessions:read, settings:read                                           | director-notes.synopsis (agent-backed synopsis generation) |
| L3  | Maestro Cue      | com.maestro.cue            | automation | fs:watch, settings:read, notifications:toast, background:service, shell (github polling = net)         | cue.engine (watchers/pollers/heartbeat)                    |
| L4  | Symphony         | com.maestro.symphony       | agents     | settings:read, net:fetch (registry), sessions:read                                                     | -                                                          |
| L5  | Usage Stats      | com.maestro.usage-stats    | insights   | storage:sql, settings:read, history:read                                                               | stats.sampler (usage sampling loop)                        |

Each feature worker:

1. Adds its `FirstPartyPluginDefinition` (exact permission list refined
   against what the feature ACTUALLY touches - grep its IPC/services; the
   table above is the starting claim, not the contract).
2. Wires its lifecycle through the shared bridge (flag ↔ grants ↔ services).
3. Registers long-running work as supervised background services where the
   feature has any (cue engine, stats sampler, DN synopsis agent) so the
   marketplace shows live status and disable ACTUALLY stops work.
4. Keeps feature config reachable: marketplace tile → Configure → the
   feature's existing config surface (EncoreTab section or modal).
5. Unit tests for definition + lifecycle; extensionModel projection test row.

### L6 - Management-surface completion (after L1..L5)

- EncoreTab: the per-feature toggle tiles are GONE (management = marketplace);
  remaining EncoreTab sections are config-only, each reachable from its
  tile's Configure.
- searchableSettings: encore-\* entries point at marketplace anchors.
- e2e: extensions marketplace test grows rows for all five first-party tiles
  (enable/disable round-trip through the bridge, permission display,
  background-service status for cue/pianola/stats).

## Sequencing

L0 first (single worker). L1–L5 parallel. L6 last (single worker, owns
EncoreTab + e2e). Collision control: `src/main/index.ts` wiring goes through
the L0 worker's bridge-construction site; feature workers DM patches if needed.

## Out of scope

- Sandboxing first-party code (they're host code; trusted by construction).
- Community-plugin re-implementations of these features.
- cue:emit capability design (still follow-on).
- Uninstalling first-party plugins (tiles support disable, not uninstall).
