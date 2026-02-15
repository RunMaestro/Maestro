# Phase 10 — Unified Inbox Card Redesign + Group Toggle

> **Effort:** Unified Inbox
> **Phase:** 10
> **Goal:** Redesign card Row 1 with agent/tab icons, remove agent badge from Row 3, fix header spacing, add group expand/collapse toggle
> **Files touched:** `src/renderer/components/AgentInbox.tsx`, `src/__tests__/renderer/components/AgentInbox.test.tsx`

---

## Context for Agent

The Unified Inbox modal (`AgentInbox.tsx`) is a virtualized list of session cards. After Phases 08-09, each card has:
- **Row 1:** `groupName / sessionName / tabName` + timestamp
- **Row 2:** Last message summary
- **Row 3:** Agent icon badge + git branch + context % + status pill

The agent icon badge (`data-testid="agent-type-badge"`) was added in Phase 08 Task 3 in the Row 3 badges div. It needs to move to Row 1.

**Design System:** Do NOT change any existing `fontSize`, `fontWeight`, `padding` values. Only restructure element placement.

**Icons available:** `getAgentIcon(toolType)` returns emoji (e.g., 🤖 for claude-code). Lucide icons already imported: `X`, `CheckCircle`. Need to add `Edit3` (or `Pencil`) and `ChevronDown`/`ChevronRight` from `lucide-react`.

**Group headers** are rendered in `InboxRow` when `row.type === 'header'` (line ~342). They show group name in uppercase. Currently no toggle.

**Collapsed state:** Use `useState<Set<string>>` to track collapsed group names. When a group is collapsed, its items are filtered out of the `rows` array before passing to react-window.

---

## Tasks

- [x] **TASK 1 — Redesign Row 1: move agent icon + add tab pencil icon.** In `src/renderer/components/AgentInbox.tsx`:

    1. Add `Edit3, ChevronDown, ChevronRight` to the lucide-react import at the top of the file (line 3). Keep existing imports (`X`, `CheckCircle`).

    2. In `InboxItemCardContent`, rewrite the **Row 1** div (lines 131-162). The new structure should be:

        ```tsx
        {/* Row 1: group / (agent_icon) session name / (pencil) tab name + timestamp */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {item.groupName && (
                <>
                    <span style={{ fontSize: 12, color: theme.colors.textDim, whiteSpace: 'nowrap' }}>
                        {item.groupName}
                    </span>
                    <span style={{ fontSize: 12, color: theme.colors.textDim }}>/</span>
                </>
            )}
            <span
                title={item.toolType}
                aria-label={`Agent: ${item.toolType}`}
                style={{ fontSize: 14, flexShrink: 0 }}
            >
                {getAgentIcon(item.toolType)}
            </span>
            <span
                style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: theme.colors.textMain,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                }}
            >
                {item.sessionName}
                {item.tabName && (
                    <span style={{ fontWeight: 400, color: theme.colors.textDim }}>
                        {' / '}
                        <Edit3 style={{ width: 10, height: 10, display: 'inline', verticalAlign: 'middle', marginRight: 2 }} />
                        {item.tabName}
                    </span>
                )}
            </span>
            <span style={{ fontSize: 12, color: theme.colors.textDim, whiteSpace: 'nowrap', flexShrink: 0 }}>
                {formatRelativeTime(item.timestamp)}
            </span>
        </div>
        ```

        Key changes from current code:
        - Agent icon (emoji) inserted between group separator and session name, with `title` tooltip
        - `Edit3` lucide icon (10x10px, inline) before tab name
        - Session name still truncates with ellipsis

    3. **Remove the `agent-type-badge` span from Row 3** (lines ~178-187). Delete the entire `<span data-testid="agent-type-badge" ...>` element. Row 3 should now start with the git branch badge (or context % if no branch).

    **Tests to update in `src/__tests__/renderer/components/AgentInbox.test.tsx`:**
    - Remove or update the test `renders agent icon badge with tooltip` — the badge moved from Row 3 to Row 1. Update the test to find the agent icon in Row 1 by looking for an element with `title="claude-code"` and `aria-label="Agent: claude-code"` (same attributes, different location).
    - Remove any test that looks for `data-testid="agent-type-badge"` — replace with a query for the `title` attribute since the element no longer has a testid in the new location.
    - If there's a test checking Row 3 badge count or order, update it to reflect that agent icon is no longer in Row 3.

    **Verify:** `npm run test -- --testPathPattern="AgentInbox" --no-coverage` — all tests pass. `npm run lint` passes.

- [x] **TASK 2 — Fix modal header spacing.** In `src/renderer/components/AgentInbox.tsx`, the header section (around line 595-655) currently crams title, badge, sort buttons, filter buttons, and close button in one 48px row. Restructure it to use two rows:

    **Row 1 (top):** Title "Unified Inbox" + badge "N need action" + close button (X)
    **Row 2 (bottom):** Sort SegmentedControl (left) + Filter SegmentedControl (right)

    Implementation:
    1. Change `MODAL_HEADER_HEIGHT` from `48` to `80` (to accommodate two rows)
    2. Restructure the header div to use `flexDirection: 'column'`:

        ```tsx
        <div
            ref={headerRef}
            className="px-4 border-b"
            style={{
                height: MODAL_HEADER_HEIGHT,
                borderColor: theme.colors.border,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: 8,
            }}
        >
            {/* Header row 1: title + badge + close */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <h2 className="text-base font-semibold" style={{ color: theme.colors.textMain }}>
                        Unified Inbox
                    </h2>
                    <span
                        aria-live="polite"
                        className="text-xs px-2 py-0.5 rounded-full"
                        style={{
                            backgroundColor: `${theme.colors.accent}20`,
                            color: theme.colors.accent,
                        }}
                    >
                        {actionCount} need action
                    </span>
                </div>
                <button
                    onClick={handleClose}
                    className="p-1.5 rounded"
                    style={{ color: theme.colors.textDim }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                    onFocus={(e) => { e.currentTarget.style.outline = `2px solid ${theme.colors.accent}`; }}
                    onBlur={(e) => { e.currentTarget.style.outline = 'none'; }}
                    title="Close (Esc)"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
            {/* Header row 2: sort + filter controls */}
            <div className="flex items-center justify-between">
                <SegmentedControl
                    options={SORT_OPTIONS}
                    value={sortMode}
                    onChange={setSortMode}
                    theme={theme}
                    ariaLabel="Sort sessions"
                />
                <SegmentedControl
                    options={FILTER_OPTIONS}
                    value={filterMode}
                    onChange={setFilterMode}
                    theme={theme}
                    ariaLabel="Filter sessions"
                />
            </div>
        </div>
        ```

    3. Update the `listHeight` calculation (around line 565) — it subtracts `MODAL_HEADER_HEIGHT`. Since header grew from 48→80, this automatically reduces available list space by 32px. Verify the math still works: `min(window.innerHeight * 0.8 - 80 - 36 - 80, 600)`.

    **Tests:** If any test checks for header height or specific header class names, update accordingly. Most tests should be unaffected since they test functionality, not layout.

    **Verify:** `npm run lint` passes. `npm run test -- --testPathPattern="AgentInbox" --no-coverage` — all tests pass.

- [ ] **TASK 3 — Add group expand/collapse toggle.** In `src/renderer/components/AgentInbox.tsx`:

    1. Add state to track collapsed groups in the `AgentInbox` component function:
        ```typescript
        const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
        ```

    2. Add toggle handler:
        ```typescript
        const toggleGroup = useCallback((groupName: string) => {
            setCollapsedGroups(prev => {
                const next = new Set(prev);
                if (next.has(groupName)) {
                    next.delete(groupName);
                } else {
                    next.add(groupName);
                }
                return next;
            });
        }, []);
        ```

    3. Modify the `buildRows` function (or create a filtered version) to exclude items from collapsed groups. After `buildRows(items, sortMode)` is called, filter out item rows whose group is collapsed:
        ```typescript
        const allRows = useMemo(() => buildRows(items, sortMode), [items, sortMode]);
        const rows = useMemo(() => {
            if (collapsedGroups.size === 0) return allRows;
            return allRows.filter(row => {
                if (row.type === 'header') return true; // Always show headers
                // Filter out items belonging to collapsed groups
                const itemGroup = row.item.groupName ?? 'Ungrouped';
                return !collapsedGroups.has(itemGroup);
            });
        }, [allRows, collapsedGroups]);
        ```

    4. Pass `collapsedGroups` and `toggleGroup` to `InboxRow` via `rowProps`:
        - Add `collapsedGroups: Set<string>` and `onToggleGroup: (groupName: string) => void` to the `RowExtraProps` interface
        - Include them in the `rowProps` useMemo

    5. In `InboxRow`, update the group header rendering (line ~342) to include a toggle chevron:
        ```tsx
        if (row.type === 'header') {
            const isCollapsed = collapsedGroups.has(row.groupName);
            return (
                <div
                    style={{
                        ...style,
                        display: 'flex',
                        alignItems: 'center',
                        paddingLeft: 16,
                        fontSize: 13,
                        fontWeight: 600,
                        color: theme.colors.textDim,
                        letterSpacing: '0.5px',
                        textTransform: 'uppercase',
                        borderBottom: `1px solid ${theme.colors.border}60`,
                        cursor: 'pointer',
                    }}
                    onClick={() => onToggleGroup(row.groupName)}
                >
                    {isCollapsed
                        ? <ChevronRight style={{ width: 14, height: 14, marginRight: 4, flexShrink: 0 }} />
                        : <ChevronDown style={{ width: 14, height: 14, marginRight: 4, flexShrink: 0 }} />
                    }
                    {row.groupName}
                </div>
            );
        }
        ```

    6. The `ChevronDown` and `ChevronRight` icons were already added to imports in TASK 1. If TASK 1 has not been executed yet when this task runs, add the import here.

    **Tests to add in `src/__tests__/renderer/components/AgentInbox.test.tsx`:**
    - Test: `it('renders chevron toggle on group headers in grouped mode')` — set sort to "Grouped", verify group headers have a chevron element.
    - Test: `it('collapses group items when group header is clicked')` — click a group header, verify items within that group are hidden.
    - Test: `it('expands collapsed group when header is clicked again')` — click twice, verify items reappear.

    **Verify:** `npm run test -- --testPathPattern="AgentInbox" --no-coverage` — all tests pass. `npm run lint` passes.

- [ ] **TASK 4 — Final verification and lint gate.** Run:
    ```bash
    npm run lint
    npm run test -- --testPathPattern="AgentInbox|useAgentInbox|agentInboxHelpers" --no-coverage
    ```
    Verify: zero TypeScript errors, all tests pass. Report total test count and pass rate.
