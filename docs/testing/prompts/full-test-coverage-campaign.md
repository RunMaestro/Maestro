# Full Test Coverage Campaign Prompt

Canonical location: `docs/testing/prompts/full-test-coverage-campaign.md`.

Before using this prompt, read `docs/testing/current-status.md` and `docs/testing/game-plan.md`. Those files contain the current branch, E2E execution, and gap-audit state.

You are operating in the Maestro repository.

Your mission is to run a full test coverage and test-quality campaign, not a quick patch. The target is 100% meaningful test coverage with a defensible assessment that the tests are comprehensive, behaviorally useful, and capable of catching regressions.

## Operating Principles

Follow these constraints:

- Do not fake coverage by deleting source from coverage, excluding risky files, or adding import-only tests.
- Do not chase 100% line coverage at the expense of meaningful assertions.
- Treat uncovered critical paths as product risk, not just metric gaps.
- Preserve existing user changes. Do not revert unrelated dirty files.
- Prefer focused seams and reusable test helpers over brittle mega-tests.
- Add integration and E2E coverage where unit tests cannot prove behavior.
- Keep changes incremental and continuously validated.
- When a production module is hard to test, first evaluate whether it needs a small testability seam. Keep such refactors minimal and behavior-preserving.
- Never introduce broad refactors just to make tests easier.

## Campaign Context

Start from the branch or worktree provided by the user. Do not assume a fixed local path, branch name, baseline percentage, or previously completed test set.

At the start of the campaign, capture the current state:

- `git status --short --branch`
- `npm run test:coverage`
- current statement, branch, function, and line coverage from the generated coverage report
- the current list of low-coverage and zero-coverage files
- the current validation status for lint, ESLint, unit tests, coverage, integration tests, and E2E tests

Record this fresh baseline in `docs/testing/audits/test-coverage-audit.md`. Treat any existing numbers in older notes as historical context only, not as authoritative campaign state.

Existing unrelated dirty/untracked files may be present. Leave them alone unless explicitly needed.

## Definition Of Done

The campaign is complete only when all of these are true:

1. `npm run test:coverage` reports 100% for statements, branches, functions, and lines, or every remaining uncovered item has a documented, justified, narrowly scoped exclusion approved by repo policy.
2. Coverage thresholds are enforced in `vitest.config.mts` so regressions fail CI.
3. Critical workflows have integration or E2E coverage, not just shallow unit coverage.
4. High-risk error paths are tested: failed IPC calls, malformed files, missing binaries, SSH failures, failed process spawns, storage corruption, permission errors, and network/websocket failures.
5. Existing noisy tests are cleaned up enough that CI output makes real failures visible.
6. The final audit document identifies what was tested, what risks remain, and why remaining exclusions are legitimate.
7. `npm run lint`, `npm run lint:eslint`, `npm run test`, `npm run test:coverage`, and relevant integration/E2E commands pass or have documented environmental blockers.

## Phase 1: Establish Baseline And Policy

Start by collecting hard data:

1. Run `git status --short --branch`.
2. Run `npm run test:coverage`.
3. Parse `coverage/coverage-final.json` and produce ranked lists:
   - Files with 0% statements
   - Files with the most missed statements
   - Files with the worst branch coverage
   - Files with high risk and low coverage
4. Inspect `vitest.config.mts`, `vitest.integration.config.ts`, `playwright.config.ts`, and package scripts.
5. Decide a coverage policy:
   - Include production code that contains behavior.
   - Exclude generated files, type-only files, and pure barrel files only when they truly contain no runtime behavior.
   - Document each exclusion with a reason.
6. Add or update coverage thresholds only when the suite is ready, or add staged thresholds if the campaign will be split into multiple PRs.

Deliverable: update `docs/testing/audits/test-coverage-audit.md` with the current baseline, coverage policy, and ranked gap list.

## Phase 2: Clean Test Signal

Before adding hundreds of tests, reduce noise that hides failures.

Address systemic issues seen during coverage runs:

- React `act(...)` warnings in renderer tests.
- Expected-error tests that allow unsuppressed `console.error`, logger noise, or stack traces.
- Canvas mocks missing methods used by tested components, such as `ctx.scale`.
- Web config tests repeatedly logging development fallback warnings.
- Tests that assert only rendering presence without behavior.

Do not silence logs globally unless the test explicitly expects that behavior. Prefer local spies and assertions:

```ts
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
expect(consoleError).toHaveBeenCalledWith(...);
```

Deliverable: CI/test output should be materially quieter without hiding unexpected failures.

## Phase 3: High-ROI Unit Coverage

Work module by module. For each module:

1. Read the source.
2. Identify public behavior and failure modes.
3. Search existing tests before adding new ones.
4. Add tests using existing local patterns.
5. Run the specific test file.
6. Run affected broader test groups.
7. Re-check coverage for that module.

Prioritize pure or semi-pure modules first, because they provide reliable coverage quickly:

- `src/renderer/utils/*`
- `src/shared/*`
- parser modules under `src/main/parsers/*`
- process-manager utilities under `src/main/process-manager/utils/*`
- renderer service wrappers under `src/renderer/services/*`
- web hooks under `src/web/hooks/*`
- simple state stores under `src/renderer/stores/*`

Test required cases:

- happy path
- null/undefined or missing data
- malformed data
- empty collections
- boundary values
- concurrent or repeated calls where state/caching exists
- thrown dependencies
- cleanup/unsubscribe behavior

Avoid meaningless tests:

- Do not assert that a function exists.
- Do not test implementation details unless the module contract is implementation-specific.
- Do not snapshot large UI trees as primary coverage.
- Do not add tests that only import a module to mark it covered.

## Phase 4: IPC Handler Coverage

IPC handlers are high-risk because they connect UI intent to filesystem/process behavior.

Prioritize handlers with low coverage and high blast radius:

- `src/main/ipc/handlers/claude.ts`
- `src/main/ipc/handlers/agentSessions.ts`
- `src/main/ipc/handlers/context.ts`
- `src/main/ipc/handlers/documentGraph.ts`
- `src/main/ipc/handlers/symphony.ts`
- `src/main/ipc/handlers/process.ts`
- `src/main/ipc/handlers/git.ts`
- `src/main/ipc/handlers/filesystem.ts`

For each handler:

1. Verify registration and exported seams.
2. Mock Electron IPC and dependencies using existing helper patterns.
3. Test success payloads.
4. Test expected recoverable failures.
5. Test unexpected failures only when the code is meant to catch/report them.
6. Verify Sentry/logging behavior when relevant.
7. Verify path restrictions and SSH propagation where applicable.

Do not swallow unexpected errors in production code just to make tests easy. This codebase prefers unexpected crashes to reach Sentry unless the failure is recoverable.

## Phase 5: Storage And Provider Session Coverage

High-impact missed coverage exists in storage implementations:

- `src/main/storage/codex-session-storage.ts`
- `src/main/storage/opencode-session-storage.ts`
- `src/main/storage/claude-session-storage.ts`
- `src/main/storage/factory-droid-session-storage.ts`

These tests must prove real behavior:

- session listing
- pagination
- search modes
- malformed JSON/JSONL handling
- missing session files
- deletion semantics
- provider-specific path resolution
- SSH remote reads
- unsupported SSH write/delete paths
- corrupted metadata
- date directory traversal
- sorting and timestamp fallback

Use temporary directories inside the test harness. Do not depend on the user’s real provider history.

## Phase 6: Renderer Component And Hook Coverage

Prioritize large, central, low-coverage files:

- `src/renderer/App.tsx`
- `src/renderer/components/FilePreview.tsx`
- `src/renderer/components/DocumentGraph/MindMap.tsx`
- `src/renderer/components/DocumentGraph/DocumentGraphView.tsx`
- `src/renderer/components/MarketplaceModal.tsx`
- `src/renderer/components/Settings/SshRemoteModal.tsx`
- `src/renderer/components/Wizard/screens/PreparingPlanScreen.tsx`
- `src/renderer/components/NewInstanceModal.tsx`
- `src/renderer/hooks/keyboard/useMainKeyboardHandler.ts`
- `src/renderer/hooks/session/useBatchedSessionUpdates.ts`
- `src/renderer/hooks/ui/useAppHandlers.ts`

For UI tests, prefer user-visible behavior:

- renders the correct state
- keyboard navigation
- escape/close behavior through layer stack
- async loading states
- error states
- disabled states
- persistence calls
- IPC call parameters
- cleanup/unsubscribe on unmount
- accessibility roles/names where applicable

Use React Testing Library with `userEvent` where possible. Wrap async expectations with `await waitFor(...)` instead of relying on immediate assertions after state changes.

## Phase 7: Electron Main And Web Server Coverage

The main entry and server surfaces need careful seam work:

- `src/main/index.ts`
- `src/main/web-server/WebServer.ts`
- `src/main/web-server/web-server-factory.ts`
- app lifecycle modules
- update checker
- auto updater

If direct testing is difficult, extract minimal pure registration/build functions and test those. Keep runtime behavior unchanged.

Required coverage:

- IPC registration table includes expected handlers.
- app startup initializes required stores/services.
- server startup registers routes/websocket handlers.
- server handles port conflicts and shutdown.
- websocket broadcast paths handle disconnected clients.
- update checks handle success, unavailable update, network failure, and disabled update state.

## Phase 8: Integration Tests

Run and expand `npm run test:integration` where practical.

Integration tests should cover:

- group chat orchestration
- process global env vars
- provider integration boundaries
- Auto Run batch/session/list flows
- remote-control sync
- Inline Wizard flow
- Symphony runner flow

Avoid brittle real-agent tests in normal unit suites. Gate slow or environment-dependent integration tests through the integration config.

## Phase 9: E2E Tests

Use Playwright/Electron E2E for critical user workflows that unit tests cannot prove.

Critical E2E flows:

- create agent
- send prompt
- interrupt process
- switch tabs
- file preview open/close
- settings persistence
- SSH remote configuration validation
- Auto Run document selection and execution
- history view and detail open
- web/mobile remote control connection if environment supports it

Use screenshots/traces only for failures. Keep E2E tests deterministic and isolate app data.

## Phase 10: Mutation/Fault-Injection Review

Coverage does not prove comprehensiveness. For high-risk modules, manually perform fault-injection review:

- Flip important booleans and confirm tests fail.
- Remove error handling and confirm tests fail where expected.
- Change IPC channel names and confirm tests fail.
- Change parser patterns and confirm tests fail.
- Break SSH wrapping and confirm tests fail.
- Break storage sort order or pagination and confirm tests fail.

Document weak tests that survive obvious mutations.

## Completion Workflow

Repeat this loop until coverage and quality goals are met:

1. Pick one module or feature area.
2. Read source and existing tests.
3. Write meaningful tests.
4. Run the specific test file.
5. Run relevant grouped tests.
6. Run `npm run test:coverage`.
7. Update audit doc with coverage movement and remaining risk.
8. Fix noisy or flaky tests encountered in touched areas.
9. Run `npm run lint` and `npm run lint:eslint`.

Before final delivery, run:

```bash
npm run format:check:all
npm run lint
npm run lint:eslint
npm run test
npm run test:coverage
npm run test:integration
npm run test:e2e
```

If integration or E2E tests require unavailable environment dependencies, document the exact blocker, command output summary, and what remains unverified.

## Final Response Requirements

Final response must include:

- Coverage before/after table.
- List of files added/modified.
- Test commands run and results.
- Any commands not run and why.
- Remaining exclusions, if any, with justification.
- Test-quality assessment: where tests are strong, where they remain weak, and which workflows are covered only by unit tests versus integration/E2E.

Do not claim “100% coverage” unless the coverage report enforces and confirms 100% statements, branches, functions, and lines.
