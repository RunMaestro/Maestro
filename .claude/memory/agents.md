# Agent System

## Active Agents

| ID | Binary | JSON Flag | Resume Flag | Read-Only Flag | Session Storage |
|----|--------|-----------|-------------|----------------|-----------------|
| `claude-code` | `claude` | `--output-format stream-json` | `--resume <id>` | `--permission-mode plan` | `~/.claude/projects/` |
| `codex` | `codex` | `--json` | `exec resume <thread_id>` | `--sandbox read-only` | `~/.codex/sessions/` |
| `opencode` | `opencode` | `--format json` | `--session <id>` | `--agent plan` | `~/.config/opencode/storage/` |
| `factory-droid` | `factory` | `-o stream-json` | `-s <id>` | default mode | `~/.factory/` |
| `terminal` | (system shell) | N/A | N/A | N/A | N/A |

## Capabilities (23 flags per agent, `src/main/agents/capabilities.ts`)

Key flags: `supportsResume`, `supportsReadOnlyMode`, `supportsJsonOutput`, `supportsSessionId`, `supportsImageInput`, `supportsSlashCommands`, `supportsSessionStorage`, `supportsCostTracking`, `supportsUsageStats`, `supportsBatchMode`, `supportsStreaming`, `supportsModelSelection`, `supportsThinkingDisplay`, `supportsContextMerge`

UI features auto-enable/disable based on capability flags.

## Adding a New Agent (6 steps)

1. Add definition → `src/main/agents/definitions.ts`
2. Define capabilities → `src/main/agents/capabilities.ts`
3. Create output parser → `src/main/parsers/{agent}-output-parser.ts`
4. Register parser → `src/main/parsers/index.ts`
5. (Optional) Session storage → `src/main/storage/{agent}-session-storage.ts`
6. (Optional) Error patterns → `src/main/parsers/error-patterns.ts`

## Output Parser Interface

```typescript
// Common parsed event structure
type: 'init' | 'text' | 'tool_use' | 'result' | 'error' | 'usage' | 'system'
sessionId?: string
text?: string
```

Registry: `registerOutputParser(agentId, parser)` / `getOutputParser(agentId)`

## Gotcha: Agent-Specific Session ID Terminology

- Claude Code: `session_id`
- Codex: `thread_id`
- Different field names, same concept. Parsers normalize this.
