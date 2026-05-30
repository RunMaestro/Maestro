<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Group Chat System

The group chat system enables multi-agent collaboration through a hub-and-spoke architecture where a central moderator coordinates messages between the user and multiple AI participant agents.

## Architecture

### Hub-and-Spoke Model

```text
                  +-----------+
                  |   User    |
                  +-----+-----+
                        |
                  +-----v-----+
                  | Moderator |  (hub - read-only AI agent)
                  +-----+-----+
                   /    |    \
          +-------+  +--+--+  +-------+
          |Agent A|  |Agent B|  |Agent C|  (spokes - participant agents)
          +-------+  +-------+  +-------+
```

- **User** sends a message to the group chat
- **Moderator** (hub) receives the message, decides which agents to delegate to via `@mentions`, and synthesizes responses
- **Participants** (spokes) are AI agents that receive tasks from the moderator and respond with results
- The moderator reviews all responses and either delegates further or returns a final answer to the user

### Message Flow

1. User submits a message via the renderer
2. The IPC handler (`groupChat:sendToModerator`) calls `routeUserMessage()`
3. The router auto-adds any `@mentioned` agents not yet in the chat (matching against available Maestro sessions)
4. The message is appended to the pipe-delimited chat log
5. A moderator batch process is spawned with the full system prompt, participant list, chat history, and user message
6. The moderator responds with `@mentions` targeting specific participants
7. The router extracts mentions, dispatches requests to each mentioned participant in parallel
8. Each participant runs as its own agent process and responds
9. When all pending participants have responded, a moderator synthesis round is spawned
10. The moderator reviews all responses and either delegates again or returns to the user

## Data Model

### GroupChat

Defined in `src/shared/group-chat-types.ts` and `src/main/group-chat/group-chat-storage.ts`:

```typescript
interface GroupChat {
	id: string; // UUID
	name: string; // Display name (sanitized for filesystem)
	createdAt: number; // Timestamp
	updatedAt: number; // Timestamp
	moderatorAgentId: string; // e.g. 'claude-code'
	moderatorSessionId: string; // Session ID prefix for routing
	moderatorAgentSessionId?: string; // Agent session UUID for continuity
	moderatorConfig?: ModeratorConfig; // Custom path, args, env vars, model, SSH
	participants: GroupChatParticipant[];
	logPath: string; // Path to chat.log
	imagesDir: string; // Path to images/
	archived?: boolean;
}
```

### GroupChatParticipant

```typescript
interface GroupChatParticipant {
	name: string; // Unique name within the chat
	agentId: string; // Agent type (e.g. 'claude-code')
	sessionId: string; // Internal process session ID for routing
	agentSessionId?: string; // Agent's conversation session ID for continuity
	addedAt: number;
	lastActivity?: number;
	lastSummary?: string;
	contextUsage?: number;
	color?: string; // Assigned color for UI
	tokenCount?: number;
	messageCount?: number;
	processingTimeMs?: number;
	totalCost?: number; // USD
	sshRemoteName?: string; // SSH remote display name
}
```

### GroupChatMessage

```typescript
interface GroupChatMessage {
	timestamp: string; // ISO 8601
	from: string; // 'user', 'moderator', or participant name
	content: string;
	readOnly?: boolean;
}
```

### GroupChatHistoryEntry

Stored in JSONL format for append-only activity tracking:

```typescript
interface GroupChatHistoryEntry {
	id: string;
	timestamp: number;
	summary: string; // One-sentence summary
	participantName: string;
	participantColor: string;
	type: 'delegation' | 'response' | 'synthesis' | 'error';
	elapsedTimeMs?: number;
	tokenCount?: number;
	cost?: number;
	fullResponse?: string;
}
```

### Chat State

```typescript
type GroupChatState = 'idle' | 'moderator-thinking' | 'agent-working';
```

## Storage Layout

Each group chat lives in its own directory under `{userData}/group-chats/{id}/`:

```text
group-chats/
  {uuid}/
    metadata.json    # GroupChat object
    chat.log         # Pipe-delimited message log
    history.jsonl    # Activity history entries (one JSON per line)
    images/          # Image attachments
```

**Atomic writes**: All metadata updates use write-to-temp-then-rename to prevent corruption on crash.

**Write serialization**: A per-chat write queue (see `enqueueWrite()`) serializes concurrent metadata writes to prevent race conditions between the router, usage listener, and session-ID listener.

### Chat Log Format

Pipe-delimited with escape sequences:

```text
TIMESTAMP|FROM|CONTENT
TIMESTAMP|FROM|CONTENT|readOnly
```

Escaping rules (applied in order):

- `\` becomes `\\`
- `|` becomes `\|`
- newlines become `\n`

## Main Process Modules

All located in `src/main/group-chat/`:

### group-chat-router.ts

The central message routing engine. Key exports:

| Function                           | Purpose                                                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routeUserMessage()`               | Routes user message to moderator batch process. Auto-adds `@mentioned` sessions as participants. Builds the full prompt with system prompt, participant list, chat history, and user request. |
| `routeModeratorResponse()`         | Parses moderator output for `@mentions`, dispatches to participants, tracks pending responses                                                                                                 |
| `routeAgentResponse()`             | Handles participant response, logs it, emits to renderer                                                                                                                                      |
| `spawnModeratorSynthesis()`        | Spawns synthesis round after all participants respond                                                                                                                                         |
| `respawnParticipantWithRecovery()` | Re-spawns a participant with recovery context after session loss                                                                                                                              |
| `extractMentions()`                | Extracts `@Name` patterns from text, matches against participants                                                                                                                             |
| `markParticipantResponded()`       | Removes participant from pending set, returns true if last                                                                                                                                    |

Module-level callbacks set during initialization:

- `setGetSessionsCallback()` - Looks up available Maestro sessions for auto-add
- `setGetCustomEnvVarsCallback()` - Resolves per-agent env vars
- `setGetAgentConfigCallback()` - Resolves per-agent config (custom args, model, etc.)
- `setSshStore()` - Provides SSH store for remote execution

### group-chat-moderator.ts

Manages the moderator lifecycle:

| Function                | Purpose                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `spawnModerator()`      | Initializes session mapping, stores session ID prefix                |
| `sendToModerator()`     | Logs message and writes to moderator process                         |
| `killModerator()`       | Kills process, clears state, removes power block                     |
| `startSessionCleanup()` | Periodic cleanup of stale sessions (30min threshold, 10min interval) |
| `stopSessionCleanup()`  | Stops cleanup on shutdown                                            |

The moderator runs in **read-only mode** to prevent unintended modifications.

### group-chat-agent.ts

Manages participant agents:

| Function                        | Purpose                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `addParticipant()`              | Resolves agent config, spawns process, stores session mapping. Supports SSH wrapping via `wrapSpawnWithSsh()`. |
| `sendToParticipant()`           | Routes message to participant, logs as `moderator->{name}`                                                     |
| `removeParticipant()`           | Kills process, removes from storage                                                                            |
| `clearAllParticipantSessions()` | Kills all participant processes for a chat                                                                     |

Participants run with **read-write access** (not read-only) so they can make code changes.

### group-chat-storage.ts

CRUD operations for group chat metadata:

| Function                      | Purpose                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `createGroupChat()`           | Creates directory structure, metadata, empty log          |
| `loadGroupChat()`             | Reads and parses metadata.json                            |
| `listGroupChats()`            | Lists all group chat directories                          |
| `deleteGroupChat()`           | Removes directory with retry logic for Windows file locks |
| `updateGroupChat()`           | Partial update with write serialization                   |
| `addParticipantToChat()`      | Appends participant to metadata                           |
| `removeParticipantFromChat()` | Filters participant from metadata                         |
| `updateParticipant()`         | Updates participant stats (tokens, cost, etc.)            |
| `addGroupChatHistoryEntry()`  | Appends JSONL history entry                               |
| `getGroupChatHistory()`       | Reads and sorts history entries                           |

### group-chat-log.ts

Log file I/O:

| Function                                | Purpose                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `appendToLog()`                         | Escapes content and appends timestamped line                                                 |
| `readLog()`                             | Parses pipe-delimited log into `GroupChatMessage[]`                                          |
| `saveImage()`                           | Saves image buffer to images directory with UUID filename and extension whitelist validation |
| `escapeContent()` / `unescapeContent()` | Pipe-delimited escape handling                                                               |

### group-chat-config.ts

Shared configuration callbacks:

| Function                          | Purpose                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `setGetCustomShellPathCallback()` | Registers callback for Windows shell preference                                        |
| `getWindowsSpawnConfig()`         | Returns shell and stdin flags for Windows agent spawning. Skipped when SSH is enabled. |

### output-buffer.ts

Buffers streaming output from group chat processes:

- Uses chunked array storage for O(1) append performance
- Enforces `MAX_GROUP_CHAT_BUFFER_SIZE` to prevent memory exhaustion
- Buffer is released on process exit, then routed through the output parser

### output-parser.ts

Extracts text content from agent JSON/JSONL output:

- Uses registered per-agent output parsers (`getOutputParser()`)
- Falls back to generic extraction for unknown agent types
- Prefers `result` messages over streaming `text` chunks

### session-parser.ts

Parses group chat session IDs to extract `groupChatId` and `participantName`:

```text
group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
group-chat-{groupChatId}-participant-{name}-recovery-{timestamp}
```

Handles hyphenated participant names by matching against UUID or timestamp suffixes.

### session-recovery.ts

Detects and recovers from `session_not_found` errors:

1. `detectSessionNotFoundError()` - Checks output against error patterns
2. `buildRecoveryContext()` - Builds rich context from chat history, emphasizing the participant's own prior statements
3. `initiateSessionRecovery()` - Clears `agentSessionId` so next spawn uses a fresh session

## IPC Handlers

Registered in `src/main/ipc/handlers/groupChat.ts`. All handler names are prefixed with `groupChat:`.

### CRUD

| Handler             | Description                                               |
| ------------------- | --------------------------------------------------------- |
| `groupChat:create`  | Creates a new group chat with name and moderator agent ID |
| `groupChat:list`    | Lists all group chats                                     |
| `groupChat:load`    | Loads a single group chat by ID                           |
| `groupChat:delete`  | Deletes a group chat and all data                         |
| `groupChat:archive` | Archives a group chat (soft delete)                       |
| `groupChat:rename`  | Renames a group chat                                      |
| `groupChat:update`  | Updates group chat metadata (name, moderator config)      |

### Chat Operations

| Handler                     | Description                                 |
| --------------------------- | ------------------------------------------- |
| `groupChat:sendToModerator` | Routes a user message through the moderator |
| `groupChat:appendMessage`   | Appends a message to the chat log           |
| `groupChat:getMessages`     | Gets all messages from the chat log         |
| `groupChat:saveImage`       | Saves an image attachment                   |
| `groupChat:getImages`       | Lists saved image attachments for the chat  |

### Moderator

| Handler                           | Description                                          |
| --------------------------------- | ---------------------------------------------------- |
| `groupChat:startModerator`        | Spawns the moderator agent                           |
| `groupChat:stopModerator`         | Kills the moderator                                  |
| `groupChat:stopAll`               | Kills moderator + all participants                   |
| `groupChat:getModeratorSessionId` | Returns the moderator's provider session ID (if any) |
| `groupChat:reportAutoRunComplete` | Signal from an Auto Run batch run that it finished   |

### Participants

| Handler                             | Description                                 |
| ----------------------------------- | ------------------------------------------- |
| `groupChat:addParticipant`          | Adds a participant agent                    |
| `groupChat:removeParticipant`       | Removes a participant                       |
| `groupChat:sendToParticipant`       | Sends a message to a specific participant   |
| `groupChat:resetParticipantContext` | Clears a participant's conversation context |

### History

| Handler                        | Description                                  |
| ------------------------------ | -------------------------------------------- |
| `groupChat:getHistory`         | Gets activity history entries                |
| `groupChat:addHistoryEntry`    | Appends a new history entry                  |
| `groupChat:deleteHistoryEntry` | Deletes a single history entry               |
| `groupChat:clearHistory`       | Clears all history                           |
| `groupChat:getHistoryFilePath` | Returns the on-disk path of the history file |

### Emitter System

The `groupChatEmitters` object provides real-time event broadcasting to the renderer:

| Emitter                   | Event                           | Purpose                    |
| ------------------------- | ------------------------------- | -------------------------- |
| `emitMessage`             | `groupChat:message`             | New message in chat        |
| `emitStateChange`         | `groupChat:stateChange`         | Chat state transition      |
| `emitParticipantsChanged` | `groupChat:participantsChanged` | Participant added/removed  |
| `emitModeratorUsage`      | `groupChat:moderatorUsage`      | Context/cost/token updates |
| `emitHistoryEntry`        | `groupChat:historyEntry`        | New history entry          |
| `emitParticipantState`    | `groupChat:participantState`    | Participant working/idle   |

## Renderer Components

Located in `src/renderer/components/`:

| Component                   | Purpose                                                               |
| --------------------------- | --------------------------------------------------------------------- |
| `GroupChatPanel.tsx`        | Main panel displayed in the center workspace for an active group chat |
| `GroupChatMessages.tsx`     | Message list with sender attribution and colors                       |
| `GroupChatInput.tsx`        | User input area with `@mention` autocomplete                          |
| `GroupChatHeader.tsx`       | Chat name, state indicator, moderator controls                        |
| `GroupChatParticipants.tsx` | Participant list with stats and remove buttons                        |
| `GroupChatList.tsx`         | Left Bar list of group chats                                          |
| `GroupChatModal.tsx`        | Creation modal for new group chats                                    |
| `GroupChatRightPanel.tsx`   | Right panel with chat info and participants                           |
| `GroupChatInfoOverlay.tsx`  | Info overlay with chat metadata                                       |
| `GroupChatHistoryPanel.tsx` | Activity history timeline                                             |
| `ParticipantCard.tsx`       | Individual participant card with stats                                |
| `CreateGroupModal.tsx`      | Group creation dialog                                                 |
| `DeleteGroupChatModal.tsx`  | Deletion confirmation                                                 |
| `RenameGroupChatModal.tsx`  | Rename dialog                                                         |

## Symphony System

Symphony is a separate feature that connects Maestro users with open-source projects seeking contributions. It is not part of the group chat system, but shares some infrastructure:

- **Registry**: Hosted at `symphony-registry.json` in the Maestro GitHub repo. Contains registered repositories with categories, maintainer info, and active status.
- **Workflow**: Browse repositories, select an issue labeled `runmaestro.ai`, clone the repo, create a branch and draft PR, run Auto Run documents from the issue, then mark the PR as ready for review.
- **Types**: Defined in `src/shared/symphony-types.ts` - includes `SymphonyRegistry`, `SymphonyIssue`, `ActiveContribution`, `ContributorStats`, and `SymphonyState`.
- **Constants**: Defined in `src/shared/symphony-constants.ts` - registry URL, cache TTLs, branch/PR templates, category display info.
- **Session metadata**: Symphony sessions attach `SymphonySessionMetadata` to the agent session for cross-referencing contributions.

## Prompt Templates

Group chat uses four prompt templates from `src/prompts/`:

| File                                | Purpose                                                                                                                            | Template Variables                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group-chat-moderator-system.md`    | System prompt for the moderator. Instructs it to assist directly for simple tasks and delegate via `@mentions` for complex ones.   | `{{CONDUCTOR_PROFILE}}`                                                                                                                                                                |
| `group-chat-moderator-synthesis.md` | Synthesis prompt shown when reviewing agent responses. Moderator decides whether to continue delegating or summarize for the user. | None                                                                                                                                                                                   |
| `group-chat-participant.md`         | System prompt for participants. Instructs response format (overview first, then details).                                          | `{{GROUP_CHAT_NAME}}`, `{{PARTICIPANT_NAME}}`, `{{LOG_PATH}}`                                                                                                                          |
| `group-chat-participant-request.md` | Per-message prompt for participants with chat history and the moderator's request.                                                 | `{{PARTICIPANT_NAME}}`, `{{GROUP_CHAT_NAME}}`, `{{GROUP_CHAT_FOLDER}}`, `{{HISTORY_CONTEXT}}`, `{{MESSAGE}}`, `{{READ_ONLY_NOTE}}`, `{{READ_ONLY_LABEL}}`, `{{READ_ONLY_INSTRUCTION}}` |

## Key Source Files

| File                                          | Purpose                                  |
| --------------------------------------------- | ---------------------------------------- |
| `src/main/group-chat/group-chat-router.ts`    | Message routing engine                   |
| `src/main/group-chat/group-chat-moderator.ts` | Moderator lifecycle management           |
| `src/main/group-chat/group-chat-agent.ts`     | Participant agent management             |
| `src/main/group-chat/group-chat-storage.ts`   | File-based CRUD with write serialization |
| `src/main/group-chat/group-chat-log.ts`       | Pipe-delimited log I/O                   |
| `src/main/group-chat/group-chat-config.ts`    | Shared Windows spawn config              |
| `src/main/group-chat/output-buffer.ts`        | Streaming output buffering               |
| `src/main/group-chat/output-parser.ts`        | Agent JSON/JSONL text extraction         |
| `src/main/group-chat/session-parser.ts`       | Session ID parsing                       |
| `src/main/group-chat/session-recovery.ts`     | Session-not-found recovery               |
| `src/main/ipc/handlers/groupChat.ts`          | IPC handler registration and emitters    |
| `src/shared/group-chat-types.ts`              | Shared type definitions                  |
| `src/shared/symphony-types.ts`                | Symphony type definitions                |
| `src/shared/symphony-constants.ts`            | Symphony constants                       |
| `src/prompts/group-chat-*.md`                 | Prompt templates                         |
