---
type: analysis
title: Agent Inbox — Test Coverage Prioritized Plan
created: 2026-02-15
tags:
  - test-coverage
  - agent-inbox
  - phase-07c
related:
  - "[[LOOP_00001_GAPS]]"
  - "[[LOOP_00001_COVERAGE_REPORT]]"
  - "[[UNIFIED-INBOX-07c]]"
---

# Agent Inbox — Test Coverage Prioritized Plan

> **Evaluated:** 2026-02-15 | **Branch:** `feature/unified-inbox` | **Source:** Phase 07b gap analysis

---

## Summary

| Metric | Value |
|--------|-------|
| **Total Candidates** | 6 |
| **Auto-Implement (PENDING)** | 1 |
| **Implemented** | 2 |
| **Manual Review (PENDING - MANUAL REVIEW)** | 0 |
| **Won't Do** | 3 |
| **Current Coverage (Agent Inbox Overall)** | ~93% |
| **Target** | 80% |
| **Estimated Post-Loop Coverage (Agent Inbox)** | ~96% |
| **Estimated Coverage Gain** | ~3 percentage points |

> The Agent Inbox feature already **exceeds** the 80% target. These gaps are polish — closing them raises coverage from 93% to ~96%.

---

## Candidate Details

### Candidate 1: `setAgentInboxOpen` in modalStore

| Field | Value |
|-------|-------|
| **Status** | `PENDING` |
| **File** | `src/renderer/stores/modalStore.ts` (lines 527–529) |
| **Importance** | **HIGH** — Bridge between keyboard shortcut and modal rendering; misspelled modal type string = broken inbox |
| **Testability** | **EASY** — Pure store action, no mocking needed, clear input/output |
| **Est. Coverage Gain** | +0.3% (modalStore), +0.5% (Agent Inbox overall) |
| **Test Type** | Unit test |
| **Test Strategy** | Call `setAgentInboxOpen(true)`, assert `isOpen('agentInbox')` returns true. Call `setAgentInboxOpen(false)`, assert false. 2 test cases in existing `modalStore.test.ts`. |
| **Mocks Needed** | None — store is self-contained |

---

### Candidate 2: Close button hover handlers

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **File** | `src/renderer/components/AgentInbox.tsx` (lines 637–641) |
| **Importance** | **MEDIUM** — Visual hover effect; low runtime risk but covers the last untested lines in the component |
| **Testability** | **EASY** — `fireEvent.mouseEnter`/`mouseLeave` on a button, assert `style.backgroundColor` |
| **Est. Coverage Gain** | +1.0% (AgentInbox.tsx lines) |
| **Test Type** | Component test |
| **Test Strategy** | Find close button via `screen.getByTitle('Close (Esc)')`. Fire `mouseEnter`, assert background color matches `${accent}20`. Fire `mouseLeave`, assert `transparent`. 2 test cases. |
| **Mocks Needed** | Standard AgentInbox render mocks (already in test file) |

---

### Candidate 3: `findRowIndexForItem` fallback return

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **File** | `src/renderer/components/AgentInbox.tsx` (lines 446–455) |
| **Importance** | **HIGH** — Core navigation logic; if broken, items won't scroll into view in grouped mode |
| **Testability** | **MEDIUM** — Requires rendering in grouped mode and selecting an item to trigger the callback; manageable with existing test infrastructure |
| **Est. Coverage Gain** | +1.5% (AgentInbox.tsx lines) |
| **Test Type** | Component test |
| **Test Strategy** | Render AgentInbox in grouped mode with multiple status groups. Navigate to a specific item via keyboard (ArrowDown). Verify `aria-activedescendant` matches expected row ID, which proves `findRowIndexForItem` loop executed. Add a test with selectedIndex out of bounds to verify fallback `return 0`. 2 test cases. |
| **Mocks Needed** | Standard AgentInbox render mocks + multiple sessions in different states for grouping |

---

### Candidate 4: `matchesFilter` default branch

| Field | Value |
|-------|-------|
| **Status** | `WON'T DO` |
| **File** | `src/renderer/hooks/useAgentInbox.ts` (line 25) |
| **Importance** | **LOW** — Unreachable via TypeScript types; `InboxFilterMode` is a union of `'all' | 'needs_input' | 'ready'` |
| **Testability** | **EASY** — Trivial to force via type casting |
| **Est. Coverage Gain** | +0.02% (1 line in useAgentInbox.ts) |
| **Rationale** | Coverage gain is negligible (0.02%). Testing a compile-time-unreachable branch provides no regression protection. The defensive guard is correct as-is. |

---

### Candidate 5: Focus/blur outline handlers

| Field | Value |
|-------|-------|
| **Status** | `WON'T DO` |
| **File** | `src/renderer/components/AgentInbox.tsx` (lines 120–126, 285–291, 643–648) |
| **Importance** | **MEDIUM** — Accessibility concern; focus rings matter for keyboard users |
| **Testability** | **MEDIUM** — `fireEvent.focus`/`fireEvent.blur`, assert `style.outline` |
| **Est. Coverage Gain** | +0.3% (lines not flagged as uncovered in 07a report) |
| **Rationale** | These lines were **not flagged as uncovered** in the 07a coverage report. The gap document notes "not in the 07a report as uncovered." Testing would be defensive but provides no measurable coverage gain. Skip to keep scope tight. |

---

### Candidate 6: `InboxRow` null guard for missing row

| Field | Value |
|-------|-------|
| **Status** | `WON'T DO` |
| **File** | `src/renderer/components/AgentInbox.tsx` (line 323) |
| **Importance** | **LOW** — Defensive guard; react-window always passes valid indices |
| **Testability** | **HARD** — Requires rendering `InboxRow` directly with an invalid index, bypassing react-window's internal logic |
| **Est. Coverage Gain** | +0.1% (1 line) |
| **Rationale** | Testing implementation internals rather than behavior. The guard exists as a safety net for a race condition that cannot be triggered through normal UI interaction. Cost outweighs benefit. |

---

## Implementation Order

Sorted by coverage impact (descending) and effort (ascending):

| Priority | Candidate | Est. Gain | Effort | Tests |
|----------|-----------|-----------|--------|-------|
| 1 | **Candidate 3:** `findRowIndexForItem` fallback | +1.5% | Medium | 2 |
| 2 | **Candidate 2:** Close button hover handlers | +1.0% | Easy | 2 |
| 3 | **Candidate 1:** `setAgentInboxOpen` modal store | +0.5% | Easy | 2 |

**Total auto-implement tests:** 6 test cases
**Total estimated coverage gain:** ~3 percentage points (Agent Inbox: 93% → ~96%)

---

## Decision Matrix

```
                    EASY        MEDIUM        HARD        VERY HARD
CRITICAL            —           —             —           —
HIGH                C1 ✅       C3 ✅         —           —
MEDIUM              C2 ✅       C5 ❌†        —           —
LOW                 C4 ❌       —             C6 ❌       —
```

- ✅ = `PENDING` (auto-implement)
- ❌ = `WON'T DO`
- † C5 excluded: lines not flagged as uncovered in baseline report

---

## Notes

- The Agent Inbox feature **already exceeds the 80% target** at ~93%. This loop is about closing the gap to near-complete coverage.
- The 3 `WON'T DO` items are either unreachable code (C4), untriggerable guards (C6), or already-covered lines (C5). None represent meaningful risk.
- The overall project coverage (60.09%) is dominated by non-Agent-Inbox modules. Broader coverage improvement requires work on session hooks, keyboard handler, and services — outside this feature's scope.
