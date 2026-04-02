# Phase 11-A: Migrate console.log to Structured Logger

## Objective

Replace 130+ `console.log` calls in the group chat router (and 26 in group-chat-agent) with the structured logger from `main/utils/logger.ts`. Also address high-frequency console.log in other main process files.

**Evidence:** `docs/agent-guides/scans/SCAN-MAIN.md`, "console.log vs logger Usage by File"
**Risk:** Low - logging changes don't affect behavior, only observability
**Estimated savings:** Improved debuggability, no net line count change

---

## Pre-flight Checks

- [ ] Phase 10 (modal/spawn consolidation) is complete
- [ ] `rtk npm run lint` passes

---

## Important Notes

- **DO NOT change log levels blindly.** Read each `console.log` to determine appropriate level:
  - `logger.debug()` - detailed debugging info (most console.logs)
  - `logger.info()` - notable state transitions
  - `logger.warn()` - unexpected but recoverable situations
  - `logger.error()` - actual errors (should already be console.error)
- **Preserve the log message content.** Only change the function call, not the message.
- **DO NOT touch `src/main/cue/` files** - under active development.

---

## Tasks

### Task 1: Read the logger API

Read `src/main/utils/logger.ts` to understand:
- Available log levels
- How to create a scoped logger
- Any structured data parameters

### Task 2: Create a scoped logger for group chat

```typescript
// At top of group-chat-router.ts
import { createLogger } from '../utils/logger';
const logger = createLogger('group-chat-router');
```

Similarly for `group-chat-agent.ts`.

### Task 3: Migrate group-chat-router.ts (130 calls)

This is the biggest target. Work section by section through the file:

```typescript
// BEFORE
console.log(`[GroupChat] Starting session for ${participantName}`);

// AFTER
logger.info(`Starting session for ${participantName}`);
```

For debug-level messages:
```typescript
// BEFORE
console.log(`[GroupChat] Processing message:`, message);

// AFTER
logger.debug(`Processing message`, { message });
```

### Task 4: Migrate group-chat-agent.ts (26 calls)

Same pattern as Task 3.

### Task 5: Migrate other high-frequency files

From the scan data:
- `useRemoteHandlers.ts` (14 calls) - renderer, use `console.debug` or renderer-side logger
- `phaseGenerator.ts` (14 calls)
- `graphDataBuilder.ts` (11 calls)
- `groupChat.ts` IPC handler (11 calls)

### Task 6: Verify no regressions

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 7: Count remaining raw console.log in group chat

```
rtk grep -rn "console\.log" src/main/group-chat/ --include="*.ts" | wc -l
```

Target: 0.

---

## Success Criteria

- 130+ console.log calls in group-chat-router.ts replaced with structured logger
- 26 calls in group-chat-agent.ts replaced
- Appropriate log levels assigned
- Lint and tests pass
