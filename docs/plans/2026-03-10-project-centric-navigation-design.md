# Design: Project-Centric Navigation with Inbox

**Date:** 2026-03-10
**Approach:** A — New Project Entity (additive, not rewrite)
**Status:** Approved

---

## Summary

Redesign Maestro's navigation from agent-centric (flat session list) to project/repo-centric (projects in left bar, session tabs per project, global inbox for attention). This is a fork divergence from upstream Maestro.

### User Decisions

| Decision | Choice |
|----------|--------|
| Project creation | Explicit (user picks a repo folder) |
| Tab identity | Each tab = one agent session (many per project) |
| Inbox location | Left sidebar section, above projects |
| Inbox triggers | Agent finished, errored, or waiting for input |
| Inbox click behavior | Navigate + auto-dismiss |
| Multi-project view | One project at a time |
| Legacy features | Drop bookmarks/groups; keep group chat as session type |

---

## 1. Data Model

### New: `Project`

```typescript
interface Project {
	id: string;            // UUID
	name: string;          // User-facing (defaults to repo folder name)
	repoPath: string;      // Absolute path to git root
	createdAt: number;     // Timestamp
	color?: string;        // Optional accent color
	collapsed?: boolean;   // Collapsed in sidebar
}
```

### Modified: `Session`

```diff
interface Session {
+  projectId: string;       // Required — links to a Project
-  groupId?: string;        // Removed (groups are gone)
-  bookmarked?: boolean;    // Removed (bookmarks are gone)
   // All other fields unchanged
}
```

### New: `InboxItem`

```typescript
interface InboxItem {
	id: string;              // UUID
	sessionId: string;       // Which session needs attention
	tabId: string;           // Which tab specifically
	projectId: string;       // Which project (for navigation)
	reason: 'finished' | 'error' | 'waiting_input';
	agentType: ToolType;     // e.g. 'claude-code'
	tabName: string;         // Snapshot at trigger time
	projectName: string;     // Snapshot at trigger time
	timestamp: number;       // When surfaced
}
```

### Removed

- `Group` type (from `src/shared/types.ts`)
- All group-related store actions and selectors
- All bookmark-related store actions and selectors
- `useSessionCategories` hook (categories no longer needed)

---

## 2. Store Architecture

### New: `projectStore`

```typescript
// src/renderer/stores/projectStore.ts
interface ProjectState {
	projects: Project[];
	activeProjectId: string;
}

interface ProjectActions {
	setProjects(projects: Project[]): void;
	addProject(project: Project): void;
	removeProject(projectId: string): void;
	updateProject(projectId: string, updates: Partial<Project>): void;
	setActiveProjectId(projectId: string): void;
}

// Selectors
selectActiveProject(state): Project | undefined;
selectAllProjects(state): Project[];
```

### New: `inboxStore`

```typescript
// src/renderer/stores/inboxStore.ts
interface InboxState {
	items: InboxItem[];
}

interface InboxActions {
	addItem(item: InboxItem): void;
	dismissItem(itemId: string): void;
	dismissAllForProject(projectId: string): void;
	clearAll(): void;
}

// Selectors
selectInboxItems(state): InboxItem[];
selectInboxCount(state): number;
selectInboxByProject(projectId: string): (state) => InboxItem[];
```

### Modified: `sessionStore`

**Removed actions:** `setGroups`, `addGroup`, `removeGroup`, `updateGroup`, `toggleGroupCollapsed`, `toggleBookmark`

**Removed state:** `groups: Group[]`

**Removed selectors:** `selectBookmarkedSessions`, `selectSessionsByGroup`, `selectUngroupedSessions`

**Added selector:** `selectSessionsByProject(projectId: string)` — returns sessions filtered by projectId

**Modified:** `addSession()` now requires `projectId` on the session.

### Unchanged: `tabStore`, `uiStore`, `notificationStore`

These stores work at the session/tab level and don't need changes. Tab operations are session-scoped, not project-scoped.

---

## 3. Left Sidebar Layout

```
┌─────────────────────────────────┐
│ INBOX (3)              [Clear]  │  ← Collapsible section, count badge
│ ┌─ 🟢 Claude finished          │     Newest first
│ │  Tab 3 · Maestro · 2m ago    │     Click → navigate + dismiss
│ ├─ 🔴 Codex error              │
│ │  Fix API · Backend · 5m ago  │
│ └─ 🟡 Claude waiting           │
│    Review · Mobile · 8m ago    │
├─────────────────────────────────┤
│ PROJECTS                [+ New] │  ← Always visible
│ ▸ Maestro           ●3 tabs    │     Active project highlighted
│ ▾ Backend API       ●2 tabs    │     Tab count badge
│ ▸ Mobile App        ●1 tab     │
└─────────────────────────────────┘
```

### Project Item Display

Each project row shows:
- Project name (editable on double-click)
- Optional color accent (left border)
- Tab count badge
- Active indicator (background highlight + accent border, same pattern as current SessionItem)
- Expand/collapse chevron (to peek at session list without switching)

### Sidebar Actions

- **[+ New Project]** button opens a folder picker → creates Project with folder name as default name
- Right-click context menu: Rename, Change Color, Delete (with confirmation)
- Drag-drop reordering of projects

---

## 4. Middle Area

### Tab Bar (Per Active Project)

When a project is selected, the tab bar shows ALL sessions for that project as tabs:

```
┌──────────────────────────────────────────────────────────┐
│ [🤖 Claude: Main] [🤖 Claude: Refactor] [📦 Codex: Fix] │  ← Session tabs
│  ● busy              idle                  ● error       │
└──────────────────────────────────────────────────────────┘
```

Each tab shows:
- Agent icon (from toolType)
- Session name or tab name
- State indicator (green dot = idle, spinner = busy, red dot = error, yellow = waiting)

### Tab ↔ Session Relationship

**Simplification:** In the current model, each Session has multiple AITabs inside it. For the new model, the tab bar shows sessions (not AITabs within a session). Each session is one tab in the project view.

If a user needs multiple conversations within one agent session, they use the existing AITab system — but at the project level, each session is one tab.

This means:
- Clicking a project tab = selecting that session (`setActiveSessionId`)
- The existing AITab sub-tabs within a session remain available (secondary tab bar or tab dropdown within the session)
- This is a **two-level tab hierarchy**: Project tabs (sessions) → Session sub-tabs (AITabs)

### Content Area

Unchanged — `MainPanel.tsx` renders the active session's content (logs, input area, file preview). The session's own AITab system handles sub-tab navigation.

---

## 5. Inbox System

### Trigger Logic

The inbox watches session state transitions. A new `useInboxWatcher` hook (or effect within App.tsx) subscribes to sessionStore:

```
When session.state transitions:
  busy → idle:          reason = 'finished'
  busy → error:         reason = 'error'
  * → waiting_input:    reason = 'waiting_input'

Only create inbox item if:
  1. The session is NOT the currently active session, OR
  2. The session IS active but the app window is not focused

Deduplicate: Don't add if an item for the same session+reason already exists.
```

### Dismissal Rules

- **Click:** Navigate to project + session, dismiss item
- **Clear button:** Dismiss all items in inbox
- **Auto-dismiss on navigate:** If user manually navigates to a session that has inbox items, dismiss those items
- **No persistence:** Inbox is runtime-only. On app restart, inbox is empty (session states reset to idle anyway)

### Display

- Sorted by timestamp, newest first
- Color-coded icons: 🟢 finished, 🔴 error, 🟡 waiting
- Each item: reason icon + agent type + tab/session name + project name + relative time ("2m ago")
- Compact layout — each item fits in ~40px height

### Audio/OS Notifications

Leverage existing `notificationStore` infrastructure:
- When an inbox item is created, also fire a toast notification
- If `osNotificationsEnabled`, fire an OS-level notification
- If `audioFeedbackEnabled`, play notification sound

---

## 6. Persistence

### Projects

New IPC namespace alongside existing sessions/groups:

**Main process:**
- New `projectsStore` (electron-store) in main process
- IPC handlers: `projects:getAll`, `projects:setAll`
- Registered in `registerPersistenceHandlers()`

**Renderer:**
- Same debounced persistence pattern as sessions (`useDebouncedPersistence`)
- `projectStore` mutations → debounced IPC write

**Preload bridge:**
- Add `window.maestro.projects.getAll()` and `window.maestro.projects.setAll()`

### Sessions

Existing persistence unchanged. Session now includes `projectId` field (persisted automatically since sessions are saved as JSON).

### Inbox

Runtime-only. Not persisted. Inbox items are transient — stale on restart since session states reset to idle.

---

## 7. Migration Strategy

On first load after the update, the restoration hook detects the old data format and migrates:

```
1. Load existing groups from groups:getAll
2. Load existing sessions from sessions:getAll

3. For each group that has sessions:
   a. Create a Project: { name: group.name, repoPath: first session's projectRoot }
   b. Set projectId on all sessions in this group

4. For ungrouped sessions:
   a. Group by git root (session.projectRoot or session.cwd)
   b. Create one Project per unique root
   c. Name = folder basename
   d. Set projectId on each session

5. Save projects via projects:setAll
6. Save migrated sessions via sessions:setAll
7. Delete groups store (or leave inert — it won't be read again)

8. Set activeProjectId = project containing the previously active session
```

**Safety:** Migration runs once. A `migrationVersion` flag in settings tracks whether migration has run. If migration fails, fall back to creating a single "Default" project with all sessions.

---

## 8. Keyboard Shortcuts

### New Shortcuts

| Action | Shortcut | Notes |
|--------|----------|-------|
| Cycle projects forward | `Ctrl+Shift+J` | Wraps around |
| Cycle projects backward | `Ctrl+Shift+K` | Wraps around |
| Focus inbox | `Ctrl+I` | Arrow keys navigate items, Enter to jump |
| Dismiss inbox item | `Backspace` (when inbox focused) | Removes without navigating |
| New project | `Ctrl+Shift+N` | Opens folder picker |

### Existing Shortcuts (Modified Scope)

| Action | Shortcut | Change |
|--------|----------|--------|
| Cycle sessions | `Cmd+J / Cmd+K` | Now scoped to active project's sessions |
| Jump to session N | `Cmd+Opt+1-9` | Now scoped to active project's sessions |
| New session | `Cmd+N` | Creates session in active project |

---

## 9. Group Chat as Session Type

Group chat (multi-agent collaboration) becomes a session type within a project rather than a separate sidebar section.

- New session with `toolType: 'group-chat'` (or existing group chat mechanism)
- Shows as a tab in the project's tab bar alongside regular agent sessions
- Group chat tab can contain multiple agents collaborating
- Uses existing group chat infrastructure, just re-parented under a project

---

## 10. Files Changed (Scope Estimate)

### New Files
- `src/renderer/stores/projectStore.ts` — Project state management
- `src/renderer/stores/inboxStore.ts` — Inbox state management
- `src/renderer/components/ProjectSidebar/ProjectSidebar.tsx` — New left sidebar
- `src/renderer/components/ProjectSidebar/ProjectItem.tsx` — Project row
- `src/renderer/components/ProjectSidebar/InboxSection.tsx` — Inbox section
- `src/renderer/components/ProjectSidebar/InboxItem.tsx` — Inbox item row
- `src/renderer/hooks/useInboxWatcher.ts` — State transition → inbox trigger
- `src/renderer/hooks/useProjectRestoration.ts` — Load + migrate projects
- `src/main/ipc/handlers/projects.ts` — Project persistence IPC

### Modified Files
- `src/renderer/types/index.ts` — Add Project, InboxItem; modify Session
- `src/shared/types.ts` — Remove Group; add Project to shared types
- `src/renderer/App.tsx` — Wire projectStore, inbox watcher, new sidebar
- `src/renderer/stores/sessionStore.ts` — Remove group logic, add project selectors
- `src/renderer/components/TabBar.tsx` — Show sessions-as-tabs for active project
- `src/main/index.ts` — Register project IPC handlers
- `src/main/preload.ts` — Expose projects namespace
- `src/main/ipc/handlers/persistence.ts` — Add projects persistence
- `src/renderer/hooks/session/useSessionRestoration.ts` — Migration logic
- `src/renderer/constants/shortcuts.ts` — New keyboard shortcuts

### Removed Files / Dead Code
- `src/renderer/components/SessionList/` — Replaced by ProjectSidebar
- Group-related hooks/utilities
- Bookmark-related logic throughout

---

## 11. Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Migration corrupts session data | Migration writes new data alongside old; old data preserved until verified |
| Inbox noise (too many items) | Only trigger on state transitions, not every output; deduplicate by session |
| Performance with many projects | Memoized selectors, virtualized lists if >20 projects |
| Breaking existing keyboard shortcuts | Existing shortcuts keep same keys, just scoped differently |
| Group chat regression | Keep existing group chat infra; only change how it's surfaced in UI |
