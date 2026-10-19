# PR #1401: merge current `rc`, limit the interrupt gate to Cursor, loosen the Cursor identity check

- **Ticket:** PR-1401, answering the maintainer review of 2026-10-18
  (https://github.com/RunMaestro/Maestro/pull/1401, comment by `pedramamini`)
- **Worktree:** `maestro-pr1401/.claude/worktrees/pr1401-cursor-cli-agent`
- **Branch under change:** `pr1401-push` @ `dfad6fa1f`. It is pushed to `fork/codex/cursor-cli-agent-rc`, the PR head
  (local HEAD = PR `headRefOid`).
- **`rc` merged in:** `b07f0755f` (merge `dd79bb814`). `origin/rc` is now at `5520c7af3`; see N4.
- **Spec round:** 4. This revision answers the round-3 Reviewer DISCUSS
  (`/tmp/qa-reports/2026-10-19-pr1401-cursor-cli-rc-sync-r3.md`). Round 3 raised no [blocking] finding.

## Round 4: what this revision changes

Round 3 landed J, K, L and M. The Reviewer confirmed that both new Cursor messages reach the main session, and that
their tests fail without the fix. The wizard is still the open item: the user chose to fix D8 in this PR rather than
split it out.

| Finding | Label | Resolution | Section |
| --- | --- | --- | --- |
| D8. The new messages never reach the wizard | discuss | **Fix here.** Each of the four wizard spawn paths keeps the `agent-error` the main process reports for its session and shows it when the turn fails | W |
| R3-3 (spec) and the round-3 PR comment overclaimed the wizard | - | Corrected under Assumptions (R4-1). The round-4 PR comment says what changed | E |
| D1. No CI on `dfad6fa1f` | discuss | Waits on the maintainer. The PR comment asks again | E, CI owns |
| N8. The final e2e changes never ran live | advisory | Stays the optional live check under Verify | Verify |
| N9, N10, N11, N4 | advisory | Dropped, as the Reviewer proposed | - |
| A4, A7, A10 | advisory | Stay deferred (round-2 record, I) | - |

Files this round (10: 5 source, 5 test):

- `src/renderer/components/Wizard/services/wizardErrorDetection.ts`
- `src/renderer/components/Wizard/services/conversationManager.ts`
- `src/renderer/components/Wizard/services/phaseGenerator.ts`
- `src/renderer/services/inlineWizardConversation.ts`
- `src/renderer/services/inlineWizardDocumentGeneration.ts`
- `src/__tests__/renderer/components/Wizard/services/wizardErrorDetection.test.ts`
- `src/__tests__/renderer/components/Wizard/services/conversationManager.test.ts`
- `src/__tests__/renderer/components/Wizard/services/phaseGenerator_ssh.test.ts`
- `src/__tests__/renderer/services/inlineWizardConversation.test.ts`
- `src/__tests__/renderer/services/inlineWizardDocumentGeneration_overrides.test.ts`

---

## W. Show the agent's reported error when a wizard turn fails (D8)

### The defect

The main process classifies every agent failure and sends it to the renderer as `agent:error`
(`error-listener.ts:45-62`). The main session listens for it. The wizard does not:

| Wizard spawn path | Listens for | On a non-zero exit it shows |
| --- | --- | --- |
| `conversationManager.ts:457-498` (new-agent wizard conversation) | `onData`, `onExit`, thinking, tools | `detectWizardError(outputBuffer)` (`:531`), else a parsed reply, else `createGenericErrorMessage` (`:582`) |
| `phaseGenerator.ts:936,967` (new-agent wizard, document generation) | `onData`, `onExit` | `Agent exited with code ${code}` (`:1025`), always |
| `inlineWizardConversation.ts:770,826` (inline wizard conversation) | `onData`, `onExit`, thinking, tools | a parsed reply, else `Agent exited with code ${code}` (`:858`) |
| `inlineWizardDocumentGeneration.ts:1106,1117` (inline wizard, document generation) | `onData`, `onExit` | `Agent exited with code ${code}` (`:1134`), always |

For Cursor, stderr never reaches `onData` (`StderrHandler.ts:116-128`), and a failed `result` leaves through the
error path. The wizard's buffer is empty, so every failed turn reads "Agent exited with code 1", plus "Check the
terminal for details." in the first path. The Reviewer reproduced this offline for all four ways Cursor delivers
the two messages (report D8). The same gap applies to any stream-json agent whose failure arrives only on stderr or
as an error event.

### The approach

Keep the error the main process reported for this spawn, and use it **only where the wizard would otherwise fall
back to a generic message**. Every branch that already produced something keeps doing so: a pattern match on the
output, a parseable reply on a non-zero exit (the Grok `--max-turns` case,
`inlineWizardConversation.test.ts:449`), and every success.

Ordering is safe. Main emits `agent-error` before `exit` (`ExitHandler.ts:280,521` before `:584`), and both
listeners forward synchronously through `safeSend` (`error-listener.ts:62`, `exit-listener.ts:245`). So the error has
arrived by the time the renderer's exit handler runs. `useAgentExecution.ts:841` already relies on this for the
synopsis turn: it stores `error.message` from `onAgentError` and reads it at exit.

### Change 1: two helpers in `wizardErrorDetection.ts`

Detection already lives in this module; these add the presentation of an error main has already classified.

```ts
/** The fields of a main-process `agent-error` that the wizard reads. */
export interface ReportedAgentError {
	type: string;
	message: string;
}

/**
 * Present an error the main process already classified (the `agent-error` event) the
 * same way as one found in the output: same title, recovery hint and retry rule.
 */
export function wizardErrorFromAgentError(
	error: ReportedAgentError,
	agentType: ToolType
): WizardError;

/**
 * Keep the latest `agent-error` the main process reports for one wizard spawn. Main
 * sends it before `process:exit`, so the exit handler can read it with `latest()`.
 */
export function captureAgentError(sessionId: string): {
	latest: () => ReportedAgentError | undefined;
	cleanup: () => void;
};
```

- `wizardErrorFromAgentError`: `type` is `error.type` when it is an own key of `ERROR_TITLES`, else `'unknown'`.
  `title`, `recoveryHint` and `canRetry` come from `ERROR_TITLES`, `recoveryHintFor` and `RETRYABLE_TYPES`, exactly
  as `detectWizardError` builds them. `message` is `error.message`.
- `captureAgentError`: subscribes with `window.maestro.process.onAgentError?.(…)`, filters on `sessionId`, and
  overwrites the stored error on each event, so a spawn the main process retries reports its last failure.
  `cleanup` unsubscribes. The optional call follows `onThinkingChunk?.` at `conversationManager.ts:470`, and keeps
  the existing test mocks that have no `onAgentError` working.

### Change 2: wire it into the four paths

In each path: create the capture right after the existing `onData` subscription, call its `cleanup` from the path's
existing cleanup function (so the timeout, abort and exit paths all unsubscribe), and read `latest()` only in the
branch named below.

| Path | Where the capture lives | Cleaned up in | Used in this branch | Result when an error was captured |
| --- | --- | --- | --- | --- |
| `conversationManager.ts` | a new `agentErrorCapture?` field on the session state, beside `exitListenerCleanup` (`:134`) | `cleanupListeners()` (`:945`) | the "No specific error detected" `else` (`:580-594`), before `createGenericErrorMessage` | `resolve({ success: false, error: \`${detected.title}: ${detected.message}\`, rawOutput, detectedError: detected })`, the same shape as the pattern-match branch at `:552-557` |
| `phaseGenerator.ts` | a private field beside `exitListenerCleanup` | `cleanup()` (`:1280`) | the non-zero branch (`:1010-1028`) | `error: formatWizardError(detected)` |
| `inlineWizardConversation.ts` | a local beside `exitListenerCleanup` | `cleanupListeners()` (`:750`) | the final `else` (`:855-861`) only | `error: formatWizardError(detected)` |
| `inlineWizardDocumentGeneration.ts` | a local beside `exitListenerCleanup` | `cleanupAll()` (`:1026`) | the non-zero branch (`:1130-1136`) | `error: formatWizardError(detected)` |

`detected` is `wizardErrorFromAgentError(captured, <the path's agent type>)`: `this.session.agentType`,
`config.agentType`, `session.agentType` and `agentType` respectively. With nothing captured, each branch keeps its
current text.

The conversation screen renders `detectedError` as a title, message, hint and retry rule
(`ConversationErrorPanel.tsx:30-65`), so the first path gets the full error panel. The other three surface a string
(`usePreparingPlanGeneration.ts:148`, `conversationActions.ts:401`, `generationActions.ts:203`), so they get
`formatWizardError`'s "Title: message" plus the hint. That helper exists for this and has no caller in production
code yet.

For Cursor this gives, for example:

- Logged out: "Authentication Required: Not authenticated with Cursor. Sign in again to continue.", with the hint
  `Run "agent login" to sign in again, then start the wizard over.` (`agentMetadata.ts:287`).
- Free plan with a named default: "Agent Error: Cursor's Free plan only allows the Auto model. Set this agent's
  model to auto, or upgrade your Cursor plan.", with the generic retry hint.

### Tests

- **`wizardErrorDetection.test.ts`:**
  - `wizardErrorFromAgentError` with `{ type: 'auth_expired', message: 'Not authenticated with Cursor. Sign in again
    to continue.' }` and `'cursor-cli'`: title "Authentication Required", the message unchanged, a hint containing
    `agent login`, `canRetry` false.
  - With `{ type: 'agent_crashed', message: <K's message> }`: title "Agent Error", `canRetry` true.
  - With an unrecognised type string, and with `'toString'`: type `'unknown'`.
  - `captureAgentError`: stub `window.maestro.process.onAgentError` to record its callback. Events for another
    session are ignored, the latest event for this session wins, and `cleanup` calls the unsubscribe function.
    Without `onAgentError` on the stub, `latest()` returns `undefined` and nothing throws.
- **`conversationManager.test.ts`:** a `cursor-cli` turn with no `data`. The test fires `onAgentError` for the
  session with Cursor's `auth_expired` error, then `onExit` with code 1. Expect `success: false`, `detectedError.type`
  `'auth_expired'`, and `detectedError.message` equal to the Cursor message. Then the same turn with the error sent
  for another session id: the result keeps today's "Agent exited with code 1. Check the terminal for details."
- **`inlineWizardConversation.test.ts`:** the same shape with K's Free-plan error. Expect `error` to contain K's
  message. The existing "should accept a parseable Grok reply even when the process exits non-zero" test must still
  pass unchanged; it pins that a parseable reply outranks a captured error.
- **`inlineWizardDocumentGeneration_overrides.test.ts`** and **`phaseGenerator_ssh.test.ts`:** one test each.
  An `auth_expired` error, then exit 1: `error` contains "Not authenticated with Cursor". These two files already
  mock spawn, exit and the folder watcher, which document generation needs. The phaseGenerator test goes in its own
  `describe('agent errors at exit')`, because nothing about it is SSH-specific (R4-4).
- Add `onAgentError: vi.fn().mockReturnValue(() => {})` to a test file's `window.maestro.process` mock only where a
  new test needs it. The tests drive the callback the way each file already drives `onExit`.
- **Probe, then revert before committing:** in `conversationManager.ts`, skip the captured error (use
  `createGenericErrorMessage` unconditionally). The new conversationManager test must fail. Do the same in
  `inlineWizardConversation.ts`.

### Out of scope for W

- The two string-only error displays collapse newlines (`ErrorDisplay.tsx:32`), so the hint shows after the message
  on one line. Restyling them is a separate change.
- The wizard still reads its output buffer first. Making main's error outrank a pattern match on the output would
  change agents that already work; nothing asks for that.

## E. Push and reply (round 4)

This replaces round 3's E.

1. Commit W as one commit: `fix(wizard): show the agent's reported error when a wizard turn fails`.
2. If this spec is tracked (the Planner's `docs(spec): PR-1401` commit), untrack it in its own commit before
   pushing: `git rm --cached docs/specs/pr1401-rc-sync-round3.md`, message
   `chore(spec): untrack the PR-1401 round 4 spec`. The file stays on disk, and the PR's net diff never contains it.
3. Push: `git push fork pr1401-push:codex/cursor-cli-agent-rc`, a fast-forward, no force. Then run
   `gh pr view 1401 -R RunMaestro/Maestro --json mergeable,mergeStateStatus`. Expect `MERGEABLE`, and `UNSTABLE`
   while CI waits for approval. If it says `CONFLICTING`, stop and report: a second `rc` merge is a round of its own.
4. Post one PR comment covering:
   - **Correction:** the round-3 comment said users "now see" both Cursor messages wherever they arrive. That held
     for the main session only; the wizard still showed "Agent exited with code 1".
   - **W:** the wizard now shows the error the main process reported, in all four wizard spawn paths, and only
     where it would otherwise show a generic message. Name the tests. Say that it helps every agent whose failures
     arrive only on stderr or as error events, not just Cursor, and that no other wizard behavior changes.
   - **Gates:** the Verify lines run locally, with their exit codes.
   - **CI:** ask again for approval of the fork workflow run, naming `lint-and-format`,
     `Test (ubuntu-latest, shard 1/2)`, `Test (ubuntu-latest, shard 2/2)`, `Test (windows-latest, shard 1/2)` and
     `Test (windows-latest, shard 2/2)`.
5. Optional, not a gate: the live check under Verify (N8). It sends five short prompts to Cursor under the user's
   account and takes about 7 minutes.

**Ask for one "autorizo" for the whole set** (`~/.claude/rules/autorizacao.md`): the W commit, the untrack commit,
the push, the PR comment, and the live check if wanted (it sends prompts to an external service). List the branch,
remote, commit messages and comment text, then stop and wait. Do not route around the trava hook. It also blocks
read-only commands whose name contains `merge`, such as `git merge-base`; use `git log` to check ancestry.

---

## Round 3 record (sections J-M, landed at `dfad6fa1f`)

Kept for reference. The round-3 Reviewer verified these against the diff. Line numbers are as of `9ab349d58`.
R3-3's claim about the wizard was wrong; W fixes the behavior, and R4-1 corrects the assumption.

### J. Treat Cursor's "Authentication required" message as a sign-in error (D6)

**The defect.** When logged out, Cursor prints:

```text
Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.
```

Round 1 captured this from `agent --list-models`; `-p` turns pass the same auth gate. No Cursor pattern matches it.
The first `auth_expired` pattern wants `authentication failed` or `please run…agent login`, and this text has
neither. So at exit it becomes `agent_crashed` ("Agent exited with code 1"). As a stderr line it is not recognised
at all. Inside a failed `result` it becomes `unknown`. The user sees a crash card instead of "Not authenticated
with Cursor" and the sign-in flow.

**Change (`src/shared/agentErrorPatterns.ts`, `CURSOR_CLI_ERROR_PATTERNS.auth_expired[0]`):**

```ts
pattern: /not (?:logged in|authenticated)|authentication (?:failed|required)|please run.*agent login/i,
```

Leave the message as it is. The comment above the bank explains why it names no login command.

**Tests:**

- `cursor-cli-output-parser.test.ts`, next to "detects auth errors from stderr via pattern bank": one test. Put the
  string above in a named constant, with a comment saying where it came from. Expect `type: 'auth_expired'` from
  all three entry points:
  - `detectErrorFromExit(1, msg, '')`, the exit path;
  - `detectErrorFromLine(msg)`, the stderr path (`StderrHandler.ts:56`);
  - `detectErrorFromParsed({ type: 'result', is_error: true, result: msg, session_id: 's1' })`.
- `error-patterns.test.ts`, inside `describe('CURSOR_CLI_ERROR_PATTERNS')`: `matchErrorPattern` on the string
  returns `auth_expired` with the message "Not authenticated with Cursor. Sign in again to continue."
- Probe, then revert: undo the pattern edit. The new parser test must fail.

### K. Explain Cursor's Free-plan model error instead of reporting a crash (D7)

**The defect.** On a Free plan, Cursor refuses every named model. Take a user whose Cursor default is a named model
(`model.modelId` in `~/.cursor/cli-config.json`; on this Mac, `composer-2.5`) and who runs a turn without a model
override. Cursor writes this to stderr and exits 1:

```text
ActionRequiredError: Named models unavailable Free plans can only use Auto. Switch to Auto or upgrad
```

The round-2 e2e run saw it live on Cursor `2026.10.16-e3cb207`; Maestro's log cut it at 100 characters. No pattern
matches, so every turn reports "Agent exited with code 1". Maestro hides stderr for stream-json agents
(`StderrHandler.ts:116-128`), so Cursor's own "Switch to Auto" hint never reaches the user.

**Change (`CURSOR_CLI_ERROR_PATTERNS.agent_crashed`), a new first entry:**

```ts
{
	pattern: /named models unavailable|can only use auto/i,
	message:
		"Cursor's Free plan only allows the Auto model. Set this agent's model to auto, or upgrade your Cursor plan.",
	recoverable: true,
},
```

- Type `agent_crashed`, like the existing "model is not available on this Cursor account" entry beside it.
  Assumption R3-3 says why not another type.
- The pattern has two alternatives, so either half still matches if the text arrives split across stderr chunks.
  The exit path also re-matches the whole stderr buffer (`ExitHandler.ts:375`).
- Checked against the bank's match order (`ERROR_TYPES_BY_HIT_FREQUENCY`): no earlier Cursor pattern matches this
  text, and the new pattern matches none of the auth, rate-limit or 429 strings the tests already pin.

**Tests:**

- `cursor-cli-output-parser.test.ts`: put the captured line in a named constant, exactly the 100 characters above
  (ending `upgrad`), with a comment saying the log truncated it. Expect `{ type: 'agent_crashed', message: <the new
  message> }` from both `detectErrorFromExit(1, msg, '')` and `detectErrorFromLine(msg)`. Also expect the same
  message from `detectErrorFromLine('Free plans can only use Auto. Switch to Auto or upgrade')`, the split case.
- `error-patterns.test.ts`: `matchErrorPattern` on the captured line returns the new message, not the generic
  "selected model is not available" one.
- Probe, then revert: delete the entry. The new parser test must fail.

### L. Make the live Cursor e2e tests independent of the account's plan (N1, N2)

These tests run only with `RUN_INTEGRATION_TESTS=true` and a logged-in Cursor. CI skips them.

- **N1, `CursorCliProcessManager.e2e.test.ts`:** in `buildBatchArgs`, pass `modelId: 'auto'` to `buildAgentArgs`.
  Both ProcessManager turns then carry `--model auto`, the plan-mode turn included.
- **N1, `CursorCliSpawner.e2e.test.ts`, "resumes a real chat by session id":** pass `{ customModel: 'auto' }` to both
  `spawnAgent` calls (with `undefined` as the first call's session id), as "spawns a real headless turn" already does.
- **N2, same file:** add `const RESUME_TIMEOUT = 300_000;` with a one-line comment (two live turns in a row; one
  turn took 65-80 s in round 2). Use it for the resume test only; the other tests keep `TIMEOUT`.

These are the edits in the Reviewer's passing copies (`/tmp/qa-r2/e2e-auto/` on this Mac), minus their absolute
import paths.

### M. Docs: the Free-plan limit and the live re-check (N5)

In `PROVIDER-SUPPORT.md`, Cursor CLI section:

- Keep the heading (`:1375`) and the `capabilities.ts:522` comment on `2026.07.16-899851b`.
- After the **Status:** paragraph (`:1377`), add one sentence: "Re-checked live on Cursor CLI `2026.10.16-e3cb207`
  during the PR's round-2 review: detection, headless turns through the CLI and desktop spawn paths, plan mode, and
  resume."
- In the table, the Model Selection value gains "; Free plans accept only `auto`". Run `npx prettier --write
  PROVIDER-SUPPORT.md` so the table re-pads; the file is otherwise prettier-clean, so nothing else moves.

---

## Round 2 record (sections F-I, landed at `9ab349d58`)

Kept for reference. The round-2 Reviewer verified these against the diff. Line numbers are as of `734c01911`.

### F. Keep Cursor's pre-error text on a failed mid-stream `result` (D2)

**The defect.** Cursor's parser maps `{"type":"result","is_error":true}` to `type: 'error'`
(`maestro-lib/parsers/cursor-cli-output-parser.ts:132-139`). StdoutHandler flushes the streamed text ahead of an
error only when `outputParser.isResultMessage(errorLineEvent)` is true (`StdoutHandler.ts:553`). That is false for
`type: 'error'`. The exit fallback is then skipped, because `errorEmitted` is set (`ExitHandler.ts:316`). The same
record arriving without a trailing newline goes through `ExitHandler.ts:283`, which passes `flushStreamedText: true`.
So the user keeps the text in one case and loses it in the other.

**Decision: keep the text in both cases.** `rc`'s own rule (the comment at `StdoutHandler.ts:543-545`) is that a
failed terminal envelope ends the turn, so what the agent said before it is the turn's last output. Claude already
behaves this way, because its parser keeps a failed result as `type: 'result'`.

**Why not change `isResultMessage`.** Cursor's parser test "parses is_error result events as errors for CLI batch
spawning" (`cursor-cli-output-parser.test.ts:228`) pins `isResultMessage` to `false` for this event. The CLI batch
path relies on that, so it never records the error text as the answer. Changing it would move the bug to the CLI.

**Change:**

1. `src/shared/maestro-lib/parsers/agent-output-parser.ts`: next to `isProvisionalErrorNotice?` (:333), add an
   optional hook in the same style:

   ```ts
   /**
    * True when this error event is the parser's mapping of a failed terminal result
    * envelope (for example Cursor's `{"type":"result","is_error":true}`). Text the
    * agent streamed before it is then the turn's last output and is flushed ahead of
    * the error, as it is for a result message. Parsers that keep a failed result as
    * `type: 'result'` (Claude) do not need this.
    */
   isFailedResultMessage?(event: ParsedEvent): boolean;
   ```

2. `cursor-cli-output-parser.ts`: implement it as `event.type === 'error' && (event.raw as CursorRawMessage |
   undefined)?.type === 'result'`. Leave `isResultMessage` unchanged.
3. `StdoutHandler.ts:553`: the flag becomes

   ```ts
   flushStreamedText:
   	!!errorLineEvent &&
   	(outputParser.isResultMessage(errorLineEvent) ||
   		outputParser.isFailedResultMessage?.(errorLineEvent) === true),
   ```

   No other parser implements the hook, so every other agent's behavior is unchanged.

**Tests:**

- `StdoutHandler.test.ts`: a `cursor-cli` stream-json process receives assistant partial deltas ("I found the bug
  in auth.ts"), then `{"type":"result","is_error":true,"result":"Rate limit","session_id":"s1"}\n`. Expect one
  `data` event carrying the streamed text, emitted before the single `agent-error`. This is the mid-stream twin of
  the existing ExitHandler test "emits an unterminated Cursor error result … after the partial text".
- `cursor-cli-output-parser.test.ts`: `isFailedResultMessage` is true for the parsed `is_error` result, false for a
  success result, and false for an `error` event whose raw `type` is not `result`.
- Probe, then revert before committing: drop the `isFailedResultMessage` clause from `StdoutHandler.ts:553`. The new
  StdoutHandler test must fail.

### G. Stop pinning the agent's config onto wizard-created sessions (D5)

**The defect.** `handleOpenConfig` copies the agent's stored config into wizard state
(`useAgentConfigurationPanel.ts:102`). `useWizardHandlers.ts:1264-1276` then turns `model`, `reasoningEffort`,
`providerPath` and `contextWindow` into the new session's `customModel`, `customEffort`, `customProviderPath` and
`customContextWindow`. Per-session values outrank the agent's config. A user who only opens the panel freezes the
session on whatever the agent's config said at that moment. In `rc`, a wizard session carried none of these and
followed the agent's config.

**Decision: remove the pins.** They are redundant as well as harmful. Every control in `AgentConfigPanel` already
saves to the agent's config through `agents.setConfig`: selects and checkboxes on change
(`AgentConfigPanel.tsx:1127-1130`, `:1160-1163`), text fields on blur (`handleConfigBlur`,
`useAgentConfigurationPanel.ts:213-222`, which `rc` already had). So whatever the user changes in the wizard
already reaches the session through the agent's config.

**Change (`src/renderer/hooks/wizard/useWizardHandlers.ts`):**

- Delete the four derived constants (`customModel`, `customEffort`, `customProviderPath`, `customContextWindow`,
  ~:1264-1276) and their four session fields (~:1378-1381).
- Delete the `readEffortFromConfig` import (:48). Delete `agentConfigValues` from the destructure (~:1224) if
  nothing else in that function reads it.
- Keep `customPath`, `customArgs` and `customEnvVars` on the session; `rc` already had them.
- Leave the wizard state and the conversation spawns alone (A5). There, `agentConfigValues` drives the planning
  turn, which is a separate path.

**Test (`useWizardHandlers.test.ts` ~:2224-2283):** keep the fixture's `agentConfigValues` block. Change the four
`customModel`/`customEffort`/`customProviderPath`/`customContextWindow` expectations to `toBeUndefined()`. Add a
comment saying that the panel saves to the agent's config, so the session follows it instead of pinning a copy.
Keep the `customPath`/`customArgs`/`customEnvVars` expectations.

### H. Cursor version in the `PROVIDER-SUPPORT.md` heading (D4)

Keep `### Cursor CLI ✅ Implemented (beta, verified against Cursor CLI 2026.07.16-899851b)` as it stands
(`PROVIDER-SUPPORT.md:1374`). The doc body (:1376) and the capabilities comment (`capabilities.ts:522`) cite the same
version. The spec's `2026.08.11` appears nowhere in the repository, and no verification against it was recorded.
Writing it would claim a check that never happened. A6 below is corrected. Re-verifying against a newer Cursor build
is out of scope for this round.

### I. Advisories

**Taken:**

- **A1. The early supersession guard lets the old tail through on the 50 ms timer.** In `ExitHandler.ts:90-97`,
  before the `return`, drop the stale process's pending output. Add `discardDataBuffer(managedProcess)` to
  `DataBufferManager.ts`, beside `flushDataBuffer`, since that class owns the timer. It clears `dataBufferTimeout`
  and sets `dataBuffer` to `undefined` without emitting. The guard calls it. Test (`ExitHandler.test.ts` ~:1315,
  "should not emit stale output…"): arm a real timer on the exiting process, through `emitDataBuffered` or an
  equivalent `setTimeout` under `vi.useFakeTimers()`. Run the exit, advance 50 ms, and expect `dataEvents` to equal
  `[]` and `dataBufferTimeout` to be `undefined`. Probe: remove the call, and the test must fail. `rc` flushed the
  old tail (its assertion was `['old tail']`). This PR suppresses it on purpose: a superseded process's output does
  not belong in the re-spawned session. Say so in the PR comment.
- **A2. The throwing-parser path lost its only test.** Re-add `rc`'s case beside the rewritten one in
  `ExitHandler.test.ts` (~:621). Give it a parser whose `parseJsonLine` throws on the trailing no-newline line, and
  expect the raw line as one `data` event. Keep the PR's "cleanly declined, so suppressed" test too. Together the
  two pin the choked-versus-declined split from A4.2.
- **A3. No test pins `interruptedCursor`.** Add two tests to `StdoutHandler.test.ts` for a `cursor-cli` process
  with `interrupted: true`. In the first, an assistant delta arriving after Stop leaves `streamedText` unchanged
  (:779). In the second, a `result` arriving after Stop emits no result and leaves `resultEmitted` false (:919).
  Probe each test by removing its gate.
- **A5. The doc implies batch mode always passes `--force`.** `PROVIDER-SUPPORT.md:1381` becomes
  ``| Batch Mode | `-p` / `--print` with `--trust`; full access adds `--force` |``, re-padded to the table width.
  Drop `--force` from the two example invocations (:1409, :1412). Add one line under them saying that full-access
  mode appends `--force`.
- **A6. No `cursor-cli` row in the Step 3.5 table.** Add
  ``| `cursor-cli` | `--add-dir <dir>` (repeatable) | Workspace root (read+write) |`` after `copilot-cli`
  (`PROVIDER-SUPPORT.md:~516`), re-padding the columns. The grant wording comes from `definitions.ts:992`.
- **A8. An orphaned comment reads as `readOnlyMode`'s doc.** In `conversationManager.ts:651`, put a one-line
  comment above `readOnlyMode` that states its reason. Take the reason from commit `0e03d23d5`, which added the line.
  Leave `rc`'s orphaned stdin comment untouched, because it was already orphaned in `rc`.
- **A9. The Windows PATH lists disagree.** In `src/shared/pathUtils.ts:339`, add
  `path.join(localAppData, 'cursor-agent', 'versions')` after the `cursor-agent` line, matching the env dirs in
  `path-prober.ts`. Extend `src/__tests__/shared/pathUtils.test.ts` to assert both entries.
- **A11. The e2e headers say `bunx`.** Change `bunx vitest` to `npx vitest` in
  `src/__tests__/e2e/CursorCliProcessManager.e2e.test.ts:3` and `CursorCliSpawner.e2e.test.ts:3`.

**Deferred:**

- **A4 (identity-validator wiring tests).** Real coverage needs new tests across `checkBinaryExists`,
  `probeUnixPaths`, `probeWindowsPaths`, the detector's custom-path and `allPaths` filter, and the CLI mock. That is
  its own change. Name it in the PR comment as a follow-up.
- **A7 (no timeout on Cursor model discovery).** Every other agent's discovery uses the same bare-env style. A
  Cursor-only timeout is the kind of divergence the maintainer keeps flagging; the fix belongs in `rc`, across all
  agents.
- **A10 (`169273daa` does not typecheck alone).** Fixing it means rewriting pushed history on the PR branch. It
  only affects bisecting.

---

## Round 1 record (sections A-E, landed at `734c01911`)

Kept for reference; the Reviewer verified these against the diff. Two corrections from round 2 are marked
**[r2]** (A6 and E).

The maintainer will not approve the fork's CI run until the branch merges cleanly. They also left two review items
open: the `!managedProcess.interrupted` gate on the exit-time streamed-text fallback applied to every stream-json
agent, and `validateAgentBinaryIdentity` required two English `--help` strings. **This was a re-port, not a
merge-and-resolve:** `rc` moved most of the files this PR edits into `src/shared/maestro-lib/` (commit `9d861232f`),
and the old paths are now 5-line `export *` shims.

### A. The merge

#### A0. Mechanics

- Merge, don't rebase: `git merge origin/rc` on `pr1401-push`, message `Merge origin/rc into
  codex/cursor-cli-agent-rc`. Follow-up fixes go in separate commits.
- Shim files: for every path in the A1 table, the resolution is `rc`'s shim exactly. Put the PR's hunk in the
  maestro-lib file.

#### A1. Code moved into `src/shared/maestro-lib/`

| PR edits this path | Its content now lives in | PR content to re-apply there |
| --- | --- | --- |
| `src/main/agents/capabilities.ts` | `maestro-lib/providers/capabilities.ts` | The `cursor-cli` entry |
| `src/main/agents/definitions.ts` | `maestro-lib/providers/definitions.ts` | The `cursor-cli` definition |
| `src/main/agents/path-prober.ts` | `maestro-lib/launch/path-prober.ts` | Validator, env dirs, the `agent:` Windows and Unix tables, probe hooks |
| `src/main/parsers/index.ts`, `parser-factory.ts` | `maestro-lib/parsers/index.ts`, `parser-factory.ts` | Parser registration |
| `src/main/parsers/cursor-cli-output-parser.ts` | `maestro-lib/parsers/cursor-cli-output-parser.ts` | The whole file, with a one-line shim at the old path |
| `src/main/parsers/error-patterns.ts` | bank: `src/shared/agentErrorPatterns.ts` | `CURSOR_CLI_ERROR_PATTERNS`, once |
| `src/main/utils/agent-args.ts` | `maestro-lib/launch/agent-args.ts` | Cursor workspace and add-dir arg handling |

Library rule: nothing under `maestro-lib/` imports electron or `src/main/` (`no-desktop-framework.smoke.test.ts`).
Each `cursor-cli` entry is registered once, in maestro-lib only. Every PR mock points at the maestro-lib path.

#### A2. What `rc` requires of every agent

- A documented Cursor turn recording (`documented-cursor-cli-normal`) in
  `src/__tests__/main/process-manager/recordings/documented.ts`, built from shapes the parser tests already pin.
- `stdinPromptArgs`, `promptFileArgs` and `AgentLoginCommand.remoteArgs` stay unset for Cursor; the image prompt
  uses `rc`'s shared `plainPathImagePrompt`.
- The Cursor parser runs `stripJsonEventLines(stdout)` before exit-time error matching, with a test.

#### A3. CLI services

- Dropped: `findCommandInPath` and its CRLF test, `getExpandedPath`, `spawnLocalAgentProcess`, `finalizeAgentStdin`,
  the Cursor-only raw-stdin prompt path (`rc`'s `resolvePromptDelivery` covers it), and `buildSshEnvForRemote`.
- Re-applied in `spawnJsonLineAgent`: `permissionMode` (outranks `readOnlyMode`), Cursor's standard/full handling
  inside `resolveCliBatchModeArgs`, `--workspace <cwd>`, `readOnlyMode: effectiveReadOnly` into `planCliLaunch` (the
  `0d22cf35b` fix), and Cursor's non-zero-exit behavior through `answerOutranksBareExit`.
- `detectAgent` runs the identity check on the custom path and passes the validator to `checkBinaryExists`.
- Autorun puts `permissionMode: 'full'` on `case 'task'` and `case 'goal-iteration'` in `autorun-cli-deps.ts`, not
  on the synopsis turn.

#### A4. `ExitHandler.ts` / `StdoutHandler.ts`

Started from `rc`'s files. Kept `rc`'s `dd53d5574`, `5b7a39c97`, `30b1c8f51` and `689351603` / `160d0094b`
behaviors. Re-applied:

1. The non-consuming session-id peek, with the early supersession guard.
2. Trailing records parsed once in ExitHandler, which distinguishes a choked parser (surface the line raw) from one
   that declined (noise). Non-error events go through `StdoutHandler.handleParsedEvent` via `dispatchParsedEvent`,
   giving exactly one `parsed-event` per line.
3. `dispatchParsedEvent` wired at every `ExitHandler` construction site, as a required dependency.
4. The streamed-text fallback stays where `rc` has it.
5. StdoutHandler's public `handleParsedEvent(sessionId, managedProcess, event, outputParser)`, one hoisted parse,
   `interruptedCursor`, and the reasoning-tag union.

#### A5. Wizard

Every conflict is resolved as the union of both sides: `rc`'s `claudeTokenSource` / Maestro-P fields /
`codexTransport` next to the PR's `customPath` / `customArgs` / `customEnvVars` / `agentConfigValues`, with one
`sessionCustomModel` per spawn object (the planner model outranks `agentConfigValues.model`). G removes the
session-creation pins in `useWizardHandlers.ts`; the conversation-spawn fields stay.

#### A6. Docs **[r2]**

- `CLAUDE-AGENTS.md`: the `cursor-cli` row re-padded to `rc`'s width, between `omp` and `terminal`. Step 14
  (provider translation support) followed in the Cursor section.
- `CLAUDE.md`: the `cursor-cli` row between `copilot-cli` and `factory-droid`.
- `PROVIDER-SUPPORT.md`:
  - `### Cursor CLI` follows the Antigravity section, under `rc`'s status-suffix convention:
    `### Cursor CLI ✅ Implemented (beta, verified against Cursor CLI 2026.07.16-899851b)`. **[r2]** Round 1's spec
    said `2026.08.11`; that was wrong (see H).
  - The Provider Translation Contract statement: "unsupported" wherever this PR implements nothing.
  - The identity-validation paragraph matches C.
  - **[r2]** Round 1's "keep the PR's `--add-dir` row in the Step 3.5 table" assumed a row that never existed.
    I-A6 adds it.

#### A7. Sweeps

`git diff --check` and the conflict-marker grep come back empty. `git grep -n "'cursor-cli'" -- src/shared/maestro-lib`
shows one entry per registry. The dropped helpers return nothing outside comments.

### B. Interrupt gate limited to Cursor (review §2, option a)

The exit-time fallback is gated by `!(managedProcess.toolType === 'cursor-cli' && managedProcess.interrupted)`;
`!errorEmitted` stays broad. A factory-droid test pins that other agents' interrupted text is still flushed.

### C. `validateAgentBinaryIdentity` relaxed to one token

It matches `CURSOR_API_KEY` alone, and its doc comment and match-site comment say the match depends on the Cursor
version. Four tests in `path-prober.test.ts` pin it.


---

## Verify (scoped, local)

The handoff copies this block **verbatim**. Run every line, even after a failure, and report each line's exit code.
Do not chain the lines with `&&`: in round 1 a failure in the first step hid every result after it.

Round 4 adds no line. W's tests are all in line 5: `src/__tests__/renderer/components/Wizard/` holds the
`wizardErrorDetection`, `conversationManager` and `phaseGenerator_ssh` tests, and line 5b holds the inline wizard
service tests. Line 1's third typecheck (`tsconfig.lint.json`) covers `src/renderer`. Line 8 lints and formats the
touched source files.

```bash
# 0. Precondition: every dependency in package.json is installed (catches a node_modules older than the merge)
node -e 'const p=require("./package.json"),fs=require("fs");const m=Object.keys({...p.dependencies,...p.devDependencies}).filter(d=>!fs.existsSync("node_modules/"+d));if(m.length){console.error("missing from node_modules: "+m.join(", ")+" (run npm ci)");process.exit(1)}'

# 1. Typecheck: the TS1117 duplicate-key check; also catches missed dispatchParsedEvent wiring
npx tsc -p tsconfig.main.json --noEmit
npx tsc -p tsconfig.cli.json --noEmit
npx tsc -p tsconfig.lint.json

# 2. Process manager: handlers (F, I-A1, I-A2, I-A3), the turn recordings, the parsed-event and factory-droid tests
npx vitest run src/__tests__/main/process-manager/

# 3. Agents, parsers (F; round 3: J, K in error-patterns.test.ts and cursor-cli-output-parser.test.ts), launch layer
npx vitest run src/__tests__/main/agents/ src/__tests__/main/parsers/ src/__tests__/main/utils/agent-args.test.ts
npx vitest run src/__tests__/shared/maestro-lib/launch/ src/shared/maestro-lib/__tests__/no-desktop-framework.smoke.test.ts

# 4. CLI services, including turn-recordings.cli.test.ts, which runs Cursor through spawnAgent
npx vitest run src/__tests__/cli/services/

# 5. Wizard (G; round 4: W in wizardErrorDetection, conversationManager and phaseGenerator_ssh tests) and the inline wizard (W)
npx vitest run src/__tests__/renderer/components/Wizard/ src/__tests__/renderer/hooks/useWizardHandlers.test.ts src/__tests__/renderer/hooks/useInlineWizard.test.ts
npx vitest run src/__tests__/renderer/services/inlineWizardConversation.test.ts src/__tests__/renderer/services/inlineWizardConversation_overrides.test.ts src/__tests__/renderer/services/inlineWizardDocumentGeneration.test.ts src/__tests__/renderer/services/inlineWizardDocumentGeneration_overrides.test.ts src/__tests__/renderer/services/inlineWizardDocumentGeneration_ssh.test.ts

# 6. Other touched test files (I-A9 and the agent icon)
npx vitest run src/__tests__/shared/pathUtils.test.ts src/__tests__/renderer/constants/agentIcons.test.ts

# 7. Docs (I-A5, I-A6, M)
node scripts/verify-docs-paths.mjs
node scripts/check-doc-refs.mjs

# 8. Formatting and lint on files this PR touches (two-dot against the rc tip merged in; deleted files excluded;
#    eslint skips src/__tests__/, which the repo's eslint config ignores)
npx prettier --check $(git diff --name-only --diff-filter=d b07f0755f HEAD -- '*.ts' '*.tsx' '*.md')
npx eslint $(git diff --name-only --diff-filter=d b07f0755f HEAD -- 'src/**/*.ts' 'src/**/*.tsx' ':!src/__tests__/**')

# 9. The Cursor e2e files still load (L). Forced off, so this never starts Cursor; expect 2 files and 6 tests skipped
RUN_INTEGRATION_TESTS=false npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/CursorCliSpawner.e2e.test.ts src/__tests__/e2e/CursorCliProcessManager.e2e.test.ts
```

Use npm, not pnpm: under pnpm the typecheck reports phantom `TS2307` errors. `npm ci`'s `postinstall` fails on this
Mac (clang 12) but leaves a usable tree. Line 0 is how to tell the two apart: after `npm ci`, line 0 must pass even
if `postinstall` printed errors.

Line 9 only checks that the Cursor e2e files load; no tsconfig includes `src/__tests__/e2e/`.

### Live check (opt-in: needs "autorizo", not a gate; N8)

```bash
RUN_INTEGRATION_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/CursorCliSpawner.e2e.test.ts src/__tests__/e2e/CursorCliProcessManager.e2e.test.ts
```

It needs a logged-in Cursor. Expect 6 of 6 on this Mac's Free plan with a named default. It is the first live run of
plan mode with `--model auto` (R3-5). Run it from the worktree, and confirm `git status --short` is empty afterwards.

### Handoff file

`/handoff` writes `tmp/handoff/PR-1401.json` (gitignored). This time:

- `verify`: the Verify block above, verbatim, as one newline-separated string. Not joined with `&&`.
- `filesToTouch`: the ten paths listed under "Round 4".
- `constraints`: npm, never pnpm; no `.gitignore` edit; W touches only the four wizard paths and their helper, and
  every branch that does not end in a generic message is unchanged; untrack the spec before pushing; fast-forward
  push only, never force; one bundled "autorizo" and no routing around the trava hook; no full `npm test`,
  `npm run lint` or repo-wide prettier as a gate.

## CI owns

The Reviewer reads these from `gh pr checks 1401 -R RunMaestro/Maestro`. Do not block on a missing local run.

- `lint-and-format`
- `Test (ubuntu-latest, shard 1/2)`, `Test (ubuntu-latest, shard 2/2)`
- `Test (windows-latest, shard 1/2)`, `Test (windows-latest, shard 2/2)`: the Windows jobs are the ones that matter
  for the path-prober and `pathUtils` install paths.

These are the jobs this repo's `ci.yml` defines. As of round 3 (head `dfad6fa1f`), **none of them has ever run on
this PR**. The fork run is `action_required`, waiting for a maintainer, so `gh pr checks` shows only CodeRabbit and
`mergeStateStatus` is `UNSTABLE`. That is expected, and it is not a finding against this lane. It does mean the
Reviewer cannot PASS on CI; the verdict rests on the local gates above until the maintainer approves the run.

## Out of scope

- CodeRabbit's "bare Windows command needs a shell" finding: declined in round 2 of the PR, tracked in #1608.
- CodeRabbit's docstring-coverage warning: not a merge gate.
- Windows prompt length on the CLI surface: `rc`'s shared prompt-delivery contract, not specific to Cursor.
- A full re-verification of every fact in the Cursor doc section against Cursor 2026.10.16.
- Advisories A4, A7 and A10 (round-2 record, I); N4, N9, N10 and N11 (dropped in round 3).
- A second `rc` merge for N4 (R3-8).
- Reproducing D6 in a live turn: it would mean logging this Mac out of Cursor.
- The wizard items listed under "Out of scope for W".

## Assumptions

**Round 4:**

- **R4-1. R3-3 was wrong about the wizard.** It said the wizard shows K's message with its generic hint. The wizard
  never received the message (D8). W makes that true, and the round-4 PR comment corrects round 3's.
- **R4-2. Fixed here, against the Reviewer's recommendation to split it out.** The user chose this. To keep it
  close to "add a Cursor agent": W changes only the branches that end in a generic message, uses the error the
  main process already computed, and adds no new IPC, setting or UI component. The PR comment says that it helps
  every agent.
- **R4-3. The captured error ranks below the wizard's own output check.** A pattern match on the output and a
  parseable reply on a non-zero exit keep their current behavior. In conversationManager, the captured error ranks
  above `createGenericErrorMessage`, whose `error[:\s]+` extraction can pick words out of an ordinary reply.
- **R4-4. The phaseGenerator test goes in `phaseGenerator_ssh.test.ts`**, in its own `describe`. That file already
  mocks spawn, exit, the folder watcher and the prompt loader that `generateDocuments` needs. `phaseGenerator.test.ts`
  tests only pure functions and has no `window.maestro` mock to extend.
- **R4-5. The latest captured error wins.** Main sends at most one `agent-error` per process (`errorEmitted`). If a
  spawn is retried under the same session id, the last failure is the one that ended the turn.
- **R4-6. The string-only paths use `formatWizardError`.** They have no error panel, so the title and hint travel in
  the string. Their displays collapse the blank line between message and hint; restyling is out of scope.
- **R4-7. Line numbers are as of `dfad6fa1f`.** Resolve each against the anchor named next to it.
- **R4-8. The spec keeps its file name** (`pr1401-rc-sync-round3.md`). The Reviewer and the handoff file already
  point at it; renaming it every round would break those references.

**Round 3:**

- **R3-1. Scope of "fix everything".** Every round-2 finding marked "fix here" is fixed (D6, D7, N1, N2, N3). The
  cheap ones the Reviewer would have dropped are taken too, because each costs a line (N5, N6, N7). D1 belongs to
  the maintainer. N4, A4, A7 and A10 stay out, for the reasons in R3-8 and the round-2 record (I).
- **R3-2. D6 adds `authentication (?:failed|required)`, not a bare `required`.** A bare `required` would catch
  unrelated text ("a restart is required"). The pattern runs only on stderr, on plain-text stdout lines, and on
  failed `result` text, never on the agent's answer inside stream-json events, so the phrase is safe there.
- **R3-3. D7 is `agent_crashed`.** It sits beside the existing Cursor "model is not available" entry, and the error
  card titles it "Agent Error" with the message as the explanation. `rate_limited` would tell the user to wait,
  which never helps. `auth_expired` would send them to sign in again, which changes nothing. `permission_denied`
  reads as folder permissions in the wizard (`wizardErrorDetection.ts:59`). The wizard adds its generic
  `agent_crashed` hint ("Try again…") under the message, as it already does for the existing model entry.
- **R3-4. The D7 fixture is the truncated 100-character line**, because that is all the log kept. The test must not
  invent the rest. The split-chunk case is tested separately.
- **R3-5. N1 pins `auto` through `buildBatchArgs`**, so the plan-mode turn gets it too. That turn passed with the
  named default in round 2 and has never run with `auto`; the Reviewer's copies ran only the two failing tests. If
  the live check shows plan mode rejecting `--model auto`, pin `auto` on the stream-json turn only, and report it.
- **R3-6. N2 gives 300 s to the resume test only.** Two turns of up to ~80 s each, plus spawn time; the Reviewer's
  copy passed in 138.5 s with 300 s. The single-turn tests keep 120 s.
- **R3-7. M adds a sentence instead of changing the heading's version.** The 2026.10.16 run covered detection, both
  spawn paths, plan mode and resume, not every fact in the section. Moving the heading to 2026.10.16 would claim a
  check that did not happen, which is the same reasoning as H in round 2.
- **R3-8. No second `rc` merge (N4).** `rc`'s 3 new commits touch 5 files, none in this PR, and GitHub still
  reports `MERGEABLE`. A merge commit every time `rc` moves adds noise without unblocking anything. E3 re-checks
  before the comment goes out.
- **R3-9. The Planner does not write the handoff file.** `/handoff` writes it; this spec gives the values to copy
  ("Handoff file").
- **R3-10. Committing this spec needs "autorizo".** The trava hook blocks `git add` and `git commit` in this repo.
  The Planner asks for it before printing the WORKTREE block. E2 untracks the spec again before the push.

**Carried from rounds 1 and 2:**

1. **Merge, not rebase** (round 1). The maintainer accepts either; a merge resolves each conflict once.
2. **Option (a) for the interrupt gate** (round 1). It limits the change to the agent that motivated it.
3. **The identity check matches `CURSOR_API_KEY` only** (round 1). The binary installs as `agent`, so the path is not
   a reliable signal.
4. **Cursor drops its raw-stdin prompt path** (round 1) and uses `rc`'s shared `resolvePromptDelivery`.
5. **`codexTransport` is not reset on `SET_SELECTED_AGENT`** (round 1). `rc` reads it only for Codex.
6. **B1 was environmental** (round 2). The fix was `npm ci`; line 0 guards against a repeat.
7. **D2: keep the text on a failed mid-stream `result`** (round 2), through the optional `isFailedResultMessage?`
   parser hook.
8. **D5: no pinning at all** (round 2). The panel already writes every change to the agent's config.
9. **D4: the heading version stands** (round 2); see R3-7.
10. **I-A1 drops the superseded tail** (round 2) instead of restoring `rc`'s flush. The round-2 PR comment said so.
11. **Line numbers are as of `9ab349d58`** for J-M, and as of `734c01911` in the round-2 record. Resolve each
    against the anchor named next to it (function, field, test name).
12. **Branch name.** The worktree already exists on `pr1401-push`, not `feature/<slug>`. Per the planning protocol,
    it is reused rather than duplicated.
13. **No brief.** `docs/briefs/` does not exist in this repo.
14. **`/skills/spec/SKILL.md` does not exist on this machine.** This spec follows the run's overrides directly.
15. **The spec lives on disk, untracked, by design.** `docs/specs/` is gitignored (`.gitignore:9`), so committing it
    takes `git add -f`, and E2 untracks it before the push so the PR's net diff stays clean.


## PR title

feat(agents): add Cursor CLI as a first-class beta agent
