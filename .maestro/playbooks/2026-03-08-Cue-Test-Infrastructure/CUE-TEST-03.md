# Phase 3: CueTestHarness

Build a shared test harness that wires up the engine with in-memory store, mock deps, and scenario helpers. This eliminates the per-test-file boilerplate of configuring mocks, creating engines, and simulating events.

**Prerequisites:** Phase 1 (shared factories) and Phase 2 (CueStore interface + InMemoryCueStore) must be complete.

**Context:** Tests for `cue-engine.test.ts`, `cue-concurrency.test.ts`, `cue-completion-chains.test.ts`, and `cue-sleep-wake.test.ts` all independently set up a CueEngine with mocked deps, configure YAML loader returns, and manually trigger events. A shared harness makes new test scenarios trivial to write.

---

- [ ] Create `src/__tests__/main/cue/__fixtures__/CueTestHarness.ts`. The harness should:
  1. Accept optional overrides for deps, settings, and store
  2. Internally create an `InMemoryCueStore`, mock deps (using shared factories from Phase 1), and a `CueEngine` instance
  3. Expose the engine, store, and individual mocks as public properties
  4. Provide `loadYaml(config: CueConfig)` — configures the mocked YAML loader to return this config and triggers a reload
  5. Provide `loadSubscriptions(subs: CueSubscription[])` — shorthand that wraps subs in a CueConfig with default settings
  6. Provide `initSession(sessionId?: string)` — calls engine's session init with a mock session
  7. Provide `advanceTime(ms: number)` — wraps `vi.advanceTimersByTimeAsync(ms)` for readability
  8. Provide `completeRun(sessionId: string, exitCode?: number)` — resolves the `onCueRun` mock for the given session with a successful/failed result, simulating agent completion
  9. Provide `getActiveRuns()` and `getActivityLog()` — delegates to engine
  10. Provide `teardown()` — calls engine stop and cleans up
      The harness must work with `vi.useFakeTimers()` (callers are responsible for setting fake timers in beforeEach). Write a small test file `src/__tests__/main/cue/cue-test-harness.test.ts` that verifies the harness itself works: create harness, load a simple interval subscription, init session, advance time past interval, verify onCueRun was called. Run `npm run lint` and `npm run test -- src/__tests__/main/cue/cue-test-harness.test.ts`.

- [ ] Refactor `src/__tests__/main/cue/cue-concurrency.test.ts` to use `CueTestHarness` instead of manual setup. The concurrency tests create engines with specific `max_concurrent` and `queue_size` settings, then trigger multiple events to test queuing behavior. Replace the manual engine creation and mock wiring with harness calls. All 13 concurrency tests must still pass. Run `npm run test -- src/__tests__/main/cue/cue-concurrency.test.ts`.

- [ ] Refactor `src/__tests__/main/cue/cue-completion-chains.test.ts` to use `CueTestHarness`. These tests exercise fan-in/fan-out and agent.completed chaining — the harness's `completeRun()` helper should simplify the mock resolution patterns. All 14 tests must pass. Run `npm run test -- src/__tests__/main/cue/cue-completion-chains.test.ts`.

- [ ] Refactor `src/__tests__/main/cue/cue-sleep-wake.test.ts` to use `CueTestHarness`. These tests manipulate heartbeat timing and sleep detection — the harness should expose the in-memory store's heartbeat for direct manipulation. All 13 tests must pass. Run full suite: `npm run test -- src/__tests__/main/cue/`. Run `npm run lint` as final check.
