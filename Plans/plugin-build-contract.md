# Plugin extensibility build - historical contract for parallel workstreams

Worktree: `.worktrees/autonomous-manager-agent`. This file was the Wave 1 coordination contract for
parallel plugin workstreams. It is retained as history, not binding implementation guidance. For current
work, use `ISA.md` for completion status, `Plans/plugin-platform-and-encore-uplift.md` for the roadmap,
and the source files listed below for contract truth.

## Current source files to cross-check

- `src/shared/plugins/permissions.ts` - capability vocab includes the original file/net/agent/notification/settings
  capabilities plus the P0 additions for sessions, history, transcripts, storage KV/SQL, events, tabs,
  shell/process, decisions, power, background services, and UI contribution/render surfaces. Scope and
  risk metadata live there; do not copy a stale capability list from this file.
- `src/shared/plugins/rpc-protocol.ts` - ONE data-driven `HOST_API` table: method -> {capability}.
  `HostMethod`, `HOST_METHODS`, `HOST_METHOD_CAPABILITY` are DERIVED from it. The P0 host-method
  surface now includes settings, sessions/tabs/history/transcripts, storage KV/SQL/fs-watch, events,
  shell/open/process, decisions, power, background, and UI command/contribution methods. Some high-risk
  methods are intentionally optional until their real dependencies are wired in `src/main/index.ts`.
- `src/shared/plugins/events.ts` - fixed metadata-only `PLUGIN_EVENT_TOPICS`, `PluginEvent`,
  `PluginEventPayloads`, and the `PluginEventBus` interface the events handlers code against.
- `src/shared/plugins/contribution-registry.ts` - `mergeContributions`: the ONE merge contract
  (built-in-always-wins, earlier-plugin-wins, dropped-with-error, provenance).
- `src/shared/plugins/contributions.ts` - host-rendered contribution shapes for UI items, panels,
  settings, tools, keybindings, agents, commands, command macros, Cue triggers, themes, prompts, and
  background services.
- `src/shared/plugins/plugin-archive.ts` - shared CLI/host archive contract: pack signed plugin files,
  exclude unsigned/runtime dependency trees by policy, and safe-extract `.tgz`/`.tar.gz` installs with
  traversal/link-entry rejection before `PluginManager.install()` copies into the installed plugins dir.
- `src/main/plugins/action-guard.ts` - `ActionGuard.begin(pluginId, capability, target?)` returns
  `{ok,release}|{ok:false,reason}`: rate + concurrency + audit-before-action for high-risk verbs.
- `src/shared/plugins/host-api.ts` - current source of truth for `HOST_API_VERSION` (1.7.0 at the
  time this roadmap was reconciled).

## Historical security constraints from Wave 1

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
3. `fs:read` AND `fs:write` scopes MUST structurally EXCLUDE the userData/config tree - grants file,
   enable-state, `encoreFeatures.*` settings, agent-configs, the CLI/WS token (`cli-server.json`),
   the plugins dir, plugin KV, pianola supervisor targets, transcripts - enforced in the broker/
   handler AFTER symlink/real-path resolution (not by consent wording).
4. `net:fetch`: keep `redirect:'error'`; add a resolved-IP egress policy that BLOCKS loopback,
   link-local (169.254.0.0/16, ::1, fe80::/10), RFC1918 (10/8, 172.16/12, 192.168/16), and cloud
   metadata (169.254.169.254); re-validate the IP actually connected to (defeat DNS rebinding). The
   CLI/WS token and the app's own loopback web-server port are NEVER reachable.
5. Security-state files (grants, enable-state, `encoreFeatures.*`, trusted keys, supervisor targets,
   agent-config overrides) are NEVER writable by any plugin capability.
6. `agents:dispatch` and `process:spawn` are not generic execution escape hatches. They may only be
   wired through injected deps that re-check broker authorization, trusted signature posture, Pianola
   low/medium risk, sanitized cwd/env/options, and audit-before-action.
7. Historical UI constraint: plugin UI was scoped to opaque-origin iframes and below first-party
   modals/consent dialogs. Current render-host work may use a richer isolated Chromium surface, but it
   must preserve no Node access, context isolation, broker-only preload, navigation/egress lockdown,
   visible provenance, and built-in-wins registry behavior.
8. Uninstall is complete: purge plugin dir, grants, enable-state, `plugins.<id>.*` settings, KV,
   scheduled triggers, supervisor targets, agent-config overrides.
9. Wrap high-risk write verbs (`fs:write`, `settings:write`, `storage:write`) with `ActionGuard`.

## Historical partition

- A - main-process plugin backend. B - renderer registries. D - docs. Main (me) wired `index.ts`.
- Workstream agents originally avoided `src/main/index.ts`; later integration work did touch it to wire deps.
- Handlers take INJECTED deps (define a deps interface); never call electron/stores directly in a
  way that blocks unit tests. The integrator implements the deps against real modules.

## Working rules

- TypeScript, tabs, no em/en dashes. Files < ~800 lines (split if needed).
- Write focused unit tests for your own code (vitest). Do NOT run project-wide lint/typecheck/build
  or formatters - the integrator runs all gates once at the end across the union of changes.
- Report exactly which files you created/edited and the deps interface the integrator must wire.
