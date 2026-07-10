# CLAUDE-PLUGINS.md

Architectural reference for **Maestro Plugins** - the third-party extension system whose pure contracts live in `src/shared/plugins/` and whose main-process runtime lives in `src/main/plugins/`. For the practical authoring guide (how to write a plugin, full manifest reference, worked examples), see [docs/agent-guides/PLUGIN-DEVELOPMENT.md](docs/agent-guides/PLUGIN-DEVELOPMENT.md). This doc is the **why** and the **gotchas** - read it before changing anything in `src/main/plugins/` or `src/shared/plugins/`.

## 30-second mental model

A plugin is one folder under `<userData>/plugins/` containing a `plugin.json` manifest. Plugins come in three trust tiers: tier 0 is data-only (declarative contributions, no code), tier 1 runs sandboxed code, tier 2 adds sandboxed UI. The whole feature is behind the `plugins` Encore flag (off by default). At startup the `PluginManager` discovers folders, validates each manifest, checks host-API compatibility and signature, and applies a persisted enable toggle. Tier 0 contributions (themes, prompts, settings, command macros, cue triggers) feed host registries directly. A tier-1 plugin stays disabled until the user enables it and consents to its capabilities; on enable, the `PluginSandboxHost` forks one Electron `utilityProcess` per plugin and runs the plugin's `entry` code in a `vm` context. Every host call the plugin makes is an RPC that the `PermissionBroker` authorizes (default deny) before a host handler executes it. UI panels render in a locked-down sandboxed iframe whose only channel out is a single narrow `postMessage` bridge.

## Status / gating

- Entire system is gated on `encoreFeatures.plugins === true` (off by default), re-read per call.
- Every `plugins:*` IPC channel throws the sentinel `'PluginsDisabled'` when the flag is off, so the renderer can distinguish "feature off" from "no plugins installed". The gate runs OUTSIDE `withIpcErrorLogging` so the sentinel is not logged as a real failure.
- `PluginManager.getActiveRecords()`, `getContributions()`, and `getAgentRegistry()` all return empty when the flag is off, regardless of what is on disk.
- `HOST_API_VERSION = '1.9.0'` (`src/shared/plugins/host-api.ts`) is the single source of truth for the host surface version.

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
  - `fs.read` / `fs.write`: resolve the symlink-real path, then RE-authorize it against the broker (`authorizeRealPath`) so a symlink inside a granted scope cannot escape, and the userData/config tree (`protectedPaths`) is denied even under a broad grant. Caps: `MAX_READ_BYTES = 10_000_000`; writes run under the `ActionGuard`.
  - `net.fetch`: `EgressGuard.assertUrlAllowed` blocks loopback / link-local / RFC1918 / cloud-metadata (169.254.169.254) / the app's own loopback port BEFORE any socket opens; fails closed if the connection-pinning dispatcher is unavailable; forces `redirect: 'error'` so a 3xx cannot be followed to a non-granted host; caps the body at `MAX_FETCH_BYTES = 5_000_000`. Returns `{ status, statusText, headers, body }`.
  - `settings.get`: denies secret-looking keys (`SECRET_KEY_PATTERN`), the `encoreFeatures` gate, and any `plugins.<other>.*` namespace that is not the caller's own.
  - `settings.set`: only `plugins.<id>.*` keys; same secret/proto/gate guards; value must be JSON-storable and `<= MAX_SETTINGS_VALUE_BYTES = 64 * 1024`.
  - `sessions.list` / `sessions.get`: projected through `toSessionMetadata` - metadata only, never transcript/prompt text.
  - `transcripts.read`: PROJECTED session content - the caller declares which fields it needs and only allowlisted fields are returned (projection, not redaction). Resolves the session's REAL `projectPath` and RE-authorizes against it (the caller-claimed path is only a broker hint), refuses an untrusted plugin that also holds `net:fetch`/`process:spawn` (the exfiltration combination), runs under the `ActionGuard` (high-risk rate/concurrency cap), and writes a per-read audit line. The metadata-only event bus is untouched.
  - `storage.*`: per-plugin KV via `kvStore` (values are strings).
  - `events.subscribe` / `unsubscribe`: filtered to the fixed `PLUGIN_EVENT_TOPICS` catalog.
  - `agents.dispatch` and `process.spawn`: INERT. They only exist as handlers when `deps.dispatch` / `deps.spawn` are injected, which is intentionally left unwired in Phase 1-2. The SDK methods exist but reject.

## Capabilities

`PLUGIN_CAPABILITIES` (`permissions.ts`), with risk and scope kind:

| Capability            | Risk   | Scope | Notes                                                                                                                                           |
| --------------------- | ------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs:read`             | medium | path  | re-authorized against symlink-real path                                                                                                         |
| `fs:write`            | high   | path  | re-authorized; runs under ActionGuard                                                                                                           |
| `net:fetch`           | medium | host  | egress-guarded (SSRF/rebind)                                                                                                                    |
| `agents:read`         | low    | none  | list/read agent metadata                                                                                                                        |
| `agents:dispatch`     | high   | none  | INERT (no production handler)                                                                                                                   |
| `notifications:toast` | low    | none  | raise a toast                                                                                                                                   |
| `settings:read`       | low    | none  | non-secret app settings; not the feature gate, not a peer plugin's namespace                                                                    |
| `settings:write`      | low    | none  | ONLY `plugins.<id>.*` keys                                                                                                                      |
| `sessions:read`       | medium | none  | METADATA only, never transcript text                                                                                                            |
| `transcripts:read`    | high   | path  | PROJECTED session content; project-scoped, re-authorized on the resolved path; refused with egress unless trusted; ActionGuard-bounded; audited |
| `storage:read`        | low    | none  | own KV                                                                                                                                          |
| `storage:write`       | low    | none  | own KV                                                                                                                                          |
| `ui:command`          | low    | none  | invoke a registered palette command                                                                                                             |
| `events:subscribe`    | medium | none  | metadata-only topics                                                                                                                            |
| `process:spawn`       | high   | none  | INERT (no production handler)                                                                                                                   |
| `ui:contribute`       | medium | none  | gates accepting declarative `uiItems` into host surfaces (menus, sidebar, status bar)                                                           |
| `ui:panel`            | medium | none  | gates accepting the plugin's sandboxed `panels`                                                                                                 |
| `ui:hostView`         | medium | none  | drives brokered updates/removals of the plugin's declared native BlockView data; no plugin renderer runs                                        |
| `ui:render-unsafe`    | high   | none  | escape hatch: full custom UI with interface access (high-trust)                                                                                 |

`PermissionRequest = { capability, scope?, reason? }`. Scopes narrow `fs:*` (a directory), `net:fetch` (a host), and `transcripts:read` (a project path); an absent scope means the broad form (the consent UI must present it as such). The user grants a subset at the consent dialog (`plugins:set-grants`).

## Contributions + registry merge

`collectContributions` validates one plugin's `contributes.*`; `aggregateContributions` merges across active plugins. Rules:

- Every contributed id is namespaced `<pluginId>/<localId>`. The manifest author writes the bare local `id`; the loader stores both `localId` and the namespaced `id`.
- Invalid individual items are dropped with a recorded error rather than failing the whole plugin (a typo in one theme must not hide good prompts).
- On a namespaced-id collision the first wins (defended even though ids are plugin-scoped). For runtime agents, built-in agents always win, so a plugin can never shadow a first-party agent.
- Contribution types: `themes`, `iconPacks`, `prompts`, `settings`, `commandMacros`, `cueTriggers` (tier 0); `commands`, `panels`, `agents`, `tools`, `keybindings` (tier 1). `cueTriggers` with `action: 'notify'` run on tier 0; `action: 'dispatch'` is risk-gated (the Pianola risk engine) and surfaced to the user, never auto-fired when high-risk. A `tools` contribution is invokable with a result via the brokered `plugins:invoke-tool` round-trip, and (when `plugins` is on) is exposed to a spawned agent's model over MCP via `maestro-cli mcp serve` (claude/codex auto-injected, others best-guess), each model call risk-gated. A `keybindings` contribution's `command` must be a plugin-local id. Registering `agents`/`keybindings` does NOT by itself wire spawning / chord-binding - each is a separate step.
- `iconPacks` is a tier-0 contribution: the host validates SVG path data and hex colors, namespaces pack entries, and renders paths only through host-owned SVG markup in the group appearance picker.

- `hostViews` are data-only contributions available to tier-0 and tier-1 plugins: `{ id, surface: 'movement' | 'cadenza', title, description?, blocks? }`. `blocks` is an optional BlockView block array, serialized UTF-8 is capped at 1,000,000 bytes, and the host renderer—not plugin code—draws it. Tier-1 runtime update/remove RPCs require `ui:hostView`, resolve only an already-declared local id, retain its title/surface, and reject cadenza decision/options or agent-routing payloads.

## IPC surface (`src/main/ipc/handlers/plugins.ts`)

Channels (all gated on `encoreFeatures.plugins`):

`plugins:list`, `plugins:set-enabled`, `plugins:install`, `plugins:update`, `plugins:uninstall`, `plugins:contributions`, `plugins:get-grants`, `plugins:set-grants`, `plugins:revoke-grants`, `plugins:invoke-command`, `plugins:invoke-tool`, `plugins:get-activity`. (Panel documents are NOT read over IPC — the render host serves them over the per-plugin `plugin-panel://` protocol; see below.)

- **Pure-reads invariant.** `plugins:list` and `plugins:contributions` MUST NOT call `refresh()`. `refresh()` reconciles sandboxes and fires `onChange` -> `plugins:changed` -> renderer re-fetch -> read again, an infinite IPC loop that freezes the app. Discovery happens at startup and on mutations only.
- **Consent (`plugins:set-grants`).** The user approves a SUBSET of the plugin's REQUESTED permissions. The handler intersects approved capabilities with the manifest's requests, so an over-broad grant can never be smuggled in via the renderer, and only known capabilities survive. `plugins:revoke-grants` calls `forgetGrants`.

## Renderer panel render host + consent

`PluginPanelFrame.tsx` is the ONE place a panel renders — an Electron `<webview>` guest, isolated per plugin (FC6 / WS-render-host):

- **Per-plugin session.** Partition `plugin:<pluginId>` (in-memory, never `persist:`), so a panel can never see the app's storage nor another plugin's, and everything dies on relaunch. Document URL `plugin-panel://panel/<encoded panelId>` — served by a per-session protocol handler in `plugin-panel-host.ts` (main), which re-checks the Encore flag + grant-gated contributions (`getPanelHtml`) on EVERY load and serves with a restrictive CSP **header + meta** (`connect-src 'none'`, `child-src/frame-src 'none'`, `form-action 'none'`, `base-uri 'none'`; inline script/style allowed, `img/font` `data:` only). Naming contract: `src/shared/plugins/panel-host.ts`.
- **Main-process enforcement.** `will-attach-webview` (window-manager) verifies partition and document name the SAME plugin, then forces web prefs: no Node, `contextIsolation`, OS `sandbox`, and the broker-only preload `plugin-panel-preload.js` (the ONLY preload; anything renderer-supplied is stripped). The session cancels ALL non-panel-document requests at the `webRequest` layer (egress denial beneath CSP) and denies every permission. `did-attach-webview` branches on `isPluginPanelSession`: panel guests get `window.open` denied and ALL navigations/redirects prevented — and NONE of the browser-tab conveniences (shortcut forwarding, JS injection, privileged paste) ever run inside plugin content. The old self-navigation exfil residual is CLOSED in the main process (the `will-frame-navigate` backstop in window-manager stays for the remaining srcdoc subframes, e.g. file preview).
- **Bridge (contract unchanged).** Panel HTML still calls `parent.postMessage({ type: 'maestro:invokeCommand', commandId, args }, '*')`. In a top-level guest `parent === window`; the guest preload (source-gated to the panel's own window) forwards that one shape via `ipcRenderer.sendToHost` -> `ipc-message` on the `<webview>` -> `PluginPanelFrame` namespaces it to `<pluginId>/<commandId>` and forwards over the broker-gated `plugins:invoke-command` RPC. One-way; no reply channel. A non-suppressible "from <plugin>" provenance line sits above every panel.

## Signing / trust

`signing.ts` + `plugin-signature.ts`. An optional `signature.json` (ed25519) covers a deterministic payload built from the SHA-256 of every other file in the plugin dir, so any tampering invalidates it. Statuses:

- `unsigned` - no signature.
- `invalid` - tampered or malformed signature. NEVER runnable.
- `untrusted` - valid signature, signing key not in the trusted set (integral but unknown publisher).
- `trusted` - valid signature, key in the trusted set.

Integrity ("files match what was signed") and trust ("key is recognized") are layered; a plugin can be integral-but-untrusted and still run once the user has enabled = consented.

## Host-API semver contract

`HOST_API_VERSION` is a permanent public contract once plugins ship. PATCH = host bug fix; MINOR = additive (new contribution point / manifest field / capability, older plugins keep working); MAJOR = remove or change the meaning of an existing one. A plugin pins `maestro.minHostApi`; the host loads it only when same-major and `host >= min`.

The current host is `1.9.0`; it added `hostViews`, `ui:hostView`, and the
`ui.hostViewUpdate` / `ui.hostViewRemove` methods. Plugins using these declare
`maestro.minHostApi: "1.9.0"`.

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
10. **Inert by design.** `agents:dispatch` and `process:spawn` have no production handler; do not wire them without the documented security review.

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
