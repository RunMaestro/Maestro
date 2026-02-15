# Phase 03: Context Bar, Git Branch, and Summary Generation

> **Feature:** Agent Inbox
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/agent-inbox`
> **Corrections applied:** Orange warning color, % label, 90-char preview, null guards

This phase enriches each inbox item with context usage data, git branch info, and a smart summary line.

---

## Context Usage Display

- [x] **Add context usage percentage with correct colors and label.** Search the codebase for how context usage is tracked per agent session: `grep -rn 'contextUsage\|contextPercent\|tokenUsage' src/renderer/types/ src/renderer/hooks/agent/`. In `useAgentInbox`, extract this value and include it in `InboxItem.contextUsage` (0-100 number).
  > ✅ Completed: Added `resolveContextUsageColor()` helper with green/orange/red thresholds (0-60/60-80/80-100). InboxItemCard now renders a 4px context usage bar at the bottom of each card with animated width. Context text is color-coded to match. Null guard shows "Context: —" placeholder when undefined/NaN. 9 new tests added (color thresholds, bar dimensions, clamping, NaN guard, placeholder). All 63 component tests + 31 hook tests pass. TSC + ESLint clean.

  **In InboxItemCard, render context as text + thin bar:**
  - Text: `"Context: {value}%"` (always show the % label — don't rely on bar alone)
  - Bar: 4px height, full card width, at bottom of card
  - Color thresholds:
    - 0-60%: green (`theme.colors.success` or `#4ade80`)
    - 60-80%: **orange** (`#f59e0b` or `theme.colors.warning`) — NOT red. Orange = warning, red = error. This is an accessibility decision.
    - 80-100%: red (`theme.colors.error` or `#f87171`)
  - **Null guard:** If `contextUsage` is `undefined` or `NaN`, hide the bar entirely and show `"Context: —"` as placeholder text.

---

## Git Branch Display

- [x] **Add git branch display with null guards.** Search the codebase for git branch tracking: `grep -rn 'gitBranch\|branch\|git' src/renderer/types/index.ts src/renderer/hooks/git/`. If branch is at session level, pass through to `InboxItem.gitBranch`.
  > ✅ Completed: Updated InboxItemCard git branch badge with `'SF Mono', 'Menlo', monospace` font stack, `⎇` icon prefix, and 25-char truncation with `...` ellipsis. Null guard via `{item.gitBranch && ...}` omits badge entirely for undefined/null/empty. Added `data-testid="git-branch-badge"` for test targeting. 3 new tests added (truncation at 25 chars, exact-25 no-truncation, empty string guard). All 66 component tests + 31 hook tests pass. TSC clean.

  **In InboxItemCard:**
  - Render as a small monospace badge: `font-family: 'SF Mono', 'Menlo', monospace; font-size: 11px`
  - Format: git icon (or `⎇`) + branch name, **truncated to 25 chars** with "..."
  - Position: Row 3 of the card, left-aligned
  - **Null guard:** If `gitBranch` is `undefined`, `null`, or empty string — completely omit the badge (don't render an empty element). Use: `{item.gitBranch && <GitBranchBadge ... />}`

---

## Smart Summary

- [x] **Generate a 1-line conversation summary (deterministic heuristic, no LLM).** In `useAgentInbox`, improve the `lastMessage` field. Extract the last 2-3 log entries from `tab.logs` (guard: `tab.logs ?? []`).
  > ✅ Completed: Replaced `extractLastMessage` with `generateSmartSummary` in `useAgentInbox.ts`. Implements all 4 summary rules: "Waiting:" prefix for `waiting_input` state, direct question display for `?`-ending AI messages, "Done:" prefix with first-sentence extraction for AI statements, and `"No activity yet"` for empty logs. Added `truncate()` and `firstSentence()` helpers. Scans last 3 log entries for AI source, with fallback to raw last-log text. All null guards: `logs ?? []`, skips entries with falsy `.text`, handles null/undefined text. 12 new hook tests added (waiting_input with/without AI text, question detection, Done prefix, entry scanning, undefined/null text guards, truncation). Updated 2 component tests for new default message. All 104 tests pass (38 hook + 66 component). TSC + ESLint clean.

  **Summary rules:**
  - If `session.state === 'waiting_input'`: prefix with `"Waiting: "` + last AI message snippet
  - If last message is from AI and ends with `?`: show that question directly
  - If last message is from AI (statement): prefix with `"Done: "` + first sentence
  - If `tab.logs` is empty: show `"No activity yet"`

  **Truncation:** All summaries capped at **90 chars** (not 120) with `"..."` ellipsis. This ensures single-line scan-ability.

  **Null guards:**
  - `tab.logs` might be undefined → default to empty array
  - Log entry text might be undefined → skip that entry
  - Handle entries where `.text` or `.content` (whatever the field name is) is null

---

## Relative Timestamp

- [x] **Add `formatRelativeTime` helper with edge case handling.** Create the helper either in the AgentInbox file or in a shared utils file (check if `src/renderer/utils/` has a time formatting file already).
  > ✅ Completed: Enhanced existing `formatRelativeTime` in `src/shared/formatters.ts` (already imported by AgentInbox) with all specified edge case guards: invalid timestamps (0, NaN, negative) return `'—'`, future timestamps (clock skew) return `'just now'`, 1-day returns `'yesterday'`, 2-29 days return `'Xd ago'`, 30+ days return `'Xmo ago'`. Added 3 new edge case tests in `src/__tests__/shared/formatters.test.ts`. Updated 4 dependent test files (CommandHistoryDrawer, OfflineQueueBanner, TabSwitcherModal, AgentSessionsModal) to match new output formats. All 19,292 tests pass (451 test files). TSC clean.

  ```ts
  export function formatRelativeTime(timestamp: number): string {
    // Guard: invalid timestamps
    if (!timestamp || isNaN(timestamp) || timestamp <= 0) return '—'

    const now = Date.now()
    const diff = now - timestamp

    // Guard: future timestamps (clock skew)
    if (diff < 0) return 'just now'

    const seconds = Math.floor(diff / 1000)
    if (seconds < 60) return 'just now'

    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`

    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`

    const days = Math.floor(hours / 24)
    if (days === 1) return 'yesterday'
    if (days < 30) return `${days}d ago`

    return `${Math.floor(days / 30)}mo ago`
  }
  ```

  Use this in InboxItemCard for the timestamp in the top-right corner. Reference `formatRuntime` in ProcessMonitor (lines 77-97) for the existing pattern.

---

## Verification

- [ ] **Run type check and lint.** Execute:
  ```bash
  cd ~/Documents/Vibework/Maestro && \
  npx tsc --noEmit && \
  npm run lint:eslint -- --max-warnings=0 \
    src/renderer/components/AgentInbox.tsx \
    src/renderer/hooks/useAgentInbox.ts \
    src/renderer/types/agent-inbox.ts
  ```
  Fix any errors or warnings. Pay special attention to:
  - Unused variables (from null guard branches)
  - Missing return types on the helper function
  - Any `any` types that should be narrowed
