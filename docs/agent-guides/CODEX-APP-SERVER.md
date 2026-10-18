# Codex App-Server Transport (design note)

An OPT-IN, per-agent transport that runs a Codex turn on `codex app-server` (JSON-RPC over stdio) instead of `codex exec --json`. The point is `turn/steer`: an app-server turn accepts input while it runs, so the Steer button can reach a Codex turn the way it already reaches a Claude turn on maestro-p (see "Steering a Claude turn that is ALREADY RUNNING" in `CLAUDE.md`).

**`codex exec` stays the default.** The app-server path is experimental, local-only, text-only, and falls back to `codex exec` whenever it cannot start.

Everything below was derived from live traffic recorded with codex-cli 0.162.1 on 2026-10-11, in `src/__tests__/fixtures/codex-app-server/` (format in that folder's `README.md`). A reference such as `plain-turn:6` means line 6 of `plain-turn.jsonl`. Parameter names that the fixtures do not exercise were read from `codex app-server generate-json-schema`.

## Precedent

OpenCode already has this shape. `OpencodeServerSpawner` (`src/main/process-manager/spawners/`) registers a `ManagedProcess`, translates the server's events back into the CLI's JSONL lines (`src/main/opencode-server/event-translator.ts`), and feeds them through the SAME `StdoutHandler` / `ExitHandler` the CLI path uses. The parser, usage, tool execution, session id and renderer are reused unchanged. Routing is `ProcessManager.shouldUseOpencodeServer()`.

The Codex version copies that design with one difference: it owns a real OS child (`codex app-server`), one per turn, so Stop and exit still go through the process-tree ladder.

## Wire basics

- Newline-delimited JSON-RPC 2.0 on the child's stdin/stdout.
- Client requests carry `jsonrpc`, `id`, `method`, `params`. Server lines omit `jsonrpc`.
- Every server NOTIFICATION carries `emittedAtMs` beside `params` (`plain-turn:8`). Responses do not (`plain-turn:2`).
- The server sends REQUESTS of its own (they carry `id` AND `method`, `approval-request:52`). Ids are a separate number space starting at 0. A request the client never answers stalls the turn forever (see "Server-to-client requests").

## Handshake

| Step                       | Line           | Shape                                                                        |
| -------------------------- | -------------- | ---------------------------------------------------------------------------- |
| request `initialize`       | `plain-turn:1` | `{ clientInfo: { name, version }, capabilities: { experimentalApi: true } }` |
| response                   | `plain-turn:2` | `{ userAgent, codexHome, platformFamily, platformOs }`                       |
| notification `initialized` | `plain-turn:3` | no params                                                                    |

`experimentalApi: true` is required for `turn/steer`. A `remoteControl/status/changed` notification can arrive before `initialized` is even sent (`read-only-turn:3`); the reader must not assume the first server line is the `initialize` response.

`clientInfo.name` becomes the thread's `originator` and the user-agent prefix (`plain-turn:6`). Use `maestro`.

## Mapping a `ProcessConfig` onto the protocol

The spawner receives the same `ProcessConfig` the exec path would have used and parses the exec args the caller already built, exactly as `parseInvocation()` does for OpenCode. Nothing upstream changes.

| Exec arg (from `definitions.ts`)                     | App-server equivalent                                                                        | Evidence                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `-C <dir>` / `config.cwd`                            | `thread/start` and `thread/resume` `cwd`                                                     | `plain-turn:4`, `resumed-turn:4`                                                                   |
| default `--dangerously-bypass-approvals-and-sandbox` | `sandbox: 'danger-full-access'`, `approvalPolicy: 'never'`                                   | `plain-turn:4`, result echoes `sandbox: { type: 'dangerFullAccess' }` at `plain-turn:6`            |
| read-only `--sandbox read-only`                      | `sandbox: 'read-only'`, `approvalPolicy: 'never'`                                            | `read-only-turn:5`                                                                                 |
| `-m <model>`                                         | `thread/start` / `thread/resume` `model`                                                     | schema (`ThreadStartParams.model`); result reports `model` at `plain-turn:6`                       |
| `-c model_reasoning_effort="x"`                      | `turn/start` `effort`                                                                        | schema (`TurnStartParams.effort`, free string); result reports `reasoningEffort` at `plain-turn:6` |
| `-c model_reasoning_summary="x"`                     | `turn/start` `summary`                                                                       | schema                                                                                             |
| other `-c key=value`                                 | `thread/start` / `thread/resume` `config` object                                             | schema                                                                                             |
| `resume <id>` (from `resumeArgs`)                    | `thread/resume` `{ threadId: <id>, cwd, sandbox, approvalPolicy }` instead of `thread/start` | `resumed-turn:4`                                                                                   |
| prompt after `--`                                    | `turn/start` `{ threadId, input: [{ type: 'text', text }] }`                                 | `plain-turn:7`                                                                                     |
| `--add-dir` (write grants)                           | dropped under full access (grants nothing more); otherwise fall back to exec                 | none                                                                                               |
| `-i <image>`                                         | not supported; fall back to exec                                                             | out of scope                                                                                       |

Notes:

- **Read-only must use `approvalPolicy: 'never'`.** With `'never'` the denied write was reported back to the model and the turn continued (`read-only-turn:51-75`), matching exec. With `'on-request'` the server asks for approval instead (`approval-request:52`), which is a prompt nobody is watching.
- **Read-only denials leave no tool card.** In `read-only-turn.jsonl` the failed write produced NO `commandExecution` item at all; only the agent's messages report it (`read-only-turn:75`). The translator cannot synthesize one and should not try.
- **The thread id IS the provider session id.** `thread/start` returns `thread.id` (`plain-turn:6`, also `thread.sessionId`, same value) and the rollout path under `~/.codex/sessions/` (same file `codex exec` writes). A thread started on app-server resumes on exec and vice versa, so falling back mid-conversation is safe.
- **Resume emits no `thread/started`.** Compare `plain-turn:8` with `resumed-turn.jsonl`, which has none. The translator must emit its own `thread.started` from the `thread/resume` RESPONSE (`resumed-turn:17`), or the tab never learns the session id on a resumed turn.
- **Resume replays history in the response.** `resumed-turn:17` carries `thread.turns` (the earlier turn's items). Ignore them; they are not this turn's output. A `deprecationNotice` (`resumed-turn:6`) suggests `excludeTurns: true`, which is the right param to send.
- The model really did see the earlier turn: `resumed-turn:33` answers `OK`.

## Notification -> `codex exec --json` line

The translator emits exactly the legacy exec shapes `CodexOutputParser.transformMessage()` already handles (`src/shared/maestro-lib/parsers/codex-output-parser.ts`, the "Legacy format" branch: `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`, `turn.failed`, `error`). No parser change is needed.

| App-server line                                                                                                                                                                                                                                     | Exec line emitted                                                                                                       | Notes                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread/start` response `result.thread.id` (`plain-turn:6`), or `thread/started` (`plain-turn:8`)                                                                                                                                                   | `{"type":"thread.started","thread_id":"<id>"}`                                                                          | Emit once per process. Prefer the RESPONSE: it exists on resume too (`resumed-turn:17`), `thread/started` does not.                                                                                                                                                  |
| `turn/started` (`plain-turn:21`)                                                                                                                                                                                                                    | `{"type":"turn.started"}`                                                                                               | Also record `turn.id`; it is the `expectedTurnId` for `turn/steer` and the `turnId` for `turn/interrupt`. The `turn/start` response carries it earlier (`plain-turn:16`).                                                                                            |
| `item/started`, `item.type: 'commandExecution'` (`tool-turn:46`)                                                                                                                                                                                    | `{"type":"item.started","item":{"id","type":"command_execution","command","status":"in_progress"}}`                     | Keep `item.id`; the parser correlates start and completion by it.                                                                                                                                                                                                    |
| `item/completed`, `commandExecution` (`tool-turn:47`)                                                                                                                                                                                               | `{"type":"item.completed","item":{"id","type":"command_execution","command","aggregated_output","exit_code","status"}}` | `aggregatedOutput` -> `aggregated_output`, `exitCode` -> `exit_code`. Status: `inProgress` -> `in_progress`, `completed` -> `completed`, `failed` and `declined` (`approval-request:55`) -> `failed`.                                                                |
| `item/completed`, `agentMessage` (`plain-turn:30`)                                                                                                                                                                                                  | `{"type":"item.completed","item":{"id","type":"agent_message","text"}}`                                                 | One per message, both `phase: 'commentary'` (`tool-turn:45`) and `phase: 'final_answer'` (`tool-turn:80`), matching what exec emits today. Preserve the optional `phase` in the translated item so the shared parser distinguishes commentary from the final answer. |
| `item/completed`, `reasoning` (`approval-request:60`)                                                                                                                                                                                               | `{"type":"item.completed","item":{"id","type":"reasoning","text"}}`                                                     | `text` = `summary` strings joined with blank lines, falling back to `content`. Skip when both are empty (as at `approval-request:60`).                                                                                                                               |
| `item/started` for anything but `commandExecution`                                                                                                                                                                                                  | nothing                                                                                                                 | Exec only reports command starts.                                                                                                                                                                                                                                    |
| `item/completed`, `userMessage` (`plain-turn:27`, `steered-turn:59`)                                                                                                                                                                                | nothing                                                                                                                 | Never forwarded. The steering verdict reads it (see below).                                                                                                                                                                                                          |
| `item/agentMessage/delta` (`plain-turn:29`)                                                                                                                                                                                                         | nothing                                                                                                                 | Exec does not stream deltas; the completed item carries the full text. Streaming is a later improvement, not phase 1.                                                                                                                                                |
| `thread/tokenUsage/updated` (`plain-turn:31`)                                                                                                                                                                                                       | `maestro.call_usage` (the active turn only; accumulated too)                                                            | See "Usage".                                                                                                                                                                                                                                                         |
| `turn/completed`, `status: 'completed'` (`plain-turn:34`)                                                                                                                                                                                           | `{"type":"turn.completed","usage":{...}}`                                                                               | Then end the process.                                                                                                                                                                                                                                                |
| `turn/completed`, `status: 'interrupted'` (`interrupted-turn:59`)                                                                                                                                                                                   | `{"type":"turn.completed","usage":{...}}`                                                                               | Usage is still real money; report it. The exit follows the Stop path.                                                                                                                                                                                                |
| `turn/completed`, `status: 'failed'`                                                                                                                                                                                                                | `{"type":"turn.failed","error":{"message":"<turn.error.message>"}}`                                                     | `turn.error` is a `TurnError` (`{ message, codexErrorInfo?, additionalDetails? }`, schema). Not observed in the fixtures.                                                                                                                                            |
| `error` notification, `willRetry: true`                                                                                                                                                                                                             | `{"type":"error","message":"Reconnecting... <message>"}`                                                                | The parser's `isCodexRetryNotice` keys on the `Reconnecting...` text and treats it as progress. Schema only.                                                                                                                                                         |
| `error` notification, `willRetry: false`                                                                                                                                                                                                            | `{"type":"error","message":"<error.message>"}`                                                                          | Schema only.                                                                                                                                                                                                                                                         |
| `initialize` response, `remoteControl/status/changed`, `account/updated`, `account/rateLimits/updated`, `mcpServer/startupStatus/updated`, `warning`, `deprecationNotice`, `thread/status/changed`, `thread/goal/cleared`, `serverRequest/resolved` | nothing                                                                                                                 | Noise. `warning` (`plain-turn:9`) can go to the debug log.                                                                                                                                                                                                           |

Item types the fixtures did not exercise (`fileChange`, `mcpToolCall`, `webSearch`, `plan`, and the rest of the `ThreadItem` union in the schema) are dropped in phase 1, the same way the parser already drops exec item types it does not know. Adding a mapping later is a translator change only.

### Usage

`thread/tokenUsage/updated` carries `total` (running THREAD total) and `last` (the latest API call), plus `modelContextWindow` (`plain-turn:31`). It fires after every model call, several times per turn (`tool-turn:48, 52, 56, 81`).

**Never report `total` as the turn's usage.** A resumed thread's first update arrives BEFORE the new turn starts and carries the old turn's total (`resumed-turn:18`: 28,851 tokens, `turnId` of the plain turn); the new turn's last update reads 61,746 (`resumed-turn:34`). Summing or forwarding `total` is the quadratic over-count `CodexTokenCounts` exists to stop.

The turn's usage is `total` at the last update with this turn's `turnId`, minus the thread total from BEFORE the turn. That baseline is read off the turn's OWN first update as `total - last` (`resumed-turn:34`: 61,746 - 32,895 = 28,851, exactly the replayed total at `resumed-turn:18`; zero for a fresh thread, where the first update's `total` equals its `last`), so it does not depend on the server replaying the previous turn's total on resume. The replayed total (the last update for another turn before this turn's first one) is only the fallback for an update with no `last`. Updates are kept per `turnId`, so one that lands before the turn id is known still counts. Map `inputTokens` -> `input_tokens`, `cachedInputTokens` -> `cached_input_tokens`, `outputTokens` -> `output_tokens`, `reasoningOutputTokens` -> `reasoning_output_tokens`. That matches what exec's `turn.completed.usage` means: per turn, not per session. `modelContextWindow` (258,400 here) can ride along for the parser's context window later; phase 1 does not need it.

Each update for the ACTIVE turn also yields one line exec never writes, `{ type: 'maestro.call_usage', usage }` (`CODEX_CALL_USAGE_LINE_TYPE`), carrying what the turn spent since its previous update in the same exec field names: the growth past the previous update, or `last` for the turn's first update. The lines of a turn sum to its `turn.completed.usage`. `CodexOutputParser` turns the line into `ParsedEvent.callUsage`, never `usage`, and it reaches the renderer as `process:call-usage`, the Throughput Gauge's live reading. An update for another turn (the replay on resume) or one ahead of the turn id yields none.

## Server-to-client requests

Every request below is answered, by method, the moment it arrives. An unknown method gets a JSON-RPC error response (`-32601`), never silence. In default mode the policy is `never` so approval requests should not appear at all; the answers are the safety net.

| Method                                                      | Default (bypass) mode                                 | Read-only mode                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `item/commandExecution/requestApproval`                     | `{ decision: 'accept' }`                              | `{ decision: 'decline' }` (recorded: `approval-request:52-55`, item ends `status: 'declined'`) |
| `item/fileChange/requestApproval`                           | `{ decision: 'accept' }`                              | `{ decision: 'decline' }`                                                                      |
| `item/permissions/requestApproval`                          | `{ permissions: <requested profile>, scope: 'turn' }` | `{ permissions: {} }` (grant nothing)                                                          |
| `execCommandApproval` (v1)                                  | `{ decision: 'approved' }`                            | `{ decision: 'denied' }`                                                                       |
| `applyPatchApproval` (v1)                                   | `{ decision: 'approved' }`                            | `{ decision: 'denied' }`                                                                       |
| `item/tool/requestUserInput`                                | `{ answers: {} }`                                     | `{ answers: {} }`                                                                              |
| `mcpServer/elicitation/request`                             | `{ action: 'decline' }`                               | `{ action: 'decline' }`                                                                        |
| `item/tool/call` (dynamic tool)                             | `{ success: false, contentItems: [] }`                | same                                                                                           |
| `account/chatgptAuthTokens/refresh`, `attestation/generate` | JSON-RPC error                                        | JSON-RPC error                                                                                 |

Why these choices:

- Approving in default mode matches exec: `--dangerously-bypass-approvals-and-sandbox` never asks. Declining in read-only mode matches `--sandbox read-only`: the model gets the refusal and carries on (`approval-request:88`).
- `requestUserInput` and elicitations are questions for a human nobody is showing. An empty answer lets the turn continue; surfacing them in the UI is a separate feature.
- The server confirms each answer with `serverRequest/resolved` (`approval-request:54`), which the translator ignores.

## Steering

`turn/steer` `{ threadId, expectedTurnId, input: [{ type: 'text', text }] }` (`steered-turn:52`). Outcomes map onto `SteeringVerdict` in `src/shared/chatSteering.ts`:

| Observed                                                                                                   | Verdict                                         | Evidence                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| RPC success `{ turnId }`                                                                                   | `delivered` (the immediate socket-style answer) | `steered-turn:55` (under 0.1s in the 2026-10-10 live check)                                                                           |
| `item/completed` with `item.type: 'userMessage'` whose text matches the steer, `turnId` = the steered turn | `absorbed` (the stdout refinement)              | `steered-turn:59` (about 1.2s after the RPC in the live check); the turn then answered PINEAPPLE in the same turn (`steered-turn:64`) |
| JSON-RPC error `-32600` "no active turn to steer"                                                          | `refused`, refusal `not-running`                | `late-steer:38`                                                                                                                       |
| RPC success, then `turn/completed` with no matching `userMessage`                                          | `dropped`                                       | inferred; not recorded                                                                                                                |
| transport failure, timeout, child gone                                                                     | `unknown`                                       | inferred                                                                                                                              |

Rules carried over from the Claude path:

- Match the `userMessage` text with `steeringTextMatches()`, not `===`. The server echoes the text in `item.content[0].text` (`steered-turn:59`).
- `expectedTurnId` is the id from `turn/started` (or the `turn/start` response). A steer that races the turn's end gets the same `-32600` and is `refused`; the caller keeps the message queued, exactly as today.
- There is no `queued` verdict on this transport. One turn per process means nothing can be parked and drained after `turn/completed`; a steer either lands in the running turn or is refused.
- The images rule holds: an item with images is not steerable (and an image turn never runs on this transport at all).

- A turn that ends, with no echo, before the RPC's answer is read is answered `refused` / `not-running` rather than `delivered` then `dropped`. Both leave the message with the caller to send normally, but a `dropped` raised after `delivered` races the turn's exit to the renderer, and an exit that wins settles the held steer as unconfirmed (paused) instead.

The `SteeringVerdict` union needs no new member. `ProcessManager.steer()` sends `turn/steer` when the registered process carries a `codexAppServer` handle (only the app-server path sets one; an exec turn falls through to the maestro-p socket client, which refuses it as `not-running`). The later verdict is emitted on the process manager as `steering-verdict` with the same frame and id the Claude path uses, so `process:steering-verdict` and `applySteeringVerdict()` carry it unchanged. The handle's `onTurnEnd` fires BEFORE the exit is reported, which is what puts a `dropped` verdict ahead of the exit.

## Lifecycle

```
spawn codex app-server (one child per turn)
  -> initialize / initialized
  -> thread/start | thread/resume (excludeTurns: true)
  -> emit thread.started
  -> turn/start
       ... notifications translated to exec lines ...
       ... server requests answered by policy ...
       ... turn/steer on request, verdicts as above ...
  -> turn/completed
  -> emit turn.completed | turn.failed
  -> close stdin, let the child exit, ExitHandler fires once
```

- **One child per turn.** Same contract as exec: a turn is a process, so busy state, exit listeners, liveness (`AGENT_LIVENESS_EVENTS`) and the idle watchdog keep working unchanged. A long-lived shared server is NOT phase 1.
- **Exit on `turn/completed`.** After the terminal line is forwarded, close stdin; if the child is still alive after a short grace, stop it through `stopProcess()`. The exit code reported to `ExitHandler` is 0 for `completed` and `interrupted`, non-zero for `failed`.
- **Stop = `turn/interrupt` then kill.** Send `turn/interrupt` `{ threadId, turnId }` (`interrupted-turn:54`); it answers `{}` (`interrupted-turn:57`) and the turn ends `turn/completed` with `status: 'interrupted'` (`interrupted-turn:59`). Then run the normal `stopProcess()` ladder in case the child does not leave on its own. Never skip the kill: a child that ignored the interrupt goes on running commands. On Windows that ladder starts at `terminate`, not `interrupt`: the `interrupt` stage writes Ctrl+C into the child's stdin, which here is the JSON-RPC channel, and `turn/interrupt` already is the protocol's interrupt. POSIX keeps the out-of-band SIGINT stage.
- **Fallback.** If the binary is missing, `initialize` fails, `thread/start` / `thread/resume` errors, the thread does not run under the sandbox the turn asked for (below), or the server answers `turn/start` itself with a JSON-RPC ERROR, kill the child and spawn the same `ProcessConfig` through the normal `codex exec` path. An error response is proof the prompt never started. Anything else after `turn/start` is sent (the child dying, a timeout) leaves that unknown, so it is reported, never retried: sending the prompt twice is worse than an error. Output (the held `thread.started`, early notifications, stderr) is held until the server accepts the turn, by its `turn/start` response or the turn's own `turn/started`, whichever is first, so a turn that falls back has shown the tab nothing and exec's output is the only output. A turn that fails in that window without a refusal releases what was held before its exit is reported, so the tab still learns the session id.
- **Sandbox verification.** A resumed thread has persisted settings of its own; the request's `sandbox` override is what keeps a read-only turn read-only. Both responses echo the EFFECTIVE policy as a `SandboxPolicy` object (`read-only-turn:6`: `sandbox: { type: 'readOnly', networkAccess: false }`; `workspaceWrite` / `dangerFullAccess` for the other modes). When the turn asked for `read-only` or `workspace-write`, `codexThreadPolicyMismatch()` (`invocation.ts`) compares the echoed `type` before `turn/start` goes out; a different or missing echo falls back to exec, which applies `--sandbox` itself. Verified live on 0.162.1: resuming a full-access thread with `sandbox: 'read-only'` echoes `readOnly` (the override takes). `approvalPolicy` is not compared: outside full access every approval request is declined, so no approval policy can widen a restricted turn.
- **Thread scoping.** One connection can carry more than one thread: a sub-agent the turn spawns runs as its own thread (`parentThreadId` on its `Thread`). Every thread-scoped notification names its thread (`params.threadId`, required in the schema; `params.thread.id` on `thread/started`), and the translator drops any that name a thread other than the one the `thread/start` / `thread/resume` response returned. Without that a sub-agent's `turn/started` would retarget `turn/steer` / `turn/interrupt` and its `turn/completed` would end this turn.
- **Instructions.** The thread picks up `AGENTS.md` from the cwd (`instructionSources`, `plain-turn:6`), same as exec.
- **Verified live (codex-cli 0.162.1).** Plain turn, resume on the same thread id, a mid-tool-loop steer (`delivered` then `absorbed`), a steer after exit (`refused` / `not-running`), Stop (the child and its `sleep` grandchild both gone), and the default transport staying on `codex exec` all behaved as written here. One ordering to expect: the exit is reported on `turn/completed`, a moment BEFORE the child process actually leaves, so a check that the pid is gone has to wait briefly after the exit event.

## SSH remotes

An SSH agent spawn is a local `ssh ... /bin/bash --norc --noprofile -s` whose stdin carries a launch script (PATH, `cd`, env exports) ending in `exec <agent>`. Bash reads a script from a pipe one byte at a time, so everything written after the `exec` line reaches the agent untouched. app-server rides that channel: the spawner writes the script first and the JSON-RPC lines after it.

- **Built beside the exec wrapper.** `wrapSpawnForSsh()` builds the exec wrapper as always and, for a turn that `wantsCodexAppServer()`, also calls `buildCodexAppServerSshLaunch()` (`ssh-launch.ts`) with the same remote, binary, cwd and env. The launch carries the planned exec turn (`execArgs`, the REMOTE `cwd`, `prompt`), because the config itself holds the ssh client's args, the local cwd and no prompt. `parseCodexExecArgs()` reads those args exactly as it reads a local config's, and the remote command is `codex app-server <configArgs>`.
- **No launch, no app-server.** `codexAppServerConfigBlocker()` refuses an SSH config without `codexAppServerSsh`, so an Auto Run, Cue, image or unsupported-arg turn runs the exec wrapper. Every setup failure falls back to that same wrapper.
- **Stop reaches the host.** The script is prefixed with `withRemotePidRecord()`. `turn/interrupt` still goes first; every stop that would signal the local ssh client (the grace ladder, kill, fallback) also calls `signalRemoteAgent()`, since a signal to the client never reaches the remote server.
- **Steering.** `getSteerEligibility()` and `getSteerSupport()` check the Codex transport before the SSH block, so an SSH Codex agent on app-server offers Steer, and one on exec is told the transport is the fix.

## Out of scope (stay on `codex exec`)

- Image prompts (`-i`). `turn/start` input supports images in the schema, but phase 1 is text-only.
- Auto Run, Cue, and CLI batch spawns (`maestro-cli` / `agent-spawner.ts`). None of them can be steered from the UI, so they gain nothing.
- Group chat (moderator and participants).
- Spawns that pass `--add-dir` write grants under a sandbox other than full access, until a mapping exists (app-server 0.162.1 has no write-grant field).

## Implementation map

| Concern                                              | Module                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Wire types, line classification, the steering handle | `src/main/codex-app-server/protocol.ts` (`CodexAppServerProcessHandle`)                      |
| Exec args -> protocol params (whitelist, else exec)  | `src/main/codex-app-server/invocation.ts` (`parseCodexAppServerInvocation`)                  |
| Server-to-client request answers                     | `src/main/codex-app-server/server-requests.ts` (`answerCodexServerRequest`)                  |
| Request ids, pending table, error shapes             | `src/main/codex-app-server/rpc-client.ts` (`CodexRpcRequestError` carries the server `code`) |
| Notification -> exec line                            | `src/main/codex-app-server/event-translator.ts`                                              |
| `turn/steer` and its verdicts                        | `src/main/codex-app-server/steering.ts` (`steerCodexAppServerTurn`)                          |
| Child, handshake, lifecycle, fallback                | `src/main/process-manager/spawners/CodexAppServerSpawner.ts`                                 |

`-c key=value` overrides are passed to the `codex app-server` child itself (it accepts `-c` and parses the value as TOML, like exec), so their semantics are unchanged; `model_reasoning_effort` / `model_reasoning_summary` additionally become `turn/start` `effort` / `summary`. Any exec arg the parser does not know sends the turn to exec rather than dropping the arg. Stop is `sdkController.interrupt()`: `turn/interrupt`, then the `stopProcess()` ladder if the child is still there after `CODEX_APP_SERVER_EXIT_GRACE_MS`.
