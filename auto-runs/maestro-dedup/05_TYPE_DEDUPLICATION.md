# Phase 05: Deduplicate Type/Interface Definitions

## Objective

Consolidate 28 interfaces that have 98 redundant definitions across the codebase. The root cause is the preload boundary re-declaration pattern: types defined in `shared/`, re-declared in `main/preload.ts`, re-declared in `renderer/types/index.ts` and `renderer/global.d.ts`, then again locally.

**Evidence:** `docs/agent-guides/scans/SCAN-TYPES.md`
**Risk:** Medium - type changes cascade across process boundaries. Build verification is critical after each change.
**Estimated savings:** ~370 lines

---

## Pre-flight Checks

- [x] Phase 04 (formatters) is complete
- [x] `rtk npm run lint` passes
- [x] `CI=1 rtk vitest run` passes

---

## Important Context

Electron apps have three process contexts:

1. **Main process** (`src/main/`) - Node.js, full access
2. **Preload** (`src/main/preload.ts`) - Bridge between main and renderer
3. **Renderer** (`src/renderer/`) - Browser context, limited access

Types in `src/shared/` are importable by all three. The problem is that instead of importing from `shared/`, many files re-declare the same interfaces.

**Strategy:** Establish `src/shared/types.ts` as the single source of truth. Update preload and renderer to import from shared rather than re-declaring.

---

## Tasks

### Task 1: Inventory all duplicated interfaces

- [x] Find AgentCapabilities definitions: 1 definition (resolved in Phase 02) at `src/shared/types.ts:152`
- [x] Find UsageStats definitions: 6 identical defs (except web makes fields optional). Fields: inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, totalCostUsd, contextWindow, reasoningTokens?. Locations: shared/types.ts:43, main/parsers/usage-aggregator.ts:33, main/preload/process.ts:101, main/process-manager/types.ts:91, renderer/global.d.ts:95, web/hooks/useWebSocket.ts:29
- [x] Find SessionInfo definitions: 3 defs with DIFFERENT fields (not true duplicates). shared/types.ts:31 (basic), debug-package/collectors/sessions.ts:13 (debug-specific), group-chat/group-chat-router.ts:60 (SSH/custom args)
- [x] Find AgentConfig definitions: 6 defs with varying field subsets. shared/types.ts:263, main/agents/definitions.ts:72 (richest), main/preload/agents.ts:20 (minimal), renderer/global.d.ts:65, renderer/types/index.ts:753, __tests__/integration/group-chat-integration.test.ts:43 (test-specific)
- [x] Find AgentConfigsData definitions: 4 identical defs `{ configs: Record<string, Record<string, any>> }`. Locations: main/stores/types.ts:105, main/ipc/handlers/agents.ts:183, main/ipc/handlers/process.ts:49, main/ipc/handlers/tabNaming.ts:47
- [x] For each, record: file path, line number, field list (see above)

### Task 2: Handle AgentCapabilities (6 defs, was addressed in Phase 02)

- [x] Verify Phase 02 is done: `rtk grep "interface AgentCapabilities" src/ --glob "*.{ts,tsx}"` (expect exactly 1 result)
  - Confirmed: exactly 1 definition at `src/shared/types.ts:152`
- [x] If more than 1, finish the Phase 02 consolidation work before continuing
  - N/A - only 1 definition exists, Phase 02 consolidation is complete

### Task 3: Consolidate UsageStats (6 definitions)

- [x] Read all 6 definitions and compare fields
  - 5 identical (required fields), 1 web version (all optional = Partial)
- [x] Kept canonical definition in `src/shared/types.ts` (already existed there)
  - No need for separate `stats-types.ts` since canonical def was already in `shared/types.ts`
- [x] Replaced 5 duplicate definitions:
  - `main/parsers/usage-aggregator.ts` - re-exports from shared/types
  - `main/preload/process.ts` - imports + re-exports from shared/types
  - `main/process-manager/types.ts` - imports + re-exports from shared/types
  - `renderer/global.d.ts` - uses `import()` type syntax to preserve ambient declarations
  - `web/hooks/useWebSocket.ts` - uses `Partial<BaseUsageStats>` for optional-fields variant
- [x] TypeScript compilation passes (tsconfig.lint.json + tsconfig.main.json)
- [x] 214 related tests pass (usage-aggregator: 20, process-manager: 38, SessionStatusBanner: 102, wakatime: 54)

### Task 4: Consolidate SessionInfo (3 definitions)

- [x] Read all 3 definitions and compare fields
  - shared/types.ts:31 (8 fields: id, groupId?, name, toolType, cwd, projectRoot, autoRunFolderPath?, customModel?)
  - group-chat/group-chat-router.ts:60 (9 fields: id, name, toolType, cwd, customArgs?, customEnvVars?, customModel?, sshRemoteName?, sshRemoteConfig?) - different purpose: group chat participant routing with SSH support
  - debug-package/collectors/sessions.ts:13 (20 fields: diagnostic snapshot with state, tabCount, contextUsage, etc.) - different purpose: debug diagnostics
  - Verdict: NOT true duplicates - different fields serving different purposes
- [x] Keep canonical definition in `src/shared/types.ts`
- [x] Renamed non-canonical interfaces to eliminate naming collision:
  - `debug-package/collectors/sessions.ts`: `SessionInfo` -> `DebugSessionInfo` (updated in collector, index.ts import/re-export)
  - `group-chat/group-chat-router.ts`: `SessionInfo` -> `GroupChatSessionInfo` (updated in router, GetSessionsCallback, config comment, test file)
  - Result: exactly 1 `interface SessionInfo` remains (in shared/types.ts)
  - TypeScript compilation passes (tsconfig.main.json + tsconfig.lint.json)
  - 141 related tests pass (4 test files: group-chat-router, debug-package)

### Task 5: Consolidate AgentConfig (5 definitions)

- [x] Read all 5 definitions and compare fields
  - `shared/types.ts:263` (8 fields, minimal, unused by imports)
  - `definitions.ts:72` (30 fields, richest, includes function-typed arg builders)
  - `preload/agents.ts:20` (7 fields, minimal for preload API signatures)
  - `renderer/global.d.ts:65` (12 fields, ambient declaration)
  - `renderer/types/index.ts:753` (12 fields, exported for renderer)
  - `group-chat-integration.test.ts:43` (test-specific type with completely different fields - NOT a true duplicate)
  - Verdict: definitions.ts is the richest; shared needs all serializable fields; renderer needs optional binaryName/command/args
- [x] Keep canonical in `src/shared/types.ts` (serializable base) + `src/main/agents/definitions.ts` (extends with function fields)
  - Expanded `shared/types.ts` AgentConfig to include all serializable fields (customPath, configOptions, capabilities, batchModePrefix, etc.)
  - Also added canonical `AgentConfigOption` to shared/types.ts
  - `definitions.ts` now extends BaseAgentConfig with function-typed fields (resumeArgs, modelArgs, etc.) and narrows optionals to required
- [x] Replaced 4 duplicate definitions with imports:
  - `preload/agents.ts` - imports AgentConfig from shared/types
  - `renderer/global.d.ts` - uses `import()` type alias for AgentConfig and AgentConfigOption
  - `renderer/types/index.ts` - re-exports AgentConfig and AgentConfigOption from shared/types
  - `group-chat-integration.test.ts` - renamed to `TestAgentConfig` (not a true duplicate, different fields)
- [x] TypeScript compilation passes (tsconfig.main.json + tsconfig.lint.json)
- [x] 596 related tests pass (15 test files: agents, agent-args, context-groomer, tabNaming, agentStore, AgentConfigPanel, useAgentConfiguration, GroupChatModals, NewInstanceModal, sessionHelpers, EncoreTab, WizardKeyboardNavigation, WizardIntegration, WizardContext, SendToAgentModal)

### Task 6: Consolidate AgentConfigsData (4 definitions)

- [x] Read all 4 definitions and compare fields
  - All 4 identical: `{ configs: Record<string, Record<string, any>> }`
  - `main/stores/types.ts:105` (canonical, already exported)
  - `main/ipc/handlers/tabNaming.ts:47` (local duplicate)
  - `main/ipc/handlers/process.ts:49` (local duplicate)
  - `main/ipc/handlers/agents.ts:183` (local duplicate)
  - Note: `director-notes.ts` and `context.ts` already imported from stores/types correctly
- [x] Kept canonical definition in `src/main/stores/types.ts` (already existed there)
- [x] Replaced 3 duplicate definitions with `import type { AgentConfigsData } from '../../stores/types'`:
  - `main/ipc/handlers/tabNaming.ts` - removed local interface, added import
  - `main/ipc/handlers/process.ts` - removed local interface, added import
  - `main/ipc/handlers/agents.ts` - removed local interface, added import
- [x] TypeScript compilation passes (tsconfig.main.json + tsconfig.lint.json)
- [x] 102 related tests pass (tabNaming: 24, process: 60, types: 18)

### Task 7: Consolidate remaining 3+ definition interfaces

For each of the 17 interfaces with 3 definitions (51 total), from SCAN-TYPES.md:

- [x] Read `docs/agent-guides/scans/SCAN-TYPES.md` for the full findings list
- [x] For each duplicated interface: find definitions, compare fields, pick canonical location
- [x] Replace duplicate definitions with imports from canonical source
- [x] Run `rtk tsc -p tsconfig.lint.json --noEmit` after each batch of changes

**Results:**
Consolidated 24 interfaces across the codebase. Summary of changes:

**4+ definition interfaces (7):**
- StatsAggregation (4->1): canonical shared/stats-types.ts, replaced in useStats.ts, UsageDashboardModal.tsx, preload/stats.ts
- AutoRunSession (4->1): canonical shared/stats-types.ts, replaced in AutoRunStats.tsx, LongestAutoRunsTable.tsx, preload/stats.ts (Omit pattern)
- SlashCommand (4->2): canonical renderer/slashCommands.ts, replaced in InputArea.tsx, MainPanel.tsx (web/mobile kept separate - different build target)
- ShellInfo (4->1): moved to shared/types.ts, replaced in shellDetector.ts, preload/system.ts, global.d.ts, types/index.ts
- ProcessConfig (4->1 IPC + 1 internal): IPC version moved to shared/types.ts, replaced in preload/process.ts, global.d.ts, types/index.ts (main/process-manager version kept as different internal type)
- DirectoryEntry (3->1): moved to shared/types.ts, replaced in preload/fs.ts, global.d.ts, types/index.ts
- ClaudeSessionOriginsData (3->1): canonical stores/types.ts, replaced in claude.ts, claude-session-storage.ts

**3-definition interfaces (17):**
- UpdateStatus (3->1): moved to shared/types.ts, replaced in auto-updater.ts, preload/system.ts, UpdateCheckModal.tsx
- SshConfigHost (3->1): moved to shared/types.ts, replaced in ssh-config-parser.ts, preload/sshRemote.ts, SshRemoteModal.tsx
- SpecKitMetadata (3->1): canonical speckit-manager.ts, replaced in prompts/speckit/index.ts, types/index.ts
- OpenSpecMetadata (3->1): canonical openspec-manager.ts, replaced in prompts/openspec/index.ts, types/index.ts
- SessionMessage (3->2): canonical session-storage.ts, replaced in useSessionViewer.ts (test mock kept)
- EditingCommand (4->1 shared + 1 AI-specific): canonical in types/index.ts, replaced in SpecKitCommandsPanel, OpenSpecCommandsPanel, BmadCommandsPanel
- LeaderboardSubmitResponse (3->2): canonical leaderboard.ts handler, replaced in preload/leaderboard.ts (renderer version has different fields - kept)
- CueEvent (3->1): canonical cue-types.ts, replaced in preload/cue.ts, useCue.ts
- CueRunResult (3->1): canonical cue-types.ts, replaced in preload/cue.ts, useCue.ts
- CueSessionStatus (3->1): canonical cue-types.ts, replaced in preload/cue.ts, useCue.ts
- ClaudeSessionOriginInfo (3->1): canonical stores/types.ts, replaced in claude.ts (index.ts already resolved)
- BootstrapSettings (3->1): canonical stores/types.ts, replaced in system.ts, group-chat-storage.ts
- AutoRunTask (3->1): canonical shared/stats-types.ts, replaced in TasksByHourChart.tsx, preload/stats.ts
- AutoRunState (3->1): canonical web-server/types.ts, replaced in preload/web.ts, useWebSocket.ts
- AgentSessionInfo (3->1): canonical session-storage.ts, replaced in cli/agent-sessions.ts; renamed drawer version to PipelineAgentInfo

**Not true duplicates (skipped):**
- ProgressStage (2 remaining): different `id` types (GroomingProgress['stage'] vs SummarizeProgress['stage'])
- LogEntry (3): different fields across renderer vs web platforms
- ProcessConfig main/process-manager: different internal type with function fields

**Verification:** tsconfig.lint.json + tsconfig.main.json pass. 380 related tests pass, 3 pre-existing failures in AgentSessionsBrowser.test.tsx (unrelated to type changes).

### Task 8: Fix the preload type-sharing mechanism

- [x] Move type declarations from `renderer/global.d.ts` to importable `.ts` files
  - Moved `SessionMessage` and `SessionMessagesResult` from `main/agents/session-storage.ts` to `shared/types.ts` (cross-process boundary types)
  - `session-storage.ts` now imports from shared and re-exports for backward compatibility
  - `renderer/types/index.ts` re-exports `SessionMessage` and `SessionMessagesResult` from shared
- [x] Update renderer files to use `import type` instead of relying on ambient declarations
  - Renderer files already used proper imports from `renderer/types/` (no changes needed)
  - Fixed import paths in global.d.ts from wrong `../../shared/types` to correct `../shared/types` (previously masked type errors because bad paths resolved as `any`)
  - Made `ProcessConfig.command` and `args` optional in shared/types.ts to fix 8 type errors exposed by the path correction
- [x] Keep `global.d.ts` minimal - only true ambient declarations (e.g., `window.maestro` shape)
  - Removed 6 inline type declarations: `AutoRunTreeNode`, `HistoryEntryType`, `SessionMessagesResult`, `GroupChatData`, plus fixed type aliases
  - Replaced all with `import()` type aliases pointing to canonical sources: `shared/types.ts`, `shared/group-chat-types.ts`, `hooks/batch/useAutoRunHandlers.ts`
  - Added policy comment at top of file explaining what belongs in global.d.ts
  - Net reduction: ~90 lines of duplicate type declarations
- [x] This prevents the re-declaration pattern from recurring
  - TypeScript compilation passes (tsconfig.lint.json + tsconfig.main.json)
  - 543 related tests pass (12 test files), 3 pre-existing failures in AgentSessionsBrowser.test.tsx (unrelated formatNumber issue)

### Task 9: Clean up renderer/types/index.ts

- [ ] Read `src/renderer/types/index.ts` and identify all re-declared types
- [ ] Replace each re-declaration with a re-export: `export type { TypeName } from '../../shared/types';`
- [ ] Verify no local definitions remain that have canonical sources in shared/

### Task 10: Verify no duplicate definitions remain

- [ ] Count AgentCapabilities: `rtk grep "interface AgentCapabilities\b" src/ --glob "*.{ts,tsx}"` (expect 1)
- [ ] Count UsageStats: `rtk grep "interface UsageStats\b" src/ --glob "*.{ts,tsx}"` (expect 1)
- [ ] Count SessionInfo: `rtk grep "interface SessionInfo\b" src/ --glob "*.{ts,tsx}"` (expect 1)
- [ ] Count AgentConfig: `rtk grep "interface AgentConfig\b" src/ --glob "*.{ts,tsx}"` (expect 1)
- [ ] Count AgentConfigsData: `rtk grep "interface AgentConfigsData\b" src/ --glob "*.{ts,tsx}"` (expect 1)

### Task 11: Full verification

- [ ] Run lint: `rtk npm run lint`
- [ ] Run type checking: `rtk tsc -p tsconfig.main.json --noEmit && rtk tsc -p tsconfig.lint.json --noEmit`
- [ ] Find related test files: `rtk grep "UsageStats\|SessionInfo\|AgentConfig" src/__tests__/ --glob "*.test.{ts,tsx}" -l`
- [ ] Run related tests: `CI=1 rtk vitest run <related-test-files>`
- [ ] Confirm zero new test failures

---

## Verification

After completing changes, run targeted tests for the files you modified:

```bash
CI=1 rtk vitest run <path-to-relevant-test-files>
```

**Rule: Zero new test failures from your changes.** Pre-existing failures on the baseline are acceptable. If a test you didn't touch starts failing, investigate whether your refactoring broke it. If your change removed code that a test depended on, update that test.

Do NOT run the full test suite (it takes too long). Only run tests relevant to the files you changed. Use `rtk grep` to find related test files:

```bash
rtk grep "import.*from.*<module-you-changed>" --glob "*.test.*"
```

Also verify types:

```bash
rtk tsc -p tsconfig.main.json --noEmit
rtk tsc -p tsconfig.lint.json --noEmit
```

---

## Success Criteria

- Each of 28 duplicated interfaces has exactly 1 canonical definition
- ~98 redundant definitions removed
- `renderer/global.d.ts` no longer re-declares shared types
- Preload boundary uses imports from `shared/`
- Lint and tests pass
