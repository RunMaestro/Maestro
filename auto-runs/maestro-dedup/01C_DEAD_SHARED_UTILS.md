# Phase 01-C: Remove Dead Shared Utility Exports

## Objective

Remove 43 exported types/functions/constants from `src/shared/` that have zero external imports.

**Evidence:** `docs/agent-guides/scans/SCAN-DEADCODE.md`, "Dead Shared Utils"
**Risk:** Very low - zero external references confirmed
**Estimated savings:** ~290 lines across 18 files

---

## Pre-flight Checks

- [x] Phase 01-B (dead store selectors) is complete
- [x] `rtk npm run lint` passes

---

## Tasks

### Task 1: Remove dead exports from shared/agentMetadata.ts

- [ ] Verify zero external refs: `rtk grep "AGENT_DISPLAY_NAMES\|BETA_AGENTS" src/ --glob "*.{ts,tsx}" | rtk grep -v "agentMetadata"`
- [ ] Remove export `AGENT_DISPLAY_NAMES` from `src/shared/agentMetadata.ts`
- [ ] Remove export `BETA_AGENTS` from `src/shared/agentMetadata.ts`

### Task 2: Remove ALL of shared/cli-activity.ts (if all exports dead)

5 dead exports: `CliActivityStatus`, `CliActivityFile`, `readCliActivities`, `updateCliActivity`, `cleanupStaleActivities`

- [ ] Check for ANY external usage: `rtk grep "cli-activity" src/ --glob "*.{ts,tsx}" | rtk grep -v "cli-activity.ts" | rtk grep -v "__tests__"`
- [ ] If zero results, delete `src/shared/cli-activity.ts` entirely
- [ ] If any results, remove only the 5 dead exports listed above

### Task 3: Remove dead export from shared/cli-server-discovery.ts

- [ ] Verify zero external refs: `rtk grep "CliServerInfo" src/ --glob "*.{ts,tsx}" | rtk grep -v "cli-server-discovery"`
- [ ] Remove export `CliServerInfo` from `src/shared/cli-server-discovery.ts`

### Task 4: Remove dead exports from shared/cue-pipeline-types.ts

**CAUTION:** Cue is under active development. Verify carefully before removing.

- [ ] Verify zero external refs for each: `rtk grep "DebateConfig\|PipelineNodePosition\|PipelineNodeType\|PipelineViewport" src/ --glob "*.{ts,tsx}" | rtk grep -v "cue-pipeline-types"`
- [ ] Remove export `DebateConfig` from `src/shared/cue-pipeline-types.ts`
- [ ] Remove export `PipelineNodePosition` from `src/shared/cue-pipeline-types.ts`
- [ ] Remove export `PipelineNodeType` from `src/shared/cue-pipeline-types.ts`
- [ ] Remove export `PipelineViewport` from `src/shared/cue-pipeline-types.ts`

### Task 5: Remove dead export from shared/deep-link-urls.ts

- [ ] Verify zero external refs: `rtk grep "buildFocusDeepLink" src/ --glob "*.{ts,tsx}" | rtk grep -v "deep-link-urls"`
- [ ] Remove export `buildFocusDeepLink` from `src/shared/deep-link-urls.ts`
- [ ] Check if entire file can be deleted: `rtk grep "deep-link-urls" src/ --glob "*.{ts,tsx}" | rtk grep -v "deep-link-urls.ts" | rtk grep -v "__tests__"`
- [ ] If zero results, delete `src/shared/deep-link-urls.ts` entirely

### Task 6: Remove dead exports from shared/gitUtils.ts

- [ ] Verify zero external refs: `rtk grep "GitFileStatus\|GitNumstatFile\|GitBehindAhead\|cleanBranchName\|cleanGitPath\|GIT_IMAGE_EXTENSIONS" src/ --glob "*.{ts,tsx}" | rtk grep -v "gitUtils"`
- [ ] Remove exports: `GitFileStatus`, `GitNumstatFile`, `GitBehindAhead`, `cleanBranchName`, `cleanGitPath`, `GIT_IMAGE_EXTENSIONS`

### Task 7: Remove dead export from shared/history.ts

**NOTE:** `ORPHANED_SESSION_ID` is USED in `main/ipc/handlers/history.ts:18`. Do NOT remove it.

- [ ] Verify zero external refs: `rtk grep "DEFAULT_PAGINATION" src/ --glob "*.{ts,tsx}" | rtk grep -v "history.ts"`
- [ ] Remove export `DEFAULT_PAGINATION` from `src/shared/history.ts`

### Task 8: Remove dead export from shared/logger-types.ts

- [ ] Verify zero external refs: `rtk grep "shouldLogLevel" src/ --glob "*.{ts,tsx}" | rtk grep -v "logger-types"`
- [ ] Remove export `shouldLogLevel` from `src/shared/logger-types.ts`

### Task 9: Remove dead exports from shared/maestro-paths.ts

- [ ] Verify zero external refs: `rtk grep "PLAYBOOKS_FOLDER_NAME\|PLAYBOOKS_RUNS_DIR\|PIPELINE_INPUT_PROMPT\|PIPELINE_OUTPUT_PROMPT\|LEGACY_PLAYBOOKS_RUNS_DIR\|ALWAYS_VISIBLE_ENTRIES" src/ --glob "*.{ts,tsx}" | rtk grep -v "maestro-paths"`
- [ ] Remove exports: `PLAYBOOKS_FOLDER_NAME`, `PLAYBOOKS_RUNS_DIR`, `PIPELINE_INPUT_PROMPT`, `PIPELINE_OUTPUT_PROMPT`, `LEGACY_PLAYBOOKS_RUNS_DIR`, `ALWAYS_VISIBLE_ENTRIES`

### Task 10: Remove dead export from shared/marketplace-types.ts

- [ ] Verify zero external refs: `rtk grep "PlaybookSource" src/ --glob "*.{ts,tsx}" | rtk grep -v "marketplace-types"`
- [ ] Remove export `PlaybookSource` from `src/shared/marketplace-types.ts`

### Task 11: Remove dead export from shared/pathUtils.ts

- [ ] Verify zero external refs: `rtk grep "parseVersion" src/ --glob "*.{ts,tsx}" | rtk grep -v "pathUtils"`
- [ ] Remove export `parseVersion` from `src/shared/pathUtils.ts`

### Task 12: Remove dead exports from shared/performance-metrics.ts

- [ ] Verify zero external refs: `rtk grep "PerformanceLogger\|createNoOpMetrics" src/ --glob "*.{ts,tsx}" | rtk grep -v "performance-metrics"`
- [ ] Remove export `PerformanceLogger` from `src/shared/performance-metrics.ts`
- [ ] Remove export `createNoOpMetrics` from `src/shared/performance-metrics.ts`

### Task 13: Remove dead exports from shared/symphony-constants.ts

- [ ] Verify zero external refs: `rtk grep "DRAFT_PR_TITLE_TEMPLATE\|DRAFT_PR_BODY_TEMPLATE\|READY_PR_BODY_TEMPLATE" src/ --glob "*.{ts,tsx}" | rtk grep -v "symphony-constants"`
- [ ] Remove exports: `DRAFT_PR_TITLE_TEMPLATE`, `DRAFT_PR_BODY_TEMPLATE`, `READY_PR_BODY_TEMPLATE`

### Task 14: Remove dead exports from shared/symphony-types.ts

- [ ] Verify zero external refs: `rtk grep "SymphonyLabel\|SymphonyErrorType" src/ --glob "*.{ts,tsx}" | rtk grep -v "symphony-types"`
- [ ] Remove export `SymphonyLabel` from `src/shared/symphony-types.ts`
- [ ] Remove export `SymphonyErrorType` from `src/shared/symphony-types.ts`

### Task 15: Remove dead exports from shared/synopsis.ts

- [ ] Verify zero external refs: `rtk grep "ParsedSynopsis\|isNothingToReport" src/ --glob "*.{ts,tsx}" | rtk grep -v "synopsis"`
- [ ] Remove export `ParsedSynopsis` from `src/shared/synopsis.ts`
- [ ] Remove export `isNothingToReport` from `src/shared/synopsis.ts`

### Task 16: Remove dead export from shared/templateVariables.ts

- [ ] Verify zero external refs: `rtk grep "TemplateSessionInfo" src/ --glob "*.{ts,tsx}" | rtk grep -v "templateVariables"`
- [ ] Remove export `TemplateSessionInfo` from `src/shared/templateVariables.ts`

### Task 17: Remove dead exports from shared/treeUtils.ts

- [ ] Verify zero external refs: `rtk grep "WalkTreeOptions\|walkTree\|PartitionedPaths" src/ --glob "*.{ts,tsx}" | rtk grep -v "treeUtils"`
- [ ] Remove exports: `WalkTreeOptions`, `walkTree`, `PartitionedPaths`
- [ ] Check if entire file can be deleted: `rtk grep "treeUtils" src/ --glob "*.{ts,tsx}" | rtk grep -v "treeUtils.ts" | rtk grep -v "__tests__"`
- [ ] If zero results, delete `src/shared/treeUtils.ts` entirely

### Task 18: Remove dead export from shared/types.ts

- [ ] Verify zero external refs: `rtk grep "SshRemoteStatus" src/ --glob "*.{ts,tsx}" | rtk grep -v "shared/types"`
- [ ] Remove export `SshRemoteStatus` from `src/shared/types.ts`

### Task 19: Clean up any files that became empty

- [ ] Check each modified file for remaining exports
- [ ] Delete any file that has zero remaining exports after removal

### Task 20: Verify - lint and tests pass

- [ ] Run lint: `rtk npm run lint`
- [ ] Find related test files: `rtk grep "import.*from.*shared/" src/__tests__/ --glob "*.test.{ts,tsx}" -l`
- [ ] Run targeted tests for modified shared files: `rtk vitest run src/__tests__/shared/`
- [ ] Confirm zero new test failures from your changes

---

## Verification

After completing changes, run targeted tests for the files you modified:

```bash
rtk vitest run <path-to-relevant-test-files>
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

- 43 dead exports removed across 18 shared files
- Any now-empty files deleted entirely
- No lint errors
- All tests pass
