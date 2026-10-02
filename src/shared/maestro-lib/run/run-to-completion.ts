// src/shared/maestro-lib/run/run-to-completion.ts

import type { AgentError, UsageStats } from '../../types';
import { createOutputParser } from '../parsers/parser-factory';
import {
	resolveTurnOutcome,
	type ResolveTurnOutcomeOptions,
	type TurnOutcome,
} from '../streaming/turn-outcome';
import {
	startTurn,
	DEFAULT_MAX_LINE_LENGTH,
	type StartTurnOptions,
	type TurnExit,
	type TurnHandle,
	type TurnHandlers,
	type TurnProcessSpec,
} from './start-turn';
import { TurnCapture } from './turn-capture';

export interface RunTurnOptions extends Omit<StartTurnOptions, 'parser'> {
	/** The provider being run. Required: a turn with no parser has no answer to return. */
	agentId: string;
	/**
	 * Label handed to the outcome resolver, which exempts a few session shapes
	 * (terminal, synopsis, tab naming) from its empty-answer rule by name.
	 */
	sessionId: string;
	/** The caller's completion policy, passed to `resolveTurnOutcome` as given. */
	outcome?: ResolveTurnOutcomeOptions;
}

/** One finished turn, with everything a caller needs to report it or continue it. */
export interface CompletedTurn {
	outcome: TurnOutcome;
	answerText: string | undefined;
	/** The provider's session id. Pass it back as the resume id to continue. */
	sessionId: string | undefined;
	usage: UsageStats | undefined;
	/**
	 * The classified failure, when the turn crashed on one. A crash with no
	 * classification (a signal nobody asked for, an empty answer) has none, and
	 * the caller words it from `exit`.
	 */
	error: AgentError | undefined;
	exit: TurnExit;
}

export interface RunningTurn {
	handle: TurnHandle;
	completed: Promise<CompletedTurn>;
}

/** Thrown before anything is spawned when the provider has no output parser. */
export class UnknownProviderError extends Error {
	constructor(readonly agentId: string) {
		super(`No output parser is registered for agent "${agentId}"`);
		this.name = 'UnknownProviderError';
	}
}

/**
 * Start a turn, stream it to `handlers`, and resolve its outcome once the
 * process is gone.
 *
 * The buffered form of `startTurn`: it folds the stream into an answer, a
 * session id and a usage total (`TurnCapture`) and asks the shared resolver
 * what the turn amounted to. A caller that needs the stream as it arrives
 * passes `handlers`; one that only needs the result awaits `completed`.
 *
 * Throws `UnknownProviderError` before spawning when the provider has no
 * parser, so a misconfigured agent never leaves a process behind.
 */
export function runTurn(
	spec: TurnProcessSpec,
	options: RunTurnOptions,
	handlers: TurnHandlers = {}
): RunningTurn {
	const { agentId, outcome: outcomeOptions, ...startOptions } = options;
	const parser = createOutputParser(agentId);
	if (!parser) throw new UnknownProviderError(agentId);

	const capture = new TurnCapture(agentId, parser);
	const handle = startTurn(
		spec,
		{
			...handlers,
			onEvent: (event, line) => {
				capture.handleEvent(event);
				handlers.onEvent?.(event, line);
			},
		},
		{ maxLineLength: DEFAULT_MAX_LINE_LENGTH, ...startOptions, parser }
	);

	const completed = handle.done.then((exit): CompletedTurn => {
		const spawnFailure: AgentError | undefined = exit.spawnError
			? {
					type: 'agent_crashed',
					message: `Failed to start ${spec.command}: ${exit.spawnError.message}`,
					recoverable: false,
					agentId,
					timestamp: Date.now(),
				}
			: undefined;

		const { outcome, error } = resolveTurnOutcome(
			{
				exitCode: exit.exitCode,
				signal: exit.signal,
				interrupted: exit.interrupted,
				stderrText: exit.stderrText,
				stdoutText: exit.stdoutText,
				explicitError: spawnFailure ?? capture.inBandError,
				capturedAnswerText: capture.answerText,
				resultMessageSeen: capture.resultMessageSeen,
			},
			parser,
			{ providerId: agentId, sessionId: options.sessionId },
			outcomeOptions
		);

		return {
			outcome,
			answerText: capture.answerText,
			sessionId: capture.sessionId,
			usage: capture.usage,
			error,
			exit,
		};
	});

	return { handle, completed };
}

/** `runTurn` for a caller that only wants the finished turn. */
export function runToCompletion(
	spec: TurnProcessSpec,
	options: RunTurnOptions,
	handlers?: TurnHandlers
): Promise<CompletedTurn> {
	return runTurn(spec, options, handlers).completed;
}
