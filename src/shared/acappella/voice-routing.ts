/**
 * Which Brain routes a spoken request: the Local Models `voice-routing`
 * assignment when it names a source, otherwise the voice-specific choice.
 *
 * **One stored value per kind of choice, never two for the same one.** A local
 * model or an endpoint is chosen by ASSIGNING it to the `voice-routing` task
 * (`localModelAssignments`), the same setting every other Local Models task
 * uses, so Settings > Models, `maestro-cli models assign`, and the voice
 * panels all read and write one record. The built-in router and the hosted
 * Brains are not Local Models sources, so they stay where they were
 * (`acappella.providers.brain`) and apply while the assignment is `off`.
 *
 * A third assignment, `system-one`, names no Brain at all: the stored choice
 * stays in the slot and speaks, and the System One engine decides the route
 * ({@link isVoiceRoutingOnSystemOne}).
 *
 * Nothing here stores a provider id for an assigned Brain. The id a session
 * reports (`qwen3-local`, `endpoint-brain`) is DERIVED from the assignment, so
 * a panel cannot show "Built-in" while a session routes on a model.
 *
 * Pure, so the renderer, the provider registry, and the capability gate resolve
 * the same answer from the same two settings.
 */

import type { LocalModelEndpoint } from '../local-models/endpoints';
import {
	formatLocalModelAssignmentSpec,
	localModelAssignmentSourceLabel,
	parseLocalModelAssignmentSpec,
	parseLocalModelAssignments,
	resolveLocalModelAssignment,
	type LocalModelAssignment,
	type LocalModelTaskId,
} from '../local-models/tasks';
import { ENDPOINT_BRAIN_PROVIDER_ID, QWEN3_BRAIN_PROVIDER_ID } from './provider-catalog';

/** The Local Models task whose assignment chooses the Brain. */
export const VOICE_ROUTING_TASK_ID: LocalModelTaskId = 'voice-routing';

/** A `voice-routing` assignment that names a model, as opposed to `off`. */
export type VoiceRoutingAssignment = Extract<LocalModelAssignment, { type: 'local' | 'endpoint' }>;

/** The source the `voice-routing` assignment puts in the Brain slot. */
export interface VoiceBrainSource {
	assignment: VoiceRoutingAssignment;
	/** The assignment as one string (`local:<id>`, `endpoint:<id>:<model>`). */
	spec: string;
	/** What a person calls it: the model's name, or `<model> on <endpoint>`. */
	label: string;
	/** The endpoint's name, when the source is one. Named in the privacy sentence. */
	endpointName?: string;
}

/** The provider id an assignment resolves to, or null when it names no model. */
export function assignedBrainProviderId(assignment: LocalModelAssignment): string | null {
	if (assignment.type === 'local') return QWEN3_BRAIN_PROVIDER_ID;
	if (assignment.type === 'endpoint') return ENDPOINT_BRAIN_PROVIDER_ID;
	return null;
}

/** Whether a provider id is one the assignment selects, never a stored choice. */
export function isAssignedBrainProviderId(providerId: string): boolean {
	return providerId === QWEN3_BRAIN_PROVIDER_ID || providerId === ENDPOINT_BRAIN_PROVIDER_ID;
}

/**
 * The Brain source the persisted settings name, or null when `voice-routing`
 * is off.
 *
 * `assignments` is the raw `localModelAssignments` setting (anything unusable
 * reads as off); `endpoints` is the saved endpoint list, used only to name the
 * source. A removed endpoint still resolves, by its model name, so the slot
 * reports the endpoint as missing instead of quietly reverting to another Brain.
 */
export function resolveVoiceBrainSource(
	assignments: unknown,
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[]
): VoiceBrainSource | null {
	const assignment = resolveLocalModelAssignment(
		parseLocalModelAssignments(assignments),
		VOICE_ROUTING_TASK_ID
	);
	if (assignment.type !== 'local' && assignment.type !== 'endpoint') return null;

	const endpointName =
		assignment.type === 'endpoint'
			? endpoints.find((endpoint) => endpoint.id === assignment.endpointId)?.name
			: undefined;
	return {
		assignment,
		spec: formatLocalModelAssignmentSpec(assignment),
		// Never null for a local or endpoint assignment.
		label: localModelAssignmentSourceLabel(assignment, endpoints) ?? '',
		...(endpointName ? { endpointName } : {}),
	};
}

/**
 * Whether System One decides the route: the `voice-routing` task is assigned to
 * it. That fills no slot. The Brain in force is still the voice-specific choice
 * and still writes what is spoken; the engine picks the agent and the tab
 * (`shared/acappella/voice-routing-system-one.ts`). A panel that shows the
 * Brain says so beside it, so "Built-in" is never read as what routes.
 */
export function isVoiceRoutingOnSystemOne(assignments: unknown): boolean {
	return (
		resolveLocalModelAssignment(parseLocalModelAssignments(assignments), VOICE_ROUTING_TASK_ID)
			.type === 'system-one'
	);
}

/**
 * The Brain provider a session runs: the assigned one when `voice-routing`
 * names a source, else the stored voice-specific choice (undefined means the
 * build default).
 */
export function effectiveBrainProviderId(
	source: VoiceBrainSource | null,
	storedBrainId: string | undefined
): string | undefined {
	return (source && assignedBrainProviderId(source.assignment)) ?? storedBrainId;
}

/** What a Conductor Brain picker row selects. */
export type VoiceBrainChoice =
	| { kind: 'provider'; providerId: string }
	| { kind: 'assignment'; assignment: VoiceRoutingAssignment };

/**
 * A picker value as a choice. A value is an assignment spec for a model
 * (`local:...`, `endpoint:...`) and a bare provider id for everything else, so
 * one `<select>` carries both kinds without a second encoding.
 */
export function parseVoiceBrainChoice(value: string): VoiceBrainChoice {
	const assignment = parseLocalModelAssignmentSpec(value);
	if (assignment && (assignment.type === 'local' || assignment.type === 'endpoint')) {
		return { kind: 'assignment', assignment };
	}
	return { kind: 'provider', providerId: value };
}

/** The picker value for the Brain in force: the inverse of {@link parseVoiceBrainChoice}. */
export function voiceBrainChoiceValue(source: VoiceBrainSource | null, providerId: string): string {
	return source ? source.spec : providerId;
}
