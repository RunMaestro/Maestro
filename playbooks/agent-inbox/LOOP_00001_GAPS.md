---
type: analysis
title: Agent Inbox — Test Coverage Gaps
created: 2026-02-15
tags:
  - test-coverage
  - agent-inbox
  - phase-07b
related:
  - "[[UNIFIED-INBOX-07a]]"
  - "[[UNIFIED-INBOX-07b]]"
  - "[[LOOP_00001_COVERAGE_REPORT]]"
---

# Agent Inbox — Test Coverage Gaps

> **Measured:** 2026-02-15 | **Branch:** `feature/unified-inbox` | **Source:** Phase 07a coverage report + manual code inspection

---

## Summary

The Agent Inbox feature is in **strong shape** (91–98% line coverage for core files). This document catalogs the remaining small gaps to close in Phase 07c/07d.

| File | Current Lines | Target | Gap Size |
|------|--------------|--------|----------|
| `AgentInbox.tsx` | 91.60% | 95%+ | ~8 lines |
| `useAgentInbox.ts` | 98.38% | 100% | 1 line |
| `modalStore.ts` (shared) | 70.22% | 80% | ~2 lines (Agent Inbox specific) |
| `agent-inbox.ts` (types) | 100% | 100% | None |

**Total new tests estimated:** 8–12 test cases

---

## Gap 1: `AgentInbox.tsx` — `findRowIndexForItem` fallback return

| Field | Value |
|-------|-------|
| **File** | `src/renderer/components/AgentInbox.tsx` |
| **Function** | `findRowIndexForItem` (lines 446–455) |
| **Uncovered Lines** | 448–452 |
| **Type** | Edge Case |
| **Current Coverage** | Partial — only called implicitly via `scrollToRow` effect |
| **Why It Matters** | The for-loop body (line 450 match check) and fallback `return 0` (line 452) are not directly tested. If the loop logic breaks, items won't scroll into view correctly. |
| **Description** | This callback maps an item index to a row index (accounting for group headers in grouped mode). The fallback `return 0` handles the case where no matching row is found — e.g., when selectedIndex is out of bounds or rows are empty. |
| **Suggested Test Approach** | **Unit test** — Extract `buildRows` (already module-scoped) and test `findRowIndexForItem` logic indirectly by: (1) rendering in grouped mode and navigating to verify scroll behavior, OR (2) testing `buildRows` directly and verifying row indices match expected positions. A simpler approach: test that selecting an item in grouped mode with headers produces correct `aria-activedescendant`. |

---

## Gap 2: `AgentInbox.tsx` — Close button hover handlers

| Field | Value |
|-------|-------|
| **File** | `src/renderer/components/AgentInbox.tsx` |
| **Function** | Close button `onMouseEnter`/`onMouseLeave` (lines 637–641) |
| **Uncovered Lines** | 638–641 |
| **Type** | Edge Case (Visual) |
| **Current Coverage** | 0% — no test fires mouseenter/mouseleave on close button |
| **Why It Matters** | Low risk — these are hover style handlers. However, they do modify `style.backgroundColor` imperatively, which could cause visual regressions if removed or broken. |
| **Description** | `onMouseEnter` sets the close button background to `${theme.colors.accent}20` (accent at 12.5% opacity). `onMouseLeave` resets it to `'transparent'`. |
| **Suggested Test Approach** | **Component test** — Fire `mouseEnter` and `mouseLeave` events on the close button (`screen.getByTitle('Close (Esc)')`) and assert `style.backgroundColor` changes. Low effort, 2 test cases. |

---

## Gap 3: `useAgentInbox.ts` — `matchesFilter` default branch

| Field | Value |
|-------|-------|
| **File** | `src/renderer/hooks/useAgentInbox.ts` |
| **Function** | `matchesFilter` (lines 12–27) |
| **Uncovered Lines** | 25 (`default: return false`) |
| **Type** | Edge Case (Defensive Guard) |
| **Current Coverage** | 0% for this specific line — all 3 valid filter modes are tested, but the `default` branch (unreachable with current types) is not |
| **Why It Matters** | Very low risk — TypeScript enforces `InboxFilterMode` is `'all' | 'needs_input' | 'ready'`, so this line is unreachable at compile time. It exists as a defensive guard. |
| **Description** | The `default` case returns `false` for any unrecognized filter mode. Since `InboxFilterMode` is a union type, this can only be reached via type casting (e.g., `'invalid' as InboxFilterMode`). |
| **Suggested Test Approach** | **Unit test** — Call `useAgentInbox` with an invalid filter mode cast via `as InboxFilterMode` and verify it returns an empty array. Alternatively, accept this as an intentional uncovered guard line (1 line = 0.02% impact). |

---

## Gap 4: `modalStore.ts` — `setAgentInboxOpen` action

| Field | Value |
|-------|-------|
| **File** | `src/renderer/stores/modalStore.ts` |
| **Function** | `setAgentInboxOpen` (lines 527–529) |
| **Uncovered Lines** | 528–529 (open/close branches) |
| **Type** | Unit |
| **Current Coverage** | 0% — no test in `modalStore.test.ts` covers the Agent Inbox modal action |
| **Why It Matters** | Medium risk — if the modal type string `'agentInbox'` is misspelled or the action is removed, the Inbox won't open/close. This is the bridge between the keyboard shortcut and the modal rendering. |
| **Description** | `setAgentInboxOpen(true)` calls `openModal('agentInbox')`, `setAgentInboxOpen(false)` calls `closeModal('agentInbox')`. These are thin wrappers around the generic modal store machinery. |
| **Suggested Test Approach** | **Unit test** — In `modalStore.test.ts`, add a test block: call `setAgentInboxOpen(true)`, assert `isOpen('agentInbox')` is true. Call `setAgentInboxOpen(false)`, assert it's false. 2 test cases, very low effort. |

---

## Gap 5: `AgentInbox.tsx` — Focus/blur outline handlers

| Field | Value |
|-------|-------|
| **File** | `src/renderer/components/AgentInbox.tsx` |
| **Function** | `onFocus`/`onBlur` handlers on InboxItemCardContent (lines 120–126) and SegmentedControl buttons (lines 285–291) |
| **Uncovered Lines** | Not in the 07a report as uncovered, but no test explicitly verifies focus ring behavior |
| **Type** | Edge Case (Accessibility) |
| **Current Coverage** | Partial — focus is tested for Tab cycling but not the visual outline style |
| **Why It Matters** | Medium risk for accessibility — focus rings are critical for keyboard users. If `outline` styling breaks, keyboard navigation becomes invisible. |
| **Description** | `onFocus` sets `outline: 2px solid ${theme.colors.accent}` with `-2px` offset. `onBlur` removes it. Applied to both item cards and segmented control buttons. |
| **Suggested Test Approach** | **Component test** — Focus an item card via `fireEvent.focus()` and check `style.outline`. Then blur and verify outline is removed. 2–3 test cases. |

---

## Gap 6: `AgentInbox.tsx` — `InboxRow` null guard for missing row

| Field | Value |
|-------|-------|
| **File** | `src/renderer/components/AgentInbox.tsx` |
| **Function** | `InboxRow` (lines 310–363) |
| **Uncovered Lines** | 323 (`if (!row) return null`) |
| **Type** | Edge Case (Defensive Guard) |
| **Current Coverage** | 0% for null guard — react-window always passes valid indices |
| **Why It Matters** | Very low risk — this guard protects against react-window passing an out-of-bounds index, which shouldn't happen in practice. |
| **Description** | If `rows[index]` is undefined (e.g., due to a race condition between rowCount and rows array), the component returns null instead of crashing. |
| **Suggested Test Approach** | Skip — this is a defensive guard that cannot be triggered through normal UI interaction. Testing it requires directly rendering `InboxRow` with an invalid index, which tests implementation details rather than behavior. Accept as intentional uncovered guard. |

---

## Untested Branches Summary

| Location | Branch Type | Tested Path | Untested Path |
|----------|-------------|-------------|---------------|
| `matchesFilter` switch | switch/default | `all`, `needs_input`, `ready` | `default` (unreachable) |
| `findRowIndexForItem` for-loop | loop exit | N/A (implicit via scroll) | Loop body + fallback return 0 |
| Close button hover | if/else (enter/leave) | Neither | Both `onMouseEnter` and `onMouseLeave` |
| `InboxRow` null guard | if/early-return | Normal row rendering | `!row` guard |
| `setAgentInboxOpen` | boolean branch | Neither | Both `true` and `false` |

---

## Untested Error Handling

| Location | Error Type | Status |
|----------|-----------|--------|
| `useAgentInbox` — undefined `aiTabs` | null guard (`?? []`) | **Tested** (line 93 of hook test) |
| `useAgentInbox` — undefined `logs` | null guard (`?? []`) | **Tested** (line 330 of hook test) |
| `useAgentInbox` — null log text | null guard (`?.text`) | **Tested** (line 549 of hook test) |
| `useAgentInbox` — empty session id | falsy guard (`!session.id`) | **Tested** (line 103 of hook test) |
| `deriveTimestamp` — invalid timestamp | fallback chain | **Tested** (line 610 of hook test) |
| `resolveStatusColor` — unknown color key | fallback (`?? textDim`) | **Not tested** — would need a session state not in `STATUS_COLORS` map |

---

## Untested Edge Cases

| Location | Edge Case | Priority |
|----------|-----------|----------|
| `AgentInbox.tsx` — context bar at exactly 0% | Width `0%` rendering | Low |
| `AgentInbox.tsx` — negative contextUsage | `Math.max(value, 0)` clamp | Low |
| `buildRows` — empty items array in grouped mode | Returns empty array | Low |
| `AgentInbox.tsx` — `selectedItemId` when selectedIndex > items.length | Returns `undefined` | Low |
| `AgentInbox.tsx` — `listHeight` on server (typeof window === 'undefined') | Returns 400 fallback | Low |

---

## Recommended Test Priority

### Must Have (High ROI, Low Effort)

1. **Gap 4: `setAgentInboxOpen` in modalStore** — 2 tests, ensures modal open/close works
2. **Gap 2: Close button hover** — 2 tests, covers the last uncovered lines in AgentInbox.tsx

### Nice to Have (Medium ROI)

3. **Gap 1: `findRowIndexForItem` fallback** — 1–2 tests, validates grouped mode scroll behavior
4. **Gap 5: Focus ring handlers** — 2–3 tests, accessibility assurance

### Skip (Low ROI)

5. **Gap 3: `matchesFilter` default** — Unreachable via TypeScript types
6. **Gap 6: `InboxRow` null guard** — Defensive guard, never triggered in practice

---

## Projected Coverage After Closing Gaps

| File | Current | After Gaps 1–4 | After All |
|------|---------|----------------|-----------|
| `AgentInbox.tsx` | 91.60% | ~95% | ~97% |
| `useAgentInbox.ts` | 98.38% | 98.38% | ~99.5% |
| `modalStore.ts` | 70.22% | ~71% | ~71% |
| **Agent Inbox Overall** | ~93% | ~95% | ~97% |

> Note: `modalStore.ts` coverage gains from Agent Inbox tests are minimal (~0.5%) since the file is 737 lines and Agent Inbox occupies only 3 lines. The broader modalStore coverage gap is a separate concern.
