# CLAUDE-PLUGINS.md

Architectural reference for **Maestro Plugins** - the third-party extension system whose pure contracts live in `src/shared/plugins/` and whose main-process runtime lives in `src/main/plugins/`. For the practical authoring guide (how to write a plugin, full manifest reference, worked examples), see [docs/agent-guides/PLUGIN-DEVELOPMENT.md](docs/agent-guides/PLUGIN-DEVELOPMENT.md). This doc is the **why** and the **gotchas** - read it before changing anything in `src/main/plugins/` or `src/shared/plugins/`.

## 30-second mental model

A plugin is one folder under `<userData>/plugins/` containing a `plugin.json` manifest. Plugins come in three trust tiers: tier 0 is data-only (declarative contributions, no code), tier 1 runs sandboxed code, tier 2 adds sandboxed UI. The whole feature is behind the `plugins` Encore flag (off by default). At startup the `PluginManager` discovers folders, validates each manifest, checks host-API compatibility and signature, and applies a persisted enable toggle. Tier 0 contributions (themes, prompts, settings, command macros, cue triggers) feed host registries directly. A tier-1 plugin stays disabled until the user enables it and consents to its capabilities; on enable, the `PluginSandboxHost` forks one Electron `utilityProcess` per plugin and runs the plugin's `entry` code in a `vm` context. Every host call the plugin makes is an RPC that the `PermissionBroker` authorizes (default deny) before a host handler executes it. UI panels render in a locked-down sandboxed iframe whose only channel out is a single narrow `postMessage` bridge.

## Status / gating

- Entire system is gated on `encoreFeatures.plugins === true` (off by default), re-read per call.
- Every `plugins:*` IPC channel throws the sentinel `'PluginsDisabled'` when the flag is off, so the renderer can distinguish "feature off" from "no plugins installed". The gate runs OUTSIDE `withIpcErrorLogging` so the sentinel is not logged as a real failure.
- `PluginManager.getActiveRecords()`, `getContributions()`, and `getAgentRegistry()` all return empty when the flag is off, regardless of what is on disk.
- `HOST_API_VERSION = '1.26.0'` (`src/shared/plugins/host-api.ts`) is the single source of truth for the host surface version.

## File map

Pure, bundle-safe contracts (no Electron, no fs) in `src/shared/plugins/`:

| File                                                                                                   | Owns                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-manifest.ts`                                                                                   | `PluginManifest`, `PluginTier`, `PLUGIN_ID_PATTERN`, `validatePluginManifest`, entry-traversal guard                                        |
| `permissions.ts`                                                                                       | `PluginCapability`, `PLUGIN_CAPABILITIES`, risk/scope maps, `PermissionRequest`/`PermissionGrant`, `isPermitted` (the default-deny matcher) |
| `contributions.ts`                                                                                     | every contribution interface, host-view block-size contract, `collectContributions`, `aggregateContributions` (built-in-wins merge)         |
| `events.ts`                                                                                            | `PLUGIN_EVENT_TOPICS`, `PluginEventPayloads` (metadata only)                                                                                |
| `host-api.ts`                                                                                          | `HOST_API_VERSION`, `isHostApiCompatible` (semver gate)                                                                                     |
| `rpc-protocol.ts`                                                                                      | `HOST_API` method->capability table, `HostRequest`/`HostResponse`/`HostControlMessage`, `extractTarget`                                     |
| `signing.ts`                                                                                           | `SIGNATURE_FILENAME`, `SignatureStatus`, canonical signing payload                                                                          |
| `capability-policy.ts`                                                                                 | cross-capability rules (`transcripts:read` + egress mutual-exclusion)                                                                       |
| `contribution-registry.ts`, `plugin-registry.ts`, `agent-registry.ts`, `storage.ts`, `theme-bridge.ts` | registry merge + record/storage shapes                                                                                                      |

Main-process runtime in `src/main/plugins/`:

| File                                          | Role                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `plugin-manager.ts`                           | discovery, validation, enable toggle, install/uninstall, sandbox reconcile, panel-html read       |
| `plugin-sandbox-host.ts`                      | forks one `utilityProcess` per tier-1 plugin; the only path a child affects the host; caps/limits |
| `plugin-sandbox-entry.ts`                     | runs inside the child; `vm` bootstrap + `buildSdk` (the `maestro` SDK)                            |
| `plugin-host-handlers.ts`                     | brokered RPC implementations (fs/net/settings/sessions/storage/events/...)                        |
| `permission-broker.ts`                        | default-deny authorization gate; re-authorizes resolved fs paths                                  |
| `net-egress-guard.ts`                         | SSRF / DNS-rebind guard for `net:fetch`                                                           |
| `plugin-kv-store.ts`                          | per-plugin private key-value store                                                                |
| `plugin-event-bus.ts`                         | host->plugin event delivery, re-authorized per delivery                                           |
| `action-guard.ts`, `plugin-scheduler-host.ts` | write-verb rate/concurrency guard; supervised cue-trigger scheduler                               |
| `plugin-signature.ts`, `plugin-store-main.ts` | ed25519 verify; on-disk state/grants and `pluginsDir()`                                           |
| `plugin-panel-host.ts`                        | panel render host: per-plugin session hardening, `plugin-panel://` protocol, egress/nav denial    |
| `plugin-session-grants.ts`                    | host-held per-session grant set (`granted-sessions`), stored as the dispatch allowlist scope      |
| `plugin-session-fields.ts`                    | which session fields a plugin may set, the granted-root scope rule, `agents.list` entry mapping   |

IPC at `src/main/ipc/handlers/plugins.ts`. Renderer at `src/renderer/components/plugins/PluginPanelFrame.tsx` plus `src/renderer/components/Settings/{PluginsPanel,PluginConsentDialog,PluginPanelHost}.tsx` and `src/renderer/hooks/usePluginContributions.ts`.

## Tiers

`PluginTier` is `0 | 1 | 2` (`plugin-manifest.ts`).

- **Tier 0 - data only.** Declarative contributions, NO code. `entry` is forbidden. Lowest risk. Auto-enables on discovery.
- **Tier 1 - sandboxed compute.** Runs `entry` code in an isolated `utilityProcess` behind the permission broker. `entry` is required.
- **Tier 2 - UI contributions.** Sandboxed panels / modals / commands. Also a code tier (`tier >= 1`), so `entry` is required.

Loadability is gated by `isHostApiCompatible(minHostApi, hostVersion)`: absent `minHostApi` is compatible; invalid semver is NOT; the major must match exactly; within a major the host must be `>=` the declared minimum.

## Lifecycle (`plugin-manager.ts`)

```
discover folders under pluginsDir()
  -> read + validate plugin.json (validatePluginManifest)
  -> host-API compat check (isHostApiCompatible)
  -> signature verify (verifyPluginSignature)
  -> apply persisted enable toggle
       (tier 0 auto-enables on first discovery; tier >= 1 stays DISABLED
        until the user enables = consents; a stored toggle always wins)
  -> reconcileSandboxes(): start runnable tier-1 children, stop the rest
```

- `refresh()` rebuilds the registry from disk and is the ONLY place sandboxes are reconciled and `onChange` (-> `plugins:changed`) fires. It re-reads disk so manual installs/removes are picked up.
- `isRunnable(record)` = `enabled && loadStatus === 'ok' && manifest && tier >= 1 && entry && signature.status !== 'invalid'`. Tampered (`invalid`) code is NEVER run.
- `install(sourceDir)` copies a source folder into `pluginsDir()/<id>`, rejecting an invalid manifest, an id collision, or any symlink in the tree (a symlink could escape the plugin dir).
- `uninstall(id)` stops the sandbox, removes the dir (only inside `pluginsDir()`), then purges everything the plugin owns: enable toggle (`forgetPlugin`), grants (`forgetGrants`), and via `purgePluginData` its KV store, `plugins.<id>.*` settings, and live event subscriptions. Uninstall leaves nothing behind.

## Tier-1 runtime: sandbox + broker + handlers

```
plugin entry code (vm context, child utilityProcess)
   | maestro.<area>.<method>(...)        the frozen SDK from buildSdk()
   v
HostRequest { id, method, params }  ---postMessage--->  PluginSandboxHost (main)
                                                          | validate method + shape, cap size
                                                          v
                                              PermissionBroker.authorize()   default DENY
                                                          | allowed?
                                                          v
                                              host handler (plugin-host-handlers.ts)
                                                          | result / error
                                                          v
HostResponse { id, ok, result?, error? } <---postMessage---
```

- **Sandbox host (`plugin-sandbox-host.ts`).** One `utilityProcess` per running tier-1 plugin (process + crash isolation). It treats the child as hostile: validates the method against `HOST_METHODS`, caps a single message at `MAX_MESSAGE_BYTES = 1_000_000` (1 MB), enforces `MAX_IN_FLIGHT = 32` concurrent calls and a sliding window of `RATE_MAX_PER_WINDOW = 200` per `RATE_WINDOW_MS = 1000`, and never evaluates anything the child sends. Teardown sends a `shutdown` control message then hard-kills after `SHUTDOWN_GRACE_MS = 2000`.
- **The SDK (`plugin-sandbox-entry.ts` `buildSdk`).** A frozen object; every method is a thin broker-gated RPC (`hostCall`). There is no direct host access. Method->capability mapping is the data-driven `HOST_API` table in `rpc-protocol.ts`; the broker reads `HOST_METHOD_CAPABILITY` from it.
- **Broker (`permission-broker.ts`).** Resolves the required capability and the call's target (`extractTarget`), then checks live grants with `isPermitted`. It does NOT execute - the sandbox host runs the handler only after `authorize` returns allowed. Grants are re-read each call via `getGrants` so a revoke takes effect immediately. Authorization is separate from execution so the gate is unit-testable without Electron or fs.
- **Handlers (`plugin-host-handlers.ts`).** The real implementations. Highlights:
  - `fs.read` / `fs.write`: expand a leading `~` (`expandPluginHomePath`), resolve the symlink-real path, then RE-authorize it against the broker (`authorizeRealPath`) so a symlink inside a granted scope cannot escape, and the userData/config tree (`protectedPaths`) is denied even under a broad grant. Caps: `MAX_READ_BYTES = 10_000_000`; writes run under the `ActionGuard`.
  - **`~` in a plugin path (host API 1.26.0).** `path.resolve` does not expand `~` and the sandbox has no `process`/`os`, so without this a plugin could not name a file under the user's home at all. `expandPluginHomePath()` (`plugin-home-path.ts`, a thin wrapper over the canonical `expandTilde()`) turns exactly `~` or a leading `~/` into `os.homedir()` and leaves every other string - including `~user/...` - untouched. It is called in exactly two main-process places, which must agree: `resolveRealPath` expands BEFORE resolving (so the real-path re-authorization and the userData exclusion see the true path), and `PermissionBroker.authorize` expands the grant's path scope AND the call target before the pure matcher compares them. Only path-scoped capabilities expand (`isPathScoped`), so a host scope or an exact allowlist member keeps its literal identity. Expansion NEVER moves into `src/shared/plugins/` - those contracts stay free of Node imports so the consent UI and the matcher stay bundle-safe. A manifest may declare a home-relative path scope only as `~/.maestro/<name>[/<more>]`; `parsePermissions` rejects `~`, `~/`, `~/.maestro`, `~/anything-else`, `~user/...`, and any `.`/`..`/empty segment, each with its own message. Absolute scopes are unchanged. The `~/.maestro/` confinement is a THIRD-PARTY rule: `parsePermissions(input, { firstParty: true })` relaxes just that one check for the host-authored `FIRST_PARTY_PLUGIN_DEFINITIONS`, which legitimately name `~/.claude.json`, `~/.codex/config.toml` and `~/Applications/MaestroRun.app` and are reviewed in this repository rather than chosen by a plugin author. `validatePluginManifest` never passes the option, so a `plugin.json` cannot reach the relaxed form; the `~/` prefix requirement and the `.`/`..`/empty-segment ban apply to both principals. Both expand the same way at the broker, so a `~` scope now matches the resolved real path instead of only a literal `~` string.
  - `net.fetch`: `EgressGuard.assertUrlAllowed` blocks loopback / link-local / RFC1918 / cloud-metadata (169.254.169.254) / the app's own loopback port BEFORE any socket opens; fails closed if the connection-pinning dispatcher is unavailable; forces `redirect: 'error'` so a 3xx cannot be followed to a non-granted host; caps the body at `MAX_FETCH_BYTES = 5_000_000`. Returns `{ status, statusText, headers, body }`.
  - `settings.get`: denies secret-looking keys (`SECRET_KEY_PATTERN`), the `encoreFeatures` gate, and any `plugins.<other>.*` namespace that is not the caller's own.
  - `settings.set`: only `plugins.<id>.*` keys; same secret/proto/gate guards; value must be JSON-storable and `<= MAX_SETTINGS_VALUE_BYTES = 64 * 1024`.
  - `sessions.list` / `sessions.get`: projected through `toSessionMetadata` - metadata only, never transcript/prompt text.
  - `sessions.focus`: navigation only, gated by the narrow `sessions:focus` capability (NOT `tabs:manage`, which also carries create/close). Closed `{ sessionId, tabId? }` schema, `assertBrokerAllowed`, unknown sessionId throws. Implemented main-side like `pluginTabsFocus`: both verbs share `pluginAiFocusFields()` (`index.ts`), the main-side mirror of the renderer's `aiTabFocusFields()`, so the jump lands on the AI tab and nulls `activeGroupId` (a focused tiled group would otherwise keep owning the panel). No `tabId` -> the session's current AI tab, else its first; an explicit `tabId` that is not one of THAT session's AI tabs is rejected.
  - **Plugin-set session fields (host API 1.26.0, `plugin-session-fields.ts`).** `sessions.create` / `sessions.update` and the `agents.list` entry mapping no longer do their own field handling in `index.ts`; the pure helpers `resolvePluginSessionCreateFields`, `resolvePluginSessionUpdateFields`, and `mapPluginAgentEntries` own it. A plugin may set `title`/`name`, `agentId`/`toolType`, `projectPath`/`cwd`, `additionalDirectories`, `customModel`, and `customEffort` - and nothing else: the builders copy from an explicit ALLOWLIST of keys, so `customPath`, `customArgs`, `customEnvVars`, `sshRemoteConfig`, and the Claude token-mode fields can never ride along (they decide which binary runs in which environment, which is `process:spawn` wearing a settings hat, and stay user-owned). Unknown keys are ignored, not rejected, matching what `sessions.create` always did with extra params.
    `additionalDirectories` is the one that needed a security rule, because the rest of Maestro turns it into real `--add-dir` flags (`additionalDirArgs`) and into the `{{ADDITIONAL_DIRECTORIES}}` prompt block - the AGENT does the reading, so the plugin's own `fs:read` scope never applies. The host accepts exactly one kind of value: an absolute directory EQUAL to the resolved project root (`projectRoot`, else `cwd`) of a session already in this plugin's grant set (`isSessionGranted`). Relative paths, `..` segments, `~`-relative paths, a SUBDIRECTORY of a granted root (equality, never prefix - prefix matching is how scope checks leak), and the root of an existing but ungranted session are each rejected with their own message. `write: true` is refused for a session-granting plugin: a grant set is a read relationship. An empty list CLEARS the field (a real key delete) rather than persisting `[]`. Normalization goes through the canonical `normalizeAdditionalDirectories` with NO home directory, deliberately, so a `~` survives into the validator and is named rather than silently expanded. A plugin that does NOT use session grants has an empty granted set by construction, so the field is unusable for it - that is the fail-closed answer, not an oversight.
    A create `cwd` expands a leading `~` (`expandPluginHomePath`) and is rejected when it lands in the userData tree; `isUnderProtectedPath` / `normalizeForPrefix` are imported from `permission-broker.ts` so this exclusion and the `fs:*` one cannot drift. `customModel` / `customEffort` are trimmed strings capped at 200 characters; an empty string clears the override. `pluginId` is threaded into `sessionsUpdate` the same way it already was into `sessionsCreate` - HOST-verified, never read from params, because it decides which roots are in reach.
    **No new capability, deliberately.** These ride on `sessions:create` / `sessions:write` / `agents:read` because they convey no reach the user has not already approved: `additionalDirectories` cannot name a path outside the grant set, `customModel` / `customEffort` pick among a provider's own models for an agent the plugin may already create, and the fields that WOULD justify a new capability are refused outright instead. A capability nobody needs still costs a line in the consent window the user must read and weigh, and consent fatigue is a real security cost. Revisit only if a field here can ever point outside the grant set.
  - `transcripts.read`: PROJECTED session content - the caller declares which fields it needs and only allowlisted fields are returned (projection, not redaction). Resolves the session's REAL `projectPath` and RE-authorizes against it (the caller-claimed path is only a broker hint), refuses an untrusted plugin that also holds `net:fetch`/`net:connect`/`process:spawn` (the exfiltration combination), runs under the `ActionGuard` (high-risk rate/concurrency cap), and writes a per-read audit line. The metadata-only event bus is untouched.
  - `storage.*`: per-plugin KV via `kvStore` (values are strings).
  - `events.subscribe` / `unsubscribe`: filtered to the fixed `PLUGIN_EVENT_TOPICS` catalog. Includes `tool.executed`, a metadata-only tool-lifecycle event (tool name + timing, never arguments or results), and `session.activated` `{ sessionId, tabId? }`, emitted from the `sessions:setActiveSessionId` handler with its own 100ms trailing debounce (separate from that handler's 400ms disk-write debounce) and skipped when the focused session did not actually change.
  - `agents.dispatch` and `process.spawn`: LIVE but fully gated. Each registers only when `deps.dispatch` / `deps.spawn` are injected (both are wired in `index.ts`). Every call runs the gate stack: allowlist-scope grant (`assertBrokerAllowed`), trusted signature (`assertTrustedActVerb`), Pianola risk ceiling (`assertLowOrMediumRisk`), a closed input schema, and the `ActionGuard` rate/concurrency cap. `agents.dispatch` ADDITIONALLY requires the separate unattended consent (see below) because plugin-initiated dispatch is never user-present.
  - `net.connect` / `net.send` / `net.close`: LIVE, trusted-only persistent outbound WebSocket. Registers only when `deps.netConnect` is injected. `wss:` only; the connect is pinned through the same `EgressGuard` lookup as `net.fetch` (loopback / RFC1918 / link-local / metadata blocked); caps at `MAX_SOCKETS_PER_PLUGIN = 4` per plugin and `MAX_FRAME_BYTES = 64 KB` per frame in both directions; `send`/`close` re-authorize the still-held host grant on every call so a mid-stream revoke denies the next call. The host owns the real socket; the plugin gets a `socketId` handle and receives frames as `net.connect:<socketId>` topic events (via `pushEvent`, not the `PLUGIN_EVENT_TOPICS` catalog). Sockets are force-closed on disable / crash / uninstall.
  - `ui.panelPost`: requires `ui:panel` and targets ONLY one of the plugin's own declared panels (own-panels-only); JSON-only payload capped at `MAX_PANEL_POST_BYTES = 64 KB`; delivered to the panel page as a `maestro:panelData` window message. One-way push - there is no reply channel back to the sandbox.
  - `ui.openPanel` / `ui.closePanel` / `ui.togglePanel`: requires `ui:panel` (no new consent); built by one shared factory and resolved through the SAME `deps.getPanel` lookup `ui.panelPost` uses, so a plugin can only summon its OWN panels. `ui.openPanel` also opens own `settings` cards (Host API 1.23.0); close/toggle stay modal-only. Other docked placements are rejected. Registered only when `deps.panelVisibility` is wired (fail closed). Main broadcasts `plugins:panel-visibility` `{ pluginId, panelId, action }`; the renderer's App-level `PluginModalPanelMount` drives the `uiStore.openPluginPanelId` field (transient, namespaced `<pluginId>/<panelId>`), and `close` only closes when that exact panel is the open one.

  **Relay conversations.** `agents.send` from the exact trusted `sh.maestro.relay` sandbox signed by the pinned Relay publisher (`src/shared/plugins/relay-identity.ts`) is a normal user conversation transport: it preserves the full prompt and existing headless agent execution configuration without a free-text topic risk veto. Exact-agent grants, trusted signature, separate unattended consent, provider-session ownership, cancellation/progress and ActionGuard still apply. No plugin opts can select this policy. Other plugin sends, `agents.dispatch` (including Relay), scheduler, Pianola and `process.spawn` keep their risk ceiling. The exact declared `sh.maestro.relay/send` MCP reply tool likewise carries conversational text only with a valid host-issued caller proof and live trusted Relay identity; Relay still authorizes the sender, bound guild/channel/thread and outbound policy before brokered network delivery. See [the Relay conversation boundary](docs/relay-host-contract.md#conversation-transport-boundary).

  **Risk rejection is not a review queue.** Automatic paths still return the legacy error string `high-risk prompt: auto-dispatch blocked, surfaced for review` for compatibility with Relay's existing exact error mapping. This does not create a pending approval. Only the scheduler explicitly notifies on a blocked verdict; that toast is not an approval control.

  **Direct dispatch requires unattended consent.** The `agents.dispatch` handler additionally calls the injected `dispatchUnattendedAllowed(pluginId, agentId)` predicate (wired in `index.ts` to `isPermittedUnattended(grantsOf(pluginId), 'agents:dispatch', agentId)`) and denies the call unless the plugin holds the separate, revocable UNATTENDED grant on top of the interactive `agents:dispatch` allowlist grant. The time-based scheduler (`PluginSchedulerHost`) enforces the same unattended check independently and calls the dispatch SINK directly, so it is unaffected by this handler.

## Capabilities

`PLUGIN_CAPABILITIES` (`permissions.ts`), with risk and scope kind:

| Capability            | Risk   | Scope     | Notes                                                                                                                                                                                                                                                           |
| --------------------- | ------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs:read`             | medium | path      | re-authorized against symlink-real path                                                                                                                                                                                                                         |
| `fs:write`            | high   | path      | re-authorized; runs under ActionGuard                                                                                                                                                                                                                           |
| `net:fetch`           | medium | host      | egress-guarded (SSRF/rebind)                                                                                                                                                                                                                                    |
| `net:connect`         | high   | host      | persistent outbound `wss://` socket, egress-guarded + connect-pinned, trusted-only, capped (4 sockets / 64 KB frame); frames delivered as `net.connect:<id>` events; an egress capability for the `transcripts:read` exfiltration rule                          |
| `agents:read`         | low    | none      | list/read agent metadata: id, name, cwd, toolType, and `supportsAdditionalDirectories` (whether the provider turns a directory grant into a real CLI flag)                                                                                                      |
| `agents:dispatch`     | high   | allowlist | LIVE, fully gated: allowlist grant + trusted signature + Pianola risk + ActionGuard + closed schema. Direct plugin dispatch ALSO needs unattended consent. Scope is REQUIRED (unscoped = wildcard = denied): exact agent ids, or the `granted-sessions` keyword |
| `notifications:toast` | low    | none      | raise a toast                                                                                                                                                                                                                                                   |
| `settings:read`       | low    | none      | non-secret app settings; not the feature gate, not a peer plugin's namespace                                                                                                                                                                                    |
| `settings:write`      | low    | none      | ONLY `plugins.<id>.*` keys                                                                                                                                                                                                                                      |
| `sessions:read`       | medium | none      | METADATA only, never transcript text                                                                                                                                                                                                                            |
| `sessions:create`     | high   | none      | create an agent; also carries the host-validated `additionalDirectories` (granted project roots, read-only), `customModel`, `customEffort`, and a `~`-expanding `cwd`. NEVER binary path / args / env / SSH remote / token mode                                 |
| `sessions:write`      | high   | none      | patch an agent's metadata and the same host-validated field set; an empty `additionalDirectories` list clears the field                                                                                                                                         |
| `sessions:focus`      | low    | none      | navigation only: switch to an EXISTING session and land on its AI tab; no tab create/close power (deliberately not `tabs:manage`)                                                                                                                               |
| `transcripts:read`    | high   | path      | PROJECTED session content; project-scoped, re-authorized on the resolved path (or the `granted-sessions` keyword, where the grant set replaces the path match); refused with egress unless trusted; ActionGuard-bounded; audited                                |
| `storage:read`        | low    | none      | own KV                                                                                                                                                                                                                                                          |
| `storage:write`       | low    | none      | own KV                                                                                                                                                                                                                                                          |
| `ui:command`          | low    | none      | invoke a registered palette command                                                                                                                                                                                                                             |
| `events:subscribe`    | medium | none      | metadata-only topics                                                                                                                                                                                                                                            |
| `process:spawn`       | high   | allowlist | LIVE, fully gated: allowlist grant + trusted signature + Pianola risk + ActionGuard + closed schema                                                                                                                                                             |
| `ui:contribute`       | medium | none      | gates declarative `uiItems` in approved host-owned surfaces; every surface uses this same capability                                                                                                                                                            |
| `ui:panel`            | medium | none      | gates sandboxed `panels` in approved Maestro regions                                                                                                                                                                                                            |
| `ui:hostView`         | medium | none      | drives brokered updates/removals of the plugin's declared native BlockView data; no plugin renderer runs                                                                                                                                                        |
| `ui:render-unsafe`    | high   | none      | high-trust custom UI only in host-approved, non-protected regions; never a trusted-chrome bypass                                                                                                                                                                |

`PermissionRequest = { capability, scope?, reason? }`. Scopes narrow `fs:*` (a directory), `net:fetch` (a host), and `transcripts:read` (a project path, or `granted-sessions`); for the allowlist-scoped act verbs the scope is REQUIRED and names exact targets. An absent scope means the broad form for path/host capabilities (the consent UI must present it as such) and a DENY for an act verb. The user grants a subset at the consent dialog (`plugins:set-grants`).

## Contributions + registry merge

`collectContributions` validates one plugin's `contributes.*`; `aggregateContributions` merges across active plugins. Rules:

- Every contributed id is namespaced `<pluginId>/<localId>`. The manifest author writes the bare local `id`; the loader stores both `localId` and the namespaced `id`.
- Invalid individual items are dropped with a recorded error rather than failing the whole plugin (a typo in one theme must not hide good prompts).
- On a namespaced-id collision the first wins (defended even though ids are plugin-scoped). For runtime agents, built-in agents always win, so a plugin can never shadow a first-party agent.
- Contribution types: `themes`, `iconPacks`, `prompts`, `settings`, `commandMacros`, `cueTriggers` (tier 0); `commands`, `panels`, `agents`, `tools`, `keybindings` (tier 1). `cueTriggers` with `action: 'notify'` run on tier 0; `action: 'dispatch'` is risk-gated (the Pianola risk engine) and surfaced to the user, never auto-fired when high-risk. A `tools` contribution is invokable with a result via the brokered `plugins:invoke-tool` round-trip, and (when `plugins` is on) is exposed to a spawned agent's model over MCP via `maestro-cli mcp serve` (claude/codex auto-injected, others best-guess), each model call risk-gated. A `panels` contribution carries an optional `size?: 'default' | 'full'` (`modal` placement only, parsed leniently: absent -> `default` silently, invalid -> manifest error plus `default`, panel never dropped), where `full` renders edge-to-edge overlay chrome. A `keybindings` contribution's `command` must be a plugin-local id. Registering `agents`/`keybindings` does NOT by itself wire spawning / chord-binding - each is a separate step.
- `iconPacks` is a tier-0 contribution: the host validates SVG path data and hex colors, namespaces pack entries, and renders paths only through host-owned SVG markup in the group appearance picker.

- `hostViews` are data-only contributions available to tier-0 and tier-1 plugins: `{ id, surface: 'movement' | 'cadenza', title, description?, blocks? }`. `blocks` is an optional BlockView block array, serialized UTF-8 is capped at 1,000,000 bytes, and the host renderer - not plugin code - draws it. Tier-1 runtime update/remove RPCs require `ui:hostView`, resolve only an already-declared local id, retain its title/surface, and reject cadenza decision/options or agent-routing payloads.

- `uiItems` (tier 1) are declarative host-rendered controls gated by `ui:contribute`: `status-bar`, `menu`, `sidebar`, `activity-bar`, `toolbar`, `tabBar`, `sessionRowBadge`, `groupHeaderBadge`, `settingsSection`, `rightPanelTab`, `contextMenuItem`, and `emptyState`. Their `command` is plugin-local; content is only label/icon/tooltip data, never raw markup.

### Trusted chrome (never plugin-accessible)

`PROTECTED_UI_SURFACES` is an explicit denylist enforced while contributions are collected and again during aggregation; every `PluginUiItemsSlot` repeats the positive-allowlist check at the render boundary. Plugins must never target, nest into, replace, or visually occlude: (1) plugin management and enable/disable controls, (2) permission or consent dialogs, (3) uninstall or grant/revoke flows, or (4) security indicators, including SSH status, permission mode, and agent identity. Those semantic zones are deliberately absent from `PluginUiSurface`. `ui:render-unsafe` is subject to the same guard and does not unlock `ui:contribute` or `ui:panel`.

## IPC surface (`src/main/ipc/handlers/plugins.ts`)

Channels (all gated on `encoreFeatures.plugins`):

`plugins:list`, `plugins:set-enabled`, `plugins:install`, `plugins:update`, `plugins:uninstall`, `plugins:contributions`, `plugins:get-grants`, `plugins:set-grants`, `plugins:revoke-grants`, `plugins:invoke-command`, `plugins:invoke-tool`, `plugins:get-activity`. (Panel documents are NOT read over IPC - the render host serves them over the per-plugin `plugin-panel://` protocol; see below.)

- **Pure-reads invariant.** `plugins:list` and `plugins:contributions` MUST NOT call `refresh()`. `refresh()` reconciles sandboxes and fires `onChange` -> `plugins:changed` -> renderer re-fetch -> read again, an infinite IPC loop that freezes the app. Discovery happens at startup and on mutations only.
- **Consent (`plugins:set-grants`).** The user approves a SUBSET of the plugin's REQUESTED permissions. The handler intersects approved capabilities with the manifest's requests, so an over-broad grant can never be smuggled in via the renderer, and only known capabilities survive. `plugins:revoke-grants` calls `forgetGrants`.
- **Host-managed dispatch allow list (`plugins:set-agent-allowlist`, issue #1250).** `agents:dispatch` uses an allowlist scope naming the exact agent ids a plugin may target. The manifest declares the CAPABILITY; the USER owns the SCOPE. This channel is registered in `index.ts` (gated on the trusted main renderer + Encore flag, NOT this module, like `plugins:request-consent`) and re-mints the grant's scope through `AuthorizationStore.setAllowlistScope` - the same sealed-ledger path as consent/revoke, so the epoch bump, anti-rollback, tombstones, and session-only fallback are all preserved. It edits ONLY the scope of an ALREADY-CONSENTED capability: it never adds a capability, never touches the `unattended` flag, and never changes identity (the plugin's files are unchanged, so `verify()` still matches), so adding an agent needs no plugin re-pack/re-sign. The plugin can never reach it (a different principal), and submitted ids are intersected with live sessions and filtered through `isValidAllowlistMember`. Edited from Settings -> Plugins (the `AgentDispatchAllowlist` editor in a plugin's Permissions tab). A denied `agents.dispatch` (an out-of-date allow list) also raises a throttled operator toast, so it no longer fails invisibly.

- **Host-enforced session grants (`scope: "granted-sessions"`, host API 1.26.0, `plugin-session-grants.ts`).** The manifest parser requires `agents:dispatch` to name exact agent ids and `transcripts:read` to name a project path - neither of which a plugin author can know. The `granted-sessions` keyword (`GRANTED_SESSIONS_SCOPE` in `permissions.ts`, accepted for exactly those two capabilities and rejected with a specific message everywhere else) hands the member set to the HOST instead: the plugin may dispatch to, and read the History of, only sessions it created through `sessions.create` (source `created`) or that the user approved through `sessions.requestAccess` (source `user-approved`). It is an EXPLICIT scope, never an unscoped grant: a freshly consented keyword grant has no members and covers nothing, because `parseAllowlistScope` drops the keyword and `isPermitted` refuses to match it as a path. The consent window renders it as "only agents this plugin creates, or that you approve when asked" rather than the raw keyword. The keyword on `transcripts:read` REQUIRES it on `agents:dispatch` too (a cross-entry rule at the end of `parsePermissions`): the set is stored as the dispatch allowlist scope, so a lone `transcripts:read` keyword either covered nothing or, with an ordinary dispatch allowlist, silently promoted the user's own Settings-managed dispatch targets into the transcript-read set that `sessions.create` then appended to.

  There is no new storage: the set IS the `agents:dispatch` grant's allowlist scope, written through the same `setAllowlistScope` path the Settings editor uses, so it is sealed, epoch-bumped, persisted across restarts, broker-checked on every dispatch, removable in Settings (a removed session is denied on the very NEXT dispatch and History read, because grants are re-read per call), and dropped when the capability is revoked. Two predicates, and merging them reopens one hole or the other. `usesSessionGrants` gates ENFORCEMENT (does the handler check the set?) and is deliberately BROAD: the manifest's `agents:dispatch` keyword, or ANY session-grant-capable ledger grant carrying the keyword. It has to mirror the broker exactly, because the broker relaxes a path-scoped verb's scope match on THAT verb's own ledger keyword (`hasSessionGrantScope` is per-capability) and leaves the set check to the handler - so any state where the broker relaxes and this answers false is a hole where neither layer checks. Two such states exist: a manifest refresh mid-drain, and every moment after the first grant, since `grantSession` rewrites only the `agents:dispatch` scope and the `transcripts:read` keyword therefore survives forever. `holdsGrantSetKeyword` gates MUTATION (may the host ADD a member?) and is STRICT: the keyword must be on `agents:dispatch`, because that grant's allowlist scope is the storage, and widening it would let `grantSession` append to an ordinary user-managed dispatch allow list. Both prefer the manifest (granting rewrites the ledger scope to real ids) with the ledger as a fail-closed fallback. Only an existing session id is ever granted, never an agent name, and every grant and revoke is audited with its source.

  **Tab targeting (`opts.tabId`).** `agents.dispatch` takes an optional closed `opts` whose ONLY member is `tabId`, mirroring how `process.spawn` closes its own. The handler resolves it through the existing `tabsList` dependency AFTER every authorization gate (so the error can never be an existence oracle for tabs of a session the plugin cannot dispatch to) and requires a VISIBLE AI tab of the session named by `agentId` - `projectSessionTabMetadata` already drops hidden consult tabs, and an unknown id, a tab of another session, a terminal/file tab, or an unexpected opts key throws with nothing sent. Because the handler can only prove tab ownership against an exact session id, `tabId` is incompatible with addressing by agent NAME (the sink resolves a name later). It NARROWS and never widens: the broker's scope target stays `agentId` (see `scopeTargetFor`), and a session-grant plugin still needs that session granted. The sink threads it into `dispatchPromptToSession`, which passes it as the `remote:executeCommand` argument after `inputMode`; omitted, the renderer uses the session's own active tab exactly as before.

  Enforcement is a broker/handler PAIR, not one check. For the path-scoped `transcripts:read` the broker (`hasSessionGrantScope`) confirms only that the capability is held - the `HANDLER_REAUTHORIZED_METHODS` posture, since the set is invisible to the pure matcher - and the handler then requires `isSessionGranted(pluginId, sessionId)` in place of the project-path match, keeping every other check (egress conflict, ActionGuard, audit, field projection). For the allowlist-scoped `agents:dispatch` nothing is relaxed: exact set membership already enforces the grant, and the handler additionally requires `agentId` to be a granted session id so the sink's agent-NAME resolution is off for these plugins. `sessions.requestAccess` is mapped to `agents:dispatch` and listed in `HANDLER_REAUTHORIZED_METHODS` (the requested session is by definition not yet in the allowlist); its handler rejects a plugin that does not use session grants, answers an already-granted session with no dialog, allows at most one confirmation per plugin at a time, and remembers a declined session for the life of that sandbox. The confirmation itself is a native main-process message box parented to the main window, defaulting to Don't Allow - injected as `confirmSessionAccess` so it is registered only when wired (fail closed) and no test opens a window.

- **Dispatch scope on renewed consent.** When updated code requires renewed consent, `ConsentMinter` shows and re-mints the existing exact-agent selection only while the sealed ledger still holds a Dispatch grant and both identities have the same trusted signer. An empty selection stays deny-all. Dispatch must be approved again in the separate high-risk section, and Unattended must be approved again with its own checkbox. Revocation, uninstall, signer changes, and removed manifest capabilities never inherit old access. If the saved selection changes while the prompt is open, confirmation is rejected so the user can review the new offer.

## Renderer panel render host + consent

`PluginPanelFrame.tsx` is the ONE place a panel renders - an Electron `<webview>` guest, isolated per plugin (FC6 / WS-render-host):

- **Per-plugin session.** Partition `plugin:<pluginId>` (in-memory, never `persist:`), so a panel can never see the app's storage nor another plugin's, and everything dies on relaunch. Document URL `plugin-panel://panel/<encoded panelId>` - served by a per-session protocol handler in `plugin-panel-host.ts` (main), which re-checks the Encore flag + grant-gated contributions (`getPanelHtml`) on EVERY load and serves with a restrictive CSP **header + meta** (`connect-src 'none'`, `child-src/frame-src 'none'`, `form-action 'none'`, `base-uri 'none'`; inline script/style allowed, `img/font` `data:` only). Naming contract: `src/shared/plugins/panel-host.ts`.
- **Main-process enforcement.** `will-attach-webview` (window-manager) verifies partition and document name the SAME plugin, then forces web prefs: no Node, `contextIsolation`, OS `sandbox`, and the broker-only preload `plugin-panel-preload.js` (the ONLY preload; anything renderer-supplied is stripped). The session cancels ALL non-panel-document requests at the `webRequest` layer (egress denial beneath CSP) and denies every permission. `did-attach-webview` branches on `isPluginPanelSession`: panel guests get `window.open` denied and ALL navigations/redirects prevented - and NONE of the browser-tab conveniences (shortcut forwarding, JS injection, privileged paste) ever run inside plugin content. The old self-navigation exfil residual is CLOSED in the main process (the `will-frame-navigate` backstop in window-manager stays for the remaining srcdoc subframes, e.g. file preview).
- **Bridge (contract unchanged).** Panel HTML still calls `parent.postMessage({ type: 'maestro:invokeCommand', commandId, args }, '*')`. In a top-level guest `parent === window`; the guest preload (source-gated to the panel's own window) forwards that one shape via `ipcRenderer.sendToHost` -> `ipc-message` on the `<webview>` -> `PluginPanelFrame` namespaces it to `<pluginId>/<commandId>` and forwards over the broker-gated `plugins:invoke-command` RPC. One-way; no reply channel. A non-suppressible "from <plugin>" provenance line sits above every panel.
- **Theme (host API 1.25.0).** `PluginPanelFrame` sends a data-only snapshot of the active palette on guest `dom-ready` and on later theme changes over `maestro:panelTheme`. The isolated preload accepts only the fixed `--maestro-*` color list from `src/shared/plugins/panel-theme.ts`, checks each color, then writes root inline CSS properties, root background, and `color-scheme`. Plugin `:root` stylesheet declarations cannot override those inline values. No theme setting or plugin KV entry crosses the boundary; no new capability is granted. Older panels can use CSS fallbacks and gain these tokens automatically on newer hosts.

## Signing / trust

`signing.ts` + `plugin-signature.ts`. An optional `signature.json` (ed25519) covers a deterministic payload built from the SHA-256 of every other file in the plugin dir, so any tampering invalidates it. Statuses:

- `unsigned` - no signature.
- `invalid` - tampered or malformed signature. NEVER runnable.
- `untrusted` - valid signature, signing key not in the trusted set (integral but unknown publisher).
- `trusted` - valid signature, key in the trusted set.

Integrity ("files match what was signed") and trust ("key is recognized") are layered; a plugin can be integral-but-untrusted and still run once the user has enabled = consented.

### Bundled-plugin signing (release vs. dev)

Bundled plugins ship trusted via a build-time signature, not a committed one. The private key is a CI secret (`MAESTRO_PLUGIN_SIGNING_KEY`); release CI writes it to a temp file, runs `maestro-cli plugin sign` over every dir in `examples/plugins/*/`, and packages the resulting `signature.json` into `<resources>/plugins/` via `extraResources`. The matching base64 SPKI public key is baked into `MAESTRO_PUBLISHER_KEYS` in `src/shared/plugins/publisher-keys.ts`, so those signatures resolve `trusted` and `seedBundledPlugins()` keeps the seeded copy. A drift guard in `.github/workflows/release.yml` re-validates the signed plugin against the baked anchor and fails the release if the CI secret and `publisher-keys.ts` ever diverge. The `signature.json` is a release artifact only - it is gitignored (`examples/plugins/*/signature.json`) and must never be committed.

**Testing a bundled code plugin locally.** Dev builds have no CI secret and fall back to the unsigned repo `examples/plugins`, so `seedBundledPlugins()` finds the plugin `unsigned` and `continue`s before copying it into `pluginsDir()`. The plugin is never installed, so there is no panel and no `main.js` to run. (The distinct "panel renders but `main.js` never runs" symptom belongs to a plugin manually installed unsigned into `pluginsDir()` and then enabled - a different path from bundled seeding.) To exercise the real (signed, trusted) path in a dev build:

1. Put the test plugin under `examples/plugins/my-plugin` with manifest `id: "my-plugin"`: the dev seeder only discovers `examples/plugins`, and the folder name must equal the declared id. Generate a throwaway keypair and sign it: `maestro-cli plugin sign examples/plugins/my-plugin --gen-key --key-out ~/maestro-dev-publisher.pem`. This writes `signature.json` (gitignored) and prints the base64 SPKI public key.
2. Add that public key to `pluginTrustedKeys` in the dev profile's Settings. `resolveTrustedKeys()` merges your key with the baked anchor, so the local signature resolves `trusted`. On the next dev startup, the seeder copies the trusted plugin into that profile's plugins directory.
3. Enable the plugin and grant consent; the plugin can now run and receive its granted events.

**Trust model (v1): single key, no revocation.** `MAESTRO_PUBLISHER_KEYS` is an allow-list of accepted keys with no CRL. Rotation is additive-then-prune: add the new public key alongside the old, resign, ship a release, then drop the old entry in a later release once no shipped build still relies on it. A leaked private key can only be revoked by shipping a new release that rotates the anchor - there is no runtime revocation.

## Host-API semver contract

`HOST_API_VERSION` is a permanent public contract once plugins ship. PATCH = host bug fix; MINOR = additive (new contribution point / manifest field / capability, older plugins keep working); MAJOR = remove or change the meaning of an existing one. A plugin pins `maestro.minHostApi`; the host loads it only when same-major and `host >= min`.

The current host is `1.26.0`; it expands a leading `~` in plugin filesystem
paths and admits the home-relative manifest path scope `~/.maestro/<name>`
(every other `~` form is rejected at parse time; absolute scopes are unchanged).
`1.26.0` also adds host-enforced per-session grants (`scope: "granted-sessions"`)
and widens the session fields a plugin may set - `additionalDirectories`
(granted project roots only, read-only), `customModel`, `customEffort`, a `~` in
a create `cwd`, and `supportsAdditionalDirectories` on every `agents.list` entry,
all on the existing `sessions:create` / `sessions:write` / `agents:read`
capabilities. See "Plugin-set session fields" above.
`1.25.0` added resumable `agents.send`, invocation-scoped
public progress, verified plugin-tool caller context, and isolated `agents.generateTitle`.
All sends and title generation require exact-agent Dispatch, unattended consent,
trusted signatures, risk and action guards. See [the Relay contract](docs/relay-host-contract.md).
`1.24.0` added host-mediated plugin services.
`1.23.0` added independent plugin settings cards.
`1.17.0` added `media:tools` with the exact
`discord-voice` scope, opaque media jobs and fixed native profiles. STT remains
in the plugin; tools and models are not bundled. (`1.15.0` is taken by the
Board + Profiles work on this fork, so it is skipped here.)
Earlier: `1.16.0` added the metadata-only `session.activated` event topic, the
`sessions.focus` method plus its narrow `sessions:focus` capability, and the
`ui.openPanel` / `ui.closePanel` / `ui.togglePanel` methods plus the optional
panel manifest field `size?: 'default' | 'full'`. `1.14.0` added the `tool.executed` event topic and the
`ui.panelPost` host-to-panel push method; `1.13.0` added the
host-mediated `PluginUiSurface` registry and trusted-chrome guard; `1.12.0`
added the `net:connect` capability and the `net.connect` / `net.send` /
`net.close` methods; `1.11.0` added `groupings` + `ui:grouping`; `1.10.0` added
`iconPacks`; `1.9.0` added `hostViews`, `ui:hostView`, and the
`ui.hostViewUpdate` / `ui.hostViewRemove` methods. Plugins declare the
`maestro.minHostApi` matching the lowest version whose surface they use.

## Key invariants and gotchas (read before editing)

1. **Encore gate everywhere.** Any new `plugins:*` channel must throw `'PluginsDisabled'` outside `withIpcErrorLogging` when the flag is off, and any manager method that exposes plugin data must return empty when disabled.
2. **Reads stay pure.** Never call `refresh()` from a read path - it reconciles sandboxes and loops via `plugins:changed`.
3. **Default deny.** Add a host method only by adding it to the `HOST_API` table with its capability; the broker derives authorization from that table. A method missing from the table is unreachable.
4. **fs is re-authorized after symlink resolution.** Never trust the raw path string; resolve the real path and re-`authorize`. The userData/config tree is excluded even under a broad grant.
5. **Net scope alone is not enough.** Hostname scope plus the egress guard (resolved-IP block list + connection pinning + `redirect: 'error'`) together defend `net:fetch`. Do not loosen any one of them in isolation.
6. **Events and sessions are metadata only.** Payloads NEVER contain transcript/prompt text or file contents. Redaction is not a boundary for free-form text. Content is reachable ONLY through the separate, consented, project-scoped, ActionGuard-bounded, audited `transcripts:read` capability - never the event bus.
7. **Built-in wins.** Plugin agents/contributions can never shadow first-party ids.
8. **Host views remain data-only.** A plugin may contribute or update only BlockView data for its own declared host view; it cannot supply HTML, renderer code, cadenza decision actions, or agent-routing data. Enforce `MAX_HOST_VIEW_BLOCKS_BYTES` in both declaration parsing and runtime updates.
9. **Uninstall purges everything** (dir, toggle, grants, KV, `plugins.<id>.*` settings, event subs). Add any new per-plugin state to `purgePluginData`.
10. **Live but fully gated.** `agents:dispatch`, `process:spawn`, and `net:connect` are wired and reachable, each behind the full gate stack (allowlist/host-scope grant + trusted signature + Pianola risk ceiling + ActionGuard + closed schema; `net:connect` adds wss-only + egress-pinning + socket/frame caps). The direct `agents.dispatch` handler additionally requires separate unattended consent. These conditions are pinned by the AST wiring guard (`plugin-host-deps-wiring.test.ts`): removing a gate, wiring a partial `net.connect` surface, or dropping `dispatchUnattendedAllowed` fails the build and forces a security review. Do not loosen any of them in isolation.
11. **Trusted chrome is permanent.** `PROTECTED_UI_SURFACES` applies to declarative items and every high-trust render tier in collection, aggregation, and at the render boundary. Never create a mount in plugin management/enable-disable, consent, uninstall/grant-revoke, or SSH/permission-mode/agent-identity chrome.

## Honest tier-1 trust model

The `vm` sandbox is realm-escapable. The intrinsics Maestro injects (the SDK, `console`, `setTimeout`) are host-realm functions, so `someInjected.constructor("return process")()` reaches the real `process`, and `codeGeneration.strings: false` only disables code-gen for the context's own `Function`, not the host's. The `vm` is DEFENSE-IN-DEPTH, never the boundary. The real controls are: the separate `utilityProcess` (process + crash isolation), the default-deny broker (which still gates ambient fs/net/exec authority), and signature/consent gating on which code runs at all. Closing the escape fully (an OS-level sandbox dropping ambient authority) is the documented Phase-3 decision. Until then, **enabling a tier-1 code plugin is a full-trust decision - only install plugins you trust.**

## Authoring surface (SDK + CLI)

External authors do not read this repo; two artifacts hand them the contract:

- **`@maestro/plugin-sdk`** (`packages/plugin-sdk/`) - a standalone, dependency-free package that VENDORS the frozen contracts (types, the small runtime values, and the `MaestroSdk` shape) so a plugin project type-checks against the same surface. A drift-guard test keeps the vendored copies in parity with `src/shared/plugins/`; bump the package version in lockstep with `HOST_API_VERSION`.
- **`maestro plugin` CLI** (`src/cli/commands/plugin.ts`) - `init` (scaffold), `validate` (manifest + signature status), `sign` (ed25519, payload byte-identical to `plugin-signature.ts`), `pack` (distributable tgz). See the authoring guide for the workflow.

## See also

- `src/shared/plugins/` - pure contracts (`plugin-manifest.ts`, `permissions.ts`, `contributions.ts`, `events.ts`, `host-api.ts`, `rpc-protocol.ts`, `signing.ts`).
- `src/main/plugins/` - runtime (`plugin-manager.ts`, `plugin-sandbox-host.ts`, `plugin-sandbox-entry.ts`, `plugin-host-handlers.ts`, `permission-broker.ts`, `net-egress-guard.ts`).
- `src/main/ipc/handlers/plugins.ts` - IPC channels and the pure-reads invariant.
- `src/renderer/components/plugins/PluginPanelFrame.tsx` + `src/main/plugins/plugin-panel-host.ts` - the panel render host (isolated webview) + the postMessage bridge.
- [docs/agent-guides/PLUGIN-DEVELOPMENT.md](docs/agent-guides/PLUGIN-DEVELOPMENT.md) - the practical authoring guide.
- `packages/plugin-sdk/` - the `@maestro/plugin-sdk` typed authoring package (vendored contracts + drift guard).
- `src/cli/commands/plugin.ts` - the `maestro plugin` init/validate/sign/pack CLI.

## Virtual session groupings (HOST_API 1.9.0)

`contributes.groupings` adds a presentation-only sidebar mode. A tier-0 grouping
declares `{ id, label, description?, rules? }`; rules are first-match-wins and
may match `toolType`, `cwdGlob`, and `namePattern`, assigning display `group`
and optional `parentGroup` labels. Unmatched sessions appear in **Other**.
Patterns use only the bounded `*` wildcard grammar (all other characters are
literal); no plugin-supplied regular expression is compiled. Groupings never
write `session.groupId` or create, rename, or delete persisted groups.

Tier-1 code may publish a validated metadata-only snapshot through
`ui:grouping`: `maestro.ui.grouping.publish({ id, groups, assignments })` and
`maestro.ui.grouping.clear(id)`. The id must be this plugin's declared local
grouping id; group ids are local, depth is at most two, unknown session ids are
dropped, and snapshots are process-local and purged when the sandbox stops,
the plugin is disabled/uninstalled, or the feature flag is off. `ui:grouping`
is low-risk and unscoped because its only output is virtual presentation.

## Bounded media tools

Host API 1.17.0 adds `media:tools` (exact `discord-voice` scope), opaque media jobs
and fixed native profiles. STT remains in the plugin; no tools/models are bundled.
See [PLUGIN-MEDIA-TOOLS.md](docs/agent-guides/PLUGIN-MEDIA-TOOLS.md) for the contract and runtime prerequisites.

## Plugin settings cards (1.23.0)

Settings-placement panels are independent searchable Settings destinations, not
Display-tab docks. See [the authoring contract](docs/plugin-settings-cards.md).
The manager admits them only for active trusted records with live `ui:panel`
grants. `hostSettings: ["media"]` draws a host-owned link to Host media tools;
it grants no host setting access. Own `ui.openPanel` can navigate to a settings
card; close/toggle remain modal-only. Identity is the existing namespaced panel ID.

## Host-mediated services (1.24.0)

`provides` / pinned `requires` declarations, exact consent scopes and the closed
transcription contract are documented in [plugin-services.md](docs/plugin-services.md).
`PluginServiceHost` routes through the existing sandbox result bridge; only
`PluginMediaTools.delegate` mints call-bound aliases. Owner jobs become exclusive,
keep their original deadline/limits and close before result delivery.
Registration and mandatory consumer startup are reconciled through main; optional
dependencies never gate text plugins. Revocation removes registrations and
in-flight work; cancellation remains usable after revoke. No direct peer IPC.
