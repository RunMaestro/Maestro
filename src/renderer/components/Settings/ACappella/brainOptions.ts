/**
 * The rows of the Conductor Brain picker, as plain data.
 *
 * One list carries both kinds of Brain: the voice-specific providers (built-in,
 * hosted), whose value is a provider id, and the models of the user's enabled
 * endpoints, whose value is the `voice-routing` assignment spec. The model rows
 * come from the same builder the Local Models Assignments picker uses, so the
 * two cannot offer different sources for the task.
 *
 * One difference from that picker, and it is deliberate: there is no "Off"
 * row. Off is what choosing a voice-specific provider means here, so those
 * providers stand where Off would.
 *
 * A local model is offered here exactly when the task offers it: installed, and
 * not recorded as measured-unfit for voice routing (`unofferedLocalModels`).
 * Qwen3 1.7B is recorded there, so it appears only when it is ALREADY the
 * assignment, with the reason in its label: a `<select>` whose value matches no
 * row renders its first row, and the panel would read "Built-in" while a model
 * routes. See `QWEN3_BRAIN_PROVIDER_ID` for the measurements.
 */

import { voiceProvidersForRole } from '../../../../shared/acappella/provider-catalog';
import {
	VOICE_ROUTING_TASK_ID,
	type VoiceBrainSource,
} from '../../../../shared/acappella/voice-routing';
import { LOCAL_MODEL_TASKS, OFF_ASSIGNMENT } from '../../../../shared/local-models/tasks';
import {
	buildAssignmentOptionGroups,
	type AssignmentOption,
	type AssignmentOptionGroup,
	type AssignmentOptionSources,
} from '../tabs/LocalModelsTab/assignmentOptions';

export function buildBrainOptionGroups(
	source: VoiceBrainSource | null,
	sources: AssignmentOptionSources
): AssignmentOptionGroup[] {
	const head: AssignmentOption[] = voiceProvidersForRole('brain').map((provider) => ({
		value: provider.id,
		label: provider.label,
	}));
	const groups: AssignmentOptionGroup[] = [{ label: null, options: head }];
	const isCurrent = (option: AssignmentOption) => option.value === source?.spec;

	const assignmentGroups = buildAssignmentOptionGroups(
		LOCAL_MODEL_TASKS[VOICE_ROUTING_TASK_ID],
		source?.assignment ?? OFF_ASSIGNMENT,
		sources
	);
	for (const group of assignmentGroups) {
		if (group.label === null) {
			// Off is dropped; what survives is a current assignment no row covers
			// (a model not downloaded, an endpoint removed or switched off).
			head.push(...group.options.filter(isCurrent));
		} else {
			groups.push(group);
		}
	}
	return groups;
}
