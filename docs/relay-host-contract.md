# Relay host contract (Host API 1.17.0)

This is the Maestro host half of the Relay Discord integration. The Discord gateway, token UI, channel ownership, per-thread session mapping, and Pianola exceptions belong to the Relay plugin, not the host. The host never receives the bot token as a setting or agent environment variable.

## Incoming Discord thread

An enabled, trusted plugin may call:

```ts
maestro.agents.send(agentId, prompt, { sessionId?: providerSessionId })
  -> Promise<{ success: boolean; response: string | null;
                sessionId: string | null; error?: string }>
```

With no `sessionId`, the host starts a fresh headless provider session. With one, it passes that opaque provider session ID to the provider's resume path. `sessionId` in the result is a **provider session ID**, not a desktop tab ID or Maestro agent ID. The plugin stores one ID per Discord thread and only saves a new ID after `success: true`. A failed run has `response: null`, may carry a provider ID for diagnostics, and must not be posted as a successful answer. The host runs different threads independently. The `agents:dispatch` ActionGuard limits one plugin to two concurrent high-risk actions; additional calls fail clearly and may be queued by the plugin. The provider process has a 20-minute timeout. Disabling, crashing, or uninstalling the plugin aborts its outstanding `agents.send` processes.

The host also records every successful provider session ID in a private persistent binding store under `<userData>/plugin-agent-sessions/`. A resume is allowed only for the same plugin and Maestro agent that received the ID; knowing another agent's provider ID is insufficient. These bindings survive a desktop restart and are deleted when the plugin is uninstalled.

Before spawning, the host checks the live `agents:dispatch` allowlist for the exact agent ID, separate unattended consent, trusted plugin signature, low/medium Pianola risk verdict, closed parameter schema, and the ActionGuard rate/concurrency/audit gate. The target is resolved against stored agents at execution time. `agents.dispatch` remains an asynchronous desktop dispatch acknowledgment.

## Outgoing plugin tools

```ts
maestro.tools.register('send', async (args, context) => {
	// context.callerAgentId: string | null
});
```

The host gives the MCP bridge a random, short-lived run proof when it actually starts a local agent. It writes the proof to an owner-only temporary file and puts only the path in the MCP server config, because providers may filter inherited environment variables. The bridge sends the proof outside the model's tool JSON. The main process resolves it to the agent ID and forwards `{ callerAgentId }` through the manager and sandbox as the handler's frozen second argument. A missing, expired, or revoked proof yields `null`. Neither `args.agentId` nor `mcp serve --tab` can establish the caller identity. The host audits tool ID and verified agent ID, without message text or credentials. The plugin must reject `null` for an identity-sensitive send and enforce channel ownership and Pianola's explicit cross-channel grants itself.

Local Claude API-mode and Codex desktop, Cue, and desktop-backed `maestro-cli send` runs receive the verified MCP config. Claude's interactive maestro-p path is excluded because its Node argv cannot accept the config flag. Cue runs use their configured Maestro agent ID and a distinct provider session. `maestro-cli send` uses a host runner when the desktop plugin service is available; the WebSocket must be both loopback and authenticated with the CLI's per-boot secret. The standalone fallback remains available when that verb is unsupported by an older desktop. A dropped connection after submitting a run is reported as an error instead of starting a duplicate local run. SSH agents receive no local MCP bridge because the desktop discovery socket is not reachable there. Other providers remain unverified and receive no automatic MCP injection.

The proof is scoped to the local same-user process boundary. A model with full shell access can act as that OS user and may read its own proof file; this mechanism authenticates plugin tool calls, not arbitrary local commands by that user. The plugin must still enforce its target policy. A bridge whose desktop connection fails reports tool-call errors. No Discord delivery is implied by a model's own prose.

## Token storage

`maestro.storage.set` writes the plugin's private KV data to `<userData>/plugin-data/<pluginId>/store.json`. On POSIX, the base/plugin directories are owner-only (`0700`), new temporary and replacement files are owner-only (`0600`), and old stores are hardened before reading. Unsafe symlinks are rejected. Windows applies the platform's file ACL behavior; POSIX mode bits are not an access-control mechanism there. The token remains plaintext for the local user and should never be copied into global `shellEnvVars`, prompts, logs, or the plugin panel response.

The Relay plugin must set `minHostApi: "1.17.0"` and declare `agents:dispatch` plus its existing network, storage, and tool contributions. This host change does not enable plugins, grant permission, install Relay, or configure a Discord bot.
