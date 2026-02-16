# Phase 07b: Test Coverage — Find Untested Code

> **Feature:** Agent Inbox
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/agent-inbox`
> **Purpose:** Identify specific untested functions, branches, and code paths that need tests
> **Source:** Adapted from Maestro Playbook Exchange — "Test Coverage" by Pedram Amini

Using the coverage report from 07a, this phase identifies specific untested functions and branches in the Agent Inbox code. It bridges coverage metrics to actionable test targets.

---

## Gap Discovery

- [x] **Find untested code (or skip if not needed)**: ✅ Completed 2026-02-15. Created LOOP_00001_GAPS.md with 6 gaps identified across AgentInbox.tsx (lines 448-452 findRowIndexForItem fallback, lines 638-641 hover handlers), useAgentInbox.ts (line 25 default branch), modalStore.ts (lines 527-529 setAgentInboxOpen), plus focus ring handlers and InboxRow null guard. Estimated 8-12 new test cases to reach ~97% Agent Inbox coverage. Read `/Users/felipegobbi/Documents/Vibework/Maestro/playbooks/agent-inbox//LOOP_00001_COVERAGE_REPORT.md`. If the report shows overall line coverage of 80% or higher for Agent Inbox files, OR there are no Agent Inbox files with coverage below 80%, mark this task complete without creating a gaps file. Otherwise, examine low-coverage files — especially `src/renderer/components/AgentInbox/`, `src/renderer/hooks/useAgentInbox*`, `src/renderer/types/agent-inbox.ts`, and any `agent-inbox.ts` in `src/main/`. For each gap, list: file path, function name, line numbers, type (Unit/Integration/Edge Case), description of what's untested, current coverage %, why it matters, and suggested test approach. Include sections for untested functions (0% coverage, public API methods, utility functions, event handlers), untested branches (if/switch/ternary with only one path tested), untested error handling (try/catch where catch is never reached, validation logic), and untested edge cases (empty arrays, null/undefined inputs, boundary values). Output to `/Users/felipegobbi/Documents/Vibework/Maestro/playbooks/agent-inbox//LOOP_00001_GAPS.md`.
