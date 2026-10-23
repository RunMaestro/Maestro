# Relay host contract (Host API 1.31.0)

## Desktop conversation continuity (1.31.0)

Version allocation follows the open API1.29 generic-platform PR1881 and API1.30
bounded-audio PR1883. This focused rc diff does not implement those preceding
contracts. Integrate and qualify their documented prerequisites before releasing
an API1.31 host; semver comparison alone is not runtime completeness enforcement.
No installer or live archive activation is part of this change.

The trusted, pinned Relay may call `agents.send(agentId, prompt, { conversationId,
messageId, sessionId?, onProgress? })`. `conversationId` is its persistent real
transport thread identity; `messageId` is the incoming transport message identity.
Both are opaque strings of 1–256 characters and must be supplied together.
`agentId` names the Maestro agent, `sessionId` remains the opaque provider session,
and the returned `tabId` names the real desktop tab. None is an outbound grant.

The host owns the persistent conversation→tab/provider mapping and execution
receipts, separate from plugin-writable storage. Each conversation has one real
background tab with user/assistant text, durable Relay origin, and queued/running/
idle/error state. It does not change navigation. Desktop and Relay turns share a
host writer reservation through process close; the renderer's normal queue still
decides desktop ordering. A duplicate message returns the saved result with
`replayed: true`; the plugin **must not send another transport response**. An
interrupted receipt fails closed, because tools may already have run. A changed
prompt under the same message identity is rejected. No automatic retry is safe.

At activation, Relay can register its explicitly stored real thread bindings with
`agents.restoreConversation(agentId, { conversationId, sessionId })`. The host
requires existing private provider ownership, the pinned Relay signer, exact-agent
grant and unattended consent. This reads the provider transcript and creates a
background tab without a provider turn. Existing archived tabs and deliberate
manual closes stay closed. Generic automation, consults and ambiguous old
provider bindings are never materialized by this API. Without the new identity
options, `agents.send` retains its existing headless behavior.

`agents.completeConversation(agentId, { conversationId, messageId })` records an
**explicit task completion** only for the latest successfully finished message,
with no pending Relay/desktop work or newer desktop input. An idle provider is
not completion evidence. A later message clears completion and reveals the same
tab. Relay must only invoke this method from a verified task completion source
(for example an authorized user's explicit `/done`), never from assistant prose.

Settings → General → Relay conversation archive controls the inactivity period
(`relayArchiveHours`, default 24, 0 disables). The owning desktop hides a tab only
after explicit task completion and inactivity, protecting running/queued work,
bookmarks, stars, saved selection, unread messages, drafts and tiled tabs. Hiding
retains the tab, transcript and provider history; History/Resume reveals it again.
An app restart marks interrupted work as an error rather than completed. No
existing desktop or automation tab is eligible without explicit Relay mapping.

Tests are synthetic source-level acceptance. They do not establish live Discord,
installed-host/plugin compatibility, or authorization for production activation.

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

With no `sessionId`, the host starts a fresh headless provider session. With one, it passes that opaque provider session ID to the provider's resume path. `sessionId` in the result is a **provider session ID**, not a desktop tab ID or Maestro agent ID. The plugin stores one ID per Discord thread and only saves a new ID after `success: true`. A failed run has `response: null`, may carry a provider ID for diagnostics, and must not be posted as a successful answer. The host runs different threads independently. Host API 1.25.0 / SDK 0.19.0 extend rc's 1.24.0 / 0.18.0 contracts; the media job API, independent Settings cards, and service broker remain available. The `agents:dispatch` ActionGuard limits one plugin to two concurrent high-risk actions; additional calls fail clearly and may be queued by the plugin. The provider process has a 60-minute timeout. Run-token and MCP proof-file lifetimes, and the desktop-backed CLI send reply wait, are 61 minutes (the run budget plus one minute for completion). Codex must emit structured model activity (text/reasoning, a tool event, or usage) within 120 seconds of spawn; init/turn-start messages and unstructured stdout/stderr do not disable this startup deadline. A startup failure returns `success: false`, `response: null`, and an error describing a possible auth/keyring block and how to retry after repairing login. The host does not inspect credentials or change the configured credential store. Timeout/cancellation force-kills the local process tree through the shared ownership-aware Stop ladder and releases the caller after at most a five-second wait even if `close` never arrives. After model activity the full 60-minute run budget remains in effect. SSH teardown terminates the local SSH process tree; remote process cleanup still depends on the remote transport. Do not automatically retry a run that may have performed tool work. These deadlines share the constants in `src/shared/plugins/headless-agent-timeouts.ts`; completed or cancelled runs revoke their proof immediately. Disabling, crashing, or uninstalling the plugin aborts its outstanding `agents.send` processes.

The host also records successful provider session IDs in a private persistent binding store under `<userData>/plugin-agent-sessions/`. A resume is allowed only for the same plugin and Maestro agent that received the ID; knowing another agent's provider ID is insufficient. The 10,000 most recently used bindings per plugin survive a desktop restart. Older bindings are evicted as new sessions arrive and then fail closed on resume; bindings are deleted when the plugin is uninstalled. Refreshing an already-owned binding is best effort: a storage error does not hide a completed provider answer, but the binding keeps its previous recency.

A plugin stop or uninstall aborts outstanding sends and closes admission for new host calls during sandbox shutdown. A provider result that arrives after cancellation is reported as failed and cannot recreate a purged session binding.

Before spawning, the host checks the live `agents:dispatch` allowlist for the exact agent ID, separate unattended consent, trusted plugin signature, closed parameter schema, and the ActionGuard rate/concurrency/audit gate. Plugins without the exact pinned Relay conversation identity and all `agents.dispatch` calls additionally require a low/medium Pianola risk verdict. The target is resolved against stored agents at execution time. `agents.dispatch` remains an asynchronous desktop dispatch acknowledgment.

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

## Live activity and conversation provenance

Relay origin remains durable conversation metadata. Reopening a conversation in
History or Quick Chat carries its origin into the tab, whose Relay badge remains
visible while idle, running, and after reload. This does not create a desktop tab
for a headless conversation.

The host separately counts started headless provider processes per target agent.
Preparation, plugin queues, and waiting for the next message do not count. Each
run releases only its own activity on completion, failure, timeout, or cancellation;
plugin shutdown uses the existing cancellation path. Duplicate or late start
callbacks cannot revive a settled run. Sidebar indicators combine this transient
signal with desktop activity without changing the active desktop tab or persisting
a synthetic busy state. The existing host busy probe, web agent status, and plugin
session metadata also include headless work; desktop tab status remains tab-scoped.
Renderer reloads fetch a versioned snapshot, so an older snapshot cannot overwrite
a newer activity event.

No plugin-supplied status mutation or additional SDK method is needed: the target
continues to come from authorized `agents.send(agentId, ...)`. Existing dispatch,
unattended consent, trusted Relay identity, and provider ownership checks apply.

## First-message thread title (Host API 1.25.0)

```ts
maestro.agents.generateTitle(agentId, firstMessage): Promise<string | null>
```

This optional call runs Maestro's tab naming prompt, cheap turn settings, and title parser once on a bounded first message (maximum 4,096 characters). It uses a fresh ephemeral provider process without resuming or recording a conversation, and returns `null` if generation fails. The host resolves the provider, working directory, and active authentication configuration from the permitted Maestro agent ID. It applies the `agents:dispatch` allowlist, unattended consent, trust, low/medium topic risk ceiling, and ActionGuard checks. The conversation exception does not apply to title generation. Plugin shutdown cancels the naming process. Relay can feature-detect this method while retaining `minHostApi: "1.25.0"` for its base progress integration.

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
Collection is bounded to 16 receipts per run. Reaching the limit preserves
the recorded receipts and stops further collection. An overflow fails the
required receipt check with an explicit error while returning the retained
evidence; this bounded list is
not an exhaustive delivery log for a run that exceeds that limit.

Local Claude API-mode and Codex desktop, Cue, and desktop-backed `maestro-cli send` runs receive the verified MCP config. Claude's interactive maestro-p path is excluded because its Node argv cannot accept the config flag. Cue runs use their configured Maestro agent ID and a distinct provider session. `maestro-cli send` uses a host runner when the desktop plugin service is available; the WebSocket must be both loopback and authenticated with the CLI's per-boot secret. The standalone fallback remains available when that verb is unsupported by an older desktop. A dropped connection after submitting a run is reported as an error instead of starting a duplicate local run. SSH agents receive no local MCP bridge because the desktop discovery socket is not reachable there. Other providers remain unverified and receive no automatic MCP injection.

The proof is scoped to the local same-user process boundary. A model with full shell access can act as that OS user and may read its own proof file; this mechanism authenticates plugin tool calls, not arbitrary local commands by that user. The plugin must still enforce its target policy. A bridge whose desktop connection fails reports tool-call errors. No Discord delivery is implied by a model's own prose.

## Token storage

`maestro.storage.set` writes the plugin's private KV data to `<userData>/plugin-data/<pluginId>/store.json`. On POSIX, the base/plugin directories are owner-only (`0700`), new temporary and replacement files are owner-only (`0600`), and old stores are hardened before reading. Unsafe symlinks are rejected. Windows applies the platform's file ACL behavior; POSIX mode bits are not an access-control mechanism there. The token remains plaintext for the local user and should never be copied into global `shellEnvVars`, prompts, logs, or the plugin panel response.

The Relay plugin must set `minHostApi: "1.25.0"` to rely on `onProgress` and declare `agents:dispatch` plus its existing network, storage, and tool contributions. This host change does not enable plugins, grant permission, install Relay, or configure a Discord bot.

## Backstage setup and update surfaces

This host package includes the Backstage prerequisites: independent plugin Settings cards linked from each
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

## Supported return flow

For delegated results, return the worker's result to the **originating authorized agent** run. That run calls the
currently advertised Relay MCP tool with the report text and an existing
permitted destination. It returns the real tool result, including nonempty
`messageIds`, to its caller. A headless origin can receive the result through
the synchronous `maestro-cli send` response; it has no desktop callback tab.
Do not lend a run proof to a worker or put an originator ID in tool arguments.

For scheduled shell reports, keep the script's status and report text
deterministic. A downstream Cue `agent.completed` subscription can select the
specific shell subscription using `source_session_ids` and `source_sub`, and
pass `{{CUE_SOURCE_STATUS}}` / `{{CUE_SOURCE_OUTPUT}}` to an authorized **agent prompt**. The shell step itself cannot call Relay. A manual shell
orchestrator can instead call `maestro-cli send` for the same stored authorized agent and inspect its JSON response. In both cases the agent must call
the live advertised plugin tool, and the caller must require actual returned
`messageIds`. If the tool is absent or rejects the destination, report failure;
do not infer delivery from prose.

The source now supports:

```bash
maestro-cli send <origin-agent> <prompt> --require-tool-receipt sh.maestro.relay/send
```

This implies
`--require-plugin-tools`, names the exact host tool contribution, and requires
a successful call observed on that run's proof. The CLI JSON adds
`toolReceipts: [{ runId, agentId, toolId, messageIds }]`. A zero exit status
requires a successful provider run, the requested tool still active, and a
matching receipt with nonempty numeric Discord IDs. Final provider prose is
never parsed as a receipt. The random `runId` is separate from the secret
proof. A nonzero result may still carry IDs from a completed send before a
later provider failure, so a caller must inspect them before retrying.

For a deterministic consumer, pass the full stored origin agent ID, capture
stdout as JSON, and require process exit 0 plus `success: true`. Check top-level
`agentId` is the origin, then select a `toolReceipts` entry whose `agentId`
equals that origin, `toolId` equals `sh.maestro.relay/send`, `runId` is a
32-character lowercase hex string, and `messageIds` is a nonempty array of
Discord numeric ID strings. Store those IDs with the report's own key before
marking it delivered. `sh_maestro_relay__send` is the MCP callable name to
discover inside the agent run; `sh.maestro.relay/send` is the host contribution
ID passed to this CLI guard. On a nonzero exit, inspect any receipts before
deciding whether retrying could duplicate a completed send.

`--require-plugin-tools` requires a local, verified MCP injection mode and refuses standalone, SSH, unverified providers and Claude interactive/dynamic runs before spawning. It does not prove delivery; use the exact receipt guard for that.

## Conversation transport boundary

Only `agents.send` from the exact host-known `sh.maestro.relay` caller with a verified `trusted` signature by `RELAY_PUBLISHER_KEY` in `src/shared/plugins/relay-identity.ts` transports an authorized conversation without the free-text topic ceiling. The pinned public ed25519 key matches the signed Backstage Relay distribution; adding another publisher to `pluginTrustedKeys` cannot grant this exception. Key rotation requires a reviewed host update and a correspondingly signed Relay distribution; the pin does not itself grant trust or consent.

The host preserves the original question, full Relay wrapper, response and configured provider execution mode. The closed schema, exact-agent grant, unattended consent, provider-session ownership, live grant/trust checks, cancellation, progress and ActionGuard audit/rate/concurrency gates remain mandatory. A caller cannot supply `force`, `skipRisk`, origin or execution permission options. Identity is rechecked on progress and before releasing a result or recording session ownership; publisher revocation suppresses late results.

The only reply exception is the declared `sh.maestro.relay/send` tool with matching plugin/local IDs, the same live pinned publisher identity, and a valid host-issued caller proof. Tool arguments do not authenticate the caller. Relay still enforces sender, guild, bound parent channel/thread, outbound policy, target metadata and disabled mentions; network delivery remains brokered. A host-observed receipt correlates the proof's agent/run/tool and nonempty message IDs. Provider prose alone is not delivery evidence.

Other plugins, other Relay tools, `agents.dispatch`, title generation, Cue/scheduler, Pianola and `process.spawn` retain their existing topic ceilings. The legacy blocked-path error remains `high-risk prompt: auto-dispatch blocked, surfaced for review`, which Relay maps to `risk-blocked`. No SDK/API schema or version is changed.

### Paired source verification

With dependencies installed in Maestro and a compatible Backstage checkout containing `plugins/relay/src/outbound.ts` and `message-queue.ts`, run:

```bash
node scripts/verify-relay-reply-path.mjs /path/to/backstage-checkout
```

Replace the example path with your checkout. This supported developer fixture bundles both sources only in memory. It connects the real source MCP bridge to host handlers over an ephemeral authenticated loopback WebSocket and uses Backstage's real outbound and queue logic with synthetic bindings and a fake Discord sink. It verifies unchanged reply text, disabled mentions, host-observed receipts, proof/publisher/destination denials and the legacy error mapping. Backstage is read-only. It makes no external network calls, provider turns or live Discord sends and supplies no current installer/package acceptance.
