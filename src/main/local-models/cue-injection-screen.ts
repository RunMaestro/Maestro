/**
 * Cue prompt-injection screen: score one untrusted value with the
 * `injection-screen` Local Models assignment.
 *
 * One function, {@link scoreCueInjectionText}, handed to the Cue engine as its
 * scorer (`CueEngineDeps.scoreInjection`). The engine never imports this
 * module: the standalone runner (`maestro-cli cue engine`) builds an engine
 * with no scorer, because that process does not load the model stack.
 *
 * It only ever returns a score or the reason there is none. Whether a run is
 * blocked is the dispatch service's call (`resolveCueInjectionDecision`), so
 * the failure policy lives in one place and this module cannot fail a run open
 * or closed by accident.
 *
 * `off` (the default assignment) is reported apart from `unavailable`: the
 * policy treats "nobody assigned a model" and "the assigned model could not
 * run" differently for a command that never asked to be screened.
 *
 * The whole value is scored. `classifyText` reads every token in overlapping
 * windows and reports the highest score, so an injection at the end of a long
 * comment is not hidden by the text before it.
 *
 * Assigned to System One, the screen is one typed yes or no question for the
 * engine in force (`runSystemOneTask`) instead of a classifier run, and its
 * P(yes) is the score. An engine that gives no answer is `unavailable`, never
 * `off` (someone asked for a screen), and it carries the task's fail policy
 * for the dispatch service to apply. No classifier is asked in its place.
 */

import {
	cueInjectionScoreFromSystemOne,
	type CueInjectionScore,
	type CueInjectionScoreRequest,
} from '../../shared/cue/injection-screen';
import { LOCAL_MODEL_TASKS } from '../../shared/local-models/tasks';
import { taskAssignmentLocation } from '../../shared/local-models/settings-location';
import { logger } from '../utils/logger';
import { runClassifierTask, runSystemOneTask, type SystemOneTaskResult } from './task-router';

const LOG_CONTEXT = '[CueInjectionScreen]';

const TASK_ID = 'injection-screen';

/** Where a person assigns the task's source, for refusal text. */
const ASSIGNMENT_LOCATION = taskAssignmentLocation(TASK_ID);

/**
 * How long one value may take. Long enough for a cold classifier to load and
 * read a 10,000 character body; short enough that an event is not held for
 * minutes. A timeout is `unavailable`, so the policy decides.
 */
export const CUE_INJECTION_SCREEN_TIMEOUT_MS = 60 * 1000;

/** A System One verdict as a score. Only ever a score: the dispatch service decides the run. */
function scoreFromSystemOne(
	verdict: Exclude<SystemOneTaskResult, { status: 'not-assigned' }>,
	request: CueInjectionScoreRequest
): CueInjectionScore {
	switch (verdict.status) {
		case 'ok':
			return (
				cueInjectionScoreFromSystemOne(verdict.answers) ?? {
					status: 'unavailable',
					reason: `${verdict.engineLabel} did not answer the screen's question.`,
				}
			);
		case 'cancelled':
			return {
				status: 'unavailable',
				reason: `${verdict.engineLabel} was stopped before it answered.`,
			};
		case 'failed-open':
		case 'failed-closed':
		case 'unavailable':
			logger.warn('Cue injection screen could not run: System One gave no answer', LOG_CONTEXT, {
				subscription: request.subscriptionName,
				variable: request.variable,
				engine: verdict.engine,
				code: verdict.code,
				reason: verdict.reason,
			});
			return {
				status: 'unavailable',
				reason: verdict.reason,
				...(verdict.status === 'failed-open' ? { failPolicy: 'open' as const } : {}),
				...(verdict.status === 'failed-closed' ? { failPolicy: 'closed' as const } : {}),
			};
	}
}

/**
 * Score one untrusted value.
 *
 * Throws only for an unclassified failure inside the model engine, which is a
 * bug (the task router reports it; see `runClassifierTask`). The dispatch
 * service treats a throw as `unavailable` too, so even that cannot strand an
 * event.
 */
export async function scoreCueInjectionText(
	request: CueInjectionScoreRequest
): Promise<CueInjectionScore> {
	const task = LOCAL_MODEL_TASKS[TASK_ID];

	// System One first: it answers `not-assigned` for any other assignment and
	// touches nothing, so the classifier path below runs exactly as it did.
	const judged = await runSystemOneTask(
		TASK_ID,
		{ text: request.text },
		request.agentId ? { agentId: request.agentId } : {}
	);
	if (judged.status !== 'not-assigned') return scoreFromSystemOne(judged, request);

	const verdict = await runClassifierTask(TASK_ID, {
		text: request.text,
		signal: AbortSignal.timeout(CUE_INJECTION_SCREEN_TIMEOUT_MS),
		...(request.agentId ? { agentId: request.agentId } : {}),
	});

	switch (verdict.status) {
		case 'off':
			return {
				status: 'off',
				reason: `${task.label} is off. Assign it a classifier model in ${ASSIGNMENT_LOCATION}.`,
			};
		case 'cancelled':
			logger.warn('Cue injection screen timed out', LOG_CONTEXT, {
				subscription: request.subscriptionName,
				variable: request.variable,
				source: verdict.source,
			});
			return { status: 'unavailable', reason: 'The assigned model took too long to answer.' };
		case 'unavailable':
			logger.warn('Cue injection screen could not run: assigned model unavailable', LOG_CONTEXT, {
				subscription: request.subscriptionName,
				variable: request.variable,
				source: verdict.source,
				code: verdict.code,
				reason: verdict.reason,
			});
			return { status: 'unavailable', reason: verdict.reason };
		case 'ok':
			return { status: 'scored', score: verdict.score };
	}
}
