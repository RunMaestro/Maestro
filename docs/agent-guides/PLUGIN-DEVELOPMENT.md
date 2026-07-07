<!-- Verified 2026-06-27 against src/shared/plugins/ + src/main/plugins/ -->

# Plugin Development Guide

How to write a Maestro plugin. For the system internals (why each control exists, the broker, gotchas), see [CLAUDE-PLUGINS.md](../../CLAUDE-PLUGINS.md). Everything below is verified against `src/shared/plugins/` and `src/main/plugins/`; do NOT assume a field or method that is not listed here.

A plugin is one folder under `<userData>/plugins/` with a `plugin.json` manifest. The plugin system is behind the `plugins` Encore feature flag (off by default) - enable it in Settings before anything below works.

---

## Quickstart: scaffold your first plugin

Use the `maestro plugin` CLI rather than hand-writing files - `init` produces a manifest that already passes validation and (for code tiers) a runnable entrypoint.

```bash
# data-only plugin (no code, tier 0)
maestro plugin init my-data --tier 0 --id com.example.data --name "My Data"

# code plugin (tier 1)
maestro plugin init my-plugin --tier 1 --id com.example.demo --name "Demo"
```

What `init` writes:

- **Tier 0** - `plugin.json`, `README.md`, `.gitignore`. No code; the host runs nothing.
- **Tier 1/2** - the above plus `entry.js` (the sandboxed entrypoint), `package.json` (`"type": "commonjs"`, pins `@maestro/plugin-sdk` as a dev dependency), and `tsconfig.json` (`NodeNext`, `checkJs`) so your editor type-checks `entry.js` with no build step.

The scaffolded `entry.js` is plain **CommonJS**. The sandbox loads it as a classic script (no ESM, no bundler, no `require`), so you assign `activate`/`deactivate` to `module.exports` and pull SDK types in through a JSDoc `@import` tag:

```js
/** @import { MaestroSdk, PluginModule } from '@maestro/plugin-sdk' */

/** @param {MaestroSdk} maestro The brokered Maestro host API. */
function activate(maestro) {
	// your plugin code here
	void maestro;
}
function deactivate() {}

/** @type {PluginModule} */
module.exports = { activate, deactivate };
```

> Do NOT use ESM in `entry.js` (`export function activate`, `import ... from`). The sandbox runs the file through `new vm.Script` and reads `module.exports`; `export`/`import` syntax fails to parse and the plugin never activates.

Then iterate and ship:

```bash
maestro plugin validate ./my-plugin
maestro plugin sign ./my-plugin --gen-key --key-out ./signing-key.pem
maestro plugin pack ./my-plugin            # -> com.example.demo-0.1.0.tgz
```

Drop the folder into `<userData>/plugins/` (or install the `.tgz` from Settings -> Plugins). Tier 0 is active immediately; tier 1/2 stay disabled until you enable them and approve capabilities. Each step is detailed below.

---

## 1. Pick a tier

| Tier | What it is                                                                                     | Code?                  | Risk          |
| ---- | ---------------------------------------------------------------------------------------------- | ---------------------- | ------------- |
| 0    | Data only: declarative contributions (themes, prompts, settings, command macros, cue triggers) | NO (`entry` forbidden) | lowest        |
| 1    | Sandboxed compute: runs `entry` code in an isolated process behind the permission broker       | YES (`entry` required) | needs consent |
| 2    | UI contributions: sandboxed panels / modals / commands                                         | YES (`entry` required) | needs consent |

Do start at tier 0 if you only ship data. Do NOT request a capability you do not use - the user sees every one at the consent prompt.

Tier 0 auto-enables on discovery. Tier 1 and 2 stay DISABLED until the user enables them and consents to the requested capabilities.

---

## 2. Directory layout

```
<userData>/plugins/
  maestro-vet-code/
    plugin.json        required
    entry.js           required for tier >= 1 (relative, inside the folder, no traversal)
    panel.html         a panel's HTML entry (tier 1/2)
    signature.json     optional ed25519 signature
```

One folder per plugin. The folder name and the manifest `id` must agree on install. `entry` and panel `entry` paths must be relative and stay inside the plugin folder (absolute paths, `..`, and a leading `~` are rejected).

---

## 3. plugin.json reference

`PluginManifest` (`src/shared/plugins/plugin-manifest.ts`):

| Field         | Type                     | Required  | Notes                                                           |
| ------------- | ------------------------ | --------- | --------------------------------------------------------------- |
| `id`          | string                   | yes       | `^[a-z][a-z0-9]*([._-][a-z0-9]+)*$`, 3-100 chars                |
| `name`        | string                   | yes       | display name                                                    |
| `version`     | string                   | yes       | semver (distinct from `minHostApi`)                             |
| `tier`        | `0 \| 1 \| 2`            | yes       | trust/capability tier                                           |
| `maestro`     | `{ minHostApi: string }` | yes       | minimum host API (current host is `1.4.0`)                      |
| `description` | string                   | no        |                                                                 |
| `author`      | string                   | no        |                                                                 |
| `license`     | string                   | no        |                                                                 |
| `homepage`    | string                   | no        |                                                                 |
| `contributes` | object                   | no        | declarative contributions (see catalog)                         |
| `entry`       | string                   | tier >= 1 | relative path to the sandboxed code entry; FORBIDDEN for tier 0 |
| `permissions` | `PermissionRequest[]`    | no        | only meaningful for tier >= 1                                   |

`minHostApi` is checked same-major and `host >= min`. A v2-targeted plugin will not load on a v1 host and vice versa.

### Worked example: tier 0 (data only)

```json
{
	"id": "maestro-vet-data",
	"name": "Maestro Vet (Data)",
	"version": "1.0.0",
	"tier": 0,
	"maestro": { "minHostApi": "1.4.0" },
	"description": "Data-only contributions for the vet workflow.",
	"contributes": {
		"themes": [
			{
				"id": "vet-neon",
				"name": "Vet Neon",
				"mode": "dark",
				"colors": { "bgMain": "#0b0f1a", "accent": "#36f9c5" }
			}
		],
		"prompts": [
			{
				"id": "vet-summary",
				"title": "Vet: Summarize Session",
				"content": "Summarize the current session in five bullets."
			}
		],
		"commandMacros": [
			{ "id": "vet-ping", "title": "Vet: Ping Macro", "prompt": "Reply with PONG." }
		],
		"settings": [{ "id": "vet-verbose", "key": "verbose", "type": "boolean", "default": false }]
	}
}
```

### Worked example: tier 1 (code + panel)

```json
{
	"id": "maestro-vet-code",
	"name": "Maestro Vet (Code)",
	"version": "1.0.0",
	"tier": 1,
	"maestro": { "minHostApi": "1.4.0" },
	"entry": "entry.js",
	"permissions": [
		{ "capability": "storage:read", "reason": "Remember the last greeting." },
		{ "capability": "storage:write" },
		{ "capability": "settings:read" },
		{ "capability": "settings:write" },
		{ "capability": "sessions:read" },
		{ "capability": "events:subscribe" },
		{ "capability": "notifications:toast" },
		{ "capability": "net:fetch", "scope": "example.com" }
	],
	"contributes": {
		"commands": [{ "id": "say-hello", "title": "Vet: Say Hello" }],
		"panels": [
			{ "id": "vet-panel", "title": "Vet Panel", "entry": "panel.html", "placement": "right" }
		]
	}
}
```

---

## 4. Contributions catalog

Every contributed `id` is the bare LOCAL id you author; the loader namespaces it to `<pluginId>/<localId>`. A bad item is dropped with an error rather than failing the whole plugin. Built-in ids always win on a collision.

### themes

`{ id, name, mode: 'light' | 'dark', colors: Record<string, string> }`

```json
{
	"id": "vet-neon",
	"name": "Vet Neon",
	"mode": "dark",
	"colors": { "bgMain": "#0b0f1a", "accent": "#36f9c5" }
}
```

### prompts

`{ id, title, content, description? }`

```json
{ "id": "vet-summary", "title": "Vet: Summarize Session", "content": "Summarize the session." }
```

### settings

`{ id, key, type: 'boolean' | 'string' | 'number', default, description? }`

```json
{ "id": "vet-verbose", "key": "verbose", "type": "boolean", "default": false }
```

The `key` must NOT: be a prototype segment (`__proto__` / `prototype` / `constructor`), match `encoreFeatures`, look secret (`key`, `token`, `secret`, `password`, `credential`, `apikey`, `auth`, `bearer`, `oauth`, `jwt`, `private`, `cert`, `signing`), or contain a path separator (`/`, `\`, `..`). `default` must match `type`.

### commandMacros (tier 0)

`{ id, title, prompt, description? }` - dispatches a templated prompt; no code.

```json
{ "id": "vet-ping", "title": "Vet: Ping Macro", "prompt": "Reply with PONG." }
```

### cueTriggers (tier 0)

`{ id, title, schedule, action: 'notify' | 'dispatch', payload, agentId? }` where `schedule` is `{ kind: 'interval', everyMinutes }` or `{ kind: 'dailyTimes', times: ['HH:MM'] }`.

```json
{
	"id": "vet-standup",
	"title": "Vet Standup",
	"schedule": { "kind": "dailyTimes", "times": ["09:00"] },
	"action": "notify",
	"payload": "Time for vet standup."
}
```

Only `action: 'notify'` runs on tier 0. `action: 'dispatch'` needs `agents:dispatch`, which is currently inert.

### commands (tier 1)

`{ id, title, description? }` - invoking it sends an `invokeCommand` RPC into the sandbox, where the plugin did `maestro.commands.register(localId, fn)`.

```json
{ "id": "say-hello", "title": "Vet: Say Hello" }
```

### panels (tier 1)

`{ id, title, entry, placement }` where `entry` is a plugin-relative `.html` file and `placement` is `'modal' | 'left' | 'right' | 'main' | 'settings'` (defaults to `modal`).

```json
{ "id": "vet-panel", "title": "Vet Panel", "entry": "panel.html", "placement": "right" }
```

### agents (tier 1)

`{ id, displayName, binaryName, baseArgs?, capabilities? }`. `binaryName` is a bare command (no path, traversal, or shell metacharacters); `capabilities` is a boolean feature map. Registering an agent adds it to the registry but does NOT enable spawning it (arbitrary binary execution is a separate, security-reviewed step).

```json
{
	"id": "vet-cli",
	"displayName": "Vet CLI",
	"binaryName": "vet",
	"baseArgs": ["--json"],
	"capabilities": { "streaming": true }
}
```

### tools (tier 1)

`{ id, name, description, inputSchema? }` - a named operation an agent can call. Register a handler with `maestro.tools.register(localId, fn)`; the host invokes it via a brokered request/response (`plugins:invoke-tool`) and your handler's return value is returned to the caller. When the `plugins` feature is on, registered tools are also exposed to a spawned agent's model over MCP: the host points the agent at `maestro-cli mcp serve` (claude and codex auto-inject the ephemeral config; other agents are best-guess), and every model-initiated call is risk-gated before the broker runs it.

### keybindings (tier 1)

`{ id, key, command, description? }` where `key` is a chord (e.g. `"Ctrl+Shift+P"`) and `command` is one of YOUR plugin-local command ids (validated as a local id, so it cannot target another plugin's command or a built-in). Parsed and discoverable now; actually binding the chord is a separate consumption step.

---

## 5. Capabilities

Request these in `permissions` as `{ capability, scope?, reason? }`. `scope` narrows `fs:*` (a directory), `net:fetch` (a host), and `transcripts:read` (a project path); absent means the broad form. `reason` shows at the consent prompt.

| Capability            | Risk   | Scope | What it allows                                                       | How to request                                                  |
| --------------------- | ------ | ----- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `fs:read`             | medium | path  | read files under the scope path                                      | `{ "capability": "fs:read", "scope": "/abs/dir" }`              |
| `fs:write`            | high   | path  | write files under the scope path                                     | `{ "capability": "fs:write", "scope": "/abs/dir" }`             |
| `net:fetch`           | medium | host  | HTTP(S) fetch to the scope host                                      | `{ "capability": "net:fetch", "scope": "example.com" }`         |
| `agents:read`         | low    | none  | list/read agent metadata                                             | `{ "capability": "agents:read" }`                               |
| `agents:dispatch`     | high   | none  | send a prompt to an agent (INERT today)                              | `{ "capability": "agents:dispatch" }`                           |
| `notifications:toast` | low    | none  | raise a toast                                                        | `{ "capability": "notifications:toast" }`                       |
| `settings:read`       | low    | none  | read non-secret app settings + own `plugins.<id>.*`                  | `{ "capability": "settings:read" }`                             |
| `settings:write`      | low    | none  | write ONLY own `plugins.<id>.*` keys                                 | `{ "capability": "settings:write" }`                            |
| `sessions:read`       | medium | none  | list session METADATA (never transcript)                             | `{ "capability": "sessions:read" }`                             |
| `transcripts:read`    | high   | path  | read PROJECTED session content (you declare fields)                  | `{ "capability": "transcripts:read", "scope": "/abs/project" }` |
| `storage:read`        | low    | none  | read own private key-value store                                     | `{ "capability": "storage:read" }`                              |
| `storage:write`       | low    | none  | write own private key-value store                                    | `{ "capability": "storage:write" }`                             |
| `ui:command`          | low    | none  | invoke a registered palette command                                  | `{ "capability": "ui:command" }`                                |
| `events:subscribe`    | medium | none  | subscribe to metadata-only host topics                               | `{ "capability": "events:subscribe" }`                          |
| `process:spawn`       | high   | none  | run a shell command (INERT today)                                    | `{ "capability": "process:spawn" }`                             |
| `ui:contribute`       | medium | none  | add host-rendered items to Maestro's UI (menus, sidebar, status bar) | `{ "capability": "ui:contribute" }`                             |
| `ui:panel`            | medium | none  | render its own sandboxed interactive panels                          | `{ "capability": "ui:panel" }`                                  |
| `ui:render-unsafe`    | high   | none  | render custom UI with full interface access (escape hatch)           | `{ "capability": "ui:render-unsafe" }`                          |

`agents:dispatch` and `process:spawn` have no production handler; the SDK methods exist but reject. The broker re-reads grants on every call, so a revoke takes effect immediately, and it re-authorizes `fs:*` paths against the symlink-resolved real path.

`transcripts:read` is project-scoped: `scope` is a project path, and an absent scope means all projects (presented as such at consent). It is refused for an untrusted plugin that also holds `net:fetch` or `process:spawn` (the content-exfiltration combination) - sign with a trusted key to allow both. Reads are rate-limited as a high-risk verb and every read is audited.

The `ui:*` capabilities gate what the host accepts and renders, not a brokered SDK call: `ui:contribute` admits your declarative `uiItems` into host surfaces, `ui:panel` admits your sandboxed `panels`, and `ui:render-unsafe` is the high-trust escape hatch for full custom UI. An enabled plugin WITHOUT the matching grant contributes none of that surface.

---

## 6. Tier-1 entry code + the maestro SDK

Your `entry` file is plain **CommonJS** JavaScript run inside a confined `vm` context (it is NOT `require`d, and ESM `export`/`import` will not parse). Assign `module.exports = { activate(maestro) {}, deactivate() {} }`; `activate` receives the frozen `maestro` SDK. Pull SDK types into the plain-JS file with a JSDoc `@import` tag (shown below).

**Sandbox globals available:** `maestro`, `module`, `exports`, `console` (`log`/`info`/`warn`/`error` route to the host log), `setTimeout`, `clearTimeout`. `async`/`await`/`Promise` work.

**Absent by design:** `require`, `process`, `Buffer`, `globalThis`, Node builtins; `eval`/`Function` code-gen is disabled. There is no direct host access - every effect goes through a brokered SDK call that rejects if the capability is not granted.

> **Security note (do not misread the above):** this describes the INTENDED API surface, not a hard security boundary. The `vm` context is realm-escapable, so a malicious tier-1 plugin CAN still reach the host (`process`, fs, network) and bypass the broker. Enabling a tier-1 code plugin is therefore a full-trust, experimental decision until OS-level sandboxing lands (Phase 3). Write benign plugins against the SDK below; never rely on the sandbox to contain hostile code. See section 13 and the threat model in [CLAUDE-PLUGINS.md](../../CLAUDE-PLUGINS.md).

**Limits:** per-plugin in-flight cap 32, rate limit 200 calls/second, single request capped at 1 MB.

### Minimal entry.js

```js
/** @import { MaestroSdk, PluginModule } from '@maestro/plugin-sdk' */

/** @param {MaestroSdk} maestro */
async function activate(maestro) {
	maestro.commands.register('say-hello', async () => {
		await maestro.notifications.toast('Hello from the vet plugin');
	});
	maestro.events.on('session.updated', (payload, meta) => {
		console.log('session updated', payload.sessionId, meta.topic);
	});
	await maestro.events.subscribe(['session.updated']);
}
function deactivate() {}

/** @type {PluginModule} */
module.exports = { activate, deactivate };
```

### SDK reference

Every method below is broker-gated and needs the matching capability granted. Signatures are copied from `buildSdk` (`src/main/plugins/plugin-sandbox-entry.ts`).

| SDK method                                                                      | Capability                   |
| ------------------------------------------------------------------------------- | ---------------------------- |
| `maestro.pluginId` (string)                                                     | -                            |
| `maestro.fs.read(path)` -> `Promise<string>`                                    | `fs:read`                    |
| `maestro.fs.write(path, contents)` -> `Promise<void>`                           | `fs:write`                   |
| `maestro.net.fetch(url, init?)` -> `Promise<unknown>`                           | `net:fetch`                  |
| `maestro.agents.list()`                                                         | `agents:read`                |
| `maestro.agents.get(agentId)`                                                   | `agents:read`                |
| `maestro.agents.dispatch(agentId, prompt, opts?)` (INERT)                       | `agents:dispatch`            |
| `maestro.notifications.toast(message, opts?)` -> `Promise<void>`                | `notifications:toast`        |
| `maestro.settings.get(key)`                                                     | `settings:read`              |
| `maestro.settings.set(key, value)` (key must be `plugins.<id>.*`)               | `settings:write`             |
| `maestro.sessions.list()` (metadata only)                                       | `sessions:read`              |
| `maestro.sessions.get(sessionId)` (metadata only)                               | `sessions:read`              |
| `maestro.transcripts.read({ sessionId, fields, projectPath?, limit?, since? })` | `transcripts:read`           |
| `maestro.storage.get(key)`                                                      | `storage:read`               |
| `maestro.storage.keys()`                                                        | `storage:read`               |
| `maestro.storage.set(key, value)` (value is a string)                           | `storage:write`              |
| `maestro.storage.delete(key)`                                                   | `storage:write`              |
| `maestro.ui.runCommand(commandId, args?)`                                       | `ui:command`                 |
| `maestro.events.on(topic, handler(payload, meta))`                              | - (delivery needs subscribe) |
| `maestro.events.subscribe(topics[])`                                            | `events:subscribe`           |
| `maestro.events.unsubscribe(topics?)`                                           | `events:subscribe`           |
| `maestro.commands.register(commandId, handler(args))`                           | - (invoked by host)          |
| `maestro.tools.register(toolId, handler(args))` (result returned to host)       | - (invoked by host)          |
| `maestro.process.spawn(command, opts?)` (INERT)                                 | `process:spawn`              |

`net.fetch` returns `{ status, statusText, headers, body }` (body is text, capped at 5 MB). Requests are egress-guarded: loopback, link-local, RFC1918, cloud-metadata, and the app's own port are blocked, and redirects are not followed (`redirect: 'error'`), so a 3xx to a non-granted host fails.

`transcripts.read` returns only the `fields` you declare for each entry (projection, not redaction); allowlisted fields include `summary`, `fullResponse`, `timestamp`, `type`, `sessionName`, and `agentSessionId`. Pass `projectPath` (from `sessions.list` metadata) so a project-scoped grant authorizes; the handler re-checks the session's real project before returning. It is bounded as a high-risk verb and audited per read.

---

## 7. Panels (HTML + the postMessage bridge)

A panel renders in an isolated Electron `<webview>` guest with a per-plugin in-memory session (partition `plugin:<pluginId>`): no Node, contextIsolation, OS sandbox, opaque origin, and a restrictive CSP served by the host (`connect-src 'none'`, etc.). Navigation and network egress are denied in the main process — the panel lives on its initial document.

**A panel CANNOT make network requests directly.** No `fetch`/XHR/WebSocket. To cause any effect, post a command to the parent; the plugin's registered command handler runs in the sandbox and uses the brokered SDK from there.

The ONLY channel out is:

```js
parent.postMessage(
	{
		type: 'maestro:invokeCommand',
		commandId: 'say-hello',
		args: {
			/* optional */
		},
	},
	'*'
);
```

The host's guest preload accepts the message only from the panel document's own window, namespaces it to `<pluginId>/<commandId>`, and forwards it over the broker-gated `invokeCommand` RPC to your `maestro.commands.register('say-hello', ...)` handler. (In the panel, `parent === window` — existing panels keep working unchanged.)

### Minimal panel.html

```html
<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
	</head>
	<body>
		<button id="hi">Say hello</button>
		<script>
			document.getElementById('hi').addEventListener('click', () => {
				parent.postMessage({ type: 'maestro:invokeCommand', commandId: 'say-hello' }, '*');
			});
		</script>
	</body>
</html>
```

Flow: panel button posts the command -> host forwards over the broker -> the plugin's `say-hello` handler runs in the sandbox -> it calls `maestro.notifications.toast(...)` (a brokered effect).

---

## 8. Events

A plugin with `events:subscribe` receives a FIXED catalog of host topics (`src/shared/plugins/events.ts`). Payloads are METADATA ONLY - never transcript or prompt text.

| Topic                 | Payload                                         |
| --------------------- | ----------------------------------------------- |
| `session.created`     | `{ sessionId, title?, agentId?, projectPath? }` |
| `session.updated`     | `{ sessionId, title?, status? }`                |
| `session.removed`     | `{ sessionId }`                                 |
| `agent.awaiting`      | `{ agentId, tabId?, kind?, risk? }`             |
| `agent.statusChanged` | `{ agentId, tabId?, status }`                   |
| `cue.fired`           | `{ cueType, projectPath? }`                     |

Register handlers with `maestro.events.on(topic, fn)` first, then start delivery with `maestro.events.subscribe([...])`. Stop with `maestro.events.unsubscribe([...])` (or no argument for all). The handler receives `(payload, meta)` where `meta` is `{ topic, at }`. Unknown topics are ignored.

---

## 9. Settings and storage namespacing

- `maestro.settings.get(key)` reads non-secret app settings and your own `plugins.<id>.*` keys. It will NOT return a secret-looking key, the `encoreFeatures` gate, or another plugin's `plugins.<other>.*` namespace.
- `maestro.settings.set(key, value)` writes ONLY `plugins.<id>.*` keys (where `<id>` is your plugin id). The same secret/prototype/gate guards apply, the value must be JSON-serializable, and it is capped at 64 KB.
- `maestro.storage.*` is your own private key-value store, scoped to your plugin. Values are strings. Use `set`/`get`/`delete`/`keys`. It is purged on uninstall.

---

## 10. Consent and grants

Tier 1/2 plugins request capabilities in `permissions`. When the user enables the plugin, the consent dialog lets them approve a SUBSET of those requests. The host only ever grants a capability the manifest requested, and only known capabilities survive - an over-broad grant cannot be injected. The user can revoke grants at any time; the broker re-reads grants on every call, so revocation is instant. Uninstalling purges grants, KV, `plugins.<id>.*` settings, and event subscriptions.

---

## 11. Signing (optional)

Ship a `signature.json` (ed25519) alongside your files. It covers a deterministic payload built from the SHA-256 of every other file in the folder, so any tampering invalidates it. Trust statuses:

- `unsigned` - no signature.
- `invalid` - tampered or malformed. NEVER runnable.
- `untrusted` - valid signature, key not in Maestro's trusted set (integral but unknown publisher).
- `trusted` - valid signature, key in the trusted set.

An integral-but-untrusted plugin still runs once the user enables = consents. A tampered (`invalid`) plugin is never run.

---

## 12. Installing

1. Build your plugin folder (`plugin.json` plus any `entry.js` / panels).
2. Drop the folder into `<userData>/plugins/` (one folder per plugin), or install it from the Plugins settings panel.
3. Open Settings -> Plugins. Tier 0 plugins are active immediately. For tier 1/2, enable the plugin and approve its capabilities at the consent dialog.
4. The plugins feature must be on (`plugins` Encore flag); otherwise every plugin action reports the feature is disabled.

---

## 13. Constraints and gotchas

- **Tier 1 is a full-trust decision.** The `vm` sandbox is realm-escapable; a malicious tier-1 plugin can reach full Node/system access. The real controls are process isolation, the default-deny broker, and signature/consent. Only install plugins you trust. (See [CLAUDE-PLUGINS.md](../../CLAUDE-PLUGINS.md) for the full threat model.)
- **Panels cannot fetch directly.** The CSP blocks all network from the iframe. Route any network or effect through a brokered command (`maestro:invokeCommand` -> your command handler -> brokered SDK).
- **Events are metadata only.** Never expect transcript or prompt text in an event payload.
- **Built-in wins on collisions.** Your contributed ids can never shadow a first-party theme, command, or agent.
- **Host-API compatibility is strict.** Same major and `host >= minHostApi`, or the plugin will not load.
- **Setting-key rules are enforced twice** (declarative contributions and runtime `settings.set`): no prototype segments, no `encoreFeatures`, no secret-looking names, no path separators.
- **`entry` rules:** required for tier >= 1, forbidden for tier 0, must stay inside the plugin folder.
- **Inert capabilities:** `agents:dispatch` and `process:spawn` are declared but have no production handler; do not build on them yet.

## 14. Tooling: the SDK package and the `maestro plugin` CLI

**`@maestro/plugin-sdk`** (`packages/plugin-sdk/`) is the typed authoring surface: the manifest, capability, contribution, and event types, the `MaestroSdk` runtime shape, and `defineManifest()` / `definePlugin()` helpers. The scaffold adds it as a dev dependency so your editor type-checks the manifest and entry code. Because the runtime `entry.js` is plain CommonJS, reference the types with a JSDoc `@import` tag - no runtime import, no build step:

```js
/** @import { MaestroSdk, PluginModule } from '@maestro/plugin-sdk' */
```

If you instead author in TypeScript and compile down to a CommonJS `entry.js`, the ESM type imports work too:

```ts
import { defineManifest, type PluginModule, type MaestroSdk } from '@maestro/plugin-sdk';
```

**The `maestro plugin` CLI** scaffolds, validates, signs, and packages a plugin:

- `maestro plugin init [dir] --tier <0|1|2> --id <id> --name <name>` - scaffold a valid `plugin.json` (plus `entry.js`, README, and an SDK-typed `tsconfig.json` + `package.json` for code tiers). Refuses a non-empty dir without `--force`.
- `maestro plugin validate [dir]` - run `validatePluginManifest`, report errors, and resolve the `signature.json` trust status (`unsigned` / `invalid` / `untrusted` / `trusted`).
- `maestro plugin sign <dir> --key <pem|base64>` (or `--gen-key --key-out <path>` to generate an ed25519 keypair) - write a `signature.json` whose payload is byte-identical to what the host verifies.
- `maestro plugin pack <dir> --out <file>` - build a distributable `.tgz` (excludes `node_modules`, `.git`, and key files).

Typical flow: `init` -> edit -> `validate` -> `sign --gen-key --key-out key.pem` -> `pack`.

## See also

- [CLAUDE-PLUGINS.md](../../CLAUDE-PLUGINS.md) - system architecture, invariants, threat model.
- `src/shared/plugins/plugin-manifest.ts` - manifest shape and validation.
- `src/shared/plugins/permissions.ts` - capability vocabulary, risk/scope, grant matching.
- `src/shared/plugins/contributions.ts` - contribution interfaces and validation.
- `src/shared/plugins/events.ts` - event topic catalog and payloads.
- `src/main/plugins/plugin-sandbox-entry.ts` - the `maestro` SDK (`buildSdk`) and sandbox globals.
- `src/main/plugins/plugin-host-handlers.ts` - what each brokered call actually does.
- `src/renderer/components/plugins/PluginPanelFrame.tsx` + `src/main/plugins/plugin-panel-host.ts` - the panel render host (isolated webview), CSP, and the postMessage bridge.
- `packages/plugin-sdk/` - the `@maestro/plugin-sdk` typed authoring package.
- `src/cli/commands/plugin.ts` - the `maestro plugin` init/validate/sign/pack CLI.
