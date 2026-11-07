/**
 * Voice routing on System One: a decorator over whichever Brain is in force.
 *
 * When the `voice-routing` task is assigned to System One, the engine in force
 * (Jev, an OpenJev server or the local judge) decides which agent and tab a
 * spoken request is for, by answering typed questions
 * (`shared/acappella/voice-routing-system-one.ts`). The wrapped Brain is not
 * asked to route. It still writes everything that is SPOKEN, because an engine
 * returns a judgment and never text.
 *
 * It is a decorator, not a fourth Brain, for the reason the Conductor router is
 * one: the id, label and tier stay the wrapped provider's, and the router that
 * wraps this in turn still validates the decision against the roster, applies
 * the recall policy, and asks out loud when the confidence is low. Which engine
 * decided a turn is on the System One decision ledger.
 *
 * Three rules:
 *
 *   1. **Any other assignment changes nothing.** `runSystemOneTask` answers
 *      `not-assigned` without asking or recording anything, and the Brain routes
 *      as it always did. The assignment is read on every turn, so switching it
 *      takes effect on the next utterance with no rebuild.
 *   2. **A turn in which the Conductor may talk back stays with the Brain.**
 *      Conversational mode lets a turn end in a spoken reply instead of a
 *      dispatch, and only a Brain can write one. That is the split, not a
 *      fallback: an engine is never asked a question whose answer is a sentence.
 *   3. **No answer is refused by name.** The task has no fail policy: a spoken
 *      request with no route is announced as the engine's own failure. The
 *      Brain is never asked to route in the engine's place, which would send
 *      the user's words to a model they did not choose for this.
 */

import { VoiceProviderError } from '../../../shared/acappella/provider-errors';
import type {
	BrainProvider,
	VoiceConverseContext,
	VoiceRouteContext,
} from '../../../shared/acappella/providers';
import type { RouteDecision } from '../../../shared/acappella/route-decision';
import {
	routeDecisionFromSystemOne,
	type VoiceRoutingSystemOneInput,
} from '../../../shared/acappella/voice-routing-system-one';
import type { SystemOneErrorCode } from '../../../shared/local-models/system-one';
import { runSystemOneTask, type SystemOneTaskResult } from '../../local-models/task-router';

/**
 * The task, spelled here because `VOICE_ROUTING_TASK_ID` is typed as any task
 * id, and `runSystemOneTask` checks the input against this one.
 */
const TASK_ID = 'voice-routing';

export interface SystemOneRoutingOptions {
	/** Injected in tests; production goes through the task router. */
	runTask?: (input: VoiceRoutingSystemOneInput) => Promise<SystemOneTaskResult>;
}

/** Wrap a Brain so its routing is System One's while the task is assigned there. */
export function withSystemOneRouting(
	brain: BrainProvider,
	options: SystemOneRoutingOptions = {}
): BrainProvider {
	const runTask = options.runTask ?? ((input) => runSystemOneTask(TASK_ID, input));
	const refuse = (message: string, kind: 'auth' | 'quota' | 'timeout' | 'unavailable') =>
		new VoiceProviderError(message, { kind, providerId: brain.id });
	const converseStream = brain.converseStream?.bind(brain);

	return {
		id: brain.id,
		label: brain.label,
		tier: brain.tier,

		async route(input: string, context: VoiceRouteContext): Promise<RouteDecision> {
			if (context.conversational) return brain.route(input, context);

			const request: VoiceRoutingSystemOneInput = { utterance: input, context };
			const judged = await runTask(request);
			switch (judged.status) {
				case 'not-assigned':
					return brain.route(input, context);
				case 'ok': {
					const decision = routeDecisionFromSystemOne(judged.answers, request);
					if (!decision) {
						throw refuse(
							`${judged.engineLabel} did not answer the routing questions.`,
							'unavailable'
						);
					}
					return decision;
				}
				case 'cancelled':
					throw refuse(`${judged.engineLabel} was stopped before it answered.`, 'timeout');
				case 'failed-open':
				case 'failed-closed':
				case 'unavailable':
					throw refuse(judged.reason, failureKindFor(judged.code));
			}
		},

		converse(agentText: string, context: VoiceConverseContext): Promise<string> {
			return brain.converse(agentText, context);
		},

		...(converseStream ? { converseStream } : {}),
	};
}

/**
 * How an engine with no answer travels as a voice failure. A refused key, a
 * rate limit and a slow answer may clear, and are announced as what they are;
 * everything else (no engine chosen, an engine not set up, a request it will
 * not take) is fixed in settings, not by saying it again.
 */
function failureKindFor(
	code: SystemOneErrorCode | 'off'
): 'auth' | 'quota' | 'timeout' | 'unavailable' {
	if (code === 'auth') return 'auth';
	if (code === 'rate-limited') return 'quota';
	if (code === 'timeout') return 'timeout';
	return 'unavailable';
}
