/**
 * @file supervisor.test.ts
 *
 * The model server's lifecycle against a real process: `fake-llama-server.mjs`
 * stands in for llama-server, started with the arguments, environment and key
 * file the real binary gets, on a real port. Nothing else is faked but the OS
 * seal and the model list.
 *
 * What is pinned: it starts only when asked, on a port it keeps; it refuses to
 * start without its key (the network refusal included), without an engine, a
 * model, or a free port, naming each; a crash is restarted with backoff and a
 * fourth one leaves it stopped with a toast; a server that stops answering
 * /health counts as crashed; a model is loaded on request; settings restart it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type SpawnOptions } from 'child_process';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const tempRoot = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
	app: { getPath: () => tempRoot.dir },
	safeStorage: { isEncryptionAvailable: () => false },
}));

const logger = vi.hoisted(() => ({
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({ logger }));

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../../../../main/utils/sentry', () => sentry);

import { PARAKEET_TDT_V2_ID, QWEN3_1_7B_ID } from '../../../../shared/local-models/model-catalog';
import type { ModelServerStatus } from '../../../../shared/local-models/model-server';
import { ModelServerError } from '../../../../main/local-models/errors';
import { MODEL_SERVER_STATE_FILE } from '../../../../main/local-models/server/config-store';
import type { ServerModelPreset } from '../../../../main/local-models/server/presets';
import {
	configureModelServer,
	ensureModelServerFor,
	getModelServerKey,
	getModelServerStatus,
	MAX_CRASH_RESTARTS,
	MODEL_SERVER_CACHE_DIRNAME,
	MODEL_SERVER_DIRNAME,
	MODEL_SERVER_KEY_FILE,
	MODEL_SERVER_PRESETS_FILE,
	modelServerServingLoaded,
	onModelServerStateChange,
	resetModelServerForTests,
	startModelServer,
	stopModelServer,
	stopModelServerNow,
	updateModelServerConfig,
	type ModelServerDeps,
	type ModelServerTimings,
} from '../../../../main/local-models/server/supervisor';
import type { SealProvider } from '../../../../main/utils/safe-storage-seal';
import { probePort } from '../../../../main/utils/tcp-port';

const FAKE_SERVER = path.resolve(__dirname, '../../../fixtures/fake-llama-server.mjs');

/** Seconds, not minutes: every wait in here is on a local process. */
const FAST: Partial<ModelServerTimings> = {
	startTimeoutMs: 8_000,
	startPollMs: 25,
	healthIntervalMs: 100,
	requestTimeoutMs: 1_000,
	restartBackoffMs: 20,
	stableRunMs: 60_000,
	stopGraceMs: 1_000,
	modelLoadTimeoutMs: 5_000,
	modelLoadPollMs: 25,
};

/** The crash and hang tests run several processes one after another. */
const SLOW_TEST_MS = 30_000;

const seal: SealProvider = {
	available: () => true,
	seal: (text) => Buffer.from(`sealed:${text}`),
	unseal: (blob) => blob.toString().slice('sealed:'.length),
};

let models: ServerModelPreset[];
const safeSend = vi.fn();
const spawnServer = vi.fn((_command: string, args: string[], options: SpawnOptions) =>
	// Under this test's own node, so it starts the same way on every platform.
	spawn(process.execPath, [FAKE_SERVER, ...args], options)
);

function configure(over: Partial<ModelServerDeps> = {}): void {
	configureModelServer({
		dataDir: () => tempRoot.dir,
		osSeal: () => seal,
		resolveBinary: async () => FAKE_SERVER,
		collectModels: async () => models,
		spawn: spawnServer,
		safeSend,
		timings: FAST,
		...over,
	});
}

const inTemp = (name: string): string => path.join(tempRoot.dir, name);
const serverDir = (): string => inTemp(MODEL_SERVER_DIRNAME);

async function readJson<T>(file: string): Promise<T> {
	return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => Promise<boolean>, what: string, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await pause(25);
	}
}

/** Poll the status until `check` holds. */
async function waitForStatus(
	check: (status: ModelServerStatus) => boolean,
	timeoutMs = 15_000
): Promise<ModelServerStatus> {
	let last: ModelServerStatus | null = null;
	await waitUntil(
		async () => {
			last = await getModelServerStatus();
			return check(last);
		},
		'the server status',
		timeoutMs
	);
	return last as unknown as ModelServerStatus;
}

/** Hold a loopback port the way an unrelated program would. */
async function occupyAnyPort(): Promise<{ port: number; release: () => Promise<void> }> {
	const squatter = net.createServer();
	await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
	return {
		port: (squatter.address() as net.AddressInfo).port,
		release: () => new Promise<void>((resolve) => squatter.close(() => resolve())),
	};
}

async function caught(promise: Promise<unknown>): Promise<ModelServerError> {
	const error = await promise.then(
		() => {
			throw new Error('expected a refusal');
		},
		(rejection: unknown) => rejection
	);
	expect(error).toBeInstanceOf(ModelServerError);
	return error as ModelServerError;
}

beforeEach(async () => {
	vi.clearAllMocks();
	tempRoot.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-model-server-'));
	// Leaked from an agent shell, this would point the data folder at the user's real one.
	vi.stubEnv('MAESTRO_USER_DATA', tempRoot.dir);
	models = [{ id: QWEN3_1_7B_ID, modelPath: inTemp('qwen.gguf'), contextSize: 40_960 }];
	configure();
});

afterEach(async () => {
	await resetModelServerForTests();
	vi.unstubAllEnvs();
	await fs.rm(tempRoot.dir, { recursive: true, force: true });
});

describe('starting and stopping', () => {
	it('starts nothing until asked, and a status read writes nothing', async () => {
		const status = await getModelServerStatus();

		expect(status).toMatchObject({
			state: 'stopped',
			port: null,
			bind: 'local',
			host: '127.0.0.1',
			baseUrl: null,
			maxModels: 1,
			pid: null,
			models: [],
			loadedModels: [],
			keyStorage: null,
		});
		expect(status.logPath).toBe(path.join(tempRoot.dir, 'logs', 'model-server.log'));
		expect(spawnServer).not.toHaveBeenCalled();
		expect(await exists(inTemp(MODEL_SERVER_STATE_FILE))).toBe(false);
	});

	it('starts on a port it keeps, with its key, its presets, and its own environment', async () => {
		vi.stubEnv('FAKE_LLAMA_SERVER_ARGV_OUT', inTemp('argv.json'));
		vi.stubEnv('FAKE_LLAMA_SERVER_ENV_OUT', inTemp('env.json'));
		vi.stubEnv('FAKE_LLAMA_SERVER_KEYS_OUT', inTemp('keys.json'));
		// Left in a user's shell, these would configure Maestro's server.
		vi.stubEnv('LLAMA_ARG_MODEL', '/elsewhere/model.gguf');
		vi.stubEnv('LLAMA_API_KEY', 'someone-elses-key');

		const status = await startModelServer();

		expect(status).toMatchObject({
			state: 'running',
			bind: 'local',
			host: '127.0.0.1',
			maxModels: 1,
			restarts: 0,
			lastError: null,
			models: [QWEN3_1_7B_ID],
			loadedModels: [],
			keyStorage: 'os',
		});
		const port = status.port as number;
		expect(status.baseUrl).toBe(`http://127.0.0.1:${port}`);
		expect(typeof status.pid).toBe('number');
		expect((await readJson<{ port: number }>(inTemp(MODEL_SERVER_STATE_FILE))).port).toBe(port);

		expect(await readJson<string[]>(inTemp('argv.json'))).toEqual([
			'--host',
			'127.0.0.1',
			'--port',
			String(port),
			'--models-preset',
			path.join(serverDir(), MODEL_SERVER_PRESETS_FILE),
			'--models-max',
			'1',
			'--api-key-file',
			path.join(serverDir(), MODEL_SERVER_KEY_FILE),
			'--no-webui',
			'--offline',
		]);

		const env = await readJson<Record<string, string>>(inTemp('env.json'));
		expect(Object.keys(env).filter((name) => name.toUpperCase().startsWith('LLAMA_'))).toEqual([
			'LLAMA_CACHE',
		]);
		expect(env.LLAMA_CACHE).toBe(path.join(serverDir(), MODEL_SERVER_CACHE_DIRNAME));

		const presets = await fs.readFile(path.join(serverDir(), MODEL_SERVER_PRESETS_FILE), 'utf-8');
		expect(presets).toContain(
			`[${QWEN3_1_7B_ID}]\nmodel = ${models[0].modelPath}\nc = 40960\njinja = true\n`
		);

		// It read the key at launch, and the file is gone now that it answers.
		const key = await getModelServerKey();
		expect(await readJson<string[]>(inTemp('keys.json'))).toEqual([key]);
		expect(await exists(path.join(serverDir(), MODEL_SERVER_KEY_FILE))).toBe(false);
		expect((await fetch(`${status.baseUrl}/health`)).status).toBe(200);
		expect((await fetch(`${status.baseUrl}/models`)).status).toBe(401);
		const authorized = await fetch(`${status.baseUrl}/models`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(authorized.status).toBe(200);

		// Its output lands in its own log, and the key never does.
		await waitUntil(
			async () =>
				(await exists(status.logPath)) &&
				(await fs.readFile(status.logPath, 'utf-8')).includes('server is listening'),
			'the server output in its log'
		);
		const log = await fs.readFile(status.logPath, 'utf-8');
		expect(log).toContain('Starting');
		expect(log).not.toContain(key);
	});

	it('stops, frees its port, and starts again on the same one', async () => {
		const first = await startModelServer();
		const port = first.port as number;

		const stopped = await stopModelServer();
		expect(stopped).toMatchObject({ state: 'stopped', pid: null, port, models: [] });
		expect(await probePort(port, '127.0.0.1')).toEqual({ free: true });

		const again = await startModelServer();
		expect(again).toMatchObject({ state: 'running', port });
		expect(again.pid).not.toBe(first.pid);
		expect(spawnServer).toHaveBeenCalledTimes(2);
	});

	it('tells state listeners about each change, once per change', async () => {
		const seen: string[] = [];
		const off = onModelServerStateChange((state) => seen.push(state));
		try {
			await startModelServer();
			await stopModelServer();
		} finally {
			off();
		}
		expect(seen).toEqual(['starting', 'running', 'stopping', 'stopped']);

		// Unsubscribed: a later start is not reported.
		await startModelServer();
		expect(seen).toHaveLength(4);
	});

	it('keeps its port across launches of the app', async () => {
		const port = (await startModelServer()).port;
		// Stops it and forgets everything in memory; the files stay, as on disk.
		await resetModelServerForTests();
		configure();

		expect((await getModelServerStatus()).port).toBe(port);
		expect((await startModelServer()).port).toBe(port);
	});

	it('fails by name when another program holds its port, and does not move', async () => {
		const held = await occupyAnyPort();
		await fs.writeFile(inTemp(MODEL_SERVER_STATE_FILE), JSON.stringify({ port: held.port }));
		try {
			const error = await caught(startModelServer());
			expect(error.code).toBe('port-in-use');
			expect(error.message).toContain(`127.0.0.1:${held.port}`);

			const status = await getModelServerStatus();
			expect(status).toMatchObject({ state: 'failed', port: held.port, pid: null });
			expect(status.lastError).toContain('Another program');
			expect(spawnServer).not.toHaveBeenCalled();
			expect((await readJson<{ port: number }>(inTemp(MODEL_SERVER_STATE_FILE))).port).toBe(
				held.port
			);
		} finally {
			await held.release();
		}
	});

	it('refuses a network start without its key, and starts nothing', async () => {
		await updateModelServerConfig({ bind: 'network' });
		await getModelServerKey();
		// The OS key store no longer opens the key that was sealed with it.
		configure({
			osSeal: () => ({
				...seal,
				unseal: () => {
					throw new Error('The key store was reset.');
				},
			}),
		});

		const error = await caught(startModelServer());
		expect(error.code).toBe('key-unavailable');
		expect(spawnServer).not.toHaveBeenCalled();
		const status = await getModelServerStatus();
		expect(status).toMatchObject({ state: 'failed', bind: 'network', host: '0.0.0.0', pid: null });
		expect(status.lastError).toContain('Rotate the key');
	});

	it('refuses to start without an engine or a text model, before choosing a port', async () => {
		configure({ resolveBinary: async () => null });
		const noEngine = await caught(startModelServer());
		expect(noEngine.code).toBe('engine-not-installed');
		// The engine is installed from the model server card, in Sources.
		expect(noEngine.message).toContain('Settings > Models > Sources');

		configure({ collectModels: async () => [] });
		expect((await caught(startModelServer())).code).toBe('no-models');

		expect(spawnServer).not.toHaveBeenCalled();
		expect(await exists(inTemp(MODEL_SERVER_STATE_FILE))).toBe(false);
	});

	it('reports a server that exits before it is ready, with the line it printed', async () => {
		vi.stubEnv('FAKE_LLAMA_SERVER_FAIL_START', 'error: failed to load the presets file');

		const error = await caught(startModelServer());
		expect(error.code).toBe('start-failed');
		expect(error.message).toContain('stopped before it was ready (exit code 1)');
		expect(error.message).toContain('failed to load the presets file');
		expect(await getModelServerStatus()).toMatchObject({ state: 'failed', pid: null });
		expect(await exists(path.join(serverDir(), MODEL_SERVER_KEY_FILE))).toBe(false);
	});

	it('stops at once for app quit', async () => {
		const { port } = await startModelServer();

		stopModelServerNow();

		await waitUntil(
			async () => (await probePort(port as number, '127.0.0.1')).free,
			'the port to be released'
		);
		await waitForStatus((status) => status.state === 'stopped' && status.pid === null);
	});
});

describe('crashes', () => {
	beforeEach(() => {
		vi.stubEnv('FAKE_LLAMA_SERVER_STARTS_FILE', inTemp('starts.txt'));
		// Late enough that a start always sees it up first.
		vi.stubEnv('FAKE_LLAMA_SERVER_CRASH_AFTER_MS', '300');
	});

	it(
		'restarts a server that stops on its own, on the same port',
		async () => {
			vi.stubEnv('FAKE_LLAMA_SERVER_CRASHES', '1');
			const first = await startModelServer();

			const status = await waitForStatus((s) => s.state === 'running' && s.restarts === 1);
			expect(status.pid).not.toBe(first.pid);
			expect(status.port).toBe(first.port);
			expect(status.lastError).toContain('stopped unexpectedly (exit code 3)');
			expect(spawnServer).toHaveBeenCalledTimes(2);
		},
		SLOW_TEST_MS
	);

	it(
		`gives up after ${MAX_CRASH_RESTARTS} restarts, and says so`,
		async () => {
			vi.stubEnv('FAKE_LLAMA_SERVER_CRASHES', '100');
			await startModelServer();

			const status = await waitForStatus((s) => s.state === 'failed', 20_000);
			expect(spawnServer).toHaveBeenCalledTimes(1 + MAX_CRASH_RESTARTS);
			expect(status.lastError).toContain(`restarted ${MAX_CRASH_RESTARTS} times`);
			expect(safeSend).toHaveBeenCalledWith(
				'remote:notifyToast',
				expect.objectContaining({ title: 'Maestro model server stopped', color: 'red' })
			);
			expect(sentry.captureMessage).toHaveBeenCalledTimes(1);

			// Left stopped: nothing comes back on its own.
			await pause(300);
			expect(spawnServer).toHaveBeenCalledTimes(1 + MAX_CRASH_RESTARTS);
			expect((await getModelServerStatus()).state).toBe('failed');
		},
		SLOW_TEST_MS
	);

	it(
		'treats a server that stops answering /health as crashed',
		async () => {
			vi.stubEnv('FAKE_LLAMA_SERVER_HANGS', '1');
			configure({ timings: { ...FAST, requestTimeoutMs: 200 } });
			const first = await startModelServer();

			const status = await waitForStatus((s) => s.state === 'running' && s.restarts === 1);
			expect(status.pid).not.toBe(first.pid);
			expect(status.lastError).toContain('stopped answering its health check');
		},
		SLOW_TEST_MS
	);

	it(
		'cancels a pending restart when stopped',
		async () => {
			vi.stubEnv('FAKE_LLAMA_SERVER_CRASHES', '1');
			configure({ timings: { ...FAST, restartBackoffMs: 500 } });
			await startModelServer();
			await waitForStatus((s) => s.state === 'restarting');

			expect((await stopModelServer()).state).toBe('stopped');
			await pause(800);
			expect(spawnServer).toHaveBeenCalledTimes(1);
			expect((await getModelServerStatus()).state).toBe('stopped');
		},
		SLOW_TEST_MS
	);
});

describe('ensureModelServerFor', () => {
	it('starts the server and loads the model', async () => {
		const result = await ensureModelServerFor(QWEN3_1_7B_ID);
		const status = await getModelServerStatus();

		expect(result).toEqual({ ok: true, baseUrl: status.baseUrl, model: QWEN3_1_7B_ID });
		expect(status).toMatchObject({ state: 'running', loadedModels: [QWEN3_1_7B_ID] });

		// Already loaded: nothing more to do, and still one server.
		expect(await ensureModelServerFor(QWEN3_1_7B_ID)).toEqual(result);
		expect(spawnServer).toHaveBeenCalledTimes(1);
	});

	it('refuses by name, and starts nothing, for a model it cannot serve', async () => {
		expect(await ensureModelServerFor('no-such-model')).toMatchObject({
			ok: false,
			code: 'model-unsupported',
		});
		expect(await ensureModelServerFor(PARAKEET_TDT_V2_ID)).toMatchObject({
			ok: false,
			code: 'model-unsupported',
		});
		models = [];
		expect(await ensureModelServerFor(QWEN3_1_7B_ID)).toMatchObject({
			ok: false,
			code: 'model-not-installed',
			error: expect.stringContaining('Settings > Models > Library'),
		});
		expect(spawnServer).not.toHaveBeenCalled();
	});

	it('names a model that fails to load, and leaves the server up', async () => {
		vi.stubEnv('FAKE_LLAMA_SERVER_LOAD_FAIL', '1');

		const result = await ensureModelServerFor(QWEN3_1_7B_ID);
		expect(result).toMatchObject({ ok: false, code: 'load-failed' });
		expect(result.ok ? '' : result.error).toContain('exit code 1');
		expect((await getModelServerStatus()).state).toBe('running');
	});

	it('serves a model downloaded after the server started, without restarting it', async () => {
		models = [{ id: 'another-model', modelPath: inTemp('another.gguf'), contextSize: 40_960 }];
		const { pid } = await startModelServer();
		expect((await getModelServerStatus()).models).toEqual(['another-model']);

		models = [
			...models,
			{ id: QWEN3_1_7B_ID, modelPath: inTemp('qwen.gguf'), contextSize: 40_960 },
		];
		expect(await ensureModelServerFor(QWEN3_1_7B_ID)).toMatchObject({ ok: true });

		const status = await getModelServerStatus();
		expect(status.models).toEqual(['another-model', QWEN3_1_7B_ID]);
		expect(status.pid).toBe(pid);
		expect(spawnServer).toHaveBeenCalledTimes(1);
	});
});

describe('modelServerServingLoaded', () => {
	it('answers only for a model the running server has loaded, and never starts or loads', async () => {
		expect(await modelServerServingLoaded(QWEN3_1_7B_ID)).toBeNull();
		expect(spawnServer).not.toHaveBeenCalled();

		await startModelServer();
		// Served, but not loaded yet: still null, and asking does not load it.
		expect(await modelServerServingLoaded(QWEN3_1_7B_ID)).toBeNull();
		expect((await getModelServerStatus()).loadedModels).toEqual([]);

		await ensureModelServerFor(QWEN3_1_7B_ID);
		const status = await getModelServerStatus();
		expect(await modelServerServingLoaded(QWEN3_1_7B_ID)).toEqual({
			baseUrl: status.baseUrl,
			key: await getModelServerKey(),
		});
		expect(await modelServerServingLoaded('another-model')).toBeNull();

		await stopModelServer();
		expect(await modelServerServingLoaded(QWEN3_1_7B_ID)).toBeNull();
	});
});

describe('updateModelServerConfig', () => {
	it('restarts a running server to apply a new model count or key', async () => {
		vi.stubEnv('FAKE_LLAMA_SERVER_ARGV_OUT', inTemp('argv.json'));
		vi.stubEnv('FAKE_LLAMA_SERVER_KEYS_OUT', inTemp('keys.json'));
		const first = await startModelServer();
		const oldKey = await getModelServerKey();

		expect(await updateModelServerConfig({ maxModels: 2 })).toMatchObject({
			state: 'running',
			maxModels: 2,
			port: first.port,
		});
		const argv = await readJson<string[]>(inTemp('argv.json'));
		expect(argv[argv.indexOf('--models-max') + 1]).toBe('2');

		await updateModelServerConfig({ rotateKey: true });
		const newKey = await getModelServerKey();
		expect(newKey).not.toBe(oldKey);
		expect(await readJson<string[]>(inTemp('keys.json'))).toEqual([newKey]);
		expect(spawnServer).toHaveBeenCalledTimes(3);
	});

	it('only records a change while the server is stopped', async () => {
		expect(await updateModelServerConfig({ bind: 'network', maxModels: 4 })).toMatchObject({
			state: 'stopped',
			bind: 'network',
			host: '0.0.0.0',
			maxModels: 4,
		});
		expect(spawnServer).not.toHaveBeenCalled();
	});

	it('rejects a setting it does not accept', async () => {
		expect((await caught(updateModelServerConfig({ maxModels: 0 }))).code).toBe('invalid-setting');
	});
});
