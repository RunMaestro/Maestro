# Relay host contract (Host API 1.21.0)

This is the Maestro host half of the Relay Discord integration. The Discord gateway, token UI, channel ownership, per-thread session mapping, and Pianola exceptions belong to the Relay plugin, not the host. The host never receives the bot token as a setting or agent environment variable.

## Incoming Discord thread

An enabled, trusted plugin may call:

```ts
const result = await maestro.agents.send(agentId, prompt, {
	sessionId: providerSessionId, // optional
	onProgress: (event) => updateProgressCard(event), // optional
});
// result: { success: boolean; response: string | null;
//           sessionId: string | null; error?: string }
```

`onProgress` receives only events from **this invocation** before the promise
settles. The callback is optional and is never serialized into the broker
request. Its event union is:

```ts
type AgentSendProgressEvent =
	| { type: 'activity'; text: string; at: string }
	| { type: 'commentary'; text: string; at: string }
	| {
			type: 'tool';
			tool: string;
			status: 'started' | 'completed' | 'failed';
			at: string;
			summary?: string;
	  };
```

`at` is an ISO 8601 UTC timestamp. `activity` is a host-owned generic status;
`commentary` is provider-designated public commentary, never raw reasoning;
`tool` carries a tool name, lifecycle status, and optional host-derived public
action summary of at most 120 characters, never arguments, output, command text,
or raw logs. A provider may emit fewer kinds, or none. The host
posts each event to the calling plugin's sandbox with that RPC request's private
correlation ID; no global event subscription or `events:subscribe` grant is
needed. Events stop on completion, cancellation, timeout, plugin stop, or grant
revocation. The result remains the only authoritative final response.

The current host emits `activity` when the headless run starts. Codex's explicit
commentary phase emits `commentary`; Claude and JSON-line providers emit tool
lifecycle events when their stream exposes them. Providers with no usable stream
still complete normally and may emit only the initial `activity` event.

With no `sessionId`, the host starts a fresh headless provider session. With one, it passes that opaque provider session ID to the provider's resume path. `sessionId` in the result is a **provider session ID**, not a desktop tab ID or Maestro agent ID. The plugin stores one ID per Discord thread and only saves a new ID after `success: true`. A failed run has `response: null`, may carry a provider ID for diagnostics, and must not be posted as a successful answer. The host runs different threads independently. The `agents:dispatch` ActionGuard limits one plugin to two concurrent high-risk actions; additional calls fail clearly and may be queued by the plugin. The provider process has a 20-minute timeout. Disabling, crashing, or uninstalling the plugin aborts its outstanding `agents.send` processes.

The host also records successful provider session IDs in a private persistent binding store under `<userData>/plugin-agent-sessions/`. A resume is allowed only for the same plugin and Maestro agent that received the ID; knowing another agent's provider ID is insufficient. The 10,000 most recently used bindings per plugin survive a desktop restart. Older bindings are evicted as new sessions arrive and then fail closed on resume; bindings are deleted when the plugin is uninstalled. Refreshing an already-owned binding is best effort: a storage error does not hide a completed provider answer, but the binding keeps its previous recency.

A plugin stop or uninstall aborts outstanding sends and closes admission for new host calls during sandbox shutdown. A provider result that arrives after cancellation is reported as failed and cannot recreate a purged session binding.

Before spawning, the host checks the live `agents:dispatch` allowlist for the exact agent ID, separate unattended consent, trusted plugin signature, low/medium Pianola risk verdict, closed parameter schema, and the ActionGuard rate/concurrency/audit gate. The target is resolved against stored agents at execution time. `agents.dispatch` remains an asynchronous desktop dispatch acknowledgment.

## Relay session origin and History

The host attributes `agents.send` calls from the authenticated `sh.maestro.relay`
plugin as `relay`; the plugin cannot supply an origin in its request. The
provider process still runs as unattended Auto Run. Completed authorized turns,
including failed provider results, receive a `RELAY` History entry with the
provider session ID and result status. History persistence errors are logged
without replacing the provider result.

Relay provider sessions carry a Relay badge in the session browser. The host
preserves that provenance when a Claude or Codex session is resumed from the
desktop, and retains existing session names and stars. At startup, older
sessions are attributed only when the private binding store proves ownership by
Relay and that exact Maestro agent; ordinary CLI sessions remain unattributed.
This backfill adds origin metadata, not historical turn entries. Existing History
filter selections gain `RELAY` on upgrade; a later explicit deselection persists.

## First-message thread title (Host API 1.21.0)

```ts
maestro.agents.generateTitle(agentId, firstMessage): Promise<string | null>
```

This optional call runs Maestro's tab naming prompt, cheap turn settings, and title parser once on a bounded first message (maximum 4,096 characters). It uses a fresh ephemeral provider process without resuming or recording a conversation, and returns `null` if generation fails. The host resolves the provider, working directory, and active authentication configuration from the permitted Maestro agent ID. It applies the same `agents:dispatch` allowlist, unattended consent, trust, risk, and ActionGuard checks as `agents.send`. Plugin shutdown cancels the naming process. Relay can feature-detect this method while retaining `minHostApi: "1.20.0"` for its base progress integration.

## Outgoing plugin tools

```ts
maestro.tools.register('send', async (args, context) => {
	// context.callerAgentId: string | null
});
```

The host gives the MCP bridge a random, short-lived run proof when it actually starts a local agent. It writes the proof to an owner-only temporary file and puts only the path in the MCP server config, because providers may filter inherited environment variables. The bridge sends the proof outside the model's tool JSON. The main process resolves it to the agent ID and forwards `{ callerAgentId }` through the manager and sandbox as the handler's frozen second argument. A missing, expired, or revoked proof yields `null`. Neither `args.agentId` nor `mcp serve --tab` can establish the caller identity. The host audits tool ID and verified agent ID, without message text or credentials. The plugin must reject `null` for an identity-sensitive send and enforce channel ownership and Pianola's explicit cross-channel grants itself.

A desktop run proof expires after one hour even if the turn is still running. A later tool call from that turn then receives `callerAgentId: null`; the plugin must reject an identity-sensitive send.

For a CLI headless run that explicitly requests a tool receipt, the host arms
only that namespaced tool ID on the new run proof. After the sandbox returns a
successful tool result, the host records only its nonempty numeric
`messageIds`, the actual tool ID, the verified agent ID, and a random run ID
distinct from the secret proof. It does not record tool arguments, message
text, credentials, or unrelated tool results. The receipt is read before the
proof is revoked and is returned only to the authenticated local CLI request.
`maestro-cli send --require-tool-receipt sh.maestro.relay/send` exits successfully
only when the provider succeeds, the tool remains active, and this run has a
matching receipt. The ordinary `send` response and plugin `agents.send` API
are unchanged. A failed run can still carry a receipt for a send completed
before the failure; do not automatically retry without examining it.

Local Claude API-mode and Codex desktop, Cue, and desktop-backed `maestro-cli send` runs receive the verified MCP config. Claude's interactive maestro-p path is excluded because its Node argv cannot accept the config flag. Cue runs use their configured Maestro agent ID and a distinct provider session. `maestro-cli send` uses a host runner when the desktop plugin service is available; the WebSocket must be both loopback and authenticated with the CLI's per-boot secret. The standalone fallback remains available when that verb is unsupported by an older desktop. A dropped connection after submitting a run is reported as an error instead of starting a duplicate local run. SSH agents receive no local MCP bridge because the desktop discovery socket is not reachable there. Other providers remain unverified and receive no automatic MCP injection.

The proof is scoped to the local same-user process boundary. A model with full shell access can act as that OS user and may read its own proof file; this mechanism authenticates plugin tool calls, not arbitrary local commands by that user. The plugin must still enforce its target policy. A bridge whose desktop connection fails reports tool-call errors. No Discord delivery is implied by a model's own prose.

## Token storage

`maestro.storage.set` writes the plugin's private KV data to `<userData>/plugin-data/<pluginId>/store.json`. On POSIX, the base/plugin directories are owner-only (`0700`), new temporary and replacement files are owner-only (`0600`), and old stores are hardened before reading. Unsafe symlinks are rejected. Windows applies the platform's file ACL behavior; POSIX mode bits are not an access-control mechanism there. The token remains plaintext for the local user and should never be copied into global `shellEnvVars`, prompts, logs, or the plugin panel response.

The Relay plugin must set `minHostApi: "1.20.0"` to rely on `onProgress` and declare `agents:dispatch` plus its existing network, storage, and tool contributions. This host change does not enable plugins, grant permission, install Relay, or configure a Discord bot.

## Backstage setup and update surfaces

This host package includes the Backstage prerequisites: settings panels inside each
extension's Settings tab, the isolated theme bridge, and the packaged `undici`
runtime used by pinned network requests. Relay's plugin implementation and Discord
credentials remain in Backstage and the user's private plugin store.

The Extensions update action and `maestro-cli plugin update <directory>` use the
same `plugins:update` handler and PluginManager. Updating preserves plugin data;
it never approves new permissions. `maestro-cli plugin list --json` reads the
resulting versions, enable state, signature and load status. A same-signer update
retains the exact Dispatch selection, but Dispatch and Unattended require renewed
consent for the new code identity. Enabling before that consent fails.

The host re-authorizes a completed send before returning text or storing a provider
session, including providers that emitted no progress. Run tokens are revoked
before proof-file removal, so a filesystem cleanup error cannot retain authority.
