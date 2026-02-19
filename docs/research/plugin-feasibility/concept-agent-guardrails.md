---
type: research
title: "Plugin Concept: Agent Guardrails"
created: 2026-02-18
tags:
  - plugin
  - concept
  - guardrails
related:
  - "[[extension-points]]"
  - "[[concept-ai-auditor]]"
  - "[[concept-agent-dashboard]]"
  - "[[concept-notifications]]"
  - "[[concept-external-integration]]"
---

# Plugin Concept: Agent Guardrails

An active enforcement plugin that can intercept and block agent actions, enforce token budgets, and kill or pause agents that violate policy. Unlike the [[concept-ai-auditor|AI Auditor]], which is purely observational, Guardrails requires the ability to **intervene** in the event pipeline — making it the hardest plugin concept in this feasibility study.

---

## Core Requirement: Interception, Not Just Observation

The Auditor listens to events after they've fired. Guardrails must either:
- **Prevent** an event from reaching downstream listeners (true interception), or
- **React** to an event by killing/pausing the agent before damage completes (reactive kill)

This distinction drives the entire architectural analysis below.

---

## Architecture Analysis

### ProcessManager Event Emission Chain

From `src/main/process-manager/ProcessManager.ts`:

```
Agent stdout → StdoutHandler.handleData()
  → StdoutHandler.processLine() → handleParsedEvent()
    → this.emitter.emit('tool-execution', sessionId, toolExecution)
    → this.emitter.emit('thinking-chunk', sessionId, text)
    → bufferManager.emitDataBuffered(sessionId, data)
      → DataBufferManager accumulates (max 8KB or 50ms)
      → flushDataBuffer() → emitter.emit('data', sessionId, data)
```

Key insight: by the time `tool-execution` is emitted, the **agent has already decided** to use the tool. For Claude Code and similar agents, the tool use block indicates intent — the agent is waiting for tool output, meaning the tool execution may already be in progress. This limits the value of pre-forwarding interception for some agents, but not all.

### ProcessManager.kill() and interrupt() Behavior

```typescript
kill(sessionId: string): boolean    // Flushes data buffer, sends SIGTERM, removes from map
interrupt(sessionId: string): boolean // Sends SIGINT, escalates to SIGTERM after 2000ms
```

Both are synchronous boolean returns. `kill()` is immediate and final. `interrupt()` gives the agent a chance to clean up but guarantees termination within 2 seconds. Neither is async — a guardrail plugin can invoke them without awaiting.

No `pause()` API exists. The only intervention options are interrupt (graceful stop with 2s timeout) and kill (immediate).

---

## Approach A: Event Middleware (Intercept Before Forwarding)

### How It Would Work

Insert a guard function between ProcessManager event emission and `forwarding-listeners.ts` forwarding to renderer:

```typescript
// In forwarding-listeners.ts (current):
processManager.on('tool-execution', (sessionId, toolEvent) => {
    safeSend('process:tool-execution', sessionId, toolEvent);
});

// With middleware (proposed):
processManager.on('tool-execution', async (sessionId, toolEvent) => {
    const decision = await pluginGuard.evaluateToolExecution(sessionId, toolEvent);
    if (decision === 'allow') {
        safeSend('process:tool-execution', sessionId, toolEvent);
    } else {
        processManager.kill(sessionId);
        safeSend('process:guardrail-blocked', sessionId, {
            toolEvent,
            reason: decision.reason,
        });
    }
});
```

### Insertion Point: `forwarding-listeners.ts`

`src/main/process-listeners/forwarding-listeners.ts` is a thin forwarder — it registers five `processManager.on(...)` handlers that call `safeSend()`. This is the **cleanest insertion point** because:

1. It sits between ProcessManager events and the renderer
2. It already depends on `ProcessListenerDependencies.safeSend` — adding a guard dependency is natural
3. No other listeners depend on it — blocking here doesn't break the main process event chain

### Critical Limitation: EventEmitter Has No Cancellation

Node.js `EventEmitter.on()` has no built-in way to cancel event propagation. All registered listeners fire in registration order, unconditionally. This means:

- **A middleware at the forwarding layer cannot prevent other listeners from seeing the event.** The ProcessManager emits `tool-execution`, and all registered listeners (forwarding, stats, group-chat routing) all fire. The middleware can only prevent the `safeSend()` call, suppressing renderer notification.
- **Other main-process listeners (stats recording, group chat routing) would still process the event.** This is acceptable for most guardrail use cases — the goal is to stop the agent, not pretend the event never happened.

### Would Modifying EventEmitter.emit() Break Tests?

Wrapping `EventEmitter.emit()` to support cancellation is possible but **inadvisable**:

1. ProcessManager is used throughout the codebase — any behavioral change to `emit()` risks breaking existing listeners
2. The existing test suite (verified via process-manager tests) relies on standard EventEmitter behavior
3. A custom `emit()` wrapper would be a non-standard pattern that surprises future developers

**Verdict: Do not modify EventEmitter.emit().** The forwarding-listener insertion point is sufficient.

### Alternative: StdoutHandler.handleParsedEvent() Hook

A deeper insertion point exists at `StdoutHandler.handleParsedEvent()` — this is where tool-execution events are first created from parsed output. A hook here would fire **before** the event reaches any listener. However:

- `StdoutHandler` is a private implementation detail of ProcessManager, not an extension point
- Refactoring it to accept plugin callbacks adds complexity to a hot path (every line of agent output)
- The benefit over forwarding-listener interception is marginal: both fire within the same event loop tick

**Not recommended for v1.** Consider only if forwarding-level interception proves too late.

---

## Approach B: Observer + Reactive Kill

### How It Would Work

The guardrail plugin subscribes to events using the same `processManager.on(...)` API as any other listener. When it detects a policy violation, it calls `processManager.kill(sessionId)` or `processManager.interrupt(sessionId)`.

```typescript
processManager.on('tool-execution', (sessionId, toolExecution) => {
    if (guardrailRules.isViolation(toolExecution)) {
        processManager.interrupt(sessionId);  // graceful stop
        auditLog.record(sessionId, 'blocked', toolExecution);
    }
});

processManager.on('usage', (sessionId, usageStats) => {
    if (usageStats.totalCostUsd > budget.maxCostPerSession) {
        processManager.kill(sessionId);  // hard stop
        auditLog.record(sessionId, 'budget-exceeded', usageStats);
    }
});
```

### Latency Analysis

**Question: What's the latency between observing a tool-execution event and the kill taking effect?**

1. `tool-execution` event emitted by StdoutHandler → guardrail listener fires (same event loop tick, ~0ms)
2. Guardrail evaluates rules (synchronous pattern matching, ~0ms)
3. `processManager.kill(sessionId)` called → sends SIGTERM to PTY/child process (synchronous, ~0ms)
4. OS delivers SIGTERM → agent process terminates (OS-dependent, typically <10ms)

**Total latency: sub-millisecond from event to kill signal, <10ms to process termination.**

However, the relevant question is: **what has the agent already done by the time the tool-execution event fires?**

- **For Claude Code (PTY mode):** The tool-execution event fires when the agent *announces* it will use a tool. Claude Code's tools are executed by the Claude Code CLI itself, not by Maestro. By the time Maestro sees the tool-execution event, the CLI may have already begun executing (or completed) the tool. The kill signal stops future actions but **cannot undo the current tool execution**.
- **For Codex (stream-JSON mode):** Codex emits `status: 'running'` when a tool starts and `status: 'completed'` when it finishes. The guardrail can react to `running` before completion, but the tool is already executing.
- **For OpenCode:** Similar to Codex — the `running` event fires as execution begins.

**Verdict: Reactive kill is fast enough to prevent *subsequent* tool executions but cannot guarantee prevention of the *current* tool execution.** This is acceptable for most guardrail use cases: stopping a chain of dangerous operations rather than preventing a single atomic action.

### Is This Fast Enough to Prevent Damage?

For multi-step destructive operations (e.g., `rm -rf` across multiple directories, a series of force-pushes), reactive kill is highly effective — the first violation triggers termination before the second action begins.

For single atomic destructive operations (e.g., one `rm -rf /important-dir`), the damage is done by the time the event fires. The guardrail can only log the violation and prevent further harm.

**Mitigation:** Pair the reactive guardrail with agent-native safety features (e.g., Claude Code's `--allowedTools` flag, per-project `.claude/settings.json` deny rules). Agent-native controls operate *before* tool execution; the plugin guardrail operates *after* the event.

---

## Token Budget Enforcement

### Data Available via `onUsage()`

```typescript
interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    totalCostUsd: number;    // Cumulative USD cost
    contextWindow: number;   // Context window fill percentage (0-1)
    reasoningTokens?: number;
}
```

`onUsage()` fires after each agent response. `totalCostUsd` is **cumulative per session** — no aggregation needed.

### Implementation

```typescript
processManager.on('usage', (sessionId, stats) => {
    const budget = pluginConfig.getBudget(sessionId);

    // Hard cost cap
    if (stats.totalCostUsd > budget.maxCostUsd) {
        processManager.kill(sessionId);
        notifyUser(`Agent killed: exceeded $${budget.maxCostUsd} budget`);
    }

    // Token limit (input + output)
    const totalTokens = stats.inputTokens + stats.outputTokens;
    if (totalTokens > budget.maxTokens) {
        processManager.interrupt(sessionId);
        notifyUser(`Agent interrupted: exceeded ${budget.maxTokens} token limit`);
    }

    // Context window warning (approaching limit)
    if (stats.contextWindow > budget.contextWarningThreshold) {
        notifyUser(`Warning: agent at ${Math.round(stats.contextWindow * 100)}% context window`);
    }
});
```

The `kill` API is already exposed to the renderer via `window.maestro.process.kill(sessionId)`, so a renderer-only plugin could also enforce budgets. However, a main-process plugin would have lower latency and could enforce budgets even if the renderer is unresponsive.

---

## Group Chat Session Filtering

### Prior Art: `GROUP_CHAT_PREFIX` Pattern

From `src/main/process-listeners/types.ts`:

```typescript
export const GROUP_CHAT_PREFIX = 'group-chat-';
```

Every process listener uses a two-tier filter:
1. `sessionId.startsWith('group-chat-')` — O(1) skip for the common case
2. Regex matching (`REGEX_MODERATOR_SESSION`, `REGEX_BATCH_SESSION`, etc.) — only when needed

A guardrail plugin should follow this pattern to:
- **Apply guardrails to user-facing agents** (standard session IDs)
- **Optionally apply to group chat participants** (session IDs matching `group-chat-*`)
- **Skip internal sessions** (`REGEX_BATCH_SESSION`, `REGEX_SYNOPSIS_SESSION`) — guardrails should not interfere with background operations

The `patterns` object from `ProcessListenerDependencies` provides all necessary regexes. A guardrail plugin registered via `setupPluginListeners(processManager, deps)` would receive these through the same dependency injection pattern.

---

## Recommended Approach

### Approach B (Observer + Reactive Kill) for v1

**Rationale:**

| Criterion | Approach A (Middleware) | Approach B (Observer + Kill) |
|-----------|------------------------|------------------------------|
| Core architecture changes | Requires modifying forwarding-listeners.ts | Zero changes to core — standard event listener |
| Risk to existing behavior | Medium — safeSend wrapping could affect event ordering | None — additive listener only |
| Interception granularity | Can suppress renderer notification | Can kill process but can't suppress events |
| Implementation complexity | Medium — async middleware in synchronous emit chain | Low — standard pattern matching + kill call |
| Latency to intervention | ~0ms (suppresses forward) | ~0ms (sends kill signal) |
| Effectiveness | Blocks UI display but agent still runs until killed | Kills agent; UI sees event + kill notification |
| Test impact | Must verify forwarding still works correctly | No impact on existing tests |

**Approach B is recommended because:**

1. **Zero core changes.** The guardrail registers as a standard listener — no modification to ProcessManager, forwarding-listeners, or EventEmitter behavior. This is critical for plugin system safety.
2. **Sufficient for real-world use.** The primary value of guardrails is stopping agents that are in a dangerous loop, not preventing a single atomic action. Reactive kill handles this well.
3. **Natural progression from Auditor.** The [[concept-ai-auditor|AI Auditor]] plugin establishes the event observation pattern. Guardrails adds `kill()`/`interrupt()` calls — a small delta, not a new architecture.
4. **Main-process component provides lowest latency.** A guardrail listener registered directly on ProcessManager fires in the same event loop tick as the event, with synchronous access to `kill()`.

### Consider Approach A for v2

If users require pre-execution blocking (e.g., showing a confirmation dialog before a destructive tool runs), Approach A's forwarding-listener middleware becomes necessary. This would:
1. Hold the `safeSend` call pending user approval
2. The agent process is suspended (via `interrupt()`) while waiting
3. On approval, forward the event and resume; on denial, kill

This requires async middleware in the forwarding pipeline, which is a more significant change. Defer until v1 usage validates demand.

---

## Feasibility Verdict

### Rating: **Moderate-Hard**

The reactive guardrail (Approach B) is straightforward to implement with existing APIs. The difficulty comes from: (1) the inherent limitation that tool execution may complete before the kill signal arrives, (2) the need for a main-process plugin component for lowest-latency enforcement, and (3) the configuration complexity of defining useful guardrail rules.

### Required New Infrastructure

| Infrastructure | Needed For | Complexity | Shared? |
|----------------|-----------|------------|---------|
| Plugin manifest + loader | Loading the plugin | Medium | Yes — all plugins need this |
| Plugin UI registration | Mounting guardrail config panel and alert UI | Medium | Yes — all UI plugins need this |
| Sandboxed API surface | Restricting to read-only events + kill/interrupt | Medium | Yes — with **write** access to kill/interrupt APIs |
| **Main-process plugin listener registration** | Registering guardrail listener on ProcessManager | Medium | Yes — Auditor also benefits from this |
| **Plugin-scoped storage API** | Persisting guardrail rules and violation log | Medium | Yes — shared with Auditor (Gap #8 from [[extension-points]]) |
| **Process control API for plugins** | Exposing `kill()` and `interrupt()` to plugin code | Low | Partial — only enforcement plugins need write access to process control |

### Infrastructure NOT Required (for v1)

- No EventEmitter modification or custom emit wrapper
- No middleware/interception layer in forwarding-listeners
- No new event types (existing tool-execution, usage, exit are sufficient)
- No pause/resume API (kill and interrupt are sufficient)

### Comparison to Other Concepts

| Concept | Rating | Key Differentiator |
|---------|--------|-------------------|
| [[concept-agent-dashboard\|Agent Dashboard]] | Trivial | Purely read-only renderer component |
| [[concept-ai-auditor\|AI Auditor]] | Moderate | Read-only but needs storage |
| **Agent Guardrails** | **Moderate-Hard** | Needs process control (kill) + storage + session filtering |
| [[concept-notifications\|Notifications]] | TBD | Needs outbound HTTP |
| [[concept-external-integration\|External Integration]] | TBD | Needs web server routes |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Kill signal arrives after tool execution completes | Certain for single-action | Medium | Document limitation; recommend pairing with agent-native deny rules; effective for multi-step chains |
| False positive kills interrupt legitimate work | Medium | High | Conservative default rules; require explicit opt-in for kill-on-violation; warning mode before kill mode |
| Guardrail rules too complex for users to configure | Medium | Medium | Ship sensible defaults; provide rule presets (e.g., "no force pushes", "no recursive deletes", "cost cap") |
| Plugin kill() access is a security concern | Low | High | Restrict to approved plugins only; require explicit user consent for process-control permission |
| Token budget enforcement races with multiple rapid usage events | Low | Low | `totalCostUsd` is cumulative — each event has the latest total; no aggregation race possible |
| Group chat / batch sessions incorrectly subject to guardrails | Medium | Medium | Follow existing `GROUP_CHAT_PREFIX` + regex pattern for session filtering; skip internal sessions by default |
| Main-process plugin component adds crash risk | Low | High | Plugin code runs in try/catch; errors captured by Sentry; plugin crash should not crash ProcessManager |
