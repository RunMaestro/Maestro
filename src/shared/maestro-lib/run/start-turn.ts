// src/shared/maestro-lib/run/start-turn.ts

import { spawn, type ChildProcess } from 'child_process';

import type { AgentOutputParser, ParsedEvent } from '../parsers/agent-output-parser';
import { createOutputParser } from '../parsers/parser-factory';
import { BufferedLineReader } from '../streaming/buffered-line-reader';
import { stopProcess, type StopHandle, type StopStage } from '../control/termination';
import type { AgentLaunchPlan } from '../launch/launch-plan';

/**
 * A sensible cap on one buffered stdout line, for a caller that wants one.
 * `startTurn` itself buffers without limit unless told otherwise.
 */
export const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024;

/** How much stdout is kept for exit classification; providers only pattern-match it. */
export const DEFAULT_STDOUT_TAIL_LIMIT = 256 * 1024;

/**
 * A sensible cap on the stderr kept for exit classification, for a caller that
 * wants one. `startTurn` itself keeps all of it unless told otherwise.
 */
export const DEFAULT_STDERR_TAIL_LIMIT = 256 * 1024;

/** Exactly what to start: the last word after planning and any SSH or wrapper step. */
export interface TurnProcessSpec {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	/**
	 * Written to the child's stdin, which is then closed: a prompt the launch
	 * plan chose to deliver over stdin, or the script an SSH remote runs.
	 */
	stdin?: string;
	/**
	 * Run the command through a shell: `true` for the platform default, or the
	 * shell's path. Needed on Windows for a bare `.exe` name (PATH resolution),
	 * a `.cmd` / `.bat` shim, or a shebang script.
	 */
	shell?: boolean | string;
}

/** A launch plan for this machine: the one kind that carries a full environment. */
export type LocalLaunchPlan = Extract<AgentLaunchPlan, { env: NodeJS.ProcessEnv }>;

/**
 * The process spec for a LOCAL launch plan. A remote plan describes the remote
 * invocation, so it goes through the SSH wrapper first and the caller builds
 * the spec from what that returns.
 */
export function turnProcessSpecFromPlan(plan: LocalLaunchPlan): TurnProcessSpec {
	return {
		command: plan.command,
		args: plan.args,
		cwd: plan.cwd,
		env: plan.env,
		stdin: plan.stdin,
	};
}

/**
 * What the caller hears while the turn runs. Every handler for a given chunk
 * has returned before the next chunk is read, and every handler has returned
 * before `done` resolves, so a caller that settles on `done` has seen it all.
 */
export interface TurnHandlers {
	/** The process was started. Fires once, before any output. */
	onStarted?(pid: number | undefined): void;
	/** Each stdout chunk as it arrived, before it is split into lines. */
	onStdout?(text: string): void;
	onStderr?(text: string): void;
	/** Each complete stdout line, including an unterminated last one at exit. */
	onLine?(line: string): void;
	/** Each line the provider's parser understood. */
	onEvent?(event: ParsedEvent, line: string): void;
	/**
	 * Output was discarded because no complete line arrived within
	 * `maxLineLength`. Dropping is silent data loss otherwise.
	 */
	onOversizedLine?(droppedBytes: number): void;
	/**
	 * The child's stdin failed. EPIPE is the common one: a prompt written to a
	 * process that has already gone. It is reported here and never thrown; the
	 * exit that follows says what happened to the turn.
	 */
	onStdinError?(error: Error): void;
}

export interface StartTurnOptions {
	/**
	 * The provider whose parser reads the stream. Each turn gets its OWN parser
	 * instance: parsers keep per-stream state, and two turns of one provider
	 * sharing an instance would read each other's. Omit for output that is not
	 * parsed.
	 */
	agentId?: string;
	/**
	 * The parser to read the stream with, for a caller that built it before
	 * starting (to fail fast on an unknown provider). Wins over `agentId`.
	 */
	parser?: AgentOutputParser;
	/** How long each stop stage gets before the next one runs. */
	stopGraceMs: number;
	/** Aborting this stops the turn, from `terminate`. */
	signal?: AbortSignal;
	/**
	 * What the child gets for stdin when there is nothing to write. `pipe`
	 * opens one and closes it at once; `ignore` gives it the null device, for a
	 * CLI that announces it is waiting on stdin before it notices the close.
	 */
	emptyStdin?: 'pipe' | 'ignore';
	/**
	 * Leave stdin open after writing (or with nothing written), for a process
	 * the caller keeps talking to through `TurnHandle.child.stdin`: an
	 * interactive agent that reads its prompts as they come.
	 */
	keepStdinOpen?: boolean;
	/**
	 * Longest partial line held before it is dropped, to bound memory against
	 * a stream that never ends a line. No limit when omitted.
	 */
	maxLineLength?: number;
	/**
	 * How much of stdout `TurnExit.stdoutText` keeps: the most recent
	 * characters. `0` keeps none, for a caller that reads the stream through
	 * its handlers and holds its own copy.
	 */
	stdoutTailLimit?: number;
	/**
	 * How much of stderr `TurnExit.stderrText` keeps: the most recent
	 * characters. No limit when omitted, because a caller may show the text as
	 * its error message. `0` keeps none.
	 */
	stderrTailLimit?: number;
	sessionId?: string;
	label?: string;
}

/** What is known about the turn once its process is gone. */
export interface TurnExit {
	/** Null when a signal ended the process, or when it never started. */
	exitCode: number | null;
	/** The signal that ended the process, as the OS reported it. */
	signal: NodeJS.Signals | null;
	/** A stop was requested through the handle or the abort signal. */
	interrupted: boolean;
	/** All of stderr, or its tail when `stderrTailLimit` is set. */
	stderrText: string;
	/** A bounded tail of stdout. */
	stdoutText: string;
	/** Bytes discarded because no complete line arrived within `maxLineLength`. */
	droppedOutputBytes: number;
	/** Set when the process could not be started. */
	spawnError?: Error;
	/**
	 * Set when writing the prompt to stdin failed, most often EPIPE from a
	 * process that closed its end before reading it. The agent never got the
	 * whole prompt, so the turn is not a success whatever its exit code says.
	 */
	stdinError?: Error;
}

export interface TurnHandle {
	readonly pid: number | undefined;
	/**
	 * The process itself, for a caller that tracks its runs by handle (a process
	 * registry). Stop it through this object's methods, not through the child.
	 */
	readonly child: ChildProcess;
	/** The parser reading this turn's stream, if any. */
	readonly parser: AgentOutputParser | null;
	/** Stop the way a user does: interrupt, then terminate, then kill the tree. */
	interrupt(): void;
	/** Stop without the interrupt stage: a timeout, a closed tab, an aborted run. */
	terminate(): void;
	/**
	 * Stop at once, for a host that is about to exit. Runs every stage with no
	 * grace period; `blocking` also waits for `taskkill` on Windows.
	 */
	terminateNow(options?: { blocking?: boolean }): void;
	stopRequested(): boolean;
	readonly done: Promise<TurnExit>;
}

/** `current + chunk`, cut to its last `limit` characters. No cut when `limit` is undefined. */
function appendBoundedTail(current: string, chunk: string, limit: number | undefined): string {
	if (limit === 0) return '';
	const combined = current + chunk;
	if (limit === undefined || combined.length <= limit) return combined;
	return combined.slice(combined.length - limit);
}

/**
 * Start one agent turn and stream it.
 *
 * This is the part every launcher used to write for itself: start the process,
 * deliver the prompt, decode and frame stdout, parse each line, stop on
 * request, and report how the process ended. It decides nothing about whether
 * the turn SUCCEEDED; the caller resolves that from `TurnExit` with its own
 * policy (`resolveTurnOutcome`), and keeps its own timeouts.
 *
 * Throws when the process cannot even be created (a bad option). A command
 * that does not exist is reported through `done` as `spawnError`, since the OS
 * only says so after `spawn` has returned.
 */
export function startTurn(
	spec: TurnProcessSpec,
	handlers: TurnHandlers,
	options: StartTurnOptions
): TurnHandle {
	const hasStdin = spec.stdin !== undefined && spec.stdin !== '';
	const stdinMode = hasStdin ? 'pipe' : (options.emptyStdin ?? 'pipe');

	const child = spawn(spec.command, spec.args, {
		cwd: spec.cwd,
		env: spec.env,
		shell: spec.shell ?? false,
		stdio: [stdinMode, 'pipe', 'pipe'],
	});

	const parser = options.parser ?? (options.agentId ? createOutputParser(options.agentId) : null);
	const tailLimit = options.stdoutTailLimit ?? DEFAULT_STDOUT_TAIL_LIMIT;

	let droppedOutputBytes = 0;
	const lineReader = new BufferedLineReader({
		maxBufferLength: options.maxLineLength,
		onOversized: (dropped) => {
			droppedOutputBytes += dropped;
			handlers.onOversizedLine?.(dropped);
		},
	});

	let stdoutText = '';
	let stderrText = '';
	let stdinError: Error | undefined;
	let stopWasRequested = false;
	let settled = false;
	let stopLadder: StopHandle | undefined;

	const stop = (from: StopStage, extra: { immediate?: boolean; blocking?: boolean } = {}): void => {
		stopLadder = stopProcess(
			{ child },
			{
				from,
				graceMs: options.stopGraceMs,
				onStopRequested: () => {
					stopWasRequested = true;
				},
				sessionId: options.sessionId,
				label: options.label,
				...extra,
			}
		);
	};

	const readLine = (line: string): void => {
		handlers.onLine?.(line);
		if (!parser || !handlers.onEvent) return;
		const event = parser.parseJsonLine(line);
		if (event) handlers.onEvent(event, line);
	};

	// A caller that takes only the raw stream (desktop chat, which frames it
	// itself) has no use for lines, so none are buffered for it.
	const framesLines = Boolean(handlers.onLine || handlers.onEvent);

	const onAbort = (): void => stop('terminate');

	const done = new Promise<TurnExit>((resolve) => {
		const settle = (exit: Pick<TurnExit, 'exitCode' | 'signal' | 'spawnError'>): void => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener('abort', onAbort);
			// The ladder ends itself when the process exits. This covers a turn
			// that settles with no exit to hear: a process that never started.
			stopLadder?.dispose();
			resolve({
				...exit,
				interrupted: stopWasRequested,
				stderrText,
				stdoutText,
				droppedOutputBytes,
				...(stdinError ? { stdinError } : {}),
			});
		};

		// Decode on the stream, not per chunk: a multibyte character split across
		// two reads would otherwise decode to replacement characters on both
		// sides of the boundary.
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');

		child.stdout?.on('data', (text: string) => {
			stdoutText = appendBoundedTail(stdoutText, text, tailLimit);
			handlers.onStdout?.(text);
			if (framesLines) for (const line of lineReader.push(text)) readLine(line);
		});

		child.stderr?.on('data', (text: string) => {
			stderrText = appendBoundedTail(stderrText, text, options.stderrTailLimit);
			handlers.onStderr?.(text);
		});

		// `close`, not `exit`: it fires once the streams have ended, so every
		// line the process wrote has been read by the time the turn settles.
		child.on('close', (exitCode, signal) => {
			// The last line may have no trailing newline.
			const trailing = lineReader.flush();
			if (trailing) readLine(trailing);
			// Node reports each as a value or null. Anything else is "none".
			settle({ exitCode: exitCode ?? null, signal: signal ?? null });
		});

		child.on('error', (error) => {
			settle({ exitCode: null, signal: null, spawnError: error });
		});
	});

	handlers.onStarted?.(child.pid);

	// A stream error with no listener is an uncaught exception, and it would
	// take the host down with it. The process closing its end of the pipe
	// before the prompt is written (EPIPE) is an ordinary way for a turn to
	// fail, and the exit that follows reports it.
	child.stdin?.on('error', (error) => handlers.onStdinError?.(error));

	// Only the prompt's own write counts against the turn. A later write by a
	// caller that keeps stdin open is that caller's to report.
	if (hasStdin) {
		child.stdin?.write(spec.stdin, (error) => {
			if (error) stdinError ??= error;
		});
	}
	if (!options.keepStdinOpen) child.stdin?.end();

	if (options.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener('abort', onAbort, { once: true });
	}

	return {
		pid: child.pid,
		child,
		parser,
		interrupt: () => stop('interrupt'),
		terminate: () => stop('terminate'),
		terminateNow: ({ blocking = false } = {}) => stop('terminate', { immediate: true, blocking }),
		stopRequested: () => stopWasRequested,
		done,
	};
}
