# PR #1401: merge current `rc`, limit the interrupt gate to Cursor, loosen the Cursor identity check

- **Ticket:** PR-1401, answering the maintainer review of 2026-10-18
  (https://github.com/RunMaestro/Maestro/pull/1401, comment by `pedramamini`)
- **Worktree:** `maestro-pr1401/.claude/worktrees/pr1401-cursor-cli-agent`
- **Branch under change:** `pr1401-push` @ `9ab349d58`. It is pushed to `fork/codex/cursor-cli-agent-rc`, the PR head
  (local HEAD = PR `headRefOid`).
- **`rc` merged in:** `b07f0755f` (merge `dd79bb814`). `origin/rc` has since moved to `6400a6da0`; see N4.
- **Spec round:** 3. This revision answers the round-2 Reviewer DISCUSS
  (`/tmp/qa-reports/2026-10-19-pr1401-cursor-cli-rc-sync-r2.md`). Round 2 raised no [blocking] finding.

## Round 3: what this revision changes

Round 2 landed F, G and I. The Reviewer re-ran the red probes for F and I-A1 and found every round-1 code finding
fixed. This round closes what the review left open:

| Finding | Label | Resolution | Section |
| --- | --- | --- | --- |
| D1. No CI on `9ab349d58` | discuss | Waits on the maintainer. The PR comment asks again, naming the exact jobs | E, CI owns |
| D6. Cursor's "Authentication required" message shows as a crash | discuss | **Fix.** Add `authentication required` to the first Cursor `auth_expired` pattern | J |
| D7. Cursor's Free-plan model error shows as a crash | discuss | **Fix.** A new Cursor pattern whose message says to switch to `auto` or upgrade | K |
| N1. Two live e2e turns use Cursor's default model | advisory | **Fix.** Pin `auto` on every live turn | L |
| N2. The resume e2e test fits two turns into 120 s | advisory | **Fix.** Give it its own 300 s budget | L |
| N3. The handoff file still carries round 1's verify | advisory | **Fix.** The handoff copies the Verify block verbatim; the values are under "Handoff file" | Verify |
| N5. The doc cites only Cursor 2026.07.16 | advisory | **Take.** One sentence records the 2026.10.16 live check; the heading stays | M |
| N6. The PR comment's job names are wrong | advisory | **Take.** This round's comment uses the exact names | E |
| N7. Line 8's eslint passes test files the config ignores | advisory | **Take.** Exclude `src/__tests__/**` from that line | Verify |
| N4. `rc` moved 3 commits | advisory | No re-merge: no file overlaps, and the PR is still `MERGEABLE`. E3 re-checks | E |
| A4, A7, A10 | advisory | Stay deferred, for the reasons in the round-2 record (I) | - |

Order: J and K together (both edit the Cursor pattern bank), L and M in any order, then Verify, then E.

Files this round (6): `src/shared/agentErrorPatterns.ts`, `src/__tests__/main/parsers/cursor-cli-output-parser.test.ts`,
`src/__tests__/main/parsers/error-patterns.test.ts`, `src/__tests__/e2e/CursorCliSpawner.e2e.test.ts`,
`src/__tests__/e2e/CursorCliProcessManager.e2e.test.ts`, `PROVIDER-SUPPORT.md`.

---

## J. Treat Cursor's "Authentication required" message as a sign-in error (D6)

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

## K. Explain Cursor's Free-plan model error instead of reporting a crash (D7)

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

## L. Make the live Cursor e2e tests independent of the account's plan (N1, N2)

These tests run only with `RUN_INTEGRATION_TESTS=true` and a logged-in Cursor. CI skips them.

- **N1, `CursorCliProcessManager.e2e.test.ts`:** in `buildBatchArgs`, pass `modelId: 'auto'` to `buildAgentArgs`.
  Both ProcessManager turns then carry `--model auto`, the plan-mode turn included.
- **N1, `CursorCliSpawner.e2e.test.ts`, "resumes a real chat by session id":** pass `{ customModel: 'auto' }` to both
  `spawnAgent` calls (with `undefined` as the first call's session id), as "spawns a real headless turn" already does.
- **N2, same file:** add `const RESUME_TIMEOUT = 300_000;` with a one-line comment (two live turns in a row; one
  turn took 65-80 s in round 2). Use it for the resume test only; the other tests keep `TIMEOUT`.

These are the edits in the Reviewer's passing copies (`/tmp/qa-r2/e2e-auto/` on this Mac), minus their absolute
import paths.

## M. Docs: the Free-plan limit and the live re-check (N5)

In `PROVIDER-SUPPORT.md`, Cursor CLI section:

- Keep the heading (`:1375`) and the `capabilities.ts:522` comment on `2026.07.16-899851b`.
- After the **Status:** paragraph (`:1377`), add one sentence: "Re-checked live on Cursor CLI `2026.10.16-e3cb207`
  during the PR's round-2 review: detection, headless turns through the CLI and desktop spawn paths, plan mode, and
  resume."
- In the table, the Model Selection value gains "; Free plans accept only `auto`". Run `npx prettier --write
  PROVIDER-SUPPORT.md` so the table re-pads; the file is otherwise prettier-clean, so nothing else moves.

## E. Push and reply (round 3)

This replaces round 2's E.

1. Commit each section on its own, in Conventional Commits form:
   - J: `fix(cursor-cli): treat Cursor's "Authentication required" message as a sign-in error`
   - K: `fix(cursor-cli): explain Cursor's Free-plan model error instead of reporting a crash`
   - L: `test(cursor-cli): pin the auto model in live e2e turns and give resume its own budget`
   - M: `docs(cursor-cli): note the Free-plan model limit and the 2026.10.16 live check`
2. If this spec is tracked (the Planner's `docs(spec): PR-1401` commit), untrack it in its own commit before
   pushing: `git rm --cached docs/specs/pr1401-rc-sync-round3.md`, message
   `chore(spec): untrack the PR-1401 round 3 spec`, as `734c01911` did. The file stays on disk, and the PR's net diff
   never contains it.
3. Push: `git push fork pr1401-push:codex/cursor-cli-agent-rc`, a fast-forward, no force. Then run
   `gh pr view 1401 -R RunMaestro/Maestro --json mergeable,mergeStateStatus`. Expect `MERGEABLE`, and `UNSTABLE`
   while CI waits for approval. If it says `CONFLICTING`, stop and report: a second `rc` merge is a round of its own.
4. Post one PR comment covering:
   - **J and K:** the two Cursor messages, what the user sees now, and the tests.
   - **L:** the live e2e tests now pass `auto`, so a Free plan no longer fails them, and resume has 300 s. Give the
     live result if step 5 ran.
   - **Gates:** the Verify lines run locally, with their exit codes.
   - **CI (N6):** ask again for approval of the fork workflow run, naming `lint-and-format`,
     `Test (ubuntu-latest, shard 1/2)`, `Test (ubuntu-latest, shard 2/2)`, `Test (windows-latest, shard 1/2)` and
     `Test (windows-latest, shard 2/2)`.
5. Optional, not a gate: the live check under Verify. It sends five short prompts to Cursor under the user's account
   and takes about 7 minutes.

**Ask for one "autorizo" for the whole set** (`~/.claude/rules/autorizacao.md`): the four commits, the untrack
commit, the push, the PR comment, and the live check if wanted (it sends prompts to an external service). List the
branch, remote, commit messages and comment text, then stop and wait. Do not route around the trava hook. It also
blocks read-only commands whose name contains `merge`, such as `git merge-base`.

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

Round 1's section E (push and reply) is superseded by E above.

---

## Verify (scoped, local)

The handoff copies this block **verbatim**. Run every line, even after a failure, and report each line's exit code.
Do not chain the lines with `&&`: in round 1 a failure in the first step hid every result after it.

Round 3's new tests are in line 3 (`src/__tests__/main/parsers/`). Line 5 also covers the wizard's error detection,
which reads the same Cursor pattern bank. Line 8's eslint now skips `src/__tests__/` (N7). Line 9 is new.

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

# 5. Wizard (G), the inline wizard, and wizardErrorDetection.test.ts, which reads the Cursor bank (J, K)
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

Line 9 is the only local check the e2e files get: no tsconfig includes `src/__tests__/e2e/`. It catches a syntax or
import error, not a type error. The two options L uses are typed: `customModel` at `agent-spawner.ts:1606` and
`modelId` at `maestro-lib/launch/agent-args.ts:19`. Line 9 exits 0 on `9ab349d58` (checked while planning).

### Live check (opt-in: needs "autorizo", not a gate)

```bash
RUN_INTEGRATION_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/CursorCliSpawner.e2e.test.ts src/__tests__/e2e/CursorCliProcessManager.e2e.test.ts
```

It needs a logged-in Cursor. Expect 6 of 6 on this Mac's Free plan with a named default; round 2 got 4 of 6 before
L. Run it from the worktree and confirm `git status --short` is empty afterwards.

### Handoff file (N3)

`/handoff` writes `tmp/handoff/PR-1401.json` (gitignored). Round 2's handoff kept round 1's values. This time:

- `verify`: the Verify block above, verbatim, as one newline-separated string. Not joined with `&&`.
- `filesToTouch`: the six files listed under "Round 3".
- `constraints`: drop the merge and re-port constraints, which round 1 completed. Keep: npm, never pnpm; no
  `.gitignore` edit; untrack the spec before pushing; fast-forward push only, never force; one bundled "autorizo" and
  no routing around the trava hook; no full `npm test`, `npm run lint` or repo-wide prettier as a gate.

## CI owns

The Reviewer reads these from `gh pr checks 1401 -R RunMaestro/Maestro`. Do not block on a missing local run.

- `lint-and-format`
- `Test (ubuntu-latest, shard 1/2)`, `Test (ubuntu-latest, shard 2/2)`
- `Test (windows-latest, shard 1/2)`, `Test (windows-latest, shard 2/2)`: the Windows jobs are the ones that matter
  for the path-prober and `pathUtils` install paths.

These are the jobs this repo's `ci.yml` defines. As of round 2 (head `9ab349d58`), **none of them has ever run on
this PR**. The fork run is `action_required`, waiting for a maintainer, so `gh pr checks` shows only CodeRabbit and
`mergeStateStatus` is `UNSTABLE`. That is expected, and it is not a finding against this lane. It does mean the
Reviewer cannot PASS on CI; the verdict rests on the local gates above until the maintainer approves the run.

## Out of scope

- CodeRabbit's "bare Windows command needs a shell" finding: declined in round 2 of the PR, tracked in #1608.
- CodeRabbit's docstring-coverage warning: not a merge gate.
- Windows prompt length on the CLI surface: `rc`'s shared prompt-delivery contract, not specific to Cursor.
- A full re-verification of every fact in the Cursor doc section against Cursor 2026.10.16 (M records only what the
  round-2 live run covered).
- Advisories A4, A7 and A10 (see the round-2 record, I).
- A second `rc` merge for N4 (see R3-8).
- Reproducing D6 in a live turn: it would mean logging this Mac out of Cursor.

## Assumptions

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
