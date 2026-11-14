/**
 * The Model Map: the two named models System Two tasks can point at.
 *
 * - The **Agent model** is for the heavier writing a person reads closely.
 * - The **Housekeeping model** is for Maestro's quick background jobs.
 *
 * Each slot holds a provider agent (the session's own when no agent is named),
 * an installed local text model, or an endpoint model. A task assigned
 * `agent-model` or `housekeeping-model` inherits that slot; a task can also
 * name a model of its own (`local:` / `endpoint:`), or be off. The two role
 * names match the Library's text groups (`LocalModelTextGroupId`), so the
 * models the Library calls Agent-ready and Housekeeping are the ones each slot
 * recommends.
 *
 * Persisted as the `modelMap` setting. An install from before the map has no
 * such setting: {@link readModelMap} builds the Housekeeping slot from the old
 * `utilitySource` / `utilityAgentId` / `utilityModelId` keys on every read, so
 * there is no one-shot migration to miss and the CLI (which reads the settings
 * file with Maestro closed) agrees with the app.
 */

import { getAgentDisplayName } from '../agentMetadata';
import type { LocalModelEndpoint } from './endpoints';
import type { LocalModelTextGroupId } from './library';
import { getLocalModel } from './model-catalog';
import {
	AGENT_MODEL_ASSIGNMENT,
	formatLocalModelAssignmentSpec,
	HOUSEKEEPING_MODEL_ASSIGNMENT,
	LOCAL_MODEL_TASKS,
	localModelAssignmentProblem,
	localModelAssignmentSourceLabel,
	modelMapRoleOf,
	parseLocalModelAssignment,
	parseLocalModelAssignmentSpec,
	resolveLocalModelAssignment,
	type LocalModelAssignment,
	type LocalModelAssignments,
	type LocalModelTaskId,
} from './tasks';

/**
 * The task whose rules a slot's choice is checked by. Any System Two text task
 * would do: they all need a text model and accept an endpoint.
 */
export const MODEL_MAP_REFERENCE_TASK = 'tab-naming' satisfies LocalModelTaskId;

/** A slot of the Model Map, named like the Library group it recommends from. */
export type ModelMapRole = LocalModelTextGroupId;

export const MODEL_MAP_ROLES: readonly ModelMapRole[] = Object.freeze(['agent', 'housekeeping']);

/** What each slot is called in front of a person. */
export const MODEL_MAP_ROLE_LABELS: Readonly<Record<ModelMapRole, string>> = Object.freeze({
	agent: 'Agent model',
	housekeeping: 'Housekeeping model',
});

/** One sentence per slot: what it is for. */
export const MODEL_MAP_ROLE_DESCRIPTIONS: Readonly<Record<ModelMapRole, string>> = Object.freeze({
	agent: 'For writing a person reads closely, such as summaries and pull request drafts.',
	housekeeping: 'For quick background jobs, such as tab names and shell commands.',
});

/**
 * What a slot runs on. `provider` spawns an agent: `agentId` names it, and the
 * session's own provider is used when it is absent. `modelId` overrides that
 * agent's default model.
 */
export type ModelMapSlot =
	| { type: 'provider'; agentId?: string; modelId?: string }
	| { type: 'local'; modelId: string; language?: string }
	| { type: 'endpoint'; endpointId: string; model: string };

export type ModelMap = Readonly<Record<ModelMapRole, ModelMapSlot>>;

/** The session's own provider: what both slots are until the user picks. */
export const SESSION_PROVIDER_SLOT: ModelMapSlot = Object.freeze({ type: 'provider' });

export const DEFAULT_MODEL_MAP: ModelMap = Object.freeze({
	agent: SESSION_PROVIDER_SLOT,
	housekeeping: SESSION_PROVIDER_SLOT,
});

/** The task assignment that inherits a slot. */
export const MODEL_MAP_ASSIGNMENTS: Readonly<Record<ModelMapRole, LocalModelAssignment>> =
	Object.freeze({
		agent: AGENT_MODEL_ASSIGNMENT,
		housekeeping: HOUSEKEEPING_MODEL_ASSIGNMENT,
	});

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Read one stored slot, or `null` when it is not a usable shape. A model id or
 * endpoint that no longer exists is kept, so readiness names it instead of the
 * slot quietly falling back to a provider.
 */
export function parseModelMapSlot(value: unknown): ModelMapSlot | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type === 'provider') {
		const agentId = nonEmptyString(record.agentId);
		const modelId = agentId ? nonEmptyString(record.modelId) : undefined;
		return Object.freeze({
			type: 'provider',
			...(agentId ? { agentId } : {}),
			...(modelId ? { modelId } : {}),
		});
	}
	if (record.type !== 'local' && record.type !== 'endpoint') return null;
	const assignment = parseLocalModelAssignment(MODEL_MAP_REFERENCE_TASK, record);
	return assignment?.type === 'local' || assignment?.type === 'endpoint' ? assignment : null;
}

/** Read the stored `modelMap`, or `null` when there is none. A missing or bad slot reads as the session provider. */
export function parseModelMap(value: unknown): ModelMap | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	return Object.freeze({
		agent: parseModelMapSlot(record.agent) ?? SESSION_PROVIDER_SLOT,
		housekeeping: parseModelMapSlot(record.housekeeping) ?? SESSION_PROVIDER_SLOT,
	});
}

/**
 * The Housekeeping slot an install from before the Model Map configured: its
 * one shared `utilitySource`, whose provider path read `utilityAgentId` /
 * `utilityModelId`.
 */
function legacyHousekeepingSlot(read: (key: string) => unknown): ModelMapSlot {
	const source = parseModelMapSlot(read('utilitySource'));
	if (source && source.type !== 'provider') return source;
	return (
		parseModelMapSlot({
			type: 'provider',
			agentId: read('utilityAgentId'),
			modelId: read('utilityModelId'),
		}) ?? SESSION_PROVIDER_SLOT
	);
}

/**
 * The Model Map in force, from any settings reader (the main store, the
 * renderer's loaded settings, the CLI's settings file). This is also the
 * migration: without a stored `modelMap`, the old Utility source becomes the
 * Housekeeping slot, which every task that used it now inherits.
 */
export function readModelMap(read: (key: string) => unknown): ModelMap {
	return (
		parseModelMap(read('modelMap')) ??
		Object.freeze({ agent: SESSION_PROVIDER_SLOT, housekeeping: legacyHousekeepingSlot(read) })
	);
}

/** The next map with one slot replaced. */
export function withModelMapSlot(map: ModelMap, role: ModelMapRole, slot: ModelMapSlot): ModelMap {
	return Object.freeze({ ...map, [role]: slot });
}

/**
 * Which provider a provider slot spawns. `usesMappedProvider` is true when the
 * slot names an agent of its own rather than following the session.
 */
export interface ResolvedSlotProvider {
	agentType: string;
	modelId: string | undefined;
	usesMappedProvider: boolean;
	changesProvider: boolean;
}

/**
 * The provider a slot runs on. A slot on a local model or an endpoint has no
 * provider of its own, so its caller's provider path (tool-based grooming,
 * which a model cannot do) stays on the session's provider.
 */
export function resolveSlotProvider(
	slot: ModelMapSlot,
	sessionProvider: string
): ResolvedSlotProvider {
	const provider = slot.type === 'provider' ? (slot.agentId ?? null) : null;
	return {
		agentType: provider ?? sessionProvider,
		modelId: provider && slot.type === 'provider' ? slot.modelId : undefined,
		usesMappedProvider: provider !== null,
		changesProvider: provider !== null && provider !== sessionProvider,
	};
}

/**
 * The provider a task's agent path spawns: the slot its assignment inherits,
 * else the session's provider. Only reached when the task did not run on a
 * model, so a task that names its own model never gets here with one.
 */
export function resolveTaskProvider(
	read: (key: string) => unknown,
	taskId: LocalModelTaskId,
	sessionProvider: string
): ResolvedSlotProvider {
	const assignment = resolveLocalModelAssignment(
		read('localModelAssignments') as LocalModelAssignments | undefined,
		taskId
	);
	const role = modelMapRoleOf(assignment);
	return resolveSlotProvider(
		role ? readModelMap(read)[role] : SESSION_PROVIDER_SLOT,
		sessionProvider
	);
}

/**
 * The one-string spelling of a slot: `provider`, `provider:<agent-id>`,
 * `provider:<agent-id>:<model>`, `local:<model-id>`, or
 * `endpoint:<endpoint-id>:<model>`. The settings picker uses it as an option
 * value and `maestro-cli models map` takes it as an argument. A provider model
 * keeps everything after the second colon, like an endpoint model.
 */
export function formatModelMapSlotSpec(slot: ModelMapSlot): string {
	if (slot.type !== 'provider') return formatLocalModelAssignmentSpec(slot);
	if (!slot.agentId) return 'provider';
	return slot.modelId ? `provider:${slot.agentId}:${slot.modelId}` : `provider:${slot.agentId}`;
}

/** Read a spelling written by {@link formatModelMapSlotSpec}, or `null`. Only the shape is checked. */
export function parseModelMapSlotSpec(spec: string): ModelMapSlot | null {
	const trimmed = spec.trim();
	if (trimmed === 'provider') return SESSION_PROVIDER_SLOT;
	if (trimmed.startsWith('provider:')) {
		const rest = trimmed.slice('provider:'.length);
		const separator = rest.indexOf(':');
		const agentId = (separator < 0 ? rest : rest.slice(0, separator)).trim();
		// `provider:` names no agent: refuse it rather than read it as the session's.
		if (!agentId) return null;
		return parseModelMapSlot({
			type: 'provider',
			agentId,
			modelId: separator < 0 ? undefined : rest.slice(separator + 1),
		});
	}
	const assignment = parseLocalModelAssignmentSpec(trimmed);
	return assignment?.type === 'local' || assignment?.type === 'endpoint' ? assignment : null;
}

/**
 * Why a slot the user is about to SAVE cannot hold this choice, or `null`. A
 * slot serves text tasks, so a local model must be a known text model; the
 * rules are the ones a text task's own picker applies.
 */
export function modelMapSlotProblem(slot: ModelMapSlot): string | null {
	if (slot.type === 'provider') return null;
	return localModelAssignmentProblem(MODEL_MAP_REFERENCE_TASK, slot);
}

/**
 * What a person calls a slot's choice: an agent's display name, "Session
 * provider", a catalog model, or `<model> on <endpoint>`.
 */
export function modelMapSlotLabel(
	slot: ModelMapSlot,
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[]
): string {
	if (slot.type === 'provider') {
		if (!slot.agentId) return 'Session provider';
		const agent = getAgentDisplayName(slot.agentId);
		return slot.modelId ? `${agent} (${slot.modelId})` : agent;
	}
	return localModelAssignmentSourceLabel(slot, endpoints) ?? formatModelMapSlotSpec(slot);
}

/** Whether a catalog model is recommended for a slot: the Library gives it that role. */
export function isRecommendedForModelMapRole(modelId: string, role: ModelMapRole): boolean {
	return getLocalModel(modelId)?.roles?.includes(role) === true;
}

/** The tasks that inherit a slot, in registry order. Reads defaults too. */
export function tasksInheritingModelMapRole(
	assignments: LocalModelAssignments | undefined,
	role: ModelMapRole
): LocalModelTaskId[] {
	return (Object.keys(LOCAL_MODEL_TASKS) as LocalModelTaskId[]).filter(
		(taskId) => modelMapRoleOf(resolveLocalModelAssignment(assignments, taskId)) === role
	);
}
