# Phase 4: Implement — By Agent Sort Mode

## Context

- **Playbook:** Unified Inbox Polish
- **Agent:** {{AGENT_NAME}}
- **Project:** {{AGENT_PATH}}
- **Loop:** {{LOOP_NUMBER}}
- **Date:** {{DATE}}
- **Working Folder:** {{AUTORUN_FOLDER}}

## Purpose

Implement the `byAgent` sort mode that groups inbox items by their parent agent (session), with agents that have unread items expanded at the top and agents with zero unreads collapsed at the bottom. Reuses the existing group expand/collapse infrastructure.

## Key Paths

- **Hook:** `src/renderer/hooks/useAgentInbox.ts`
- **Component:** `src/renderer/components/AgentInbox.tsx`

---

## Task 1: Add byAgent sorting logic in the hook

- [ ] Open `{{AGENT_PATH}}/src/renderer/hooks/useAgentInbox.ts`. Find the `sortItems` function (lines 125-147). Add a new case `'byAgent'` to the switch statement. The logic: (1) Group items by `sessionName` (the agent name). (2) For each group, compute `unreadCount = items in that group where hasUnread === true`. (3) Sort groups: groups with `unreadCount > 0` come first (sorted by highest unread count descending), then groups with `unreadCount === 0` (sorted alphabetically by sessionName). (4) Within each group, sort items by timestamp descending (newest first). Implementation approach: create a `Map<string, InboxItem[]>` keyed by `sessionName`, populate it, sort the keys using the criteria above, then flatten back to an array. Use TABS for indentation. Success criteria: when `sortMode === 'byAgent'`, items are grouped by `sessionName` with unread groups first. Run `npx tsc --noEmit --pretty 2>&1 | head -30` from `{{AGENT_PATH}}` — there should be ZERO type errors now (all sort/filter modes are handled).

## Task 2: Add byAgent group headers in the component

- [ ] Open `{{AGENT_PATH}}/src/renderer/components/AgentInbox.tsx`. The `buildRows` function (lines 42-59) currently only inserts group headers when `sortMode === 'grouped'`. Update it to ALSO insert headers when `sortMode === 'byAgent'`. The difference: (1) For `'grouped'`, the header text is `item.groupName ?? 'Ungrouped'` (Left Bar group name). (2) For `'byAgent'`, the header text should be `item.sessionName` (the agent name). Modify the function: change `if (sortMode !== 'grouped')` to `if (sortMode !== 'grouped' && sortMode !== 'byAgent')`. Then inside the loop, determine the grouping key based on sort mode: for `'grouped'` use `item.groupName ?? 'Ungrouped'`, for `'byAgent'` use `item.sessionName`. Use TABS for indentation. Success criteria: when `sortMode === 'byAgent'`, group headers appear with agent names.

## Task 3: Add unread count badge and auto-collapse to byAgent headers

- [ ] Open `{{AGENT_PATH}}/src/renderer/components/AgentInbox.tsx`. Two changes: (1) **Unread count badge on group headers.** Find the group header rendering inside `InboxRow` (around lines 370-395). When `sortMode === 'byAgent'`, compute the unread count for this group by counting items in the `rows` array that belong to this group and have `item.hasUnread === true`. Display it as a badge after the group name: `<span style={{ fontSize: 11, marginLeft: 8, padding: '1px 6px', borderRadius: 10, backgroundColor: unreadCount > 0 ? theme.colors.warning + '20' : theme.colors.border + '40', color: unreadCount > 0 ? theme.colors.warning : theme.colors.textDim }}>{unreadCount} unread</span>`. To access `sortMode` inside `InboxRow`, add `sortMode: InboxSortMode` to the `RowExtraProps` interface and pass it through `rowProps`. (2) **Auto-collapse zero-unread agents.** In the main `AgentInbox` component, add a `useEffect` that runs when `sortMode` changes to `'byAgent'`. It should compute which agents have zero unreads and set them as collapsed in `collapsedGroups`. When switching away from `'byAgent'`, clear the auto-collapsed state. Use `items` (the filtered InboxItem array) to determine unread counts per agent. Use TABS for indentation. Success criteria: byAgent group headers show unread count badges, zero-unread agents are auto-collapsed when entering byAgent mode. The `RowExtraProps` interface includes `sortMode`.

## Task 4: Add agent type label to byAgent group headers

- [ ] Open `{{AGENT_PATH}}/src/renderer/components/AgentInbox.tsx`. When `sortMode === 'byAgent'`, the group header should also show the agent type (e.g., "Claude Code", "Codex") next to the agent name. Find the group header rendering in `InboxRow`. When a `'byAgent'` header is displayed, look up the `toolType` from the first item in that group: find the next row after the header that is of type `'item'` and read `item.toolType`. Display it in parentheses: `<span style={{ fontSize: 11, color: theme.colors.textDim, marginLeft: 4 }}>({toolType})</span>`. If the toolType cannot be determined, don't show the parenthetical. To find the first item of a group, pass the full `rows` array (already available via `RowExtraProps`) and scan from `index + 1` until finding a row of type `'item'`. Use TABS for indentation. Success criteria: byAgent group headers show format like `▼ vibework-chat (claude-code)    2 unread`.
