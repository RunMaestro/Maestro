# Codex Mid-Turn Interaction: Native Resume Approach

## Problem

Codex currently uses the **interrupt-and-continue fallback** for mid-turn interaction:

1. SIGINT kills the process
2. New process spawned with a hand-crafted continuation prompt containing partial output
3. Agent loses all conversation context except what Maestro manually captures and stuffs into the prompt

This is fragile, lossy, and architecturally different from Claude Code's native stdin-based mid-turn input.

## Research Findings (Codex CLI Reference)

- `codex exec` is explicitly **non-interactive** — designed for "scripted or CI-style runs that should finish without human interaction"
- stdin with `-` only accepts the **initial prompt**, not continuous streaming input
- No documented stdin streaming, IPC, socket, or signal-based mid-turn message injection
- `--json` emits JSONL events **out** but there's no way to send events **back in**
- **Conclusion: True mid-turn stdin injection (like Claude Code's `stream-json`) is impossible with Codex**

## Proposed Approach: Interrupt + Native Resume

Codex supports `codex exec resume <SESSION_ID> "follow-up prompt"`. Instead of reconstructing context manually, leverage Codex's own session persistence.

### Current Flow (Fallback)

```text
User interjects while Codex is working
    → SIGINT sent to process
    → Process exits
    → Maestro collects partial stdout captured so far
    → Maestro builds continuation prompt:
        buildContinuationPrompt(partialOutput, userMessage)
        wraps partial output in <partial_output> tags
    → Spawn fresh: codex exec -- "giant continuation prompt"
    → Agent sees ONLY what Maestro stuffed in the prompt
    → Context loss: tool calls in progress, reasoning state, earlier turns
```

### Proposed Flow (Native Resume)

```text
User interjects while Codex is working
    → Grab thread_id (already stored as sessionId on the tab/process)
    → SIGINT sent to process
    → Process exits (Codex saves state to ~/.codex/sessions/ JSONL files)
    → Spawn: codex exec resume <thread_id> -- "user's interjection message"
    → Codex loads FULL conversation history from its own session files
    → Agent has complete context of everything that happened
```

### Comparison

| Aspect                     | Current (Fallback)                         | Proposed (Native Resume)                 |
| -------------------------- | ------------------------------------------ | ---------------------------------------- |
| Context preservation       | Partial — only captured stdout             | Full — Codex's own session files         |
| Continuation prompt        | Hand-crafted with `<partial_output>` tags  | Just the user's interjection             |
| Tool call history          | Lost                                       | Preserved                                |
| Reasoning state            | Lost                                       | Preserved (in session JSONL)             |
| Earlier conversation turns | Lost                                       | Preserved                                |
| Complexity                 | High — prompt reconstruction logic         | Low — use existing resume infrastructure |
| Reliability                | Fragile — depends on stdout capture timing | Robust — Codex manages its own state     |

## Infrastructure Already in Place

| Component                   | File                                      | Status                                          |
| --------------------------- | ----------------------------------------- | ----------------------------------------------- |
| `thread_id` extraction      | `src/main/parsers/codex-output-parser.ts` | Done — parsed from `thread.started` JSONL event |
| `resumeArgs` definition     | `src/main/agents/definitions.ts`          | Done — `(sessionId) => ['resume', sessionId]`   |
| `supportsResume` capability | `src/main/agents/capabilities.ts`         | Done — `true`                                   |
| Resume arg building         | `src/main/utils/agent-args.ts`            | Done — inserts `resume <id>` into CLI args      |
| Session ID storage          | Tab/process state in agentStore           | Done — stored when parser emits `init` event    |

## Implementation Plan

### Primary Change: `src/renderer/hooks/input/useInputProcessing.ts`

In the interrupt-and-continue fallback path (~line 443-538), replace:

```typescript
// BEFORE: Build continuation prompt with partial output
const continuationPrompt = buildContinuationPrompt(partialOutput, userMessage);
queueExecution({ prompt: continuationPrompt, sessionId: undefined });
```

With:

```typescript
// AFTER: Resume with native session continuation
const threadId = getCurrentSessionId(); // already captured from thread.started
queueExecution({ prompt: userMessage, sessionId: threadId });
```

### Capability Gating

Gate this behavior on agents that support native resume:

```typescript
if (capabilities.supportsResume && sessionId) {
	// Use native resume — full context preserved by agent
	queueExecution({ prompt: userMessage, sessionId });
} else {
	// Fall back to continuation prompt reconstruction
	const continuationPrompt = buildContinuationPrompt(partialOutput, userMessage);
	queueExecution({ prompt: continuationPrompt });
}
```

### Secondary Changes

1. **`src/main/process-manager/spawners/ChildProcessSpawner.ts`** — Ensure resume args are passed through when `sessionId` is provided on a queued execution
2. **`src/main/utils/agent-args.ts`** — Verify the resume + follow-up prompt combination produces correct CLI: `codex exec resume <id> -- "message"`

## Key Risk: Session State on SIGINT

**Does Codex save session state when interrupted with SIGINT (not just on clean exit)?**

Codex uses incrementally-written `.jsonl` rollout files at `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. Since JSONL files are append-only and typically flushed per-line, partial sessions should be persisted even on interrupt.

**Mitigation:** If SIGINT doesn't reliably save state, two fallback strategies:

1. **Graceful wait** — Let the current turn complete, then resume (queue-and-wait instead of interrupt)
2. **Hybrid** — Try native resume first; if it fails (session not found), fall back to continuation prompt

## Agents This Applies To

| Agent         | Supports Resume | Session Persistence       | Candidate?         |
| ------------- | --------------- | ------------------------- | ------------------ |
| Codex         | Yes             | JSONL rollout files       | Yes                |
| Claude Code   | N/A             | Has native mid-turn stdin | No (already works) |
| OpenCode      | TBD             | TBD                       | Investigate        |
| Factory Droid | TBD             | TBD                       | Investigate        |

## References

- Codex CLI reference: https://developers.openai.com/codex/cli/reference.md
- Agent definitions: `src/main/agents/definitions.ts:143-190`
- Agent capabilities: `src/main/agents/capabilities.ts:206-232`
- Codex output parser: `src/main/parsers/codex-output-parser.ts`
- Codex session storage: `src/main/storage/codex-session-storage.ts`
- Interrupt fallback path: `src/renderer/hooks/input/useInputProcessing.ts:443-538`
