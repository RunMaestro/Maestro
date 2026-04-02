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

For each pair, create a diff to understand what actually varies:

```
diff src/main/speckit-manager.ts src/main/openspec-manager.ts
diff src/renderer/components/SpecKitCommandsPanel.tsx src/renderer/components/OpenSpecCommandsPanel.tsx
diff src/main/ipc/handlers/speckit.ts src/main/ipc/handlers/openspec.ts
diff src/renderer/services/speckit.ts src/renderer/services/openspec.ts
diff src/prompts/speckit/index.ts src/prompts/openspec/index.ts
```

Document what differs (likely: directory names, feature labels, prompt content).

### Task 2: Design the shared base

Based on the diffs, design a parameterized base:

```typescript
// src/main/spec-command-manager.ts (shared base)
interface SpecCommandManagerConfig {
	featureName: string;          // 'speckit' | 'openspec'
	commandsDir: string;          // directory name for commands
	promptsDir: string;           // directory for prompts
	defaultCommands: SpecCommand[];
}

export class SpecCommandManager {
	constructor(private config: SpecCommandManagerConfig) {}

	async listCommands(): Promise<SpecCommand[]> { ... }
	async getCommand(name: string): Promise<SpecCommand> { ... }
	async saveCommand(command: SpecCommand): Promise<void> { ... }
	async deleteCommand(name: string): Promise<void> { ... }
	// ... shared logic
}
```

### Task 3: Consolidate the EditingCommand interface

Find all 3 definitions:

```
rtk grep "interface EditingCommand" src/ --glob="*.{ts,tsx}"
```

Create one canonical definition in `src/shared/types.ts` or alongside the shared base.

### Task 4: Implement shared manager (main process)

Create `src/main/spec-command-manager.ts`:

1. Extract all common logic from `speckit-manager.ts` and `openspec-manager.ts`
2. Parameterize the differences
3. Reduce each feature-specific file to thin wrappers:

```typescript
// src/main/speckit-manager.ts (after consolidation)
import { SpecCommandManager } from './spec-command-manager';
import { SPECKIT_DEFAULTS } from '../prompts/speckit';

export const speckitManager = new SpecCommandManager({
	featureName: 'speckit',
	commandsDir: '.speckit',
	promptsDir: 'speckit',
	defaultCommands: SPECKIT_DEFAULTS,
});
```

### Task 5: Implement shared UI component (renderer)

Create `src/renderer/components/SpecCommandsPanel.tsx` (shared):

1. Extract common UI from both panels
2. Parameterize: feature name, labels, color accents
3. Reduce each feature-specific panel to thin wrappers:

```typescript
// src/renderer/components/SpecKitCommandsPanel.tsx (after)
import { SpecCommandsPanel } from './SpecCommandsPanel';
export const SpecKitCommandsPanel = () => (
	<SpecCommandsPanel featureName="speckit" label="SpecKit" />
);
```

### Task 6: Consolidate IPC handlers

Create `src/main/ipc/handlers/spec-commands.ts` (shared):

1. Extract common handler logic
2. Register both speckit and openspec handlers from the shared base
3. Keep feature-specific files as thin registrations

### Task 7: Consolidate renderer services

Create `src/renderer/services/specCommands.ts` (shared):

1. Extract common service logic
2. Feature-specific services become thin wrappers

### Task 8: Consolidate prompt templates

If prompts differ significantly in content, keep them separate but share structure:

```typescript
// src/prompts/spec-commands/base.ts (shared structure)
// src/prompts/speckit/index.ts (speckit-specific content, extending base)
// src/prompts/openspec/index.ts (openspec-specific content, extending base)
```

### Task 9: Update all imports

Search for all imports of the old files and update:

```
rtk grep "speckit-manager|openspec-manager|SpecKitCommandsPanel|OpenSpecCommandsPanel" src/ --glob="*.{ts,tsx}"
```

### Task 10: Verify

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 11: Manual smoke test checklist

Since these are user-facing features, verify:

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
