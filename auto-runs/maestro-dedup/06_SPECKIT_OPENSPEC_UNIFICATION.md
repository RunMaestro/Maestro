# Phase 06: Unify SpecKit/OpenSpec Parallel Implementations

## Objective

SpecKit and OpenSpec are near-identical feature implementations totaling ~2,431 lines with ~1,100 removable through consolidation. Create a shared base that both features extend.

**Evidence:** `docs/agent-guides/scans/SCAN-PATTERNS.md`, "SpecKit vs OpenSpec"
**Risk:** Medium-high - these are user-facing features. Thorough testing required.
**Estimated savings:** ~1,100 lines

---

## Pre-flight Checks

- [ ] Phase 05 (type deduplication) is complete
- [ ] `rtk npm run lint` passes
- [ ] `rtk vitest run` passes

---

## Important Context

5 file pairs with near-identical implementations:

| SpecKit File                                         | OpenSpec File                                         | Combined Lines |
| ---------------------------------------------------- | ----------------------------------------------------- | -------------- |
| `main/speckit-manager.ts` (530)                      | `main/openspec-manager.ts` (471)                      | 1,001          |
| `renderer/components/SpecKitCommandsPanel.tsx` (424) | `renderer/components/OpenSpecCommandsPanel.tsx` (426) | 850            |
| `main/ipc/handlers/speckit.ts` (100)                 | `main/ipc/handlers/openspec.ts` (100)                 | 200            |
| `renderer/services/speckit.ts` (56)                  | `renderer/services/openspec.ts` (56)                  | 112            |
| `prompts/speckit/index.ts` (157)                     | `prompts/openspec/index.ts` (111)                     | 268            |

Also: `EditingCommand` interface has 3 definitions.

---

## Tasks

### Task 1: Diff each file pair to identify differences

- [ ] Diff managers: `diff src/main/speckit-manager.ts src/main/openspec-manager.ts`
- [ ] Diff UI panels: `diff src/renderer/components/SpecKitCommandsPanel.tsx src/renderer/components/OpenSpecCommandsPanel.tsx`
- [ ] Diff IPC handlers: `diff src/main/ipc/handlers/speckit.ts src/main/ipc/handlers/openspec.ts`
- [ ] Diff renderer services: `diff src/renderer/services/speckit.ts src/renderer/services/openspec.ts`
- [ ] Diff prompt templates: `diff src/prompts/speckit/index.ts src/prompts/openspec/index.ts`
- [ ] Document what actually differs (expected: directory names, feature labels, prompt content)

### Task 2: Design the shared base

- [ ] Define `SpecCommandManagerConfig` interface with parameterized differences: `featureName`, `commandsDir`, `promptsDir`, `defaultCommands`
- [ ] Design `SpecCommandManager` class with shared methods: `listCommands`, `getCommand`, `saveCommand`, `deleteCommand`
- [ ] Confirm the design covers all logic from both existing managers

### Task 3: Consolidate the EditingCommand interface

- [ ] Find all definitions: `rtk grep "interface EditingCommand" src/ --glob "*.{ts,tsx}"`
- [ ] Compare fields across all 3 definitions
- [ ] Create one canonical definition in `src/shared/types.ts` or alongside the shared base
- [ ] Replace other 2 definitions with imports

### Task 4: Implement shared manager (main process)

- [ ] Create `src/main/spec-command-manager.ts` with all common logic extracted from both managers
- [ ] Reduce `src/main/speckit-manager.ts` to a thin wrapper (~10 lines) instantiating SpecCommandManager with speckit config
- [ ] Reduce `src/main/openspec-manager.ts` to a thin wrapper (~10 lines) instantiating SpecCommandManager with openspec config
- [ ] Run type checking: `rtk tsc -p tsconfig.main.json --noEmit`

### Task 5: Implement shared UI component (renderer)

- [ ] Create `src/renderer/components/SpecCommandsPanel.tsx` with parameterized props: `featureName`, `label`, color accents
- [ ] Reduce `src/renderer/components/SpecKitCommandsPanel.tsx` to thin wrapper calling SpecCommandsPanel
- [ ] Reduce `src/renderer/components/OpenSpecCommandsPanel.tsx` to thin wrapper calling SpecCommandsPanel
- [ ] Run type checking: `rtk tsc -p tsconfig.lint.json --noEmit`

### Task 6: Consolidate IPC handlers

- [ ] Create `src/main/ipc/handlers/spec-commands.ts` with shared handler logic
- [ ] Reduce `src/main/ipc/handlers/speckit.ts` to thin registration calling shared handlers
- [ ] Reduce `src/main/ipc/handlers/openspec.ts` to thin registration calling shared handlers

### Task 7: Consolidate renderer services

- [ ] Create `src/renderer/services/specCommands.ts` with shared service logic
- [ ] Reduce `src/renderer/services/speckit.ts` to thin wrapper
- [ ] Reduce `src/renderer/services/openspec.ts` to thin wrapper

### Task 8: Consolidate prompt templates

- [ ] If prompts differ significantly in content, keep separate but share structure via a base in `src/prompts/spec-commands/base.ts`
- [ ] If prompts are nearly identical, parameterize into a shared template
- [ ] Update `src/prompts/speckit/index.ts` to extend shared base
- [ ] Update `src/prompts/openspec/index.ts` to extend shared base

### Task 9: Update all imports

- [ ] Find all imports to update: `rtk grep "speckit-manager\|openspec-manager\|SpecKitCommandsPanel\|OpenSpecCommandsPanel" src/ --glob "*.{ts,tsx}"`
- [ ] Update each import to point to the correct (possibly unchanged) export locations
- [ ] Ensure feature-specific thin wrappers still export the same names

### Task 10: Verify

- [ ] Run lint: `rtk npm run lint`
- [ ] Find related test files: `rtk grep "speckit\|openspec\|SpecKit\|OpenSpec" src/__tests__/ --glob "*.test.{ts,tsx}" -l`
- [ ] Run related tests: `rtk vitest run <related-test-files>`
- [ ] Confirm zero new test failures

### Task 11: Manual smoke test checklist

- [ ] SpecKit commands list loads
- [ ] OpenSpec commands list loads
- [ ] Creating a new command works for both
- [ ] Editing a command works for both
- [ ] Deleting a command works for both
- [ ] Running a command works for both

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

- Shared `spec-command-manager.ts` base with parameterized config
- Shared `SpecCommandsPanel.tsx` base component
- Shared IPC handler and service
- Feature-specific files reduced to thin wrappers (<50 lines each)
- ~1,100 lines removed
- Lint and tests pass
- Both features function identically to before
