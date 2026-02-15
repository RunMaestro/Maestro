# Phase 5: Validate — Tests and Gate

## Context

- **Playbook:** Unified Inbox Polish
- **Agent:** {{AGENT_NAME}}
- **Project:** {{AGENT_PATH}}
- **Loop:** {{LOOP_NUMBER}}
- **Date:** {{DATE}}
- **Working Folder:** {{AUTORUN_FOLDER}}

## Purpose

Update existing tests to match the new defaults and dimensions, add new tests for starred filter and byAgent sort, then run the full lint/test/build gate.

## Key Paths

- **Component tests:** `src/__tests__/renderer/components/AgentInbox.test.tsx`
- **Hook tests:** `src/__tests__/renderer/hooks/useAgentInbox.test.ts`
- **Helper tests:** `src/__tests__/renderer/helpers/agentInboxHelpers.test.ts`

---

## Task 1: Update existing tests for new defaults and dimensions

- [ ] Open `{{AGENT_PATH}}/src/__tests__/renderer/components/AgentInbox.test.tsx`. Search for all assertions that reference the old values and update them: (1) Any test asserting `w-[600px]` should now assert `w-[800px]`. (2) Any test asserting `filterMode` defaults — the default is now `'unread'`, not `'all'`. If tests render the component and expect to see all items by default, they may need updating since the default filter now only shows unread items. (3) Any test asserting item height of `100` should now assert `120`. (4) Any test checking for the Edit3 icon or `/` separators in Row 1 — these should now check for `|` pipe separators and no icons. Search for strings like `600`, `w-[600px]`, `'all'` (in filter context), `Edit3`, and `100` (in height context). Fix each occurrence. Also open `{{AGENT_PATH}}/src/__tests__/renderer/hooks/useAgentInbox.test.ts` and update `MAX_MESSAGE_LENGTH` references from `90` to `300` if any tests assert on truncation length. Run `npx vitest run --reporter=verbose 2>&1 | tail -40` from `{{AGENT_PATH}}` to check current test status. Use TABS for indentation. Success criteria: all pre-existing tests pass with the updated values.

## Task 2: Add tests for starred filter mode

- [ ] Open `{{AGENT_PATH}}/src/__tests__/renderer/hooks/useAgentInbox.test.ts`. Add a new `describe('starred filter mode', ...)` block with these test cases: (1) `'returns only starred items when filter is starred'` — create test sessions where some tabs have `starred: true` and others `starred: false`, call the hook with `filterMode: 'starred'`, assert only starred items are returned. (2) `'returns empty array when no tabs are starred'` — all tabs have `starred: false`, assert empty result. (3) `'starred filter works with all sort modes'` — test that starred items can be sorted by newest, oldest, grouped, and byAgent. Also open `{{AGENT_PATH}}/src/__tests__/renderer/components/AgentInbox.test.tsx` and add: (4) `'shows star indicator on starred items'` — render with starred items, assert the `★` character appears. (5) `'shows ★ Starred option in filter controls'` — assert the filter segmented control includes "★ Starred". Use TABS for indentation. Run `npx vitest run --reporter=verbose 2>&1 | tail -40` from `{{AGENT_PATH}}`. Success criteria: all 5 new tests pass.

## Task 3: Add tests for byAgent sort mode

- [ ] Open `{{AGENT_PATH}}/src/__tests__/renderer/hooks/useAgentInbox.test.ts`. Add a new `describe('byAgent sort mode', ...)` block with these test cases: (1) `'groups items by sessionName'` — create items from 3 different agents, sort by byAgent, assert items are grouped by sessionName. (2) `'places agents with unreads before agents without'` — create agents with and without unread items, assert unread agents come first. (3) `'sorts by unread count descending within unread group'` — agent with 3 unreads comes before agent with 1 unread. (4) `'sorts alphabetically within zero-unread group'` — agents with no unreads are alphabetical. (5) `'sorts items within each agent by timestamp descending'` — within a single agent's group, newest items come first. Also open `{{AGENT_PATH}}/src/__tests__/renderer/components/AgentInbox.test.tsx` and add: (6) `'shows By Agent option in sort controls'` — assert the sort segmented control includes "By Agent". (7) `'renders group headers with agent name when byAgent sort is active'` — verify headers appear with agent names. Use TABS for indentation. Run `npx vitest run --reporter=verbose 2>&1 | tail -40` from `{{AGENT_PATH}}`. Success criteria: all 7 new tests pass.

## Task 4: Full verification gate

- [ ] Run the complete verification gate from `{{AGENT_PATH}}`: (1) Type check: `npx tsc --noEmit --pretty` — must have ZERO errors. (2) Lint: `npx eslint src/renderer/components/AgentInbox.tsx src/renderer/hooks/useAgentInbox.ts src/renderer/types/agent-inbox.ts --no-error-on-unmatched-pattern` — must have ZERO errors. (3) Tests: `npx vitest run --reporter=verbose` — ALL tests must pass, zero failures. (4) If any step fails, fix the issue and re-run. Report the final counts: total tests passed, total errors, total warnings. Write a summary to `{{AUTORUN_FOLDER}}/INBOX_POLISH_GATE_REPORT.md` with format: `# Inbox Polish Gate Report\n\n## Results\n- tsc: PASS/FAIL (N errors)\n- eslint: PASS/FAIL (N errors)\n- vitest: PASS/FAIL (N passed, M failed)\n\n## Files Modified\n- list of all files changed\n\n## Summary\nOne paragraph summary`. Success criteria: all three checks pass (0 errors, 0 failures).
