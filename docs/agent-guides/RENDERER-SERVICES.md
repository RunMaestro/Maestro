<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Renderer Services and Constants Guide

Covers `src/renderer/services/` (13 files, ~4,470 lines) and `src/renderer/constants/` (10 files, ~1,676 lines).

Not documented in detail below but present in `services/`: `bmad.ts` (BMAD slash command service, mirrors `speckit.ts`/`openspec.ts`) and `feedbackConversation.ts` (feedback/wizard conversation flow).

Not documented in detail below but present in `constants/`: `cueYamlDefaults.ts` (default Cue YAML templates).

---

## Services Overview

The services directory provides a clean API layer between React components and the Electron main process via IPC. Services wrap `window.maestro.*` calls exposed by the preload bridge.

### Architecture

```text
React Components
      |
      v
 renderer/services/  <--- createIpcMethod() pattern
      |
      v
 window.maestro.*   (preload bridge)
      |
      v
 main process IPC handlers
```

---

## Service Files

### ipcWrapper.ts (~180 lines)

Central utility for wrapping IPC calls with standardized error handling.

**`createIpcMethod<T>(options)`** - The core pattern used by `git.ts` and `process.ts`:

- **Swallow mode**: Provide `defaultValue` - errors are logged and the default is returned. Used for read operations.
- **Rethrow mode**: Set `rethrow: true` - errors are logged and rethrown. Used for write/mutation operations.
- **Transform**: Optional `transform` function post-processes the result before returning.

Two overloaded option interfaces enforce mutual exclusivity:

- `IpcMethodOptionsWithDefault<T>` - requires `defaultValue`, optional `rethrow: false`
- `IpcMethodOptionsRethrow<T>` - requires `rethrow: true`, no `defaultValue`

**`IpcCache` class** - Simple in-memory cache for IPC results with TTL (default 30s):

- `getOrFetch(key, fetcher, ttl)` - Cache-or-fetch pattern
- `invalidate(key)` / `invalidatePrefix(prefix)` / `clear()` - Cache invalidation
- Exported as singleton `ipcCache`

**Adoption**: Only `git.ts` and `process.ts` use `createIpcMethod`. The wizard services, contextGroomer, contextSummarizer, speckit, and openspec all make direct `window.maestro.*` calls with their own try/catch patterns.

---

### git.ts (~165 lines)

Git operations service. Every method takes an optional `sshRemoteId` parameter for remote execution.

All methods use `createIpcMethod` with `defaultValue` (swallow mode):

- `isRepo(cwd, sshRemoteId?)` - Returns `false` on error
- `getStatus(cwd, sshRemoteId?)` - Parallel fetches status + branch, parses porcelain format via `parseGitStatusPorcelain` from shared utils
- `getDiff(cwd, files?, sshRemoteId?)` - Full diff or per-file diffs
- `getNumstat(cwd, sshRemoteId?)` - Line-level statistics via `parseGitNumstat`
- `getRemoteBrowserUrl(cwd, sshRemoteId?)` - Converts remote URL to browser-friendly URL
- `getBranches(cwd, sshRemoteId?)` - Deduplicated local + remote branches
- `getTags(cwd, sshRemoteId?)` - All tags

Exported as `gitService` object (not a class).

---

### process.ts (~120 lines)

Process management service. Wraps `window.maestro.process.*` calls.

Methods using `createIpcMethod` with `rethrow: true`:

- `spawn(config)` - Returns `ProcessSpawnResult` (pid, success, optional sshRemote info)
- `write(sessionId, data)` - Write to process stdin
- `interrupt(sessionId)` - Send SIGINT/Ctrl+C
- `kill(sessionId)` - Kill process
- `resize(sessionId, cols, rows)` - Resize PTY terminal

Event listener methods (direct passthrough, no createIpcMethod):

- `onData(handler)` - Process stdout data
- `onExit(handler)` - Process exit with code
- `onSessionId(handler)` - Batch mode session ID assignment
- `onToolExecution(handler)` - Tool execution events (OpenCode, Codex)

Exported as `processService` object.

---

### shellCommand.ts (~200 lines)

Command mode ("bang commands"): running a `!command` typed in the AI composer and streaming its output into the transcript. The agent is bypassed entirely - never spawned, never written to, never shown the command or its output.

**Key exports:**

- `dispatchShellCommand({ session, tabId, command, request? })` - record the command in `aiCommandHistory` (bang-prefixed) and run it. **This is the entry point every command surface uses**: a typed `!` command and an accepted AI command mode suggestion both go through it, so both run, record, and recall identically. It forwards its whole options object to `runShellCommand` rather than destructuring the fields it happens to name, so a field added later cannot be silently dropped here. The optional `request` is the only thing separating the two: present, it marks the command as generated rather than typed
- `runShellCommand({ session, tabId, command })` - append a live output card to the tab and run the command; resolves on exit. Use `dispatchShellCommand` unless you deliberately want the run WITHOUT the history entry
- `cancelShellCommand(logId)` - stop a running command by its card's log id (the card's Stop button)
- `resolveCommandCwd(session)` - where a bang command runs (agent `cwd`, or the SSH remote's working dir). Deliberately NOT `shellCwd`, which only terminal mode's `cd` moves. The composer's `CommandModeBar` and Tab completion both call this so the advertised directory, the completion source, and the actual run directory can never disagree
- `isShellCommandRunning(logId)`, `buildShellRunSessionId(sessionId, runId)`, `SHELL_COMMAND_OUTPUT_LIMIT`

**Why a synthetic session id.** `process.runCommand` keys its `data` / `stderr` / `command-exit` events by sessionId. Reusing the agent's real id would route shell output straight into `useAgentDataListener` / `useAgentStderrListener` / `useAgentCommandExitListener`, appending it to the tab as agent output and flipping session state. Each run instead gets `{sessionId}-shell-{runId}`, which matches none of those listeners' patterns (no `-ai-` segment, no `-terminal` suffix, no `-batch-` segment) and no session in the store, so they all no-op and this module owns the stream. Do NOT "simplify" this to the plain session id.

Output is buffered and flushed on an animation frame (one store write per frame, not per chunk) and capped at `SHELL_COMMAND_OUTPUT_LIMIT` characters, because transcript logs are persisted to the sessions file.

The output box caps at 480px and follows its own tail via `useStickToBottom`, so a chatty command cannot push the conversation off the screen AND the newest lines stay visible. That pairing is the whole reason the hook exists: the cap is what stops the outer transcript auto-scroll from being able to follow the output, because the card stops growing once it is reached.

Rendered by `components/ShellCommandCard.tsx`, anchored by `LogEntry.shellCommand`. Routing happens at the top of `useInputProcessing.processInput`.

**The card has TWO copy buttons, and they copy different things.** The one in the header copies the OUTPUT (ANSI-stripped - the stored text keeps its escape codes so the card can render colour, but pasting `\x1b[36m` anywhere is never wanted). The one beside the command copies the COMMAND, and appears only while the command is expanded, so it cannot be mistaken for the output copy a few pixels to its right. Both are `<CopyIconButton>`; the hand-rolled copy-then-swap-to-a-checkmark this file used to carry is gone.

**The command line is a disclosure.** It is truncated to one line by default and expands to a wrapped, selectable block when the header is clicked - a `find` with a dozen predicates otherwise buries the exit code and the controls on every card. The toggle is a real `<button>` with `aria-expanded`, not a `div` with `role="button"`: this is a keyboard-first app, and `role` grants the semantics without the tab stop or Enter/Space handling. The copy button inside that clickable header relies on `CopyIconButton`'s `stopPropagation`, or copying would also collapse the command out from under the click.

**Deleting a card.** The card carries its own trash icon (with the same inline "Delete? Yes/No" confirm the transcript's user messages use) because it takes an early return in `TerminalOutput` and never renders the shared hover toolbar. It routes to the SAME `handleDeleteLog` in `hooks/tabs/internal/useScrollLogHandlers.ts`, which now branches on `log.shellCommand` before its `source === 'user'` guard, since a card is neither a user message nor part of one:

- It deletes as a **single entry**, not the span-to-the-next-user-message a chat message deletes as. The card owns both its command and its output.
- It must **never** call `claude.deleteMessagePair` - the agent was bypassed entirely, so there is no pair in its session to delete.
- Delete is hidden while the command is still **running**. Removing a live card would orphan the process: output keeps streaming into an entry that no longer exists, with no Stop button left to reach it. Stop first, then delete.

Because that gate reads `shellCommand.status`, `LogItem`'s memo comparator in `TerminalOutput.tsx` must compare the `shellCommand` fields (`status`, `exitCode`, `durationMs`, `truncated`) and not just `log.text`. A command that prints NOTHING (`!true`, `!mkdir foo`) changes only those fields when it exits, so comparing text alone froze the card mid-run: spinner up, Stop still offered, delete still hidden.

The recall-history rule lives in the pure reducer `hooks/tabs/internal/deleteShellCommandLog.ts`: the bang-prefixed `aiCommandHistory` entry is pruned **only when no card anywhere in the agent still shows that command**. The two lists have different scopes - cards are per tab, `aiCommandHistory` is per agent and deduplicated - so pruning unconditionally would strip `!ls` from up-arrow recall while two other `ls` cards sit on screen.

### Command mode is STATE, not a text prefix

The `!` is a _gesture_ that enters the mode and is consumed on entry - it never lands in the draft. Once in command mode the composer holds the bare command line. **Never infer the mode by testing the text for a leading `!`**: a real command can contain bangs (`find . -name '*!*'`), and the draft doesn't start with one anyway.

`!` is a **rung, not a toggle**. Each press on an EMPTY composer climbs one rung, and Escape on an empty composer climbs back down. Focus never leaves the textarea at any point:

```
agent chat  --!->  'shell'  --!->  'ai'
agent chat  <-Esc-  'shell'  <-Esc-  'ai'
```

| Rung      | The draft is...                 | Enter does                                               |
| --------- | ------------------------------- | -------------------------------------------------------- |
| `'off'`   | a message for the agent         | sends it                                                 |
| `'shell'` | a literal shell command line    | runs it (`dispatchShellCommand`)                         |
| `'ai'`    | plain English describing a want | asks the tab's model for one command line, then confirms |

There is no rung above `'ai'`, so a `!` typed there is ordinary text - the request is prose, and prose contains bangs. A `!` typed into a NON-empty composer is ordinary text on every rung (`echo !` never climbs).

The mode lives in two places, and they must move together:

| Where                              | Scope              | Set by                                                     |
| ---------------------------------- | ------------------ | ---------------------------------------------------------- |
| `composerInputStore.aiCommandMode` | live, active tab   | the `!` gesture; Escape/Backspace on an empty command line |
| `AITab.commandMode`                | persisted, per tab | flushed with `inputValue` (see draft write-back below)     |

`AITab.commandMode` is typed `ComposerCommandMode | boolean` because builds before AI command mode wrote `true` for what is now `'shell'`, and those values are still on disk. **Always read it through `normalizeComposerCommandMode()`**, which maps `true` -> `'shell'` and anything unrecognised -> `'off'` (a corrupt value must land the user in chat, never in a shell).

**The invariant:** the same string is a shell command, a request for one, or a message to the agent depending only on this value. Any path that persists or restores `inputValue` MUST carry `commandMode` with it, or a restored draft routes the wrong way. `syncAiInputToSession` reads the mode from the store itself rather than taking it as an argument, precisely so a caller cannot forget it; the queued write-back carries it too.

Because the value is a union now, **never test it for truthiness** - `'off'` is a truthy string. Compare against `'off'` / `'shell'` / `'ai'`, or use `isShellCommandMode()` / `isAiCommandMode()`.

### Drafts are written back on a typing timer, and always to the tab they were typed in

`useInputSync` owns both halves of draft persistence:

| Function                                       | When                                                     |
| ---------------------------------------------- | -------------------------------------------------------- |
| `queueAiDraftFlush(tabId, value, commandMode)` | every keystroke, coalesced over ~300ms of idle           |
| `syncAiInputToSession(value, tabId?)`          | blur / submit / tab switch - supersedes any queued write |

Two rules keep drafts from being lost, and both exist because they were broken before:

1. **No flush point is load bearing.** The live text lives in `composerInputStore` (one global slot, deliberately outside session state so a keystroke doesn't re-render the app). Anything that skipped blur/submit/tab-switch - a quit while typing, an unmount, focus that never left the textarea - used to throw the text away. The keystroke-driven write-back means session state is never more than a typing pause behind, and window blur / visibility hide flush it immediately. A write whose text and mode already match the tab returns the same session reference, so the timer costs nothing when nothing changed.
2. **Every write is attributed to a tab id, never to "the active tab".** A flush that lands after the active tab moved (blur arriving late, an async continuation) would otherwise stamp its text onto the newly active tab - erasing that tab's draft with text from another one. Pass the tab id whenever the write can land later than the moment it was scheduled.

`utils/shellCommandInput.ts` is down to two helpers:

| Function                                 | Job                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `detectCommandModeEntry(prev, next)`     | Should this edit climb a rung? Returns the text to keep, bang eaten  |
| `nextComposerCommandMode(mode)`          | The rung a `!` climbs to, or null when there is none above           |
| `previousComposerCommandMode(mode)`      | The rung Escape climbs down to; `'off'` is the floor                 |
| `normalizeComposerCommandMode(raw)`      | Persisted value (including the legacy boolean) -> a mode             |
| `isShellCommandMode` / `isAiCommandMode` | Rung predicates, so call sites don't compare strings inline          |
| `stripShellCommandEscape(v)`             | Unwraps `\!foo` -> `!foo` for messages that really start with a bang |

Entry requires the composer to have been **empty** before the edit, so retrofitting a `!` onto an in-progress message doesn't silently turn a sentence into a shell command - and so `echo !` stays shell text rather than climbing.

Surfaces that consume the mode: `InputArea` (reads the store once, derives `isShellCommandDraft` / `isAiCommandDraft` / `isShellInput`, passes them down), `useInputKeyDown` (Tab trigger, dropdown navigation, the Escape/Backspace ladder, and the proposal card's answer keys), `useInputHandlers` (which composer slice completion reads, the attachment guards, plus the `getCommandMode` dep threaded into `useInputProcessing`), and `useInputAreaTextChange` (the `!` gesture, and suppressing `@` mentions and slash commands - in a shell line `@` is an scp target and `/` starts an absolute path, and in a prose request neither belongs).

### aiCommand.ts - AI command mode

Turns a plain-English request into one shell command line, shows it, and runs it only after a yes/no. The composer's second bang rung.

**Key exports:**

- `requestAiCommand({ session, tabId, request })` - ask the tab's OWN provider, at its current model and effort (resolved with `codifyTurnSettings`, the same helper a chat turn uses), for one command line. Fire and forget: everything visible is driven off `aiCommandStore`
- `acceptAiCommand(session, entry)` - run the proposal through `dispatchShellCommand`
- `dismissAiCommand(entry)` - clear the card and RETURN the original request text, so declining hands it back to the composer for editing

**State** lives in `stores/aiCommandStore.ts`, keyed per AI tab (`${sessionId}:${tabId}`), never on the session model: nothing here survives a restart, and a proposal the user never answered must not come back days later attached to a stale working directory. Each attempt carries a `requestId`, because the model round trip cannot be cancelled once dispatched - a reply that lands after a dismissal (or after a second request replaced the first) is dropped rather than resurrecting a card the user closed.

**The model call** is `aiCommand:suggest` in the main process (`ipc/handlers/aiCommand.ts`), which builds the prompt with `shared/aiCommand.ts` and runs it through `groomContext` with `readOnlyMode` AND `disableTools`. Both flags matter: with tools available, a task-shaped request ("clean up the build output") makes the model try to DO the work instead of naming the command. The prompt itself is `src/prompts/ai-command.md`, editable in Settings -> Maestro Prompts like any other core prompt.

**The handler never executes anything.** The accepted command goes back through the ordinary command-mode path, so a suggested command and a typed one run in the same directory, on the same SSH remote, through the same code.

**Follow-ups carry history.** `requestAiCommand` mines the target tab's transcript with `collectRecentCommands()` and sends the last `AI_COMMAND_HISTORY_LIMIT` (8) command lines, oldest first, so "actually just give me a count" can refine the `find` command above it instead of composing a new one. Three things about that:

- It reads the **transcript**, not `aiCommandHistory`. That list is per agent, deduplicated, and order-normalized (a repeat moves to the end), so it cannot answer "what did I just run in THIS tab" - which is the only question a follow-up is asking.
- It reads the **target tab** (`tabId`), not the active one. A tab switch while a suggestion is in flight must not hand one tab's commands to another tab's request.
- Failures are **labeled, not filtered**. "That didn't work, try something else" is a common follow-up, and a model that cannot see the failure proposes the same broken command again.

Each entry carries the **request as well as the command**, rendered as an `Asked:` / `Ran:` pair. `LogEntry.shellCommand.request` is stamped by `runShellCommand` only when the caller supplies one, so the field's presence means exactly "this command was generated, not typed" - and `ShellCommandCard` shows it above the command as provenance. This matters because a follow-up refines the ASK at least as much as the command line: `find . -newermt '2 days ago' -type f` does not say it was requested as "files edited in the past two days", so without the request the model has to reverse-engineer intent from flags.

`formatRecentCommands` collapses whitespace in both fields before emitting them. That is not cosmetic: the block is a list where one entry is one or two labeled lines, and a request is typed into a MULTILINE composer, so a newline in a request would inject what looks like another entry into the block above it.

Commands and exit statuses are sent; output is not. The refinement cases are about the command's shape, and a `find` over a large tree would swamp the prompt with its own results.

`shared/aiCommand.ts` holds the two pure pieces, unit-testable without either process: `buildAiCommandPrompt()` (substitution runs in ONE pass, so no substituted value is rescanned for further tokens - chained `.replace()` calls let a previously-run command like `echo {{USER_REQUEST}}` sitting in the history get filled in by the next replace in the chain) and `extractCommandLine()` (strips fences, `$`/`%` prompts, wrapping backticks, and lead-in lines; returns null rather than proposing an empty run).

---

### `probeSessionAiProcesses()` (in process.ts)

`probeSessionAiProcesses(sessionId, targetTabId)` asks the MAIN process what is actually running for one agent's AI tabs, returning `{anyActive, targetTabActive, earliestStartTime, probeFailed}`.

Reach for it anywhere the question is "is this agent mid-turn right now". The renderer store is NOT a safe answer: it can still read `idle` for a moment after a turn starts or before an exit reconciles, and both the queue decision and the cross-agent mention-only branch have been bitten by that window. Terminal tabs and Cue runs are filtered out (neither holds the agent's sequential AI turn), and a forced-parallel run (`-fp-<n>` suffix) counts as busy on its own tab.

**It fails SAFE.** An IPC failure returns every flag `true` plus `probeFailed`, because unknown ownership must read as busy - treating it as idle re-spawns a live process id and loses its response. Do not "simplify" that to a `false` default.

---

### crossAgentMentions.ts (~115 lines)

Resolve and dispatch `@agent` mentions. Deliberately two steps, because WHEN a consult fires is part of the contract:

- `planCrossAgentMentions(message, sourceSessionId)` - resolve the mentioned agents. Sends nothing. Returns `null` when the message mentions no other agent, and `suppressLocal: true` when it LEADS with an `@agent` mention (the source agent must not answer).
- `dispatchCrossAgentMentions(plan, message, sourceSession, sourceTabId)` - fire the consults for an already-resolved plan.
- `dispatchCrossAgentMentionsForMessage(message, sourceSession, sourceTabId)` - plan + dispatch, for callers holding only the raw text.

**A queued message must not consult at submit time - including one addressed only at the other agent.** A message sent while the agent is busy goes to the execution queue; dispatching its mention immediately pulls the other agent into a question that is still several messages deep in the queue. So `useInputProcessing` PLANS at submit (it needs `suppressLocal` to decide whether to send locally at all), stamps `crossAgentMention: true` on the `QueuedItem`, and `agentStore.processQueuedItem` dispatches when the item becomes the agent's turn. `noteDispatch` strips the flag so an Agent Resilience retry cannot re-consult, and `handleEditQueueItem` recomputes it against the edited text.

A LEADING mention (`suppressLocal`) is the same story. The source agent does not answer it, but it still queues - as a `crossAgentOnly` item - whenever `hasWorkAheadOfNewMessage()` says the user lined work up first. Dispatching it fires the consult and returns before the spawn and before `noteDispatch`, then calls `applyQueuedItemRelease()` to hand back the busy state the dequeue took, since no process will arrive to close it out. It consults at submit time only when nothing is ahead of it - and that check goes through `probeSessionAiProcesses()`, not the store, so a turn main has already started still counts.

Module-level functions, not a hook: the queue drain runs outside React. The send itself is `sendCrossAgentRequest` in `hooks/agent/useCrossAgentDispatch.ts`, also module-level, sharing one `pendingRequests` tracker with the hook that subscribes to the response chunks.

**Only agents are targets - a group is not.** `resolveMentionedTargetSessionIds()` (`hooks/input/useAgentMentionCompletion.ts`) skips group suggestions outright, and `buildKnownMentionNameSet()` leaves group names out of the chip set for the same reason. A group is picker shorthand: accepting the row inserts `memberMentionValue` (every member's own `@name`), so the sent text names agents and nothing else. Resolving a group here TOO is how an agent that merely shared a name with a group had its message fanned out to the whole group - suggestions are built groups-first, so the group won that name every time. It also matters for `suppressLocal`: a message leading with a token that resolves to nothing must not suppress the local send, or it is addressed to nobody at all. A group name that survives into the sent text stays plain text, like any other unrecognized `@word`.

**Stop cancels consults - it is an agent-level action, not a tab one.** A mention fans one turn out across several processes: the agent's own tab plus one ephemeral `cross-agent-*` process per target, none of which carry the agent's process id. `useInterruptHandler` therefore calls `window.maestro.crossAgent.cancel(sessionId)` before it signals anything else (non-critical - a failure there must not block the interrupt). Cancellation is addressed by SOURCE AGENT, never by request id: the renderer only learns a request id once `crossAgent.send` resolves, so a Stop pressed inside that window would miss a consult main is already spawning. Main holds the authoritative registry (`cancelCrossAgentRequestsForSource` in `main/cross-agent/cross-agent-router.ts`), which is registered BEFORE the target's binary is resolved and re-checked around the spawn, so a Stop landing in either race still lands. A cancelled consult settles exactly like a timeout - process killed, partial flushed - but stamped `canceled` rather than `error`, because the user stopping a consult is not the target failing to answer. `crossAgentTerminationNote()` is the one place that wording is chosen, so the bubble and the history entry cannot disagree.

### queuedPrompt.ts - send a prompt without a composer

Everything that asks an agent a question without a user typing it - the CLI's `dispatch --queue`, a snooze's wake prompt - builds its queue item here.

- `buildQueuedMessageItem({ session, tab, text, images? })` - the `QueuedItem` a message becomes, exactly as the composer builds it.
- `enqueuePromptForTab({ sessionId, tabId, text, images? })` - resolve both from the store and append to the tail of `session.executionQueue`. Returns the item, or `null` when the agent is gone or has no AI tab.

**Queue it, do not spawn it.** The queue solves the timing problem for free: `useQueueProcessing` drains an idle agent on its next render and a busy one when its turn finishes, so no caller re-implements "is the agent free?", and nothing has to reach for the spawn config. It also re-resolves the target at DRAIN time through `resolveQueuedItemTarget`, which is what makes this safe to call in the same tick as the store write that created the tab. The alternative - dispatching the `maestro:remoteCommand` event - reads a render-time `sessionsRef`, so a prompt fired before React re-rendered finds a stale session and is dropped.

Three fields are easy to omit and each has a visible cost. `tabName` is the label a queued item falls back to once its tab is closed. `readOnlyMode` is what lets the item bypass the parallel-execution guard. `turnSettings` (from `captureQueuedTurnSettings`) freezes the model and effort at queue time, so a queue that drains after the user switches models still runs - and is labeled - with what was selected when it was queued. The `@mention` flags are STAMPED here and fired by `agentStore.processQueuedItem` at drain time, per the contract above; this module plans, it never consults.

Module-level functions, not a hook: the callers are a 15s sweep timer and an IPC listener, both outside React. `useRemoteIntegration`'s `dispatch --queue` path hand-rolled this item and had already drifted - a `agentSessionId.split('-')[0]` tab label instead of `getTabDisplayName`, and no `turnSettings` capture at all.

### snoozeWakePrompt.ts - run a snooze's prompt when its tab returns

A snooze carries a note AND, optionally, a prompt. They address different readers: the note becomes the wake notification (for the user), the prompt is sent to the agent the instant the tab is back. Either, both, or neither.

- `runSnoozeWakePrompt(sessionId, entry, restoredTabId, isMemberRestored?)` - queue `entry.wakePrompt` into the tab that came back. Returns whether anything was queued.
- `runSnoozeWakePromptAfterGroupWake(sessionId, entry, restoredTabId, droppedMembers)` - the same, for a group wake that already knows which panes it had to drop.

It fires on BOTH ways a tab returns - the scheduler's wake (`useSnoozeScheduler`) and an early "Unsnooze now" (`tabStore.unsnoozeTab`) - because the user wrote the prompt against the tab COMING BACK, not against the clock. A dismissed snooze restores nothing, so nothing is dispatched there.

The target comes from `resolveWakePromptTabId()` in `utils/snoozeHelpers.ts`, which is not the same as `entry.tab.id`: when an equivalent tab was already open the wake focuses THAT one and the prompt has to follow the tab the user actually lands on. A group resolves to its first surviving AI pane in leaf order - the layout's focused pane is stored as a pane id rather than a tab id, and a group focused on a file pane would otherwise have nowhere to send a prompt the user did ask for. A file, terminal, or browser snooze resolves to `null` and is logged rather than rerouted; the dialog hides the field for those kinds (`canSnoozeRunWakePrompt`), so an entry carrying one at all came from an older build or the CLI.

Everything goes through `queuedPrompt.ts` rather than a spawn, for the tick-safety reason above: the tab is restored in the same `setSessions` call the wake runs in.

### fileDeletion.ts - delete the previewed file

One confirmation, one delete, behind every surface that offers to remove the file you are looking at: the File Preview toolbar's trash button and the command palette's `File: Delete` entry.

**Key export:** `requestFileDeletion({ path, sshRemoteId?, sessionId? })` - opens the shared `confirm` modal (destructive, titled "Delete File") and, only on confirm, runs `window.maestro.fs.delete` - the same IPC the Files panel context menu uses, so SSH remotes are honored. `sessionId` defaults to the active session, which is what both surfaces are scoped to.

After a successful delete it force-closes every file preview tab in that session pointing at the path, then dispatches the `maestro:refreshFileTree` CustomEvent so the Files panel drops the entry without waiting for its next auto-refresh. The close deliberately skips the unsaved-changes prompt `handleCloseFileTab` puts up: the file is gone, so keeping the tab would leave the user editing a buffer that can no longer be saved back. A failed delete leaves the tab alone and reports through a red toast.

Do NOT add a second delete path. A new surface should call `requestFileDeletion` so the confirmation copy and the tab cleanup cannot drift.

---

### contextGroomer.ts (~430 lines)

Manages merging multiple conversation contexts across agents.

**Key exports:**

- `AGENT_ARTIFACTS` - Per-agent artifact patterns to strip during transfer (slash commands, brand references, model names)
- `AGENT_TARGET_NOTES` - Per-agent capability descriptions for transfer context
- `buildContextTransferPrompt(sourceAgent, targetAgent)` - Builds a prompt with agent-specific artifact removal instructions
- `ContextGroomingService` class (singleton: `contextGroomingService`)

**Grooming workflow:**

1. Collect and format source contexts
2. Calculate original token count
3. Call `window.maestro.context.groomContext()` with grooming prompt
4. Parse groomed output via `parseGroomedOutput` (from contextExtractor utils)
5. Report token savings

Shared utilities imported from `renderer/utils/contextExtractor`:

- `formatLogsForGrooming` - Formats LogEntry arrays into text
- `parseGroomedOutput` - Parses groomed text back to LogEntry arrays
- `estimateTokenCount` - Estimates tokens from a ContextSource
- `calculateTotalTokens` - Sums token counts across sources

Does NOT use `createIpcMethod`; uses direct `window.maestro.context.*` calls.

---

### contextSummarizer.ts (~489 lines)

Manages compacting a single conversation context to reduce context window usage.

**Key constants:**

- `MAX_SUMMARIZE_TOKENS = 50000` - Single-pass limit
- `TARGET_COMPACTED_TOKENS = 40000` - Multi-pass target
- `MIN_TOKENS_FOR_SUMMARIZATION = 2000` - Fallback threshold
- `MIN_LOG_ENTRIES_FOR_SUMMARIZATION = 8` - Second fallback
- `MAX_CONSOLIDATION_DEPTH = 3` - Prevents infinite loops

**`ContextSummarizationService` class** (singleton: `contextSummarizationService`):

- `summarizeContext(request, sourceLogs, onProgress)` - Main entry. Chunks large contexts automatically.
- `canSummarize(contextUsage, logs?)` - Triple-fallback eligibility check (context %, token estimate, log count)
- `cancelSummarization()` - Calls `window.maestro.context.cancelGrooming()`
- `formatCompactedTabName(originalName)` - Generates "Name Compacted YYYY-MM-DD"

**Chunked summarization:**
Large contexts (>50k tokens) are split into chunks, each summarized separately, then combined. If the combined result exceeds `TARGET_COMPACTED_TOKENS`, up to 3 consolidation passes aggressively reduce it.

Shares the same utilities from `contextExtractor` as contextGroomer: `formatLogsForGrooming`, `parseGroomedOutput`, `estimateTextTokenCount`.

---

### wizardIntentParser.ts (~277 lines)

Parses natural language input after `/wizard` command to determine user intent.

**`parseWizardIntent(input, hasExistingDocs)`** - Returns `{ mode, goal? }`:

- `'new'` - Create new documents from scratch
- `'iterate'` - Modify/extend existing documents (includes extracted goal)
- `'ask'` - Ambiguous, needs user clarification

Detection logic (priority order):

1. Empty input + no docs -> `new`; empty input + docs -> `ask`
2. Prefix match against `NEW_MODE_KEYWORDS` (21 keywords: new, fresh, start, create, begin, scratch, etc.)
3. Prefix match against `ITERATE_MODE_KEYWORDS` (21 keywords: continue, iterate, add, update, modify, etc.)
4. Anywhere-in-input match for both keyword sets
5. Ambiguous fallback: with docs -> `ask`, without docs -> `new`

**Helper functions:**

- `suggestsIterateIntent(input)` - Regex-based patterns ("I want to add...", "can you update...", etc.)
- `suggestsNewIntent(input)` - Regex-based patterns ("start from scratch", "new project", etc.)

Pure logic, no IPC calls.

---

### inlineWizardConversation.ts (~873 lines)

Manages AI conversations during inline wizard mode. Each message spawns a new agent process in batch mode (stateless per-message approach).

**Key functions:**

- `generateInlineWizardPrompt(config)` - Builds system prompt from mode-specific templates (`wizardInlineIteratePrompt` / `wizardInlineNewPrompt`), substitutes template variables
- `startInlineWizardConversation(config)` - Creates session config (no process spawn yet)
- `sendWizardMessage(session, userMessage, history, callbacks?)` - Spawns agent, collects output, parses structured JSON response
- `parseWizardResponse(response)` - Delegates to shared `parseStructuredOutput`, applies `READY_CONFIDENCE_THRESHOLD` (80)
- `endInlineWizardConversation(session)` - Kills process if active

**Agent-specific handling:**

- `buildArgsForAgent(agent)` - Configures per-agent CLI args. Claude Code gets `--allowedTools Read,Glob,Grep,LS` (read-only). Codex/OpenCode use base args.
- `extractResultFromStreamJson(output, agentType)` - Parses Claude Code `result` messages, OpenCode `text` parts, Codex `agent_message` content

**Process management:**

- 20-minute inactivity timeout (resets on any output)
- Registers `onData`, `onExit`, `onThinkingChunk`, `onToolExecution` listeners directly on `window.maestro.process`
- Does NOT use `processService` wrapper

---

### inlineWizardDocumentGeneration.ts (~1,292 lines)

Generates Auto Run documents from wizard conversation results. The largest service file.

**Key functions:**

- `generateInlineDocuments(config)` - Main orchestrator:
  1. Creates date-prefixed subfolder (e.g., "2026-03-21-Feature-Name")
  2. Sets up file watcher on subfolder for real-time streaming
  3. Spawns agent process with generation prompt
  4. Routes both chokidar file-change events and a periodic disk poll through a shared `createPlaybookDocumentEmitter` so each doc surfaces to the UI exactly once (the poll backstops the macOS fsevents cold-start window where add events go missing)
  5. Falls back to parsing document markers from output if neither watcher nor poll caught the file
  6. Creates a playbook configuration for generated documents
- `createPlaybookDocumentEmitter(options)` - Factory returning a `PlaybookDocumentEmitter` that owns the dedup set across watcher + poll inputs. Exposes `tryEmitFile`, `pollAndEmit`, `getEmittedDocuments`, `hasEmitted`. Built as a factory (not a class) so tests can mock `window.maestro.fs` / `window.maestro.autorun` without subclassing.
- `generateDocumentPrompt(config, subfolder?)` - Builds prompt from mode-specific templates
- `parseGeneratedDocuments(output)` - Extracts `---BEGIN DOCUMENT---` / `---END DOCUMENT---` blocks with FILENAME, UPDATE, and CONTENT fields
- `splitIntoPhases(content)` - Fallback splitter when agent produces single large document
- `countTasks(content)` - Counts `- [ ]` / `- [x]` checkbox items
- `sanitizeFilename(filename)` - Prevents path traversal attacks
- `extractDisplayTextFromChunk(chunk, agentType)` - Parses streaming JSON for display text

**Duplicated functions** (also in inlineWizardConversation.ts):

- `extractResultFromStreamJson` - Identical logic for parsing agent output
- `buildArgsForAgent` - Similar but allows Write tool (conversation version restricts to read-only)

---

### speckit.ts (~57 lines)

SpecKit slash command service. Wraps `window.maestro.speckit.*`:

- `getSpeckitCommands()` - Get all spec-kit commands
- `getSpeckitMetadata()` - Get version and refresh date
- `getSpeckitCommand(slashCommand)` - Get single command by slash string

Uses manual try/catch (does not use `createIpcMethod`).

---

### openspec.ts (~57 lines)

OpenSpec slash command service. Wraps `window.maestro.openspec.*`:

- `getOpenSpecCommands()` - Get all OpenSpec commands
- `getOpenSpecMetadata()` - Get version and refresh date
- `getOpenSpecCommand(slashCommand)` - Get single command by slash string

Structurally identical to speckit.ts - same 3 functions, same error handling pattern, same return types. Only the IPC namespace differs.

---

### systemSleep.ts (~90 lines)

Machine-sleep accounting for the renderer. Any duration measured as
`Date.now() - start` counts an overnight suspend as work: the wall clock runs while the
process is frozen, and a system suspend never fires `visibilitychange` (the window stays
"visible" the whole time). The main process measures the real gap with `powerMonitor` and
ships it over `app:systemResume`; this module accumulates it and every Auto Run duration
subtracts it.

- `beginSleepAwareSpan()` / `sleepAwareElapsedMs(span)` - the preferred pair. Per task, per
  loop, per run.
- `onSystemSleep(handler)` - for a live tracker that pauses its own clock (`useTimeTracking`
  walks its per-session timestamps forward by the gap).
- `sleepAwareElapsedSince(startTime)` - for a display that only kept a start timestamp
  (the Auto Run pill, the thinking timer).
- `getTotalSleepMs()`, `recordSystemSleep()` (tests), `resetSystemSleepTracking()` (tests).

Singleton: one IPC listener, attached lazily on first use, one counter, so every consumer
measures the same sleep. The math lives in `src/shared/sleepTracking.ts` and is shared with
the main-process counterpart `src/main/utils/sleep-tracker.ts`.

---

### index.ts (~45 lines)

Barrel export file. Re-exports from:

- `git` (gitService + types)
- `process` (processService + types)
- `ipcWrapper` (createIpcMethod + types)
- `contextGroomer` (ContextGroomingService + singleton + types)
- `contextSummarizer` (ContextSummarizationService + singleton + types)
- `systemSleep` (span helpers, `onSystemSleep`, `getTotalSleepMs` + types)
- `wizardIntentParser` (parseWizardIntent, suggestsIterateIntent, suggestsNewIntent + types)

Notable omissions from the barrel: `speckit.ts`, `openspec.ts`, `inlineWizardConversation.ts`, `inlineWizardDocumentGeneration.ts` are imported directly by consumers.

---

## Constants Overview

### themes.ts (~10 lines)

Pure re-export from `src/shared/themes.ts`. No definitions in this file - all theme data lives in the shared layer.

Exports: `THEMES`, `DEFAULT_CUSTOM_THEME_COLORS`, `getThemeById`, type exports for `Theme`, `ThemeId`, `ThemeColors`, `ThemeMode`.

---

### shortcuts.ts (~193 lines)

Defines all keyboard shortcuts in three tiers:

**`DEFAULT_SHORTCUTS`** (30+ entries) - User-configurable:

- Panel toggles: sidebar, right panel, AI/shell mode
- Agent navigation: previous/next, jump to session
- View actions: files tab, history tab, Auto Run tab, git diff, git log
- Actions: new agent, kill agent, quick actions, settings, help
- Editor: markdown mode, auto-scroll, bookmarks, font size reset
- Modals: prompt composer, wizard, symphony, director's notes

**`FIXED_SHORTCUTS`** (10+ entries) - Displayed but not configurable:

- Jump to session (Alt+Cmd+1-0)
- Context-specific filters (Cmd+F in various views)
- File preview navigation (Cmd+Arrow)
- Font size increase/decrease

**`TAB_SHORTCUTS`** (20+ entries) - AI mode only:

- Tab CRUD: new, close, close all, close others, close left/right, reopen
- Tab navigation: switcher, previous/next, go to tab 1-9, last tab
- Tab actions: rename, toggle read-only, toggle save to history, toggle show thinking, toggle unread, toggle star

Each shortcut has `id`, `label`, and `keys` array.

---

### modalPriorities.ts (~243 lines)

Defines priority/z-index values for all modals and overlays. Used by the layer stack system for Escape key handling and visual stacking.

**Priority Ranges:**

| Range   | Category              | Examples                                                                           |
| ------- | --------------------- | ---------------------------------------------------------------------------------- |
| 1000+   | Critical/Celebrations | Standing ovation (1100), Keyboard mastery (1095), Tour (1050), Quit confirm (1020) |
| 900-999 | High priority         | Gist publish (980), Playbook delete (950), Rename instance (900)                   |
| 700-899 | Standard modals       | Wizard (760), New instance (750), Batch runner (720), Quick action (700)           |
| 600-699 | Group chat + info     | New group chat (650), Shortcuts help (650), About (600)                            |
| 400-599 | Settings + analytics  | Process monitor (550), Usage dashboard (540), Log viewer (500), Settings (450)     |
| 100-399 | Overlays + previews   | Git diff (200), Git log (190), Lightbox (150), File preview (100)                  |
| 1-99    | Autocomplete          | Slash autocomplete (50), File tree filter (30)                                     |

Exported as `MODAL_PRIORITIES` const object with 60+ named entries.

---

### app.ts (~113 lines)

Claude Code tool-related constants for output parsing.

**`KNOWN_TOOL_NAMES`** - Array of 19 known tool names (Task, Bash, Glob, Grep, Read, Edit, Write, etc.)

**`isLikelyConcatenatedToolNames(text)`** - Detects malformed output like "TaskGrepGrepReadReadRead" by checking if text is composed of 3+ consecutive tool names. Also handles MCP tool patterns (`mcp__provider__tool`).

**`CLAUDE_BUILTIN_COMMANDS`** - Map of 10 built-in Claude Code slash commands to descriptions (compact, context, cost, init, pr-comments, release-notes, todos, review, security-review, plan).

**`getSlashCommandDescription(cmd)`** - Returns description for built-in commands, parses plugin commands (`plugin:command`), falls back to generic description.

---

### agentIcons.ts (~80 lines)

Maps agent type IDs to emoji display icons.

**`AGENT_ICONS`** - Record mapping:

- `claude-code` / `claude` -> robot emoji
- `codex` / `openai-codex` -> diamond
- `gemini-cli` / `gemini` -> blue diamond
- `qwen3-coder` / `qwen` -> hexagon
- `opencode` -> pager
- `factory-droid` -> factory
- `terminal` -> laptop

**`getAgentIcon(agentId)`** / **`getAgentIconForToolType(toolType)`** - Safe lookup with `DEFAULT_AGENT_ICON` (wrench) fallback.

Used by `SendToAgentModal` and `useAvailableAgents` hook.

---

### colorblindPalettes.ts (~288 lines)

Comprehensive accessibility color system based on Wong's palette (Nature Methods, 2011).

**Color Palettes:**

- `COLORBLIND_AGENT_PALETTE` - 10 colors for agent/categorical data
- `COLORBLIND_BINARY_PALETTE` - 2 colors (blue/orange) for binary comparisons
- `COLORBLIND_HEATMAP_SCALE` - 5-level sequential scale (light yellow to dark blue)
- `COLORBLIND_LINE_COLORS` - 3 colors for line charts
- `COLORBLIND_EXTENSION_PALETTE` - 15 file type categories with light/dark mode variants

**Pattern fills** for additional visual distinction:

- `COLORBLIND_PATTERNS` - solid, diagonal, dots, crosshatch, horizontal, vertical

**Helper functions:**

- `getColorBlindAgentColor(index)` - Wrapping index lookup
- `getColorBlindHeatmapColor(intensity)` - Clamped 0-4 lookup
- `getColorBlindPattern(index)` - Wrapping pattern lookup
- `getColorBlindExtensionColor(extension, isLightTheme)` - Maps file extensions to category colors (TS/JS, markdown, config, CSS, HTML, Python, Rust, Go, shell, images, Java, C/C++, Ruby, SQL, PDF)

Used extensively by UsageDashboard charts and SymphonyModal.

---

### conductorBadges.ts (~346 lines)

Gamification system tracking cumulative AutoRun time with conductor-themed achievements.

**11 badge levels:**

| Level | Name                      | Required Time |
| ----- | ------------------------- | ------------- |
| 1     | Apprentice Conductor      | 15 minutes    |
| 2     | Assistant Conductor       | 1 hour        |
| 3     | Associate Conductor       | 8 hours       |
| 4     | Resident Conductor        | 24 hours      |
| 5     | Principal Guest Conductor | 1 week        |
| 6     | Chief Conductor           | 30 days       |
| 7     | Music Director            | 3 months      |
| 8     | Maestro Emeritus          | 6 months      |
| 9     | World Maestro             | 1 year        |
| 10    | Grand Maestro             | 5 years       |
| 11    | Titan of the Baton        | 10 years      |

Each badge includes name, description, a historical example conductor with Wikipedia link, and flavor text.

**Helper functions:**

- `getBadgeForTime(cumulativeTimeMs)` - Returns highest qualifying badge
- `getNextBadge(currentBadge)` - Returns next badge or null
- `getProgressToNextBadge(time, current, next)` - 0-100 progress
- `formatTimeRemaining(time, nextBadge)` - Human-readable remaining time
- `formatCumulativeTime(timeMs)` - Human-readable elapsed time

Used by AchievementCard, LeaderboardRegistrationModal, PlaygroundPanel, SessionList.

---

### keyboardMastery.ts (~87 lines)

Keyboard shortcut mastery progression system.

**5 levels:**

| Level     | Name             | Threshold |
| --------- | ---------------- | --------- |
| beginner  | Beginner         | 0%        |
| student   | Student          | 25%       |
| performer | Performer        | 50%       |
| virtuoso  | Virtuoso         | 75%       |
| maestro   | Keyboard Maestro | 100%      |

**Helper functions:**

- `getLevelForPercentage(percentage)` - Returns highest matching level
- `getLevelIndex(percentage)` - Returns index 0-4
- `collectBoundShortcuts(...maps)` - Merges shortcut maps (later maps win on id) and keeps only the entries with a chord bound. This is the mastery DENOMINATOR everywhere: an unbound shortcut cannot be fired, so counting one pins the user below 100% forever and lists a chord that does not exist under "Unused Shortcuts". Pass the LIVE maps (`shortcuts`, `tabShortcuts` off the settings store) plus `FIXED_SHORTCUTS`, so a binding cleared in Settings -> Shortcuts leaves the denominator too.
- `countUsedBoundShortcuts(bound, usedShortcutIds)` - The NUMERATOR. Not `usedShortcuts.length`: that list keeps ids whose binding was later cleared or that were removed from the app, which would push the count past the total and report over 100%.

Do NOT hand-roll another `Object.keys(DEFAULT_SHORTCUTS).length + ...` total - `settingsStore` and `LeaderboardRegistrationModal` each had their own copy, and they disagreed with the two surfaces that render the figure.

Used by ShortcutsHelpModal, KeyboardStats, KeyboardMasteryCelebration, LeaderboardRegistrationModal, PlaygroundPanel, settingsStore.

---

### cuePatterns.ts (~224 lines)

Defines `CuePattern` interface and the `CUE_PATTERNS` array - preset Cue YAML templates (startup, file watch, interval, etc.) surfaced in the Cue modal for users to pick from.

---

## IPC Access Patterns

**Services using `createIpcMethod`:** `git.ts` (7 calls), `process.ts` (5 calls)

**Services with direct `window.maestro.*` calls:**

- `contextGroomer.ts` - 2 calls to `window.maestro.context.*`
- `contextSummarizer.ts` - 4 calls to `window.maestro.context.*`
- `inlineWizardConversation.ts` - 8 calls to `window.maestro.process.*` and `window.maestro.agents.*`
- `inlineWizardDocumentGeneration.ts` - 15+ calls across `window.maestro.process.*`, `window.maestro.autorun.*`, `window.maestro.agents.*`, `window.maestro.fs.*`
- `speckit.ts` - 3 calls to `window.maestro.speckit.*`
- `openspec.ts` - 3 calls to `window.maestro.openspec.*`

The wizard services and context services bypass both `createIpcMethod` and `processService`, calling the preload bridge directly. They manage their own error handling, event listeners, timeouts, and cleanup.
