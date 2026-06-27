# Plugin extensibility build — contract for parallel workstreams

Worktree: `.worktrees/autonomous-manager-agent`. We are building Phase 1 (declarative
breadth) + Phase 2 (brokered read/act verbs) of the plugin extensibility plan, and documenting
Phases 3-4. The shared-contract SPINE is already committed (do not modify it). Build against it.

## Committed spine (read these; do NOT change them)

- `src/shared/plugins/permissions.ts` — capability vocab now includes: `settings:write`,
  `sessions:read`, `storage:read`, `storage:write`, `ui:command`, `events:subscribe` (plus the
  originals). All new caps have ScopeKind `none` (structurally confined by their handler, not by a
  user scope). `capabilityRisk`, `describeCapability`, `isPermitted` already handle them.
- `src/shared/plugins/rpc-protocol.ts` — ONE data-driven `HOST_API` table: method -> {capability}.
  `HostMethod`, `HOST_METHODS`, `HOST_METHOD_CAPABILITY` are DERIVED from it. New methods present
  and INERT (no handler yet): `settings.set`, `sessions.list`, `sessions.get`, `storage.get`,
  `storage.keys`, `storage.set`, `storage.delete`, `ui.runCommand`, `events.subscribe`,
  `events.unsubscribe`. `HostControlMessage` has a new `{ kind:'event'; topic; at; payload }` push.
- `src/shared/plugins/events.ts` — fixed `PLUGIN_EVENT_TOPICS` (metadata-only), `PluginEvent`,
  `PluginEventPayloads`, and the `PluginEventBus` interface the events handlers code against.
- `src/shared/plugins/contribution-registry.ts` — `mergeContributions` / `mergedItems`: the ONE
  merge contract (built-in-always-wins, earlier-plugin-wins, dropped-with-error, provenance).
- `src/shared/plugins/contributions.ts` — `PanelContribution` now has a required `placement`
  (`'modal'|'left'|'right'|'main'|'settings'`, default `modal`).
- `src/main/plugins/action-guard.ts` — `ActionGuard.begin(pluginId, capability, target?)` →
  `{ok,release}|{ok:false,reason}`: rate + concurrency + audit-before-action for high-risk verbs.
- `src/shared/plugins/host-api.ts` — `HOST_API_VERSION = '1.2.0'`.

## NON-NEGOTIABLE security invariants (every workstream MUST honor)

1. Default-deny stays the only path: every host effect goes through `PermissionBroker`; never hand
   a plugin a credential/handle/token/channel/socket. No generic eval/exec/invoke(channel).
2. New caps are confined STRUCTURALLY by their handler:
   - `storage:*` → a per-plugin dir under userData (e.g. `<userData>/plugin-data/<pluginId>/`); a
     plugin can ONLY touch its own store. Bounded value size + key count.
   - `settings:write` → ONLY keys under `plugins.<pluginId>.*`, and only NON-secret values; never
     `encoreFeatures.*`, never any security-state key.
   - `sessions:read` → session METADATA ONLY (id, title, agentId, status, timestamps, projectPath).
     NEVER raw transcript/message content (redaction is not a boundary for free-form text).
   - `ui:command` → only invokes a registered command-palette command; never a privileged internal
     IPC/WS verb; plugin cannot fabricate a channel.
   - `events:subscribe` → only the fixed metadata-only topic catalog; re-authorize EVERY delivery
     against live grants (instant revoke).
3. `fs:read` AND `fs:write` scopes MUST structurally EXCLUDE the userData/config tree — grants file,
   enable-state, `encoreFeatures.*` settings, agent-configs, the CLI/WS token (`cli-server.json`),
   the plugins dir, plugin KV, pianola supervisor targets, transcripts — enforced in the broker/
   handler AFTER symlink/real-path resolution (not by consent wording).
4. `net:fetch`: keep `redirect:'error'`; add a resolved-IP egress policy that BLOCKS loopback,
   link-local (169.254.0.0/16, ::1, fe80::/10), RFC1918 (10/8, 172.16/12, 192.168/16), and cloud
   metadata (169.254.169.254); re-validate the IP actually connected to (defeat DNS rebinding). The
   CLI/WS token and the app's own loopback web-server port are NEVER reachable.
5. Security-state files (grants, enable-state, `encoreFeatures.*`, trusted keys, supervisor targets,
   agent-config overrides) are NEVER writable by any plugin capability.
6. Registration != execution. Do NOT wire `agents:dispatch` or `process:spawn` — they stay inert
   (Phase 4, documented only).
7. Plugin UI stays an opaque-origin iframe (srcDoc + sandbox="allow-scripts", NEVER
   allow-same-origin, NEVER a URL src, NEVER dangerouslySetInnerHTML in trusted chrome), even when
   docked inline; z-clamped strictly BELOW first-party modals/consent dialogs; mandatory,
   non-suppressible provenance shown on every plugin-contributed surface; built-in-wins on every
   registry.
8. Uninstall is complete: purge plugin dir, grants, enable-state, `plugins.<id>.*` settings, KV,
   scheduled triggers, supervisor targets, agent-config overrides.
9. Wrap high-risk write verbs (`fs:write`, `settings:write`, `storage:write`) with `ActionGuard`.

## Partition (no two workstreams touch the same file)

- A — main-process plugin backend. B — renderer registries. D — docs. Main (me) wires `index.ts`.
- NOBODY edits `src/main/index.ts` (the integrator wires deps there).
- Handlers take INJECTED deps (define a deps interface); never call electron/stores directly in a
  way that blocks unit tests. The integrator implements the deps against real modules.

## Working rules

- TypeScript, tabs, no em/en dashes. Files < ~800 lines (split if needed).
- Write focused unit tests for your own code (vitest). Do NOT run project-wide lint/typecheck/build
  or formatters — the integrator runs all gates once at the end across the union of changes.
- Report exactly which files you created/edited and the deps interface the integrator must wire.
