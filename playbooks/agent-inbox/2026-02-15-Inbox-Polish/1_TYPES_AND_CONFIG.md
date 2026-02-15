# Phase 1: Update — Types and Configuration

## Context

- **Playbook:** Unified Inbox Polish
- **Agent:** {{AGENT_NAME}}
- **Project:** {{AGENT_PATH}}
- **Loop:** {{LOOP_NUMBER}}
- **Date:** {{DATE}}
- **Working Folder:** {{AUTORUN_FOLDER}}

## Purpose

Add the new `starred` filter mode and `byAgent` sort mode to the type system, update filter/sort option arrays, and change the default filter from `all` to `unread`.

## Key Paths

- **Types:** `src/renderer/types/agent-inbox.ts`
- **Component:** `src/renderer/components/AgentInbox.tsx`
- **Hook:** `src/renderer/hooks/useAgentInbox.ts`

---

## Task 1: Extend InboxFilterMode and InboxSortMode types

- [ ] Open `{{AGENT_PATH}}/src/renderer/types/agent-inbox.ts`. Make two changes: (1) On line 23, change `export type InboxFilterMode = 'all' | 'unread' | 'read'` to `export type InboxFilterMode = 'all' | 'unread' | 'read' | 'starred'`. Update the comment above it to include "Starred". (2) On line 20, change `export type InboxSortMode = 'newest' | 'oldest' | 'grouped'` to `export type InboxSortMode = 'newest' | 'oldest' | 'grouped' | 'byAgent'`. Update the comment above it to include "By Agent". Also add a `starred?: boolean` field to the `InboxItem` interface (after the `hasUnread` field on line 16) so the inbox can display the star indicator. Use TABS for indentation. Success criteria: `InboxFilterMode` includes `'starred'`, `InboxSortMode` includes `'byAgent'`, `InboxItem` has optional `starred` field. Run `npx tsc --noEmit --pretty 2>&1 | head -30` from `{{AGENT_PATH}}` to check for type errors — there WILL be exhaustiveness errors in the `matchesFilter` and `sortItems` functions, that's expected and will be fixed in later docs.

## Task 2: Update FILTER_OPTIONS and SORT_OPTIONS arrays + default filter

- [ ] Open `{{AGENT_PATH}}/src/renderer/components/AgentInbox.tsx`. Make three changes: (1) Find the `FILTER_OPTIONS` array (around line 430) and add a new entry: `{ value: 'starred', label: '★ Starred' }` as the LAST option. (2) Find the `SORT_OPTIONS` array (around line 424) and add a new entry: `{ value: 'byAgent', label: 'By Agent' }` as the LAST option. (3) Find the `useState<InboxFilterMode>('all')` call (around line 443) and change the default to `'unread'`. Also add `'starred'` to the `EMPTY_STATE_MESSAGES` record (around line 29) with value `{ text: 'No starred sessions.', showIcon: false }`. Use TABS for indentation. Success criteria: the FILTER_OPTIONS array has 4 entries (all, unread, read, starred), the SORT_OPTIONS array has 4 entries (newest, oldest, grouped, byAgent), the default filter is `'unread'`, and the EMPTY_STATE_MESSAGES record has a `starred` key. Run `npx tsc --noEmit --pretty 2>&1 | head -50` from `{{AGENT_PATH}}` — type errors in `matchesFilter` and `sortItems` are expected at this stage.
