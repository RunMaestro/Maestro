---
type: report
title: Agent Inbox — Baseline Test Coverage Report
created: 2026-02-15
tags:
  - test-coverage
  - agent-inbox
  - phase-07a
related:
  - "[[UNIFIED-INBOX-07a]]"
  - "[[UNIFIED-INBOX-07b]]"
---

# Agent Inbox — Baseline Test Coverage Report

> **Measured:** 2026-02-15 | **Branch:** `feature/unified-inbox` | **Framework:** Vitest + V8

---

## Overall Line Coverage: 60.09%

| Metric       | Covered | Total  | Percentage |
|-------------|---------|--------|-----------|
| **Statements** | 35,138  | 59,286 | **59.26%** |
| **Branches**   | 22,947  | 42,470 | **54.03%** |
| **Functions**  | 7,314   | 12,645 | **57.84%** |
| **Lines**      | 33,387  | 55,560 | **60.09%** |

- **Target:** 80%
- **Gap to Target:** ~20 percentage points
- **Test Suite:** 452 test files, 19,336 tests passing, 107 skipped, 0 failures

---

## Agent Inbox Feature — Coverage Breakdown

| File | Stmts | Branch | Funcs | Lines | Tests | Status |
|------|-------|--------|-------|-------|-------|--------|
| `AgentInbox.tsx` | 87.57% | 82.69% | 86.84% | 91.60% | 88 | Above target |
| `useAgentInbox.ts` | 98.68% | 95.65% | 100% | 98.38% | 38 | Excellent |
| `agent-inbox.ts` (types) | 100% | 100% | 100% | 100% | — | Complete |
| `agentInboxHelpers` (cross-file) | — | — | — | — | 17 | Pure functions |
| `modalStore.ts` (shared) | 69.45% | 51.27% | 40% | 70.22% | 66 | Below target |

**Agent Inbox Total Tests:** 143+ across 4 test files (88 + 38 + 17 in dedicated files)

### Key Observations

- `useAgentInbox.ts` is **near-perfect** at 98.38% line coverage — only line 25 (an early guard) uncovered.
- `AgentInbox.tsx` is **well-covered** at 91.60% lines — small gaps in lines 448-452 and 638-641.
- `modalStore.ts` is **below target** at 70.22% — Agent Inbox modal functions (lines 628-736) are partially uncovered. This is shared infrastructure, not Agent Inbox-specific.

---

## Coverage by Module (Selected Highlights)

### Well-Covered Modules (>80% lines)

| Module | Lines | Notes |
|--------|-------|-------|
| `shared/` | 92.66% | Shared utilities, formatters |
| `renderer/stores/` | 89.76% | State management stores |
| `web/components/` | 97.55% | Web UI components |
| `web/hooks/` | 97.79% | Web hooks |
| `web/utils/` | 99.54% | Web utilities |
| `renderer/hooks/batch/` | 84.57% | Batch processing hooks |
| `renderer/hooks/remote/` | 86.70% | SSH/remote hooks |

### Below-Target Modules (<80% lines)

| Module | Lines | Notes |
|--------|-------|-------|
| `renderer/hooks/session/` | 31.56% | Session management hooks (largest gap) |
| `renderer/hooks/props/` | 0% | Panel prop hooks (no tests at all) |
| `renderer/hooks/symphony/` | 43.44% | Symphony/contribution hooks |
| `renderer/hooks/keyboard/` | 63.19% | Keyboard handler (complex, large) |
| `renderer/hooks/input/` | 69.80% | Input processing hooks |
| `renderer/hooks/git/` | 69.88% | Git management hooks |
| `renderer/hooks/ui/` | 65.53% | UI utility hooks |
| `renderer/services/` | 65.69% | Services layer |
| `renderer/utils/` | 77.92% | Renderer utilities |
| `web/` (App) | 26.53% | Web app entry point |

---

## Lowest Coverage Files (Critical Gaps)

| File | Lines | Category |
|------|-------|----------|
| `hooks/session/useSessionUpdates.ts` | 1.04% | Session state management |
| `hooks/session/useRealtimeTracker.ts` | 3.94% | Session realtime tracking |
| `hooks/session/useSessionNavigation.ts` | 0% | Session navigation |
| `hooks/session/usePinnedSessions.ts` | 0% | Pinned sessions |
| `hooks/props/useMainPanelProps.ts` | 0% | Main panel props |
| `hooks/props/useRightPanelProps.ts` | 0% | Right panel props |
| `hooks/props/useSessionListProps.ts` | 0% | Session list props |
| `hooks/ui/useAppHandlers.ts` | 0% | App-level handlers |
| `hooks/ui/useThemeStyles.ts` | 0% | Theme style hook |
| `hooks/input/useInputSync.ts` | 0% | Input synchronization |
| `hooks/agent/useSendAndContinue.ts` | 0% | Agent send & continue |
| `hooks/symphony/useContribution.ts` | 0% | Symphony contributions |
| `hooks/symphony/useContributorStats.ts` | 0% | Contributor stats |
| `services/contextGroomer.ts` | 22.44% | Context grooming service |
| `utils/remarkSmartFormatTable.ts` | 5.55% | Table formatting utility |

---

## Existing Test Patterns

The project follows consistent patterns across all 452 test files:

1. **Testing Stack:** Vitest + @testing-library/react + jsdom
2. **Hook Testing:** `renderHook` with `act()` for state updates
3. **Component Testing:** `render` + `screen` queries + `fireEvent`
4. **Mock Strategy:** `vi.mock()` for modules, `vi.fn()` for functions
5. **Factory Functions:** `makeSession()`, `makeTab()`, etc. for test data creation
6. **Semantic Queries:** `getByRole`, `getByText`, `getAllByRole` preferred over test IDs
7. **Accessibility Testing:** ARIA attributes validated in dedicated test blocks
8. **Setup:** Global `setup.ts` with jsdom environment, tab-indented files

---

## Recommendations

### Quick Wins (High coverage gain, low effort)

These modules have partial coverage and could reach 80%+ with targeted tests:

| Target | Current | Effort | Notes |
|--------|---------|--------|-------|
| `modalStore.ts` Agent Inbox lines | 70% | Low | Add tests for inbox-related modal actions (lines 628-736) |
| `renderer/utils/` assorted | 78% | Low | Many files at 80-95%, a few at 0% pulling average down |
| `renderer/hooks/settings/` | 76% | Medium | Large file with many branches |
| `AgentInbox.tsx` remaining lines | 92% | Low | Just lines 448-452, 638-641 uncovered |

### Requires Setup (Medium effort, infrastructure needed)

| Target | Current | Effort | Blocker |
|--------|---------|--------|---------|
| `hooks/session/` cluster | 32% | High | Complex state management, needs extensive mocking |
| `hooks/keyboard/` handler | 63% | Medium | Large file (750+ lines), needs keyboard event simulation |
| `hooks/input/` processing | 70% | Medium | Complex input pipeline with debouncing |
| `services/contextGroomer.ts` | 22% | High | Requires IPC mocking for main process communication |

### Skip for Now (Low ROI or non-essential)

| Target | Reason |
|--------|--------|
| `hooks/props/*` (0%) | Pure prop-passing hooks, low logic density |
| `web/App.tsx` (27%) | Web app entry point, hard to unit test |
| `utils/confetti.ts` (0%) | Animation utility, visual-only |
| `utils/clipboard.ts` (0%) | Browser API wrapper, hard to test in jsdom |
| `utils/formatters.ts` (0%) | Renderer-side formatters may be redundant with shared/formatters |
| Type definition files (0%) | No executable code to test |

---

## Agent Inbox Specific — Next Steps

The Agent Inbox feature is in **strong shape** at 91-98% coverage for its core files. To reach 80% project-wide target, the effort should focus on:

1. **Close the `modalStore.ts` gap** — Add tests for the Agent Inbox modal state transitions (lines 628-736)
2. **Cover `AgentInbox.tsx` edge cases** — Lines 448-452 and 638-641 are small gaps
3. **Integration test** — A single test exercising the full pipeline (store → hook → component → user interaction)
4. **Performance test** — Verify rendering with 100+ inbox items doesn't regress

The broader project coverage gap (60% vs 80% target) is overwhelmingly in non-Agent-Inbox modules, particularly the session management and keyboard handling hooks.
