# Relay outbound host audit (2026-10-05)

This audit covers the host source in this checkout and a read-only check of the
installed Relay. It does not activate a plugin, send a Discord message, change
the Obsidian vault or user service, or package/install a host build.

## Provisioning and identity

| Run                                                                                | Host path                                                                                                                         | Verified Relay tool access                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Codex desktop turn                                                           | `src/main/ipc/handlers/process/handle-spawn.ts` → `buildMcpInjection`                                                             | When plugins are enabled and tools are active, the host issues a proof for a stored agent and injects `mcp_servers.maestro` before the Codex `exec` arguments. Proof is revoked on exit.     |
| Local Codex Cue **agent prompt**                                                   | `src/main/cue/cue-spawn-builder.ts` → `buildMcpInjection`                                                                         | The host issues a proof for the Cue session's configured agent and revokes it in `cue-executor.ts`. The run has its own provider session.                                                    |
| Desktop-backed headless `maestro-cli send`                                         | `src/cli/commands/send.ts` → authenticated loopback `plugins_send_agent` → `plugin-headless-agent-runner.ts` → `agent-spawner.ts` | The host resolves the stored target agent, issues its run proof and injects Codex MCP config. The caller receives the provider result on CLI stdout; no desktop tab or callback is required. |
| Standalone CLI fallback, SSH, unverified providers, Claude interactive `maestro-p` | No supported local proof-backed bridge                                                                                            | Do not use for identity-sensitive Relay sends.                                                                                                                                               |
| Cue `action: command`, `command.mode: shell`                                       | `src/main/cue/cue-shell-executor.ts`                                                                                              | A shell command has no model MCP bridge or verified agent identity, even if its subscription has `agent_id`. It must pass its report to a supported agent run.                               |

The MCP bridge passes its proof outside tool arguments. `plugins_call_tool` in
`src/main/web-server/handlers/messageHandlers/plugins.ts` resolves the proof and
passes `callerAgentId` to the plugin. The Relay sender rejects a null identity
and checks the bound channel/thread or an explicit Pianola grant. Neither
`--tab` nor `args.agentId` establishes identity. A successful provider final
answer, dispatch acknowledgement, or desktop callback is not a Discord receipt.

## Supported return flow

For delegated results, return the worker's result to the **originating Obsidian
Codex** run (`76fd8ebe-7346-4db0-8799-edcd03071bb2`). That run calls the
currently advertised Relay MCP tool with the report text and an existing
permitted destination. It returns the real tool result, including nonempty
`messageIds`, to its caller. A headless origin can receive the result through
the synchronous `maestro-cli send` response; it has no desktop callback tab.
Do not lend a run proof to a worker or put an originator ID in tool arguments.

For scheduled shell reports, keep the script's status and report text
deterministic. A downstream Cue `agent.completed` subscription can select the
specific shell subscription using `source_session_ids` and `source_sub`, and
pass `{{CUE_SOURCE_STATUS}}` / `{{CUE_SOURCE_OUTPUT}}` to an Obsidian Codex
**agent prompt**. The shell step itself cannot call Relay. A manual shell
orchestrator can instead call `maestro-cli send` for the same stored Obsidian
Codex agent and inspect its JSON response. In both cases the agent must call
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

`--require-plugin-tools` remains available as the less specific guard: it
refuses the standalone fallback but does not prove a Relay send. The installed
CLI has neither source option until a separately authorized, packaged host
update. Backstage can draft script migration against this contract now, but
must not execute it against the installed CLI.

## Current activation and migration blocks

- Read-only `plugin list` reports `sh.maestro.relay` 0.0.13, trusted and
  `loadStatus: ok`, with `enabled: false`. A fresh MCP initialize and
  `tools/list` returned `tools: []`. The manifest calls the tool
  `relay_send_discord`; `sh_maestro_relay__send` was its prior callable MCP
  name. Rediscover the name after consent rather than assuming it is live.
- Changed plugin bytes require Chris to enable Relay and confirm the protected
  permission window, including the previously intended Dispatch allow list and
  separate Unattended choice. Do not broaden grants. There is no current
  `MAESTRO_PLUGIN_RUN_TOKEN_FILE` in this audit shell and no reporting Pianola
  agent. No authenticated Obsidian send or Discord `messageIds` were obtained.
- The Obsidian vault's `AGENTS.md`, `.maestro/cue.yaml`, seven active HTTP
  sender scripts (`check-daily-artifacts.py`, `check-cli-updates.py`,
  `check-claude-tokens.py`, `reap-orphan-mcp.py`, `health-log-helper.py`,
  `local_llm.py`, `docker-cc-health-check.sh`), and the dependent
  `local-summary.py` still need migration. Preserve each schedule and
  notification condition. The vault and user-systemd write override is
  pending, so none of those files was edited.
- `maestro-relay.service` remains enabled/failed with exit status 203 and port
  3457 has no listener. Its retirement requires the pending external write
  scope. Do not use the legacy HTTP daemon or raw Discord REST meanwhile.
- No local test package was created. Any later host handoff must first combine
  the latest RC and the user's PR heads **locally only**, document the exact
  revisions, and verify the affected feature in the packaged build before
  installation is proposed. No release, push, or upstream merge is part of
  this audit.

## Source verification

Focused Vitest suites for CLI send, Cue spawn, headless runner, run identity
and WebSocket plugin handlers passed. CLI and main TypeScript no-emit checks
passed. The receipt tests cover exact proof/agent/tool correlation, unrelated
and malformed results, model-only IDs, risk-blocked and rejected calls,
deactivation, expiry, and provider failure. These are source tests, not a
live Discord delivery test.

## Post-RC live diagnosis (2026-10-05)

The installed Host and CLI both report `0.18.9-RC`; Relay `0.0.14` is
trusted, loadable and enabled. `encoreFeatures.plugins` is true. The installed
Relay private settings contain a Pianola outbound policy for the stored
Obsidian Codex agent with two allowed channel IDs. No credential was read or
changed for this audit.

The receipt-required Obsidian Claude run
`run_cli-send_1791186640221_8d6f246d` failed after 9.1 seconds; the next
Claude diagnostic run failed after 7.9 seconds. Both provider transcripts
contain `authentication_failed: Failed to authenticate: OAuth session expired
and could not be refreshed` before any model action. `claude auth status --json`
currently reports `loggedIn: false`. The stored Obsidian Claude agent is local
with `enableMaestroP: false`, so source routing selects Claude API mode and
the ephemeral `--mcp-config` injection. Re-authentication by Chris is needed
before another Claude provider turn can prove tool availability. Do not retry
the report blindly; there are no observed receipt IDs from these runs.

The Obsidian Codex diagnostic run completed, but its tool-catalog check found
no Relay callable in that run. Host-side MCP initialization plus `tools/list`,
using both Node and the installed Electron binary with `ELECTRON_RUN_AS_NODE=1`,
advertised `sh_maestro_relay__send`. Codex CLI `0.159.0` also accepted the
Host's `-c mcp_servers.maestro.*` config shape via `codex mcp list --json`.
The provider transcript has no MCP startup error or actual spawn argv, so
this evidence does not establish whether that particular run loaded the
ephemeral server into Codex's exposed tool catalog. Its catalog result must
not be treated as proof that Relay itself is disabled.

One definite Host diagnostic bug was fixed in this checkout: a
`--require-tool-receipt` run without a receipt previously replaced an earlier
provider failure with the generic missing-receipt error. The handler now
preserves the provider failure while still returning `success: false` and no
receipt. Its regression test, the full WebSocket handler suite (298 tests),
main TypeScript no-emit check, Prettier and `git diff --check` pass. This
source fix is not installed; it changes error reporting only, not delivery.

Next safe sequence: Chris restores Claude authentication; then perform a
fresh no-send tool-catalog diagnostic for the chosen originator and capture
the full CLI JSON and MCP startup diagnostics. If Codex still lacks
`mcp__maestro__sh_maestro_relay__send`, inspect that run's effective spawn
arguments and MCP startup result before changing provider injection. Only
after tool presence and the destination binding are verified should Chris
authorize one controlled delivery attempt. Require a host-observed receipt
with nonempty `messageIds`; do not use the legacy HTTP path or infer delivery
from provider prose. Installation or restart of a rebuilt Host remains a
separate Chris decision.
