# Relay outbound host audit (2026-10-05)

This audit describes host provisioning and authenticated Relay receipt boundaries. Verification uses synthetic targets and network sinks.

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

Return delegated results through the originating authorized agent with its own host-issued proof. The canonical [receipt and retry contract](relay-host-contract.md#supported-return-flow) specifies provider, tool, run and destination correlation.

## Source verification

Focused Vitest suites for CLI send, Cue spawn, headless runner, run identity
and WebSocket plugin handlers passed. CLI and main TypeScript no-emit checks
passed. The receipt tests cover exact proof/agent/tool correlation, unrelated
and malformed results, model-only IDs, risk-blocked and rejected calls,
deactivation, expiry, and provider failure. These are source tests, not a
live Discord delivery test.
