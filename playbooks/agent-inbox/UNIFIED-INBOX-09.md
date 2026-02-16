# Phase 09 — Add Unified Inbox to Left Bar Menu

> **Effort:** Unified Inbox
> **Phase:** 09
> **Goal:** Add "Unified Inbox" entry to the Left Bar hamburger menu between Process Monitor and Usage Dashboard, rename modal title, update all references
> **Files touched:** `src/renderer/components/SessionList.tsx`, `src/renderer/hooks/props/useSessionListProps.ts`, `src/renderer/App.tsx`, `src/renderer/components/AgentInbox.tsx`, `src/renderer/hooks/keyboard/useMainKeyboardHandler.ts`, `src/__tests__/renderer/components/AgentInbox.test.tsx`, `src/__tests__/renderer/hooks/useMainKeyboardHandler.test.ts`

---

## Context for Agent

The Left Bar hamburger menu is rendered in `SessionList.tsx` (lines 586–700). Each menu item follows this exact pattern:

```tsx
<button
    onClick={() => {
        setSomeModalOpen(true);
        setMenuOpen(false);
    }}
    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
>
    <IconComponent className="w-5 h-5" style={{ color: theme.colors.accent }} />
    <div className="flex-1">
        <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
            Label
        </div>
        <div className="text-xs" style={{ color: theme.colors.textDim }}>
            Description
        </div>
    </div>
    <span
        className="text-xs font-mono px-1.5 py-0.5 rounded"
        style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
    >
        {formatShortcutKeys(shortcuts.someShortcut.keys)}
    </span>
</button>
```

**Current menu order (lines 586–700):**
1. Settings (line 586)
2. System Logs (line 610)
3. Process Monitor (line 633)
4. Usage Dashboard (line 656)
5. Maestro Symphony (line 679)

**The "Unified Inbox" entry goes between Process Monitor and Usage Dashboard.**

The `AgentInbox` modal is already functional. The shortcut `Alt+Cmd+I` already works via `useMainKeyboardHandler.ts`. The modal state is managed by `setAgentInboxOpen` from `modalStore.ts`. However, `setAgentInboxOpen` is **not yet passed** as a prop to `SessionList.tsx` — it needs to be threaded through `useSessionListProps.ts` AND the caller in `App.tsx` must provide it.

**Lucide icon:** `Inbox` from `lucide-react` — already available in the library, just not imported yet.

**Critical:** The keyboard handler toast (`useMainKeyboardHandler.ts` line ~411) and its test (`useMainKeyboardHandler.test.ts` line ~1286) both reference `'Agent Inbox'` — these MUST be updated to `'Unified Inbox'` as well.

---

## Tasks

- [x] **TASK 1 — Thread `setAgentInboxOpen` from App.tsx through to SessionList.** Four locations need changes:

    **In `src/renderer/hooks/props/useSessionListProps.ts`:**
    1. Add `setAgentInboxOpen: (open: boolean) => void;` to the `UseSessionListPropsDeps` interface (after `setProcessMonitorOpen` around line 91)
    2. Add `setAgentInboxOpen: deps.setAgentInboxOpen,` to the returned props object (after `setProcessMonitorOpen` around line 198)
    3. Add `deps.setAgentInboxOpen,` to the `useMemo` dependency array (after `deps.setProcessMonitorOpen` around line 326)

    **In `src/renderer/App.tsx`:**
    1. Find the `useSessionListProps()` call (search for `useSessionListProps`). In the deps object passed to it, add `setAgentInboxOpen,` alongside the other modal setters (`setProcessMonitorOpen`, `setUsageDashboardOpen`, etc.). The `setAgentInboxOpen` variable is already destructured from `modalStore` at line 273 — it just needs to be passed into the deps.

    **In `src/renderer/components/SessionList.tsx`:**
    1. Add `setAgentInboxOpen: (open: boolean) => void;` to the `SessionListProps` interface (after `setUsageDashboardOpen` around line 1052)

    **Verify:** `npm run lint` passes with zero type errors. This is critical — if `setAgentInboxOpen` is missing from ANY of the three locations (deps interface, App.tsx caller, SessionList props), TypeScript will error.

- [x] **TASK 2 — Add "Unified Inbox" menu entry in SessionList.** In `src/renderer/components/SessionList.tsx`:

    1. Add `Inbox` to the lucide-react import (line 2–39). Insert it alphabetically among the existing imports (after `Info`).

    2. Destructure `setAgentInboxOpen` from props in the component function (alongside the other setter destructures like `setProcessMonitorOpen`, `setUsageDashboardOpen`).

    3. Insert a new menu button **after Process Monitor** (after line 655, before the Usage Dashboard button at line 656). Use the exact pattern from the other menu items:

        ```tsx
        <button
            onClick={() => {
                setAgentInboxOpen(true);
                setMenuOpen(false);
            }}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
        >
            <Inbox className="w-5 h-5" style={{ color: theme.colors.accent }} />
            <div className="flex-1">
                <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
                    Unified Inbox
                </div>
                <div className="text-xs" style={{ color: theme.colors.textDim }}>
                    Unified tabs inbox
                </div>
            </div>
            <span
                className="text-xs font-mono px-1.5 py-0.5 rounded"
                style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
            >
                {formatShortcutKeys(shortcuts.agentInbox.keys)}
            </span>
        </button>
        ```

    **Verify:** `npm run lint` passes.

- [x] **TASK 3 — Rename "Agent Inbox" / "Inbox" to "Unified Inbox" across ALL references.** This is a multi-file rename. The name must be consistent everywhere:

    **In `src/renderer/components/AgentInbox.tsx`:**
    1. Change the `<h2>` text from `Inbox` to `Unified Inbox` (in the header section)
    2. Change the `aria-label` on the dialog from `"Agent Inbox"` to `"Unified Inbox"`
    3. Update the `useModalLayer` call label from `'Agent Inbox'` to `'Unified Inbox'`

    **In `src/renderer/hooks/keyboard/useMainKeyboardHandler.ts`:**
    1. Find the toast that fires when the inbox shortcut is pressed with zero items (around line 411). Change `title: 'Agent Inbox'` to `title: 'Unified Inbox'`. If there's also a `message` field referencing the old name, update that too.

    **Tests to update in `src/__tests__/renderer/components/AgentInbox.test.tsx`:**
    - Any test checking `aria-label="Agent Inbox"` → change to `"Unified Inbox"`
    - Any test checking heading text "Inbox" → change to "Unified Inbox"
    - Any test checking `useModalLayer` ariaLabel `'Agent Inbox'` → change to `'Unified Inbox'`
    - Search the ENTIRE test file for the strings `'Agent Inbox'` and `'Inbox'` and update every occurrence that refers to the modal name (NOT occurrences in variable names like `AgentInbox`)

    **Tests to update in `src/__tests__/renderer/hooks/useMainKeyboardHandler.test.ts`:**
    - Find the test that checks the toast title (around line 1286). Change `title: 'Agent Inbox'` to `title: 'Unified Inbox'`

    **Verify:** `npm run test -- --testPathPattern="AgentInbox|useMainKeyboardHandler" --no-coverage` — all tests pass. `npm run lint` passes.

- [x] **TASK 4 — Final verification and full regression.** Run:
    ```bash
    npm run lint
    npm run test -- --testPathPattern="AgentInbox|useAgentInbox|agentInboxHelpers|useMainKeyboardHandler" --no-coverage
    ```
    Verify: zero TypeScript errors, all tests pass. If any test still references `'Agent Inbox'` as expected text (not as a component/variable name), fix it. Report total test count and pass rate.
    > ✅ Completed: `npm run lint` — zero TypeScript errors (all 3 tsconfig targets pass). Tests: 4 test files, **204 tests passed** (96 AgentInbox component + 40 useAgentInbox hook + 17 agentInboxHelpers + 51 useMainKeyboardHandler), 100% pass rate. Grep confirmed no remaining `'Agent Inbox'` in user-facing expected text — only in code comments, describe blocks, and variable names.
