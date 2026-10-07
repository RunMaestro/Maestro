---
title: maestro-lib (Library)
description: Plan, run, stream, resume and stop an AI coding agent turn from your own Node program, without the desktop app or the CLI.
icon: book
---

maestro-lib is the part of Maestro that starts a coding agent (Claude Code, Codex, OpenCode and others), sends it a prompt, reads its reply as it streams, stops it, and reports how the turn ended. The desktop app, `maestro-cli` and Cue all run their agents through it. You can use it from your own Node program through one entry module.

## What it is, and what it is not

It is:

- **Plain Node.** Nothing it loads needs Electron or the desktop app. It runs on Node 20 or later, on a laptop, a server or in CI.
- **One turn at a time.** A turn is one prompt sent to one agent process. The agent keeps the conversation; to continue it, you pass the session id the last turn returned.
- **Local.** It starts the agent on the machine your program runs on, in the folder you give it.

It is not:

- **Not the desktop app or the CLI.** There are no agents in a Left Bar, no tabs, no Auto Run, no playbooks, no Cue pipelines and no stored history. Your program keeps whatever state it needs.
- **Not an agent.** It runs agent CLIs you have installed and logged in to. It does not call a model API itself.
- **Not remote.** SSH remotes belong to the desktop app and the CLI, which store them.
- **Not a provider installer.** If the provider's binary is not on this machine, planning the turn fails with `not-installed`.

## Providers

`planSessionTurn` checks every request before anything starts, and refuses what could not run correctly:

| Reason          | When                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown-agent` | The agent id is not one Maestro knows.                                                                                                                                                  |
| `no-batch-mode` | The provider cannot run a single turn without a terminal.                                                                                                                               |
| `no-parser`     | Maestro has no parser for the provider's output, so the answer could not be read. The turn is refused rather than run blind.                                                            |
| `no-resume`     | You asked to resume, and the provider cannot resume a session.                                                                                                                          |
| `no-read-only`  | You asked for a read-only turn, and the provider's command line cannot enforce one. A program with nobody watching gets read-only or a refusal, never a turn that only looks read-only. |
| `not-installed` | The provider's binary was not found on `PATH`, in its known install locations, or at the `command` you gave.                                                                            |
| `launch`        | The launch could not be planned. The message says why.                                                                                                                                  |

What each provider supports in maestro-lib `0.1.0`:

| Agent id        | Name            | Runs a turn | Resume | Read-only |
| --------------- | --------------- | ----------- | ------ | --------- |
| `claude-code`   | Claude Code     | yes         | yes    | yes       |
| `codex`         | Codex           | yes         | yes    | yes       |
| `opencode`      | OpenCode        | yes         | yes    | yes       |
| `factory-droid` | Factory Droid   | yes         | yes    | yes       |
| `copilot-cli`   | Copilot-CLI     | yes         | yes    | yes       |
| `qwen3-coder`   | Qwen3 Coder     | yes         | yes    | yes       |
| `pi`            | Pi              | yes         | yes    | yes       |
| `omp`           | Oh My Pi        | yes         | yes    | yes       |
| `grok`          | Grok CLI        | yes         | yes    | yes       |
| `antigravity`   | Antigravity CLI | yes         | yes    | no        |
| `hermes`        | Hermes          | no          | no     | no        |

Hermes is refused with `no-parser`. To list providers at run time, use `getVisibleAgentDefinitions()` and `getAgentCapabilities(id)`.

## Install

maestro-lib is built from the Maestro repository. It is not published to a package registry.

```bash
git clone https://github.com/RunMaestro/Maestro.git
cd Maestro
npm ci
npm run build:maestro-lib
```

The build writes `dist/maestro-lib/`:

| File           | What it is                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `index.js`     | The library, one CommonJS file for Node 20. Both `require` and `import` load it.                         |
| `index.d.ts`   | Type declarations for everything the entry exports (the files they refer to are under `types/`).         |
| `package.json` | Name `maestro-lib`, the library version, and `maestroAppVersion`, the Maestro version it was built from. |
| `README.md`    | This page.                                                                                               |

Add it to your program as a local dependency:

```json
{
	"dependencies": {
		"maestro-lib": "file:../Maestro/dist/maestro-lib"
	}
}
```

The bundle has no runtime dependencies. For types, your program needs `@types/node`. The declarations also name `node-pty`, for stopping a PTY you started yourself; it is an optional peer, and with `skipLibCheck` (the TypeScript default for most setups) you do not need it.

## Version

The library has its own version, separate from the Maestro app's version. The app can ship many releases with no change to the library.

- `MAESTRO_LIB_VERSION`, exported from the entry, and `version` in the built `package.json` hold the same value.
- It follows semver over what the entry exports. Below `1.0.0`, a minor release may change the surface.
- To pin it, build from a Maestro commit or tag, keep that `dist/maestro-lib/` folder, and check the version at startup:

```ts
import { MAESTRO_LIB_VERSION } from 'maestro-lib';

const SUPPORTED = '0.1.';

if (!MAESTRO_LIB_VERSION.startsWith(SUPPORTED)) {
	throw new Error(`This tool needs maestro-lib ${SUPPORTED}x, found ${MAESTRO_LIB_VERSION}`);
}
```

Import from `maestro-lib` only. The files under `types/` mirror the library's internal modules; they are there for the declarations, and their paths can change in any release.

## Run a first turn

`planSessionTurn` turns an agent id, a folder and a prompt into a process spec. `runToCompletion` starts it and resolves once the agent has exited.

```ts
import { BACKGROUND_STOP_GRACE_MS, planSessionTurn, runToCompletion } from 'maestro-lib';

export async function askOnce(cwd: string, prompt: string): Promise<string | undefined> {
	const planned = await planSessionTurn({ agentId: 'claude-code', cwd, prompt });
	if (!planned.ok) {
		throw new Error(`${planned.reason}: ${planned.error}`);
	}

	const turn = await runToCompletion(planned.spec, {
		agentId: 'claude-code',
		sessionId: 'my-tool',
		stopGraceMs: BACKGROUND_STOP_GRACE_MS,
	});
	return turn.answerText;
}
```

The request (`SessionTurnRequest`) takes:

| Field             | Meaning                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `agentId`         | The provider, for example `claude-code`.                                                                       |
| `cwd`             | The folder the agent works in. It must exist; a missing folder ends the turn as `crashed`.                     |
| `prompt`          | What to send.                                                                                                  |
| `resumeSessionId` | The session to continue. See [Resume a session](#resume-a-session).                                            |
| `model`           | A model id the provider accepts.                                                                               |
| `readOnly`        | The agent may read but not change anything. Refused for a provider that cannot enforce it.                     |
| `command`         | The provider's binary, when it is not on `PATH` or in its usual install location.                              |
| `envVars`         | Environment variables for this turn. They are set over your program's environment and the provider's defaults. |
| `querySource`     | `'user'`, `'auto'` or `'cue'`: who asked for the turn. It is passed to the agent as `MAESTRO_QUERY_SOURCE`.    |

The run options (`RunTurnOptions`) need three fields. `agentId` is the same provider. `sessionId` is a label for your program, used in log lines; it is not the provider's session id, and a fixed name such as `'my-tool'` is fine. `stopGraceMs` is how long each stop stage waits before the next one: `INTERACTIVE_STOP_GRACE_MS` (2 seconds) for a turn someone is watching, `BACKGROUND_STOP_GRACE_MS` (5 seconds) for an unattended one.

The agent's environment is your program's environment, then the provider's defaults for any variable your environment leaves unset, then `envVars`. This is the order `maestro-cli` uses.

## Stream the reply

`runTurn` returns at once with a handle and a promise. The handlers are called while the agent runs. Each line the provider's parser understands arrives in `onEvent` as a `ParsedEvent`.

```ts
import { INTERACTIVE_STOP_GRACE_MS, planSessionTurn, runTurn, type ParsedEvent } from 'maestro-lib';

function show(event: ParsedEvent): void {
	switch (event.type) {
		case 'init':
			if (event.sessionId) console.log(`[session ${event.sessionId}]`);
			break;
		case 'text':
			if (!event.isReasoning && event.text) process.stdout.write(event.text);
			break;
		case 'tool_use':
			console.log(`\n[tool ${event.toolName ?? 'unknown'}]`);
			break;
		case 'usage':
			if (event.usage) console.log(`\n[${event.usage.outputTokens} tokens out]`);
			break;
		case 'error':
			console.error(`\n[error] ${event.text ?? ''}`);
			break;
		default:
			break;
	}
}

export async function streamTurn(cwd: string, prompt: string): Promise<void> {
	const planned = await planSessionTurn({ agentId: 'opencode', cwd, prompt });
	if (!planned.ok) throw new Error(planned.error);

	const { completed } = runTurn(
		planned.spec,
		{ agentId: 'opencode', sessionId: 'my-tool', stopGraceMs: INTERACTIVE_STOP_GRACE_MS },
		{
			onStarted: (pid) => console.log(`[started, pid ${pid ?? 'unknown'}]`),
			onEvent: (event) => show(event),
		}
	);
	await completed;
}
```

The event types:

| `type`     | Carries                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `init`     | `sessionId` when the provider announces it at the start.                                                                     |
| `text`     | `text`. `isPartial` marks a fragment of a longer message; `isReasoning` marks the agent's thinking, which is not the answer. |
| `tool_use` | `toolName`, `toolCallId`, and `toolState`, whose shape is the provider's own.                                                |
| `usage`    | `usage`: `inputTokens`, `outputTokens`, and for some providers cache tokens, `costUsd` and `contextWindow`.                  |
| `result`   | The provider's final message. `text` is the answer when the provider sends one.                                              |
| `error`    | `text`, an error the provider reported in its stream.                                                                        |
| `system`   | A provider message that is not part of the conversation.                                                                     |

Providers differ in which events they send and how they split text. Show events as they arrive, and use `CompletedTurn.answerText` for the final answer: it is the result text when the provider sent one, and otherwise the text streamed during the turn.

The other handlers are `onStdout` and `onStderr` (raw chunks), `onLine` (each stdout line before parsing), `onOversizedLine` (output dropped because a line grew past the limit) and `onStdinError` (the prompt could not be written to the agent). Every handler for a chunk returns before the next chunk is read, and all of them return before `completed` resolves.

## Resume a session

The provider keeps the conversation. A finished turn returns its `sessionId`; pass it as `resumeSessionId` to send the next message in the same conversation. `planned.resuming` is `true` when the plan resumes one.

```ts
import {
	BACKGROUND_STOP_GRACE_MS,
	planSessionTurn,
	runToCompletion,
	type CompletedTurn,
} from 'maestro-lib';

async function send(cwd: string, prompt: string, resumeSessionId?: string): Promise<CompletedTurn> {
	const planned = await planSessionTurn({ agentId: 'claude-code', cwd, prompt, resumeSessionId });
	if (!planned.ok) throw new Error(planned.error);
	return runToCompletion(planned.spec, {
		agentId: 'claude-code',
		sessionId: 'my-tool',
		stopGraceMs: BACKGROUND_STOP_GRACE_MS,
	});
}

export async function conversation(cwd: string): Promise<void> {
	const first = await send(cwd, 'Name one prime number.');
	if (!first.sessionId) throw new Error('The provider did not report a session id');

	const second = await send(cwd, 'Now name the next one.', first.sessionId);
	console.log(second.answerText);
}
```

Store the session id if your program should continue the conversation after a restart. Each provider keeps its sessions in its own files, so the id only works on the machine (and for the account) that created it.

## Stop a turn

A running turn is stopped through its `TurnHandle`:

| Method                        | What it does                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `interrupt()`                 | Stops the way a user does: an interrupt first, so the agent can end its turn, then terminate, then kill, each after `stopGraceMs`.   |
| `terminate()`                 | Skips the interrupt: terminate, then kill. For a timeout or a cancelled job.                                                         |
| `terminateNow({ blocking? })` | Runs every stage at once with no grace period, for a program that is about to exit. `blocking` also waits for `taskkill` on Windows. |
| `stopRequested()`             | Whether a stop has been asked for.                                                                                                   |

A stop also ends the processes the agent started during the turn (a shell command a tool was running, for example), once the agent has exited. A turn you stopped resolves with outcome `interrupted`, whatever the process's exit code says.

```ts
import {
	INTERACTIVE_STOP_GRACE_MS,
	planSessionTurn,
	runTurn,
	type CompletedTurn,
} from 'maestro-lib';

export async function runWithStop(
	cwd: string,
	prompt: string,
	timeoutMs: number
): Promise<CompletedTurn> {
	const planned = await planSessionTurn({ agentId: 'codex', cwd, prompt });
	if (!planned.ok) throw new Error(planned.error);

	const { handle, completed } = runTurn(planned.spec, {
		agentId: 'codex',
		sessionId: 'my-tool',
		stopGraceMs: INTERACTIVE_STOP_GRACE_MS,
	});

	// Ctrl+C stops the turn the way a user would; a second Ctrl+C ends it at once.
	const onSigint = (): void => {
		if (handle.stopRequested()) handle.terminateNow({ blocking: true });
		else handle.interrupt();
	};
	process.on('SIGINT', onSigint);

	// A turn that runs too long is terminated without the interrupt stage.
	const timer = setTimeout(() => handle.terminate(), timeoutMs);

	try {
		return await completed;
	} finally {
		clearTimeout(timer);
		process.off('SIGINT', onSigint);
	}
}
```

You can also pass an `AbortSignal` as `signal` in the run options. Aborting it stops the turn from `terminate`.

## Read the outcome

`completed` resolves with a `CompletedTurn`:

| Field        | Meaning                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `outcome`    | `completed`, `completed-with-warning`, `interrupted` or `crashed`.                                          |
| `answerText` | The answer, or `undefined` when there was none.                                                             |
| `sessionId`  | The provider's session id, for the next turn's `resumeSessionId`.                                           |
| `usage`      | Token and cost totals for this turn (`UsageStats`), when the provider reported them.                        |
| `error`      | An `AgentError` when the turn crashed on a failure the library could classify.                              |
| `exit`       | `TurnExit`: `exitCode`, `signal`, `interrupted`, a tail of `stderrText` and `stdoutText`, and `spawnError`. |

The outcomes:

- `completed`: the agent finished its turn.
- `completed-with-warning`: there is an answer, but the agent exited with an error code or never sent its final result message. Show the answer, and flag it.
- `interrupted`: you stopped it.
- `crashed`: the agent failed. `error.type` names the cause when it is known, for example `auth_expired`, `rate_limited`, `token_exhaustion`, `network_error` or `agent_crashed` (the full list is the `AgentErrorType` type), and `error.message` describes it. A crash with no `error` (killed by a signal you did not send, for example) is described by `exit`.

```ts
import type { CompletedTurn } from 'maestro-lib';

export function describeTurn(turn: CompletedTurn): string {
	switch (turn.outcome) {
		case 'completed':
			return turn.answerText ?? '(no answer)';
		case 'completed-with-warning':
			return `${turn.answerText ?? ''}\n(warning: the agent exited with code ${turn.exit.exitCode})`;
		case 'interrupted':
			return '(stopped)';
		case 'crashed': {
			if (turn.exit.spawnError) return `Could not start the agent: ${turn.exit.spawnError.message}`;
			if (turn.error) return `${turn.error.type}: ${turn.error.message}`;
			const how = turn.exit.signal ? `signal ${turn.exit.signal}` : `code ${turn.exit.exitCode}`;
			return `The agent exited with ${how}: ${turn.exit.stderrText.trim()}`;
		}
	}
}
```

## Host hooks

The library sends log lines and error reports to whatever your program registers. All hooks are optional; without them, log lines and reports are dropped.

```ts
import { setMaestroLibErrorReporter, setMaestroLibLogger } from 'maestro-lib';

const debug = process.env.MY_TOOL_DEBUG === '1';

setMaestroLibLogger({
	debug: (message, context) => {
		if (debug) console.error(`[debug] ${context ?? ''} ${message}`);
	},
	info: (message, context) => console.error(`[info] ${context ?? ''} ${message}`),
	warn: (message, context) => console.error(`[warn] ${context ?? ''} ${message}`),
	error: (message, context, data) =>
		console.error(`[error] ${context ?? ''} ${message}`, data ?? ''),
});

setMaestroLibErrorReporter({
	captureException: (error, extra) => console.error('[report]', error, extra ?? ''),
	captureMessage: (message, level, extra) =>
		console.error(`[report ${level ?? 'error'}]`, message, extra ?? ''),
});
```

Log lines go to the logger you register at the time of the call, so register hooks once at startup. Keep the library's output on stderr if your program prints results on stdout.

Two more hooks exist for hosts that have the data: `setMaestroLibImageRefResolver` resolves Maestro's `maestro-image://` image references (without it, such a reference is treated as unreadable), and `setMaestroLibCapabilitySnapshotLookup` supplies live per-agent capability data (without it, context windows fall back to built-in defaults). A program that is not Maestro does not need either.

## Lower-level pieces

`planSessionTurn` and `runTurn` cover a program that runs turns. The entry also exports the steps they are made of, for a program that needs more control:

- **Plan:** `buildAgentArgs` (the provider's arguments, resume included), `buildAgentLaunchPlan` (environment and prompt delivery), `turnProcessSpecFromPlan`, and `checkBinaryExists` / `checkCustomPath` to find a provider's binary.
- **Run:** `startTurn` starts and streams a turn and reports how the process ended, without deciding whether it succeeded. `TurnCapture` folds its events into an answer, session id and usage, and `resolveTurnOutcome` decides the outcome. `runTurn` is these three together.
- **Stop:** `stopProcess` runs the same stop stages on a process you started yourself; `snapshotProcessTree` and `killProcessTreeNow` record and end what it started.
- **Parsers:** `createOutputParser(agentId)` returns a new parser for one stream. `initializeOutputParsers()`, then `getOutputParser(agentId)`, gives a shared instance for read-only checks.

```ts
import {
	BACKGROUND_STOP_GRACE_MS,
	createOutputParser,
	resolveTurnOutcome,
	startTurn,
	TurnCapture,
	type TurnOutcome,
	type TurnProcessSpec,
} from 'maestro-lib';

export async function runByHand(spec: TurnProcessSpec, agentId: string): Promise<TurnOutcome> {
	const parser = createOutputParser(agentId);
	if (!parser) throw new Error(`No parser for ${agentId}`);

	const capture = new TurnCapture(agentId, parser);
	const handle = startTurn(
		spec,
		{ onEvent: (event) => capture.handleEvent(event) },
		{ parser, stopGraceMs: BACKGROUND_STOP_GRACE_MS }
	);
	const exit = await handle.done;

	const { outcome } = resolveTurnOutcome(
		{
			exitCode: exit.exitCode,
			signal: exit.signal,
			interrupted: exit.interrupted,
			stderrText: exit.stderrText,
			stdoutText: exit.stdoutText,
			explicitError: capture.inBandError,
			stdinError: exit.stdinError,
			capturedAnswerText: capture.answerText,
			resultMessageSeen: capture.resultMessageSeen,
		},
		parser,
		{ providerId: agentId, sessionId: 'my-tool' }
	);
	return outcome;
}
```

## See also

- [Maestro CLI](./cli) for running agents and playbooks from a shell.
- [Running Cue on a Server](./maestro-cue-server) for unattended pipelines.
- `maestro-lib-run`, a small program in the Maestro build that runs one turn with these same calls and prints JSON lines. Its source, `src/shared/maestro-lib/bin/run-turn.ts`, is a complete example.
