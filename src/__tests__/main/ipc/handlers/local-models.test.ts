/**
 * @file local-models.test.ts
 *
 * The core Local Models IPC channels (`localModels:*`) and the service they
 * share with A Cappella's `models:*` / `runtimes:*` channels.
 *
 * Properties worth protecting:
 *
 *   - **No Encore gate.** Local Models is a core service; every channel answers
 *     with no feature flag set at all.
 *   - **Ids are validated before they reach a path join.**
 *   - **Remove cancels first**, so a live writer cannot recreate what was deleted.
 *   - **One implementation behind both transports.** A runtime install started
 *     on the core channel is joined, not duplicated, by the voice channel, and
 *     its progress is broadcast on both.
 *   - **Re-registering never doubles a broadcast.**
 *   - **Endpoint channels are thin.** `endpoints:*` hand their arguments to the
 *     endpoint service untouched, the same functions the CLI bridge calls.
 *   - **`runTask` is thin too.** It hands the task id and input to the task
 *     router's request entry, which the CLI bridge also calls.
 *   - **So is `taskReadiness`.** It hands the (optional) task id to the
 *     readiness request entry `maestro-cli models status` also reaches.
 *   - **And `draftPullRequest`.** It hands the request to the Git drafts entry
 *     `maestro-cli models run git-drafts --cwd` also reaches.
 *   - **`semanticIndex:status` reads the indexer's own record**, the one
 *     `maestro-cli models index` prints, and its progress is broadcast once.
 *   - **`search` hands its request to the one search entry** `maestro-cli
 *     search` also reaches, and returns the verdict untouched.
 *   - **Spoken notices are thin, and focus is read at the transport.**
 *     `spokenNotices:agentFinished` hands the report to the one notice entry
 *     with whether a Maestro window has focus; `spokenNotices:speak` hands its
 *     text to the entry `maestro-cli notify speak` also reaches.
 *   - **A dictation belongs to the window that started it.** The owner is the
 *     calling window, a client with no window (the web bridge) is refused
 *     before any microphone opens, an interruption reaches the owner alone,
 *     and a window that goes away or reloads takes its recording with it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ipcMain } from 'electron';

const focus = vi.hoisted(() => ({ window: null as unknown }));

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
	BrowserWindow: { getFocusedWindow: () => focus.window },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const downloader = vi.hoisted(() => {
	const listeners = new Set<(progress: unknown) => void>();
	return {
		listeners,
		onProgress: vi.fn((listener: (progress: unknown) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		download: vi.fn(async (modelId: string) => ({ modelId, status: 'complete' })),
		pause: vi.fn(() => true),
		resume: vi.fn(async (modelId: string) => ({ modelId, status: 'complete' })),
		cancel: vi.fn(async () => true),
		cancelAll: vi.fn(async () => {}),
	};
});

vi.mock('../../../../main/local-models/model-downloader', () => ({
	getModelDownloader: () => downloader,
}));

vi.mock('../../../../main/local-models/model-store', () => ({
	listStatuses: vi.fn(async () => []),
	installPathFor: vi.fn(
		(entry: { id: string }, file: { path: string }) => `/models/${entry.id}/${file.path}`
	),
	remove: vi.fn(async () => 42),
	removeAll: vi.fn(async () => 1_000),
	totalFootprint: vi.fn(async () => ({ bytes: 7 })),
	verify: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../../../main/local-models/runtime/runtime-installer', () => ({
	installNativeRuntime: vi.fn(),
}));

vi.mock('../../../../main/local-models/runtime/runtime-store', () => ({
	artifactForThisPlatform: vi.fn(() => ({ url: 'payload.tgz', bytes: 100, dependencies: [] })),
	isRuntimeInstalled: vi.fn(async () => false),
	isRuntimeStale: vi.fn(async () => false),
	removeAllRuntimes: vi.fn(async () => {}),
	runtimesFootprint: vi.fn(async () => 0),
}));

vi.mock('../../../../main/local-models/runtime/native-loader', () => ({
	resetNativeRuntimes: vi.fn(),
}));

vi.mock('../../../../main/local-models/endpoint-service', () => ({
	detectNewLocalModelEndpoints: vi.fn(async () => [
		{ kind: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', models: [] },
	]),
	listLocalModelEndpointModels: vi.fn(async () => ({ ok: true, models: [{ id: 'm' }] })),
	testLocalModelEndpoint: vi.fn(async () => ({ ok: true, model: 'm', latencyMs: 12 })),
}));

const userModels = vi.hoisted(() => ({
	listener: null as ((entries: readonly unknown[]) => void) | null,
	released: 0,
}));

vi.mock('../../../../main/local-models/user-models', () => ({
	previewHuggingFaceModel: vi.fn(async () => ({
		ok: true,
		value: { entry: { id: 'hf-x' }, alreadyAdded: false },
	})),
	addHuggingFaceModel: vi.fn(async () => ({
		ok: true,
		value: { entry: { id: 'hf-x' }, added: true },
	})),
	removeUserLocalModel: vi.fn(async () => ({ ok: false, message: 'No model you added.' })),
	listUserLocalModels: vi.fn(() => [{ id: 'hf-x' }]),
	onUserLocalModelsChanged: vi.fn((listener: (entries: readonly unknown[]) => void) => {
		userModels.listener = listener;
		return () => {
			userModels.released++;
		};
	}),
}));

vi.mock('../../../../main/local-models/hardware', () => ({
	resolveHardwareProfile: vi.fn(async () => ({
		platform: 'darwin',
		arch: 'arm64',
		totalMemoryBytes: 16 * 1024 ** 3,
		unifiedMemory: true,
		gpus: [],
	})),
}));

vi.mock('../../../../main/local-models/task-router', () => ({
	runLocalTaskRequest: vi.fn(async () => ({ status: 'use-utility-agent' })),
}));

vi.mock('../../../../main/local-models/task-readiness', () => ({
	resolveTaskReadinessRequest: vi.fn(async () => [{ taskId: 'semantic-search', state: 'off' }]),
}));

vi.mock('../../../../main/local-models/git-drafts', () => ({
	draftPullRequestRequest: vi.fn(async () => ({
		success: false,
		status: 'off',
		error: 'Git drafts is off.',
	})),
}));

const semanticIndex = vi.hoisted(() => {
	const listeners = new Set<(progress: unknown) => void>();
	return {
		listeners,
		progress: {
			state: 'indexing',
			indexed: 3,
			total: 10,
			bySourceType: {
				history: { indexed: 3, total: 8 },
				'directors-notes': { indexed: 0, total: 1 },
				transcript: { indexed: 0, total: 1 },
			},
			modelId: 'local:bge-small-en-v1.5',
		},
	};
});

vi.mock('../../../../main/local-models/semantic-indexer', () => ({
	semanticIndexStorage: vi.fn(async () => ({
		totalChunks: 3,
		models: [],
		sizeBytes: 4096,
		diskBytes: 8192,
	})),
	clearSemanticIndex: vi.fn(async () => ({
		totalChunks: 0,
		models: [],
		sizeBytes: 4096,
		diskBytes: 4096,
	})),
	semanticIndexProgress: vi.fn(() => semanticIndex.progress),
	onSemanticIndexProgress: vi.fn((listener: (progress: unknown) => void) => {
		semanticIndex.listeners.add(listener);
		return () => semanticIndex.listeners.delete(listener);
	}),
}));

const tokenProxy = vi.hoisted(() => ({
	report: {
		status: { port: 48123, running: true, agentIds: ['a'], lastError: null, gatewayUrls: null },
		agents: [],
		usage: null,
		recentCompressions: [],
	},
	block: { hash: 'a'.repeat(64), original: 'long', compressed: 'short' },
}));

vi.mock('../../../../main/local-models/proxy/service', () => ({
	getTokenProxyReport: vi.fn(async () => tokenProxy.report),
	ensureTokenProxyPort: vi.fn(async () => 48123),
	readTokenProxyBlock: vi.fn(async () => tokenProxy.block),
}));

vi.mock('../../../../main/local-models/tab-cleanup', () => ({
	suggestTabCleanup: vi.fn(async () => ({
		success: false,
		status: 'off',
		error: 'Tab cleanup suggestions is off.',
	})),
}));

vi.mock('../../../../main/local-models/work-search', () => ({
	browseSemanticIndexRequest: vi.fn(async () => ({ entries: [], total: 0, offset: 0, limit: 20 })),
	searchPastWorkRequest: vi.fn(async () => ({ status: 'off' })),
}));

vi.mock('../../../../main/local-models/run-on-test', () => ({
	testAgentRunOn: vi.fn(async () => ({
		ok: false,
		code: 'run-on-source-disabled',
		message: 'The source "Ollama" is disabled.',
	})),
}));

vi.mock('../../../../main/local-models/system-one/service', () => {
	const report = { settings: { engine: 'jev-cloud' }, engineLabel: 'Jev (TypeSafe cloud)' };
	return {
		getSystemOneReport: vi.fn(async () => report),
		updateSystemOneSettingsRequest: vi.fn(async () => report),
		setSystemOneKeyRequest: vi.fn(async () => report),
		clearSystemOneKeyRequest: vi.fn(async () => report),
		testSystemOne: vi.fn(async () => ({ ok: true, engine: 'jev-cloud', probability: 0.97 })),
	};
});

vi.mock('../../../../main/local-models/system-one/agent-service', () => ({
	getSystemOneAgentAccessRequest: vi.fn(async () => ({
		allowed: false,
		gate: 'engine-untested',
		message: 'System One is off: Jev (TypeSafe cloud) has not passed its Test.',
		reason: 'System One is off: Jev (TypeSafe cloud) has not passed its Test.',
		engine: 'jev-cloud',
		engineLabel: 'Jev (TypeSafe cloud)',
		calibrated: true,
		budget: { dayStartedAt: 0, dailyBudgetUsd: 1, spentTodayUsd: 0, remainingTodayUsd: 1 },
	})),
	readSystemOneAgentUsage: vi.fn(async () => ({
		since: 0,
		retentionDays: 30,
		rows: [],
		totals: { requests: 0, cachedRequests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
		budget: { dayStartedAt: 0, dailyBudgetUsd: 1, spentTodayUsd: 0.2, remainingTodayUsd: 0.8 },
		engine: 'jev-cloud',
		engineLabel: 'Jev (TypeSafe cloud)',
		notice: null,
	})),
}));
vi.mock('../../../../main/local-models/system-one/decisions', () => ({
	readSystemOneLedger: vi.fn(() => ({ entries: [], total: 0, retentionDays: 30, notice: null })),
}));

vi.mock('../../../../main/local-models/tier-options', () => ({
	listHarnessTierOptionsRequest: vi.fn(async () => [
		{
			harness: 'codex',
			name: 'Codex',
			installed: true,
			catalog: [{ id: 'gpt-6-luna', priority: 4 }],
			runOn: { supported: true },
			sources: [],
			problems: [],
		},
	]),
}));

const dictation = vi.hoisted(() => {
	const listeners = new Set<(ownerId: string, interruption: unknown) => void>();
	return {
		listeners,
		startDictation: vi.fn(async (_ownerId: string) => ({ started: true })),
		stopDictation: vi.fn(async (_ownerId: string) => ({
			status: 'ok',
			text: 'Ship it.',
			audioMs: 900,
		})),
		cancelDictation: vi.fn(async (_ownerId: string) => {}),
		onDictationInterrupted: vi.fn((listener: (ownerId: string, interruption: unknown) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
	};
});

vi.mock('../../../../main/local-models/dictation', () => dictation);

const spokenNotices = vi.hoisted(() => ({
	announceAgentFinishedRequest: vi.fn(async (_notice: unknown, _context: unknown) => ({
		spoken: true,
		text: 'Backend finished',
		lineSource: 'fallback',
	})),
	speakNoticeRequest: vi.fn(async (text: unknown) => ({
		spoken: true,
		text,
		lineSource: 'given',
	})),
}));

vi.mock('../../../../main/local-models/spoken-notices', () => spokenNotices);

import {
	registerLocalModelsHandlers,
	DICTATION_INTERRUPTED_CHANNEL,
	LOCAL_MODEL_PROGRESS_CHANNEL,
	LOCAL_RUNTIME_PROGRESS_CHANNEL,
	SEMANTIC_INDEX_PROGRESS_CHANNEL,
} from '../../../../main/ipc/handlers/local-models';
import {
	registerACappellaModelsHandlers,
	ACAPPELLA_RUNTIME_PROGRESS_CHANNEL,
} from '../../../../main/ipc/handlers/acappella-models';
import type { LocalRuntimeListing } from '../../../../main/local-models/service';
import { LOCAL_MODEL_CATALOG, getLocalModel } from '../../../../shared/local-models/model-catalog';
import { remove, removeAll, verify } from '../../../../main/local-models/model-store';
import { installNativeRuntime } from '../../../../main/local-models/runtime/runtime-installer';
import { testAgentRunOn } from '../../../../main/local-models/run-on-test';
import {
	clearSystemOneKeyRequest,
	getSystemOneReport,
	setSystemOneKeyRequest,
	testSystemOne,
	updateSystemOneSettingsRequest,
} from '../../../../main/local-models/system-one/service';
import { readSystemOneLedger } from '../../../../main/local-models/system-one/decisions';
import {
	getSystemOneAgentAccessRequest,
	readSystemOneAgentUsage,
} from '../../../../main/local-models/system-one/agent-service';
import { listHarnessTierOptionsRequest } from '../../../../main/local-models/tier-options';
import {
	artifactForThisPlatform,
	isRuntimeInstalled,
	isRuntimeStale,
	removeAllRuntimes,
} from '../../../../main/local-models/runtime/runtime-store';
import { resetNativeRuntimes } from '../../../../main/local-models/runtime/native-loader';
import {
	listLocalModelEndpointModels,
	testLocalModelEndpoint,
} from '../../../../main/local-models/endpoint-service';
import { runLocalTaskRequest } from '../../../../main/local-models/task-router';
import { resolveTaskReadinessRequest } from '../../../../main/local-models/task-readiness';
import { draftPullRequestRequest } from '../../../../main/local-models/git-drafts';
import {
	searchPastWorkRequest,
	browseSemanticIndexRequest,
} from '../../../../main/local-models/work-search';
import { clearSemanticIndex } from '../../../../main/local-models/semantic-indexer';
import {
	ensureTokenProxyPort,
	readTokenProxyBlock,
} from '../../../../main/local-models/proxy/service';
import { suggestTabCleanup } from '../../../../main/local-models/tab-cleanup';
import {
	addHuggingFaceModel,
	previewHuggingFaceModel,
	removeUserLocalModel,
} from '../../../../main/local-models/user-models';
import { USER_LOCAL_MODELS_CHANGED_CHANNEL } from '../../../../main/ipc/handlers/local-models';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const MODEL_ID = LOCAL_MODEL_CATALOG[0].id;
const broadcasts: Array<{ channel: string; payload: unknown }> = [];
const safeSend = vi.fn((channel: string, payload: unknown) => {
	broadcasts.push({ channel, payload });
});

/** The most recent registration for a channel (handlers are re-registered per test). */
function handlerFor(channel: string): Handler {
	const registration = vi
		.mocked(ipcMain.handle)
		.mock.calls.filter(([registered]) => registered === channel)
		.at(-1);
	expect(registration, `no handler registered for ${channel}`).toBeDefined();
	return registration?.[1] as unknown as Handler;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	broadcasts.length = 0;
	registerLocalModelsHandlers({ safeSend: safeSend as never });
});

describe('Local Models IPC handlers', () => {
	it('answers every channel with no Encore Feature enabled', async () => {
		// No settings store exists on this transport at all: the gate is a
		// consumer's concern, never the core service's.
		await expect(handlerFor('localModels:list')({})).resolves.toHaveLength(
			LOCAL_MODEL_CATALOG.length
		);
		await expect(handlerFor('localModels:footprint')({})).resolves.toEqual({ bytes: 7 });
		await expect(handlerFor('localModels:runtimes:list')({})).resolves.not.toHaveLength(0);
	});

	it('reads the hardware the fit labels are judged against', async () => {
		await expect(handlerFor('localModels:hardware')({})).resolves.toMatchObject({
			unifiedMemory: true,
			totalMemoryBytes: 16 * 1024 ** 3,
		});
	});

	it('looks up, adds and removes a Hugging Face model through the one service', async () => {
		await expect(
			handlerFor('localModels:hf:preview')({}, 'owner/repo', 'model.gguf')
		).resolves.toMatchObject({ ok: true, value: { alreadyAdded: false } });
		expect(previewHuggingFaceModel).toHaveBeenCalledWith('owner/repo', 'model.gguf');

		await expect(
			handlerFor('localModels:hf:add')({}, 'owner/repo', 'model.gguf')
		).resolves.toMatchObject({ ok: true, value: { added: true } });
		expect(addHuggingFaceModel).toHaveBeenCalledWith('owner/repo', 'model.gguf');

		// A refusal the user can act on is an answer, not a rejection.
		await expect(handlerFor('localModels:hf:remove')({}, 'hf-nope')).resolves.toEqual({
			ok: false,
			message: 'No model you added.',
		});
		expect(removeUserLocalModel).toHaveBeenCalledWith('hf-nope');
		await expect(handlerFor('localModels:userModels')({})).resolves.toEqual([{ id: 'hf-x' }]);
	});

	it('broadcasts the user models after every change, once per registration', () => {
		userModels.listener?.([{ id: 'hf-x' }]);
		expect(broadcasts).toContainEqual({
			channel: USER_LOCAL_MODELS_CHANGED_CHANNEL,
			payload: [{ id: 'hf-x' }],
		});
		const released = userModels.released;
		registerLocalModelsHandlers({ safeSend: safeSend as never });
		expect(userModels.released).toBe(released + 1);
	});

	it('lists every catalog model with its install paths', async () => {
		const listings = (await handlerFor('localModels:list')({})) as Array<{
			entry: { id: string };
			installPaths: string[];
		}>;
		expect(listings[0].entry.id).toBe(MODEL_ID);
		expect(listings[0].installPaths[0]).toContain(`/models/${MODEL_ID}/`);
	});

	it('delegates download, pause, resume, cancel, and verify for a catalog id', async () => {
		await handlerFor('localModels:download')({}, MODEL_ID);
		await handlerFor('localModels:pause')({}, MODEL_ID);
		await handlerFor('localModels:resume')({}, MODEL_ID);
		await handlerFor('localModels:cancel')({}, MODEL_ID);
		await handlerFor('localModels:verify')({}, MODEL_ID);

		expect(downloader.download).toHaveBeenCalledWith(MODEL_ID);
		expect(downloader.pause).toHaveBeenCalledWith(MODEL_ID);
		expect(downloader.resume).toHaveBeenCalledWith(MODEL_ID);
		expect(downloader.cancel).toHaveBeenCalledWith(MODEL_ID);
		expect(verify).toHaveBeenCalledWith(MODEL_ID);
	});

	describe('download installs the engine the model runs on', () => {
		const runtimeId = getLocalModel(MODEL_ID)!.runtime;

		it('fetches a missing engine alongside the model and reports both', async () => {
			vi.mocked(installNativeRuntime).mockResolvedValue({} as never);
			vi.mocked(isRuntimeInstalled).mockResolvedValue(false);

			const result = await handlerFor('localModels:download')({}, MODEL_ID);

			expect(downloader.download).toHaveBeenCalledWith(MODEL_ID);
			expect(vi.mocked(installNativeRuntime).mock.calls[0][0]).toBe(runtimeId);
			expect(resetNativeRuntimes).toHaveBeenCalled();
			expect(result).toMatchObject({
				modelId: MODEL_ID,
				status: 'complete',
				runtime: { runtimeId, status: 'installed' },
			});
		});

		it('leaves an engine that is installed and current alone', async () => {
			vi.mocked(isRuntimeInstalled).mockResolvedValue(true);
			vi.mocked(isRuntimeStale).mockResolvedValue(false);

			const result = await handlerFor('localModels:download')({}, MODEL_ID);

			expect(installNativeRuntime).not.toHaveBeenCalled();
			expect(result).toMatchObject({ runtime: { runtimeId, status: 'ready' } });
		});

		it('replaces an engine this build no longer expects', async () => {
			vi.mocked(installNativeRuntime).mockResolvedValue({} as never);
			vi.mocked(isRuntimeInstalled).mockResolvedValue(true);
			vi.mocked(isRuntimeStale).mockResolvedValue(true);

			const result = await handlerFor('localModels:download')({}, MODEL_ID);

			expect(installNativeRuntime).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({ runtime: { status: 'installed' } });
		});

		it('says the platform has no build without calling the installer', async () => {
			vi.mocked(isRuntimeInstalled).mockResolvedValue(false);
			vi.mocked(artifactForThisPlatform).mockReturnValueOnce(null);

			const result = await handlerFor('localModels:download')({}, MODEL_ID);

			expect(installNativeRuntime).not.toHaveBeenCalled();
			expect(result).toMatchObject({ status: 'complete', runtime: { status: 'unavailable' } });
		});

		it('reports a failed engine install beside a model that did arrive', async () => {
			vi.mocked(isRuntimeInstalled).mockResolvedValue(false);
			vi.mocked(installNativeRuntime).mockRejectedValue(new Error('hash mismatch'));

			const result = await handlerFor('localModels:download')({}, MODEL_ID);

			// Not a rejection: the weights are on disk, and the caller has to be able
			// to say both things.
			expect(result).toMatchObject({
				status: 'complete',
				runtime: { runtimeId, status: 'failed', error: 'hash mismatch' },
			});
		});
	});

	it('rejects an id that is not in the catalog before it reaches a path join', async () => {
		for (const channel of ['localModels:download', 'localModels:remove', 'localModels:verify']) {
			await expect(handlerFor(channel)({}, '../../etc/passwd')).rejects.toThrow(
				'UnknownLocalModel'
			);
		}
		expect(downloader.download).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it('cancels a live download before deleting the model', async () => {
		await expect(handlerFor('localModels:remove')({}, MODEL_ID)).resolves.toBe(42);
		expect(downloader.cancel.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(remove).mock.invocationCallOrder[0]
		);

		await expect(handlerFor('localModels:remove-all')({})).resolves.toBe(1_000);
		expect(downloader.cancelAll.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(removeAll).mock.invocationCallOrder[0]
		);
	});

	it('broadcasts download progress on its own channel, once per registration', async () => {
		// A second registration must replace the first listener, not add to it.
		registerLocalModelsHandlers({ safeSend: safeSend as never });
		for (const listener of downloader.listeners) listener({ modelId: MODEL_ID });

		const progress = broadcasts.filter((b) => b.channel === LOCAL_MODEL_PROGRESS_CHANNEL);
		expect(progress).toEqual([
			{ channel: LOCAL_MODEL_PROGRESS_CHANNEL, payload: { modelId: MODEL_ID } },
		]);
	});

	it('lists each runtime with the models that need it', async () => {
		const listings = (await handlerFor('localModels:runtimes:list')({})) as LocalRuntimeListing[];
		for (const listing of listings) {
			expect(listing).not.toHaveProperty('slots');
			expect(Array.isArray(listing.models)).toBe(true);
			expect(listing.bytes).toBe(100);
		}
		expect(listings.some((listing) => listing.models.length > 0)).toBe(true);
	});

	it('installs a runtime, resets the loader, and rejects an unknown id', async () => {
		vi.mocked(installNativeRuntime).mockResolvedValue({} as never);

		await expect(handlerFor('localModels:runtimes:install')({}, 'onnx')).resolves.toBe(true);
		expect(resetNativeRuntimes).toHaveBeenCalled();

		await expect(handlerFor('localModels:runtimes:install')({}, 'cuda')).rejects.toThrow(
			'UnknownLocalRuntime'
		);
	});

	it('frees runtime disk and drops whatever is dlopened', async () => {
		await expect(handlerFor('localModels:runtimes:remove-all')({})).resolves.toBeUndefined();
		expect(removeAllRuntimes).toHaveBeenCalled();
		expect(resetNativeRuntimes).toHaveBeenCalled();
	});
});

describe('one service behind both transports', () => {
	beforeEach(() => {
		registerACappellaModelsHandlers({
			settingsStore: {
				get: (key: string) => (key === 'encoreFeatures' ? { aCappella: true } : undefined),
			},
			safeSend: safeSend as never,
		});
	});

	it('joins a runtime install started on the other transport and broadcasts on both', async () => {
		const gate = deferred<never>();
		vi.mocked(installNativeRuntime).mockImplementation((async (_id, options) => {
			options?.onProgress?.({ runtimeId: 'onnx', phase: 'downloading', bytes: 1, totalBytes: 2 });
			return gate.promise;
		}) as never);

		const core = handlerFor('localModels:runtimes:install')({}, 'onnx');
		const voice = handlerFor('runtimes:install')({}, 'onnx');
		gate.resolve({} as never);

		await expect(Promise.all([core, voice])).resolves.toEqual([true, true]);
		expect(installNativeRuntime).toHaveBeenCalledTimes(1);

		const channels = broadcasts.map((b) => b.channel);
		expect(channels).toContain(LOCAL_RUNTIME_PROGRESS_CHANNEL);
		expect(channels).toContain(ACAPPELLA_RUNTIME_PROGRESS_CHANNEL);
	});

	it('serves the voice model channels from the same service', async () => {
		await handlerFor('models:download')({}, MODEL_ID);
		expect(downloader.download).toHaveBeenCalledWith(MODEL_ID);
		await expect(handlerFor('models:remove')({}, 'nope')).rejects.toThrow('UnknownLocalModel');
	});
});

describe('endpoint channels', () => {
	it('detects without arguments', async () => {
		await expect(handlerFor('localModels:endpoints:detect')({})).resolves.toEqual([
			expect.objectContaining({ kind: 'ollama' }),
		]);
	});

	it('hands listModels its endpoint reference untouched', async () => {
		await expect(handlerFor('localModels:endpoints:listModels')({}, 'ep-1')).resolves.toEqual({
			ok: true,
			models: [{ id: 'm' }],
		});
		expect(listLocalModelEndpointModels).toHaveBeenCalledWith('ep-1');
	});

	it('hands test its endpoint reference and model untouched', async () => {
		const draft = { id: 'draft' };
		await expect(handlerFor('localModels:endpoints:test')({}, draft, 'llama')).resolves.toEqual({
			ok: true,
			model: 'm',
			latencyMs: 12,
		});
		expect(testLocalModelEndpoint).toHaveBeenCalledWith(draft, 'llama');
	});
});

describe('task router channel', () => {
	it('hands runTask its task id and input untouched', async () => {
		const input = { prompt: 'Fix the login timeout' };
		await expect(handlerFor('localModels:runTask')({}, 'tab-naming', input)).resolves.toEqual({
			status: 'use-utility-agent',
		});
		expect(runLocalTaskRequest).toHaveBeenCalledWith('tab-naming', input);
	});

	it('hands taskReadiness the task id untouched, including none', async () => {
		await expect(handlerFor('localModels:taskReadiness')({}, 'semantic-search')).resolves.toEqual([
			{ taskId: 'semantic-search', state: 'off' },
		]);
		expect(resolveTaskReadinessRequest).toHaveBeenLastCalledWith('semantic-search');

		await handlerFor('localModels:taskReadiness')({});
		expect(resolveTaskReadinessRequest).toHaveBeenLastCalledWith(undefined);
	});

	it('hands draftPullRequest its request untouched and returns the verdict', async () => {
		const request = { cwd: '/repo', baseBranch: 'main' };
		await expect(handlerFor('localModels:draftPullRequest')({}, request)).resolves.toEqual({
			success: false,
			status: 'off',
			error: 'Git drafts is off.',
		});
		expect(draftPullRequestRequest).toHaveBeenCalledWith(request);
	});

	it('asks for tab cleanup suggestions with no argument and returns the verdict', async () => {
		// A renderer cannot steer which tabs are read: whatever it sends is dropped.
		await expect(
			handlerFor('localModels:suggestTabCleanup')({}, { sessions: [] })
		).resolves.toEqual({
			success: false,
			status: 'off',
			error: 'Tab cleanup suggestions is off.',
		});
		expect(suggestTabCleanup).toHaveBeenCalledWith();
	});

	it('hands a Run on test its request untouched and returns the verdict', async () => {
		const request = {
			agentId: 'agent-1',
			target: { type: 'source', endpointId: 'ep-1', model: 'm' },
			subject: { toolType: 'codex' },
		};
		await expect(handlerFor('localModels:runOn:test')({}, request)).resolves.toEqual({
			ok: false,
			code: 'run-on-source-disabled',
			message: 'The source "Ollama" is disabled.',
		});
		expect(testAgentRunOn).toHaveBeenCalledWith(request);
	});

	it('reads the System One report without asking the engine', async () => {
		await expect(handlerFor('localModels:systemOne:report')({})).resolves.toMatchObject({
			engineLabel: 'Jev (TypeSafe cloud)',
		});
		expect(getSystemOneReport).toHaveBeenCalled();
		expect(testSystemOne).not.toHaveBeenCalled();
	});

	it('hands a System One change, a key and a clear to the service untouched', async () => {
		const patch = { engine: 'openjev', openJevUrl: 'https://gpu.lan:8000' };
		await handlerFor('localModels:systemOne:set')({}, patch);
		expect(updateSystemOneSettingsRequest).toHaveBeenCalledWith(patch);

		const key = { engine: 'jev-cloud', key: 'sk-ipc-test-0123456789abcdef' };
		const stored = await handlerFor('localModels:systemOne:setKey')({}, key);
		expect(setSystemOneKeyRequest).toHaveBeenCalledWith(key);
		// The answer is the report. No channel returns a key.
		expect(JSON.stringify(stored)).not.toContain(key.key);

		await handlerFor('localModels:systemOne:clearKey')({}, { engine: 'openjev' });
		expect(clearSystemOneKeyRequest).toHaveBeenCalledWith({ engine: 'openjev' });
	});

	it('runs the System One test and returns its verdict', async () => {
		await expect(handlerFor('localModels:systemOne:test')({})).resolves.toMatchObject({
			ok: true,
			probability: 0.97,
		});
		expect(testSystemOne).toHaveBeenCalledTimes(1);
	});

	it('reads the System One ledger with the query it was handed, and asks the engine nothing', async () => {
		vi.mocked(testSystemOne).mockClear();
		const query = { taskId: 'cue-gate', outcome: 'timeout' };

		await expect(handlerFor('localModels:systemOne:ledger')({}, query)).resolves.toEqual({
			entries: [],
			total: 0,
			retentionDays: 30,
			notice: null,
		});

		expect(readSystemOneLedger).toHaveBeenCalledWith(query);
		expect(testSystemOne).not.toHaveBeenCalled();
	});

	it('answers whether one agent may ask System One, and asks the engine nothing', async () => {
		vi.mocked(testSystemOne).mockClear();

		await expect(
			handlerFor('localModels:systemOne:agentAccess')({}, 'agent-7')
		).resolves.toMatchObject({ allowed: false, gate: 'engine-untested', engine: 'jev-cloud' });

		// The agent id arrives as the first argument, not shifted by the IPC event.
		expect(getSystemOneAgentAccessRequest).toHaveBeenCalledWith('agent-7');
		expect(testSystemOne).not.toHaveBeenCalled();
	});

	it('reads what agents spent through the function the CLI reaches, and asks the engine nothing', async () => {
		vi.mocked(testSystemOne).mockClear();
		const query = { since: 1_700_000_000_000 };

		await expect(handlerFor('localModels:systemOne:usage')({}, query)).resolves.toMatchObject({
			rows: [],
			budget: { dailyBudgetUsd: 1, spentTodayUsd: 0.2 },
			engine: 'jev-cloud',
		});

		// The query arrives as the first argument, not shifted by the IPC event, and
		// no caller is named: the table is for the user, not for one agent.
		expect(readSystemOneAgentUsage).toHaveBeenCalledWith(query);
		expect(testSystemOne).not.toHaveBeenCalled();
	});

	it('hands a tier options request to the service and returns its rows', async () => {
		const request = { harness: 'codex', refresh: true };
		await expect(handlerFor('localModels:tiers:options')({}, request)).resolves.toEqual([
			expect.objectContaining({ harness: 'codex', catalog: [{ id: 'gpt-6-luna', priority: 4 }] }),
		]);
		expect(listHarnessTierOptionsRequest).toHaveBeenCalledWith(request);
	});

	it('hands search its request untouched and returns the verdict', async () => {
		const request = { query: 'retry logic', mode: 'semantic', agentId: 'agent-1' };
		await expect(handlerFor('localModels:search')({}, request)).resolves.toEqual({
			status: 'off',
		});
		expect(searchPastWorkRequest).toHaveBeenCalledWith(request);
	});
});

describe('token proxy channels', () => {
	it('answers report with the proxy report, untouched', async () => {
		await expect(handlerFor('localModels:proxy:report')({})).resolves.toBe(tokenProxy.report);
	});

	it('answers ensurePort with the port the service chose', async () => {
		await expect(handlerFor('localModels:proxy:ensurePort')({})).resolves.toBe(48123);
		expect(ensureTokenProxyPort).toHaveBeenCalledTimes(1);
	});

	it('hands block the hash as it arrived, for the service to check', async () => {
		await expect(handlerFor('localModels:proxy:block')({}, '../not-a-hash')).resolves.toBe(
			tokenProxy.block
		);
		expect(readTokenProxyBlock).toHaveBeenCalledWith('../not-a-hash');
	});
});

describe('semantic index channels', () => {
	it('exposes actual storage bytes, bounded browsing, and the serialized clear operation', async () => {
		await expect(handlerFor('localModels:semanticIndex:storage')({})).resolves.toMatchObject({
			diskBytes: 8192,
		});
		const request = { modelId: 'local:bge-small-en-v1.5', offset: 20 };
		await handlerFor('localModels:semanticIndex:browse')({}, request);
		expect(browseSemanticIndexRequest).toHaveBeenCalledWith(request);
		await expect(handlerFor('localModels:semanticIndex:clear')({})).resolves.toMatchObject({
			totalChunks: 0,
		});
		expect(clearSemanticIndex).toHaveBeenCalledOnce();
	});
	it('answers status with the indexer record, untouched', async () => {
		await expect(handlerFor('localModels:semanticIndex:status')({})).resolves.toBe(
			semanticIndex.progress
		);
	});

	it('broadcasts the indexer progress on its own channel', () => {
		const update = { ...semanticIndex.progress, indexed: 4 };
		for (const listener of semanticIndex.listeners) listener(update);

		expect(broadcasts).toEqual([{ channel: SEMANTIC_INDEX_PROGRESS_CHANNEL, payload: update }]);
	});

	it('broadcasts once however many times the handlers are registered', () => {
		registerLocalModelsHandlers({ safeSend: safeSend as never });
		registerLocalModelsHandlers({ safeSend: safeSend as never });
		expect(semanticIndex.listeners.size).toBe(1);

		for (const listener of semanticIndex.listeners) listener(semanticIndex.progress);
		expect(broadcasts).toHaveLength(1);
	});
});

describe('spoken notices channels', () => {
	const NOTICE = { agentName: 'Backend', response: 'Done.' };

	it('reports a finished turn with whether a Maestro window has focus', async () => {
		focus.window = null;
		await expect(
			handlerFor('localModels:spokenNotices:agentFinished')({}, NOTICE)
		).resolves.toMatchObject({ spoken: true, text: 'Backend finished' });
		expect(spokenNotices.announceAgentFinishedRequest).toHaveBeenLastCalledWith(NOTICE, {
			appFocused: false,
			safeSend,
		});

		focus.window = { id: 1 };
		await handlerFor('localModels:spokenNotices:agentFinished')({}, NOTICE);
		expect(spokenNotices.announceAgentFinishedRequest).toHaveBeenLastCalledWith(NOTICE, {
			appFocused: true,
			safeSend,
		});
	});

	it('hands text to speak to the entry the CLI also reaches', async () => {
		await expect(
			handlerFor('localModels:spokenNotices:speak')({}, 'The build is green.')
		).resolves.toEqual({ spoken: true, text: 'The build is green.', lineSource: 'given' });
		expect(spokenNotices.speakNoticeRequest).toHaveBeenCalledWith('The build is green.');
	});

	it('answers with no Encore Feature switched on', async () => {
		// Registered by the core handlers, which read no feature flag at all.
		const channels = vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel);
		expect(channels).toContain('localModels:spokenNotices:agentFinished');
		expect(channels).toContain('localModels:spokenNotices:speak');
	});
});

describe('dictation channels', () => {
	/** A window's webContents: an id, a send, and the two lifecycle events. */
	function fakeWindow(id: number) {
		const handlers = new Map<string, Array<() => void>>();
		const listen = (event: string, handler: () => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		};
		return {
			id,
			send: vi.fn(),
			isDestroyed: vi.fn(() => false),
			on: vi.fn(listen),
			once: vi.fn(listen),
			emit: (event: string) => {
				for (const handler of handlers.get(event) ?? []) handler();
			},
		};
	}

	it('starts, stops, and cancels for the calling window', async () => {
		const sender = fakeWindow(41);

		await expect(handlerFor('localModels:dictation:start')({ sender })).resolves.toEqual({
			started: true,
		});
		await expect(handlerFor('localModels:dictation:stop')({ sender })).resolves.toMatchObject({
			status: 'ok',
			text: 'Ship it.',
		});
		await handlerFor('localModels:dictation:cancel')({ sender });

		expect(dictation.startDictation).toHaveBeenCalledWith('window:41');
		expect(dictation.stopDictation).toHaveBeenCalledWith('window:41');
		expect(dictation.cancelDictation).toHaveBeenCalledWith('window:41');
	});

	it('refuses a client with no window before any microphone is opened', async () => {
		// The web bridge invokes handlers with a placeholder event and no sender.
		await expect(handlerFor('localModels:dictation:start')({})).resolves.toMatchObject({
			started: false,
			code: 'no-microphone',
			message: expect.stringContaining('not available from a browser'),
		});
		await expect(handlerFor('localModels:dictation:stop')({})).resolves.toEqual({
			status: 'idle',
		});
		await handlerFor('localModels:dictation:cancel')({});

		expect(dictation.startDictation).not.toHaveBeenCalled();
		expect(dictation.stopDictation).not.toHaveBeenCalled();
		expect(dictation.cancelDictation).not.toHaveBeenCalled();
	});

	it('tells only the owning window that its recording ended, and never broadcasts it', async () => {
		const owner = fakeWindow(51);
		const other = fakeWindow(52);
		await handlerFor('localModels:dictation:start')({ sender: owner });
		await handlerFor('localModels:dictation:stop')({ sender: other });

		const interruption = { code: 'device-lost', message: 'The microphone stopped.' };
		for (const listener of dictation.listeners) listener('window:51', interruption);

		expect(owner.send).toHaveBeenCalledWith(DICTATION_INTERRUPTED_CHANNEL, interruption);
		expect(other.send).not.toHaveBeenCalled();
		expect(broadcasts).toEqual([]);
	});

	it('does not send to a window that is already gone', async () => {
		const owner = fakeWindow(61);
		await handlerFor('localModels:dictation:start')({ sender: owner });
		owner.isDestroyed.mockReturnValue(true);

		for (const listener of dictation.listeners) {
			listener('window:61', { code: 'max-duration', message: 'Stopped.' });
		}
		expect(owner.send).not.toHaveBeenCalled();
	});

	it('cancels a recording whose window reloads or is destroyed', async () => {
		const sender = fakeWindow(71);
		await handlerFor('localModels:dictation:start')({ sender });
		expect(dictation.cancelDictation).not.toHaveBeenCalled();

		sender.emit('did-navigate');
		expect(dictation.cancelDictation).toHaveBeenCalledWith('window:71');

		sender.emit('destroyed');
		expect(dictation.cancelDictation).toHaveBeenCalledTimes(2);
	});

	it('watches a window once however many times it dictates', async () => {
		const sender = fakeWindow(81);
		await handlerFor('localModels:dictation:start')({ sender });
		await handlerFor('localModels:dictation:stop')({ sender });
		await handlerFor('localModels:dictation:start')({ sender });

		expect(sender.on).toHaveBeenCalledTimes(1);
		expect(sender.once).toHaveBeenCalledTimes(1);
	});

	it('listens for interruptions once however many times the handlers are registered', () => {
		registerLocalModelsHandlers({ safeSend: safeSend as never });
		registerLocalModelsHandlers({ safeSend: safeSend as never });
		expect(dictation.listeners.size).toBe(1);
	});
});
