# CLAUDE-CONVERSATIONAL-PRD.md

Reference guide for the **Conversational PRD Planner** — the multi-turn chat interface that progressively assembles a Product Requirements Document and commits it to the Work Graph.

Epic: HumpfTech/Maestro #203. Tasks: #204–#211.

---

## Overview

The Conversational PRD Planner replaces the one-shot PRD form with a guided conversation. The assistant asks one question at a time (problem → users → success criteria → scope → constraints), accumulates a `ConversationalPrdDraft`, and signals when it is ready to commit. The user clicks "Commit to Work Graph" and the draft is passed to `DeliveryPlannerService.createPrd()` unchanged.

**Architecture decision (ADR):** Option A — In-process. State is held in the Electron main process. No new agent sessions are spawned. See `docs/architecture/conversational-prd-planner.md` for the full decision rationale.

---

## Components

### Main-process (`src/main/conversational-prd/`)

| File                    | Role                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gateway.ts`            | `ConversationalPrdGateway` interface + response/request types                                                                                                                        |
| `structured-gateway.ts` | `StructuredConversationalPrdGateway` — deterministic stub (no LLM) used in tests and as the current production gateway                                                               |
| `session-store.ts`      | `IConversationalPrdStore` interface + `InMemoryConversationalPrdStore` (volatile, in-memory)                                                                                         |
| `file-store.ts`         | `FileConversationalPrdStore` — persists sessions to `conversational-prd-sessions.json` under `MAESTRO_USER_DATA_DIR`; serialised write queue; injectable `FsAdapter` for testability |
| `service.ts`            | `ConversationalPrdService` — orchestrates store + gateway; owns message appending, draft merging, greeting logic                                                                     |
| `index.ts`              | Barrel re-exports                                                                                                                                                                    |

### IPC layer

| File                                          | Role                                                                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/ipc/handlers/conversational-prd.ts` | Registers five IPC channels (see table below); instantiates `FileConversationalPrdStore` with real `fs/promises`; exports `initConversationalPrdStore()` |
| `src/main/preload/conversationalPrd.ts`       | `createConversationalPrdApi()` — bridges IPC channels to `window.maestro.conversationalPrd.*`                                                            |
| `src/main/preload/index.ts`                   | Mounts `conversationalPrd` namespace at line ~233                                                                                                        |

### Renderer (`src/renderer/`)

| File                                                      | Role                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `components/ConversationalPRD/ConversationalPrdModal.tsx` | Modal shell: session list, new-session entry point, Escape-to-close (full chat UX is a follow-up) |

> **TODO (follow-up):** `ConversationalPrdPanel.tsx` (chat + live draft), `PrdDraftView.tsx`, and a renderer `services/conversationalPrd.ts` IPC wrapper are planned but not yet implemented on this branch. The modal directly calls `window.maestro.conversationalPrd.*` for now.

### Shared types

`src/shared/conversational-prd-types.ts` — all shared types; imported by main, renderer, and tests.

### System prompt

`src/prompts/conversational-prd-planner.md` — editable via **Maestro Prompts** tab in Settings. Prompt ID: `conversational-prd-planner` (`PROMPT_IDS.CONVERSATIONAL_PRD_PLANNER`).

---

## File Index

```
src/
├── shared/
│   └── conversational-prd-types.ts          ← canonical types
├── prompts/
│   └── conversational-prd-planner.md        ← system prompt
├── main/
│   ├── conversational-prd/
│   │   ├── gateway.ts                       ← gateway interface
│   │   ├── structured-gateway.ts            ← stub gateway (current production)
│   │   ├── session-store.ts                 ← in-memory store
│   │   ├── file-store.ts                    ← file-backed store
│   │   ├── service.ts                       ← service layer
│   │   └── index.ts                         ← barrel
│   ├── ipc/handlers/conversational-prd.ts   ← IPC registration
│   └── preload/conversationalPrd.ts         ← preload bridge
├── renderer/
│   └── components/ConversationalPRD/
│       └── ConversationalPrdModal.tsx       ← modal shell (full panel is follow-up)
└── __tests__/
    ├── main/conversational-prd/
    │   ├── service.test.ts
    │   ├── session-store.test.ts
    │   ├── file-store.test.ts
    │   ├── structured-gateway.test.ts
    │   └── archive.test.ts
    ├── prompts/
    │   └── conversationalPrdPlanner.test.ts  ← prompt contract tests
    └── integration/
        └── conversational-prd-smoke.integration.test.ts
docs/
└── architecture/
    └── conversational-prd-planner.md        ← ADR
```

---

## IPC Channels

All channels use `createIpcDataHandler` and return `{ success, data } | { success, error }`.

| Channel                            | Direction       | Input                                | Output                             |
| ---------------------------------- | --------------- | ------------------------------------ | ---------------------------------- |
| `conversationalPrd:createSession`  | renderer → main | `ConversationalPrdStartRequest`      | `ConversationalPrdStartResponse`   |
| `conversationalPrd:sendMessage`    | renderer → main | `ConversationalPrdTurnRequest`       | `ConversationalPrdTurnResponse`    |
| `conversationalPrd:getSession`     | renderer → main | `string` (conversationId)            | `ConversationalPrdSession \| null` |
| `conversationalPrd:listSessions`   | renderer → main | `{ projectPath?, includeArchived? }` | `ConversationalPrdSession[]`       |
| `conversationalPrd:archiveSession` | renderer → main | `{ sessionId, actor? }`              | `ConversationalPrdSession`         |

Renderer access: `window.maestro.conversationalPrd.<method>()`. All methods return `Promise<IpcResponse<T>>`. Use `conversationalPrdService` from `src/renderer/services/conversationalPrd.ts` — it unwraps the envelope and throws on failure.

---

## End-to-End Flow

```
User opens ConversationalPrdModal (via Quick Actions or Encore Features)
    │
    ├─ listSessions({ projectPath }) → picks most recent active session or shows EmptyState
    │
    └─ [New session]
         │
         createSession({ projectPath, gitPath })
             │
             ConversationalPrdService.createSession()
                 ├─ store.create()                    ← new session (conversationId = UUID)
                 ├─ gateway.respond({ history: [], userMessage: "<greeting prompt>" })
                 │     └─ StructuredConversationalPrdGateway: turn 0 → asks about problem
                 └─ store.appendMessage(role: 'assistant', content: greeting)
             │
             Returns { conversationId, greeting }
             │
User types message → sendMessage({ conversationId, message })
    │
    ConversationalPrdService.sendMessage()
        ├─ store.appendMessage(role: 'user')
        ├─ gateway.respond({ history, userMessage })
        │     └─ returns { messageToUser, prdDraftDelta, status }
        ├─ store.mergeDraft(delta)                    ← partial fields applied
        ├─ store.appendMessage(role: 'assistant')
        └─ returns ConversationalPrdTurnResponse
             │ { assistantMessage, delta, suggestCommit, draft }
             │
             [if suggestCommit] → onFinalize(session) callback fires
             │
After 5 turns (StructuredGateway): status = 'ready-to-finalize'
    │
    → ConversationalPrdModal shows finalize affordance (full chat UX is follow-up)
    → [Commit] calls DeliveryPlannerService.createPrd() with rendered draft
```

---

## System Prompt Output Contract

Every gateway response MUST be a single JSON object (no surrounding prose):

```json
{
  "messageToUser": "string — shown to user",
  "prdDraftDelta": {
    "title"?: "string",
    "problem"?: "string",
    "users"?: "string",
    "successCriteria"?: "string",
    "scope"?: "string",
    "constraints"?: "string",
    "dependencies"?: "string",
    "outOfScope"?: "string",
    "notes"?: "string"
  },
  "status": "gathering" | "needs-clarification" | "ready-to-finalize"
}
```

Rules:

- `prdDraftDelta` is **merged** (not replaced) into the running draft. Omit fields that have not changed.
- `status: "ready-to-finalize"` requires problem + users + successCriteria + scope all populated.
- `suggestCommit` in `ConversationalPrdTurnResponse` is derived from `status === "ready-to-finalize"`.

The `StructuredConversationalPrdGateway` (current production) simulates this deterministically: turns 0–3 gather fields, turn 4+ returns `ready-to-finalize`. It does not call an LLM.

---

## Persistence / Archive

`FileConversationalPrdStore` writes the full session list to:

```
$MAESTRO_USER_DATA_DIR/conversational-prd-sessions.json
```

Format: `{ version: 1, sessions: PersistedConversationalPrdSession[] }`.

Design notes:

- Whole-file writes on every mutation (acceptable at low volume).
- Serialised `writeQueue` (Promise chain) prevents concurrent-write races.
- `init()` must be awaited before the first IPC call — `initConversationalPrdStore()` in the IPC handler module does this.
- Corrupt or missing file → empty store + `console.warn` (never throws on read).
- `archived: true` hides a session from `list()` by default. Pass `{ includeArchived: true }` to include them.
- `InMemoryConversationalPrdStore` (used in unit tests) is volatile — sessions are lost on restart.

---

## Validation Steps

Run these after any change to the conversational PRD subsystem:

```bash
# Type-check main process
npm run lint

# Unit tests — main process + store + gateway
npm run audit:conv-prd-types

# Unit tests — renderer components (if changed)
npm run audit:conv-prd-renderer

# Prompt contract tests + smoke test (all in one)
npm run audit:conv-prd-all
```

Manual smoke:

1. `npm run dev` → open any agent workspace.
2. Open the Conversational PRD modal (via Quick Actions or enable it in Settings → Encore Features).
3. Start a new session; verify it appears in the session list.
4. Quit and reopen the app — confirm the session persists (file store).
5. Archive the session — confirm it no longer appears in the session list.

> **Note:** Full multi-turn chat UX (send messages, draft field population) is a follow-up iteration (#415). The current `ConversationalPrdModal` covers session creation and listing only.

---

## Open Follow-ups

| #   | Item                              | Notes                                                                                                                                                                                                                                                                                         |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Real LLM gateway**              | `StructuredConversationalPrdGateway` is a stub. A `ClaudeConversationalPrdGateway` (Anthropic SDK) should call the API directly with the system prompt. API key / model config needs a home — likely reuse `MaestroSettings.modelSlug` / `apiKey` or add a `conversationalPrdSettings` block. |
| 2   | **Streaming UX**                  | `ConversationalPrdChunkEvent` type and `deliveryPlanner:conversationalPrd:chunk` channel are reserved but not wired. Token-by-token streaming requires a push channel from main → renderer.                                                                                                   |
| 3   | **Settings integration**          | No user-facing settings exist yet. Candidates: model selection, auto-archive age, max concurrent sessions per project.                                                                                                                                                                        |
| 4   | **Handoff to epic decomposition** | After commit, the normal flow is `convertPrdToEpic` → `decomposeEpicToTasks`. Consider auto-triggering the pipeline from the finalize affordance.                                                                                                                                             |
| 5   | **One-at-a-time enforcement**     | The store supports multiple concurrent sessions per project. The UI should probably enforce one active session per project to avoid confusion (currently it picks the most recent active one).                                                                                                |
