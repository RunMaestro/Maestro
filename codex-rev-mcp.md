**Findings**

1. **High - Unmapped MCP tool names can invoke non-tool plugin handlers. Confidence: high.**  
   [src/cli/services/mcp-bridge.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/cli/services/mcp-bridge.ts:97) falls back to `name` when no `tools/list` mapping exists. [messageHandlers.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/main/web-server/handlers/messageHandlers.ts:4916) then accepts that caller-supplied `toolId`, and [plugin-manager.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/main/plugins/plugin-manager.ts:440) only splits `<plugin>/<local>` before calling the sandbox. In the sandbox, commands and tools share the same handler map: [plugin-sandbox-entry.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/main/plugins/plugin-sandbox-entry.ts:162) and [plugin-sandbox-entry.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/main/plugins/plugin-sandbox-entry.ts:303). A model/client can call `plugin/private-command` or any registered command handler if it guesses the local id, bypassing the advertised tool list and the intended name-to-toolId reverse map.

2. **High - The risk gate is text-only, so high-risk tool capability can auto-execute if the toolId/args look benign. Confidence: medium-high.**  
   The bridge gates on `evaluatePluginDispatch(`${toolId} ${argText}`)` at [messageHandlers.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/main/web-server/handlers/messageHandlers.ts:4926), before [messageHandlers.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/main/web-server/handlers/messageHandlers.ts:4939) invokes the broker. That gate is regex text classification over the tool name/JSON args ([plugin-dispatch-gate.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/shared/plugins/plugin-dispatch-gate.ts:33), [pianola-risk.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/shared/pianola/pianola-risk.ts:37)). The tool manifest has no risk class or confirmation policy ([contributions.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/shared/plugins/contributions.ts:146), [contributions.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/shared/plugins/contributions.ts:640)). A destructive plugin tool named `run` with innocuous args would pass as low/medium and execute automatically. This does not satisfy the invariant that high-risk model-initiated tool calls must not auto-execute.

3. **Medium - Invalid JSON on MCP stdin is silently dropped instead of returning JSON-RPC parse errors. Confidence: high.**  
   [mcp.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/cli/commands/mcp.ts:54) catches `JSON.parse` failures and only logs to stderr at [mcp.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/cli/commands/mcp.ts:58). For JSON-RPC stdio, malformed request frames should produce a `-32700` response with `id: null`. Silent drop can make MCP clients hang and is a protocol-conformance gap.

4. **Low - MCP lifecycle is not enforced before tool calls. Confidence: medium.**  
   `createMcpToolServer` has no initialized state; `tools/list` and `tools/call` are accepted directly in the switch ([mcp-protocol.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/shared/plugins/mcp-protocol.ts:116), [mcp-protocol.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/shared/plugins/mcp-protocol.ts:130), [mcp-protocol.ts](/C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/shared/plugins/mcp-protocol.ts:140)). Well-behaved clients initialize first, but the server does not enforce the MCP lifecycle.

**Greptile-Readiness Score**

**3/5.** The bridge has the right broad architecture: stdout discipline is mostly respected, local SSH injection is gated, verified adapters are the only auto-injected ones, and name de-collision exists. The security boundary around callable tool identity and high-risk execution is not tight enough for 5/5.

**Blocks 5/5**

- Reject any `tools/call` name that is not present in the current MCP name-to-toolId map; remove the raw-name fallback.
- Validate `toolId` against `manager.getContributions().tools` immediately before invoking the sandbox.
- Separate plugin command handlers from tool handlers, or otherwise prove only contributed tools are reachable via `invokeTool`.
- Add manifest/tool-level risk metadata or a broker policy that can block inherently high-risk tools independent of textual args.
- Return proper JSON-RPC parse errors for malformed stdin frames.
- Add tests for unmapped tool call rejection, unadvertised command non-invocation, risk policy around high-risk tools with benign args, and malformed JSON-RPC framing.
