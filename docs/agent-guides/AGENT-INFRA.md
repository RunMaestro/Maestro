---
type: reference
title: Agent Infrastructure
created: 2026-05-14
tags:
  - agents
  - storage
  - ipc
related:
  - '[[CLAUDE-AGENTS]]'
  - '[[CLAUDE-IPC]]'
  - '[[IPC-PATTERNS]]'
---

# Agent Infrastructure

Cross-cutting infrastructure that all agents plug into: per-agent session
storage, the external-session watcher pipeline, and the renderer-facing IPC
bridge that surfaces externally-spawned agent activity. Read this when you are
adding a new agent or extending the visibility surface for an existing one.

For the agent capability matrix see [[CLAUDE-AGENTS]]. For the full IPC namespace
listing see [[CLAUDE-IPC]]. For the cross-cutting IPC subscription pattern (event
channels, cleanup contracts, renderer bookkeeping) see
[IPC-PATTERNS](./IPC-PATTERNS.md).

---

## `getStorageWatchSpec()` — the storage extension point

Each agent's session-storage class extends `BaseSessionStorage`
(`src/main/storage/base-session-storage.ts`). To opt the agent into external
session visibility, override `getStorageWatchSpec()` and return a
`StorageWatchSpec`.

```typescript
interface StorageWatchSpec {
	rootDir: string;
	fileMatcher: (relPath: string) => { sessionId: string; projectPath: string } | null;
	activityEvent?: 'append' | 'create';
}
```

- **`rootDir`** — absolute path to the directory the watcher should observe
  recursively. Missing or unreadable directories are tolerated; same-user scope
  means it is normal for some agents to be uninstalled on a given host.
- **`fileMatcher`** — pure, synchronous function from a path **relative to
  `rootDir`** to a `{ sessionId, projectPath }` match, or `null` for paths that
  don't correspond to a tracked session (sidecar metadata, wrong depth,
  unrelated junk). It runs on every chokidar event, so it must not perform I/O.
- **`activityEvent`** — which file event represents live activity for this
  agent. Default `'append'` (existing per-session JSONL grows in place — Claude
  Code, Codex, Copilot CLI, Factory Droid). Use `'create'` when each new message
  arrives as a brand-new file in a per-session directory (OpenCode pre-v1.2 JSON
  layout).

The default `BaseSessionStorage.getStorageWatchSpec()` returns `null`, meaning
"this agent doesn't expose externally observable session files." Storage classes
without per-session files on a stable path should leave the default in place.

### Example: append-style (Claude Code)

```typescript
// src/main/storage/claude-session-storage.ts
getStorageWatchSpec(): StorageWatchSpec | null {
	return {
		rootDir: this.getProjectsDir(),
		fileMatcher: (relPath) => {
			const segments = relPath.split(path.sep);
			if (segments.length !== 2) return null;
			const [encodedProjectSegment, fileName] = segments;
			if (!fileName.endsWith('.jsonl')) return null;
			return {
				sessionId: fileName.slice(0, -'.jsonl'.length),
				projectPath: encodedProjectSegment,
			};
		},
		activityEvent: 'append',
	};
}
```

### Example: create-style (OpenCode)

```typescript
// src/main/storage/opencode-session-storage.ts
getStorageWatchSpec(): StorageWatchSpec | null {
	return {
		rootDir: OPENCODE_STORAGE_DIR,
		fileMatcher: (relPath) => {
			const segments = relPath.split(path.sep);
			if (segments.length !== 3) return null;
			const [, sessionSegment, fileName] = segments;
			if (!fileName.endsWith('.json')) return null;
			return { sessionId: sessionSegment, projectPath: '' };
		},
		activityEvent: 'create',
	};
}
```

Wire-up is automatic — the coordinator iterates the storage registry on boot,
calls `getStorageWatchSpec()` on every entry, and starts a `SessionFileWatcher`
for any spec it gets back. No further plumbing is required.

---

## `ExternalSessionCoordinator` — boot contract

**Where it lives:** `src/main/storage/external-session-coordinator.ts`.

**When it starts:** during main-process boot in `src/main/index.ts`, after the
process manager and the storage registry are constructed. The coordinator is
held as a module-level singleton and constructed with:

```typescript
externalSessionCoordinator = new ExternalSessionCoordinator({
	processManager,
	storageRegistry,
});
externalSessionCoordinator.start().catch((err) => {
	logger.error(`Failed to start ExternalSessionCoordinator: ${err}`, 'Startup');
});
```

`start()` walks the storage registry, reads each agent's `StorageWatchSpec`,
and launches one `SessionFileWatcher` per agent that exposes one. Per-watcher
failures are logged but never fatal — a single misbehaving agent must not bring
the whole coordinator down.

**Two responsibilities the per-agent watcher doesn't handle on its own:**

1. **Source annotation / dedup.** Maestro itself may already be driving a
   session whose JSONL the watcher would otherwise classify as "external."
   The coordinator stamps `source: 'local' | 'external'` by asking
   `ProcessManager.findByAgentSessionId(event.sessionId)`. Sessions Maestro
   owns are still folded into the coalesced state map (so the renderer sees
   one consistent view), but per-file `'append'` / `'create'` events are
   suppressed for them — the stats DB would otherwise get a second insert via
   the process-driven path.
2. **Burst coalescing.** Bulk imports or chatty agents can fire many
   append/create events in quick succession. The coordinator debounces the
   outward `'state-changed'` emission to 100ms (`STATE_CHANGE_DEBOUNCE_MS`) so
   renderer state churn stays sane.

**Shutdown:** `stop()` is wired into the quit handler (`src/main/app-lifecycle/
quit-handler.ts` → `stopExternalSessionCoordinator`). It cancels the pending
debounce timer, stops every watcher in parallel, and clears the state map. Safe
to call multiple times.

**Same-user, local-FS scope only.** Cross-user observation is out of scope —
Maestro will only see sessions owned by the OS user running the app. SSH remote
watching is also out of scope; see `SessionFileWatcher` for the underlying
constraints.

---

## IPC bridge — surfacing activity to the renderer

The coordinator's two outbound channels feed two distinct consumers:

| Coordinator event       | Consumer                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `'state-changed'`       | Renderer (via `EXTERNAL_ACTIVITY_CHANNEL = 'storage:externalActivity'`)                        |
| `'append'` / `'create'` | In-process `external-stats-ingester.ts` — tails the JSONL deltas to mirror usage into stats DB |

The renderer subscribes through the preload bridge:

```typescript
// hydrate
const initial = await window.maestro.storage.listExternalSessions();

// subscribe
const unsubscribe = window.maestro.storage.onExternalActivity((events) => {
	// events: SessionActivityEvent[]
});
```

Handlers are registered by `registerExternalSessionsHandlers()` in
`src/main/ipc/handlers/external-sessions.ts`, which:

1. exposes `'storage:list-external-sessions'` → returns
   `Array.from(coordinator.getState().values())` for renderer hydration, and
2. forwards every coordinator `'state-changed'` payload onto the
   `'storage:externalActivity'` channel via `safeSend`.

The preload-side wrapper (`src/main/preload/storage.ts`) is the canonical place
to learn the on-the-wire shape; the renderer hook
`src/renderer/hooks/session/useExternalSessionActivity.ts` shows the expected
hydrate-then-subscribe pattern. For the broader IPC subscription / cleanup
contract, see [IPC-PATTERNS](./IPC-PATTERNS.md).

---

## Adding a new agent — checklist

1. Create the storage class extending `BaseSessionStorage`
   (`src/main/storage/<agent>-session-storage.ts`).
2. Override `getStorageWatchSpec()` if the agent persists per-session files on
   a stable path. Pick `activityEvent: 'append'` for JSONL-grow agents,
   `'create'` for per-message-file agents.
3. Register the storage in `src/main/storage/index.ts` (`initializeSessionStorages`).
4. Done — the coordinator picks the new agent up automatically on next boot.
   No coordinator, IPC handler, preload, or renderer changes are required for
   visibility.

If the agent does not write per-session files (e.g., terminal), leave the
default `getStorageWatchSpec(): null` in place. It will be quietly skipped.
