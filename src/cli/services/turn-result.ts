/**
 * Turn result adapter for the CLI spawner.
 *
 * `spawnClaudeAgent` and `spawnJsonLineAgent` used to decide "did this turn
 * succeed?" with two different hand-written rules (`code === 0 && finalResult`
 * and `!errorText && (code === 0 || hasAnswer)`). Both now collect the same
 * `TurnFacts` the desktop chat collects and ask the shared
 * `resolveTurnOutcome` (src/shared/maestro-lib/streaming/turn-outcome.ts), so
 * the CLI, desktop chat and (later) Cue cannot disagree about it.
 *
 * This module is the only CLI-specific part: it translates the library's
 * four-valued outcome into the `AgentResult` shape every CLI caller already
 * consumes, and it keeps the two guarantees callers rely on that the library
 * deliberately leaves to its caller (see the notes on `strictEmptyAnswer` and
 * the non-zero-exit guard below).
 */

import type { AgentResult } from './agent-spawner';
import {
	resolveTurnOutcome,
	type TurnOutcomeProvider,
} from '../../shared/maestro-lib/streaming/turn-outcome';
import type { AgentError, ToolType, UsageStats } from '../../shared/types';

/**
 * CLI turns are never one of the excluded session shapes (terminal, synopsis,
 * tab naming) that the resolver's empty-answer rule exempts, so the session id
 * handed to it is only a label.
 */
const CLI_TURN_LABEL = 'cli-turn';

export interface CliTurnInput {
	toolType: ToolType;
	provider: TurnOutcomeProvider;
	/** Exit code from the `close` event; null when the process was signal-killed. */
	exitCode: number | null;
	/** Signal from the `close` event, if the process was signal-killed. */
	signal: string | null;
	/** The caller aborted the turn (AbortSignal) before or at exit. */
	interrupted: boolean;
	stderrText: string;
	/** Raw stdout (a bounded tail is enough; providers only pattern-match it). */
	stdoutText: string;
	/** An in-band error the provider reported in its stream, if any. */
	errorText?: string;
	/** The captured answer, from the result event or accumulated text. */
	answerText?: string;
	/** The provider sent an explicit result/done event (distinct from having text). */
	resultMessageSeen: boolean;
	agentSessionId?: string;
	usageStats?: UsageStats;
	/**
	 * A clean exit that captured nothing is a failure. Claude's CLI path has
	 * always behaved this way (`code === 0 && finalResult`); the generic
	 * JSON-line path has always accepted it. Each path passes what it did
	 * before so the migration onto the shared resolver is behavior-preserving -
	 * generalizing the rule is Open Question 2 in the turn contract.
	 */
	strictEmptyAnswer: boolean;
	/**
	 * A captured answer outranks a BARE bad exit (see `answerOutranksGenericExit`).
	 * The generic JSON-line path has always accepted that (Grok exits non-zero
	 * after `--max-turns` with its whole answer streamed). Claude's CLI path
	 * never did (`code === 0 && finalResult`), and neither does desktop, so it
	 * passes `false` and keeps failing a non-zero exit.
	 */
	answerOutranksBareExit: boolean;
	/**
	 * Bytes the line reader discarded because no complete line arrived within
	 * `MAX_LINE_BUFFER_LENGTH`. A drop with nothing captured is a FAILURE even on
	 * a clean exit: the answer may well have been the line that was thrown away,
	 * and the generic JSON-line path would otherwise report a completed turn with
	 * no response, which Auto Run counts as a finished task.
	 */
	droppedOutputBytes?: number;
}

function inBandError(toolType: ToolType, message: string): AgentError {
	return {
		type: 'unknown',
		message,
		recoverable: false,
		agentId: toolType,
		timestamp: Date.now(),
	};
}

function crashMessage(input: CliTurnInput, classified: AgentError | undefined): string {
	if (input.errorText) return input.errorText;
	if (input.stderrText) return input.stderrText;
	// Only when nothing was captured: with an answer in hand the drop is not what
	// failed the turn, and naming it would point at the wrong cause.
	if (input.droppedOutputBytes && !input.answerText?.trim()) {
		return `Agent produced no usable answer: ${input.droppedOutputBytes} bytes of output were discarded because no complete line arrived within the line buffer.`;
	}
	// A specific classification ("rate limit reached") explains more than the
	// generic fallback ("Agent exited with code 1"), which only restates the
	// exit code the caller's own wording already covers.
	if (classified && !isGenericExitFallback(classified)) return classified.message;
	if (input.signal) return `Process terminated by signal ${input.signal}`;
	return `Process exited with code ${input.exitCode}`;
}

/**
 * Every provider's `detectErrorFromExit` ends in "nothing matched -> generic
 * `agent_crashed` for any non-zero exit", worded "<name> exited with code N".
 * The shared error bank ALSO has `agent_crashed` patterns of its own ("fatal
 * error", "panic", "unexpected internal error"), so the type alone cannot tell
 * the two apart; the fallback's wording can, because no canned pattern message
 * uses it.
 */
const GENERIC_EXIT_FALLBACK = /exited with code \d+/;

function isGenericExitFallback(error: AgentError | null): boolean {
	return error?.type === 'agent_crashed' && GENERIC_EXIT_FALLBACK.test(error.message);
}

/**
 * Wrap the provider's exit classifier with the two CLI-specific rules:
 *
 * 1. A captured answer outranks the GENERIC fallback (when the caller opts in),
 *    and nothing else. A specific classification (auth, rate limit, token
 *    exhaustion, permission, a pattern-matched panic) still fails the turn, and
 *    so does an in-band error the provider reported.
 * 2. When an answer exists, classify from stderr only. Providers match
 *    `stderr + stdout`, and the streamed answer is stdout: an answer that
 *    merely mentions "401 Unauthorized" or "rate limit" must not turn a
 *    successful turn into a failure. ExitHandler is stderr-only for the same
 *    reason on the SSH path. With no answer, stdout is still consulted so a
 *    stdout-only failure is not lost.
 *
 * This is the CLI-vs-desktop divergence recorded by the `bad-exit-with-answer`
 * turn recording. It lives here, not in the shared resolver, so desktop
 * behavior is unchanged.
 */
function cliExitClassifier(input: CliTurnInput): TurnOutcomeProvider {
	const hasAnswer = Boolean(input.answerText?.trim());
	return {
		detectErrorFromExit: (exitCode, stderr, stdout) => {
			const detected = input.provider.detectErrorFromExit(
				exitCode,
				stderr,
				hasAnswer ? '' : stdout
			);
			if (
				input.answerOutranksBareExit &&
				hasAnswer &&
				!input.errorText &&
				isGenericExitFallback(detected)
			) {
				return null;
			}
			return detected;
		},
	};
}

/** Resolve one finished turn into the CLI's `AgentResult`. Pure. */
export function resolveCliTurnResult(rawInput: CliTurnInput): AgentResult {
	// A `close` event with no signal gives `null` in Node but is easy to hand in as
	// `undefined`; both mean "exited on its own".
	const input = { ...rawInput, signal: rawInput.signal ?? null };
	const carried = { agentSessionId: input.agentSessionId, usageStats: input.usageStats };

	const resolved = resolveTurnOutcome(
		{
			exitCode: input.exitCode,
			signal: input.signal,
			interrupted: input.interrupted,
			stderrText: input.stderrText,
			stdoutText: input.stdoutText,
			explicitError: input.errorText ? inBandError(input.toolType, input.errorText) : undefined,
			capturedAnswerText: input.answerText,
			resultMessageSeen: input.resultMessageSeen,
		},
		cliExitClassifier(input),
		{ providerId: input.toolType, sessionId: CLI_TURN_LABEL },
		{ generalizeEmptyAnswerRule: input.strictEmptyAnswer }
	);

	if (resolved.outcome === 'interrupted') {
		return { success: false, outcome: 'interrupted', error: 'Interrupted', ...carried };
	}

	// The resolver leaves "non-zero exit, nothing captured, no provider
	// classification" as `completed` (the state every provider that lacks a
	// matching `detectErrorFromExit` heuristic is left in). A CLI caller feeds
	// that straight into Auto Run bookkeeping, so it must not read as success.
	const hasAnswer = Boolean(input.answerText?.trim());
	const nonZeroWithoutAnswer = input.exitCode !== 0 && input.exitCode !== null && !hasAnswer;
	// A process killed by a signal nobody requested is never a success, however
	// much text it had streamed by then: the answer is truncated, and an Auto Run
	// task counted as done on a partial answer is worse than a visible failure.
	// (`interrupted` was handled above, so a signal here was not ours.)
	const killedBySignal = input.signal !== null;
	// `strictEmptyAnswer` must hold even when the provider sent an explicit (but
	// empty) result event: the resolver's own empty-answer rule is skipped once
	// `resultMessageSeen` is set, and Claude always sends one.
	const strictEmpty = input.strictEmptyAnswer && !hasAnswer;
	// Output was discarded and nothing was captured, so the dropped bytes may have
	// been the answer itself. Reporting `completed` here is the one failure the
	// line-buffer cap could otherwise introduce.
	const droppedTheAnswer = Boolean(input.droppedOutputBytes) && !hasAnswer;
	if (
		resolved.outcome === 'crashed' ||
		nonZeroWithoutAnswer ||
		killedBySignal ||
		strictEmpty ||
		droppedTheAnswer
	) {
		return {
			success: false,
			outcome: 'crashed',
			error: crashMessage(input, resolved.error),
			...carried,
		};
	}

	return {
		success: true,
		outcome: resolved.outcome,
		response: input.answerText,
		...carried,
	};
}

/** The caller aborted before a process was ever started. */
export function interruptedResult(): AgentResult {
	return { success: false, outcome: 'interrupted', error: 'Interrupted' };
}

/** A failure that happened before there was a turn to resolve (spawn error, unresolved SSH). */
export function spawnFailureResult(error: string): AgentResult {
	return { success: false, outcome: 'crashed', error };
}
