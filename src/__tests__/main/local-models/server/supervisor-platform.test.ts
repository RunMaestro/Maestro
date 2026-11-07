/**
 * @file supervisor-platform.test.ts
 *
 * What the model server supervisor does that depends on the platform, with the
 * platform's values stood in. None of this ran on Windows or Linux hardware
 * (see "Cross-platform coverage" in docs/architecture/local-models.md), so each
 * case pins the one decision that would differ there:
 *
 *   - The executable is started directly, never through a shell, so a path with
 *     spaces and a drive letter reaches it as one argument each.
 *   - A Windows exit status that only reads in hex (a DLL that was not found) is
 *     reported in hex.
 *   - A kept port the system refuses to bind (a reserved range on Windows) fails
 *     the start by name, and the port does not move.
 *   - On a system with no key store (Linux with no keyring) the key is obscured,
 *     and the status says so. A key the key store sealed is refused by name while
 *     the key store is away, and it is never written over.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';

const tempRoot = vi.hoisted(() => ({ dir: '' }));

/**
 * Electron's `safeStorage` as a Linux session shows it. With no keyring it
 * reports no encryption, and `encryptString` throws. `available` flips it to a
 * session that has one.
 */
const keyStore = vi.hoisted(() => ({ available: false }));
const safeStorage = vi.hoisted(() => ({
	isEncryptionAvailable: () => keyStore.available,
	encryptString: vi.fn((text: string) => {
		if (!keyStore.available) throw new Error('Encryption is not available.');
		return Buffer.from(`keyring:${text}`);
	}),
	decryptString: vi.fn((blob: Buffer) => {
		if (!keyStore.available) throw new Error('Decryption is not available.');
		return blob.toString().slice('keyring:'.length);
	}),
}));

vi.mock('electron', () => ({
	app: { getPath: () => tempRoot.dir },
	safeStorage,
}));

const logger = vi.hoisted(() => ({
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({ logger }));

vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

/** When set, the next port checks answer this instead of asking the system. */
const portProbe = vi.hoisted(() => ({
	answer: null as null | { free: false; code: string | null; message: string },
}));
vi.mock('../../../../main/utils/tcp-port', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../../main/utils/tcp-port')>();
	return {
		...actual,
		probePort: (port: number, host: string) =>
			portProbe.answer ? Promise.resolve(portProbe.answer) : actual.probePort(port, host),
	};
});

import { QWEN3_1_7B_ID } from '../../../../shared/local-models/model-catalog';
import { ModelServerError } from '../../../../main/local-models/errors';
import {
	MODEL_SERVER_KEY_PREFIX,
	MODEL_SERVER_STATE_FILE,
} from '../../../../main/local-models/server/config-store';
import type { ServerModelPreset } from '../../../../main/local-models/server/presets';
import {
	configureModelServer,
	getModelServerKey,
	getModelServerStatus,
	MODEL_SERVER_DIRNAME,
	MODEL_SERVER_KEY_FILE,
	MODEL_SERVER_PRESETS_FILE,
	resetModelServerForTests,
	startModelServer,
	updateModelServerConfig,
	type ModelServerDeps,
	type ModelServerTimings,
} from '../../../../main/local-models/server/supervisor';

const FAKE_SERVER = path.resolve(__dirname, '../../../fixtures/fake-llama-server.mjs');

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

/** A model file where Windows keeps it: a drive letter, backslashes, and a space in the profile name. */
const WINDOWS_MODEL_PATH =
	'C:\\Users\\Pat Doe\\AppData\\Roaming\\Maestro\\models\\qwen3-1.7b-instruct-q4km\\Qwen3-1.7B-Q4_K_M.gguf';

let dataDir: string;
let binary: string;
let models: ServerModelPreset[];

const spawnServer = vi.fn((_command: string, args: string[], options: SpawnOptions) =>
	// The stand-in server runs under this test's own node; the command the
	// supervisor asked for is what the assertions read.
	spawn(process.execPath, [FAKE_SERVER, ...args], options)
);

function configure(over: Partial<ModelServerDeps> = {}): void {
	configureModelServer({
		dataDir: () => dataDir,
		// No `osSeal`: the supervisor's own default over Electron's `safeStorage`.
		resolveBinary: async () => binary,
		collectModels: async () => models,
		spawn: spawnServer,
		timings: FAST,
		...over,
	});
}

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

/** A process that exits with `code` before it listens, as a binary with a missing library does. */
function deadOnArrival(code: number): ChildProcess {
	const child = Object.assign(new EventEmitter(), {
		pid: 4242,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(() => true),
	});
	setImmediate(() => {
		child.emit('exit', code, null);
		child.stdout.end();
		child.stderr.end();
		child.emit('close', code, null);
	});
	return child as unknown as ChildProcess;
}

beforeEach(async () => {
	vi.clearAllMocks();
	keyStore.available = false;
	portProbe.answer = null;
	tempRoot.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-model-server-platform-'));
	// A space in the data folder, as in "C:\Users\Pat Doe" or "~/Library/Application Support".
	dataDir = path.join(tempRoot.dir, 'Maestro Data');
	binary = path.join(dataDir, 'runtimes', 'llama-server', 'llama-server.exe');
	await fs.mkdir(path.dirname(binary), { recursive: true });
	vi.stubEnv('MAESTRO_USER_DATA', dataDir);
	models = [{ id: QWEN3_1_7B_ID, modelPath: WINDOWS_MODEL_PATH, contextSize: 40_960 }];
	configure();
});

afterEach(async () => {
	await resetModelServerForTests();
	vi.unstubAllEnvs();
	await fs.rm(tempRoot.dir, { recursive: true, force: true });
});

describe('starting the executable', () => {
	it('starts it directly with no shell, from its own directory, and hides its window', async () => {
		await startModelServer();

		expect(spawnServer).toHaveBeenCalledTimes(1);
		const [command, , options] = spawnServer.mock.calls[0];
		// The path as it is: nothing quoted it, and nothing needs to.
		expect(command).toBe(binary);
		expect(command).toContain(' ');
		expect(command.endsWith('llama-server.exe')).toBe(true);
		expect(options.shell ?? false).toBe(false);
		// Windows looks for the backend DLLs beside the executable.
		expect(options.cwd).toBe(path.dirname(binary));
		expect(options.windowsHide).toBe(true);
		expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
	});

	it('hands each path with a space to the process as one argument', async () => {
		const argvOut = path.join(tempRoot.dir, 'argv.json');
		const keysOut = path.join(tempRoot.dir, 'keys.json');
		vi.stubEnv('FAKE_LLAMA_SERVER_ARGV_OUT', argvOut);
		vi.stubEnv('FAKE_LLAMA_SERVER_KEYS_OUT', keysOut);

		const status = await startModelServer();

		const presetsPath = path.join(dataDir, MODEL_SERVER_DIRNAME, MODEL_SERVER_PRESETS_FILE);
		const keyFile = path.join(dataDir, MODEL_SERVER_DIRNAME, MODEL_SERVER_KEY_FILE);
		expect(presetsPath).toContain(' ');
		const args = spawnServer.mock.calls[0][1];
		expect(args[args.indexOf('--models-preset') + 1]).toBe(presetsPath);
		expect(args[args.indexOf('--api-key-file') + 1]).toBe(keyFile);
		// What the process received is what was passed: no argument was split.
		expect(await readJson<string[]>(argvOut)).toEqual(args);
		// It opened the key file at that path, so the path arrived whole.
		expect(await readJson<string[]>(keysOut)).toEqual([await getModelServerKey()]);
		expect(status.models).toEqual([QWEN3_1_7B_ID]);
	});

	it('writes a Windows model path into the presets file as it is', async () => {
		await startModelServer();

		const presets = await fs.readFile(
			path.join(dataDir, MODEL_SERVER_DIRNAME, MODEL_SERVER_PRESETS_FILE),
			'utf-8'
		);
		// The presets dialect has no quoting and no escapes: backslashes, the
		// drive letter and the space are the value.
		expect(presets).toContain(`[${QWEN3_1_7B_ID}]\nmodel = ${WINDOWS_MODEL_PATH}\nc = 40960\n`);
		expect(presets).not.toContain('\r');
	});

	it('names in hex the exit status Windows gives a program whose DLL was not found', async () => {
		// STATUS_DLL_NOT_FOUND. Nothing is printed: the process never ran.
		spawnServer.mockImplementationOnce(() => deadOnArrival(0xc0000135));

		const error = await caught(startModelServer());

		expect(error.code).toBe('start-failed');
		expect(error.message).toContain('stopped before it was ready (exit code 0xC0000135)');
		expect(await getModelServerStatus()).toMatchObject({ state: 'failed', pid: null });
		// The key file never outlives the start, whichever way it ends.
		expect(await exists(path.join(dataDir, MODEL_SERVER_DIRNAME, MODEL_SERVER_KEY_FILE))).toBe(
			false
		);
	});
});

describe('the kept port', () => {
	it('fails by name, and does not move, when the system refuses the port', async () => {
		// Windows reserves port ranges (for Hyper-V and WSL) that change at restart,
		// so a port that was free when it was chosen can be refused later. The bind
		// then fails with EACCES, not EADDRINUSE: nothing is listening on it.
		await fs.mkdir(dataDir, { recursive: true });
		await fs.writeFile(
			path.join(dataDir, MODEL_SERVER_STATE_FILE),
			JSON.stringify({ port: 50123 })
		);
		portProbe.answer = {
			free: false,
			code: 'EACCES',
			message: 'listen EACCES: permission denied 127.0.0.1:50123',
		};

		const error = await caught(startModelServer());

		expect(error.code).toBe('start-failed');
		expect(error.message).toContain('cannot listen on 127.0.0.1:50123');
		expect(error.message).toContain('EACCES');
		expect(spawnServer).not.toHaveBeenCalled();
		const status = await getModelServerStatus();
		expect(status).toMatchObject({ state: 'failed', port: 50123, pid: null });
		expect(
			(await readJson<{ port: number }>(path.join(dataDir, MODEL_SERVER_STATE_FILE))).port
		).toBe(50123);
	});
});

describe('the key on a system with no key store (Linux with no keyring)', () => {
	const stateFile = (): string => path.join(dataDir, MODEL_SERVER_STATE_FILE);

	it('starts with an obscured key, says so, and never asks the missing key store', async () => {
		const status = await startModelServer();

		expect(status).toMatchObject({ state: 'running', keyStorage: 'obscured' });
		expect(safeStorage.encryptString).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('obscured, not encrypted'),
			expect.any(String)
		);

		const key = await getModelServerKey();
		expect(key.startsWith(MODEL_SERVER_KEY_PREFIX)).toBe(true);
		const raw = await fs.readFile(stateFile(), 'utf-8');
		expect(raw).not.toContain(key);
		expect(JSON.parse(raw).key.storage).toBe('obscured');
	});

	it('reads the same obscured key at the next launch, and after a keyring appears', async () => {
		const key = await getModelServerKey();
		const before = await fs.readFile(stateFile(), 'utf-8');

		// A new launch of the app: nothing in memory, the file as it was.
		await resetModelServerForTests();
		configure();
		expect(await getModelServerKey()).toBe(key);

		// The user installs a keyring. The key was not sealed by it, so it is read
		// the way it was written, and it is not sealed again behind the user's back.
		keyStore.available = true;
		expect(await getModelServerKey()).toBe(key);
		expect(safeStorage.decryptString).not.toHaveBeenCalled();
		expect(await fs.readFile(stateFile(), 'utf-8')).toBe(before);
		expect((await getModelServerStatus()).keyStorage).toBe('obscured');
	});

	it('refuses by name a key the key store sealed while the key store is away, and keeps it', async () => {
		keyStore.available = true;
		const key = await getModelServerKey();
		expect((await getModelServerStatus()).keyStorage).toBe('os');
		const sealed = (await readJson<{ key: unknown }>(stateFile())).key;

		// The same machine with no keyring in the session (signed in over SSH, or
		// the keyring daemon is not running).
		keyStore.available = false;
		const error = await caught(startModelServer());

		expect(error.code).toBe('key-unavailable');
		expect(error.message).toContain("sealed with this system's key store");
		expect(error.message).toContain('Rotate the key');
		expect(spawnServer).not.toHaveBeenCalled();
		// Not written over: the next session with the keyring opens it again.
		expect((await readJson<{ key: unknown }>(stateFile())).key).toEqual(sealed);

		keyStore.available = true;
		expect(await getModelServerKey()).toBe(key);
	});

	it('makes an obscured key when the user rotates while the key store is away', async () => {
		keyStore.available = true;
		const old = await getModelServerKey();

		keyStore.available = false;
		const status = await updateModelServerConfig({ rotateKey: true });

		expect(status.keyStorage).toBe('obscured');
		const rotated = await getModelServerKey();
		expect(rotated).not.toBe(old);
		expect((await startModelServer()).state).toBe('running');
	});
});
