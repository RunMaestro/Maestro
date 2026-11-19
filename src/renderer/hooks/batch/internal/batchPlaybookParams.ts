import type { AgentError, BatchRunPlaybook } from '../../../../shared/types';
import {
	collectUnresolvedRequired,
	describeMissingRequiredParams,
	resolvePlaybookParamSpecs,
	type PlaybookParamSet,
} from '../../../../shared/playbookParams';
import { logger } from '../../../utils/logger';

/**
 * The launching playbook's parameters, resolved once per run: specs are per
 * playbook, not per document. An ad-hoc run (no playbook) has none.
 */
export function resolveRunPlaybookParams(
	playbook: BatchRunPlaybook | undefined,
	prompt: string
): PlaybookParamSet | undefined {
	if (!playbook) return undefined;
	return {
		specs: resolvePlaybookParamSpecs(prompt, playbook.parameterOverlay),
		values: playbook.parameterValues ?? {},
	};
}

/**
 * Re-read a playbook's overlay and answers from its agent's playbook store, so
 * answers the user gave during a pause count on Resume. Keeps `current` when
 * the store cannot be read or the playbook no longer exists: the precondition
 * then pauses again rather than starting with nothing.
 */
export async function reloadRunPlaybookParams(
	playbook: BatchRunPlaybook,
	ownerSessionId: string,
	prompt: string,
	current: PlaybookParamSet
): Promise<PlaybookParamSet> {
	try {
		const result = await window.maestro.playbooks.list(ownerSessionId);
		const stored = result.success
			? result.playbooks?.find((candidate) => candidate.id === playbook.id)
			: undefined;
		if (!stored) return current;
		return {
			specs: resolvePlaybookParamSpecs(prompt, stored.parameterOverlay),
			values: stored.parameterValues ?? {},
		};
	} catch (err) {
		logger.warn(
			`[BatchProcessor] Could not re-read playbook ${playbook.id} parameters; keeping the run's answers:`,
			undefined,
			err
		);
		return current;
	}
}

/**
 * The pause a run takes when a required parameter has no answer, or null when
 * every required parameter resolves. Recoverable: the user configures the
 * playbook and resumes.
 */
export function missingParamsPauseError(
	params: PlaybookParamSet,
	context: { agentId: string; sessionId: string }
): AgentError | null {
	const missing = collectUnresolvedRequired(params.specs, params.values);
	if (missing.length === 0) return null;
	return {
		type: 'missing_parameters',
		message: describeMissingRequiredParams(missing),
		recoverable: true,
		agentId: context.agentId,
		sessionId: context.sessionId,
		timestamp: Date.now(),
	};
}
