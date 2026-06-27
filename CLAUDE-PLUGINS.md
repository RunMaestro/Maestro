# CLAUDE-PLUGINS.md

Architectural reference for **Maestro Plugins** - the third-party extension system whose pure contracts live in `src/shared/plugins/` and whose main-process runtime lives in `src/main/plugins/`. For the practical authoring guide (how to write a plugin, full manifest reference, worked examples), see [docs/agent-guides/PLUGIN-DEVELOPMENT.md](docs/agent-guides/PLUGIN-DEVELOPMENT.md). This doc is the **why** and the **gotchas** - read it before changing anything in `src/main/plugins/` or `src/shared/plugins/`.

## 30-second mental model

A plugin is one folder under `<userData>/plugins/` containing a `plugin.json` manifest. Plugins come in three trust tiers: tier 0 is data-only (declarative contributions, no code), tier 1 runs sandboxed code, tier 2 adds sandboxed UI. The whole feature is behind the `plugins` Encore flag (off by default). At startup the `PluginManager` discovers folders, validates each manifest, checks host-API compatibility and signature, and applies a persisted enable toggle. Tier 0 contributions (themes, prompts, settings, command macros, cue triggers) feed host registries directly. A tier-1 plugin stays disabled until the user enables it and consents to its capabilities; on enable, the `PluginSandboxHost` forks one Electron `utilityProcess` per plugin and runs the plugin's `entry` code in a `vm` context. Every host call the plugin makes is an RPC that the `PermissionBroker` authorizes (default deny) before a host handler executes it. UI panels render in a locked-down sandboxed iframe whose only channel out is a single narrow `postMessage` bridge.

## Status / gating

- Entire system is gated on `encoreFeatures.plugins === true` (off by default), re-read per call.
- Every `plugins:*` IPC channel throws the sentinel `'PluginsDisabled'` when the flag is off, so the renderer can distinguish "feature off" from "no plugins installed". The gate runs OUTSIDE `withIpcErrorLogging` so the sentinel is not logged as a real failure.
- `PluginManager.getActiveRecords()`, `getContributions()`, and `getAgentRegistry()` all return empty when the flag is off, regardless of what is on disk.
- `HOST_API_VERSION = '1.1.0'` (`src/shared/plugins/host-api.ts`) is the single source of truth for the host surface version.

## File map

Pure, bundle-safe contracts (no Electron, no fs) in `src/shared/plugins/`:

| File                                                                                                   | Owns                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-manifest.ts`                                                                                   | `PluginManifest`, `PluginTier`, `PLUGIN_ID_PATTERN`, `validatePluginManifest`, entry-traversal guard                                        |
| `permissions.ts`                                                                                       | `PluginCapability`, `PLUGIN_CAPABILITIES`, risk/scope maps, `PermissionRequest`/`PermissionGrant`, `isPermitted` (the default-deny matcher) |
| `contributions.ts`                                                                                     | every contribution interface, `collectContributions`, `aggregateContributions` (built-in-wins merge)                                        |
| `events.ts`                                                                                            | `PLUGIN_EVENT_TOPICS`, `PluginEventPayloads` (metadata only)                                                                                |
| `host-api.ts`                                                                                          | `HOST_API_VERSION`, `isHostApiCompatible` (semver gate)                                                                                     |
| `rpc-protocol.ts`                                                                                      | `HOST_API` method->capability table, `HostRequest`/`HostResponse`/`HostControlMessage`, `extractTarget`                                     |
| `signing.ts`                                                                                           | `SIGNATURE_FILENAME`, `SignatureStatus`, canonical signing payload                                                                          |
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
  - `storage.*`: per-plugin KV via `kvStore` (values are strings).
  - `events.subscribe` / `unsubscribe`: filtered to the fixed `PLUGIN_EVENT_TOPICS` catalog.
  - `agents.dispatch` and `process.spawn`: INERT. They only exist as handlers when `deps.dispatch` / `deps.spawn` are injected, which is intentionally left unwired in Phase 1-2. The SDK methods exist but reject.

## Capabilities

`PLUGIN_CAPABILITIES` (`permissions.ts`), with risk and scope kind:

| Capability            | Risk   | Scope | Notes                                                                        |
| --------------------- | ------ | ----- | ---------------------------------------------------------------------------- |
| `fs:read`             | medium | path  | re-authorized against symlink-real path                                      |
| `fs:write`            | high   | path  | re-authorized; runs under ActionGuard                                        |
| `net:fetch`           | medium | host  | egress-guarded (SSRF/rebind)                                                 |
| `agents:read`         | low    | none  | list/read agent metadata                                                     |
| `agents:dispatch`     | high   | none  | INERT (no production handler)                                                |
| `notifications:toast` | low    | none  | raise a toast                                                                |
| `settings:read`       | low    | none  | non-secret app settings; not the feature gate, not a peer plugin's namespace |
| `settings:write`      | low    | none  | ONLY `plugins.<id>.*` keys                                                   |
| `sessions:read`       | medium | none  | METADATA only, never transcript text                                         |
| `storage:read`        | low    | none  | own KV                                                                       |
| `storage:write`       | low    | none  | own KV                                                                       |
| `ui:command`          | low    | none  | invoke a registered palette command                                          |
| `events:subscribe`    | medium | none  | metadata-only topics                                                         |
| `process:spawn`       | high   | none  | INERT (no production handler)                                                |

`PermissionRequest = { capability, scope?, reason? }`. Path/host scopes narrow `fs:*`/`net:fetch`; an absent scope means the broad form (the consent UI must present it as such). The user grants a subset at the consent dialog (`plugins:set-grants`).

## Contributions + registry merge

`collectContributions` validates one plugin's `contributes.*`; `aggregateContributions` merges across active plugins. Rules:

- Every contributed id is namespaced `<pluginId>/<localId>`. The manifest author writes the bare local `id`; the loader stores both `localId` and the namespaced `id`.
- Invalid individual items are dropped with a recorded error rather than failing the whole plugin (a typo in one theme must not hide good prompts).
- On a namespaced-id collision the first wins (defended even though ids are plugin-scoped). For runtime agents, built-in agents always win, so a plugin can never shadow a first-party agent.
- Contribution types: `themes`, `prompts`, `settings`, `commandMacros`, `cueTriggers` (tier 0); `commands`, `panels`, `agents` (tier 1). `cueTriggers` with `action: 'notify'` run on tier 0; `action: 'dispatch'` needs `agents:dispatch` (inert). Registering an `agents` contribution does NOT enable spawning it - that is a separate, security-reviewed step (arbitrary binary execution).

## IPC surface (`src/main/ipc/handlers/plugins.ts`)

Channels (all gated on `encoreFeatures.plugins`):

`plugins:list`, `plugins:set-enabled`, `plugins:install`, `plugins:uninstall`, `plugins:contributions`, `plugins:get-grants`, `plugins:set-grants`, `plugins:revoke-grants`, `plugins:invoke-command`, `plugins:panel-html`.

- **Pure-reads invariant.** `plugins:list` and `plugins:contributions` MUST NOT call `refresh()`. `refresh()` reconciles sandboxes and fires `onChange` -> `plugins:changed` -> renderer re-fetch -> read again, an infinite IPC loop that freezes the app. Discovery happens at startup and on mutations only.
- **Consent (`plugins:set-grants`).** The user approves a SUBSET of the plugin's REQUESTED permissions. The handler intersects approved capabilities with the manifest's requests, so an over-broad grant can never be smuggled in via the renderer, and only known capabilities survive. `plugins:revoke-grants` calls `forgetGrants`.

## Renderer panel lockdown + consent

`PluginPanelFrame.tsx` is the ONE place panel HTML renders:

- Loaded over `plugins:panel-html` and injected as `srcDoc` into an iframe with `sandbox="allow-scripts"` and NO `allow-same-origin` and NO URL `src`. The frame cannot read app cookies/localStorage, reach `window.parent`, navigate the top frame, or touch the host DOM.
- `withPanelCsp` injects a restrictive meta CSP (`default-src 'none'`, `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, inline script/style allowed, `img/font` `data:` only). So a panel CANNOT fetch/XHR/WebSocket directly - any network must go through the brokered `net:fetch` capability.
- The only channel out is `postMessage({ type: 'maestro:invokeCommand', commandId, args })`. The host accepts it only when `event.source === iframe.contentWindow`, namespaces it to `<pluginId>/<commandId>`, and forwards over the broker-gated `plugins:invoke-command` RPC to the plugin's registered command handler. A non-suppressible "from <plugin>" provenance line sits above every panel.
- KNOWN RESIDUAL: a meta CSP cannot block frame self-navigation, so a panel could set `window.location` to leak data it already obtained via granted capabilities. Top-frame nav is blocked; full self-nav egress blocking needs main-process `will-frame-navigate` filtering (tracked follow-up).

## Signing / trust

`signing.ts` + `plugin-signature.ts`. An optional `signature.json` (ed25519) covers a deterministic payload built from the SHA-256 of every other file in the plugin dir, so any tampering invalidates it. Statuses:

- `unsigned` - no signature.
- `invalid` - tampered or malformed signature. NEVER runnable.
- `untrusted` - valid signature, signing key not in the trusted set (integral but unknown publisher).
- `trusted` - valid signature, key in the trusted set.

Integrity ("files match what was signed") and trust ("key is recognized") are layered; a plugin can be integral-but-untrusted and still run once the user has enabled = consented.

## Host-API semver contract

`HOST_API_VERSION` is a permanent public contract once plugins ship. PATCH = host bug fix; MINOR = additive (new contribution point / manifest field / capability, older plugins keep working); MAJOR = remove or change the meaning of an existing one. A plugin pins `maestro.minHostApi`; the host loads it only when same-major and `host >= min`.

## Key invariants and gotchas (read before editing)

1. **Encore gate everywhere.** Any new `plugins:*` channel must throw `'PluginsDisabled'` outside `withIpcErrorLogging` when the flag is off, and any manager method that exposes plugin data must return empty when disabled.
2. **Reads stay pure.** Never call `refresh()` from a read path - it reconciles sandboxes and loops via `plugins:changed`.
3. **Default deny.** Add a host method only by adding it to the `HOST_API` table with its capability; the broker derives authorization from that table. A method missing from the table is unreachable.
4. **fs is re-authorized after symlink resolution.** Never trust the raw path string; resolve the real path and re-`authorize`. The userData/config tree is excluded even under a broad grant.
5. **Net scope alone is not enough.** Hostname scope plus the egress guard (resolved-IP block list + connection pinning + `redirect: 'error'`) together defend `net:fetch`. Do not loosen any one of them in isolation.
6. **Events and sessions are metadata only.** Payloads NEVER contain transcript/prompt text or file contents. Redaction is not a boundary for free-form text.
7. **Built-in wins.** Plugin agents/contributions can never shadow first-party ids.
8. **Uninstall purges everything** (dir, toggle, grants, KV, `plugins.<id>.*` settings, event subs). Add any new per-plugin state to `purgePluginData`.
9. **Inert by design.** `agents:dispatch` and `process:spawn` have no production handler; do not wire them without the documented security review.

## Honest tier-1 trust model

The `vm` sandbox is realm-escapable. The intrinsics Maestro injects (the SDK, `console`, `setTimeout`) are host-realm functions, so `someInjected.constructor("return process")()` reaches the real `process`, and `codeGeneration.strings: false` only disables code-gen for the context's own `Function`, not the host's. The `vm` is DEFENSE-IN-DEPTH, never the boundary. The real controls are: the separate `utilityProcess` (process + crash isolation), the default-deny broker (which still gates ambient fs/net/exec authority), and signature/consent gating on which code runs at all. Closing the escape fully (an OS-level sandbox dropping ambient authority) is the documented Phase-3 decision. Until then, **enabling a tier-1 code plugin is a full-trust decision - only install plugins you trust.**

## See also

- `src/shared/plugins/` - pure contracts (`plugin-manifest.ts`, `permissions.ts`, `contributions.ts`, `events.ts`, `host-api.ts`, `rpc-protocol.ts`, `signing.ts`).
- `src/main/plugins/` - runtime (`plugin-manager.ts`, `plugin-sandbox-host.ts`, `plugin-sandbox-entry.ts`, `plugin-host-handlers.ts`, `permission-broker.ts`, `net-egress-guard.ts`).
- `src/main/ipc/handlers/plugins.ts` - IPC channels and the pure-reads invariant.
- `src/renderer/components/plugins/PluginPanelFrame.tsx` - panel lockdown + the postMessage bridge.
- [docs/agent-guides/PLUGIN-DEVELOPMENT.md](docs/agent-guides/PLUGIN-DEVELOPMENT.md) - the practical authoring guide.
