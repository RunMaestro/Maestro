// `maestro-cli models assign <task-id> <spec>`, `models tasks` and `models map`
// - which source each Local Models task runs on, and the two Model Map slots a
// task can inherit.
//
// `assign` edits the `localModelAssignments` setting in the settings file, as
// the endpoint verbs do, so it works with Maestro closed and the settings
// watcher reloads every window. It validates and stores through the SAME shared
// helpers the Assignments picker in Settings uses (`parseLocalModelAssignmentSpec`,
// `localModelAssignmentProblem`, `withLocalModelAssignment`), so the CLI cannot
// save a pick the picker would refuse, and choosing a task's default removes its
// entry exactly as the picker does.
//
// `tasks` reads the assignments from the same file and asks the desktop for
// readiness over the WS bridge (the same resolver as `models status`). When the
// desktop cannot be asked it still lists the assignments, and says why the
// readiness column is empty.

import { withMaestroClient } from '../services/maestro-client';
import {
	readLocalModelAssignments,
	readLocalModelEndpoints,
	readStoredModelMap,
	writeLocalModelAssignments,
	writeModelMap,
} from '../services/storage';
import { ExitCode } from '../exit-codes';
import {
	formatLocalModelTasks,
	formatModelMap,
	formatSuccess,
	formatWarning,
	type ModelMapSlotDisplay,
} from '../output/formatter';
import { findLocalModelEndpoint } from '../../shared/local-models/endpoints';
import {
	formatLocalModelAssignmentSpec,
	isLocalModelTaskId,
	LOCAL_MODEL_TASK_IDS,
	LOCAL_MODEL_TASKS,
	localModelAssignmentCaution,
	localModelAssignmentProblem,
	modelMapRoleOf,
	parseLocalModelAssignmentSpec,
	resolveLocalModelAssignments,
	withLocalModelAssignment,
	type LocalModelAssignment,
	type LocalModelTaskId,
} from '../../shared/local-models/tasks';
import {
	formatModelMapSlotSpec,
	MODEL_MAP_ROLE_LABELS,
	MODEL_MAP_ROLES,
	modelMapSlotLabel,
	modelMapSlotProblem,
	parseModelMapSlotSpec,
	tasksInheritingModelMapRole,
	withModelMapSlot,
	type ModelMapRole,
	type ModelMapSlot,
} from '../../shared/local-models/model-map';
import { isValidAgentId } from '../../shared/agentIds';
import type { LocalModelTaskReadiness } from '../../shared/local-models/task-readiness';
import { failCommand } from '../services/session-command';

/** Matches `models status`: above the app's endpoint list budget. */
const READINESS_TIMEOUT_MS = 15_000;

interface JsonOption {
	json?: boolean;
}

const SPEC_FORMS =
	'off, agent-model, housekeeping-model, system-one, local:<model-id>, or endpoint:<endpoint>:<model>';

const SLOT_SPEC_FORMS =
	'provider, provider:<agent-id>, provider:<agent-id>:<model>, local:<model-id>, or endpoint:<endpoint>:<model>';

/** A spelled assignment, checked against a task and ready to store. */
export type ResolvedAssignmentSpec =
	| { ok: true; assignment: LocalModelAssignment; endpointEnabled: boolean }
	| { ok: false; message: string };

/**
 * Read an assignment spelling for a task and check that it fits, without
 * storing it. Every verb that takes a spelling goes through this (`models
 * assign`, and `s1 set engine local-judge --model`), so they accept the same
 * forms and refuse the same mistakes.
 */
export function resolveAssignmentSpec(
	taskId: LocalModelTaskId,
	spec: string
): ResolvedAssignmentSpec {
	const parsed = parseLocalModelAssignmentSpec(spec);
	if (!parsed) return { ok: false, message: `Assignment must be ${SPEC_FORMS}. Got "${spec}".` };

	// The picker only offers saved endpoints, so the CLI only accepts one. It
	// also takes an endpoint the way the endpoint verbs do (id prefix or name)
	// and stores the full id, which is what the router looks up.
	let assignment: LocalModelAssignment = parsed;
	let endpointEnabled = true;
	if (parsed.type === 'endpoint') {
		const lookup = findLocalModelEndpoint(readLocalModelEndpoints(), parsed.endpointId);
		if (!lookup.ok) return { ok: false, message: lookup.message };
		assignment = { ...parsed, endpointId: lookup.endpoint.id };
		endpointEnabled = lookup.endpoint.enabled;
	}

	const problem = localModelAssignmentProblem(taskId, assignment);
	if (problem) return { ok: false, message: problem };
	return { ok: true, assignment, endpointEnabled };
}

/** Store a task's assignment in the settings file. Check it with {@link resolveAssignmentSpec} first. */
export function storeTaskAssignment(
	taskId: LocalModelTaskId,
	assignment: LocalModelAssignment
): void {
	writeLocalModelAssignments(
		withLocalModelAssignment(readLocalModelAssignments(), taskId, assignment)
	);
}

export function modelsAssign(taskId: string, spec: string, options: JsonOption): void {
	if (!isLocalModelTaskId(taskId)) {
		failCommand(
			`Unknown task "${taskId}". Tasks: ${LOCAL_MODEL_TASK_IDS.join(', ')}`,
			options.json,
			ExitCode.InvalidUsage
		);
	}
	const resolved = resolveAssignmentSpec(taskId, spec);
	if (!resolved.ok) failCommand(resolved.message, options.json, ExitCode.InvalidUsage);
	const { assignment, endpointEnabled } = resolved;
	storeTaskAssignment(taskId, assignment);

	const task = LOCAL_MODEL_TASKS[taskId];
	const stored = formatLocalModelAssignmentSpec(assignment);
	// A caution is not a refusal: the picker would not have offered this model
	// for the task, so the reason it would not is said next to the result.
	const caution = localModelAssignmentCaution(taskId, assignment);
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				taskId,
				assignment,
				spec: stored,
				...(caution ? { caution } : {}),
			})
		);
		return;
	}
	console.log(formatSuccess(`${task.label} -> ${stored}`));
	if (caution) console.log(formatWarning(`Not recommended for this task: ${caution}`));
	if (!endpointEnabled) {
		console.log(formatWarning('That endpoint is disabled. Enable it before the task can run.'));
	}
	if (assignment.type === 'system-one') {
		// The assignment names no engine, so say where the engine is chosen.
		console.log('  It asks the System One engine in force: maestro-cli s1 status');
	}
	const role = modelMapRoleOf(assignment);
	if (role) {
		console.log(`  It follows the ${MODEL_MAP_ROLE_LABELS[role]}: maestro-cli models map ${role}`);
	} else if (assignment.type !== 'off') {
		console.log(`  Check it would run: maestro-cli models status ${taskId}`);
	}
}

export async function modelsTasks(options: JsonOption): Promise<void> {
	const assignments = resolveLocalModelAssignments(
		readLocalModelAssignments(),
		readStoredModelMap()
	);

	// Readiness needs the model store and the network, so it comes from the
	// desktop. Its absence is not a failure here: the assignments are the
	// answer to "what is each task on", and they live in the settings file.
	let readiness: LocalModelTaskReadiness[] | undefined;
	let readinessError: string | undefined;
	try {
		const reply = await withMaestroClient((client) =>
			client.sendCommand<{
				success: boolean;
				readiness?: LocalModelTaskReadiness[];
				error?: string;
			}>(
				{ type: 'local_models_task_readiness' },
				'local_models_task_readiness_result',
				READINESS_TIMEOUT_MS
			)
		);
		if (reply.success && reply.readiness) readiness = reply.readiness;
		else readinessError = reply.error || 'readiness check failed';
	} catch (error) {
		readinessError = error instanceof Error ? error.message : String(error);
	}

	const rows = LOCAL_MODEL_TASK_IDS.map((taskId) => {
		const task = LOCAL_MODEL_TASKS[taskId];
		return {
			taskId,
			label: task.label,
			description: task.description,
			needs: task.needs,
			allowsModelMap: task.allowsModelMap,
			assignment: assignments[taskId],
			spec: formatLocalModelAssignmentSpec(assignments[taskId]),
			readiness: readiness?.find((row) => row.taskId === taskId),
		};
	});

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				tasks: rows,
				...(readinessError ? { readinessError } : {}),
			})
		);
		return;
	}
	console.log(formatLocalModelTasks(rows, readinessError));
}

function isModelMapRole(value: string): value is ModelMapRole {
	return (MODEL_MAP_ROLES as readonly string[]).includes(value);
}

/**
 * Read a slot spelling and check it fits, the way the Model Map card in
 * Settings does: an endpoint is looked up by id prefix or name (and stored by
 * full id), a provider must be a known agent, a local model a text model.
 */
export function resolveModelMapSlotSpec(
	spec: string
): { ok: true; slot: ModelMapSlot } | { ok: false; message: string } {
	const parsed = parseModelMapSlotSpec(spec);
	if (!parsed) return { ok: false, message: `A slot must be ${SLOT_SPEC_FORMS}. Got "${spec}".` };
	let slot = parsed;
	if (parsed.type === 'endpoint') {
		const lookup = findLocalModelEndpoint(readLocalModelEndpoints(), parsed.endpointId);
		if (!lookup.ok) return { ok: false, message: lookup.message };
		slot = { ...parsed, endpointId: lookup.endpoint.id };
	}
	if (slot.type === 'provider' && slot.agentId && !isValidAgentId(slot.agentId)) {
		return { ok: false, message: `"${slot.agentId}" is not a known agent.` };
	}
	const problem = modelMapSlotProblem(slot);
	return problem ? { ok: false, message: problem } : { ok: true, slot };
}

/**
 * `maestro-cli models map [<role> [<slot>]]`: print the Model Map, one slot, or
 * set one slot. The same validation and spelling as the Model Map card in
 * Settings > Models > System Two.
 */
export function modelsMap(
	role: string | undefined,
	spec: string | undefined,
	options: JsonOption
): void {
	if (role !== undefined && !isModelMapRole(role)) {
		failCommand(
			`Unknown slot "${role}". Slots: ${MODEL_MAP_ROLES.join(', ')}`,
			options.json,
			ExitCode.InvalidUsage
		);
	}
	let map = readStoredModelMap();
	if (role !== undefined && spec !== undefined) {
		const resolved = resolveModelMapSlotSpec(spec);
		if (!resolved.ok) failCommand(resolved.message, options.json, ExitCode.InvalidUsage);
		map = withModelMapSlot(map, role, resolved.slot);
		writeModelMap(map);
	}

	const assignments = readLocalModelAssignments();
	const endpoints = readLocalModelEndpoints();
	const rows: ModelMapSlotDisplay[] = (role ? [role] : MODEL_MAP_ROLES).map((slotRole) => ({
		role: slotRole,
		label: MODEL_MAP_ROLE_LABELS[slotRole],
		spec: formatModelMapSlotSpec(map[slotRole]),
		source: modelMapSlotLabel(map[slotRole], endpoints),
		tasks: tasksInheritingModelMapRole(assignments, slotRole).map(
			(taskId) => LOCAL_MODEL_TASKS[taskId].label
		),
	}));

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				modelMap: Object.fromEntries(
					rows.map((row) => [row.role, { slot: map[row.role as ModelMapRole], ...row }])
				),
			})
		);
		return;
	}
	if (role !== undefined && spec !== undefined) {
		console.log(formatSuccess(`${MODEL_MAP_ROLE_LABELS[role]} -> ${rows[0].spec}`));
		console.log(`  Check the tasks that use it: maestro-cli models status`);
		return;
	}
	console.log(formatModelMap(rows));
}
