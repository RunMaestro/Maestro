# CLI / UI Parity Audit

Goal: (almost) anything a person can do by pointing and clicking in Maestro, an
agent should be able to do through `maestro-cli`. This file records where that
holds today, where it does not, and why.

Audited 2026-08-19 against the three surfaces that define "clickable": the
keyboard shortcut registry (`src/renderer/constants/shortcuts.ts`), the Quick
Actions command builders (`src/renderer/components/QuickActionsModal/commands/`),
and the Left Bar context menus (`src/renderer/components/SessionList/`). The
authoritative CLI surface is `docs/cli-reference.md`, generated from the
Commander tree by `npm run gen:cli-reference`.

## How to add a scriptable write

Persistent per-agent and per-tab state goes through **one** message:
`update_session_config`. It is the only write path that has all three of the
things a scriptable operation needs:

1. An **allowlist** in the renderer, so the CLI cannot write arbitrary `Session`
   internals.
2. A **response channel**, so the CLI learns whether the write landed instead of
   assuming it did.
3. A **`setMany` flush** before the ack, so a read taken immediately after the
   write sees the new value rather than racing the renderer's 2 second debounced
   persistence.

The handler lives in `useAppRemoteEventListeners.ts`
(`maestro:remoteUpdateSessionConfig`). It holds two allowlists: agent fields,
and - when the patch carries a `tabId` - AI tab fields. Adding a scriptable
field usually means one allowlist entry plus one CLI verb.

Do **not** reach for the older `mainWindow.webContents.send('remote:...')`
pattern (`star_tab`, `toggle_bookmark`, `reorder_tab`) for new state. Those are
fire-and-forget: they report success as soon as the message is handed to the
renderer, they do not confirm the renderer applied anything, and they do not
flush. They stay because the mobile web client speaks them.

Prefer **explicit set operations over toggles**. A toggle is unusable from a
script: re-running it flips back, and an agent driving the desktop has no
reliable way to observe the result mid-flight. `bookmark`/`unbookmark`,
`tab star`/`tab unstar`, and `tab read`/`tab unread` are all set verbs for this
reason.

Every write should have a matching read. A verb an agent cannot verify is a verb
an agent has to guess about.

A tab-targeted verb takes its tab id through `resolveTabEntry()`
(`src/cli/services/session-command.ts`), which accepts an exact id, a unique
prefix, or the literal `active` - the tab that agent has selected, with
`-a <agent-id>` naming whose. Use the helper rather than matching ids yourself:
it returns the whole `DesktopTabEntry`, so a verb that needs the current value
(`tab thinking cycle`) reads it from the same call that resolved the tab instead
of taking a second round trip or trusting a value the caller guessed.

## Covered

| Point-and-click action                       | CLI                                                               |
| -------------------------------------------- | ----------------------------------------------------------------- |
| Bookmark / unbookmark an agent (Cmd+Shift+B) | `bookmark` / `unbookmark`, or `update-agent --bookmark`           |
| Create / rename / remove an agent            | `create-agent`, `rename-agent`, `remove-agent`                    |
| Edit Agent modal fields                      | `update-agent`, `settings agent set`                              |
| Switch an agent's provider                   | `update-agent --provider --force`                                 |
| Move an agent to a group                     | `update-agent --group`                                            |
| Change working directory                     | `update-agent --cwd`                                              |
| SSH remote execution config                  | `update-agent --ssh-remote / --ssh-cwd`, `create-ssh-remote`      |
| Focus an agent, switch AI/Shell mode         | `focus-agent`, `switch-mode`                                      |
| Create / rename / remove a group             | `create-group`, `rename-group`, `remove-group`                    |
| Group icon, color, and nesting               | `create-group --icon/--color/--parent`, `update-group`            |
| Create a worktree agent                      | `create-worktree`                                                 |
| New / close / rename a tab                   | `tab new`, `tab close`, `tab rename`                              |
| Star a tab (Cmd+Shift+S)                     | `tab star` / `tab unstar`                                         |
| Mark a tab unread                            | `tab unread` / `tab read`                                         |
| Toggle Save to History                       | `tab save-to-history`                                             |
| Composer chips: thinking, read-only access   | `tab thinking` (off/on/sticky/cycle), `tab read-only`             |
| Model / effort pills on one tab              | `tab model`, `tab effort` (`inherit` clears the override)         |
| Enter-to-send chip                           | `tab enter-to-send`                                               |
| Read one tab's settings back                 | `tab show`, or `session list --json`                              |
| Move Tab to First / Last                     | `tab move <tab-id> first\|last\|<index>`                          |
| Send a message, or run a shell command       | `send`, `dispatch`, `send-terminal`                               |
| Open a file / URL / terminal tab             | `open-file`, `open-browser`, `open-terminal`                      |
| Open a modal or dashboard                    | `open <surface> [--tab]` (registry in `src/shared/uiSurfaces.ts`) |
| Auto Run: start, stop, resume, skip, abort   | `auto-run`, `stop-auto-run`, `resume-auto-run`, ...               |
| Settings, theme, Encore features             | `settings`, `theme`, `set-theme`, `encore`                        |
| Toasts and center flashes                    | `notify toast`, `notify flash`                                    |
| Cue subscriptions and scheduled tasks        | `cue trigger`, `cue schedule`, `cue pipeline`                     |

## Open gaps

Ranked by how often an agent is likely to hit them. None of these are blocked by
a design constraint; they are simply not built yet.

1. **Interrupt a running turn.** Escape stops a busy agent in the UI. There is
   no CLI equivalent and no WS message behind one. This is the largest remaining
   gap: an agent that starts a runaway turn on another agent cannot stop it.
2. **Snooze a tab / list snoozed tabs.** `Cmd+Shift+Z` hides a tab until a
   chosen time. Scriptable snooze needs time parsing plus a wake entry in
   `snoozedTabs`, so it is more than an allowlist entry. `open snoozed-tabs`
   shows the list in the UI but returns nothing to the caller.
3. **Reopen a closed tab.** `closedTabHistory` and `unifiedClosedTabHistory` are
   runtime-only and never persisted, so the CLI cannot see the stack to restore
   from it. Closing this means persisting that history first.
4. **Duplicate an agent.** The context menu's "Duplicate..." opens a modal with
   options (what to copy). `create-agent` can approximate it, but there is no
   one-shot duplicate.
5. **Toggle Live mode** (`isLive`) for the web interface.
6. **Collapse / expand a group**, and reorder agents in the Left Bar. Pure
   presentation; low value for automation, which is why they are last.
7. **Git actions** (View Git Log / Diff, Pull, Push, Change Branch, Create PR).
   Deliberately not mirrored: these open modals over `useGitAgentActions`, and an
   agent already has `git` and `gh` in its shell, which is strictly more capable.
   Only the modal-opening is unavailable, not the capability.
8. **Wizard and interactive pickers** (New Agent Wizard, Fuzzy File Search,
   Tab Switcher, Search: Messages). These are interactive by definition; the
   underlying data is reachable through `list`, `session show`, and
   `director-notes history`.
