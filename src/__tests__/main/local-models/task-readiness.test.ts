/**
 * @file task-readiness.test.ts
 *
 * Local Models task readiness, with the model store, the runtime loader, and
 * the endpoint service injected. Properties worth protecting:
 *
 *   - **Every reason is produced, and every one carries a recovery.** A reason
 *     with no suggested action is a dead end in front of a person.
 *   - **No substitution.** A verdict is about the assigned source; nothing
 *     else is consulted.
 *   - **Runtime before model.** A runtime that will not load is reported even
 *     when the model is also missing, because a download does not fix it.
 *   - **One listing per endpoint** when every task is resolved at once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	endpointListsModel,
	resolveAllTaskReadiness,
	resolveTaskReadiness,
	resolveTaskReadinessRequest,
	type ResolveTaskReadinessOptions,
} from '../../../main/local-models/task-readiness';
import type { ModelStatus } from '../../../main/local-models/model-store';
import type { NativeRuntimeUnavailable } from '../../../main/local-models/runtime/native-loader';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import { DEFAULT_SYSTEM_ONE_SETTINGS } from '../../../shared/local-models/system-one-settings';
import {
	BGE_SMALL_EN_ID,
	KOKORO_82M_ID,
	PROMPT_GUARD_2_22M_ID,
	QWEN3_1_7B_ID,
} from '../../../shared/local-models/model-catalog';
import {
	isTaskRunnable,
	LOCAL_MODEL_TASK_UNREADY_REASONS,
	type LocalModelTaskReadiness,
	type LocalModelTaskUnreadyReason,
} from '../../../shared/local-models/task-readiness';
import {
	LOCAL_MODEL_TASK_IDS,
	type LocalModelAssignments,
} from '../../../shared/local-models/tasks';

const ENDPOINT: LocalModelEndpoint = {
	id: 'ep-1',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

function status(kind: ModelStatus['status'], detail?: string): ModelStatus {
	return { id: 'x', status: kind, manifest: null, bytesOnDisk: 0, ...(detail ? { detail } : {}) };
}

const RUNTIME_DOWN: NativeRuntimeUnavailable = {
	kind: 'runtime-unavailable',
	runtimeId: 'onnx',
	moduleId: 'onnxruntime-node',
	platform: 'darwin',
	arch: 'arm64',
	failure: 'not-downloaded',
	message: 'ONNX Runtime is not downloaded yet.',
	suggestedAction: 'Download it in Settings.',
};

/** Options where everything is healthy unless a test overrides a seam. */
function healthy(overrides: ResolveTaskReadinessOptions = {}): ResolveTaskReadinessOptions {
	return {
		readModelStatus: vi.fn(async () => status('installed')),
		readRuntimeFailure: vi.fn(async () => null),
		findEndpoint: vi.fn(() => ({ ok: true as const, endpoint: ENDPOINT })),
		listEndpointModels: vi.fn(async () => ({
			ok: true as const,
			models: [{ id: 'nomic-embed-text:latest' }],
		})),
		...overrides,
	};
}

const local = (modelId: string) => ({ type: 'local' as const, modelId });
const SYSTEM_ONE = { type: 'system-one' as const };

/** The System One engine as readiness reads it: chosen, named, and set up or not. */
function systemOne(
	engine: 'off' | 'jev-cloud' | 'local-judge',
	problem: string | null = null
): NonNullable<ResolveTaskReadinessOptions['readSystemOne']> {
	const engineLabel =
		engine === 'off'
			? 'Off'
			: engine === 'jev-cloud'
				? 'Jev (TypeSafe cloud)'
				: 'Local judge, not calibrated';
	return vi.fn(async () => ({
		settings: { ...DEFAULT_SYSTEM_ONE_SETTINGS, engine },
		engineLabel,
		problem,
	}));
}
const endpoint = (model = 'nomic-embed-text') => ({
	type: 'endpoint' as const,
	endpointId: ENDPOINT.id,
	model,
});

beforeEach(() => {
	settings.clear();
});

describe('resolveTaskReadiness', () => {
	it('checks the shared local model for inherited tasks and honors explicit overrides', async () => {
		settings.set('utilitySource', local(QWEN3_1_7B_ID));
		const options = healthy();
		const verdict = await resolveTaskReadiness('tab-naming', options);
		expect(verdict).toMatchObject({ state: 'ready', assignment: local(QWEN3_1_7B_ID) });
		expect(options.readModelStatus).toHaveBeenCalledWith(QWEN3_1_7B_ID);
		settings.set('localModelAssignments', { 'tab-naming': { type: 'off' } });
		expect(await resolveTaskReadiness('tab-naming', options)).toMatchObject({ state: 'off' });
	});

	it('reports an inherited missing model as unavailable rather than as a provider', async () => {
		settings.set('utilitySource', local(QWEN3_1_7B_ID));
		expect(
			await resolveTaskReadiness(
				'tab-summary',
				healthy({
					readModelStatus: async () => status('not-installed'),
				})
			)
		).toMatchObject({ state: 'unavailable', reason: 'model-not-installed' });
	});

	it('reports the default assignment when nothing is stored', async () => {
		const tabNaming = await resolveTaskReadiness('tab-naming', healthy());
		expect(tabNaming).toMatchObject({
			taskId: 'tab-naming',
			label: 'Tab naming',
			needs: 'text-gen',
			assignment: { type: 'utility-agent' },
			state: 'utility-agent',
		});
		expect(isTaskRunnable(tabNaming)).toBe(true);

		const search = await resolveTaskReadiness('semantic-search', healthy());
		expect(search.state).toBe('off');
		expect(search.suggestedAction).toMatch(/a local model or an endpoint/);
		expect(isTaskRunnable(search)).toBe(false);
	});

	it('offers only a local model for an off task an endpoint cannot serve', async () => {
		const screen = await resolveTaskReadiness('injection-screen', healthy());
		expect(screen.state).toBe('off');
		expect(screen.suggestedAction).toMatch(/Assign it a local model in/);
	});

	it('reads the persisted assignments by default', async () => {
		settings.set('localModelAssignments', { 'semantic-search': local(BGE_SMALL_EN_ID) });
		const verdict = await resolveTaskReadiness('semantic-search', healthy());
		expect(verdict).toMatchObject({ state: 'ready', runtimeId: 'onnx' });
		expect(verdict.detail).toMatch(/on this machine/);
	});

	it('answers ready for an installed local model whose runtime loads', async () => {
		const options = healthy({
			assignments: { 'injection-screen': local(PROMPT_GUARD_2_22M_ID) },
		});
		const verdict = await resolveTaskReadiness('injection-screen', options);
		expect(verdict.state).toBe('ready');
		expect(verdict.reason).toBeUndefined();
		expect(options.readRuntimeFailure).toHaveBeenCalledWith('onnx');
		expect(options.readModelStatus).toHaveBeenCalledWith(PROMPT_GUARD_2_22M_ID);
	});

	it('lets Dictation run on an endpoint that lists its speech model', async () => {
		const verdict = await resolveTaskReadiness(
			'dictation',
			healthy({
				assignments: { dictation: endpoint('whisper-1') },
				listEndpointModels: vi.fn(async () => ({
					ok: true as const,
					models: [{ id: 'whisper-1' }],
				})),
			})
		);
		expect(verdict).toMatchObject({ state: 'ready', detail: 'Runs whisper-1 on Ollama.' });
	});

	it('names a speech model the endpoint does not serve', async () => {
		const verdict = await resolveTaskReadiness(
			'dictation',
			healthy({ assignments: { dictation: endpoint('whisper-1') } })
		);
		expect(verdict).toMatchObject({ state: 'unavailable', reason: 'endpoint-model-missing' });
	});

	it('offers a local model or an endpoint for Dictation while it is off', async () => {
		const verdict = await resolveTaskReadiness('dictation', healthy());
		expect(verdict.state).toBe('off');
		expect(verdict.suggestedAction).toMatch(/Assign it a local model or an endpoint in/);
	});

	it('answers ready for an endpoint that lists the model, matching a bare Ollama name to :latest', async () => {
		const verdict = await resolveTaskReadiness(
			'semantic-search',
			healthy({ assignments: { 'semantic-search': endpoint() } })
		);
		expect(verdict).toMatchObject({ state: 'ready', detail: 'Runs nomic-embed-text on Ollama.' });
	});

	it('is ready for model routing on an embedding model and on a text model alike', async () => {
		for (const modelId of [BGE_SMALL_EN_ID, QWEN3_1_7B_ID]) {
			const verdict = await resolveTaskReadiness(
				'model-routing',
				healthy({ assignments: { 'model-routing': local(modelId) } })
			);
			expect(verdict).toMatchObject({ state: 'ready', needs: 'text-gen' });
		}
	});

	it('names both kinds model routing takes when it is assigned neither', async () => {
		const verdict = await resolveTaskReadiness(
			'model-routing',
			healthy({ assignments: { 'model-routing': local(PROMPT_GUARD_2_22M_ID) } })
		);
		expect(verdict).toMatchObject({ state: 'unavailable', reason: 'model-wrong-kind' });
		expect(verdict.detail).toMatch(
			/is not a text-generation or embedding model, which Model routing needs/
		);
		expect(verdict.suggestedAction).toMatch(/^Assign a text-generation or embedding model in /);
	});

	it('checks the runtime before the model', async () => {
		const options = healthy({
			assignments: { 'semantic-search': local(BGE_SMALL_EN_ID) },
			readRuntimeFailure: vi.fn(async () => RUNTIME_DOWN),
			readModelStatus: vi.fn(async () => status('not-installed')),
		});
		const verdict = await resolveTaskReadiness('semantic-search', options);
		expect(verdict).toMatchObject({
			state: 'unavailable',
			reason: 'runtime-unavailable',
			detail: RUNTIME_DOWN.message,
			suggestedAction: RUNTIME_DOWN.suggestedAction,
			runtimeId: 'onnx',
		});
		expect(options.readModelStatus).not.toHaveBeenCalled();
	});

	it('names a stale or partial install but not the store\'s bare "Not installed"', async () => {
		const assignments: LocalModelAssignments = { 'semantic-search': local(BGE_SMALL_EN_ID) };
		const bare = await resolveTaskReadiness(
			'semantic-search',
			healthy({
				assignments,
				readModelStatus: async () => status('not-installed', 'Not installed'),
			})
		);
		expect(bare.detail).toMatch(/is not downloaded\.$/);

		const stale = await resolveTaskReadiness(
			'semantic-search',
			healthy({
				assignments,
				readModelStatus: async () => status('not-installed', 'Missing file onnx/model.onnx'),
			})
		);
		expect(stale.detail).toMatch(/\(Missing file onnx\/model\.onnx\)/);
	});

	it('never consults an endpoint for a local assignment, or the model store for an endpoint one', async () => {
		const localOptions = healthy({
			assignments: { 'semantic-search': local(BGE_SMALL_EN_ID) },
			readModelStatus: vi.fn(async () => status('not-installed')),
		});
		await resolveTaskReadiness('semantic-search', localOptions);
		expect(localOptions.findEndpoint).not.toHaveBeenCalled();
		expect(localOptions.listEndpointModels).not.toHaveBeenCalled();

		const endpointOptions = healthy({
			assignments: { 'semantic-search': endpoint() },
			listEndpointModels: vi.fn(async () => ({
				ok: false as const,
				error: { kind: 'network' as const, message: 'Ollama is not running.' },
			})),
		});
		await resolveTaskReadiness('semantic-search', endpointOptions);
		expect(endpointOptions.readModelStatus).not.toHaveBeenCalled();
		expect(endpointOptions.readRuntimeFailure).not.toHaveBeenCalled();
	});

	const cases: Array<{
		reason: LocalModelTaskUnreadyReason;
		taskId: 'semantic-search' | 'injection-screen' | 'cue-gate';
		options: ResolveTaskReadinessOptions;
		detail: RegExp;
		action: RegExp;
	}> = [
		{
			reason: 'model-unknown',
			taskId: 'semantic-search',
			options: healthy({ assignments: { 'semantic-search': local('gone-model') } }),
			detail: /"gone-model" is not a model/,
			action: /^Assign an embedding model from the Local Models catalog/,
		},
		{
			reason: 'model-wrong-kind',
			taskId: 'semantic-search',
			options: healthy({ assignments: { 'semantic-search': local(KOKORO_82M_ID) } }),
			detail: /Kokoro.* is not an embedding model, which Semantic search needs/,
			action: /^Assign an embedding model in /,
		},
		{
			reason: 'model-not-installed',
			taskId: 'semantic-search',
			options: healthy({
				assignments: { 'semantic-search': local(BGE_SMALL_EN_ID) },
				readModelStatus: async () => status('not-installed'),
			}),
			detail: /is not downloaded/,
			action: /^Download it in /,
		},
		{
			reason: 'model-corrupt',
			taskId: 'injection-screen',
			options: healthy({
				assignments: { 'injection-screen': local(PROMPT_GUARD_2_22M_ID) },
				readModelStatus: async () => status('corrupt', 'model.quant.onnx is 3 bytes'),
			}),
			detail: /failed verification \(model\.quant\.onnx is 3 bytes\)/,
			action: /^Verify or re-download it in /,
		},
		{
			reason: 'runtime-unavailable',
			taskId: 'injection-screen',
			options: healthy({
				assignments: { 'injection-screen': local(PROMPT_GUARD_2_22M_ID) },
				readRuntimeFailure: async () => RUNTIME_DOWN,
			}),
			detail: /ONNX Runtime is not downloaded/,
			action: /Download it in Settings/,
		},
		{
			reason: 'endpoint-unsupported',
			taskId: 'injection-screen',
			options: healthy({ assignments: { 'injection-screen': endpoint('guard') } }),
			detail: /needs a text-classifier model, which an endpoint cannot serve/,
			action: /Assign a local model/,
		},
		{
			reason: 'endpoint-unknown',
			taskId: 'semantic-search',
			options: healthy({
				assignments: { 'semantic-search': endpoint() },
				findEndpoint: () => ({
					ok: false,
					problem: 'unknown',
					message: 'No saved endpoint has the id "ep-1".',
				}),
			}),
			detail: /No saved endpoint/,
			action: /models endpoints add/,
		},
		{
			reason: 'endpoint-disabled',
			taskId: 'semantic-search',
			options: healthy({
				assignments: { 'semantic-search': endpoint() },
				findEndpoint: () => ({
					ok: false,
					problem: 'disabled',
					message: 'Ollama is disabled.',
					endpoint: { ...ENDPOINT, enabled: false },
				}),
			}),
			detail: /is disabled/,
			action: /Enable it/,
		},
		{
			reason: 'endpoint-key-missing',
			taskId: 'semantic-search',
			options: healthy({
				assignments: { 'semantic-search': endpoint() },
				findEndpoint: () => ({ ok: true, endpoint: { ...ENDPOINT, apiKeyEnvVar: 'OLLAMA_KEY' } }),
				listEndpointModels: async () => ({
					ok: false,
					error: { kind: 'missing-key', message: 'OLLAMA_KEY is not set.' },
				}),
			}),
			detail: /OLLAMA_KEY is not set/,
			action: /Set OLLAMA_KEY in Settings -> Environment/,
		},
		{
			reason: 'endpoint-rejected',
			taskId: 'semantic-search',
			options: healthy({
				assignments: { 'semantic-search': endpoint() },
				listEndpointModels: async () => ({
					ok: false,
					error: { kind: 'auth', message: 'Ollama answered 401.', httpStatus: 401 },
				}),
			}),
			detail: /answered 401/,
			action: /Check the API key/,
		},
		{
			reason: 'endpoint-unreachable',
			taskId: 'semantic-search',
			options: healthy({
				assignments: { 'semantic-search': endpoint() },
				listEndpointModels: async () => ({
					ok: false,
					error: { kind: 'timeout', message: 'Ollama did not answer in 5s.' },
				}),
			}),
			detail: /did not answer/,
			action: /Start Ollama, or check its base URL \(http:\/\/127\.0\.0\.1:11434\)/,
		},
		{
			reason: 'endpoint-model-missing',
			taskId: 'semantic-search',
			options: healthy({ assignments: { 'semantic-search': endpoint('mxbai-embed-large') } }),
			detail: /Ollama does not serve "mxbai-embed-large"/,
			action: /ollama pull mxbai-embed-large/,
		},
		{
			reason: 'system-one-off',
			taskId: 'cue-gate',
			options: healthy({
				assignments: { 'cue-gate': SYSTEM_ONE },
				readSystemOne: systemOne('off'),
			}),
			detail: /Cue gate is assigned to System One, and System One is off/,
			action: /^Choose an engine in Settings > Models > System One, or assign another source/,
		},
		{
			reason: 'system-one-not-ready',
			taskId: 'cue-gate',
			options: healthy({
				assignments: { 'cue-gate': SYSTEM_ONE },
				readSystemOne: systemOne('jev-cloud', 'Jev (TypeSafe cloud) has no API key.'),
			}),
			detail: /has no API key/,
			action: /^Set up Jev \(TypeSafe cloud\) in Settings > Models > System One/,
		},
	];

	it.each(cases)(
		'reports $reason with a recovery',
		async ({ reason, taskId, options, detail, action }) => {
			const verdict = await resolveTaskReadiness(taskId, options);
			expect(verdict.state).toBe('unavailable');
			expect(verdict.reason).toBe(reason);
			expect(verdict.detail).toMatch(detail);
			expect(verdict.suggestedAction).toMatch(action);
			expect(isTaskRunnable(verdict)).toBe(false);
		}
	);

	it('covers every reason in the closed list', () => {
		expect(new Set(cases.map((entry) => entry.reason))).toEqual(
			new Set(LOCAL_MODEL_TASK_UNREADY_REASONS)
		);
	});

	it('suggests loading the model on a non-Ollama server', async () => {
		const verdict = await resolveTaskReadiness(
			'semantic-search',
			healthy({
				assignments: { 'semantic-search': endpoint('text-embedding-3-small') },
				findEndpoint: () => ({
					ok: true,
					endpoint: { ...ENDPOINT, kind: 'lmstudio', name: 'LM Studio' },
				}),
			})
		);
		expect(verdict.suggestedAction).toMatch(/^Load it on LM Studio/);
	});
});

describe('an assignment to the built-in Maestro model server', () => {
	const onServer = (model: string = QWEN3_1_7B_ID) => ({
		type: 'endpoint' as const,
		endpointId: 'maestro-server',
		model,
	});
	const serverReady = (overrides: ResolveTaskReadinessOptions = {}) =>
		healthy({
			assignments: { 'tab-naming': onServer(), 'semantic-search': onServer() },
			isServerEngineInstalled: vi.fn(async () => true),
			...overrides,
		});

	it('is ready when the engine and the model are downloaded, without listing or starting anything', async () => {
		const options = serverReady();
		const verdict = await resolveTaskReadiness('tab-naming', options);

		expect(verdict.state).toBe('ready');
		expect(verdict.detail).toMatch(
			/on the Maestro model server, which starts when a task needs it/
		);
		expect(options.findEndpoint).not.toHaveBeenCalled();
		expect(options.listEndpointModels).not.toHaveBeenCalled();
		expect(options.readModelStatus).toHaveBeenCalledWith(QWEN3_1_7B_ID);
	});

	it('refuses a need other than text generation', async () => {
		const verdict = await resolveTaskReadiness('semantic-search', serverReady());
		expect(verdict).toMatchObject({ state: 'unavailable', reason: 'endpoint-unsupported' });
		expect(verdict.detail).toMatch(/serves text generation only/);
	});

	it('names a missing engine, then a model it does not serve, then one not downloaded', async () => {
		const noEngine = await resolveTaskReadiness(
			'tab-naming',
			serverReady({ isServerEngineInstalled: vi.fn(async () => false) })
		);
		expect(noEngine).toMatchObject({ state: 'unavailable', reason: 'endpoint-unreachable' });
		expect(noEngine.detail).toMatch(/llama-server\) is not downloaded/);
		expect(noEngine.suggestedAction).toMatch(/Sources/);

		const notServed = await resolveTaskReadiness(
			'tab-naming',
			serverReady({ assignments: { 'tab-naming': onServer(BGE_SMALL_EN_ID) } })
		);
		expect(notServed).toMatchObject({ state: 'unavailable', reason: 'endpoint-model-missing' });

		const notDownloaded = await resolveTaskReadiness(
			'tab-naming',
			serverReady({ readModelStatus: vi.fn(async () => status('not-installed')) })
		);
		expect(notDownloaded).toMatchObject({ state: 'unavailable', reason: 'model-not-installed' });
		expect(notDownloaded.suggestedAction).toMatch(/Download it in/);
	});
});

describe('a task assigned to System One', () => {
	it('is ready when the engine in force is set up, and names that engine', async () => {
		const options = healthy({
			assignments: { 'cue-gate': SYSTEM_ONE },
			readSystemOne: systemOne('local-judge'),
		});
		const verdict = await resolveTaskReadiness('cue-gate', options);
		expect(verdict).toMatchObject({
			state: 'ready',
			assignment: SYSTEM_ONE,
			detail: 'Asks Local judge, not calibrated.',
		});
		expect(isTaskRunnable(verdict)).toBe(true);
	});

	it('reads the engine and asks nothing: no model status, runtime or endpoint is consulted', async () => {
		const options = healthy({
			assignments: { 'cue-gate': SYSTEM_ONE },
			readSystemOne: systemOne('jev-cloud'),
		});
		await resolveTaskReadiness('cue-gate', options);
		expect(options.readSystemOne).toHaveBeenCalledTimes(1);
		expect(options.readModelStatus).not.toHaveBeenCalled();
		expect(options.readRuntimeFailure).not.toHaveBeenCalled();
		expect(options.listEndpointModels).not.toHaveBeenCalled();
	});

	it('does not read the engine for a task that is not assigned to it', async () => {
		const options = healthy({ readSystemOne: systemOne('jev-cloud') });
		await resolveAllTaskReadiness(options);
		expect(options.readSystemOne).not.toHaveBeenCalled();
	});

	it('drops the assignment from a task with no typed questions, which stays on its default', async () => {
		const options = healthy({
			assignments: { 'semantic-search': SYSTEM_ONE } as LocalModelAssignments,
			readSystemOne: systemOne('jev-cloud'),
		});
		const verdict = await resolveTaskReadiness('semantic-search', options);
		expect(verdict.state).toBe('off');
		expect(options.readSystemOne).not.toHaveBeenCalled();
	});
});

describe('resolveAllTaskReadiness', () => {
	it('answers every task in registry order and lists a shared endpoint once', async () => {
		const options = healthy({
			assignments: {
				'semantic-search': endpoint(),
				'git-drafts': endpoint('nomic-embed-text'),
			},
		});
		const all = await resolveAllTaskReadiness(options);
		expect(all.map((row: LocalModelTaskReadiness) => row.taskId)[0]).toBe('tab-naming');
		expect(all).toHaveLength(LOCAL_MODEL_TASK_IDS.length);
		expect(options.listEndpointModels).toHaveBeenCalledTimes(1);
		expect(all.find((row) => row.taskId === 'git-drafts')?.state).toBe('ready');
	});
});

describe('resolveTaskReadinessRequest', () => {
	it('answers every task for no id and a one-entry list for one', async () => {
		await expect(resolveTaskReadinessRequest(undefined)).resolves.toHaveLength(
			LOCAL_MODEL_TASK_IDS.length
		);
		const one = await resolveTaskReadinessRequest('tab-naming');
		expect(one).toHaveLength(1);
		expect(one[0].taskId).toBe('tab-naming');
	});

	it('refuses an unknown task id', async () => {
		await expect(resolveTaskReadinessRequest('tab-nameing')).rejects.toThrow(
			/Unknown task "tab-nameing"/
		);
		await expect(resolveTaskReadinessRequest(42)).rejects.toThrow(/Unknown task "42"/);
	});
});

describe('endpointListsModel', () => {
	it('matches exactly, and a bare name to its :latest tag only', () => {
		const models = [{ id: 'qwen3:latest' }, { id: 'llama3.2:3b' }];
		expect(endpointListsModel(models, 'qwen3')).toBe(true);
		expect(endpointListsModel(models, 'qwen3:latest')).toBe(true);
		expect(endpointListsModel(models, 'llama3.2:3b')).toBe(true);
		expect(endpointListsModel(models, 'llama3.2')).toBe(false);
		expect(endpointListsModel(models, 'qwen3:8b')).toBe(false);
	});
});
