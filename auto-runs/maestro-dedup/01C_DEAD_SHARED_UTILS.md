# Phase 01-C: Remove Dead Shared Utility Exports

## Objective

Remove 43 exported types/functions/constants from `src/shared/` that have zero external imports.

**Evidence:** `docs/agent-guides/scans/SCAN-DEADCODE.md`, "Dead Shared Utils"
**Risk:** Very low - zero external references confirmed
**Estimated savings:** ~290 lines across 18 files

---

## Pre-flight Checks

- [ ] Phase 01-B (dead store selectors) is complete
- [ ] `rtk npm run lint` passes

---

## Tasks

### Task 1: Remove dead exports from shared/agentMetadata.ts

Remove these 2 exports:

- `AGENT_DISPLAY_NAMES`
- `BETA_AGENTS`

Verify: `rtk grep "AGENT_DISPLAY_NAMES\|BETA_AGENTS" src/ --include="*.ts" --include="*.tsx" | grep -v "agentMetadata"`

### Task 2: Remove ALL of shared/cli-activity.ts (if all exports dead)

This file has 5 dead exports - check if the file has ANY used exports:

- `CliActivityStatus`
- `CliActivityFile`
- `readCliActivities`
- `updateCliActivity`
- `cleanupStaleActivities`

```
rtk grep "cli-activity" src/ --include="*.ts" --include="*.tsx" | grep -v "cli-activity.ts" | grep -v "__tests__"
```

If zero results, delete the entire file. Otherwise, remove only the dead exports.

### Task 3: Remove dead export from shared/cli-server-discovery.ts

Remove: `CliServerInfo`

### Task 4: Remove dead exports from shared/cue-pipeline-types.ts

Remove these 4 exports:

- `DebateConfig`
- `PipelineNodePosition`
- `PipelineNodeType`
- `PipelineViewport`

**CAUTION:** This is in the cue domain which is under active development. Verify carefully before removing.

### Task 5: Remove dead export from shared/deep-link-urls.ts

Remove: `buildFocusDeepLink`

Check if the entire file can be deleted: `rtk grep "deep-link-urls" src/ | grep -v "deep-link-urls.ts" | grep -v "__tests__"`

### Task 6: Remove dead exports from shared/gitUtils.ts

Remove these 6 exports:

- `GitFileStatus`
- `GitNumstatFile`
- `GitBehindAhead`
- `cleanBranchName`
- `cleanGitPath`
- `GIT_IMAGE_EXTENSIONS`

### Task 7: Remove dead export from shared/history.ts

Remove: `DEFAULT_PAGINATION`

**NOTE:** `ORPHANED_SESSION_ID` was verified as USED in `main/ipc/handlers/history.ts:18`. Do NOT remove it.

### Task 8: Remove dead export from shared/logger-types.ts

Remove: `shouldLogLevel`

### Task 9: Remove dead exports from shared/maestro-paths.ts

Remove these 6 exports:

- `PLAYBOOKS_FOLDER_NAME`
- `PLAYBOOKS_RUNS_DIR`
- `PIPELINE_INPUT_PROMPT`
- `PIPELINE_OUTPUT_PROMPT`
- `LEGACY_PLAYBOOKS_RUNS_DIR`
- `ALWAYS_VISIBLE_ENTRIES`

### Task 10: Remove dead export from shared/marketplace-types.ts

Remove: `PlaybookSource`

### Task 11: Remove dead export from shared/pathUtils.ts

Remove: `parseVersion`

### Task 12: Remove dead exports from shared/performance-metrics.ts

Remove these 2 exports:

- `PerformanceLogger`
- `createNoOpMetrics`

### Task 13: Remove dead exports from shared/symphony-constants.ts

Remove these 3 exports:

- `DRAFT_PR_TITLE_TEMPLATE`
- `DRAFT_PR_BODY_TEMPLATE`
- `READY_PR_BODY_TEMPLATE`

### Task 14: Remove dead exports from shared/symphony-types.ts

Remove these 2 exports:

- `SymphonyLabel`
- `SymphonyErrorType`

### Task 15: Remove dead exports from shared/synopsis.ts

Remove these 2 exports:

- `ParsedSynopsis`
- `isNothingToReport`

### Task 16: Remove dead export from shared/templateVariables.ts

Remove: `TemplateSessionInfo`

### Task 17: Remove dead exports from shared/treeUtils.ts

Remove these 3 exports:

- `WalkTreeOptions`
- `walkTree`
- `PartitionedPaths`

Check if the entire file can be deleted.

### Task 18: Remove dead export from shared/types.ts

Remove: `SshRemoteStatus`

### Task 19: Clean up any files that became empty

If any file has zero remaining exports after removal, delete the entire file.

### Task 20: Verify - lint and tests pass

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

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
