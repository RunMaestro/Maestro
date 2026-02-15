# Phase 07d: Test Coverage — Implement Tests

> **Feature:** Agent Inbox
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/agent-inbox`
> **Purpose:** Write tests for PENDING candidates from the evaluation phase
> **Source:** Adapted from Maestro Playbook Exchange — "Test Coverage" by Pedram Amini

This phase implements the actual tests. Each task writes tests for ONE pending item, runs them, and updates the plan. The project uses **Vitest** as the test framework.

---

## Implementation

- [x] **Write tests (or skip if none)**: Read `/Users/felipegobbi/Documents/Vibework/Maestro/playbooks/agent-inbox//LOOP_00001_PLAN.md`. If the file doesn't exist OR contains no items with status exactly `PENDING`, mark this task complete without changes. Otherwise, implement tests for ONE `PENDING` item with EASY/MEDIUM testability and HIGH/CRITICAL importance. Follow the project's existing test conventions: Vitest framework, test files alongside source as `*.test.ts` or `*.test.tsx`, use `describe`/`it`/`expect` patterns. Use `vi.mock()` for mocking. Run `cd ~/Documents/Vibework/Maestro && npx vitest run --reporter=verbose 2>&1 | tail -30` to verify tests pass. Update the item's status to `IMPLEMENTED` in `/Users/felipegobbi/Documents/Vibework/Maestro/playbooks/agent-inbox//LOOP_00001_PLAN.md`. Log to `/Users/felipegobbi/Documents/Vibework/Maestro/playbooks/agent-inbox//TEST_LOG_maestro.app_2026-02-15.md` with: test file path, test cases added, coverage before/after, gain. Only implement ONE test per task execution.

- [x] **Write next batch of tests (or skip if none)**: Read `/Users/felipegobbi/Documents/Vibework/Maestro/playbooks/agent-inbox//LOOP_00001_PLAN.md`. If no items with status exactly `PENDING` remain, mark this task complete. Otherwise, implement tests for the next `PENDING` item following the same process: write test, run `npx vitest run --reporter=verbose`, verify pass, update status to `IMPLEMENTED`, append to test log. Only implement ONE test per task execution.
  > ✅ Implemented Candidate 2 (close button hover handlers): 2 tests added, 19340 total pass, +1.0% coverage gain.

- [ ] **Write remaining tests (or skip if none)**: Read `/Users/felipegobbi/Documents/Vibework/Maestro/playbooks/agent-inbox//LOOP_00001_PLAN.md`. If no items with status exactly `PENDING` remain, mark this task complete. Otherwise, implement tests for the next `PENDING` item following the same process. Continue until this item is done — only ONE per execution. Update plan and log accordingly.

- [ ] **Final test batch (or skip if none)**: Read `/Users/felipegobbi/Documents/Vibework/Maestro/playbooks/agent-inbox//LOOP_00001_PLAN.md`. If no items with status exactly `PENDING` remain, mark this task complete. Otherwise, implement tests for the next `PENDING` item. Same process: write, run, verify, update status, log. After implementation, run the full test suite one final time: `cd ~/Documents/Vibework/Maestro && npx vitest run 2>&1 | tail -20` to confirm no regressions.
