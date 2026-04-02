# Maestro Dedup Playbook Index

Master index of all deduplication playbooks. Execute phases in order - each phase depends on the prior phases being complete.

**Total estimated savings:** ~8,314 lines across 40 dedup findings
**Total playbook documents:** 30
**Validated against:** origin/rc on 2026-04-01

---

## Tasks

### Task 1: Read this index and acknowledge the full scope

Read all documents listed below in order. Confirm you understand: 13 phases, 40 tracker findings, ~8,314 lines of removable/consolidatable code. Each subsequent document is a self-contained Auto Run step - execute them sequentially.

---

## Execution Order

### Phase 01: Dead Code Removal (P0 - Zero Risk)

**Savings:** ~990 lines | **Risk:** None | **Tracker items:** #1, #2, #3, #4

| Doc | File                                                       | Description                                           |
| --- | ---------------------------------------------------------- | ----------------------------------------------------- |
| 01A | [01A_DEAD_COMPONENTS.md](01A_DEAD_COMPONENTS.md)           | Delete 7 component files with 0 production imports    |
| 01B | [01B_DEAD_STORE_SELECTORS.md](01B_DEAD_STORE_SELECTORS.md) | Remove 53 dead store exports across 9 files           |
| 01C | [01C_DEAD_SHARED_UTILS.md](01C_DEAD_SHARED_UTILS.md)       | Remove 43 dead shared utility exports across 18 files |
| 01D | [01D_DEAD_MAIN_PROCESS.md](01D_DEAD_MAIN_PROCESS.md)       | Remove 75 dead main process exports across 35 files   |

---

### Phase 02: Type Bug Fix (P0 - Critical)

**Savings:** ~50 lines | **Risk:** Medium | **Tracker items:** #5

| Doc | File                                                         | Description                                            |
| --- | ------------------------------------------------------------ | ------------------------------------------------------ |
| 02  | [02_AGENT_CAPABILITIES_BUG.md](02_AGENT_CAPABILITIES_BUG.md) | Fix AgentCapabilities double-definition in global.d.ts |

---

### Phase 03: Test Mock Consolidation (P1 - Zero Production Risk)

**Savings:** ~2,895 lines | **Risk:** None (test-only) | **Tracker items:** #9, #10, #11, #34

| Doc | File                                                       | Description                                |
| --- | ---------------------------------------------------------- | ------------------------------------------ |
| 03A | [03A_MOCK_SESSION_FACTORY.md](03A_MOCK_SESSION_FACTORY.md) | Consolidate 66 createMockSession factories |
| 03B | [03B_MOCK_THEME_FACTORY.md](03B_MOCK_THEME_FACTORY.md)     | Consolidate 154 theme mock definitions     |
| 03C | [03C_WINDOW_MAESTRO_MOCKS.md](03C_WINDOW_MAESTRO_MOCKS.md) | Consolidate 117 window.maestro mock setups |
| 03D | [03D_MOCK_TAB_FACTORY.md](03D_MOCK_TAB_FACTORY.md)         | Consolidate 12 tab mock factories          |

---

### Phase 04: Formatter Consolidation (P1/P2/P3 - Low Risk)

**Savings:** ~515 lines | **Risk:** Low | **Tracker items:** #12, #22, #23, #24, #31, #32, #33

| Doc | File                                                                 | Description                                                                     |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 04A | [04A_FORMAT_DURATION.md](04A_FORMAT_DURATION.md)                     | Consolidate 22 formatDuration definitions                                       |
| 04B | [04B_FORMAT_ELAPSED_TIME.md](04B_FORMAT_ELAPSED_TIME.md)             | Consolidate 5 formatElapsedTime definitions                                     |
| 04C | [04C_FORMAT_TIME_TIMESTAMP.md](04C_FORMAT_TIME_TIMESTAMP.md)         | Create canonical formatTimestamp, replace 15 definitions                        |
| 04D | [04D_FORMAT_NUMBER_SIZE_TOKENS.md](04D_FORMAT_NUMBER_SIZE_TOKENS.md) | Consolidate formatNumber, formatFileSize, estimateTokens, stripAnsi, generateId |

---

### Phase 05: Type Deduplication (P1 - Medium Risk)

**Savings:** ~370 lines | **Risk:** Medium | **Tracker items:** #14

| Doc | File                                                 | Description                                             |
| --- | ---------------------------------------------------- | ------------------------------------------------------- |
| 05  | [05_TYPE_DEDUPLICATION.md](05_TYPE_DEDUPLICATION.md) | Consolidate 28 interfaces with 98 redundant definitions |

---

### Phase 06: SpecKit/OpenSpec Unification (P1 - Medium-High Risk)

**Savings:** ~1,100 lines | **Risk:** Medium-High | **Tracker items:** #13

| Doc | File                                                                     | Description                                        |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| 06  | [06_SPECKIT_OPENSPEC_UNIFICATION.md](06_SPECKIT_OPENSPEC_UNIFICATION.md) | Unify 5 near-identical file pairs into shared base |

---

### Phase 07: Session State Patterns (P1/P2 - Medium Risk)

**Savings:** ~700 lines | **Risk:** Medium | **Tracker items:** #6, #7, #15, #16

| Doc | File                                                           | Description                                                                |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 07A | [07A_SESSION_UPDATE_HELPERS.md](07A_SESSION_UPDATE_HELPERS.md) | Extract updateAiTab/updateActiveAiTab, eliminate setSessions prop-drilling |
| 07B | [07B_SESSION_FIND_SELECTORS.md](07B_SESSION_FIND_SELECTORS.md) | Replace 71 sessions.find calls with store selectors                        |

---

### Phase 08: Shared UI Components (P2/P3 - Low Risk)

**Savings:** ~650 lines | **Risk:** Low | **Tracker items:** #19, #20, #35

| Doc | File                                                 | Description                                       |
| --- | ---------------------------------------------------- | ------------------------------------------------- |
| 08A | [08A_GHOST_ICON_BUTTON.md](08A_GHOST_ICON_BUTTON.md) | Extract GhostIconButton, replace 100+ instances   |
| 08B | [08B_SPINNER_COMPONENT.md](08B_SPINNER_COMPONENT.md) | Extract Spinner, replace 95+ instances            |
| 08C | [08C_EMPTY_STATE_VIEW.md](08C_EMPTY_STATE_VIEW.md)   | Extend EmptyStateView, adopt across 26+ locations |

---

### Phase 09: Shared Hooks (P2/P3 - Low Risk)

**Savings:** ~490 lines | **Risk:** Low | **Tracker items:** #17, #18, #36, #37

| Doc | File                                                                     | Description                                                                   |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 09A | [09A_FOCUS_AND_EVENT_HOOKS.md](09A_FOCUS_AND_EVENT_HOOKS.md)             | Create useFocusAfterRender (45 sites) and useEventListener (63+ files)        |
| 09B | [09B_DEBOUNCE_AND_ACTIVE_SESSION.md](09B_DEBOUNCE_AND_ACTIVE_SESSION.md) | Migrate debounce/throttle (15+ files), activeSession re-derivation (28 files) |

---

### Phase 10: Modal & Spawn Consolidation (P1/P2 - Medium Risk)

**Savings:** ~328 lines | **Risk:** Medium | **Tracker items:** #8, #26, #27

| Doc | File                                                                       | Description                                         |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| 10A | [10A_MODAL_LAYER_MIGRATION.md](10A_MODAL_LAYER_MIGRATION.md)               | Migrate 50+ files to useModalLayer hook             |
| 10B | [10B_GROUP_CHAT_SPAWN_AND_RESOLVE.md](10B_GROUP_CHAT_SPAWN_AND_RESOLVE.md) | Extract spawnGroupChatAgent helper, store resolve() |

---

### Phase 11: Logging & Error Handling (P2 - Low Risk)

**Savings:** Improved observability | **Risk:** Low | **Tracker items:** #21, #25

| Doc | File                                                         | Description                                            |
| --- | ------------------------------------------------------------ | ------------------------------------------------------ |
| 11A | [11A_CONSOLE_LOG_TO_LOGGER.md](11A_CONSOLE_LOG_TO_LOGGER.md) | Migrate 130+ console.log to structured logger          |
| 11B | [11B_SENTRY_ERROR_HANDLING.md](11B_SENTRY_ERROR_HANDLING.md) | Add Sentry to 252 catch blocks missing error reporting |

---

### Phase 12: Constants & Minor Cleanup (P3 - Very Low Risk)

**Savings:** ~126 lines | **Risk:** Very low | **Tracker items:** #28, #29, #38

| Doc | File                                                               | Description                                               |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| 12  | [12_CONSTANTS_AND_MINOR_DEDUP.md](12_CONSTANTS_AND_MINOR_DEDUP.md) | AUTO_RUN_FOLDER_NAME, DEFAULT_CAPABILITIES, CSS constants |

---

### Phase 13: Oversized File Decomposition (P3 - High Risk)

**Savings:** Maintainability | **Risk:** High | **Tracker items:** #39, #40

| Doc | File                                                         | Description                                       |
| --- | ------------------------------------------------------------ | ------------------------------------------------- |
| 13A | [13A_APP_TSX_DECOMPOSITION.md](13A_APP_TSX_DECOMPOSITION.md) | Decompose App.tsx from 4,034 to <1,000 lines      |
| 13B | [13B_OTHER_OVERSIZED_FILES.md](13B_OTHER_OVERSIZED_FILES.md) | Decompose symphony.ts, SymphonyModal, FilePreview |
| 13C | [13C_OVERSIZED_TEST_FILES.md](13C_OVERSIZED_TEST_FILES.md)   | Split 28 test files over 2,000 lines              |

---

## Verification Commands

**MANDATORY:** Run after every playbook document. Do NOT skip tests. The Windows build environment is working.

Use RTK (Rust Token Killer) to save tokens on verification output:

```
rtk npm run lint           # TypeScript type checking (83% token savings)
rtk npm run lint:eslint    # ESLint code quality (84% token savings)
rtk vitest run             # Vitest test suite (99.5% token savings)
```

If RTK is not available, fall back to raw npm:

```
npm run lint
npm run lint:eslint
npm run test
```

**Important:** Always prefix verification commands with `rtk` when available. Even in command chains, use `rtk` on each command:

```
rtk npm run lint && rtk vitest run
```

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

## Risk Boundaries

| Safe to delete without asking | Needs re-exports for backwards compat         | DO NOT TOUCH                          |
| ----------------------------- | --------------------------------------------- | ------------------------------------- |
| Dead code with 0 imports      | Shared utils used across main/renderer        | `src/main/cue/` (active dev)          |
| Unused type exports           | Types in `shared/` imported by both processes | Files with recent uncommitted changes |
| Orphaned test mocks           |                                               |                                       |

## Key Files Created by These Playbooks

| File                                              | Created In | Purpose                       |
| ------------------------------------------------- | ---------- | ----------------------------- |
| `src/__tests__/helpers/mockSession.ts`            | Phase 03A  | Shared session mock factory   |
| `src/__tests__/helpers/mockTheme.ts`              | Phase 03B  | Shared theme mock factory     |
| `src/__tests__/helpers/mockMaestro.ts`            | Phase 03C  | window.maestro mock utilities |
| `src/__tests__/helpers/mockTab.ts`                | Phase 03D  | Shared tab mock factory       |
| `src/renderer/components/ui/GhostIconButton.tsx`  | Phase 08A  | Shared ghost icon button      |
| `src/renderer/components/ui/Spinner.tsx`          | Phase 08B  | Shared spinner component      |
| `src/renderer/hooks/utils/useFocusAfterRender.ts` | Phase 09A  | Focus-after-render hook       |
| `src/renderer/hooks/utils/useEventListener.ts`    | Phase 09A  | Event listener hook           |
| `src/renderer/hooks/useActiveSession.ts`          | Phase 09B  | Active session hook           |
| `src/main/spec-command-manager.ts`                | Phase 06   | Shared SpecKit/OpenSpec base  |
| `src/main/group-chat/spawnGroupChatAgent.ts`      | Phase 10B  | Shared spawn helper           |
| `src/renderer/constants/classNames.ts`            | Phase 12   | Shared CSS constants          |
