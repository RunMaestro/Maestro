# Group Chat Composer Parity

Verified against `origin/rc` at `bc203be21` (2026-10-19). Paths are relative to `src/renderer/` unless they start with `src/`. "AI chat" is `components/InputArea/` plus `hooks/input/`; "Group Chat" is `components/GroupChatInput.tsx` (860 lines) mounted by `components/GroupChatPanel.tsx`.

Status values: **Shared** (one implementation used by both), **Reimpl, identical** (two copies, same behaviour), **Reimpl, drifted** (two copies that differ), **Missing** (AI chat only), **GC only**.

Proposal values: **Share** (as is), **Share, GC behaviour** (shared, with Group Chat specific wiring), **Left out** (not ported to Group Chat; anything Group Chat already has for it stays as it is), **N/A** (not applicable to a room). Every proposal below is final; "decided" in the Reviewer column marks a row the review changed.

## Decisions

The review settled every proposal. Applied as follows:

1. Every N/A row stays N/A, except tab completion: it is wanted for agent references (row 12a, Share) and stays N/A for files, branches, tags and history (row 12b).
2. Of the rows marked unsure, `Screenshot N` references (rows 21, 28) and the image capability gate on Attach (row 23) are shared. Rows 11, 16, 26, 34, 35, 36, 39, 40, 41, 43 and 45 are left out of Group Chat.
3. The image viewer (lightbox, new row 58) and the expanded image viewer (image organizer, row 22) are shared.

"Left out" never removes what Group Chat already has. Where a left-out row has a Group Chat version today, that version stays, and any bug it carries is listed under [Kept Group Chat behaviour](#kept-group-chat-behaviour) as its own item.

## Feature table

"Group Chat today" is the status of the feature in Group Chat. File locations for every row are in the [appendix](#appendix-file-locations).

### Input behaviour and keys

| #   | Feature                                                                                               | Group Chat today                                                 | Proposal            | Reason                                                                                                 | Reviewer |
| --- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| 1   | Textarea grows with content, caret kept visible                                                       | Reimpl, drifted (AI has the one-reflow-per-frame keystroke path) | Share               | Pure presentation; the perf path helps both.                                                           |          |
| 2   | Enter vs Cmd+Enter to send, plus toggle chip                                                          | Reimpl, drifted                                                  | Share, GC behaviour | Same rule; the setting source differs (room has no tab).                                               |          |
| 3   | Escape blurs composer and focuses transcript                                                          | Missing                                                          | Share               | Same keyboard-first contract in any transcript.                                                        |          |
| 4   | Cmd+F from the composer opens Find                                                                    | Reimpl, drifted                                                  | Share, GC behaviour | Same gesture; only the search key differs (`groupChatOutputSearchKey`).                                |          |
| 5   | Read-only toggle chord                                                                                | Reimpl, drifted                                                  | Share, GC behaviour | Must honour the user's binding; target is the room flag.                                               |          |
| 6   | Cmd+Y opens staged image carousel                                                                     | Shared (plus redundant copy)                                     | Share               | Global handler already covers rooms; drop the copy.                                                    |          |
| 7   | Pasted text is trimmed of surrounding whitespace                                                      | Reimpl, identical                                                | Share               | Identical behaviour, two copies.                                                                       |          |
| 8   | Spell check follows setting                                                                           | Shared (setting)                                                 | Share               | Already the same.                                                                                      |          |
| 9   | Placeholder text                                                                                      | Reimpl, drifted                                                  | Share, GC behaviour | Placeholder becomes a surface prop.                                                                    |          |
| 10  | `!` command ladder (shell / AI command), `CommandModeBar`, `AiCommandProposal`, `$` prefix, monospace | Missing                                                          | N/A                 | Runs in one agent's cwd (`resolveCommandCwd(session)`) on that tab's provider; a room has neither.     |          |
| 11  | Slash command popover                                                                                 | Missing                                                          | Left out            | Commands are bound to one agent or provider.                                                           | decided  |
| 12a | Tab completes an `@agent` reference with the picker closed                                            | Missing (AI chat has none either)                                | Share               | Today Tab only accepts an open `@` picker (row 17). New: one match completes, several open the picker. | decided  |
| 12b | Shell tab completion (files, branches, tags, history)                                                 | Missing                                                          | N/A                 | Shell input only; a room has none.                                                                     | decided  |
| 13  | Up Arrow command history                                                                              | Missing (terminal only)                                          | N/A                 | Not an AI chat feature; terminal mode only.                                                            |          |
| 14  | Voice dictation (mic, coarse pointer only)                                                            | Missing                                                          | Share               | Text entry only; nothing agent specific.                                                               |          |

### Mentions

| #   | Feature                                                                      | Group Chat today | Proposal            | Reason                                                                               | Reviewer |
| --- | ---------------------------------------------------------------------------- | ---------------- | ------------------- | ------------------------------------------------------------------------------------ | -------- |
| 15  | `@` picker (agents and groups, group expands to members)                     | Shared           | Share, GC behaviour | Already shared with a locked category.                                               |          |
| 16  | `@` category cycling (Left/Right), file and folder mentions, folder drill-in | Missing          | Left out            | Relative paths are ambiguous across participants. Agents-only picker (row 15) stays. | decided  |
| 17  | `@` picker keyboard (arrows, Tab/Enter accept, Escape)                       | Reimpl, drifted  | Share               | Same picker, same keys.                                                              |          |
| 18  | Live `@mention` pills                                                        | Shared           | Share               | Already shared; roster is a prop.                                                    |          |
| 19  | `MentionRoutingBar` (parallel / consult first / hand-off)                    | Missing          | N/A                 | Describes the cross-agent consult path; room mentions go through the moderator.      |          |

### Images and files

| #   | Feature                                                               | Group Chat today       | Proposal            | Reason                                                         | Reviewer |
| --- | --------------------------------------------------------------------- | ---------------------- | ------------------- | -------------------------------------------------------------- | -------- |
| 20  | Staged image strip (thumbnails, remove, annotate, drag to reorder)    | Shared                 | Share               | Already shared.                                                |          |
| 21  | Reorder rewrites `Screenshot N` text in the draft                     | Missing                | Share               | Main lists room images as numbered paths, so N lines up.       | decided  |
| 22  | Expanded image viewer: image organizer modal (button and Cmd+Shift+Y) | Shared (chord drifted) | Share               | Fix the chord to read the visible composer's images.           | decided  |
| 23  | Attach image button and file picker                                   | Reimpl, drifted        | Share, GC behaviour | One picker; room gates on the moderator's provider.            | decided  |
| 24  | Image paste                                                           | Shared                 | Share               | Already shared.                                                |          |
| 25  | Image drop                                                            | Shared                 | Share               | Already shared.                                                |          |
| 26  | External file drop inserts `@path`                                    | Shared (drifted root)  | Left out            | Room keeps today's drop; its path root bug is item K1.         | decided  |
| 27  | Files panel drag inserts `@path` or stages image                      | Missing                | N/A                 | A room has no Files tab (Right Bar is Participants / History). |          |
| 28  | Drag a thumbnail into the text as `Screenshot N`                      | Missing                | Share               | Same convention as row 21.                                     | decided  |
| 29  | Upload local files to host (web-desktop)                              | Missing                | Share               | Handler already supports rooms; only the control is absent.    |          |
| 58  | Image viewer: lightbox (thumbnail, Cmd+Y, transcript image)           | Shared                 | Share               | One `LightboxModal`; branches on `isGroupChat`.                | decided  |

### Draft handling

| #   | Feature                                                                          | Group Chat today          | Proposal            | Reason                                     | Reviewer |
| --- | -------------------------------------------------------------------------------- | ------------------------- | ------------------- | ------------------------------------------ | -------- |
| 30  | Draft persists per conversation, flushed on switch / blur / drop / composer open | Shared                    | Share, GC behaviour | Shared hook; storage stays per surface.    |          |
| 31  | Staged images kept per conversation                                              | Reimpl (parallel storage) | Share, GC behaviour | Composer takes images through the adapter. |          |
| 32  | Prompt Composer (expanded editor, Cmd+Shift+P)                                   | Shared                    | Share               | Already shared.                            |          |

### Toolbar pills and toggles

| #   | Feature                                     | Group Chat today  | Proposal | Reason                                                            | Reviewer |
| --- | ------------------------------------------- | ----------------- | -------- | ----------------------------------------------------------------- | -------- |
| 33  | Save to History pill (Cmd+S)                | Missing           | N/A      | Writes a per-tab synopsis entry; a room keeps its own history.    |          |
| 34  | Permission / Read-Only pill                 | Reimpl, drifted   | Left out | Room keeps its Read-Only toggle; global flag is item K2.          | decided  |
| 35  | Thinking pill (off / on / sticky)           | Missing           | Left out | Per-tab stream setting with no room equivalent.                   | decided  |
| 36  | Model and effort pills, Cmd+Shift+0 console | Missing           | Left out | A room mixes providers; moderator model stays in Edit Group Chat. | decided  |
| 37  | Notification settings bell                  | Reimpl, identical | Share    | Same popover, two copies.                                         |          |

### Send and queue

| #   | Feature                                                                                                                                                                                                | Group Chat today                      | Proposal            | Reason                                                                  | Reviewer |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------- | ----------------------------------------------------------------------- | -------- |
| 38  | Send button                                                                                                                                                                                            | Reimpl, drifted                       | Share, GC behaviour | Busy tint comes from main's room state.                                 |          |
| 39  | Send images with no text                                                                                                                                                                               | Missing                               | Left out            | Room keeps requiring text before Send.                                  | decided  |
| 40  | Send menu while busy (Queue / Force Send / Queue Held / Steer)                                                                                                                                         | Missing                               | Left out            | Busy room send keeps queueing through main.                             | decided  |
| 41  | Steer chord (Opt+Cmd+Enter) from composer and window                                                                                                                                                   | Missing (chord)                       | Left out            | Room keeps Steer as a button on a queued card (row 44).                 | decided  |
| 42  | Forced Parallel Send (Cmd+Shift+Enter)                                                                                                                                                                 | Missing                               | N/A                 | Main serializes rounds; there is no parallel lane in a room.            |          |
| 43  | Queue Held (queue paused)                                                                                                                                                                              | Missing                               | Left out            | Main pauses the room queue as a whole.                                  | decided  |
| 44  | Queued items list                                                                                                                                                                                      | Shared (placement and actions differ) | Share, GC behaviour | Same widget; actions come from the surface.                             |          |
| 45  | Edit a queued message (card pencil, Cmd+Shift+E)                                                                                                                                                       | Missing                               | Left out            | Would need a new main queue operation.                                  | decided  |
| 46  | Per-item pause, merge, and Force Send on a queued card                                                                                                                                                 | Missing                               | N/A                 | Main owns ordering and pauses the queue as a whole.                     |          |
| 47  | Queue paused banner with Resume, "Sending, cannot remove"                                                                                                                                              | GC only                               | Share, GC behaviour | Becomes a surface slot above the composer; content stays room specific. |          |
| 48  | Execution queue indicator and queue browser                                                                                                                                                            | Missing                               | N/A                 | Browses agent queues; the room queue is already on screen.              |          |
| 49  | Agent status chrome around the composer: thinking pill with Stop, cross-agent responding pill, task list bar, Concerto pipeline, context warning sash, summarize / merge overlays, inline wizard panel | Missing                               | N/A                 | All bound to one agent tab's turn or context window.                    |          |
| 50  | Quit-when-idle pill (app-wide)                                                                                                                                                                         | Missing                               | Share               | App-wide state, not agent bound.                                        |          |
| 51  | Warning border (read-only or Auto Run queueing)                                                                                                                                                        | Reimpl, drifted                       | Share, GC behaviour | Same visual; inputs differ per surface.                                 |          |

### Layout, phone, web-desktop

| #   | Feature                                                                                         | Group Chat today          | Proposal | Reason                                                                          | Reviewer |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------- | -------- | ------------------------------------------------------------------------------- | -------- |
| 52  | Phone: composer folds behind a handle; toolbar keeps attach / mic / send / "..."; options sheet | Missing                   | Share    | Room is unusable at 390px for the same reasons; sheet rows follow capabilities. |          |
| 53  | Narrow viewport: toggles collapse behind "..."                                                  | Missing                   | Share    | Presentation only.                                                              |          |
| 54  | Toasts lift above the composer                                                                  | Shared (wired separately) | Share    | Move into the shared composer root.                                             |          |
| 55  | Cmd+. toggles composer / transcript focus                                                       | Shared                    | Share    | Already shared (see outside-composer note on the output target).                |          |

### Accessibility and hints

| #   | Feature                                         | Group Chat today | Proposal | Reason                                     | Reviewer |
| --- | ----------------------------------------------- | ---------------- | -------- | ------------------------------------------ | -------- |
| 56  | Accessible names on send, menu, mic, options    | Reimpl, drifted  | Share    | Comes free with the shared controls.       |          |
| 57  | Tooltips show the LIVE chord (`shortcutSuffix`) | Reimpl, drifted  | Share    | Same rule from CLAUDE.md (read live maps). |          |

## Shared component approach

**Shared core** (new `components/ChatComposer/`): the textarea with `MentionChipOverlay`, autosize, the `@` picker and its keys, paste trimming, the staged image strip, the toolbar, the send column (bell, send, Send menu), the phone fold, and toast avoidance. It knows nothing about sessions, tabs, or rooms.

**Surface adapter** (one object the surface builds and passes in):

- `value` / `setValue` and a draft key (AI: `composerInputStore` selectors so App still does not re-render per keystroke; room: local state over `draftMessage` via `useDraftPersistence`).
- `stagedImages` / `setStagedImages` (AI: tab; room: `groupChatStagedImagesById`).
- `mentionRoster` and `mentionCategory` (AI: all, excluding self; room: agents only).
- `onSubmit(intent)` where `intent` is `send | steer | hold | force`. The AI adapter calls `processInput` with the matching options. The room adapter only ever receives `send` (rows 40, 41, 43 are left out) and forwards it to `window.maestro.groupChat.submitMessage`, never deciding send vs queue (see `src/shared/groupChatQueueModel.ts`). Room steer stays on the queued card (row 44).
- `capabilities: ComposerCapabilities`, a flat object of booleans: `commandMode`, `slashCommands`, `shellTabCompletion`, `fileMentions`, `mentionRouting`, `saveToHistory`, `permission`, `thinking`, `modelEffort`, `sendMenu`, `imageAttach`, `voice`, `upload`. AI derives it from `useAgentCapabilities` and input mode. The room uses a constant `GROUP_CHAT_COMPOSER_CAPABILITIES` with every AI-only flag off, plus `imageAttach` derived from the moderator's provider (`supportsImageInput`): main saves room images to disk and tells the moderator to read them (`src/shared/maestro-lib/groupchat/router.ts:1302`). Toolbar, sheet, keys, and Send menu read only this object, so a feature is switched off in one place.
  - Changed by the review: `permission` was `'three-way' | 'read-only-toggle' | false` and is now a boolean for AI's pill, because the room keeps its own toggle (row 34); `sendMenuActions` (a set of intents) is now `sendMenu`, because the room offers no Send menu rows; `tabCompletion` is now `shellTabCompletion` (row 12b).
  - Agent tab completion (row 12a) needs no flag: both surfaces have it, and it reads `mentionRoster`.
- `toolbarExtras` slot: the room renders its existing Read-Only toggle there (row 34 left out, row 5 chord still targets it).
- `aboveComposer` slot: AI renders its status chrome (row 49) there; the room renders its paused banner (row 47).

**Stays surface specific**: AI's `InputContext` completion state, slash / shell tab completion / command ladder hooks (mounted only when the capability is on), `useInputSync` tab bindings, `processInput`, queued cards in the transcript. Room's main-owned queue mirror, steer service and queued-card Steer button, Read-Only toggle and its flag storage, queued list placement, external file drop.

## Step sequence (each lands on rc alone)

| Step | Change                                                                                                                                                                                                                                                                                      | Size   | Notes                                                                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Small bug fixes found here, no new surface: organizer chord reads the visible composer (row 22); Escape blur works in rooms (row 3); remove hard-coded Cmd+R / Cmd+Y from `GroupChatInput` in favour of the shortcut map (rows 5, 6); guard `runForcedParallelSend` in rooms (outside list) | S      | Merged into rc (#1877, `e1287cf11`), one commit per fix, plus the Cmd+. gap below.                                                                                                                                           |
| 2    | Extract leaf controls used by both: send column (bell + send), attach-image input with AI's error handling, paste-trim helper                                                                                                                                                               | S      | Merged into rc (#1890, `9d6f5b29f`). See [Progress](#progress).                                                                                                                                                              |
| 3    | Shared composer keyboard hook: `@` picker branch, Enter / Cmd+Enter, Escape, Cmd+F with a search-key resolver; `useInputKeyDown` and `GroupChatInput` both call it                                                                                                                          | M      | Done on `refactor/composer-keyboard-hook` (`d03e3a32e`, off rc), PR #1891, not merged. P1 and P2 fixed on it (`21ebee936`, `e30be29f9`).                                                                                     |
| 4    | Add `ComposerCapabilities`, AI derivation, room constant; `ToolbarControls` reads capabilities and callbacks instead of `session`                                                                                                                                                           | M      | Done on `refactor/composer-capabilities` (`8e625df6c`, on step 3), PR #1892, not merged. Seven flags, not thirteen (see [Progress](#progress)).                                                                              |
| 5    | Render `ToolbarControls` in Group Chat with the room capabilities: gains narrow overflow, voice, upload, live chord tooltips, phone toolbar and options sheet                                                                                                                               | M      | Done on `refactor/composer-room-toolbar` (`58c0df2df`, on step 4), PR #1945, not merged. Read-Only is in `toolbarExtras` on desktop and a new `sheetExtras` slot on a phone. Dictation fix on it (`e94289913`, `ab3ff624d`). |
| 6    | Session-free `ComposerTextarea` (from `InputTextarea`) with placeholder and roster props, used by both                                                                                                                                                                                      | S-M    | Done on `refactor/composer-textarea` (`69a0c1af0`, on step 5), no PR yet.                                                                                                                                                    |
| 7    | Phone fold handle in Group Chat (per-surface `usePersistedToggle` key) and quit-when-idle pill                                                                                                                                                                                              | S      | Not started.                                                                                                                                                                                                                 |
| 8    | `ChatComposer` shell composing steps 2-7 with the adapter; `GroupChatInput` becomes an adapter, `InputArea` keeps its overlays and chrome around it                                                                                                                                         | M-L    | Could split into "room first" and "AI second".                                                                                                                                                                               |
| 9    | Approved ports, one per change: `@agent` Tab completion for both surfaces, in the step 3 hook (row 12a); `Screenshot N` in rooms (rows 21, 28); room Attach gated on the moderator's provider (row 23)                                                                                      | S each | Rows 22 and 58 need no port beyond step 1. New UI actions need `maestro-cli` verbs.                                                                                                                                          |

**What I am unsure of in the plan**: whether the AI composer's per-keystroke store isolation (CLAUDE-PERFORMANCE) survives behind an adapter without an extra render layer; whether `WizardInputPanel` (`components/InlineWizard/`) and the Prompt Composer modal should join the shared core later (both are further composers, not audited here); and whether step 3 is cleaner after step 8 than before it.

## Progress

Steps 1 and 2 are merged into rc. Steps 3-6 are done on four stacked branches, the first off `origin/rc`, none merged; step 6 is not yet a PR. Step 7 is not started. Each step's commit message lists the room behaviour changes; the rows below are what those messages describe. Each branch also carries a CLAUDE.md index trim (2026-10-28) and the merges that carry it up the stack, which change no rows.

| Step | Branch, commit                                         | Rows completed    | Rows partly completed                                                            |
| ---- | ------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------- |
| 1    | rc, `e1287cf11` (#1877)                                | 3, 5, 6, 22       | None                                                                             |
| 2    | rc, `9d6f5b29f` (#1890)                                | 7, 37, 38         | 23: one picker with AI's error handling; the moderator's provider gate is step 9 |
| 3    | `refactor/composer-keyboard-hook`, `d03e3a32e` (#1891) | 4, 17             | 2: the send keys are shared; the room's Enter toggle moves in step 5             |
| 4    | `refactor/composer-capabilities`, `8e625df6c` (#1892)  | None (no room UI) | None                                                                             |
| 5    | `refactor/composer-room-toolbar`, `58c0df2df` (#1945)  | 2, 14, 29, 53, 57 | 52: phone toolbar row and options sheet; the fold handle is step 7               |
| 6    | `refactor/composer-textarea`, `69a0c1af0` (no PR)      | 9, 18             | None                                                                             |

Fixes made on 2026-10-29, which change no rows:

- Step 3: `e30be29f9` fixes P2 (IME Enter, also raised by CodeRabbit on #1891) and `21ebee936` fixes P1 (picker Escape). Both are merged up into steps 4 and 5. See [Findings fixed](#findings-fixed).
- Step 5: `e94289913` adds `cancelVoiceInput()` to `useVoiceInput`, and `ab3ff624d` calls it when the room changes or its draft is sent (Greptile P1 on #1945).

Row 34 stays left out: step 5 moves the room's Read-Only toggle into the shared toolbar unchanged, and the global flag is still item K2. Row 1 (autosize) is not part of step 6: each surface keeps its own sizing, so the row waits for step 8.

### Room behaviour changes in steps 2-6

- **Attach (step 2).** A picked image of the wrong type or over 10MB flashes the reason ("Unsupported image type (PNG, JPEG, GIF or WebP)" / "Image too large (max 10MB)") instead of being dropped with only a log line. A failed or aborted read flashes "Failed to attach image" / "Image attachment canceled" and is reported.
- **Send (step 2).** Unchanged: disabled without text, warning tint and "Queue message" while the room is busy.
- **Enter-to-send on (step 3).** Cmd/Ctrl+Enter now sends, as in AI chat (it was swallowed). Opt+Cmd+Enter and Ctrl+Opt+Enter also send, since the room has no steer chord. Cmd+Shift+Enter is still swallowed, and Cmd/Ctrl+Enter still never reaches the window handler.
- **`@` picker open (step 3).** Shift+Enter accepts the selected agent (it inserted a newline), and Cmd/Ctrl+Enter accepts it instead of sending the draft. Cmd/Ctrl with Up, Down, Tab or Escape acts on the picker instead of falling through to the window. Escape also returns the caret to the composer.
- **Kept on purpose (step 3).** Picker keys and Cmd/Ctrl+Enter stop propagating. Cmd+F opens the room's Find bar, refocuses it when open, and leaves Cmd+Shift+F to the window. Enter-to-send comes from the global setting only. Escape with the picker closed stays with `handleEscapeInMain`.
- **Desktop toolbar (step 5).** Laid out as in AI chat. The Read-Only and Prompt Composer tooltips show the live, rebindable chord.
- **Web-desktop (step 5).** Attach reads "Upload Image to Host", and an Upload button copies local files to the host and mentions them in the draft (the draft is flushed first, as a drop does).
- **Touch devices with speech recognition (step 5).** A mic button dictates into the draft, which persists like typing.
- **Narrow window (step 5).** Read-Only and the Enter toggle fold behind "...".
- **Phone (step 5).** The row holds attach, upload (web-desktop), mic, Send and "...". The bell column, the Prompt Composer button and the Enter toggle are not shown, as in AI chat. Send keeps the room's rules. "..." opens a sheet with a Read-Only switch.
- **Never shown in a room.** Save to History, the permission pill, Thinking, and the model and effort pills.
- **IME composition (step 3 fix).** Enter during a composition no longer sends, with or without Cmd/Ctrl, and in the `@` picker no longer accepts. Up, Down, Tab and Escape in the picker are left to the input method.
- **Dictation (step 5 fix).** Switching rooms or sending ends a dictation in progress: the mic returns to idle, and a result the browser still delivers is dropped instead of landing in the next room's draft or the cleared one.
- **Textarea (step 6).** Meant to be none visible, but see P4: the room's textarea no longer fills the composer's width. The caret color is now set explicitly to the text color it already had, and the CSS height cap is `176px` instead of `11rem`. At the default 16px font size these are the same; at a smaller font size setting the cap now matches the 176px autosize clamp the room already used.

### Step 4 deviation: capability list

`ComposerCapabilities` has seven flags: `imageAttach`, `upload`, `voice`, `saveToHistory`, `permission`, `thinking`, `modelEffort`. Only flags with a reader exist; each deferred flag is added by the change that first reads it:

- `commandMode`, `slashCommands`, `shellTabCompletion`: step 8, where the shared shell mounts the command ladder, slash and shell completion hooks per capability.
- `fileMentions`: step 8 (step 6 reads no picker categories), when the shared textarea's `@` picker needs to know whether it may offer file and folder categories.
- `mentionRouting`: step 8, if the shell mounts `MentionRoutingBar`.
- `sendMenu`: step 8 at the earliest. The send column already takes its menu as an optional prop, so the flag may never be needed.

There is no flag for the Prompt Composer button (it shows when its callback is passed) or for the phone options sheet (it mounts when a section flag is on or the surface passes rows). `GROUP_CHAT_COMPOSER_CAPABILITIES` keeps `imageAttach` on, as the room offers Attach today, until step 9 derives it from the moderator's provider.

### Findings from steps 2-6 (not fixed)

- **P3, AI terminal mode "..." on a phone opens nothing.** The phone branch of `ToolbarControls` keeps the "..." in terminal mode with no sheet behind it, pinned by a test. This predates the plan; step 5 left it as it was.
- **P4, step 6 narrows the room's textarea.** `GroupChatInput` keeps its own `relative flex items-start` wrapper around `ComposerTextarea`, which renders that wrapper itself. The inner one is a flex item without `flex-1`, so it shrinks to the textarea's intrinsic width. Measured with the built CSS: 203px of a 916px composer, against 914px on step 5. AI chat is not affected (its wrapper sits in a `flex-col` box). Found by the 2026-10-29 verification; the fix is to drop the room's outer wrapper.

### Findings fixed

Both on step 3 (`refactor/composer-keyboard-hook`), merged up into steps 4 and 5.

- **P1, AI chat `@` picker Escape blurred the composer.** The picker closed, then the key reached `handleEscapeInMain`, which blurs the composer. Fixed in `21ebee936`: `handleComposerPickerKey` stops propagation for the picker's Escape on every surface. Escape with the picker closed is unchanged.
- **P2, IME Enter could send half-composed text.** The Enter branch of `handleComposerSendKey` had no `isComposing` guard, in both composers. Fixed in `e30be29f9`: one check, `isImeComposing()` (`isComposing`, or keyCode 229 for Safari), keeps Enter from sending and the picker keys from acting while a composition is active. The AI composer's steer chord, Forced Parallel Send and category cycling use the same check.

## Kept Group Chat behaviour

Left-out rows where Group Chat already has its own version. The version stays; a bug it carries is a separate item, not part of this plan's steps.

| Row | Kept as is                                            | Separate item |
| --- | ----------------------------------------------------- | ------------- |
| 16  | Agents-only `@` picker (row 15)                       | None          |
| 26  | Shared drop handler appends `@path` to the room draft | K1            |
| 34  | Two-state Read-Only toggle, sent per message to main  | K2            |
| 39  | Send needs text; images ride along with it            | None          |
| 41  | Steer button on a queued card, main-owned             | None          |

- **K1, external drop path root.** The dropped path is made relative to the ACTIVE AGENT's project root (`hooks/input/useInputHandlers.ts:1210`), which has nothing to do with the room. Needs its own decision: absolute path, or the moderator's cwd.
- **K2, one Read-Only flag for every room.** `groupChatReadOnlyMode` (`stores/groupChatStore.ts:226`) is global, so toggling it in one room changes all of them.

Rows 11, 35, 36, 40, 43 and 45 have no Group Chat version, so nothing is kept.

## Parity gaps noticed outside the composer (not audited)

- Queued messages render in the transcript in AI chat but inside the composer in Group Chat (`TerminalOutput.tsx:771` vs `GroupChatInput.tsx:662`).
- `runForcedParallelSend` (`hooks/input/useInputKeyDown.ts:165`) has no room guard, and the window branch (`useMainKeyboardHandler.ts:1121`) dispatches it while a room is open, so the chord can act on the hidden agent. **Fixed on `fix/group-chat-composer-keys` (merged into rc, #1877):** the window branch skips rooms, as `steerSend` does (`useMainKeyboardHandler.ts:1127`). The composer path and the Send menu are under MainPanel, which is unmounted in a room.
- Cmd+. from the room composer focuses `terminalOutputRef` (`useMainKeyboardHandler.ts:925`), which belongs to the AI transcript. **Fixed on `fix/group-chat-composer-keys` (merged into rc, #1877):** in a room it toggles between the room composer and the room transcript, whatever the hidden agent's input mode (`useMainKeyboardHandler.ts:916`).
- Window shortcuts that still act on the hidden agent while a room is open. The agent selected under the room stays the active session, and these branches read it with no room guard. Locations are on `fix/group-chat-composer-keys`, all in `hooks/keyboard/useMainKeyboardHandler.ts`.
  - Cmd+J, new terminal tab (`:699`): creates a terminal tab in the hidden agent; the xterm focus that follows finds nothing mounted. Judgment call: block in a room, or leave the room for the new tab.
  - Ctrl+Shift+\`, new terminal tab (`:1243`): same as Cmd+J, without the focus. Judgment call, same choice as Cmd+J.
  - Tile-below chords (`:713`): tile a new tab into the hidden agent through `tileNewTabInSession`. Judgment call: block in a room, or leave the room.
  - Edit last queued message (`:1216`): `requestEditLastQueuedMessage` picks the hidden agent's newest queued message, while the room's own queue is drawn in its composer. Clearly wrong.
  - Toggle tab star (`:881`): `toggleTabStar` stars the hidden agent's active AI tab. Clearly wrong.
  - Clear terminal (`:738`): when the hidden agent is in terminal mode, a no-op (no xterm is mounted) that is still tracked as used. Clearly wrong, harmless.
  - Agent-level actions: open batch runner (`:1201`), move to group (`:674`), bookmark (`:849`), fuzzy file search (`:843`). Each acts on the hidden agent. Judgment call: may be intended, as agent-level actions rather than chat ones.
  - Jump to bottom (`:1157`) is harmless: `logsEndRef` is not mounted in a room, so nothing scrolls.
- In a room shown in another window, the organizer chord with 2+ room images is tracked as used though no strip is mounted here to open (`useMainKeyboardHandler.ts:863`).
- Transcript rendering differs (`GroupChatMessages.tsx` vs `TerminalOutput` / `LogItem`), including message actions; not compared here.

## Group Chat only features (outside the composer)

Chat features a room has and AI chat does not. Not composer rows, so they are not in the feature tables or the Summary counts. Verified against `origin/rc` at `1109c8197` (2026-10-21). File locations are in the [appendix](#group-chat-only-features).

- **G1, "Only work with agents that are free"** (`requireIdleParticipants`, on by default; a chat saved without the field counts as on). A toggle under "Agent Availability" in the New and Edit Group Chat modal, stored per chat. When it is on and the moderator delegates to a participant whose agent is busy with its own conversation, an Auto Run or a CLI run, the router posts a "Waiting for @agent" line, holds the delegation, and sends it once the agent is free. The wait polls every 5 seconds and re-reads the setting on each poll, so turning it off mid-wait releases the held request within about 5 seconds; it gives up after 15 minutes. Introduced in `d0cdaba91`, on rc and main.
  - **AI chat today.** The nearest case is an `@mention` consult to a busy agent. The consult service never checks whether the target is busy: it spawns an ephemeral `cross-agent-<requestId>` process in the target's working directory straight away, beside whatever that agent is already running. A consult is read-only unless `crossAgentMentionsWritable` is on (default off), but a hand-off gets write access by default (`crossAgentHandoffsWritable`, default on).
  - **Open question for the maintainer:** should a consult or hand-off to a busy agent wait the same way? Not proposed here.
  - **CLI gap.** No `maestro-cli` path: `group-chat start` takes `--participant`, `--moderator`, `--message` and `--message-file`, with no availability option, so a CLI-started chat always gets the default (on), and no `group-chat` verb edits an existing chat's settings. Recorded here only; the row in `docs/agent-guides/CLI-UI-PARITY.md` is left for a separate change.

## Summary

59 rows: the 57 audited features, row 12 split into 12a and 12b, and new row 58 (image viewer). 15 already shared. 38 proposed for sharing (26 as is, 12 with Group Chat behaviour). 11 left out. 10 not applicable. No open proposals. The Group Chat only setting G1 is listed separately and not counted.

## Appendix: file locations

Keyed by row number in the feature tables. Paths are relative to `src/renderer/` unless they start with `src/`.

| #   | AI chat                                                                                                                                         | Group Chat                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | `components/InputArea/hooks/useInputAreaAutosize.ts`, rAF keystroke path in `hooks/useInputAreaTextChange.ts:134`                               | `useAutosizeTextarea` at `GroupChatInput.tsx:568`                                                                         |
| 2   | `hooks/input/useInputKeyDown.ts:525-568` (per-tab override `activeTab.enterToSend` over `enterToSendAI`), chip `ToolbarControls.tsx:572`        | `GroupChatInput.tsx:359-369, 427-433`, chip `:805`; global setting only                                                   |
| 3   | `useInputKeyDown.ts:569-572`, `hooks/keyboard/useKeyboardNavigation.ts:659`                                                                     | Missing: `handleEscapeInMain` compares against the AI `inputRef`, so nothing happens                                      |
| 4   | `useInputKeyDown.ts:249`                                                                                                                        | `GroupChatInput.tsx:333` (also refocuses an open bar)                                                                     |
| 5   | Tab shortcut `toggleReadOnlyMode` (rebindable, `constants/shortcuts.ts:563`) via `hooks/keyboard/useMainKeyboardHandler.ts`, gated off in rooms | Hard-coded `e.key === 'r'` at `GroupChatInput.tsx:346`, ignores rebinding                                                 |
| 6   | `useMainKeyboardHandler.ts:856` (already picks room images when a room is active)                                                               | Redundant local copy hard-coding `'y'` at `GroupChatInput.tsx:353`                                                        |
| 7   | `hooks/input/useInputHandlers.ts:839-858` (skipped when a room is active)                                                                       | Copy at `GroupChatInput.tsx:471-504`                                                                                      |
| 8   | `InputArea.tsx:163`                                                                                                                             | `GroupChatInput.tsx:153`                                                                                                  |
| 9   | `components/InputArea/components/InputTextarea.tsx:159` ("Talking to X powered by Y", mode aware)                                               | `GroupChatInput.tsx:735` ("Type to queue message..." while busy)                                                          |
| 10  | `useInputAreaTextChange.ts:75`, `components/CommandModeBar.tsx`, `components/AiCommandProposal.tsx`, `InputTextarea.tsx:110`                    | Missing                                                                                                                   |
| 11  | `overlays/SlashCommandPopover.tsx`, opened in `useInputAreaTextChange.ts:94`, keys `useInputKeyDown.ts:497`                                     | Missing (comment at `GroupChatInput.tsx:156`)                                                                             |
| 12a | None: outside shell input, Tab with the picker closed does nothing (`useInputKeyDown.ts:580`)                                                   | Tab only accepts an open picker (`GroupChatInput.tsx:396`)                                                                |
| 12b | `overlays/TabCompletionPopover.tsx`, `hooks/input/useTabCompletion.ts`, `useInputKeyDown.ts:580` (shell input only)                             | Missing                                                                                                                   |
| 13  | `overlays/CommandHistoryPopover.tsx`; `useInputKeyDown.ts:573-579` checks `inputMode === 'terminal'`                                            | Missing                                                                                                                   |
| 14  | `hooks/utils/useVoiceInput.ts`, `InputArea.tsx:395`, button `ToolbarControls.tsx:159, 412`                                                      | Missing                                                                                                                   |
| 15  | `overlays/AtMentionPopover.tsx`, `hooks/input/useMentionPicker.ts`                                                                              | Same components, locked to `category: 'agents'`, no file suggestions, `GroupChatInput.tsx:227, 673`                       |
| 16  | `useInputKeyDown.ts:434-480`                                                                                                                    | Missing (category bar hidden)                                                                                             |
| 17  | `useInputKeyDown.ts:432-494`                                                                                                                    | Copy at `GroupChatInput.tsx:379-425` (adds stopPropagation, Escape does not refocus)                                      |
| 18  | `MentionChipOverlay.tsx` via `InputTextarea.tsx:131` (roster excludes self)                                                                     | Same via `GroupChatInput.tsx:243, 717` (roster through `filterLiveAgents`)                                                |
| 19  | `components/MentionRoutingBar.tsx`, `hooks/useMentionRouting.ts` (runs `planCrossAgentMentions`)                                                | Missing                                                                                                                   |
| 20  | `components/StagedImagesStrip.tsx` at `InputArea.tsx:574`                                                                                       | Same at `GroupChatInput.tsx:693`                                                                                          |
| 21  | `InputArea.tsx:279` (`renumberScreenshotReferences`)                                                                                            | Plain reorder at `GroupChatInput.tsx:561`                                                                                 |
| 22  | Button in `StagedImagesStrip.tsx:61`; chord `useMainKeyboardHandler.ts:865` gated on AI `ctx.stagedImages`                                      | Button shared; chord reads the hidden AI tab's count                                                                      |
| 23  | `ToolbarControls.tsx:193` (`addStagedImageIfUnique`, read error and abort reporting, `canAttachImages` capability gate `InputArea.tsx:189`)     | `GroupChatInput.tsx:520, 766` (type and 10MB checks, no error reporting, no gate)                                         |
| 24  | `useInputHandlers.ts:825`                                                                                                                       | Same handler, room branch at `:886`                                                                                       |
| 25  | `useInputHandlers.ts:1089`                                                                                                                      | Same handler, room branch at `:1219`                                                                                      |
| 26  | `useInputHandlers.ts:1241-1287`                                                                                                                 | Same handler, appends to `draftMessage` (`:987`), path relative to the active agent's root (`:1210`)                      |
| 27  | `useInputHandlers.ts:1142-1202`                                                                                                                 | Refused for rooms (`:1145`)                                                                                               |
| 28  | `useInputHandlers.ts:1123-1131`                                                                                                                 | Refused for rooms (`:1125`)                                                                                               |
| 29  | Button `ToolbarControls.tsx:131`; `handleUploadFiles` `useInputHandlers.ts:1056` already accepts a room                                         | No button                                                                                                                 |
| 30  | `hooks/input/useDraftPersistence.ts` via `useInputSync.ts`; `stores/composerInputStore.ts`                                                      | Same hook at `GroupChatInput.tsx:190`, flushes `:259, 509, 516, 729`; stored in `groupChat.draftMessage`                  |
| 31  | `tab.stagedImages`                                                                                                                              | `groupChatStagedImagesById` in `stores/groupChatStore.ts:233`                                                             |
| 32  | `PromptComposerModal.tsx` mounted `components/AppModals/AppUtilityModals.tsx:847`; button `ToolbarControls.tsx:393`                             | Same modal (sessions and groups passed for rooms), button `GroupChatInput.tsx:757`, chord `useMainKeyboardHandler.ts:890` |
| 33  | `ToolbarControls.tsx:475`                                                                                                                       | Missing                                                                                                                   |
| 34  | Three-way per tab, capability gated, `ToolbarControls.tsx:494`                                                                                  | Two-state Read-Only at `GroupChatInput.tsx:786`, one global `groupChatReadOnlyMode` (`groupChatStore.ts:226`)             |
| 35  | `ToolbarControls.tsx:533`                                                                                                                       | Missing                                                                                                                   |
| 36  | `components/ModelEffortPills.tsx`; console refused in rooms by `resolveModelEffortTabId` (`useMainKeyboardHandler.ts:903`)                      | Missing                                                                                                                   |
| 37  | `components/NotificationSendControls.tsx:55`                                                                                                    | Copy at `GroupChatInput.tsx:819`                                                                                          |
| 38  | `NotificationSendControls.tsx:76` (always enabled)                                                                                              | `GroupChatInput.tsx:840` (disabled with no text, warning tint and "Queue message" title while busy)                       |
| 39  | `hooks/input/useInputProcessing.ts:375, 1607-1610` (default image-only prompt)                                                                  | Blocked: `handleSend` needs text (`GroupChatInput.tsx:279`)                                                               |
| 40  | `components/SendMenuPopover.tsx`, opened by `NotificationSendControls.tsx:29`                                                                   | Missing                                                                                                                   |
| 41  | `useInputKeyDown.ts:200-218, 535`; explicitly returns in rooms (`:203`, `useMainKeyboardHandler.ts:1131`)                                       | Steer only as a button on a queued card (`GroupChatInput.tsx:602`, `services/groupChatSteering.ts`)                       |
| 42  | `useInputKeyDown.ts:165-183, 553`                                                                                                               | Missing                                                                                                                   |
| 43  | `HOLD_SEND_EVENT`, `useInputKeyDown.ts:224`                                                                                                     | Missing (main pauses the whole queue, not an item)                                                                        |
| 44  | `QueuedItemsList` in the transcript, `components/TerminalOutput/TerminalOutput.tsx:771`                                                         | Same component inside the composer, `GroupChatInput.tsx:662`, adapted from main's queue (`:579`)                          |
| 45  | `onEditQueuedItem` (`TerminalOutput.tsx:777`), `services/editQueuedMessage.ts`                                                                  | Missing                                                                                                                   |
| 46  | `TerminalOutput.tsx:775-783`                                                                                                                    | Missing                                                                                                                   |
| 47  | Missing                                                                                                                                         | `GroupChatInput.tsx:626-658`                                                                                              |
| 48  | `InputArea.tsx:561` (`ExecutionQueueIndicator`)                                                                                                 | Missing                                                                                                                   |
| 49  | `InputArea.tsx:419-480, 513-572, 756`                                                                                                           | Missing (room Stop All is in `GroupChatHeader.tsx:151`)                                                                   |
| 50  | `QuitWhenIdleIndicator.tsx` at `InputArea.tsx:511`                                                                                              | Missing, so an armed quit is invisible in a room                                                                          |
| 51  | `InputArea.tsx:206, 653`                                                                                                                        | Read-only only, `GroupChatInput.tsx:712`                                                                                  |
| 52  | `InputArea.tsx:414-508`, `components/PhoneComposerHandle.tsx`, `ToolbarControls.tsx:281`, `components/ComposerOptionsSheet.tsx`                 | Missing (no `usePhoneLayout` in the file)                                                                                 |
| 53  | `ToolbarControls.tsx:451`                                                                                                                       | Missing                                                                                                                   |
| 54  | `useToastAvoidZone` in `components/MainPanel/MainPanelContent.tsx`                                                                              | Same hook at `GroupChatInput.tsx:200`                                                                                     |
| 55  | `useMainKeyboardHandler.ts:914-930`                                                                                                             | Same branch with `groupChatInputRef` (`:921`)                                                                             |
| 56  | `NotificationSendControls.tsx:86`, `ToolbarControls.tsx:317, 347`                                                                               | `title` only on send and toolbar buttons (`GroupChatInput.tsx:852`)                                                       |
| 57  | `ToolbarControls.tsx:397, 488, 527`                                                                                                             | Prompt Composer only (`GroupChatInput.tsx:761`); Read-Only tooltip has no chord                                           |
| 58  | `LightboxModal.tsx` at `AppModals/AppUtilityModals.tsx:704`, opened via `useModalHandlers.ts:592`                                               | Same modal; room delete and annotate at `useModalHandlers.ts:625`                                                         |

### Group Chat only features

Paths are relative to the repo root. Lines are on `origin/rc` at `1109c8197`.

| Item | Where                                                                                                                                                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1   | Default `requiresIdleParticipants` in `src/shared/group-chat-types.ts:349`                                                                                                                                                                                                                                                                                |
| G1   | Router `src/shared/maestro-lib/groupchat/router.ts`: `isDelegationBlockedByBusyAgent` `:295`, poll `:304` (5s), give-up `:312` (15 min), `waitForAgentToFree` `:1518`, `queueDelegationUntilAgentIsFree` `:1639` (calls the wait at `:1657`), delegation checks `:2059, 2306`                                                                             |
| G1   | Busy probe `isAgentBusy` via `src/main/ipc/bootstrap/session-mention-mapper.ts:26`                                                                                                                                                                                                                                                                        |
| G1   | IPC `src/main/ipc/handlers/groupChat.ts`: create `:287-298` (`requireIdleParticipants !== false`), update `:413, 441`; preload `src/main/preload/groupChat.ts:82, 106`; type `src/renderer/global.d.ts:181`                                                                                                                                               |
| G1   | UI `src/renderer/components/GroupChatModal.tsx` (state `:67`, section `:297`, placed at `:614` edit and `:647` create), wired through `src/renderer/components/AppModals/AppModals.tsx:406, 421`, `src/renderer/components/AppModals/AppGroupChatModals.tsx:24, 45`, `src/renderer/hooks/groupChat/useGroupChatHandlers.ts:578` (create), `:668` (update) |
| G1   | CLI `src/cli/index.ts:863` (`group-chat` verbs; none takes the setting)                                                                                                                                                                                                                                                                                   |
| G1   | AI chat comparison: consult spawn `src/shared/maestro-lib/agents/consult.ts:309-321` (no busy check), write access `src/main/ipc/handlers/cross-agent.ts:72`                                                                                                                                                                                              |
