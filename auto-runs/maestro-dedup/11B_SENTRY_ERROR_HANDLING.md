# Phase 11-B: Add Sentry to catch Blocks Missing Error Reporting

## Objective

Audit 252 catch blocks that use `console.error` without `captureException`/`captureMessage` and add Sentry reporting where errors are unexpected (not recoverable/expected failures).

**Evidence:** `docs/agent-guides/scans/SCAN-PATTERNS.md`, "try-catch with console.error only"
**Risk:** Low - adding error reporting doesn't change behavior
**Estimated savings:** Improved production error visibility

---

## Pre-flight Checks

- [ ] Phase 11-A (console.log migration) is complete
- [ ] `rtk npm run lint` passes

---

## Important Context

From CLAUDE.md:

- **DO let exceptions bubble up** when they represent unexpected failures
- **DO handle expected/recoverable errors explicitly** (network errors, file not found, etc.)
- **DO use Sentry utilities** for explicit reporting

Sentry utilities:

- Main process: `import { captureException, captureMessage } from '../utils/sentry';`
- Renderer: `import { captureException } from '../components/ErrorBoundary';` (or similar)

---

## Tasks

### Task 1: Prioritize by risk category

Not all 252 catch blocks need Sentry. Prioritize:

**MUST add Sentry (unexpected failures):**

- Main process IPC handlers (user actions that fail silently)
- Data persistence/storage operations
- Agent spawn failures
- Session state corruption

**SKIP Sentry (expected/recoverable):**

- Network timeouts (expected in SSH/remote scenarios)
- File not found (user may have deleted it)
- Parse errors on user input
- Git operations on non-git directories

### Task 2: Audit main process files (4 files, highest priority)

```
rtk grep -rn "catch" src/main/ --include="*.ts" -A2 | grep "console.error" | grep -v "captureException"
```

For each catch block:

1. Read the try block to understand what can fail
2. If the error is unexpected, add `captureException`
3. If the error is expected, add a comment explaining why Sentry is skipped

```typescript
// BEFORE
catch (error) {
	console.error('Failed to save session:', error);
}

// AFTER (unexpected)
catch (error) {
	console.error('Failed to save session:', error);
	captureException(error, { operation: 'saveSession', sessionId });
}

// AFTER (expected)
catch (error) {
	// Expected: file may not exist yet on first run
	console.error('Settings file not found:', error);
}
```

### Task 3: Audit CLI files (14 files)

CLI errors are user-facing. Add Sentry only for internal errors, not for user input validation failures.

### Task 4: Audit renderer components (40+ files)

For UI components, most catch blocks are around:

- API calls (add Sentry for unexpected failures)
- DOM operations (usually expected, skip Sentry)
- Data parsing (add Sentry if data comes from our systems)

### Task 5: Audit renderer hooks (24 files)

Similar to components - focus on hooks that call IPC or external services.

### Task 6: Audit renderer services/stores/utils (14 files)

These are often the most critical - they handle data flow.

### Task 7: Verify

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 8: Count improvement

```
# Files with console.error but no Sentry
rtk grep -rn "console.error" src/ --include="*.ts" --include="*.tsx" -l | while read f; do
	if ! grep -q "captureException\|captureMessage" "$f"; then
		echo "$f"
	fi
done | wc -l
```

Target: fewer than 30 remaining (expected-error-only files).

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

- High-priority catch blocks (main process, data persistence) have Sentry reporting
- Expected/recoverable errors are documented with comments
- No behavioral changes
- Lint and tests pass
