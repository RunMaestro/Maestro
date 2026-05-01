# ADR: Conversational PRD Planner — In-Process vs Sidecar

**Status:** Accepted
**Date:** 2026-05-01
**Issue:** HumpfTech/Maestro #204
**Deciders:** HumpfTech platform team

---

## Problem Statement

The current Delivery Planner performs one-shot PRD decomposition: the user supplies a title and description, the `DeliveryPlannerDecompositionGateway` runs a single structured-output pass, and a complete PRD Work Graph item is produced. There is no mechanism for the user to refine scope, negotiate acceptance criteria, or iterate on the decomposition before it is committed to the Work Graph.

The goal of the Conversational PRD Planner is to replace (or augment) that one-shot flow with a **multi-turn chat** that progressively assembles a PRD. The system asks clarifying questions, the user answers, and a draft PRD accumulates across turns until the user explicitly commits it.

**The architectural question:** Should this multi-turn state be held:

- **(A) In-process** — as a stateful conversation map inside (or alongside) `DeliveryPlannerService`, with a new set of IPC channels managed entirely within the existing delivery-planner subsystem, OR
- **(B) As a sidecar session** — as a new conversational session managed by the existing Maestro agent runtime (e.g. a dedicated Claude Code / Sonnet session spawned as an Electron-visible AI tab), with the delivery-planner service only consuming the final committed PRD?

---

## Context and Constraints

### Existing architecture

The delivery-planner subsystem is a pure domain service:

- `DeliveryPlannerService` holds no long-lived stateful conversations — its only in-memory state is `InMemoryDeliveryPlannerProgressStore`, which tracks short-lived operations (external-mirror-sync, decomposition, github-sync) keyed by auto-incrementing IDs.
- The decomposition gateway (`DeliveryPlannerDecompositionGateway`) is a **single-call interface**: one request in, one structured-output result out. There is no streaming, no session resumption, and no turn count.
- All IPC channels (`deliveryPlanner:createPrd`, `deliveryPlanner:decomposePrd`, etc.) are stateless request-response.
- State durability is delegated to Work Graph (SQLite via `WorkGraphStorage`) and external mirror files.

The agent runtime (sessions, process-manager, agent-dispatch) already manages long-lived conversational sessions with PTY processes, output parsers, session storage, group-chat multi-agent orchestration, crash recovery (`session-recovery.ts`), and SSH remote execution. It exposes a rich IPC namespace (`window.maestro.symphony.*`, process events, Auto Run triggers).

### Decision criteria (from issue #204)

| Criterion                                      | Weight |
| ---------------------------------------------- | ------ |
| Latency (time-to-first-response)               | High   |
| Operational cost                               | High   |
| Multi-user / concurrent planners               | Medium |
| Model variety (use different models per turn)  | Medium |
| Resource isolation (planner crash ≠ app crash) | Medium |
| Integration complexity                         | High   |

---

## Option A: In-Process (extend `DeliveryPlannerService`)

### Description

Add a `ConversationalPrdSession` lifecycle to the delivery-planner subsystem:

1. A new `conversationalPrd:start` IPC call creates a `ConversationalPrdSession` keyed by a `conversationId` (UUID) and stores it in a new `InMemoryConversationalPrdStore` (same pattern as `InMemoryDeliveryPlannerProgressStore`).
2. Each user turn arrives via `conversationalPrd:turn` — the handler appends the user message, calls a new `ConversationalPrdGateway` interface (analogous to `DeliveryPlannerDecompositionGateway`), and returns the assistant's response plus any `PrdDraftDelta` (partial field updates).
3. The draft PRD is accumulated client-side as a `ConversationalPrdDraft` and reflected back to the renderer in each response envelope.
4. When the user confirms, `conversationalPrd:commit` calls `service.createPrd(...)` with the accumulated draft, producing the canonical Work Graph item.
5. The `ConversationalPrdGateway` is a thin interface — the actual LLM call happens through whatever provider is wired at call time (HTTP, SDK, or a future streaming adapter).

```
Renderer (DeliveryPlannerWizard)
    │  conversationalPrd:start / turn / commit / abort
    ▼
DeliveryPlannerService.conversationalPrd.*
    │
    ├─ InMemoryConversationalPrdStore   (conversationId → ConversationalPrdSession)
    │
    └─ ConversationalPrdGateway         (single interface, multiple impls)
           └─ ClaudeConversationalPrdGateway (HTTP / SDK)
```

### Advantages

- Zero new infrastructure. No new processes, no PTY, no session IDs to manage.
- Conversation state lives in the same process — no IPC round-trips between the gateway and the renderer during a turn.
- The `commit` path is a direct call to `service.createPrd(...)` — no translation layer.
- The `ConversationalPrdGateway` interface can be swapped in tests with a deterministic stub (same pattern as `StructuredDeliveryPlannerDecompositionGateway`).
- State is already well-understood: `InMemoryDeliveryPlannerProgressStore` shows the pattern is idiomatic to this codebase.
- Crash recovery is simple: a crash ends the planning session and the user re-starts. No orphaned PTY processes or dangling claims.
- No agent-dispatch entanglement. The Delivery Planner principle ("no agent spawning") is preserved.

### Disadvantages

- The gateway implementation (the actual LLM HTTP call) must be written from scratch — there is no reuse of the existing Claude Code PTY pipeline.
- Streaming responses require a new push channel (`deliveryPlanner:conversationalTurn:chunk` or similar) rather than reusing the existing terminal output pipeline.
- Model variety requires explicit wiring (e.g., pass `model` in the gateway call). It is not automatic.
- In-memory only: if the main process crashes mid-conversation, the draft is lost. (Mitigation: persist draft to a scratch file; not strictly required for MVP.)
- Concurrent planners for multiple projects are supported (multiple `conversationId` values), but there is no per-conversation process isolation.

---

## Option B: Sidecar Session (new agent runtime session)

### Description

Spawn a new Maestro agent session (e.g., `claude-code` or a dedicated `conversational-planner` agent type) as a visible AI tab. The user interacts with it through the existing AI Terminal. When the conversation reaches a commit point, the agent emits a structured JSON payload that a new `conversationalPrd:import` IPC handler passes to `service.createPrd(...)`.

```
Renderer (AI Terminal — new "Planner" tab)
    │  process I/O (existing PTY pipeline)
    ▼
ManagedProcess (claude-code or dedicated agent)
    │  structured output on stdout
    ▼
Output parser → deliveryPlanner:conversationalPrd:import
    ▼
DeliveryPlannerService.createPrd(...)
```

### Advantages

- Reuses the full agent runtime: PTY, streaming output, SSH support, Auto Run, session recovery.
- Model variety is first-class — the user can select any agent type.
- Process isolation: a runaway planner cannot crash the main process.
- The user sees the planning conversation in the familiar AI Terminal UI with no new UI components.
- Multi-user (web/mobile) naturally inherits the existing session IPC.

### Disadvantages

- **High integration complexity.** The existing agent runtime is built around long-running coding sessions, not structured planning wizards. Extracting the final PRD requires either: (a) a custom output parser that recognises a commit sentinel in the raw PTY stream, or (b) a new agent type with a bespoke system prompt that emits JSON. Both add fragile coupling between planning semantics and raw process output.
- **Violates the Delivery Planner principle** that "planning must not launch Maestro or start implementation" — spawning an agent session blurs the boundary.
- **State ownership conflict.** The agent session owns its conversation history; the Delivery Planner service owns the PRD Work Graph item. Bridging these two ownership domains requires a translation step that is brittle (depends on the agent not deviating from the expected output format).
- **No native multi-turn commit protocol.** The existing `ConvertPrdToEpicInput` / `DecomposeEpicInput` IPC calls are one-shot. Bolting multi-turn semantics onto an agent session requires a new protocol layer anyway.
- **Latency.** Spawning a PTY process, waiting for the agent to start, and parsing its greeting adds 1–3 seconds of latency before the first planning turn. An in-process HTTP call to the LLM API is faster.
- **Cost.** Every session spawn re-sends a full system prompt. An in-process gateway can use cached prefix or a compact prompt template.
- **Recovery on crash** is more complex: dangling PTY processes, open claims, and session IDs that are no longer valid (the `session-recovery.ts` module already handles this but adds code surface).

---

## Comparison Table

| Dimension                        | Option A: In-Process                                                                                          | Option B: Sidecar Session                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **State lifecycle**              | `conversationId → ConversationalPrdSession` map in main process memory; optional scratch file for persistence | Agent session lifecycle (spawn → heartbeat → release); history in session storage |
| **Persistence**                  | In-memory by default; can write scratch JSON to userData                                                      | Persisted in session storage automatically                                        |
| **Recovery on crash**            | Draft lost; user re-starts conversation                                                                       | Session recovery exists but adds complexity; orphaned PTY risk                    |
| **Integration with existing UI** | New wizard panel / chat component in Delivery Planner UI                                                      | Reuses AI Terminal with no new UI                                                 |
| **Model variety**                | Explicit in gateway interface; requires wiring                                                                | First-class via agent type selection                                              |
| **Streaming**                    | New push channel needed                                                                                       | PTY streaming built-in                                                            |
| **SSH remote**                   | Not needed (LLM call is outbound HTTP)                                                                        | Inherited automatically                                                           |
| **Multi-user / concurrent**      | Supported via multiple `conversationId` values                                                                | Supported via multiple sessions                                                   |
| **Implementation complexity**    | Low — one new interface, one new store, ~5 new IPC channels                                                   | High — output parser, agent type, commit protocol, PTY lifecycle                  |
| **Delivery Planner principles**  | Preserved ("no agent spawning")                                                                               | Violated (spawns agent session)                                                   |
| **Latency**                      | Low (direct HTTP call, no PTY startup)                                                                        | Medium–High (PTY spawn overhead)                                                  |
| **Cost**                         | Lower (compact prompt, cached prefix possible)                                                                | Higher (full system prompt per session)                                           |
| **Test isolation**               | High (gateway stub, no process)                                                                               | Medium (requires process mocking)                                                 |

---

## Decision: Option A — In-Process

**Rationale:**

1. **Simpler integration path.** Option A introduces exactly one new abstraction (`ConversationalPrdGateway`) alongside existing patterns (`InMemoryDeliveryPlannerProgressStore`, the decomposer gateway). Option B requires bridging two ownership domains, writing an output parser, and managing PTY lifecycle — all of which are high-risk surfaces.

2. **Delivery Planner principles are preserved.** The explicit architectural rule in `CLAUDE-DELIVERY-PLANNER.md` is "No agent spawning. Delivery Planner creates structured work and marks tasks `agent-ready`; Agent Dispatch owns capability matching, claim, heartbeat, and pickup." Option B directly contradicts this.

3. **Latency and cost favour in-process.** Multi-turn PRD planning conversations are short (5–15 turns) and time-sensitive — the user is waiting. A direct HTTP/SDK call to the LLM API is measurably faster than PTY spawn + greeting round-trip. Compact prompt templates can reduce per-turn cost vs. a full agent system prompt.

4. **Crash recovery is acceptable for a planning wizard.** Unlike coding sessions (where losing an in-progress implementation is catastrophic), losing a mid-flight planning conversation is recoverable — the user can restart. If persistence becomes important, writing a scratch JSON file to `userData/delivery-planner/conversations/` is a straightforward addition.

5. **Test coverage is better.** The gateway interface allows deterministic stub implementations (identical to `StructuredDeliveryPlannerDecompositionGateway`), enabling vitest unit tests without any process spawning.

---

## Implementation Sketch

### New types (see `src/shared/conversational-prd-types.ts`)

```typescript
ConversationalPrdSession; // full session record
ConversationalPrdMessage; // single turn (user | assistant | system)
ConversationalPrdDraft; // accumulated partial PRD fields
PrdDraftDelta; // field-level delta emitted per assistant turn
ConversationalPrdTurnRequest; // renderer → main: submit a user message
ConversationalPrdTurnResponse; // main → renderer: assistant reply + delta
```

### New gateway interface (in `src/main/delivery-planner/`)

```typescript
export interface ConversationalPrdGateway {
	turn(
		session: ConversationalPrdSession,
		userMessage: string
	): Promise<ConversationalPrdTurnResult>;
}

export interface ConversationalPrdTurnResult {
	assistantMessage: string;
	delta: PrdDraftDelta;
	suggestCommit: boolean;
}
```

### New IPC channels

| Channel                                    | Direction       | Description                                                      |
| ------------------------------------------ | --------------- | ---------------------------------------------------------------- |
| `deliveryPlanner:conversationalPrd:start`  | renderer → main | Create a new `ConversationalPrdSession`, return `conversationId` |
| `deliveryPlanner:conversationalPrd:turn`   | renderer → main | Submit a user message, receive assistant reply + delta           |
| `deliveryPlanner:conversationalPrd:commit` | renderer → main | Commit accumulated draft as a canonical PRD Work Graph item      |
| `deliveryPlanner:conversationalPrd:abort`  | renderer → main | Discard session without committing                               |
| `deliveryPlanner:conversationalPrd:get`    | renderer → main | Retrieve current session state (for reconnect / hot reload)      |
| `deliveryPlanner:conversationalPrd:chunk`  | main → renderer | Push streaming token chunks (optional, for streaming UX)         |

### State storage

```
InMemoryConversationalPrdStore
  conversationId (UUID) → ConversationalPrdSession
  │
  ├─ messages: ConversationalPrdMessage[]    (full turn history)
  ├─ draft: ConversationalPrdDraft           (accumulated PRD fields)
  ├─ status: 'active' | 'committed' | 'aborted'
  └─ metadata: { projectPath, gitPath, startedAt, actor }
```

Optional persistence path: `userData/delivery-planner/conversations/<conversationId>.json` — write after each turn, delete on commit/abort.

### Integration with `DeliveryPlannerService`

`conversationalPrd:commit` calls:

```typescript
service.createPrd({
	title: session.draft.title,
	description: renderPrdDescription(session.draft),
	projectPath: session.metadata.projectPath,
	gitPath: session.metadata.gitPath,
	actor: session.metadata.actor,
});
```

No changes to `DeliveryPlannerService.createPrd` are required — the conversational layer is purely additive.

### Where state lives

- `InMemoryConversationalPrdStore` is instantiated once in `registerDeliveryPlannerHandlers` alongside the existing `InMemoryDeliveryPlannerProgressStore`.
- The `ConversationalPrdGateway` implementation is injected via the handler dependencies (same pattern as `DeliveryPlannerDecompositionGateway`).

### Files to create / modify

| File                                                      | Action                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/shared/conversational-prd-types.ts`                  | **New** — type definitions (this ADR's stub)                                                                       |
| `src/main/delivery-planner/conversational-prd-gateway.ts` | **New** — gateway interface + in-memory stub                                                                       |
| `src/main/delivery-planner/conversational-prd-store.ts`   | **New** — `InMemoryConversationalPrdStore`                                                                         |
| `src/main/ipc/handlers/delivery-planner.ts`               | **Modify** — register 5 new IPC channels                                                                           |
| `src/main/preload/deliveryPlanner.ts`                     | **Modify** — expose new API methods                                                                                |
| `src/shared/delivery-planner-types.ts`                    | **Modify** — add `ConversationalPrdStartRequest`, `ConversationalPrdTurnRequest`, `ConversationalPrdCommitRequest` |

---

## Open Questions

1. **Streaming UX.** Should the assistant response stream token-by-token (requiring `deliveryPlanner:conversationalPrd:chunk` push events) or arrive as a complete response? Token streaming is a better UX but requires a more complex gateway implementation. Recommendation: start with complete-response for the first iteration, add streaming in a follow-up.

2. **Gateway implementation.** The type stub leaves the gateway as an interface. The first concrete implementation should use the Anthropic SDK directly (not via Claude Code PTY). Where should API key / model configuration live — in `MaestroSettings` (reuse `modelSlug` / `apiKey`) or in a new `conversationalPrdSettings` block?

3. **Draft persistence.** In-memory is sufficient for MVP. If the app is quit mid-conversation, the draft is lost. Should we auto-save to `userData/delivery-planner/conversations/`? If yes, when do we prune old drafts?

4. **Concurrency limit.** Should the UI allow multiple simultaneous planning conversations (one per project)? The store supports it, but the UI should probably enforce one-at-a-time per project to avoid confusion.

5. **Handoff to Epic decomposition.** After `commit`, the normal flow is `convertPrdToEpic` → `decomposeEpicToTasks`. Should the conversational planner offer to trigger this automatically, or remain strictly planning-only?

6. **System prompt.** The `ConversationalPrdGateway` needs a planning-specific system prompt. Should this live in `src/prompts/` (editable via the Maestro Prompts tab) or be hardcoded in the gateway? Recommendation: add to `src/prompts/` with a new `PROMPT_IDS` entry.

7. **Acceptance criteria validation.** The commit path calls `service.createPrd(...)` which does not validate that the draft contains acceptance criteria. Should `conversationalPrd:commit` reject drafts that are not `isSufficientlySpecifiedForDispatch`-equivalent, or leave that to the user?
