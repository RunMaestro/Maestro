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

## Focus belongs to the human (`--background` / `--focus`)

An agent may create a surface. It may not decide the human should be looking at
it. Every verb that can move the Maestro view or raise a notice carries a
`background` bit so a caller that wants to stay out of the way has a way to say
so, and the bundled system prompt tells agents to pass it by DEFAULT.

`background: true` means exactly two things, everywhere: the active **agent**
does not change, and the active **tab** inside any agent does not change. The
surface is still created and still addressable - it lands in the tab bar the way
a browser opens a background tab. "Created but invisible" is a different bug and
must never pass as background placement.

### The flag is ADDITIVE. No verb's default changed.

The defect was that an agent which wanted to be polite had no way to ask. It was
**not** that the verbs focus. Every verb behaves exactly as it did before when
the flag is absent, so no existing script, playbook, Cue prompt, or
muscle-memory invocation changes - what changed is the guidance, which now says
to pass the flag rather than leaving each agent to guess.

That split matters: flipping the CLI defaults would silently rewrite behaviour
for every caller that has already shipped, including the web and mobile clients,
which send the same messages and legitimately DO want to focus. Flipping the
guidance changes only what new calls ask for.

| Verb                                              | Message                                               | Default (unchanged)                     |
| ------------------------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| `open-file`                                       | `open_file_tab`                                       | focuses                                 |
| `open-terminal`                                   | `open_terminal_tab`                                   | focuses                                 |
| `open-browser`                                    | `open_browser_tab`                                    | focuses                                 |
| `tab new`                                         | `new_tab` / `new_ai_tab_with_prompt`                  | focuses                                 |
| `dispatch --new-tab`                              | `new_ai_tab_with_prompt`                              | **background** (as it always was)       |
| `dispatch` (no `--new-tab`)                       | `send_command`                                        | selects the target agent                |
| `create-agent`                                    | `create_session`                                      | selects the new agent                   |
| `create-worktree`                                 | `create_worktree_session` + `send_command`            | selects the new agent                   |
| `switch-mode`                                     | `switch_mode`                                         | switches                                |
| `refresh-auto-run`                                | `refresh_auto_run_docs`                               | selects the target agent, flashes       |
| `refresh-files`                                   | `refresh_file_tree`                                   | **already quiet**; flag accepted, no-op |
| `focus-agent`, `send --tab`, `open`, `open-graph` | `select_session`, `open_modal`, `open_document_graph` | **always foreground, no flag**          |

`focus-agent`, `send --tab`, `open` and `open-graph` exist TO move the view - the
caller named that intent, and the graph is a full-window overlay whose only
effect IS being looked at, so a background one would do nothing. They are
deliberately absent from the table and must stay that way.

`--focus` ships on every verb even where it currently just names the default,
because a future default flip needs the escape hatch to already exist.

### Two verbs of one command name: `dispatch`

`dispatch --new-tab` is background by default and `dispatch` (writing to an
existing tab) is not. Both are correct - one creates a surface the caller will
address by id, the other writes into a conversation - and they are why the table
is keyed by **verb** rather than by message. `send_command` is also what
`create-worktree` uses to deliver its optional `--message`, and that call carries
the placement the CALLER resolved for `create-worktree` rather than re-resolving
as `dispatch`. Without that, `create-worktree --background --message "..."`
created the agent quietly and was then yanked onto it one message later, which
reads as the flag not working.

### Verbs that accept the flag and ignore it

`refresh-files` renders no notice and moves no selection: the Files panel it
refreshes is only drawn for the agent already on screen. It still accepts
`--background`, and `ALREADY_QUIET_VERBS` in `shared/focusPlacement.ts` is where
that is recorded.

This is not a placeholder. The guidance agents are given is "pass `--background`
unless the user asked to be taken there", and commander **rejects an unknown
option** - so one verb that refused the flag would turn a polite habit into a
failed command, and the rule would have to be taught as a lookup table instead of
a sentence. A verb belongs on that list only while it is genuinely quiet; the
moment one grows a notice or a selection change it moves into
`CLI_BACKGROUND_DEFAULTS` and the flag starts meaning something, with no change
to anything already calling it.

### Placement is not error suppression

A failed command still raises its toast with `background: true` set. The flag
says where a surface goes, not whether the user gets to hear that something
broke - `openTerminalTab`'s "Failed to start terminal" and `configureAutoRun`'s
"Worktree Error" toasts are deliberately ungated.

### The contract lives in one module

`src/shared/focusPlacement.ts`, imported by both ends:

- CLI: `resolveBackgroundFlag(flags, verb)` turns `--background` / `--focus`
  into the bit that goes on the wire. Keyed by **verb, not message**: `tab new
--prompt` and `dispatch --new-tab` both send `new_ai_tab_with_prompt` and
  disagree about the default, so keying by message would force one of them to
  change behaviour.
- Main process: `readBackgroundField(message)` reads it back, and it is an
  **opt-in** - only a literal `true` counts.

> [!WARNING]
> Never write `message.background !== false` in a handler. That reads an absent
> field as an opt-in and silently stops the verb from focusing, which breaks
> every existing caller at once. It is the single most likely way this change
> regresses, and it is why the read goes through one shared function.

### `--no-switch` is NOT a spelling of `--background`

They coexist on `open-file` and mean different things:

- `--no-switch` stays on the current agent and **still activates the tab there**.
  If you were already on that agent, your view still changes.
- `--background` changes nothing currently rendered, on any agent.

Passing both is fine; `--background` is strictly stronger and wins. Folding the
first into the second would silently change behaviour for everyone already
passing it. Worth knowing regardless: `--no-switch` reads like it means
`--background` and does not, so anyone who reached for it probably wanted the
stronger one.

### Renderer side

Background placement is the absence of a focus patch: the four `*FocusFields`
helpers in `src/renderer/utils/tabFocusFields.ts` are what make a tab visible, so
`createTab({ activate: false })`, `addTerminalTab(s, tab, { activate: false })`
and `handleOpenFileTab(file, { activate: false })` simply do not spread one.
`open_file_tab` is the one three-state path, because it has to serve both flags:

```
neither       -> switch agent, activate tab   (default)
--no-switch   -> stay on agent, activate tab
--background  -> touch nothing rendered anywhere
```

### Verifying

Use `Claude/Tools/focus_watch.py`, never your eyes: it logs every focus
transition, so an inert flag cannot pass as a fix. **Two runs per verb:**

1. **With `--background`**, against a _different_ agent than the focused one:
   the log stays empty, and the surface still exists (`tab show`,
   `session list`, `list terminals`).
2. **Without the flag**: the log records exactly the jump it recorded before.
   Since no default changed, an unflagged call that stops focusing is a
   regression - and it is the failure mode this design is most likely to
   produce.

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
| Save a pasted chat image (right-click)       | `image save` (`image list` to find it)                            |
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
