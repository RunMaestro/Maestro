/**
 * The Maestro model server as the Model server card and `maestro-cli models
 * server` see it: one report (state, engine, loaded models, install progress),
 * the engine install with its build choice, and the settings change.
 *
 * Both transports call these functions, the card through the
 * `localModels:server:*` IPC channels and the CLI through the WS bridge, so a
 * Start pressed in one is the server the other reports. The lifecycle itself
 * (start, stop, the key, crash restarts) is `supervisor.ts`; this module only
 * joins it to the engine store and the catalog, and validates what a caller
 * sent.
 */

import { getLocalModel, localModelGgufFile } from '../../../shared/local-models/model-catalog';
import {
	MODEL_SERVER_NAME,
	type ModelServerBuildOption,
	type ModelServerEngineInfo,
	type ModelServerEngineProgress,
	type ModelServerLoadedModel,
	type ModelServerReport,
	type ModelServerStatus,
} from '../../../shared/local-models/model-server';
import {
	availableServerBuildChoices,
	isServerBuildChoice,
	SERVER_BUILD_CHOICES,
	selectServerBuild,
	serverBuildDownloadBytes,
	type ServerBuildChoice,
} from '../../../shared/local-models/server-engine';
import { logger } from '../../utils/logger';
import { ModelServerError } from '../errors';
import { installServerEngine, type ServerEngineInstallOptions } from './engine-installer';
import {
	isServerEngineInstalled,
	isServerEngineStale,
	readServerEngineManifest,
} from './engine-store';
import {
	getModelServerStatus,
	startModelServer,
	stopModelServer,
	updateModelServerConfig,
} from './supervisor';

const LOG_CONTEXT = 'ModelServer';

/** The builds this machine can install, `default` first. */
export function modelServerBuildOptions(
	platform: string = process.platform,
	arch: string = process.arch
): ModelServerBuildOption[] {
	const options: ModelServerBuildOption[] = [];
	for (const choice of availableServerBuildChoices(platform, arch)) {
		const build = selectServerBuild(platform, arch, choice);
		if (!build) continue;
		options.push({
			choice,
			label: build.label,
			kind: build.kind,
			downloadBytes: serverBuildDownloadBytes(build),
		});
	}
	return options;
}

async function engineInfo(): Promise<ModelServerEngineInfo> {
	const [manifest, installed] = await Promise.all([
		readServerEngineManifest(),
		isServerEngineInstalled(),
	]);
	const present = installed && manifest !== null;
	return {
		installed: present,
		stale: present ? await isServerEngineStale() : false,
		release: present ? manifest.release : null,
		choice: present ? manifest.choice : null,
		label: present ? manifest.label : null,
		kind: present ? manifest.kind : null,
		accelerator: present ? (manifest.accelerator ?? null) : null,
		bytes: present ? manifest.bytes : 0,
		builds: modelServerBuildOptions(),
	};
}

/** The loaded models with their approximate memory: the weights file each one opened. */
export function modelServerLoadedModels(ids: readonly string[]): ModelServerLoadedModel[] {
	return ids.map((id) => {
		const entry = getLocalModel(id);
		const gguf = entry ? localModelGgufFile(entry) : undefined;
		return { id, displayName: entry?.displayName ?? id, approxBytes: gguf?.bytes ?? 0 };
	});
}

let installing: ModelServerEngineProgress | null = null;
let engineInstall: { choice: ServerBuildChoice; promise: Promise<ModelServerReport> } | null = null;
const progressListeners = new Set<(progress: ModelServerEngineProgress) => void>();

/**
 * Subscribe to engine install progress. Fanned out here, not passed per call, so
 * an install started from the CLI shows on the card in every window.
 */
export function onModelServerEngineProgress(
	listener: (progress: ModelServerEngineProgress) => void
): () => void {
	progressListeners.add(listener);
	return () => {
		progressListeners.delete(listener);
	};
}

function emitProgress(progress: ModelServerEngineProgress): void {
	installing = progress.phase === 'done' ? null : progress;
	for (const listener of progressListeners) listener(progress);
}

/** Everything the card shows. Reads only: never starts the server or downloads anything. */
export async function getModelServerReport(): Promise<ModelServerReport> {
	const [status, engine] = await Promise.all([getModelServerStatus(), engineInfo()]);
	return {
		status,
		engine,
		loaded: modelServerLoadedModels(status.loadedModels),
		installing,
	};
}

function requireBuildChoice(raw: unknown): ServerBuildChoice {
	if (isServerBuildChoice(raw)) return raw;
	throw new ModelServerError(
		`"${String(raw)}" is not a model server build. Use ${SERVER_BUILD_CHOICES.join(', ')}.`,
		'invalid-setting'
	);
}

/**
 * Download, verify and install the `llama-server` engine for a build choice: the
 * card's Install button and `models server set --build`. A choice this platform
 * has no build for is refused by name; nothing is substituted.
 *
 * A running server keeps serving through the download and is stopped only right
 * before the new build replaces the old, then started again on it. A second
 * request for the same choice joins the first; a different choice while one is
 * installing is refused.
 *
 * Optional `options` are for tests (a fake fetch, a foreign platform).
 */
export function installModelServerEngine(
	rawChoice: unknown,
	options: Omit<ServerEngineInstallOptions, 'onProgress' | 'beforePromote'> = {}
): Promise<ModelServerReport> {
	let choice: ServerBuildChoice;
	try {
		choice = requireBuildChoice(rawChoice);
	} catch (error) {
		// A transport hands this an unchecked value; the caller awaits a promise.
		return Promise.reject(error);
	}
	if (engineInstall) {
		if (engineInstall.choice === choice) return engineInstall.promise;
		return Promise.reject(
			new ModelServerError(
				`The ${MODEL_SERVER_NAME} engine is already installing the "${engineInstall.choice}" build. Wait for it to finish.`,
				'invalid-setting'
			)
		);
	}

	const promise = (async (): Promise<ModelServerReport> => {
		let restartAfter = false;
		try {
			await installServerEngine(choice, {
				...options,
				onProgress: (progress) => emitProgress({ choice, ...progress }),
				beforePromote: async () => {
					const { state } = await getModelServerStatus();
					if (state === 'stopped' || state === 'failed') return;
					restartAfter = state !== 'stopping';
					await stopModelServer();
				},
			});
		} finally {
			installing = null;
		}
		if (restartAfter) {
			try {
				await startModelServer();
			} catch (error) {
				// The install succeeded. The report carries the start's error in
				// `status.lastError`, which is what the card and the CLI show.
				logger.warn(
					`The ${MODEL_SERVER_NAME} did not start again on the new engine: ${error instanceof Error ? error.message : String(error)}`,
					LOG_CONTEXT
				);
			}
		}
		return getModelServerReport();
	})().finally(() => {
		engineInstall = null;
	});
	engineInstall = { choice, promise };
	return promise;
}

/**
 * Apply a settings change sent over a transport: `{ bind?, maxModels?, rotateKey? }`.
 * The bind mode and model count are validated by the config store, which names
 * a value it refuses.
 */
export function updateModelServerConfigRequest(raw: unknown): Promise<ModelServerStatus> {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return Promise.reject(
			new ModelServerError('A model server settings change must be an object.', 'invalid-setting')
		);
	}
	const patch = raw as { bind?: unknown; maxModels?: unknown; rotateKey?: unknown };
	if (patch.rotateKey !== undefined && typeof patch.rotateKey !== 'boolean') {
		return Promise.reject(
			new ModelServerError('rotateKey must be true or false.', 'invalid-setting')
		);
	}
	return updateModelServerConfig({
		bind: patch.bind as ModelServerStatus['bind'] | undefined,
		maxModels: patch.maxModels as number | undefined,
		rotateKey: patch.rotateKey === true,
	});
}

/** Forget the in-flight install, so each test starts from a process that never ran one. */
export function resetModelServerServiceForTests(): void {
	installing = null;
	engineInstall = null;
	progressListeners.clear();
}
