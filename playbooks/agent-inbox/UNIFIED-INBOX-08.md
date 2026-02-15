# Phase 08 — Agent Inbox UI Polish (5 Adjustments)

> **Effort:** Unified Inbox
> **Phase:** 08
> **Goal:** Fix card sizing, simplify filters to Read/Unread/All, add agent icon badge, add tab name, add card dividers
> **Files touched:** `src/renderer/components/AgentInbox.tsx`, `src/renderer/types/agent-inbox.ts`, `src/renderer/hooks/useAgentInbox.ts`, `src/__tests__/renderer/components/AgentInbox.test.tsx`, `src/__tests__/renderer/hooks/useAgentInbox.test.ts`

---

## Context for Agent

The Agent Inbox is a modal (`AgentInbox.tsx`) displaying a virtualized list of sessions needing attention. It uses `react-window` for rendering, `useAgentInbox.ts` for data aggregation, and `agent-inbox.ts` for types/constants. The current `ITEM_HEIGHT = 80` produces 68px visible cards (80 - 12 for row padding) which clips content when 3 rows of data are rendered (session name, message, badges).

**Design System Constraints:** Do NOT change any `fontSize`, `fontWeight`, `lineHeight`, or `padding` values on existing elements (SegmentedControl buttons, badges, card text). The platform has an established aesthetic — respect existing proportions. Only `ITEM_HEIGHT` changes because math proves content doesn't fit.

**Agent Icons:** Emoji-based, live in `src/renderer/constants/agentIcons.ts`. Use `getAgentIcon(toolType)` for safe lookup with fallback. Icons include emojis (🤖, 📟, 🏭) and unicode shapes (◇, ⬡).

**Tab Structure:** Sessions have `aiTabs: AITab[]`. Each tab has `id`, `name` (nullable), `agentSessionId` (nullable), `hasUnread` (boolean), `logs`, `createdAt`. Tab display name logic from `TabBar.tsx`: use `tab.name` if set, else last 8 chars of `agentSessionId`, else UUID fragment.

**hasUnread mechanism:** Set to `true` when new message arrives on inactive tab. Cleared to `false` when user views the tab or scrolls to bottom. This is the basis for the new Read/Unread filter.

---

## Tasks

- [x] **TASK 1 — Rewrite filter system to All / Unread / Read.** The current filters are "All" / "Needs Input" / "Ready" based on session state. Replace with a simpler binary read/unread model. The status badge on each card (from `STATUS_LABELS`) still shows "Needs Input", "Ready", etc. — that stays as-is for in-card context.

    **In `src/renderer/types/agent-inbox.ts`:**
    1. Change `InboxFilterMode` from `'all' | 'needs_input' | 'ready'` to `'all' | 'unread' | 'read'`
    2. Update JSDoc from `/** UI labels: "All", "Needs Input", "Ready" */` to `/** UI labels: "All", "Unread", "Read" */`
    3. Do NOT change `STATUS_LABELS` or `STATUS_COLORS` — they describe card badges, not filters

    **In `src/renderer/hooks/useAgentInbox.ts`:**
    1. Rewrite `matchesFilter()` to:
        ```typescript
        function matchesFilter(
            sessionState: Session['state'],
            hasUnread: boolean,
            filterMode: InboxFilterMode
        ): boolean {
            switch (filterMode) {
                case 'all':
                    return hasUnread || sessionState === 'waiting_input' || sessionState === 'idle'
                case 'unread':
                    return hasUnread === true
                case 'read':
                    return hasUnread === false && (sessionState === 'idle' || sessionState === 'waiting_input')
                default:
                    return false
            }
        }
        ```
        The `all` filter keeps the same logic (shows everything relevant). `unread` is purely based on `hasUnread`. `read` shows sessions the user has already seen but that have activity.

    **In `src/renderer/components/AgentInbox.tsx`:**
    1. Update `FILTER_OPTIONS` array:
        ```typescript
        const FILTER_OPTIONS: { value: InboxFilterMode; label: string }[] = [
            { value: 'all', label: 'All' },
            { value: 'unread', label: 'Unread' },
            { value: 'read', label: 'Read' },
        ];
        ```
    2. Update `EMPTY_STATE_MESSAGES`:
        ```typescript
        const EMPTY_STATE_MESSAGES: Record<InboxFilterMode, { text: string; showIcon: boolean }> = {
            all: { text: 'All caught up — no sessions need attention.', showIcon: true },
            unread: { text: 'No unread sessions.', showIcon: false },
            read: { text: 'No read sessions with activity.', showIcon: false },
        };
        ```

    **Tests to update in `src/__tests__/renderer/components/AgentInbox.test.tsx`:**
    - Every test that references `'Needs Input'` as a **filter button** text → change to `'Unread'`
    - Every test that references `'Ready'` as a **filter button** text → change to `'Read'`
    - BUT: `'Needs Input'` as a **status badge** on a card (from `STATUS_LABELS`) stays — those assertions should still find "Needs Input" in the badge, just not in the filter bar
    - Update empty state tests: `'No sessions waiting for input.'` → `'No unread sessions.'`, `'No idle sessions with unread messages.'` → `'No read sessions with activity.'`
    - Update all `fireEvent.click(screen.getByText('Needs Input'))` that target the filter button to `fireEvent.click(screen.getByText('Unread'))`
    - Update all `fireEvent.click(screen.getByText('Ready'))` that target the filter button to `fireEvent.click(screen.getByText('Read'))`

    **Tests to update in `src/__tests__/renderer/hooks/useAgentInbox.test.ts`:**
    - Update filter mode strings from `'needs_input'` to `'unread'` and `'ready'` to `'read'`
    - Update assertions to match new filter behavior (unread = hasUnread true, read = hasUnread false with activity)

    **Verify:** `npm run test -- --testPathPattern="AgentInbox|useAgentInbox" --no-coverage` — all tests pass.

- [x] **TASK 2 — Increase card row height to prevent text clipping + add dividers.** In `src/renderer/components/AgentInbox.tsx`:

    1. Change `ITEM_HEIGHT` from `80` to `100` (line 20). This gives 88px visible area (100 - 12 row padding), solving the confirmed 62px-in-52px clipping.
    2. Increase inner padding gap from `gap: 4` (line 129) to `gap: 6` for breathing room between rows.
    3. Add subtle divider between list items: in the `InboxRow` component, for `row.type === 'item'`, add `borderBottom: \`1px solid ${theme.colors.border}40\`` to the outer div's style. Use `40` hex alpha (~25% opacity) for subtlety. Do NOT add a border to the last item — check if `index === rows.length - 1` to skip. For `row.type === 'header'` (group headers), add a slightly stronger border: `borderBottom: \`1px solid ${theme.colors.border}60\`` for visual hierarchy.

    **Tests to update in `src/__tests__/renderer/components/AgentInbox.test.tsx`:**
    - Update the `card has correct height and border-radius` test: assertion from `'68px'` to `'88px'`
    - Update comment from `// height = ITEM_HEIGHT (80) - 12 = 68px` to `// height = ITEM_HEIGHT (100) - 12 = 88px`
    - Add test: `it('renders divider between inbox items')` — verify that an item row has `borderBottom` in its style

    **Verify:** `npm run test -- --testPathPattern="AgentInbox" --no-coverage` — all tests pass.

- [ ] **TASK 3 — Add agent icon badge to each inbox card (icon only, no text).** In `src/renderer/components/AgentInbox.tsx`:

    1. Add import: `import { getAgentIcon } from '../constants/agentIcons';`
    2. In `InboxItemCardContent`, in the **Row 3 badges** div (the `display: 'flex'` div around line 172), add as the **first child** (before git branch badge):
        ```tsx
        <span
            data-testid="agent-type-badge"
            title={item.toolType}
            aria-label={`Agent: ${item.toolType}`}
            style={{
                fontSize: 11,
                lineHeight: 1,
            }}
        >
            {getAgentIcon(item.toolType)}
        </span>
        ```
        Icon only. No text label. No background pill. The `title` provides a native tooltip on hover showing the agent type. `aria-label` provides accessibility.

    **Tests to add in `src/__tests__/renderer/components/AgentInbox.test.tsx`:**
    ```typescript
    it('renders agent icon badge with tooltip', () => {
        const sessions = [createInboxSession('s1', 't1')];
        render(<AgentInbox theme={theme} sessions={sessions} groups={[]} onClose={onClose} />);
        const badge = screen.getByTestId('agent-type-badge');
        expect(badge).toBeTruthy();
        expect(badge.getAttribute('title')).toBe('claude-code');
        expect(badge.getAttribute('aria-label')).toBe('Agent: claude-code');
    });
    ```
    Also check if the test `card has no standalone emoji` exists (around line 1364). If it does, update it to account for the agent icon emoji being intentionally present inside the `agent-type-badge` element.

    **Verify:** `npm run test -- --testPathPattern="AgentInbox" --no-coverage` — all tests pass.

- [ ] **TASK 4 — Add tab name to inbox card display.** This requires changes to the type, the data hook, and the component.

    **In `src/renderer/types/agent-inbox.ts`:**
    1. Add `tabName?: string` to the `InboxItem` interface (after `sessionName`)

    **In `src/renderer/hooks/useAgentInbox.ts`:**
    1. Add a helper function to compute tab display name (same logic as `TabBar.tsx`):
        ```typescript
        function getTabDisplayName(tab: { name: string | null; agentSessionId: string | null; id: string }, tabIndex: number): string {
            if (tab.name) return tab.name
            return `Tab ${tabIndex + 1}`
        }
        ```
        Use `Tab N` as fallback for unnamed tabs instead of UUID fragments (more user-friendly).
    2. In the `useAgentInbox` loop where tabs are iterated, track `tabIndex` and compute the tab name:
        ```typescript
        for (let tabIdx = 0; tabIdx < tabs.length; tabIdx++) {
            const tab = tabs[tabIdx]
            // ... existing filter logic ...
            items.push({
                // ... existing fields ...
                tabName: tabs.length > 1 ? getTabDisplayName(tab, tabIdx) : undefined,
            })
        }
        ```
        Only set `tabName` when the session has 2+ tabs. Single-tab sessions don't need the tab name (reduces visual noise).

    **In `src/renderer/components/AgentInbox.tsx`:**
    1. In `InboxItemCardContent`, Row 1 (session name area, around line 140-152), after the session name `<span>`, conditionally render the tab name:
        ```tsx
        <span style={{ fontSize: 14, fontWeight: 600, color: theme.colors.textMain, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {item.sessionName}
            {item.tabName && (
                <span style={{ fontWeight: 400, color: theme.colors.textDim }}>
                    {' / '}{item.tabName}
                </span>
            )}
        </span>
        ```
        Tab name renders in dimmer color and normal weight inside the same flex item, inheriting the truncation.

    **Tests to update:**
    - In `src/__tests__/renderer/hooks/useAgentInbox.test.ts`: Add test that when a session has 2+ tabs, the returned items include `tabName`. When session has 1 tab, `tabName` should be undefined.
    - In `src/__tests__/renderer/components/AgentInbox.test.tsx`: Add test that when `tabName` is present, the card renders "sessionName / tabName" format.

    **Verify:** `npm run test -- --testPathPattern="AgentInbox|useAgentInbox" --no-coverage` — all tests pass.

- [ ] **TASK 5 — Full verification and lint gate.** Run complete Agent Inbox test suite with coverage:
    ```bash
    npm run test -- --testPathPattern="AgentInbox|useAgentInbox|agentInboxHelpers" --no-coverage
    ```
    Then run lint:
    ```bash
    npm run lint
    ```
    Verify: all tests pass, zero TypeScript errors, zero ESLint errors. If any test still references `'Needs Input'` or `'Ready'` as filter button text (not as status badge text), fix it. Report total test count and pass rate.
