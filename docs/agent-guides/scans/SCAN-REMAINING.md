# Dedup Scan: Remaining Systems

Scan of context providers, renderer types, web utilities, and symphony runner for duplication.

---

## 1. Context Providers (`src/renderer/contexts/`)

### Context vs. Store Overlap Check

No duplication found. Each context provides data that does not exist in any zustand store:

| Context | Data Source | Store Equivalent? |
|---------|------------|-------------------|
| GitStatusContext | `useGitStatusPolling` (IPC polling) | None - no store polls git |
| InlineWizardContext | `useInlineWizard` hook | None - wizard state is context-only |
| InputContext | Local `useState` calls | None - completion state not in stores |
| LayerStackContext | `useLayerStack` hook | None - layer management not in stores |

### Usage Analysis

```
grep -rn "useContext.*GitStatus|useContext.*InlineWizard|useContext.*Input\b|useContext.*LayerStack" src/renderer/
```

Results - raw `useContext` calls only appear inside the context definition files themselves (3 total). All external consumers use the exported hooks (`useGitBranch`, `useInputContext`, etc.), which is the intended pattern.

**Consumer counts by hook:**
- `useLayerStack` - 20+ consumers (every modal/overlay component)
- `useGitFileStatus` - 3 consumers
- `useGitDetail` - 2 consumers
- `useGitBranch` - 1 consumer
- `useInputContext` - 3 consumers
- `useInlineWizardContext` - 2 consumers
- `useGitStatus` (legacy/deprecated) - 0 external consumers

### Finding: Deprecated Hook With Zero Consumers

`useGitStatus()` in GitStatusContext.tsx is marked `@deprecated` and has 0 external consumers. The legacy `GitStatusContext` and its provider nesting could be removed. Low priority since it adds minimal code and no runtime cost when unused.

### Finding: No Duplication

All four contexts serve distinct, non-overlapping purposes. No context duplicates store functionality.

---

## 2. Renderer Types (`src/renderer/types/`)

### All Type Exports

```
grep -rn "export type|export interface" src/renderer/types/ --include="*.ts"
```

81 total exports across 4 files:
- `index.ts` - 61 exports (including re-exports from shared)
- `contextMerge.ts` - 10 interfaces
- `layer.ts` - 9 types/interfaces
- `fileTree.ts` - 1 interface

### Cross-Reference with `shared/types.ts`

```
grep -rn "export type|export interface" src/shared/types.ts
```

Shared exports: AgentId, ToolType, ThinkingMode, Group, SessionInfo, UsageStats, HistoryEntryType, HistoryEntry, PlaybookDocumentEntry, Playbook, BatchDocumentEntry, WorktreeConfig, WorktreeRunTarget, BatchRunConfig, AgentConfig, AgentErrorType, AgentError, AgentErrorRecovery, PowerStatus, SshRemoteConfig, SshRemoteStatus, SshRemoteTestResult, AgentSshRemoteConfig, ProviderStats, GlobalAgentStats.

### Overlap Analysis

| Type | shared/types.ts | renderer/types/index.ts | Relationship |
|------|----------------|------------------------|-------------|
| `HistoryEntry` | Base definition | `extends BaseHistoryEntry` adds `achievementAction` | Proper extension - no duplication |
| `WorktreeConfig` | Base definition | `extends BaseWorktreeConfig` adds `ghPath` | Proper extension - no duplication |
| `BatchRunConfig` | Shared version (documents, prompt, loopEnabled, maxLoops) | Renderer version adds `worktree`, `worktreeTarget` | **Parallel definitions - not extending** |
| `BatchDocumentEntry` | Defined in shared | Re-exported from shared | Clean re-export |
| `AgentError` | Defined in shared | Re-exported from shared | Clean re-export |
| `UsageStats` | Defined in shared | Re-exported from shared | Clean re-export |
| `AgentConfig` | Defined in shared | **Separate definition** in renderer | **Parallel definitions** |

### Finding: `BatchRunConfig` Defined Twice

`shared/types.ts` line 129 and `renderer/types/index.ts` line 273 both define `BatchRunConfig`. The renderer version adds `worktree?: WorktreeConfig` and `worktreeTarget?: WorktreeRunTarget`. The shared version does not have these fields.

All renderer imports use the renderer version. No main-process or CLI code imports `BatchRunConfig` from either location.

**Risk:** Low - they serve different layers. The shared version is minimal for cross-process IPC contracts. The renderer version extends it for UI-specific concerns. However, neither `extends` the other - this could be refactored so the renderer version properly extends the shared base.

### Finding: `AgentConfig` Defined Twice

`shared/types.ts` line 139 defines `AgentConfig` with 14 fields. `renderer/types/index.ts` line 747 defines a separate `AgentConfig` with overlapping but not identical fields (renderer adds `capabilities`, `configOptions`, etc.).

**Risk:** Medium - having two parallel `AgentConfig` definitions could lead to drift. The renderer version is a superset. Could be refactored to extend the shared base.

### Finding: `Session` Not in Shared

The massive `Session` interface (~200 fields) exists only in `renderer/types/index.ts`. The main process has `SessionInfo` in `shared/types.ts` which is a minimal subset (id, name, toolType, state, isLive, cwd). This is intentional - `Session` is renderer-only state while `SessionInfo` is the IPC-safe summary.

---

## 3. Web Utilities (`src/web/utils/`)

### All Exports

```
grep -rn "function |const " src/web/utils/ --include="*.ts"
```

40 exports across 5 files:
- `config.ts` - 10 functions (getMaestroConfig, buildApiUrl, buildWebSocketUrl, etc.)
- `cssCustomProperties.ts` - 11 functions + 1 constant
- `logger.ts` - 1 singleton (webLogger) + internal helpers
- `serviceWorker.ts` - 5 functions
- `viewState.ts` - 8 functions + constants

### Cross-Reference with shared/ and renderer/utils/

**Logger:**
- `src/web/utils/logger.ts` imports `BaseLogLevel` and `LOG_LEVEL_PRIORITY` from `shared/logger-types.ts`
- `src/main/utils/logger.ts` (main process logger) uses `MainLogLevel` which extends `BaseLogLevel` with 'toast' and 'autorun'
- No duplication - web logger is a lightweight browser-specific implementation; main logger is Node.js-specific with file I/O. Both share the base type system.

**CSS/Theme:**
- `cssCustomProperties.ts` imports `Theme` and `ThemeColors` from `shared/theme-types.ts`
- `src/renderer/constants/themes.ts` defines theme data but does NOT duplicate CSS property generation
- No overlap with renderer theme handling (renderer uses Tailwind/inline styles; web interface uses CSS variables)

**Config:**
- `config.ts` is web-only. The renderer uses Electron's IPC bridge (`window.maestro.*`), not HTTP/WebSocket URLs.
- No equivalent in renderer/utils/ or shared/

**View State:**
- `viewState.ts` uses `localStorage` for web PWA state persistence
- `src/renderer/hooks/useSettings.ts` uses Electron's settings store for desktop persistence
- No overlap - different persistence mechanisms for different platforms

**Service Worker:**
- `serviceWorker.ts` is browser-only (service worker API)
- No equivalent in renderer or shared

### Finding: No Duplication

All web utilities are platform-specific (browser/PWA) with no overlap against the Electron renderer or shared utilities. The logger shares base types from `shared/logger-types.ts` which is the correct pattern.

---

## 4. Symphony Runner (`src/main/services/symphony-runner.ts`)

### Cross-Reference with Batch Processing

```
grep -rn "useBatchProcessor|BatchProcessor|batchStateMachine|BatchProcessingState" src/cli/
```

No results. The CLI has no batch processor overlap with Symphony.

**Symphony Runner vs. useBatchProcessor:**
- Symphony Runner handles git/PR workflow only (clone, branch, fork, push, draft PR, document setup)
- `useBatchProcessor` in `src/renderer/hooks/batch/` handles sequential document execution within a session
- They are complementary: Symphony Runner sets up the repository and documents, then hands off to the standard batch system for actual task execution

**Symphony Runner vs. CLI playbooks:**
- CLI playbooks (`src/cli/services/playbooks.ts`) run playbook files against sessions
- Symphony Runner runs against external GitHub repositories
- No shared code or patterns

### IPC Integration

Symphony Runner is called from one location:
- `src/main/ipc/handlers/symphony.ts` handler `symphony:startContribution`
- Frontend access: `src/renderer/hooks/symphony/useSymphony.ts` -> `window.maestro.symphony.startContribution()`
- UI: `src/renderer/components/SymphonyModal.tsx`

### Finding: No Duplication

Symphony Runner is a focused, single-purpose service. Its git operations (clone, branch, push) are not shared with any other module because no other system performs the same workflow (clone external repo -> fork -> draft PR -> setup docs).

The `execFileNoThrow` utility it uses is shared from `src/main/utils/execFile.ts`, and the fork setup logic is in `src/main/utils/symphony-fork.ts` - both appropriately factored out.

---

## Summary of Findings

| ID | Location | Issue | Severity | Action |
|----|----------|-------|----------|--------|
| R-1 | `GitStatusContext.tsx` | `useGitStatus()` deprecated with 0 consumers | Low | Remove legacy context + hook when convenient |
| R-2 | `renderer/types/index.ts` vs `shared/types.ts` | `BatchRunConfig` defined in parallel (not extending) | Low | Refactor renderer version to `extends` shared base |
| R-3 | `renderer/types/index.ts` vs `shared/types.ts` | `AgentConfig` defined in parallel (not extending) | Medium | Refactor renderer version to `extends` shared base |
| R-4 | All web/utils/ files | No duplication found | None | No action needed |
| R-5 | symphony-runner.ts | No duplication found | None | No action needed |
| R-6 | All context providers | No context/store duplication found | None | No action needed |
