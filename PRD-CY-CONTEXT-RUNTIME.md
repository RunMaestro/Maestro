# PRD: Cy Context Runtime Engine — Maestro Integration via Claude Code Protocol Impersonation

**Version**: 2.0  
**Date**: 2026-04-14  
**Author**: Ron Eddings / Cy  
**Target**: `/Volumes/VRAM/00-09_System/01_Tools/Maestro`  
**Strategy**: Option A — Set `customPath` in Maestro's agent config to point at a `cy` shim binary that speaks Claude Code's exact stream-json protocol

---

## 1. Executive Summary

Cy has a context runtime engine that manages agent sessions with capabilities no individual CLI tool provides: context hydration/dehydration (artifact persistence), dual-model threading (Claude Code + Codex in a single conversation), structured compaction, and extension-driven context policies. This PRD defines how to expose that engine to Maestro by impersonating Claude Code's CLI protocol — making Maestro believe it's talking to `claude` when it's actually talking to Cy.

**The core insight**: Maestro doesn't care what binary it spawns. It cares about three things:

1. The binary exists at a resolvable path
2. It accepts Claude Code's CLI args (`--print --output-format stream-json --resume <id> -- "prompt"`)
3. It emits JSONL matching `ClaudeOutputParser`'s expected event shapes

Cy already knows both protocols intimately — it spawns Claude Code (`cc-subprocess.ts`) and Codex (`codex-subprocess.ts`) as inference backends. This PRD inverts that relationship: Cy becomes the binary Maestro spawns.

---

## 2. Evidence Base

### 2.1 How Maestro Spawns Claude Code (Grounded in Source)

**Source**: `Maestro/src/main/agents/definitions.ts` lines 96-106

```typescript
{
  id: 'claude-code',
  name: 'Claude Code',
  binaryName: 'claude',
  command: 'claude',
  args: [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
  ],
  resumeArgs: (sessionId: string) => ['--resume', sessionId],
}
```

Maestro's `ChildProcessSpawner.ts` constructs the final command:

```
claude --print --verbose --output-format stream-json --dangerously-skip-permissions [--resume <sessionId>] -- "user prompt"
```

The process is spawned via Node's `child_process.spawn()` with `stdio: ['pipe', 'pipe', 'pipe']`. Stdout is parsed line-by-line as JSONL.

### 2.2 The Stream-JSON Protocol (Grounded in ClaudeOutputParser)

**Source**: `Maestro/src/main/parsers/claude-output-parser.ts`

Maestro expects exactly three JSONL event types:

**Event 1: `system/init`** — emitted once at session start

```json
{
	"type": "system",
	"subtype": "init",
	"session_id": "abc123-uuid",
	"slash_commands": ["/help", "/compact"]
}
```

**Event 2: `assistant`** — streaming partial responses

```json
{
	"type": "assistant",
	"session_id": "abc123-uuid",
	"message": {
		"role": "assistant",
		"content": [
			{ "type": "text", "text": "partial response..." },
			{ "type": "thinking", "thinking": "reasoning..." },
			{ "type": "tool_use", "name": "Read", "id": "tool_1", "input": { "path": "src/index.ts" } }
		]
	}
}
```

**Event 3: `result`** — final response with usage

```json
{
	"type": "result",
	"session_id": "abc123-uuid",
	"result": "Final formatted text output",
	"modelUsage": { "claude-sonnet-4-5-20250929": { "inputTokens": 1200, "outputTokens": 800 } },
	"usage": {
		"input_tokens": 1200,
		"output_tokens": 800,
		"cache_read_input_tokens": 500,
		"cache_creation_input_tokens": 200
	},
	"total_cost_usd": 0.0042
}
```

**Key detail from `ClaudeOutputParser.extractToolUseBlocks()`** (lines 209-227): The parser already extracts `tool_use` content blocks from `assistant` messages and passes them as `toolUseBlocks` in the `ParsedEvent`. This means if Cy emits tool calls as proper `tool_use` blocks (not just text), Maestro's parser will pick them up.

### 2.3 How Maestro Discovers Custom Binaries

**Source**: `Maestro/src/main/agents/definitions.ts`, `Maestro/src/main/agents/detector.ts`

Each agent config supports a `customPath` field:

```typescript
interface AgentConfig {
	customPath?: string; // User-specified custom path
	// ...
}
```

When `customPath` is set, Maestro uses that binary instead of searching PATH for `binaryName`. This is the cleanest integration point — no Maestro source changes needed.

### 2.4 Cy's Existing Protocol Knowledge

**Source**: `cy/engine/providers/cc-subprocess.ts`, `cy/engine/providers/cc-twin-session.ts`

Cy already:

- Fabricates Claude Code JSONL session files (`buildTwinEntries()`) with correct entry shapes
- Parses Claude Code's `stream-json` output format (`handleStreamJsonLine()`)
- Manages twin session UUIDs in SQLite (`resolveTwinUuid()`)
- Renders system prompts with the `<cy-tool>` protocol for tool delegation

**Source**: `cy/engine/providers/codex-subprocess.ts`, `cy/engine/providers/codex-twin-session.ts`

Cy also:

- Fabricates Codex JSONL rollout sessions (`buildCodexTwinEntries()`)
- Parses Codex exec JSONL events (`JsonlChunkParser<CodexExecEvent>`)
- Manages isolated CODEX_HOME directories for subprocess isolation
- Supports dual-mode: single-turn (ephemeral) and multi-turn (resume)

### 2.5 Cy's Context Runtime Primitives

**Source**: `cy/engine/core/agent-session.ts`, `cy/engine/core/agent-loop.ts`, `cy/engine/core/compaction/compaction.ts`

The context runtime provides:

| Primitive        | Source File                | What It Does                                                  |
| ---------------- | -------------------------- | ------------------------------------------------------------- |
| Agent Loop       | `agent-loop.ts`            | Turn loop with steering/follow-up message queues              |
| Session Manager  | `session-manager.ts`       | Tree-structured JSONL persistence with branch/fork/compaction |
| Compaction       | `compaction/compaction.ts` | Structured summarization preserving file-op tracking          |
| Model Registry   | `model-registry.ts`        | Multi-provider model management with API key resolution       |
| Resource Loader  | `resource-loader.ts`       | Skills, prompts, themes, context files, AGENTS.md loading     |
| Extension Runner | `extensions/runner.ts`     | Hook pipeline: before/after tool calls, context transforms    |

### 2.6 Hydrate/Dehydrate System (Context Promotion)

**Source**: `cy/extensions/cy-context-promotion.ts`, `cy/extensions/lib/context-artifacts.ts`, `cy/extensions/lib/context-policies.ts`

Cy's unique context management:

- **Dehydration**: When a tool result exceeds a token threshold (25,600 tokens for read, 2,000 for search), it's persisted as an **artifact** (either inline in session JSONL or as a sidecar file) and replaced in context with a compact **handle**:

  ```
  artifact=read-24080ca6 | tool=read | policy=inline_preview | tokens≈3210 | bytes=13854 | path=src/index.ts

  [first ~220 tokens of preview]

  [raw artifact persisted outside active context]
  Use artifact_read with artifactId="read-24080ca6" to reopen.
  ```

- **Rehydration**: The model calls `artifact_read` with a mode (`preview`, `full`, `range`) to bring exact content back into context on demand.

- **Pinning**: `artifact_pin` keeps specific artifact content live across all future turns (max 5 pinned, 60K token budget).

- **Per-tool policies** (`context-policies.ts`):
  - `inline_full` — small results stay in context verbatim
  - `inline_preview` — medium results get a preview + handle
  - `handle_only` — large results get only a handle

This is invisible to the model — it just sees handles and calls `artifact_read` when it needs exact content. The token savings are significant: a 50KB file read that would consume 12,500 tokens becomes a ~300 token handle.

### 2.7 Dual-Model Threading

**Source**: `cy/engine/providers/cc-subprocess.ts`, `cy/engine/providers/codex-subprocess.ts`

Cy can route individual turns to different model backends within the same conversation:

- **Claude path** (`cc-subprocess.ts`): Spawns `claude --resume <twin-uuid> -p <prompt>` with a fabricated twin JSONL. The subprocess uses Claude Code's blessed identity and Max subscription auth.

- **Codex path** (`codex-subprocess.ts`): Spawns `codex exec resume <twin-uuid> <prompt>` with an isolated CODEX_HOME. Uses Codex CLI's identity and subscription.

Both paths:

1. Rebuild the twin session JSONL from Cy's native session history on every turn
2. Strip native tools from the subprocess (Claude: `--tools ""`, Codex: `--disable shell_tool`)
3. Inject Cy's tools as text-based `<cy-tool>` protocol in the system prompt
4. Parse tool calls from assistant text back into structured `toolCall` content blocks
5. Execute tools locally with Cy's hooks/permissions/extensions

**Model switching within a session**: The model used for each turn is determined by Cy's model registry and can be changed mid-conversation. The session state is model-agnostic — only the inference backend changes.

### 2.8 Bun Runtime for the Shim Binary

**Source**: `/Volumes/VRAM/80-89_Resources/80_Reference/docs/bun/docs/guides/process/spawn.md`

Cy runs on Bun. The shim binary will use:

- `Bun.spawn()` for subprocess management (already used in `codex-subprocess.ts`)
- `Bun.write()` for file output
- `bun:sqlite` for session state (already used in `cc-subprocess.ts`)
- `process.stdout.write()` for JSONL event emission to Maestro

---

## 3. Architecture: The Cy Shim Binary

### 3.1 What Maestro Sees

Maestro config (user sets `customPath` in agent settings):

```
Custom Path: /Volumes/VRAM/00-09_System/01_Tools/cy/bin/cy-claude-shim
```

Maestro spawns:

```
/Volumes/VRAM/00-09_System/01_Tools/cy/bin/cy-claude-shim \
  --print --verbose --output-format stream-json \
  --dangerously-skip-permissions \
  [--resume <session-id>] \
  -- "user prompt here"
```

Maestro sees on stdout:

```jsonl
{"type":"system","subtype":"init","session_id":"cy-session-uuid","slash_commands":["/help","/compact","/codex"]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reading the file..."}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"read","id":"toolu_01","input":{"path":"src/index.ts"}}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Here's what I found..."}]}}
{"type":"result","session_id":"cy-session-uuid","result":"Full response text","usage":{"input_tokens":2400,"output_tokens":1200},"total_cost_usd":0.0084}
```

### 3.2 What Actually Happens Inside

```
Maestro spawns cy-claude-shim
  │
  ├─ Parse Claude Code CLI args (--resume, --print, etc.)
  ├─ Map Maestro session_id → Cy SessionManager
  ├─ Load/create Cy session (JSONL tree, extensions, compaction state)
  ├─ Build system prompt (skills, context files, AGENTS.md, tool schemas)
  ├─ Run Cy agent loop for ONE turn:
  │   ├─ transformContext → dehydrate old tool results (artifact handles)
  │   ├─ convertToLlm → normalize AgentMessage[] to Message[]
  │   ├─ Route to model backend:
  │   │   ├─ Default: cc-subprocess (Claude Code via Max subscription)
  │   │   └─ If /codex prefix: codex-subprocess (Codex CLI)
  │   ├─ Stream assistant response → emit as stream-json JSONL to stdout
  │   ├─ Parse tool calls from response
  │   ├─ Execute tools locally (Cy's tools, hooks, permissions)
  │   ├─ Feed tool results back → continue loop
  │   └─ On agent_end → emit result event
  ├─ Persist session state to Cy's SessionManager
  └─ Exit with code 0
```

### 3.3 Tool Display in Maestro

Maestro's `ClaudeOutputParser` (lines 209-227) already extracts `tool_use` blocks from assistant messages. The shim emits Cy's tool executions as proper `tool_use` content blocks:

```json
{
	"type": "assistant",
	"message": {
		"role": "assistant",
		"content": [
			{ "type": "text", "text": "Let me read that file." },
			{
				"type": "tool_use",
				"name": "read",
				"id": "toolu_01X",
				"input": { "path": "src/engine/core/agent.ts" }
			}
		]
	}
}
```

For tool results (which Claude Code doesn't stream back to Maestro in its native protocol), the shim renders them as formatted assistant text blocks showing the tool name, result preview, and artifact handle if dehydrated:

````json
{
	"type": "assistant",
	"message": {
		"role": "assistant",
		"content": [
			{
				"type": "text",
				"text": "\n📄 **read** → `src/engine/core/agent.ts`\n```typescript\nimport { type AssistantMessage } from '../ai.js';\n// ... (278 lines)\n```\n"
			}
		]
	}
}
````

This renders beautifully in Maestro's markdown renderer as a code block with the tool name as a header.

### 3.4 Model Switching via Slash Commands

Maestro does NOT support `@codex` inline model routing. Model switching is per-agent config. However, the Cy shim can support model switching via **slash commands** — which Maestro DOES support for Claude Code (`supportsSlashCommands: true`).

The shim advertises custom slash commands in the `system/init` event:

```json
{
	"type": "system",
	"subtype": "init",
	"session_id": "cy-uuid",
	"slash_commands": ["/help", "/compact", "/codex", "/claude", "/model"]
}
```

When the user types `/codex solve this bug`, the shim:

1. Parses the `/codex` prefix from the prompt
2. Routes that turn through `codex-subprocess.ts` instead of `cc-subprocess.ts`
3. Streams the response back in Claude's stream-json format

The model switch is per-turn — subsequent prompts without a prefix use the default model.

---

## 4. Implementation Phases

### Phase 1: Shim Binary — Claude Protocol Compatibility (MVP)

**Goal**: Maestro can use Cy as a drop-in replacement for `claude` via `customPath`.

- [ ] Create `bin/cy-claude-shim.ts` — Bun entrypoint
- [ ] Parse Claude Code CLI args: `--print`, `--output-format`, `--resume`, `--dangerously-skip-permissions`, `--verbose`, `--model`, `--permission-mode`
- [ ] Map `--resume <id>` to Cy's `SessionManager.open()`
- [ ] Emit `system/init` JSONL with session_id on startup
- [ ] Run Cy's agent loop for exactly one turn (matching `--print` semantics)
- [ ] Stream `assistant` events to stdout as JSONL during inference
- [ ] Emit `result` event with usage stats and cost on completion
- [ ] Handle `--` prompt separator (extract prompt from positional args)
- [ ] Exit with appropriate codes (0 = success, 1 = error)
- [ ] Verify: set `customPath` in Maestro → Cy processes prompts, Maestro shows output

### Phase 2: Tool Execution Display

**Goal**: Cy's tool calls render visibly in Maestro's output stream.

- [ ] Emit `tool_use` content blocks in `assistant` events for each Cy tool call
- [ ] Emit formatted tool result text blocks showing: tool name, key args, result preview
- [ ] For dehydrated results, emit the artifact handle with preview text
- [ ] Emit `thinking` content blocks when the model produces extended thinking
- [ ] Verify: Maestro displays tool calls inline in the conversation output

### Phase 3: Context Runtime Features

**Goal**: Cy's unique features work through the shim.

- [ ] Hydrate/dehydrate pipeline active (artifacts persist across turns via `--resume`)
- [ ] Auto-compaction triggers when context exceeds threshold
- [ ] Extension hooks fire (cy-context, cy-context-promotion, cy-momentum, etc.)
- [ ] Skills load from Cy's skill directory
- [ ] Context files (AGENTS.md / CLAUDE.md) load from project cwd
- [ ] Session persistence via Cy's JSONL tree (survives Maestro restart)

### Phase 4: Dual-Model Routing

**Goal**: Users can switch between Claude and Codex within a single Maestro session.

- [ ] Implement `/codex` slash command prefix routing
- [ ] Implement `/claude` slash command to switch back
- [ ] Implement `/model` slash command to list available models
- [ ] Route turns through `codex-subprocess.ts` when `/codex` is active
- [ ] Route turns through `cc-subprocess.ts` when `/claude` is active (default)
- [ ] Translate Codex responses back to Claude's stream-json format
- [ ] Verify: `/codex explain this code` routes through Codex, response appears normally in Maestro

### Phase 5: Usage & Cost Tracking

**Goal**: Maestro's usage dashboard shows accurate metrics.

- [ ] Aggregate usage across model backends (Claude + Codex) per session
- [ ] Emit cumulative `modelUsage` in result events matching Claude's format
- [ ] Track cost using Cy's model registry pricing data
- [ ] Emit `total_cost_usd` in result events
- [ ] Verify: Maestro's cost tracking and context window display work correctly

### Phase 6: Session Resume & Discovery

**Goal**: Maestro's session browser can discover and resume Cy sessions.

- [ ] Store Cy session files in Claude Code's expected location (`~/.claude/projects/<slug>/`)
- [ ] OR implement a `CySessionStorage` class extending Maestro's `BaseSessionStorage`
- [ ] Map Cy session IDs to Claude-compatible session IDs
- [ ] Support `--resume` with both Cy-native and Claude-compatible session IDs
- [ ] Verify: Maestro's session browser shows Cy sessions, resuming works

---

## 5. File Manifest

| File                                 | Purpose                                                 |
| ------------------------------------ | ------------------------------------------------------- |
| `bin/cy-claude-shim.ts`              | Bun CLI entrypoint — parses Claude args, runs Cy engine |
| `engine/shim/arg-parser.ts`          | Parse Claude Code CLI arguments into Cy config          |
| `engine/shim/stream-json-emitter.ts` | Convert Cy AgentEvents to Claude stream-json JSONL      |
| `engine/shim/session-bridge.ts`      | Map Maestro session IDs ↔ Cy SessionManager             |
| `engine/shim/tool-renderer.ts`       | Render Cy tool calls as tool_use blocks + result text   |
| `engine/shim/slash-commands.ts`      | Handle /codex, /claude, /model prefix routing           |

---

## 6. Risks & Mitigations

| Risk                                      | Impact                           | Mitigation                                                                     |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| Claude Code protocol changes              | Shim breaks silently             | Pin to known protocol version, add integration tests                           |
| Multi-turn state across batch invocations | Session corruption               | Cy's SessionManager already handles this via JSONL append                      |
| Maestro expects single-turn completion    | Cy loop runs multiple tool turns | The shim runs the full loop internally, streams all events, emits one `result` |
| Usage stats format mismatch               | Dashboard shows wrong numbers    | Match `ClaudeOutputParser.extractUsageFromRaw()` exactly                       |
| Maestro upgrades break assumptions        | Shim becomes incompatible        | Integration tests against Maestro's parser, pin Maestro version in dev         |

---

## 7. Success Criteria

1. **Protocol parity**: Maestro cannot distinguish Cy from Claude Code in normal operation
2. **Tool visibility**: Every Cy tool call appears as a formatted block in Maestro's output
3. **Session continuity**: `--resume` works across Maestro restarts
4. **Dual-model**: `/codex` and `/claude` prefixes route to correct backends
5. **Context efficiency**: Artifact dehydration reduces context usage visible in Maestro's usage bar
6. **Zero Maestro changes**: Everything works via `customPath` — no Maestro source modifications
