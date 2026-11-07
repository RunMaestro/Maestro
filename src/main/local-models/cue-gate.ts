/**
 * Cue gate: answer a subscription's `gate` condition with the `cue-gate` Local
 * Models assignment.
 *
 * One function, {@link evaluateCueGate}, handed to the Cue engine as its gate
 * evaluator (`CueEngineDeps.evaluateGate`). The engine never imports this
 * module: the standalone runner (`maestro-cli cue engine`) builds an engine
 * with no evaluator, because that process does not load the model stack, and
 * a gate there is reported as unavailable instead.
 *
 * It only ever returns a check. Whether an unavailable gate runs or skips is
 * the dispatch service's call (`resolveCueGateDecision`), so the failure
 * policy lives in one place and this module cannot fail a run open or closed
 * by accident.
 *
 * The verdicts, none of which falls back to an agent:
 *   - `off` is the default assignment. A subscription that names a gate while
 *     the task is off has a gate nothing can check, which is `unavailable`.
 *   - `unavailable`, `cancelled` (the timeout), and a reply that is not a
 *     verdict are all `unavailable`, with the reason a person can act on.
 *
 * Assigned to System One, the gate is one typed yes or no question for the
 * engine in force (`runSystemOneTask`) instead of a prompt for a model. An
 * engine that gives no answer is `unavailable` as well, and the check carries
 * what the fail policy said: the subscription's `gate_on_unavailable` when it
 * states one, else the Cue gate task's own. No model is asked in its place.
 */

import {
	CUE_GATE_REPLY_SCHEMA,
	cueGateCheckFromSystemOne,
	formatCueGateInput,
	parseCueGateReply,
	type CueGateCheck,
	type CueGateOnUnavailable,
	type CueGateRequest,
} from '../../shared/cue/gate';
import { LOCAL_MODEL_TASKS } from '../../shared/local-models/tasks';
import { taskAssignmentLocation } from '../../shared/local-models/settings-location';
import type { SystemOneFailPolicy } from '../../shared/local-models/system-one';
import { getPrompt } from '../prompt-manager';
import { logger } from '../utils/logger';
import { runLocalTask, runSystemOneTask, type SystemOneTaskResult } from './task-router';

const LOG_CONTEXT = '[CueGate]';

const TASK_ID = 'cue-gate';

/** Where a person assigns the task's source, for refusal text. */
const ASSIGNMENT_LOCATION = taskAssignmentLocation(TASK_ID);

/** One short sentence and a boolean, as JSON. */
const CUE_GATE_MAX_TOKENS = 200;

/**
 * How long a gate may take. Long enough for a cold local model to load and
 * answer; short enough that an event is not held for minutes behind a stuck
 * server. A timeout is `unavailable`, so the subscription's policy decides.
 */
export const CUE_GATE_TIMEOUT_MS = 60 * 1000;

function unavailable(reason: string): CueGateCheck {
	return { status: 'unavailable', reason };
}

/** A subscription's `gate_on_unavailable` in System One's words. */
const FAIL_POLICY_FOR: Record<CueGateOnUnavailable, SystemOneFailPolicy> = {
	run: 'open',
	skip: 'closed',
};

/** A System One verdict as a gate check. Only ever a check: the dispatch service decides the run. */
function checkFromSystemOne(
	verdict: Exclude<SystemOneTaskResult, { status: 'not-assigned' }>,
	subscriptionName: string
): CueGateCheck {
	switch (verdict.status) {
		case 'ok':
			return (
				cueGateCheckFromSystemOne(verdict.answers, verdict.engineLabel) ??
				unavailable(`${verdict.engineLabel} did not answer the gate's question.`)
			);
		case 'cancelled':
			return unavailable(`${verdict.engineLabel} was stopped before it answered.`);
		case 'failed-open':
		case 'failed-closed':
		case 'unavailable':
			logger.warn('Cue gate not checked: System One gave no answer', LOG_CONTEXT, {
				subscription: subscriptionName,
				engine: verdict.engine,
				code: verdict.code,
				reason: verdict.reason,
			});
			return {
				status: 'unavailable',
				reason: verdict.reason,
				...(verdict.status === 'failed-open' ? { onUnavailable: 'run' as const } : {}),
				...(verdict.status === 'failed-closed' ? { onUnavailable: 'skip' as const } : {}),
			};
	}
}

/**
 * Check one event against one gate condition.
 *
 * Throws only for an unclassified failure inside the model engine, which is a
 * bug (the task router reports it; see `runLocalTask`). The dispatch service
 * treats a throw as `unavailable` too, so even that cannot strand an event.
 */
export async function evaluateCueGate(request: CueGateRequest): Promise<CueGateCheck> {
	const task = LOCAL_MODEL_TASKS[TASK_ID];
	const offReason = `${task.label} is off. Assign it a local model or an endpoint in ${ASSIGNMENT_LOCATION}.`;

	// System One first: it answers `not-assigned` for any other assignment and
	// touches nothing, so the model path below runs exactly as it did.
	const judged = await runSystemOneTask(
		TASK_ID,
		{ condition: request.condition, event: request.event },
		{
			...(request.onUnavailable ? { failPolicy: FAIL_POLICY_FOR[request.onUnavailable] } : {}),
			...(request.agentId ? { agentId: request.agentId } : {}),
		}
	);
	if (judged.status !== 'not-assigned') return checkFromSystemOne(judged, request.subscriptionName);

	const verdict = await runLocalTask(TASK_ID, {
		system: getPrompt('cue-gate-local'),
		prompt: formatCueGateInput({ condition: request.condition, event: request.event }),
		maxTokens: CUE_GATE_MAX_TOKENS,
		jsonSchema: CUE_GATE_REPLY_SCHEMA,
		signal: AbortSignal.timeout(CUE_GATE_TIMEOUT_MS),
		...(request.agentId ? { agentId: request.agentId } : {}),
	});

	switch (verdict.status) {
		case 'off':
			return unavailable(offReason);
		case 'use-utility-agent':
			// The registry refuses this assignment for the task; a hand-edited
			// settings file is the only way here. There is no agent path to keep.
			return unavailable(
				`${task.label} cannot run on the Utility Agent. Assign it a local model or an endpoint in ${ASSIGNMENT_LOCATION}.`
			);
		case 'cancelled':
			logger.warn('Cue gate timed out', LOG_CONTEXT, {
				subscription: request.subscriptionName,
				source: verdict.source,
			});
			return unavailable('The assigned model took too long to answer.');
		case 'unavailable':
			logger.warn('Cue gate not checked: assigned model unavailable', LOG_CONTEXT, {
				subscription: request.subscriptionName,
				source: verdict.source,
				code: verdict.code,
				reason: verdict.reason,
			});
			return unavailable(verdict.reason);
		case 'ok': {
			const reply = parseCueGateReply(verdict.json);
			if (!reply) {
				logger.warn('Assigned model returned no usable gate verdict', LOG_CONTEXT, {
					subscription: request.subscriptionName,
					source: verdict.source,
					responseLength: verdict.text.length,
				});
				return unavailable(
					'The assigned model did not return a yes or no. Assign a larger model if this repeats.'
				);
			}
			return { status: reply.pass ? 'pass' : 'fail', reason: reply.reason };
		}
	}
}
