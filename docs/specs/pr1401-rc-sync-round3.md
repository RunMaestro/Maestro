# PR #1401: merge current `rc`, limit the interrupt gate to Cursor, loosen the Cursor identity check

- **Ticket:** PR-1401, answering the maintainer review of 2026-10-18
  (https://github.com/RunMaestro/Maestro/pull/1401, comment by `pedramamini`)
- **Worktree:** `maestro-pr1401/.claude/worktrees/pr1401-cursor-cli-agent`
- **Branch under change:** `pr1401-push` @ `c957177a8`. It is pushed to `fork/codex/cursor-cli-agent-rc`, the PR head.
- **Merge target:** `origin/rc` @ `a6d596651` (fetched 2026-10-18). This tip is 1,395 commits ahead of
  the PR. The merge base is `4f24ea7c8`, the `rc` commit that round 2 merged in.

## Problem

The maintainer will not approve the fork's CI run until the branch merges cleanly. They also left two
review items open:

1. **Merge conflicts (blocking).** The maintainer's trial merge conflicts in 21 files. 43 files changed on
   both sides since `4f24ea7c8`. The maintainer asked for a careful pass on the exit and stdout handlers,
   and for a repeat of the round-2 duplicate-key check.
2. **The `!managedProcess.interrupted` gate on the exit-time streamed-text fallback.** It applies to every
   stream-json agent, but its only test covers Cursor.
3. **`validateAgentBinaryIdentity`** still requires two English `--help` strings. Its doc comment
   calls the help output a "stable help contract", which is the opposite of the risk.

CI (item 3 of the review) unblocks itself: the maintainer approves the workflow run once the branch is
clean.

**This is a re-port, not a merge-and-resolve.** `rc` moved most of the files this PR edits into
`src/shared/maestro-lib/` (commit `9d861232f`). The old paths are now 5-line `export *` shims, so
"keep both" inside a shim file puts the code in the wrong place. Section A1 lists every move.

## Work items

| # | What | Source | Section |
| --- | --- | --- | --- |
| A | Merge `origin/rc` and move the PR's code onto the new layout | Review §1 | A0-A7 |
| B | Limit the streamed-text interrupt gate to `cursor-cli`, and pin the non-Cursor case | Review §2, option (a) | B |
| C | Relax `validateAgentBinaryIdentity` to one token, and mark the match as version-coupled | Review §2 | C |
| D | Bring the three agent docs in line with `rc`'s new conventions | Fallout from the merge | A6 |
| E | Push, then answer the review on the PR | Review §1, §3 | E |

Order: A, then B and C (they edit code A just moved), then E. D is part of A.

---

## A. The merge

### A0. Mechanics

- **Merge, don't rebase.** Run `git merge origin/rc` on `pr1401-push`. The maintainer accepts a merge,
  and rebasing 13 commits (2 of them merge commits) over 1,395 commits replays the same conflicts
  many times.
- **Fetch first.** If `origin/rc` moved past `a6d596651`, merge the new tip. Re-run the overlap check
  `git diff --name-only 4f24ea7c8 HEAD` against `git diff --name-only 4f24ea7c8 origin/rc` to catch
  newly overlapping files.
- **Commit message:** `Merge origin/rc into codex/cursor-cli-agent-rc`, the same message rounds 1 and
  2 used. Put follow-up fixes (B, C, test rewiring) in separate commits after the merge, so the merge
  commit holds only conflict resolution.
- **Shim files:** for every path in the A1 table, the resolution is `rc`'s shim exactly. Put the PR's
  hunk in the maestro-lib file.

### A1. Code moved into `src/shared/maestro-lib/`

| PR edits this path | Its content now lives in | PR content to re-apply there |
| --- | --- | --- |
| `src/main/agents/capabilities.ts` | `maestro-lib/providers/capabilities.ts` | The `cursor-cli` entry, before the closing `};` (rc ~:518) |
| `src/main/agents/definitions.ts` | `maestro-lib/providers/definitions.ts` | The `cursor-cli` definition, before `];` (rc ~:970) |
| `src/main/agents/path-prober.ts` | `maestro-lib/launch/path-prober.ts` | Validator, env dirs, the `agent:` Windows and Unix tables, probe hooks (see below) |
| `src/main/parsers/index.ts`, `parser-factory.ts` | `maestro-lib/parsers/index.ts`, `parser-factory.ts` | Parser registration (rc :65, :83, :105; :24, :36) |
| `src/main/parsers/cursor-cli-output-parser.ts` (new file in the PR) | `maestro-lib/parsers/cursor-cli-output-parser.ts` | Move the whole file, import from `'../../types'`, and leave a one-line shim at the old path like `rc`'s grok shim |
| `src/main/parsers/error-patterns.ts` | `maestro-lib/parsers/…` (bank: `src/shared/agentErrorPatterns.ts`) | `CURSOR_CLI_ERROR_PATTERNS`, once |
| `src/main/utils/agent-args.ts` | `maestro-lib/launch/agent-args.ts` | Cursor workspace and add-dir arg handling |

**path-prober anchors in `rc`'s file:**

- Validator: before :94.
- Windows env dirs `%LOCALAPPDATA%\cursor-agent` and `\versions`: after :132.
- Unix env dirs `~/.cursor/bin` and `~/.local/share/cursor-agent`: after :177.
- Windows `agent:` paths: before `gh:` at :441.
- Unix `agent:` paths: before `gh:` at :614.
- Validator calls: `probeWindowsPaths` :466, `probeUnixPaths` :637, `checkBinaryExists` :684, `findAllBinaryPaths` :801.
- Imports: `execFileNoThrow` comes from `'./exec-file'` and `logger` from `'../host'`.
- Keep `rc`'s rename of the copilot key from `'copilot-cli'` to `copilot` (:393, :564).

**Library rule:** nothing under `maestro-lib/` may import electron or `src/main/`. The
`no-desktop-framework.smoke.test.ts` suite enforces this.

**Tests:** point every PR mock at the maestro-lib path. `rc`'s spawner imports
`shared/maestro-lib/launch/path-prober` directly, so a mock of the old `main/agents` path catches
nothing. `rc`'s `detector.test` mocks `maestro-lib/launch/exec-file`.

**Single registration:** each `cursor-cli` entry goes in once, in maestro-lib only. That applies to
`AGENT_CAPABILITIES`, `PARSER_CONSTRUCTORS`, the `agent:` known-path tables and the error bank.

### A2. What `rc` now requires of every agent

- **Turn recordings (this test fails if skipped).** `turn-recordings.test.ts:499-507` needs a documented
  recording for every pickable agent with a parser, except claude-code, opencode and hermes.
  - Add `documented-cursor-cli-normal` to `DOCUMENTED_RECORDINGS`, and its session id to
    `DOCUMENTED_SESSION_IDS`. Both are in `src/__tests__/main/process-manager/recordings/documented.ts`.
  - Build the chunks from the Cursor stream-json shapes the PR's parser tests already pin (`system`
    init, `assistant` partials, `result` with usage). Do not invent new shapes. Give it a header
    comment naming its source, as the other recordings have.
  - `turn-recordings.cli.test.ts:239-249` derives a CLI test from this recording automatically, so it
    also runs Cursor through `spawnAgent`.
- **New optional definition fields.** Leave `stdinPromptArgs`, `promptFileArgs` and
  `AgentLoginCommand.remoteArgs` unset for Cursor. If the PR's inline `imagePromptBuilder` matches
  `rc`'s `plainPathImagePrompt` (definitions ~:175), use the shared helper instead.
- **Parser exit-time error matching.** Since `36a3358a0`, every other `rc` parser runs
  `stripJsonEventLines(stdout)` before matching errors at exit. Do the same in the Cursor parser (PR
  HEAD :390). Add a parser test: a JSON event line containing an error-pattern word must not match.
- **Unchanged on `rc`:**
  - The parser count stays at 11.
  - The `AgentCapabilities` interface added no flags.
  - The three total `Record<AgentId>` registries in `agentMetadata.ts` already contain `cursor-cli`.

### A3. CLI services (`agent-spawner.ts`, `batch-processor.ts`, `goal-runner.ts`)

`rc` rebuilt this layer. Take `rc`'s file for each, then re-apply the PR's intent at the new seams.

**Drop. `rc` removed these or covers them centrally:**

- `findCommandInPath` and its CRLF fix (PR `02e207905`). `rc`'s `detectAgent` (:527-560) uses
  `checkBinaryExists`, which already splits on `/\r?\n/`. Delete the PR's `where` CRLF test, because it
  asserts a spawn that no longer happens.
- `getExpandedPath`, `spawnLocalAgentProcess` and `finalizeAgentStdin`.
  `maestro-lib/run/start-turn.ts:55-80` already promotes `.cmd` shims to a shell with escaping.
- **The Cursor-only raw-stdin prompt path (`useRawLocalStdin`).** `rc`'s `resolvePromptDelivery`
  (`maestro-lib/launch/prompt-delivery.ts`) now sends the prompt over stdin on Windows hosts for any
  agent that declares `supportsPromptViaStdin`. Cursor already declares it as `true`. Cursor follows
  that shared contract like every other agent, with no special case.
- `buildSshEnvForRemote`. The PR's `effectiveReadOnly` fix (`0d22cf35b`) moves: see the next list.

**Re-apply in `spawnJsonLineAgent` (rc :1175):**

1. Add a `permissionMode` parameter between `readOnlyMode` and `sshRemoteConfig` (rc :1179-1180).
   Compute `effectiveReadOnly` before rc :1203, where an explicit `permissionMode` outranks
   `readOnlyMode`.
2. Fold Cursor's standard/full handling and the `--force` append into `resolveCliBatchModeArgs`
   (rc :1151-1165) instead of adding a second branch.
3. Insert Cursor's `workingDirArgs` (`--workspace <cwd>`) before the add-dir line (rc :1214).
   `rc` moved add-dir ahead of resume.
4. Pass `effectiveReadOnly` to `resolveAgentOverrides` (rc :1222-1228).
5. **The `0d22cf35b` fix, at its new home:** pass `readOnlyMode: effectiveReadOnly` into
   `planCliLaunch` (rc :1282). `buildAgentLaunchPlan` applies `readOnlyEnvOverrides` to both local
   and remote env (`launch-plan.ts:199`), and the remote wrapper reads `plan.envVars` (rc :1321).
   Keep the PR's two SSH regression tests, retargeted to assert on the plan env.
6. Express the PR's non-zero-exit behavior for Cursor ("keep unclassified streamed output") through
   `rc`'s `answerOutranksBareExit` knob (rc :1523, `turn-result.ts:69`, `:148`), not a parallel
   branch. The PR's existing Cursor non-zero-exit tests decide the value.
7. Add `permissionMode` to `SpawnAgentOptions` (rc :1535). Pass it in `spawnAgentOnce` (rc :1653; call
   at :1700-1708). `spawnAgent`'s retry spreads its options, so the field carries through.

**`detectAgent`:** add the identity check to the custom-path branch (rc :537-547), and pass the
validator to `checkBinaryExists` (rc :553).

**Autorun:** `batch-processor.ts` and `goal-runner.ts` are now thin adapters. The spawn happens in
`src/cli/services/autorun-cli-deps.ts:82`. Put the PR's `permissionMode: 'full'` in two places:
`case 'task'` (rc :98-116, options at :108) and `case 'goal-iteration'` (rc :128-138, :137). Do not
put it in `autoRunTurnOptions` (:37), because the synopsis turn uses that and stays read-only.

**Duplicate-key trap:** in `agent-spawner.test.ts`, `rc`'s path-prober mock factory (:72-75) already
returns `checkBinaryExists`. Keep `rc`'s key and add only `validateAgentBinaryIdentity`. Two
`checkBinaryExists` keys is TS1117.

**Test setup that may break again:** `cursor-cli` is the one agent whose detection runs the binary. In
round 2 that made the probe the first observed spawn in the CLI tests, and 8 tests went red. If that
recurs, apply round 2's fix again: mock the two probing functions, and give the affected tests the
extra tick their neighbours have.

### A4. `ExitHandler.ts` / `StdoutHandler.ts`: the careful pass

Start from `rc`'s version of both files and re-apply the PR's intent. Losing any of these `rc`
behaviors is a regression:

| `rc` commit | Behavior to keep | What dropping it breaks |
| --- | --- | --- |
| `dd53d5574` | The trailing flush detects errors on every envelope (`flushedError`, rc :209-213), not just `type === 'error'` | A failed Claude `result` (`is_error: true`) renders as the answer |
| `5b7a39c97` | Errors go out through `emitAgentErrorAfterOutput(…)`, which flushes the data buffer first and sets `errorEmitted`/`resultEmitted` (rc :220-227) | The error card overtakes buffered text and the renderer erases it |
| `30b1c8f51` | The result branch sets `streamedText = resultText` (rc :233-234), and `exit` carries a `TurnSettlement` (rc :503) | `answerCaptured` and `capturedAnswerText` come out false for a run whose answer is the trailing record |
| `689351603` / `160d0094b` | `resolveTurnOutcome`; `handleExit(…, signal, stdinError)` (rc :60-66) | Turn-outcome classification |

Re-apply the PR's intent as follows:

1. **The non-consuming session-id peek** goes between rc :99 and :101, above `awaitCopilotShutdown`
   (:111). The early guard goes at rc :73-75. Round 2's guard test (`4b7fad66e`, which captures
   `jsonBuffer` inside a mocked `waitForCopilotShutdown`) must pass unchanged.
2. **Flush trailing records through `StdoutHandler`, so usage is counted.** The trailing no-newline
   record still gets parsed once in ExitHandler. That parse distinguishes a parser that choked (surface
   the line raw) from one that cleanly declined (noise). Non-error events are then handed to
   `StdoutHandler.handleParsedEvent` through the PR's `dispatchParsedEvent` dependency.
   **Exactly one `parsed-event` per line:** `handleParsedEvent` emits `parsed-event` itself (rc :695),
   so drop `rc`'s `emitParsedEvent` at :185 for events that go through dispatch. The error branch still
   emits its own `parsed-event`, as StdoutHandler :495 does. `usage` (:705) and `call-usage` (:709-711)
   then fire once, through the shared `UsageAccumulator`.
3. **Wire `dispatchParsedEvent` wherever an `ExitHandler` is constructed:**
   - `ChildProcessSpawner.ts` :71-75
   - `CodexAppServerSpawner.ts` :149-151 (it builds its `StdoutHandler` inline)
   - `OpencodeServerSpawner.ts` :99
   - `ExitHandler.test.ts` :150
   - `recordings/turn-recordings.test.ts` :103-104

   Keep the dependency required, so `tsc` flags any site that was missed.
4. **The streamed-text fallback stays where `rc` has it (rc :240-253).** Do NOT move it below
   `detectErrorFromExit` as the PR did. Moving it there means `resultEmitted` is still unset when the
   `facts` object is built (rc :359). `resultMessageSeen` then comes out false, and
   `turn-outcome.ts:201-206` reports `completed-with-warning` instead of `completed` for agents that
   never send a result event (Factory Droid). For the gate itself, see B.
5. **`StdoutHandler`:**
   - Adopt the PR's public `handleParsedEvent(sessionId, managedProcess, event: ParsedEvent, outputParser)`
     signature. Remove the re-parse at rc :690-692, but keep the `emitParsedEvent` at :695 as the one
     emission per line.
   - Put the single hoisted parse after the steering early return (rc :424-432), and reuse it at :489
     and :637 instead of parsing again.
   - Place `interruptedCursor` after :695. It wraps the `streamedText` append (~:763) and joins the
     result gate (:898-903).
   - The reasoning-tag list (:751-756) is the union of `cursor-cli` with `rc`'s omp and antigravity
     entries.
6. **`ManagedProcess`:** `rc` renamed `tempImageFiles` to `tempFiles` (`3db193e79`) and added
   `usageAccumulator`. Grep the PR side for the old name.

**Required new test (`ExitHandler.test.ts`):** a stream-json run whose final record arrives without a
trailing newline emits exactly one `parsed-event`, one `usage` and one `session-id`. This pins the
de-duplication in step 2.

### A5. Wizard

`rc` moved no wizard code into new files. Every conflict comes from both sides adding lines at the same
spot. Resolve each one as the union of both sides:

- **`ConversationScreen/types.ts` :58-61:** keep `rc`'s `enableMaestroP`, `maestroPMode` and
  `maestroPPath`, plus the PR's four fields.
- **Spawn calls:** keep `rc`'s `claudeTokenSource: getClaudeTokenSourceFields(state)` next to the PR's
  `customPath`/`customArgs`/`customEnvVars`/`agentConfigValues`. Locations:
  - `useConversationBootstrap.ts` :46-47
  - `useWizardConversationSend.ts` :290-291, :385-386
  - `usePreparingPlanGeneration.ts` :117-118

  Add the PR's fields to the dependency arrays (:94, :332, :425, :182).
- **`conversationManager.ts`:** add `claudeTokenSource` at :57, :144 and :197, next to the PR's
  fields. The `cursor-cli` case in `buildArgsForAgent` goes before `default:` (:754).
- **Duplicate-key traps (TS1117):**
  - `conversationManager.ts` :635-637 and `phaseGenerator.ts` :1169 each keep one
    `sessionCustomModel`: the PR's merged one, where the planner model outranks
    `agentConfigValues.model`.
  - Delete `rc`'s standalone `sessionCustomModel: this.session!.model` / `config.model` line.
  - Keep `rc`'s `getClaudeTokenSourceFields` spreads at :644 and :1172. The fields they emit
    (`enableMaestroP`, `maestroPMode`, `maestroPPath`) do not overlap the PR's keys.
- **`inlineWizard/conversationActions.ts`:** keep `rc`'s `setWizardAgentWorking(tabId, true)` (:349-355)
  and its `finally` (:422), around the PR's 5-argument `sendWizardMessage(…)` call.
- **`WizardContext` (`types.ts`, `reducer.ts`, `WizardContext.tsx`, `AgentSelectionScreen.tsx`):** keep
  `rc`'s `codexTransport` and `setCodexTransport` next to the PR's `agentConfigValues` and setter. The
  PR's `SET_SELECTED_AGENT` reset does not clear `codexTransport` (see Assumptions).
- **`useWizardHandlers.ts`:**
  - Keep both imports at :48.
  - Destructuring: `rc`'s `codexTransport` (:1226) and the PR's `agentConfigValues` (:1222).
  - Session object: the PR's `customModel`/`customEffort`/`customProviderPath`/`customContextWindow`
    go after :1362, and `rc`'s `codexTransport` stays at :1369-1370.
  - The PR's test hunk moves from ~2114 to ~2224, below `rc`'s new skill-discovery tests.
- **`inlineWizardConversation.ts` and `inlineWizardDocumentGeneration.ts`:** the PR adds only
  `images`/`readOnlyMode` (spawn object ~:874-884) and `permissionMode` (after `sessionSshRemoteConfig`,
  :1163). No duplicates.

### A6. Docs

- **`CLAUDE-AGENTS.md`:**
  - `rc` widened the Notes column and re-padded every row of the Supported Agents table (:7-20).
    Re-pad the `cursor-cli` row to the new width and keep it between `omp` and `terminal`.
  - Under "Adding New Agents", `rc` added step 14 (declare provider translation support or its
    limits). Follow it in the Cursor section.
- **`CLAUDE.md`:**
  - `rc` cut this file down to an index (`9be143969`), and the Supported Agents table moved to
    ~:549-564. Insert the `cursor-cli` row between `copilot-cli` and `factory-droid`.
  - `scripts/verify-docs-paths.mjs` now fails on any index line over 320 characters, any duplicate
    title, and any title present in only one of `CLAUDE.md` and `CANONICAL-UTILITIES.md`.
- **`PROVIDER-SUPPORT.md`:**
  - Keep the PR's `--add-dir` row in the Step 3.5 table.
  - Keep `### Cursor CLI` appended after the Antigravity section (it ends at ~:1370).
  - Rename the heading to `rc`'s status-suffix convention:
    `### Cursor CLI ✅ Implemented (beta, verified against Cursor CLI 2026.08.11)`.
  - Add the statement that `rc`'s new Provider Translation Contract (:664-762, rule at :666)
    requires: whether sessions, memories, instructions, skills and custom subagents can be translated
    in each direction. Say "unsupported" wherever this PR implements nothing.
  - Keep the identity-validation paragraph, updated to match C.

### A7. Sweeps after resolution (before the merge commit)

- `git diff --check` and `git grep -nE '^(<<<<<<<|=======$|>>>>>>>)'` both come back empty.
- The three `tsc` runs from Verify pass. This is the duplicate-key (TS1117) check the maintainer asked
  to repeat, and it also catches missed `dispatchParsedEvent` wiring.
- `git grep -n "'cursor-cli'" -- src/shared/maestro-lib` shows exactly one entry per registry.
- `git grep -nE "findCommandInPath|buildSshEnvForRemote|finalizeAgentStdin|useRawLocalStdin" -- src`
  returns nothing outside comments.

---

## B. Limit the streamed-text interrupt gate to Cursor (review §2, option a)

**Why option (a).** The broad `!interrupted` gate came from PR commit `0878a9e96` ("harden Cursor CLI
integration"), and the only test pinning it is the Cursor one ("does not finalize accumulated Cursor
text after interruption reports code zero"). `StdoutHandler`'s `interruptedCursor` guard only stops
text that arrives *after* Stop. Text accumulated *before* Stop still sits in `streamedText`, so
ExitHandler needs its own gate for Cursor. Every other agent should keep `rc`'s behavior: on Stop, the
accumulated text is flushed at exit. That is what the maintainer described for Factory Droid.

**Change:** `rc`'s fallback at rc :240-253 becomes:

```ts
// Some agents (like Factory Droid) don't send explicit "done" events, they just exit.
// Flush what they streamed, unless an error already went out, or this is a Cursor
// turn the user stopped: Cursor reports exit code 0 after an interrupt, so its partial
// text would otherwise be finalized as a complete answer. Other agents' partial text
// from an interrupted turn is flushed on purpose.
if (
	isStreamJsonMode &&
	!managedProcess.errorEmitted &&
	!managedProcess.resultEmitted &&
	!(managedProcess.toolType === 'cursor-cli' && managedProcess.interrupted) &&
	managedProcess.streamedText
) {
```

`!errorEmitted` stays broad. The maintainer called it "a clear improvement", and the existing test
"does not flush partial streamedText after an agent error was already emitted" pins it.

**Tests (`ExitHandler.test.ts`):**

- Keep the existing Cursor interrupt test.
- Add: `factory-droid`, `isStreamJsonMode: true`, `interrupted: true`, `streamedText: 'partial droid
  answer'`, exit code 0. Expect exactly one `data` event with that text, and `resultEmitted === true`.
- Probe, then revert before committing: change the gate back to a broad `!managedProcess.interrupted`.
  The new factory-droid test must fail.

## C. Relax `validateAgentBinaryIdentity` (review §2)

Location after A1: `src/shared/maestro-lib/launch/path-prober.ts`, before rc :94.

- Match on `CURSOR_API_KEY` alone. Drop `'Start the Cursor Agent'`. `CURSOR_API_KEY` is the
  documented auth variable, so it is far less likely to be reworded than prose. It still separates
  Cursor's `agent` from unrelated executables of the same name.
- Rewrite the doc comment: remove "stable help contract" and say plainly that this match depends on
  the Cursor version.
- Add a comment at the match site, roughly: "Version-coupled: depends on Cursor's `--help` text. If
  Cursor stops being detected after a Cursor update, check here first."
- Keep the `exitCode !== 0 → false` check and the early `return true` for every other agent.
- **Tests (`path-prober.test.ts`):**
  - Help output that contains `CURSOR_API_KEY` but none of the old prose validates.
  - Help output without `CURSOR_API_KEY` is rejected.
  - A non-zero exit is rejected.
  - A non-Cursor agent id returns `true` without spawning.

## E. Push and reply

1. Before pushing, remove this spec from the index: `git rm --cached docs/specs/pr1401-rc-sync-round3.md`
   in its own commit. The file stays on disk (`docs/specs/` is gitignored), and the PR's net diff
   never contains it.
2. Push: `git push fork pr1401-push:codex/cursor-cli-agent-rc`, no force. Pushing a merge on top of
   the current head is a fast-forward.
3. Confirm `gh pr view 1401 -R RunMaestro/Maestro --json mergeable,mergeStateStatus` reports
   `MERGEABLE`.
4. Post one PR comment answering the 2026-10-18 review, in the round-2 format. It must cover:
   - **The re-port:** maestro-lib moves, dropped obsolete code (the raw-stdin path in particular, and
     why), and the new turn recording.
   - **Duplicate keys and wiring:** the duplicate-key traps found, the `dispatchParsedEvent` sites,
     and the one-`parsed-event` test.
   - **B:** option (a), with the factory-droid test.
   - **C:** the one-token match, with its comment.
   - **Local gates actually run,** and the ask to approve the fork workflow run.

**Every git and GitHub write above needs the user's "autorizo" (rule in
`~/.claude/rules/autorizacao.md`).** That covers `git merge`, each `git commit`, `git rm --cached`,
`git push`, and the PR comment. Ask once for the whole set: list the branch, remote, commit messages
and comment text, then stop and wait. A read-only command can also trip the hook because its name
contains `merge` (for example `git merge-base`). Do not route around it.

---

## Verify (scoped, local)

```bash
# Typecheck: this is the TS1117 duplicate-key check, and it catches missed dispatchParsedEvent wiring
npx tsc -p tsconfig.main.json --noEmit
npx tsc -p tsconfig.cli.json --noEmit
npx tsc -p tsconfig.lint.json

# Process manager: handlers, the turn recordings, and the new parsed-event and factory-droid tests
npx vitest run src/__tests__/main/process-manager/

# Agents, parsers, launch layer
npx vitest run src/__tests__/main/agents/ src/__tests__/main/parsers/ src/__tests__/main/utils/agent-args.test.ts
npx vitest run src/__tests__/shared/maestro-lib/launch/ src/shared/maestro-lib/__tests__/no-desktop-framework.smoke.test.ts

# CLI services, including turn-recordings.cli.test.ts, which runs Cursor through spawnAgent
npx vitest run src/__tests__/cli/services/

# Wizard
npx vitest run src/__tests__/renderer/components/Wizard/ src/__tests__/renderer/hooks/useWizardHandlers.test.ts src/__tests__/renderer/hooks/useInlineWizard.test.ts
npx vitest run src/__tests__/renderer/services/inlineWizardConversation.test.ts src/__tests__/renderer/services/inlineWizardConversation_overrides.test.ts src/__tests__/renderer/services/inlineWizardDocumentGeneration.test.ts src/__tests__/renderer/services/inlineWizardDocumentGeneration_overrides.test.ts src/__tests__/renderer/services/inlineWizardDocumentGeneration_ssh.test.ts

# Docs
node scripts/verify-docs-paths.mjs
node scripts/check-doc-refs.mjs

# Formatting and lint on touched files only
npx prettier --check $(git diff --name-only origin/rc...HEAD -- '*.ts' '*.tsx' '*.md')
npx eslint $(git diff --name-only origin/rc...HEAD -- 'src/**/*.ts' 'src/**/*.tsx')
```

Use npm, not pnpm. Under pnpm, the typecheck reports phantom `TS2307` errors. The npm `postinstall`
fails on this Mac (clang 12) but leaves a usable tree.

## CI owns

The Reviewer reads these from `gh pr checks 1401`. Do not block on a missing local run.

- `test (ubuntu-latest)` and `test (windows-latest)`: the full `npm test` matrix. The Windows leg is
  the one that matters for the path-prober install paths.
- `npm run lint`, `npm run lint:eslint`, and repo-wide `npx prettier --check .`.
- Build and Playwright E2E.

As of this spec, these have **never run on this PR**. It is a fork PR, and the maintainer said they
will approve the workflow run once the branch is clean. Until then, `gh pr checks 1401` shows only
CodeRabbit. That is expected, and it is not a finding against this lane.

## Out of scope

- CodeRabbit's "bare Windows command needs a shell" finding: declined in round 2, tracked in #1608.
- CodeRabbit's docstring-coverage warning: not a merge gate, and the maintainer did not raise it.
- Windows prompt length on the CLI surface (argv on every agent unless `cmdShellLaunch` is set). This
  is `rc`'s shared prompt-delivery contract and not specific to Cursor.

## Assumptions

1. **Merge, not rebase.** The maintainer accepts either. A merge resolves each conflict once.
2. **Option (a) for the interrupt gate.** It limits the behavior change to the agent that motivated
   it and needs no new policy for the other agents.
3. **The identity check matches `CURSOR_API_KEY` only.** No secondary check on the path containing
   `cursor`: the binary is installed as `agent`, so the path is not a reliable signal.
4. **Cursor drops its raw-stdin prompt path** and uses `rc`'s shared `resolvePromptDelivery`, based on
   the `supportsPromptViaStdin: true` it already declares. The PR's reason for the special case
   (Windows command-line limits) is now handled centrally for the desktop surface. Keeping a
   Cursor-only path would be the kind of divergence the maintainer keeps flagging.
5. **`codexTransport` is not reset on `SET_SELECTED_AGENT`.** `rc` reads it only for Codex, and the
   PR's reset is about Cursor config values. Clearing it would change `rc`'s Codex behavior with no
   test asking for that.
6. **rc line numbers are as of `a6d596651`.** If `origin/rc` moved, they are approximate. Always
   resolve against the anchor named next to them (function, field, commit).
7. **This spec is committed on `pr1401-push`, force-added** (`git add -f`, because `.gitignore`
   ignores `specs/`), so the Reviewer can see it. E1 removes it from the index before the push, so
   it never shows in the PR diff. Earlier rounds kept specs on `feature/pr1401-cursor-cli-agent`, but
   that branch is stale, and this worktree is on `pr1401-push`.
8. **Branch name.** The worktree already exists for this PR on `pr1401-push`, not
   `feature/<slug>`. Per the planning protocol it is reused rather than duplicated.
9. **No brief.** `docs/briefs/` does not exist in this repo.
10. **Facts from read-only analysis.** The `rc`-side facts come from `git diff`/`log`/`show` between
    `4f24ea7c8` and `a6d596651`. No trial merge was run, because the user's hook blocks
    `git merge-tree`/`merge-base` without an "autorizo". The 21-file conflict list is the maintainer's.

## PR title

feat(agents): add Cursor CLI as a first-class beta agent
