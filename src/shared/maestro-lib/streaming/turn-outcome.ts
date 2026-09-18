/**
 * Turn outcome resolution - maestro-lib Part Two.
 *
 * Implements the "1. Turn termination" section of
 * `Plans/maestro-lib-turn-contract.md`: a single, pure, provider-agnostic
 * function that maps the facts a running turn produced onto one of four
 * outcomes. Desktop chat, the CLI, and Cue currently reimplement this
 * independently and disagree (see the contract doc's "Why this exists"
 * section); this module is the one place the logic lives once migration
 * lands.
 *
 * `resolveTurnOutcome` does not decide whether the exit should be processed
 * at all - the caller must apply the spawn-generation/supersession check
 * (`ExitHandler.ts:114-121`) before calling this, since a superseded exit
 * produces no outcome, not `crashed`. It also does not perform provisional-
 * error resolution, SSH transport-error matching, or Copilot's async
 * post-exit reconciliation - those all feed into `TurnFacts.explicitError`
 * and `TurnFacts.capturedAnswerText` before this function runs; by the time
 * `TurnFacts` exists, those are already resolved.
 */

import type { AgentError } from '../../types';

export type TurnOutcome = 'completed' | 'completed-with-warning' | 'interrupted' | 'crashed';

/**
 * The facts a completed (non-superseded) turn produced, assembled by the
 * streaming layer from whatever transport is in play. See the contract
 * doc's "The facts the library reports" for the provenance of each field.
 */
export interface TurnFacts {
	exitCode: number | null;
	/**
	 * Raw signal value from the transport. Typed loosely on purpose: PTY
	 * transports report a number (node-pty), child_process transports
	 * report a string (e.g. 'SIGTERM') and today do not capture it at all.
	 * See the turn contract's open question on signal typing before reading
	 * anything provider-specific into this field's shape.
	 */
	signal: string | number | null;
	/** The caller explicitly requested stop before/at exit. */
	interrupted: boolean;
	stderrText: string;
	stdoutText: string;
	/** A resolved (non-provisional) error, if one was already raised. */
	explicitError: AgentError | undefined;
	capturedAnswerText: string | undefined;
	/** The provider sent an explicit "done"/result event (distinct from
	 * merely having produced text - see the contract's `resultMessageSeen`
	 * note on why these two are not the same boolean). */
	resultMessageSeen: boolean;
}

/** The subset of `AgentOutputParser` the resolver needs. */
export interface TurnOutcomeProvider {
	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null;
}

const OMP_EMPTY_ANSWER_SESSION_EXCLUSIONS: RegExp[] = [/-terminal$/, /-synopsis-/, /^tab-naming-/];

export interface ResolveTurnOutcomeOptions {
	/**
	 * When true, the "clean exit with nothing captured is never success"
	 * rule (see below) applies to every provider, not just omp. Defaults to
	 * false, which reproduces today's production behavior exactly
	 * (`ExitHandler.ts:324-353`) so a desktop chat migration onto this
	 * resolver is behavior-preserving by default. This is Open Question 2 in
	 * the turn contract - do not flip it without that question being
	 * explicitly resolved and reviewed, since it is a real, user-visible
	 * behavior change for every provider other than omp.
	 */
	generalizeEmptyAnswerRule?: boolean;
}

export interface TurnOutcomeResult {
	outcome: TurnOutcome;
	/**
	 * Populated whenever `outcome === 'crashed'` and there is a concrete,
	 * already-classified error to surface: `facts.explicitError` as given,
	 * or whatever `provider.detectErrorFromExit` returned. NOT populated for
	 * the empty-answer rule below - that failure has no upstream `AgentError`
	 * to reuse, and its message is provider-specific (e.g. omp's "exited
	 * without producing a response"); the caller constructs it.
	 */
	error?: AgentError;
}

/**
 * Resolve a turn's outcome from its facts. Pure - no I/O, no emission, no
 * mutation of its arguments.
 *
 * Precedence (see `Plans/maestro-lib-turn-contract.md`, section 1):
 *  1. `interrupted` wins outright, before any error is considered.
 *  2. An already-resolved `explicitError` -> crashed.
 *  3. The provider's own `detectErrorFromExit` -> crashed. `facts.exitCode`
 *     is coerced to `0` here when `null` (a signal-terminated process) purely
 *     because the provider callback's signature requires a `number` - this
 *     does NOT mean a signal-killed exit is treated as clean; rule 4 below
 *     independently catches the case where that coercion would otherwise let
 *     a signal kill masquerade as success.
 *  4. No captured answer AND no explicit done signal (`resultMessageSeen`)
 *     -> crashed, when either: the exit was signal-terminated (`facts.signal
 *     !== null`, checked for every provider - an abnormal termination with
 *     nothing to show for it is unambiguously a crash, not a provider-
 *     specific judgment call), or the empty-answer-on-clean-exit rule
 *     applies (omp today; see `generalizeEmptyAnswerRule`). Either way,
 *     the known excluded session shapes (terminal / synopsis / tab-naming
 *     runs) are exempt. Requiring `!resultMessageSeen` here (not just
 *     `!hasAnswer`) matters: a provider that already sent an explicit result
 *     event before being signal-killed or exiting empty-handed already
 *     completed its turn, and must not be reclassified as a crash just
 *     because `capturedAnswerText` happens to be empty at this call site.
 *  5. Clean exit with an explicit done signal -> completed.
 *  6. A captured answer despite a non-zero exit or a missing done signal ->
 *     completed-with-warning.
 *  7. Otherwise (no answer, not subject to rule 4, no other signal) ->
 *     completed. This is deliberately NOT `crashed`: it is the literal
 *     "indistinguishable from success" state every non-omp provider is left
 *     in today when nothing else fired, and changing that silently would be
 *     the same unreviewed behavior change rule 4 already flags.
 */
export function resolveTurnOutcome(
	facts: TurnFacts,
	provider: TurnOutcomeProvider,
	context: { providerId: string; sessionId: string },
	options: ResolveTurnOutcomeOptions = {}
): TurnOutcomeResult {
	if (facts.interrupted) {
		return { outcome: 'interrupted' };
	}

	if (facts.explicitError) {
		return { outcome: 'crashed', error: facts.explicitError };
	}

	const detected = provider.detectErrorFromExit(
		facts.exitCode ?? 0,
		facts.stderrText,
		facts.stdoutText
	);
	if (detected) {
		return { outcome: 'crashed', error: detected };
	}

	const hasAnswer = Boolean(facts.capturedAnswerText?.trim());

	if (!hasAnswer && !facts.resultMessageSeen) {
		const killedBySignal = facts.signal !== null;
		const emptyAnswerRuleApplies =
			killedBySignal || options.generalizeEmptyAnswerRule || context.providerId === 'omp';
		const isExcludedSession = OMP_EMPTY_ANSWER_SESSION_EXCLUSIONS.some((pattern) =>
			pattern.test(context.sessionId)
		);
		if (emptyAnswerRuleApplies && !isExcludedSession) {
			return { outcome: 'crashed' };
		}
	}

	if (facts.exitCode === 0 && facts.resultMessageSeen) {
		return { outcome: 'completed' };
	}

	if (hasAnswer) {
		return { outcome: 'completed-with-warning' };
	}

	return { outcome: 'completed' };
}
