# Dedup Scan: Cue + Debug Package

Scan date: 2026-03-21
Source: `src/main/cue/` (rc branch, commit 4563239d), `src/main/debug-package/` (main branch)

---

## Part 1: Cue (`src/main/cue/`)

### Function Inventory

```
=== cue-types.ts ===
167: export function createCueEvent(type, triggerName, payload)

=== cue-db.ts ===
 82: function log(level, message)
 96: export function initCueDb(onLog?, dbPathOverride?)
128: export function closeCueDb()
139: export function isCueDbReady()
147: function getDb()
159: export function recordCueEvent(event)
188: export function updateCueEventStatus(id, status)
197: export function getRecentCueEvents(since, limit?)
237: export function updateHeartbeat()
246: export function getLastHeartbeat()
260: export function pruneCueEvents(olderThanMs)
275: export function isGitHubItemSeen(subscriptionId, itemKey)
285: export function markGitHubItemSeen(subscriptionId, itemKey)
297: export function hasAnyGitHubSeen(subscriptionId)
307: export function pruneGitHubSeen(olderThanMs)
318: export function clearGitHubSeenForSubscription(subscriptionId)

=== cue-engine.ts ===
 82: export class CueEngine (methods: start, stop, refreshSession, removeSession,
     getStatus, getActiveRuns, getActivityLog, stopRun, stopAll, isEnabled,
     getQueueStatus, getSettings, getGraphData, triggerSubscription, clearQueue,
     hasCompletionSubscribers, notifyAgentCompleted, clearFanInState,
     dispatchSubscription, initSession, pushActivityLog, hasTimeBasedSubscriptions,
     teardownSession)

=== cue-executor.ts ===
 77: function buildDisplayArgs(args, prompt)
 91: function extractCleanStdout(rawStdout, toolType)
126: export async function executeCuePrompt(config)
456: export function stopCueRun(runId)
477: export function getActiveProcesses()
485: export function getCueProcessList()
509: export function recordCueHistoryEntry(result, session)

=== cue-fan-in-tracker.ts ===
 57: export function createCueFanInTracker(deps)
 61:   function handleFanInTimeout(key, ownerSessionId, settings, sub, sources)

=== cue-file-watcher.ts ===
 25: export function createCueFileWatcher(config)

=== cue-filter.ts ===
 16: function toComparableNumber(value)
 27: function resolveKey(obj, key)
 41: export function matchesFilter(payload, filter)
 97: export function describeFilter(filter)

=== cue-github-poller.ts ===
 16: function execFileAsync(cmd, args, opts?)
 49: export function createCueGitHubPoller(config)
 73:   async function resolveGh()
 86:   async function resolveRepo()
102:   async function pollPRs(repo)
169:   async function pollIssues(repo)
225:   async function doPoll()

=== cue-heartbeat.ts ===
 32: export function createCueHeartbeat(deps)
 35:   function startHeartbeat()
 51:   function stopHeartbeat()
 58:   function detectSleepAndReconcile()

=== cue-reconciler.ts ===
 34: export function reconcileMissedTimeEvents(config)

=== cue-run-manager.ts ===
 83: export function createCueRunManager(deps)
 89:   function getSessionName(sessionId)
 93:   function drainQueue(sessionId)
137:   async function doExecuteCueRun(sessionId, prompt, event, ...)

=== cue-subscription-setup.ts ===
 25: export function calculateNextScheduledTime(times, days?)
 79: export function setupHeartbeatSubscription(deps, session, state, sub)
145: export function setupScheduledSubscription(deps, session, state, sub)
234: export function setupFileWatcherSubscription(deps, session, state, sub)
279: export function setupGitHubPollerSubscription(deps, session, state, sub)
318: export function setupTaskScannerSubscription(deps, session, state, sub)

=== cue-task-scanner.ts ===
 36: export function extractPendingTasks(content)
 57: function walkDir(dir, root)
 87: export function createCueTaskScanner(config)
 99:   function hashContent(content)
103:   async function doScan()

=== cue-activity-log.ts ===
 18: export function createCueActivityLog(maxSize?)
```

### Duplication Findings

#### 1. LOCAL `execFileAsync` REIMPLEMENTS SHARED UTILITY

**File:** `cue-github-poller.ts:16`
**Duplicate of:** `src/main/utils/execFile.ts:6` (`const execFileAsync = promisify(execFile)`)

The github poller defines its own `execFileAsync` wrapper around `child_process.execFile`:

```typescript
// cue-github-poller.ts
function execFileAsync(cmd, args, opts?) {
    return new Promise((resolve, reject) => {
        cpExecFile(cmd, args, { ...opts, env: ghEnv }, (error, stdout, stderr) => { ... });
    });
}
```

However, this version injects `ghEnv` as the environment, which the shared version does not. This is intentional - the local version hardcodes the expanded env for `gh` detection. The shared `execFileNoThrow` from `src/main/utils/execFile.ts` would be a cleaner approach if extended to accept an `env` option.

**Severity:** LOW - The local version serves a specific purpose (injecting expanded env). Could be refactored to use the shared version with an env parameter.

#### 2. `walkDir` REIMPLEMENTS DIRECTORY WALKING

**File:** `cue-task-scanner.ts:57`
**Similar to:** Various directory walk implementations in the codebase

The task scanner has its own recursive `walkDir(dir, root)` function that skips `node_modules`, `.git`, `.next`. This is a common pattern but not extracted to shared utils. Other places in the codebase that walk directories (storage collector, filesystem handlers) use their own implementations.

**Severity:** LOW - The function is simple and the skip list is task-scanner-specific.

#### 3. DB ACCESS PATTERN DUPLICATES stats-db.ts

**File:** `cue-db.ts`
**Similar to:** `src/main/stats/stats-db.ts`

Both files follow the same pattern:
- Module-level `let db: Database.Database | null = null`
- `init*Db()` / `close*Db()` lifecycle functions
- `getDb()` internal accessor with "not initialized" guard
- WAL mode pragma
- CREATE TABLE IF NOT EXISTS SQL strings
- Prune functions with age-based deletion

This is acknowledged in the file header: "Uses the same `better-sqlite3` pattern as `src/main/stats/stats-db.ts`."

**Severity:** MEDIUM - Both DB modules could share a base DB wrapper utility (init, close, getDb guard, WAL setup, prune). However, the tables and queries are domain-specific, so only the lifecycle boilerplate is truly duplicated (~30 lines).

#### 4. SSH WRAPPING - PROPERLY REUSES SHARED UTILITY

**File:** `cue-executor.ts:8`
**Uses:** `src/main/utils/ssh-spawn-wrapper.ts` (`wrapSpawnWithSsh`)

No duplication here. The executor correctly imports and uses the shared SSH wrapper, matching the same pattern as `group-chat-router.ts` and `group-chat-agent.ts`.

#### 5. AGENT ARGS BUILDING - PROPERLY REUSES SHARED UTILITY

**File:** `cue-executor.ts:9-10`
**Uses:** `src/main/utils/agent-args.ts` (`buildAgentArgs`, `applyAgentConfigOverrides`)

No duplication. The executor correctly uses the shared agent argument builder.

#### 6. CLI DETECTION - PROPERLY REUSES SHARED UTILITY

**File:** `cue-github-poller.ts:4`
**Uses:** `src/main/utils/cliDetection.ts` (`resolveGhPath`, `getExpandedEnv`)

No duplication. The GitHub poller correctly uses the shared CLI detection utilities.

#### 7. FILTER ENGINE IS SELF-CONTAINED (NO DUPLICATION)

`cue-filter.ts` implements a domain-specific filter matching engine (exact match, negation, numeric comparison, glob patterns, dot-notation). No similar general-purpose filter engine exists elsewhere in the codebase. This is appropriately scoped.

#### 8. CHOKIDAR USAGE - ISOLATED BUT REPEATED

**Files:** `cue-file-watcher.ts`, `cue-yaml-loader.ts`
**Also used in:** Various places across the codebase

Both the file watcher and YAML loader create their own chokidar instances. This is expected since they watch different paths with different options. No meaningful dedup opportunity.

### Cue Internal Patterns

The cue directory shows good internal decomposition (refactored in commit `8af9ffc2` from a monolithic `cue-engine.ts` into 5 focused modules). The factory pattern (`createCueFanInTracker`, `createCueHeartbeat`, `createCueRunManager`, etc.) with dependency injection keeps modules testable and decoupled.

---

## Part 2: Debug Package (`src/main/debug-package/`)

### Function Inventory

```
=== index.ts ===
 67: export async function generateDebugPackage(outputDir, deps, options?)
294: export function previewDebugPackage()

=== packager.ts ===
 32: function generateReadme()
 79: export async function createZipPackage(outputDir, contents)

=== collectors/agents.ts ===
 34: export async function collectAgents(agentDetector)

=== collectors/batch-state.ts ===
 30: export function collectBatchState(sessionsStore)

=== collectors/errors.ts ===
 29: function sanitizeErrorEntry(entry)
 41: export function collectErrors(sessionsStore)

=== collectors/external-tools.ts ===
 38: export async function collectExternalTools()

=== collectors/group-chats.ts ===
 26: function countMessages(logPath)
 42: export async function collectGroupChats()

=== collectors/logs.ts ===
 32: function sanitizeEntry(entry)
 45: export function collectLogs(limit?)

=== collectors/processes.ts ===
 26: export async function collectProcesses(processManager)

=== collectors/sanitize.ts ===
 13: export function sanitizePath(pathStr)
 26: export function sanitizeText(text)
 43: export function sanitizeLogMessage(message)

=== collectors/sessions.ts ===
 42: export async function collectSessions(sessionsStore)

=== collectors/settings.ts ===
 52: function isSensitiveKey(key)
 60: function isPathKey(key)
 68: function sanitizeObject(obj, sanitizedFields, prefix?)
105: export async function collectSettings(settingsStore, bootstrapStore?)

=== collectors/storage.ts ===
 35: function getDirectorySize(dirPath)
 72: function getFileSize(filePath)
 87: export async function collectStorage(bootstrapStore?)

=== collectors/system.ts ===
 39: export function collectSystemInfo()

=== collectors/web-server.ts ===
 31: export async function collectWebServer(webServer)

=== collectors/windows-diagnostics.ts ===
 49: export async function collectWindowsDiagnostics()
 75: async function collectNpmInfo()
100: function checkInstallationDirectories()
```

### Duplication Findings

#### 1. `getDirectorySize` - LOCAL IMPLEMENTATION

**File:** `collectors/storage.ts:35`
**Similar to:** `src/main/utils/remote-fs.ts:419` (`directorySizeRemote`)
**Similar to:** `src/main/ipc/handlers/filesystem.ts:224` (IPC handler `fs:directorySize`)

The storage collector has a local `getDirectorySize(dirPath)` that recursively sums file sizes. The main codebase has `directorySizeRemote` in `remote-fs.ts` for SSH-aware directory sizing, and an IPC handler `fs:directorySize` that delegates to it.

The local version is simpler (no SSH, synchronous), which is appropriate for the debug package context where it runs in the main process with local-only paths. However, there's no shared local-only `getDirectorySize` utility.

**Severity:** LOW - The local version is simpler and synchronous by design. A shared utility would add unnecessary complexity for this use case.

#### 2. `sanitizeErrorEntry` DUPLICATES `sanitizeEntry`

**File:** `collectors/errors.ts:29` (`sanitizeErrorEntry`)
**Identical to:** `collectors/logs.ts:32` (`sanitizeEntry`)

Both functions do the exact same thing:
```typescript
function sanitizeErrorEntry(entry: LogEntry): SanitizedLogEntry {
    return {
        timestamp: entry.timestamp,
        level: entry.level,
        message: sanitizeLogMessage(entry.message),
        context: entry.context,
    };
}
```

**Severity:** HIGH - These are byte-for-byte identical. The `sanitizeEntry` function from `logs.ts` should be exported and imported by `errors.ts` instead of reimplementing it. Or move the function to `sanitize.ts`.

#### 3. COLLECTOR PATTERN - STRUCTURAL REPETITION IN index.ts

**File:** `index.ts:87-252`

The `generateDebugPackage()` function has 12 nearly identical try/catch blocks:

```typescript
try {
    const result = collectX(...);
    contents['x.json'] = result;
    filesIncluded.push('x.json');
} catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    errors.push(`x: ${errMsg}`);
    logger.error('Failed to collect x', 'DebugPackage', error);
}
```

This pattern repeats for: system, settings, agents, external-tools, windows-diagnostics, groups, sessions, processes, logs, errors, web-server, storage, group-chats, batch-state.

**Severity:** MEDIUM - Could be reduced to a loop over a collector registry:
```typescript
const collectors = [
    { id: 'system-info', fn: () => collectSystemInfo(), alwaysInclude: true },
    { id: 'sessions', fn: () => collectSessions(deps.sessionsStore), optional: 'includeSessions' },
    // ...
];
for (const c of collectors) {
    if (c.optional && !opts[c.optional]) continue;
    try {
        contents[`${c.id}.json`] = await c.fn();
        filesIncluded.push(`${c.id}.json`);
    } catch (error) { ... }
}
```

This would reduce ~170 lines to ~30 lines and make adding new collectors trivial.

#### 4. `execFileNoThrow` - PROPERLY REUSES SHARED UTILITY

**Files:** `collectors/external-tools.ts`, `collectors/windows-diagnostics.ts`
**Uses:** `src/main/utils/execFile.ts` (`execFileNoThrow`)

No duplication. Both collectors correctly import from the shared utility.

#### 5. `sanitizePath` - UNIQUE TO DEBUG PACKAGE (NO WIDER DUPLICATE)

The `sanitize.ts` module provides `sanitizePath`, `sanitizeText`, `sanitizeLogMessage`. These are debug-package-specific (replace home dir with `~`, truncate long messages). No similar sanitization exists elsewhere in the codebase. This is appropriately scoped.

#### 6. `isCloudflaredInstalled` - PROPERLY REUSES SHARED UTILITY

**Files:** `collectors/external-tools.ts:13`, `collectors/web-server.ts:10`
**Uses:** `src/main/utils/cliDetection.ts`

No duplication. Both collectors correctly import from the shared utility.

---

## Summary

### Cue - Action Items

| # | Severity | Finding | Recommendation |
|---|---|---|---|
| 1 | LOW | `execFileAsync` in cue-github-poller | Consider extending shared `execFileNoThrow` to accept env option |
| 2 | LOW | `walkDir` in cue-task-scanner | Keep as-is; skip list is domain-specific |
| 3 | MEDIUM | DB lifecycle boilerplate duplicates stats-db | Extract shared `createSqliteDb(path, schemas, options)` helper |

### Debug Package - Action Items

| # | Severity | Finding | Recommendation |
|---|---|---|---|
| 1 | HIGH | `sanitizeErrorEntry` identical to `sanitizeEntry` | Export `sanitizeEntry` from logs.ts, import in errors.ts |
| 2 | MEDIUM | 12 identical try/catch blocks in index.ts | Refactor to collector registry loop pattern |
| 3 | LOW | `getDirectorySize` is local-only | Keep as-is; simpler sync version appropriate for context |

### Cross-Module

| # | Severity | Finding | Recommendation |
|---|---|---|---|
| 1 | MEDIUM | Both cue-db and stats-db duplicate SQLite lifecycle boilerplate | Shared base DB module could eliminate ~30 lines per consumer |
