import type { TurnOutcome } from '../../shared/maestro-lib/streaming/turn-outcome';
import type { CueRunStatus } from './cue-types';

export interface CueTurnFacts {
	outcome: TurnOutcome;
	exitCode: number | null;
	answerCaptured: boolean;
	killedBySignal: boolean;
}

/**
 * Map a shared turn outcome onto Cue's run status. `completed-with-warning` (a
 * full answer, then a bad exit) is a success per the turn contract; Cue used to
 * record it as `failed`. `timeout` never comes from here - Cue's own watchdog
 * sets it without consulting the resolver.
 */
function cueStatusForOutcome(outcome: TurnOutcome): CueRunStatus {
	switch (outcome) {
		case 'interrupted':
			return 'stopped';
		case 'crashed':
			return 'failed';
		default:
			return 'completed';
	}
}

/**
 * Resolve the CueRunStatus for a turn given the outcome from resolveTurnOutcome
 * and Cue's safety override rules.
 *
 * Two rules are applied on top of the resolver, because a pipeline must not
 * chain off a silent failure or a truncated answer:
 * - A non-zero exit that captured nothing is `failed`, even when the resolver
 *   leaves it as `completed` (which is where parser-less agents land).
 * - A signal kill nobody requested is `failed` however much text had streamed by
 *   then (`interrupted` is handled above, so this signal was not ours).
 */
export function cueStatusForTurn(facts: CueTurnFacts): CueRunStatus {
	const nonZeroWithoutAnswer =
		facts.exitCode !== 0 && facts.exitCode !== null && !facts.answerCaptured;
	const killedBySignal = facts.killedBySignal;

	if (facts.outcome !== 'interrupted' && (nonZeroWithoutAnswer || killedBySignal)) {
		return 'failed';
	}

	return cueStatusForOutcome(facts.outcome);
}
