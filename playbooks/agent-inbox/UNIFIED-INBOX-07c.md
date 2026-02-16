# Phase 07c: Test Coverage — Evaluate and Prioritize

> **Feature:** Agent Inbox
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/agent-inbox`
> **Purpose:** Rate each test gap by importance and testability, create prioritized implementation plan
> **Source:** Adapted from Maestro Playbook Exchange — "Test Coverage" by Pedram Amini

This phase evaluates each gap from 07b and assigns importance (CRITICAL/HIGH/MEDIUM/LOW) and testability (EASY/MEDIUM/HARD/VERY HARD) ratings. Only EASY/MEDIUM + HIGH/CRITICAL items get auto-implemented.

---

## Evaluation

- [x] **Evaluate gaps (or skip if empty)**: Read `/Users/felipegobbi/Documents/Vibework/Maestro/playbooks/agent-inbox//LOOP_00001_GAPS.md`. If it contains no gaps OR all gaps have already been evaluated in `/Users/felipegobbi/Documents/Vibework/Maestro/playbooks/agent-inbox//LOOP_00001_PLAN.md`, mark this task complete without changes. Otherwise, rate each gap using these criteria — IMPORTANCE: CRITICAL (core business logic, security, data integrity), HIGH (frequently used utils, API endpoints, state management, error handling), MEDIUM (supporting modules, helpers, UI components), LOW (unlikely edge cases, deprecated code). TESTABILITY: EASY (pure functions, no deps, clear I/O), MEDIUM (some mocking, manageable deps), HARD (heavy mocking, external services, complex setup), VERY HARD (needs refactoring, tightly coupled). Mark EASY/MEDIUM testability + HIGH/CRITICAL importance as `PENDING` for auto-implementation. Mark HIGH/CRITICAL + HARD as `PENDING - MANUAL REVIEW`. Mark VERY HARD or LOW importance as `WON'T DO`. Output to `/Users/felipegobbi/Documents/Vibework/Maestro/playbooks/agent-inbox//LOOP_00001_PLAN.md` with: Total Candidates count, Auto-Implement count with estimated coverage gain, Manual Review count, Won't Do count, Current Coverage %, Target 80%, Estimated Post-Loop Coverage %, and detailed entries for each test candidate with Status, File, Importance, Testability, Est. Coverage Gain, Test Type, Test Strategy, and Mocks Needed. End with an Implementation Order section sorted by coverage impact.
