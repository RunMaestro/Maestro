/**
 * Local Models task readiness: may this task run on its assignment, and if not,
 * exactly why.
 *
 * The task router answers "unavailable" only AFTER a call failed. A surface
 * that offers a task (a settings row, `maestro-cli models status`, a consumer
 * deciding whether to show its affordance) needs the answer BEFORE, with a
 * reason a person can act on. That is this module, in the same style as A
 * Cappella's `capability-gate.ts` (which stays voice-specific):
 *
 *   - **No substitution.** A verdict is about the source the user assigned. A
 *     missing local model is never answered with "but an endpoint is up".
 *   - **No bare boolean.** Every unavailable verdict carries a closed `reason`,
 *     a sentence naming the missing piece, and a suggested action.
 *   - **Runtime before model.** A native runtime that will not load here is not
 *     fixed by downloading the model, so that is reported first.
 *   - **Cheap for local models.** Model status is the store's manifest-and-length
 *     check (never a re-hash), and the runtime is checked WITHOUT loading it,
 *     exactly as the voice gate does. Only an endpoint assignment reaches the
 *     network: one model listing, inside the client's short list budget.
 *   - **System One is read, never asked.** A task assigned to System One is
 *     ready when the engine in force is set up to answer (an engine is chosen,
 *     and it has its key, URL or model). Nothing is sent to find out, so a
 *     verdict costs no request and tells an engine nothing.
 */

import { getLocalModel } from '../../shared/local-models/model-catalog';
import {
	endpointServesNeed,
	isLocalModelTaskId,
	LOCAL_MODEL_TASK_IDS,
	LOCAL_MODEL_TASKS,
	resolveLocalModelAssignment,
	taskAcceptsLocalKind,
	taskLocalModelKinds,
	type LocalModelAssignment,
	type LocalModelAssignments,
	type LocalModelTaskDefinition,
	type LocalModelTaskId,
} from '../../shared/local-models/tasks';
import {
	modelsSettingsLocation,
	taskAssignmentLocation,
} from '../../shared/local-models/settings-location';
import {
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_NAME,
} from '../../shared/local-models/model-server';
import type {
	LocalModelTaskReadiness,
	LocalModelTaskUnreadyReason,
} from '../../shared/local-models/task-readiness';
import type { LocalModelEndpoint } from '../../shared/local-models/endpoints';
import type { NativeRuntimeId } from '../../shared/local-models/native-runtimes';
import type { SystemOneReport } from '../../shared/local-models/system-one-settings';
import type { EndpointModel, EndpointModelsResult } from './endpoint-client';
import {
	findUsableLocalModelEndpoint,
	listLocalModelEndpointModels,
	type UsableLocalModelEndpoint,
} from './endpoint-service';
import { getStatus, type ModelStatus } from './model-store';
import {
	knownNativeRuntimeUnavailability,
	type NativeRuntimeUnavailable,
} from './runtime/native-loader';
import { runtimeSetupLocation } from './runtime/runtime-consumers';
import { isServerEngineInstalled } from './server/engine-store';
import { isServerModel } from './server/presets';
import { readLocalModelAssignments } from './sources';
import { getSystemOneReport } from './system-one/service';

const NEED_LABELS: Record<LocalModelTaskDefinition['needs'], string> = {
	'text-gen': 'text-generation',
	embedding: 'embedding',
	classifier: 'text-classifier',
	stt: 'speech-to-text',
	tts: 'text-to-speech',
};

/** "a text-generation model", "an embedding model". */
function aNeed(need: LocalModelTaskDefinition['needs']): string {
	const label = NEED_LABELS[need];
	return `${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`;
}

/** "a text-generation or embedding model": every kind of catalog model a task accepts. */
function aLocalNeed(task: LocalModelTaskDefinition): string {
	const [first, ...rest] = taskLocalModelKinds(task);
	return [aNeed(first), ...rest.map((kind) => NEED_LABELS[kind])].join(' or ');
}

export interface ResolveTaskReadinessOptions {
	/** The persisted assignments. Defaults to the `localModelAssignments` setting. */
	assignments?: LocalModelAssignments;
	/** Injected for tests. Defaults to the model store's cheap status check. */
	readModelStatus?: (modelId: string) => Promise<ModelStatus>;
	/** Why a runtime will not load, WITHOUT loading it. Defaults to the loader's answer. */
	readRuntimeFailure?: (runtimeId: NativeRuntimeId) => Promise<NativeRuntimeUnavailable | null>;
	/** A saved, enabled endpoint by exact id. Defaults to the endpoint service. */
	findEndpoint?: (endpointId: string) => UsableLocalModelEndpoint;
	/** The models an endpoint serves. Defaults to the endpoint service's listing. */
	listEndpointModels?: (endpoint: LocalModelEndpoint) => Promise<EndpointModelsResult>;
	/** Whether the Maestro model server's engine is downloaded. Defaults to the engine store. */
	isServerEngineInstalled?: () => Promise<boolean>;
	/** The System One engine in force, read from its settings. Defaults to the service's report. */
	readSystemOne?: () => Promise<SystemOneEngineStanding>;
}

/** What readiness reads about System One: the engine, its name, and why it cannot answer. */
export type SystemOneEngineStanding = Pick<SystemOneReport, 'settings' | 'engineLabel' | 'problem'>;

/** One task's readiness against its effective assignment. */
export async function resolveTaskReadiness(
	taskId: LocalModelTaskId,
	options: ResolveTaskReadinessOptions = {}
): Promise<LocalModelTaskReadiness> {
	const assignments = options.assignments ?? readLocalModelAssignments();
	return resolveForAssignment(
		LOCAL_MODEL_TASKS[taskId],
		resolveLocalModelAssignment(assignments, taskId),
		options
	);
}

/**
 * Every task's readiness, in registry order. An endpoint several tasks share is
 * listed once, so a status page does not probe the same server per task.
 */
export async function resolveAllTaskReadiness(
	options: ResolveTaskReadinessOptions = {}
): Promise<LocalModelTaskReadiness[]> {
	const assignments = options.assignments ?? readLocalModelAssignments();
	const list = options.listEndpointModels ?? defaultListEndpointModels;
	const listings = new Map<string, Promise<EndpointModelsResult>>();
	const readSystemOne = options.readSystemOne ?? getSystemOneReport;
	let systemOne: Promise<SystemOneEngineStanding> | undefined;
	const shared: ResolveTaskReadinessOptions = {
		...options,
		assignments,
		// One engine serves every task assigned to it, so it is read once.
		readSystemOne: () => (systemOne ??= readSystemOne()),
		listEndpointModels: (endpoint) => {
			let listing = listings.get(endpoint.id);
			if (!listing) {
				listing = list(endpoint);
				listings.set(endpoint.id, listing);
			}
			return listing;
		},
	};
	return Promise.all(LOCAL_MODEL_TASK_IDS.map((taskId) => resolveTaskReadiness(taskId, shared)));
}

/**
 * The transport-facing entry: IPC (`localModels:taskReadiness`) and the CLI
 * bridge (`maestro-cli models status`) hand over an untrusted value. No task id
 * means every task; a named task answers a one-entry list, so both transports
 * render one shape.
 */
export async function resolveTaskReadinessRequest(
	taskId: unknown
): Promise<LocalModelTaskReadiness[]> {
	if (taskId === undefined || taskId === null || taskId === '') return resolveAllTaskReadiness();
	if (!isLocalModelTaskId(taskId)) {
		throw new Error(`Unknown task "${String(taskId)}". Tasks: ${LOCAL_MODEL_TASK_IDS.join(', ')}`);
	}
	return [await resolveTaskReadiness(taskId)];
}

function defaultListEndpointModels(endpoint: LocalModelEndpoint): Promise<EndpointModelsResult> {
	return listLocalModelEndpointModels(endpoint);
}

async function resolveForAssignment(
	task: LocalModelTaskDefinition,
	assignment: LocalModelAssignment,
	options: ResolveTaskReadinessOptions
): Promise<LocalModelTaskReadiness> {
	const base = { taskId: task.id, label: task.label, needs: task.needs, assignment };
	switch (assignment.type) {
		case 'off':
			return {
				...base,
				state: 'off',
				detail: `${task.label} is off.`,
				suggestedAction: `Assign it ${
					endpointServesNeed(task.needs) ? 'a local model or an endpoint' : 'a local model'
				} in ${taskAssignmentLocation(task.id)}.`,
			};
		case 'utility-agent':
			return {
				...base,
				state: 'utility-agent',
				detail: `${task.label} runs on the Utility Agent.`,
			};
		case 'local':
			return { ...base, ...(await resolveLocal(task, assignment.modelId, options)) };
		case 'endpoint':
			return {
				...base,
				...(await resolveEndpoint(task, assignment.endpointId, assignment.model, options)),
			};
		case 'system-one':
			return { ...base, ...(await resolveSystemOne(task, options)) };
	}
}

type Verdict = Omit<LocalModelTaskReadiness, 'taskId' | 'label' | 'needs' | 'assignment'>;

function unavailable(
	reason: LocalModelTaskUnreadyReason,
	detail: string,
	suggestedAction: string,
	extra: Partial<Verdict> = {}
): Verdict {
	return { state: 'unavailable', reason, detail, suggestedAction, ...extra };
}

async function resolveSystemOne(
	task: LocalModelTaskDefinition,
	options: ResolveTaskReadinessOptions
): Promise<Verdict> {
	const { settings, engineLabel, problem } = await (options.readSystemOne ?? getSystemOneReport)();
	const where = modelsSettingsLocation('system-one');
	if (settings.engine === 'off') {
		return unavailable(
			'system-one-off',
			`${task.label} is assigned to System One, and System One is off.`,
			`Choose an engine in ${where}, or assign another source in ${taskAssignmentLocation(task.id)}.`
		);
	}
	if (problem) {
		return unavailable('system-one-not-ready', problem, `Set up ${engineLabel} in ${where}.`);
	}
	return { state: 'ready', detail: `Asks ${engineLabel}.` };
}

async function resolveLocal(
	task: LocalModelTaskDefinition,
	modelId: string,
	options: ResolveTaskReadinessOptions
): Promise<Verdict> {
	const needLabel = aLocalNeed(task);
	const entry = getLocalModel(modelId);
	if (!entry) {
		return unavailable(
			'model-unknown',
			`"${modelId}" is not a model in this build's catalog.`,
			`Assign ${needLabel} model from the Local Models catalog in ${taskAssignmentLocation(task.id)}.`
		);
	}
	if (!taskAcceptsLocalKind(task, entry.kind)) {
		return unavailable(
			'model-wrong-kind',
			`${entry.displayName} is not ${needLabel} model, which ${task.label} needs.`,
			`Assign ${needLabel} model in ${taskAssignmentLocation(task.id)}.`
		);
	}

	const runtimeId = entry.runtime;
	const readRuntimeFailure = options.readRuntimeFailure ?? knownNativeRuntimeUnavailability;
	const runtimeFailure = await readRuntimeFailure(runtimeId);
	if (runtimeFailure) {
		return unavailable(
			'runtime-unavailable',
			runtimeFailure.message,
			runtimeFailure.suggestedAction,
			{
				runtimeId,
			}
		);
	}

	const status = await (options.readModelStatus ?? getStatus)(modelId);
	const location = runtimeSetupLocation(runtimeId);
	if (status.status === 'installed') {
		return { state: 'ready', detail: `Runs ${entry.displayName} on this machine.`, runtimeId };
	}
	if (status.status === 'corrupt') {
		return unavailable(
			'model-corrupt',
			`${entry.displayName} is installed but failed verification${
				status.detail ? ` (${status.detail})` : ''
			}.`,
			`Verify or re-download it in ${location}.`,
			{ runtimeId }
		);
	}
	// The store's "Not installed" restates the verdict; anything else (a stale
	// revision, a missing file) is worth naming.
	const why = status.detail && status.detail !== 'Not installed' ? ` (${status.detail})` : '';
	return unavailable(
		'model-not-installed',
		`${entry.displayName} is not downloaded${why}.`,
		`Download it in ${location}.`,
		{ runtimeId }
	);
}

async function resolveEndpoint(
	task: LocalModelTaskDefinition,
	endpointId: string,
	model: string,
	options: ResolveTaskReadinessOptions
): Promise<Verdict> {
	if (!endpointServesNeed(task.needs)) {
		return unavailable(
			'endpoint-unsupported',
			`${task.label} needs ${aNeed(task.needs)} model, which an endpoint cannot serve.`,
			`Assign a local model in ${taskAssignmentLocation(task.id)}.`
		);
	}

	if (endpointId === MODEL_SERVER_ENDPOINT_ID) return resolveModelServer(task, model, options);

	const found = (options.findEndpoint ?? findUsableLocalModelEndpoint)(endpointId);
	if (!found.ok) {
		return found.problem === 'disabled'
			? unavailable(
					'endpoint-disabled',
					found.message,
					`Enable it in the endpoint list, or assign another source in ${taskAssignmentLocation(task.id)}.`
				)
			: unavailable(
					'endpoint-unknown',
					found.message,
					`Add the endpoint again (maestro-cli models endpoints add), or assign another source in ${taskAssignmentLocation(task.id)}.`
				);
	}

	const endpoint = found.endpoint;
	const listing = await (options.listEndpointModels ?? defaultListEndpointModels)(endpoint);
	if (!listing.ok) {
		const { kind, message } = listing.error;
		if (kind === 'missing-key') {
			return unavailable(
				'endpoint-key-missing',
				message,
				`Set ${endpoint.apiKeyEnvVar ?? 'the API key variable'} in Settings -> Environment.`
			);
		}
		if (kind === 'auth') {
			return unavailable(
				'endpoint-rejected',
				message,
				`Check the API key in ${endpoint.apiKeyEnvVar ?? 'Settings -> Environment'}, and that it may call ${endpoint.name}.`
			);
		}
		return unavailable(
			'endpoint-unreachable',
			message,
			`Start ${endpoint.name}, or check its base URL (${endpoint.baseUrl}).`
		);
	}

	if (!endpointListsModel(listing.models, model)) {
		return unavailable(
			'endpoint-model-missing',
			`${endpoint.name} does not serve "${model}".`,
			endpoint.kind === 'ollama'
				? `Pull it (ollama pull ${model}), or assign a model ${endpoint.name} lists.`
				: `Load it on ${endpoint.name}, or assign a model it lists.`
		);
	}
	return { state: 'ready', detail: `Runs ${model} on ${endpoint.name}.` };
}

/**
 * The Maestro model server is never saved and starts when a task needs it, so
 * its verdict is about what a start needs, read from disk without starting it:
 * the engine, and the model as an installed catalog text model.
 */
async function resolveModelServer(
	task: LocalModelTaskDefinition,
	model: string,
	options: ResolveTaskReadinessOptions
): Promise<Verdict> {
	if (task.needs !== 'text-gen') {
		return unavailable(
			'endpoint-unsupported',
			`${task.label} needs ${aNeed(task.needs)} model, and the ${MODEL_SERVER_NAME} serves text generation only.`,
			`Assign a local model or another endpoint in ${taskAssignmentLocation(task.id)}.`
		);
	}
	if (!(await (options.isServerEngineInstalled ?? isServerEngineInstalled)())) {
		return unavailable(
			'endpoint-unreachable',
			`The ${MODEL_SERVER_NAME} engine (llama-server) is not downloaded.`,
			`Install it in ${modelsSettingsLocation('sources')}.`
		);
	}
	const entry = getLocalModel(model);
	if (!entry || !isServerModel(entry)) {
		return unavailable(
			'endpoint-model-missing',
			`The ${MODEL_SERVER_NAME} does not serve "${model}": it serves the Library's text models.`,
			`Assign a downloaded text model in ${taskAssignmentLocation(task.id)}.`
		);
	}
	const status = await (options.readModelStatus ?? getStatus)(model);
	if (status.status !== 'installed') {
		return unavailable(
			'model-not-installed',
			`${entry.displayName} is not downloaded, so the ${MODEL_SERVER_NAME} cannot serve it.`,
			`Download it in ${modelsSettingsLocation('library')}.`
		);
	}
	return {
		state: 'ready',
		detail: `Runs ${entry.displayName} on the ${MODEL_SERVER_NAME}, which starts when a task needs it.`,
	};
}

/**
 * Whether a listing includes the assigned model. Ollama lists tags in full
 * (`qwen3:latest`) and answers a bare name with its `latest` tag, so a bare
 * assigned name matches its `:latest` entry.
 */
export function endpointListsModel(models: readonly EndpointModel[], model: string): boolean {
	return models.some(
		(entry) => entry.id === model || (!model.includes(':') && entry.id === `${model}:latest`)
	);
}
