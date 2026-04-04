# Copilot CLI Phase 2: Full Parity Plan

Use this document to kick off a new session once Phase 1 (core agent integration) is verified working. Phase 1 code is already merged — the agent ID, definition, capabilities, output parser, and error patterns are in place.

## Prerequisite: Verify Phase 1

Before starting Phase 2, confirm these work:
1. `copilot` binary detected in Settings → AI Agents
2. Creating a new Copilot CLI agent session succeeds
3. Sending a message produces output (parsed from JSONL)
4. Session resume via `--resume SESSION-ID` works
5. Model selection via config option works

If the JSONL output schema doesn't match the parser's assumptions, **fix the parser first** — see "JSON Schema Investigation" below.

---

## JSON Schema Investigation (Do This First)

Run: `copilot -p "Say hello in one sentence" --output-format json --allow-all`

Capture the full output and document the actual JSONL event types. The parser in `src/main/parsers/copilot-cli-output-parser.ts` uses heuristic type matching. Refine it to match the actual schema:

1. What event type contains the session ID? (e.g., `session.started`, `init`, `thread.started`)
2. What event type contains streaming text? (e.g., `content.delta`, `assistant.message`, `text`)
3. What event type contains tool calls? (e.g., `tool_use`, `tool.started`, `tool.completed`)
4. What event type contains usage stats? (e.g., `usage`, `turn.completed`, `stats`)
5. What event type signals completion? (e.g., `result`, `complete`, `done`)
6. How are errors structured? (e.g., `{ type: "error", error: { message: "..." } }`)

Update `CopilotCliRawMessage` interface and `transformMessage()` method to match.

---

## Todo: Session Storage Browser

**Goal**: Enable browsing/resuming past sessions from the Right Bar.

**Files**:
- New: `src/main/storage/copilot-cli-session-storage.ts`
- Edit: `src/main/storage/index.ts` — register `CopilotCliSessionStorage`
- Edit: `src/main/agents/capabilities.ts` — set `supportsSessionStorage: true`

**Implementation**:
1. Investigate session file format at `~/.copilot/session-state/` (may also be `~/.copilot/sessions/`)
2. Extend `BaseSessionStorage` from `src/main/storage/base-session-storage.ts`
3. Implement required methods:
   - `listSessions(projectPath, options)` — list session files, extract metadata (title, date, agent)
   - `readSessionMessages(projectPath, sessionId, options)` — parse session file into `SessionMessage[]`
   - `searchSessions(projectPath, query)` — search session content
   - `getGlobalStats()` — aggregate usage statistics (optional)
4. Register in `initializeSessionStorages()` in `src/main/storage/index.ts`

**Reference**: Follow `codex-session-storage.ts` or `factory-droid-session-storage.ts` patterns.

---

## Todo: Usage Stats & Cost Tracking

**Goal**: Show token counts and cost in the UI (MainPanel token display, cost widget).

**Files**:
- Edit: `src/main/parsers/copilot-cli-output-parser.ts` — refine `extractUsageFromRaw()`
- Edit: `src/main/agents/capabilities.ts` — set `supportsUsageStats: true`, `supportsCostTracking: true`

**Implementation**:
1. From the JSON schema investigation, identify which event carries usage data
2. Map fields to `ParsedEvent.usage` (inputTokens, outputTokens, cacheReadTokens, costUsd)
3. If Copilot CLI doesn't report cost directly, leave `supportsCostTracking: false` and only enable `supportsUsageStats: true`
4. Context window: parse from JSON events if reported, otherwise use the user's configured value

---

## Todo: Thinking/Reasoning Display

**Goal**: Show model reasoning/thinking content in the AI Terminal.

**Files**:
- Edit: `src/main/parsers/copilot-cli-output-parser.ts`
- Edit: `src/main/agents/capabilities.ts` — set `supportsThinkingDisplay: true`

**Implementation**:
1. Check if Copilot CLI JSON output includes reasoning/thinking tokens (separate from main content)
2. If yes: emit them as `type: 'text'` with `isPartial: true` (like Codex reasoning items)
3. If no: leave `supportsThinkingDisplay: false`

---

## Todo: Read-Only Mode

**Goal**: Restrict the agent to read-only operations for safe analysis.

**Files**:
- Edit: `src/main/agents/definitions.ts` — set `readOnlyArgs` and `readOnlyCliEnforced`
- Edit: `src/main/agents/capabilities.ts` — set `supportsReadOnlyMode: true`

**Implementation**:
1. Test: `copilot -p "prompt" --deny-tool=write --deny-tool=create --deny-tool=apply_patch --output-format json`
2. If this reliably prevents file modifications, update the definition:
   ```typescript
   readOnlyArgs: ['--deny-tool=write', '--deny-tool=create', '--deny-tool=apply_patch'],
   readOnlyCliEnforced: true,
   ```
3. If `--deny-tool` doesn't work for read-only, use prompt-only enforcement (leave `readOnlyCliEnforced: false`)

---

## Todo: Image Input

**Goal**: Allow attaching images/screenshots to prompts.

**Files**:
- Edit: `src/main/agents/definitions.ts` — add `imageArgs`
- Edit: `src/main/agents/capabilities.ts` — set `supportsImageInput: true`

**Implementation**:
1. Check if Copilot CLI supports image input via `@ filename.png` or a flag like `-i`
2. If supported via a flag: add `imageArgs: (imagePath: string) => ['--flag', imagePath]`
3. If supported via stdin/stream-json: set `supportsStreamJsonInput: true` and add `--input-format stream-json` handling
4. If not supported: leave `supportsImageInput: false`

---

## Todo: Wizard Support

**Goal**: Enable inline wizard (structured output conversations) with Copilot CLI.

**Files**:
- Edit: `src/main/agents/capabilities.ts` — set `supportsWizard: true`

**Implementation**:
1. Test sending a structured wizard prompt to Copilot CLI
2. Verify the agent follows the structured output format (numbered steps, clear sections)
3. If output quality is sufficient: enable `supportsWizard: true`
4. The wizard system is prompt-driven, so no code changes are needed if the agent handles prompts well

---

## Todo: Group Chat Moderation

**Goal**: Allow Copilot CLI agents to serve as group chat moderators.

**Files**:
- Edit: `src/main/agents/capabilities.ts` — set `supportsGroupChatModeration: true`

**Implementation**:
1. Test group chat with Copilot CLI as moderator
2. Verify it can coordinate between agents, route questions, and synthesize responses
3. Group chat uses prompt-based coordination, so no code changes needed if quality is sufficient

---

## Todo: Context Export

**Goal**: Allow exporting Copilot CLI session context for transfer to other agents.

**Files**:
- Edit: `src/main/agents/capabilities.ts` — set `supportsContextExport: true`

**Implementation**:
- Depends on session storage being implemented first
- Context export reads session messages and formats them for another agent
- Once `CopilotCliSessionStorage.readSessionMessages()` works, enable this flag

---

## Todo: Result Messages

**Goal**: Detect when the agent has finished its response for Auto Run sequencing.

**Files**:
- Edit: `src/main/parsers/copilot-cli-output-parser.ts` — refine `isResultMessage()`
- Edit: `src/main/agents/capabilities.ts` — set `supportsResultMessages: true`

**Implementation**:
1. From JSON schema investigation, identify the completion signal
2. Update `transformMessage()` to emit `type: 'result'` for the correct event type
3. Update `isResultMessage()` to match

---

## Capability Parity Matrix

| Capability | Claude Code | Codex | OpenCode | Factory Droid | Copilot CLI (Phase 1) | Copilot CLI (Target) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Resume | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Read-Only | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| JSON Output | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Session ID | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Image Input | ✅ | ✅ | ✅ | ✅ | ❌ | ❓ |
| Slash Commands | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Session Storage | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cost Tracking | ✅ | ❌ | ✅ | ❌ | ❌ | ❓ |
| Usage Stats | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Batch Mode | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Streaming | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Result Messages | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| Model Selection | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Thinking Display | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Context Merge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Context Export | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Wizard | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Group Chat Mod | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |

❓ = depends on CLI capability (needs investigation)

---

## Suggested Order of Work

1. **JSON Schema Investigation** — must be first; everything else depends on it
2. **Parser Refinement** — fix parser to match actual schema
3. **Usage Stats** — quick win, high visibility
4. **Result Messages** — needed for Auto Run to work properly
5. **Session Storage** — enables session browsing in Right Bar
6. **Read-Only Mode** — safety feature
7. **Thinking Display** — nice-to-have
8. **Image Input** — if supported by CLI
9. **Context Export** — depends on session storage
10. **Wizard + Group Chat** — quality-dependent, test and enable
