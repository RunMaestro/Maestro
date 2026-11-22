/**
 * The Maestro model server's lifecycle: llama.cpp's `llama-server`, run in
 * router mode and watched by Maestro.
 *
 * 1. **It never starts itself.** `startModelServer()` is the user pressing
 *    Start. `ensureModelServerFor()` is something the user turned on that needs
 *    it: an agent that runs on a server model, a task assigned to one. Nothing
 *    calls either at app start, and app quit stops it (`stopModelServerNow()`).
 * 2. **The port is chosen once and kept** (`config-store.ts`). A port another
 *    program holds fails the start by name; the server does not move.
 * 3. **Every start uses the key.** Local only listens on `127.0.0.1` and Network
 *    on `0.0.0.0`, and both pass `--api-key-file`. llama-server reads that file
 *    once, at launch, so it exists only while the server starts and is deleted
 *    as soon as the server answers.
 * 4. **One process serves every installed text model** (router mode, see
 *    `presets.ts`). A model loads when a request names it, at most `maxModels` at
 *    a time; loading one more unloads the least recently used.
 * 5. **It is watched.** It is ready when `GET /health` answers and its own
 *    `GET /models` accepts the key, so another server that took the port is never
 *    mistaken for it. While it runs, `/health` is polled, and a server that stops
 *    answering is treated as crashed. A crash is restarted with backoff, at most
 *    `MAX_CRASH_RESTARTS` times in a row; then it stays stopped and the user is
 *    told.
 * 6. **Only Maestro configures it** (`modelServerEnvironment`): no `LLAMA_*`
 *    variable reaches it, its model cache is an empty folder of its own, and
 *    `--offline` keeps it from downloading anything.
 *
 * Its stdout and stderr go to `userData/logs/model-server.log`, size-capped.
 *
 * In router mode each loaded model runs in a child process that the router
 * starts on a loopback port of its own, without the key (upstream llama.cpp
 * strips it from the child's arguments). Those ports are never on the network,
 * in either bind mode.
 */

import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from 'child_process';
import { safeStorage } from 'electron';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

import { getLocalModel } from '../../../shared/local-models/model-catalog';
import {
	MODEL_SERVER_BIND_HOSTS,
	MODEL_SERVER_NAME,
	modelServerBaseUrl,
	type ModelServerBind,
	type ModelServerEnsureResult,
	type ModelServerState,
	type ModelServerStatus,
} from '../../../shared/local-models/model-server';
import { modelsSettingsLocation } from '../../../shared/local-models/settings-location';
import {
	BACKGROUND_STOP_GRACE_MS,
	stopProcess,
} from '../../../shared/maestro-lib/control/termination';
import { stripAnsiCodes } from '../../../shared/stringUtils';
import { atomicWriteFile, createKeyedWriteQueue } from '../../utils/atomic-json-store';
import { openCappedLogFile, type CappedLogFile } from '../../utils/capped-log-file';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout';
import { logger } from '../../utils/logger';
import type { SafeSendFn } from '../../utils/safe-send';
import { safeStorageSeal, type SealProvider } from '../../utils/safe-storage-seal';
import { captureMessage } from '../../utils/sentry';
import { probePort } from '../../utils/tcp-port';
import { isModelServerError, ModelServerError } from '../errors';
import { localModelsDataDir } from '../paths';
import {
	ensureModelServerKey,
	ensureModelServerPort,
	readModelServerConfig,
	rotateModelServerKey,
	writeModelServerSettings,
	type ModelServerSettingsPatch,
} from './config-store';
import { installedServerBinary } from './engine-store';
import {
	buildModelServerArgs,
	collectServerModels,
	isServerModel,
	modelServerEnvironment,
	renderModelServerPresets,
	type ServerModelPreset,
} from './presets';

const LOG_CONTEXT = 'ModelServer';

/** The server's working folder in Maestro's data folder. */
export const MODEL_SERVER_DIRNAME = 'model-server';
export const MODEL_SERVER_PRESETS_FILE = 'presets.ini';
/** Exists only while the server starts. */
export const MODEL_SERVER_KEY_FILE = 'api-key';
/** The empty cache the router lists models from (see `modelServerEnvironment`). */
export const MODEL_SERVER_CACHE_DIRNAME = 'cache';
/** In `userData/logs/`. */
export const MODEL_SERVER_LOG_FILE = 'model-server.log';

/** Restarts after crashes in a row before the server is left stopped. */
export const MAX_CRASH_RESTARTS = 3;

/** Failed `/health` checks in a row that count as a crash. */
export const HEALTH_FAILURE_LIMIT = 3;

export interface ModelServerTimings {
	/** How long a start may take to answer `/health`. */
	startTimeoutMs: number;
	/** Between `/health` checks while it starts. */
	startPollMs: number;
	/** Between `/health` checks while it runs. */
	healthIntervalMs: number;
	/** The budget of one request to the server that is not a model load. */
	requestTimeoutMs: number;
	/** The first restart's delay. It doubles with each crash in a row. */
	restartBackoffMs: number;
	/** A run this long counts as recovered: the crash count starts again. */
	stableRunMs: number;
	/** Between SIGTERM and SIGKILL when it is stopped. */
	stopGraceMs: number;
	/** How long one model may take to load. */
	modelLoadTimeoutMs: number;
	/** Between status checks while a model loads. */
	modelLoadPollMs: number;
}

export const DEFAULT_MODEL_SERVER_TIMINGS: Readonly<ModelServerTimings> = Object.freeze({
	// Generous: a first start on Windows can wait on a virus scan of the new binary.
	startTimeoutMs: 60_000,
	startPollMs: 250,
	healthIntervalMs: 15_000,
	requestTimeoutMs: 5_000,
	restartBackoffMs: 1_000,
	stableRunMs: 60_000,
	stopGraceMs: BACKGROUND_STOP_GRACE_MS,
	// Tens of gigabytes from a slow disk.
	modelLoadTimeoutMs: 10 * 60_000,
	modelLoadPollMs: 500,
});

export interface ModelServerDeps {
	/** Maestro's data folder. Defaults to `localModelsDataDir()`. */
	dataDir?: () => string;
	/** The OS seal for the key. Defaults to Electron's `safeStorage`. */
	osSeal?: () => SealProvider;
	/** The installed `llama-server`. Defaults to the engine store's. */
	resolveBinary?: () => Promise<string | null>;
	/** The models to serve. Defaults to the installed catalog text models. */
	collectModels?: () => Promise<ServerModelPreset[]>;
	/** Starts the process. A seam for tests, which run a stand-in server. */
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	/** Raises the toast when the server is left stopped after crashing. */
	safeSend?: SafeSendFn;
	timings?: Partial<ModelServerTimings>;
}

/** One launched process, from spawn to exit. */
interface ServerRun {
	child: ChildProcess;
	port: number;
	bind: ModelServerBind;
	maxModels: number;
	/** Held for Maestro's own requests to the server. Never logged. */
	key: string;
	/** Catalog ids the router lists. */
	models: string[];
	/** Epoch ms it answered `/health`; null while it starts. */
	readyAt: number | null;
	log: CappedLogFile;
	/** The last few KB of its output, for an error message. */
	tail: string;
	/** Set when Maestro stops it, so its exit is not a crash. */
	stopping: boolean;
	/** Set when it was stopped for not answering `/health`. */
	hung: boolean;
	exit: { code: number | null; signal: NodeJS.Signals | null; error?: Error } | null;
	exited: Promise<void>;
	markExited: () => void;
	/** Resolves when its output has ended, so the last lines are in `tail`. */
	closed: Promise<void>;
	markClosed: () => void;
	healthTimer: ReturnType<typeof setInterval> | null;
	healthChecking: boolean;
	healthFailures: number;
}

interface RouterModel {
	id: string;
	status: string;
	failed: boolean;
	exitCode: number | null;
}

const TAIL_CHARS = 8 * 1024;

let deps: ModelServerDeps = {};
let run: ServerRun | null = null;
let state: ModelServerState = 'stopped';
let lastError: string | null = null;
let restarts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

const stateListeners = new Set<(next: ModelServerState) => void>();

/**
 * Subscribe to the server's state changes (`starting`, `running`, `failed`,
 * ...). The payload is only the new state: a listener that needs the rest reads
 * `getModelServerStatus()`. Returns the unsubscribe.
 */
export function onModelServerStateChange(listener: (next: ModelServerState) => void): () => void {
	stateListeners.add(listener);
	return () => {
		stateListeners.delete(listener);
	};
}

function setState(next: ModelServerState): void {
	if (state === next) return;
	state = next;
	for (const listener of stateListeners) {
		try {
			listener(next);
		} catch (error) {
			logger.warn(
				`A ${MODEL_SERVER_NAME} state listener threw: ${errorMessage(error)}`,
				LOG_CONTEXT
			);
		}
	}
}

// Every start, stop, restart and settings change runs on one chain: a stop
// pressed while a start is still waiting for the server waits for that start.
const lifecycle = createKeyedWriteQueue();
const LIFECYCLE_KEY = 'model-server';

/** Point the server at the app's services. Starts nothing. */
export function configureModelServer(next: ModelServerDeps): void {
	deps = next;
	// A key file outlives its start only when Maestro itself was killed during one.
	void fs.rm(keyFilePath(), { force: true }).catch(() => {});
}

function timing<K extends keyof ModelServerTimings>(key: K): ModelServerTimings[K] {
	return deps.timings?.[key] ?? DEFAULT_MODEL_SERVER_TIMINGS[key];
}

function dataDir(): string {
	return (deps.dataDir ?? localModelsDataDir)();
}

function serverDir(): string {
	return path.join(dataDir(), MODEL_SERVER_DIRNAME);
}

function keyFilePath(): string {
	return path.join(serverDir(), MODEL_SERVER_KEY_FILE);
}

function presetsPath(): string {
	return path.join(serverDir(), MODEL_SERVER_PRESETS_FILE);
}

/** The server's log file. Its output is appended there across restarts. */
export function modelServerLogPath(): string {
	return path.join(dataDir(), 'logs', MODEL_SERVER_LOG_FILE);
}

function osSeal(): SealProvider {
	return (deps.osSeal ?? (() => safeStorageSeal(safeStorage)))();
}

function collectModels(): Promise<ServerModelPreset[]> {
	return (deps.collectModels ?? collectServerModels)();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for `promise`, at most `ms`. True when it settled in time. */
async function within(promise: Promise<void>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([promise.then(() => true), timedOut]);
	} finally {
		clearTimeout(timer);
	}
}

function seeLog(): string {
	return `See ${modelServerLogPath()}.`;
}

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

function authHeaders(key: string): Record<string, string> {
	return { Authorization: `Bearer ${key}` };
}

/** `GET /health`, which needs no key. False on any failure. */
async function checkHealth(port: number): Promise<boolean> {
	try {
		const response = await fetchWithTimeout(
			`${modelServerBaseUrl(port)}/health`,
			{},
			timing('requestTimeoutMs')
		);
		await response.body?.cancel().catch(() => {});
		return response.ok;
	} catch {
		return false;
	}
}

function parseRouterModels(body: unknown): RouterModel[] {
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return [];
	const models: RouterModel[] = [];
	for (const item of data) {
		const record = item as { id?: unknown; status?: Record<string, unknown> } | null;
		if (typeof record?.id !== 'string') continue;
		const status = record.status ?? {};
		models.push({
			id: record.id,
			status: typeof status.value === 'string' ? status.value : 'unknown',
			failed: status.failed === true,
			exitCode: typeof status.exit_code === 'number' ? status.exit_code : null,
		});
	}
	return models;
}

/** The text of an error answer, from llama-server's `{ error: { message } }`. */
async function answerMessage(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: { message?: unknown } } | null;
		if (typeof body?.error?.message === 'string') return body.error.message;
	} catch {
		// Not JSON; the status says enough.
	}
	return `HTTP ${response.status}`;
}

/** The router's model list. Throws when it does not accept the key. */
async function listRouterModels(current: ServerRun, reload = false): Promise<RouterModel[]> {
	const response = await fetchWithTimeout(
		`${modelServerBaseUrl(current.port)}/models${reload ? '?reload=1' : ''}`,
		{ headers: authHeaders(current.key) },
		timing('requestTimeoutMs')
	);
	if (!response.ok) {
		throw new Error(`GET /models answered ${await answerMessage(response)}`);
	}
	return parseRouterModels(await response.json());
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/** The last line of output that reads like the reason it stopped. */
function lastReason(tail: string): string | null {
	const lines = stripAnsiCodes(tail)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const line =
		[...lines].reverse().find((text) => /error|fail|couldn'?t|cannot|unable/i.test(text)) ??
		lines[lines.length - 1];
	return line ? line.slice(0, 300) : null;
}

function describeExit(exit: NonNullable<ServerRun['exit']>): string {
	if (exit.error) return exit.error.message;
	if (exit.signal) return `signal ${exit.signal}`;
	const code = exit.code ?? 0;
	// A Windows status such as 0xC0000135 (a DLL not found) reads only in hex.
	return code > 0xffff ? `exit code 0x${code.toString(16).toUpperCase()}` : `exit code ${code}`;
}

async function exitedBeforeReady(current: ServerRun): Promise<ModelServerError> {
	// The reason is often the last line it printed, which can land after the exit.
	await within(current.closed, 1_000);
	const reason = lastReason(current.tail);
	return new ModelServerError(
		`The ${MODEL_SERVER_NAME} stopped before it was ready (${describeExit(current.exit!)})${reason ? `: ${reason}` : ''}. ${seeLog()}`,
		'start-failed'
	);
}

async function writeKeyFile(file: string, key: string): Promise<void> {
	await fs.rm(file, { force: true });
	// `wx` creates a new file, so the owner-only mode applies to it.
	await fs.writeFile(file, `${key}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
}

function onOutput(current: ServerRun, chunk: Buffer | string): void {
	current.log.write(chunk);
	current.tail = (current.tail + chunk.toString()).slice(-TAIL_CHARS);
}

function onExit(
	current: ServerRun,
	code: number | null,
	signal: NodeJS.Signals | null,
	error?: Error
): void {
	if (current.exit) return;
	current.exit = { code, signal, ...(error ? { error } : {}) };
	stopHealthMonitor(current);
	current.markExited();
	if (run !== current) return;
	run = null;
	if (current.stopping) {
		setState('stopped');
		logger.info(`The ${MODEL_SERVER_NAME} stopped`, LOG_CONTEXT);
		return;
	}
	// A start still waiting for it reports this itself.
	if (current.readyAt === null) return;
	if (Date.now() - current.readyAt >= timing('stableRunMs')) restarts = 0;
	scheduleRestart(
		current.hung
			? `The ${MODEL_SERVER_NAME} stopped answering its health check and was stopped.`
			: `The ${MODEL_SERVER_NAME} stopped unexpectedly (${describeExit(current.exit)}).`
	);
}

/**
 * Spawn the server with what is on disk now and wait until it answers. Throws a
 * `ModelServerError` naming why it could not; nothing is left running then.
 */
async function launchLocked(knownModels?: ServerModelPreset[]): Promise<void> {
	const binary = await (deps.resolveBinary ?? installedServerBinary)();
	if (!binary) {
		throw new ModelServerError(
			`The ${MODEL_SERVER_NAME} engine is not installed. Install it in ${modelsSettingsLocation('sources')}.`,
			'engine-not-installed'
		);
	}
	const models = knownModels ?? (await collectModels());
	if (models.length === 0) {
		throw new ModelServerError(
			`No text model is downloaded for the ${MODEL_SERVER_NAME} to serve. Download one in ${modelsSettingsLocation('library')}.`,
			'no-models'
		);
	}
	// Rendered first: a model path the file cannot hold stops the start here.
	const presets = renderModelServerPresets(models);

	const config = await readModelServerConfig(dataDir());
	const port = await ensureModelServerPort(dataDir());
	const { key } = await ensureModelServerKey(dataDir(), osSeal());
	const host = MODEL_SERVER_BIND_HOSTS[config.bind];

	const probe = await probePort(port, host);
	if (!probe.free) {
		throw probe.code === 'EADDRINUSE'
			? new ModelServerError(
					`Another program is using ${host}:${port}, the port the ${MODEL_SERVER_NAME} keeps. Quit that program (a llama-server left running by a Maestro that did not quit cleanly counts), then start the server again.`,
					'port-in-use'
				)
			: new ModelServerError(
					`The ${MODEL_SERVER_NAME} cannot listen on ${host}:${port}: ${probe.message}.`,
					'start-failed'
				);
	}

	const cacheDir = path.join(serverDir(), MODEL_SERVER_CACHE_DIRNAME);
	await fs.mkdir(cacheDir, { recursive: true });
	await atomicWriteFile(presetsPath(), presets);
	const keyFile = keyFilePath();
	await writeKeyFile(keyFile, key);

	try {
		const args = buildModelServerArgs({
			bind: config.bind,
			port,
			presetsPath: presetsPath(),
			maxModels: config.maxModels,
			apiKeyFile: keyFile,
		});
		const log = openCappedLogFile(modelServerLogPath(), {
			onError: (error) =>
				logger.warn(
					`The ${MODEL_SERVER_NAME} log could not be written: ${errorMessage(error)}`,
					LOG_CONTEXT
				),
		});
		log.write(`\n[${new Date().toISOString()}] Starting ${binary} ${args.join(' ')}\n`);

		let child: ChildProcess;
		try {
			// Spawned directly, never through a shell: a path with spaces needs no
			// quoting and nothing in it is interpreted. The install directory is the
			// working directory, where Windows looks for the backend DLLs.
			child = (deps.spawn ?? spawnProcess)(binary, args, {
				cwd: path.dirname(binary),
				env: modelServerEnvironment(process.env, cacheDir),
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch (error) {
			log.close();
			throw new ModelServerError(
				`The ${MODEL_SERVER_NAME} could not be started: ${errorMessage(error)}.`,
				'start-failed',
				error
			);
		}

		let markExited = (): void => {};
		let markClosed = (): void => {};
		const current: ServerRun = {
			child,
			port,
			bind: config.bind,
			maxModels: config.maxModels,
			key,
			models: models.map((model) => model.id),
			readyAt: null,
			log,
			tail: '',
			stopping: false,
			hung: false,
			exit: null,
			exited: new Promise<void>((resolve) => (markExited = resolve)),
			markExited: () => markExited(),
			closed: new Promise<void>((resolve) => (markClosed = resolve)),
			markClosed: () => markClosed(),
			healthTimer: null,
			healthChecking: false,
			healthFailures: 0,
		};
		child.stdout?.on('data', (chunk: Buffer) => onOutput(current, chunk));
		child.stderr?.on('data', (chunk: Buffer) => onOutput(current, chunk));
		child.once('exit', (code, signal) => onExit(current, code, signal));
		child.once('close', () => {
			current.log.write(`[${new Date().toISOString()}] Exited\n`);
			current.log.close();
			current.markClosed();
		});
		// `on`, not `once`: an `error` event with no listener left throws in main.
		child.on('error', (error) => {
			// A process that never started (ENOENT, EACCES) sends no exit event.
			if (child.pid === undefined) {
				onExit(current, null, null, error);
				current.log.close();
				current.markClosed();
				return;
			}
			logger.warn(`The ${MODEL_SERVER_NAME} process reported: ${error.message}`, LOG_CONTEXT);
		});
		// Adopted at once, so quitting the app stops a server that is still starting.
		run = current;

		try {
			await waitUntilReady(current);
		} catch (error) {
			if (!current.exit) {
				current.stopping = true;
				stopProcess(
					{ child },
					{ from: 'terminate', graceMs: timing('stopGraceMs'), label: 'model-server' }
				);
				await within(current.exited, timing('stopGraceMs') * 2);
			}
			if (run === current) run = null;
			throw error;
		}
		// Set here, with `readyAt`, and nowhere after: a crash from this moment on
		// moves it to `restarting`, and nothing later may write over that.
		current.readyAt = Date.now();
		setState('running');
		startHealthMonitor(current);
		logger.info(
			`The ${MODEL_SERVER_NAME} is listening on ${host}:${port} (${current.models.length} model${current.models.length === 1 ? '' : 's'})`,
			LOG_CONTEXT
		);
	} finally {
		// Read at launch; not needed on disk past this point.
		await fs.rm(keyFile, { force: true }).catch(() => {});
	}
}

async function waitUntilReady(current: ServerRun): Promise<void> {
	const deadline = Date.now() + timing('startTimeoutMs');
	for (;;) {
		if (current.exit) throw await exitedBeforeReady(current);
		if (await checkHealth(current.port)) break;
		if (current.exit) throw await exitedBeforeReady(current);
		if (Date.now() >= deadline) {
			throw new ModelServerError(
				`The ${MODEL_SERVER_NAME} did not answer within ${Math.round(timing('startTimeoutMs') / 1000)} seconds and was stopped. ${seeLog()}`,
				'start-failed'
			);
		}
		await delay(timing('startPollMs'));
	}
	// Ours, and not a program that took the port in the moment before the spawn.
	try {
		current.models = (await listRouterModels(current)).map((model) => model.id);
	} catch (error) {
		if (current.exit) throw await exitedBeforeReady(current);
		throw new ModelServerError(
			`A server answered on port ${current.port}, but it is not the ${MODEL_SERVER_NAME} (${errorMessage(error)}). Quit the program using that port, then start the server again.`,
			'start-failed',
			error
		);
	}
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

function startHealthMonitor(current: ServerRun): void {
	current.healthTimer = setInterval(() => void checkLiveness(current), timing('healthIntervalMs'));
	current.healthTimer.unref?.();
}

function stopHealthMonitor(current: ServerRun): void {
	if (current.healthTimer) clearInterval(current.healthTimer);
	current.healthTimer = null;
}

async function checkLiveness(current: ServerRun): Promise<void> {
	if (current.healthChecking || current.stopping || current.exit || current.hung) return;
	current.healthChecking = true;
	try {
		if (await checkHealth(current.port)) {
			current.healthFailures = 0;
			// Up long enough to count as recovered from the crashes before it.
			if (
				restarts > 0 &&
				current.readyAt !== null &&
				Date.now() - current.readyAt >= timing('stableRunMs')
			) {
				restarts = 0;
				lastError = null;
			}
			return;
		}
		current.healthFailures += 1;
		if (current.healthFailures < HEALTH_FAILURE_LIMIT || current.stopping || current.exit) return;
		current.hung = true;
		stopHealthMonitor(current);
		logger.warn(
			`The ${MODEL_SERVER_NAME} did not answer ${HEALTH_FAILURE_LIMIT} health checks in a row; stopping it to restart`,
			LOG_CONTEXT
		);
		stopProcess(
			{ child: current.child },
			{ from: 'terminate', graceMs: timing('stopGraceMs'), label: 'model-server' }
		);
	} finally {
		current.healthChecking = false;
	}
}

function cancelRestart(): void {
	if (restartTimer) clearTimeout(restartTimer);
	restartTimer = null;
}

/** After a crash: try again with backoff, or give up and say so. */
function scheduleRestart(reason: string): void {
	cancelRestart();
	restarts += 1;
	if (restarts > MAX_CRASH_RESTARTS) {
		giveUp(reason);
		return;
	}
	lastError = reason;
	setState('restarting');
	const delayMs = timing('restartBackoffMs') * 2 ** (restarts - 1);
	logger.warn(
		`${reason} Restarting in ${delayMs} ms (${restarts} of ${MAX_CRASH_RESTARTS}).`,
		LOG_CONTEXT
	);
	restartTimer = setTimeout(() => {
		restartTimer = null;
		void lifecycle.enqueue(LIFECYCLE_KEY, restartLocked);
	}, delayMs);
	restartTimer.unref?.();
}

async function restartLocked(): Promise<void> {
	// Stopped, or started by someone else, while the timer ran.
	if (state !== 'restarting' || run) return;
	try {
		await launchLocked();
	} catch (error) {
		scheduleRestart(`The ${MODEL_SERVER_NAME} could not restart: ${errorMessage(error)}`);
	}
}

function giveUp(reason: string): void {
	setState('failed');
	lastError = `${reason} It was restarted ${MAX_CRASH_RESTARTS} times and did not stay up, so it was left stopped. ${seeLog()}`;
	logger.error(lastError, LOG_CONTEXT);
	void captureMessage(`${MODEL_SERVER_NAME} left stopped after repeated crashes`, 'warning', {
		reason,
		platform: process.platform,
		arch: process.arch,
	});
	deps.safeSend?.('remote:notifyToast', {
		title: `${MODEL_SERVER_NAME} stopped`,
		message: lastError,
		color: 'red' as const,
	});
}

// ---------------------------------------------------------------------------
// Start and stop
// ---------------------------------------------------------------------------

async function startLocked(knownModels?: ServerModelPreset[]): Promise<void> {
	if (run) return;
	cancelRestart();
	setState('starting');
	lastError = null;
	try {
		await launchLocked(knownModels);
	} catch (error) {
		setState('failed');
		lastError = errorMessage(error);
		logger.warn(`The ${MODEL_SERVER_NAME} could not start: ${lastError}`, LOG_CONTEXT);
		throw error;
	}
}

async function stopLocked(): Promise<void> {
	const current = run;
	if (!current) return;
	current.stopping = true;
	setState('stopping');
	stopHealthMonitor(current);
	stopProcess(
		{ child: current.child },
		{ from: 'terminate', graceMs: timing('stopGraceMs'), label: 'model-server' }
	);
	const budget = timing('stopGraceMs') * 2 + 2_000;
	if (!(await within(current.exited, budget))) {
		logger.warn(
			`The ${MODEL_SERVER_NAME} (pid ${current.child.pid ?? 'unknown'}) had not exited ${budget} ms after it was stopped`,
			LOG_CONTEXT
		);
	}
	if (run === current) run = null;
	await fs.rm(keyFilePath(), { force: true }).catch(() => {});
}

/**
 * Start the server: the user pressed Start. Resolves with the status once it
 * answers; rejects with a `ModelServerError` naming why it could not.
 */
export function startModelServer(): Promise<ModelServerStatus> {
	return lifecycle.enqueue(LIFECYCLE_KEY, async () => {
		// Asked for directly, so earlier crashes no longer count against it.
		restarts = 0;
		await startLocked();
		return getModelServerStatus();
	});
}

/** Stop the server and wait for it to exit. A pending restart is cancelled. */
export function stopModelServer(): Promise<ModelServerStatus> {
	return lifecycle.enqueue(LIFECYCLE_KEY, async () => {
		cancelRestart();
		restarts = 0;
		lastError = null;
		await stopLocked();
		setState('stopped');
		return getModelServerStatus();
	});
}

/**
 * Stop it now, for app quit: every stage of the stop at once, the whole tree
 * (the router and each model's process), and no waiting on an event loop that
 * is about to end.
 */
export function stopModelServerNow(): void {
	cancelRestart();
	const current = run;
	if (!current) return;
	current.stopping = true;
	stopHealthMonitor(current);
	stopProcess(
		{ child: current.child },
		{
			from: 'terminate',
			graceMs: timing('stopGraceMs'),
			immediate: true,
			blocking: true,
			label: 'model-server',
		}
	);
	try {
		fsSync.rmSync(keyFilePath(), { force: true });
	} catch {
		// Quitting; the next configure removes it.
	}
}

export interface ModelServerConfigPatch extends ModelServerSettingsPatch {
	/** Replace the key. What was set up with the old one needs the new one. */
	rotateKey?: boolean;
}

/**
 * Change the bind mode, the model count, or the key. A running server is
 * restarted to apply it, since all three are read at launch.
 */
export function updateModelServerConfig(patch: ModelServerConfigPatch): Promise<ModelServerStatus> {
	return lifecycle.enqueue(LIFECYCLE_KEY, async () => {
		const before = await readModelServerConfig(dataDir());
		const after = await writeModelServerSettings(dataDir(), {
			bind: patch.bind,
			maxModels: patch.maxModels,
		});
		if (patch.rotateKey) {
			await rotateModelServerKey(dataDir(), osSeal());
			logger.info(`The ${MODEL_SERVER_NAME} key was rotated`, LOG_CONTEXT);
		}
		const changed =
			patch.rotateKey === true ||
			before.bind !== after.bind ||
			before.maxModels !== after.maxModels;
		if (run && changed) {
			await stopLocked();
			restarts = 0;
			await startLocked();
		}
		return getModelServerStatus();
	});
}

/**
 * The server's key, made on first use: for the card's Copy, and for whatever
 * Maestro points at the server. Never log it.
 */
export async function getModelServerKey(): Promise<string> {
	return (await ensureModelServerKey(dataDir(), osSeal())).key;
}

// ---------------------------------------------------------------------------
// Serving a model
// ---------------------------------------------------------------------------

/** Make the running server list `models` again after the presets changed. */
async function refreshModelsLocked(current: ServerRun, models: ServerModelPreset[]): Promise<void> {
	await atomicWriteFile(presetsPath(), renderModelServerPresets(models));
	try {
		current.models = (await listRouterModels(current, true)).map((model) => model.id);
	} catch (error) {
		throw new ModelServerError(
			`The ${MODEL_SERVER_NAME} could not reload its model list: ${errorMessage(error)}. ${seeLog()}`,
			'load-failed',
			error
		);
	}
}

/** Ask the router to load `modelId` and wait until it has. */
async function loadModel(current: ServerRun, modelId: string, name: string): Promise<void> {
	const stopped = (): ModelServerError =>
		new ModelServerError(
			`The ${MODEL_SERVER_NAME} stopped while it was loading ${name}.`,
			'load-failed'
		);
	const find = async (): Promise<RouterModel | undefined> =>
		(await listRouterModels(current)).find((model) => model.id === modelId);

	let before: RouterModel | undefined;
	try {
		before = await find();
	} catch (error) {
		if (run !== current || current.exit) throw stopped();
		throw new ModelServerError(
			`The ${MODEL_SERVER_NAME} did not answer before loading ${name}: ${errorMessage(error)}. ${seeLog()}`,
			'load-failed',
			error
		);
	}
	if (before?.status !== 'loaded') {
		let response: Response;
		try {
			response = await fetchWithTimeout(
				`${modelServerBaseUrl(current.port)}/models/load`,
				{
					method: 'POST',
					headers: { ...authHeaders(current.key), 'Content-Type': 'application/json' },
					body: JSON.stringify({ model: modelId }),
				},
				timing('requestTimeoutMs')
			);
		} catch (error) {
			if (run !== current) throw stopped();
			throw new ModelServerError(
				`The ${MODEL_SERVER_NAME} did not take the request to load ${name}: ${errorMessage(error)}.`,
				'load-failed',
				error
			);
		}
		if (!response.ok) {
			const message = await answerMessage(response);
			// Loading, or loaded since the check above: nothing to ask for.
			if (!/already running/i.test(message)) {
				throw new ModelServerError(
					`The ${MODEL_SERVER_NAME} could not load ${name}: ${message}.`,
					'load-failed'
				);
			}
		} else {
			await response.body?.cancel().catch(() => {});
		}
	}

	const deadline = Date.now() + timing('modelLoadTimeoutMs');
	let pollFailures = 0;
	for (;;) {
		if (run !== current || current.exit) throw stopped();
		let model: RouterModel | undefined;
		let answered = false;
		try {
			model = await find();
			answered = true;
			pollFailures = 0;
		} catch (error) {
			if (run !== current || current.exit) throw stopped();
			if (++pollFailures >= HEALTH_FAILURE_LIMIT) {
				throw new ModelServerError(
					`The ${MODEL_SERVER_NAME} stopped answering while it was loading ${name}: ${errorMessage(error)}. ${seeLog()}`,
					'load-failed',
					error
				);
			}
		}
		if (answered) {
			if (!model) {
				throw new ModelServerError(
					`The ${MODEL_SERVER_NAME} no longer lists ${name}. ${seeLog()}`,
					'load-failed'
				);
			}
			if (model.status === 'loaded') return;
			if (model.failed) {
				throw new ModelServerError(
					`The ${MODEL_SERVER_NAME} could not load ${name}${model.exitCode !== null ? ` (exit code ${model.exitCode})` : ''}. ${seeLog()}`,
					'load-failed'
				);
			}
			if (model.status === 'unloaded') {
				throw new ModelServerError(
					`${name} was unloaded before it finished loading, most likely to make room for another model: the ${MODEL_SERVER_NAME} keeps ${current.maxModels} loaded at a time.`,
					'load-failed'
				);
			}
		}
		if (Date.now() >= deadline) {
			throw new ModelServerError(
				`${name} did not finish loading within ${Math.round(timing('modelLoadTimeoutMs') / 60_000)} minutes. ${seeLog()}`,
				'load-failed'
			);
		}
		await delay(timing('modelLoadPollMs'));
	}
}

/**
 * Make the server ready to serve `modelId`: start it if it is not running, add
 * the model to its list if it was installed since, and load it. For a caller
 * the user turned on (an agent that runs on a server model, a task assigned to
 * one); it must refuse what it was about to do on `ok: false`, never send it
 * somewhere else.
 */
export async function ensureModelServerFor(modelId: string): Promise<ModelServerEnsureResult> {
	try {
		const entry = getLocalModel(modelId);
		if (!entry || !isServerModel(entry)) {
			throw new ModelServerError(
				`"${modelId}" is not a text model the ${MODEL_SERVER_NAME} can serve.`,
				'model-unsupported'
			);
		}
		const current = await lifecycle.enqueue(LIFECYCLE_KEY, async () => {
			const models = await collectModels();
			if (!models.some((model) => model.id === modelId)) {
				throw new ModelServerError(
					`${entry.displayName} is not downloaded. Download it in ${modelsSettingsLocation('library')}.`,
					'model-not-installed'
				);
			}
			if (!run) {
				restarts = 0;
				await startLocked(models);
			}
			const active = run as ServerRun | null;
			if (!active) {
				throw new ModelServerError(`The ${MODEL_SERVER_NAME} is not running.`, 'start-failed');
			}
			if (!active.models.includes(modelId)) await refreshModelsLocked(active, models);
			if (!active.models.includes(modelId)) {
				throw new ModelServerError(
					`The ${MODEL_SERVER_NAME} does not list ${entry.displayName} after reloading its models. ${seeLog()}`,
					'load-failed'
				);
			}
			return active;
		});
		// Outside the lifecycle chain: a large model can take minutes to load, and
		// a Stop pressed meanwhile must not wait for it.
		await loadModel(current, modelId, entry.displayName);
		return { ok: true, baseUrl: modelServerBaseUrl(current.port), model: modelId };
	} catch (error) {
		if (isModelServerError(error)) return { ok: false, code: error.code, error: error.message };
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** What the server is doing now. Reads only; never starts it or chooses a port. */
export async function getModelServerStatus(): Promise<ModelServerStatus> {
	const config = await readModelServerConfig(dataDir());
	const current = run;
	const ready = current !== null && current.readyAt !== null && current.exit === null;
	let loadedModels: string[] = [];
	if (current && ready) {
		try {
			loadedModels = (await listRouterModels(current))
				.filter((model) => model.status === 'loaded')
				.map((model) => model.id);
		} catch {
			// A status read reports what it can; the health check owns failures.
		}
	}
	const port = current?.port ?? config.port;
	const bind = current?.bind ?? config.bind;
	return {
		state,
		port,
		bind,
		host: MODEL_SERVER_BIND_HOSTS[bind],
		baseUrl: port === null ? null : modelServerBaseUrl(port),
		maxModels: current?.maxModels ?? config.maxModels,
		pid: current?.child.pid ?? null,
		startedAt: current?.readyAt ?? null,
		restarts,
		lastError,
		models: ready && current ? [...current.models] : [],
		loadedModels,
		keyStorage: config.keyStorage,
		logPath: modelServerLogPath(),
	};
}

/**
 * Where the running server serves `modelId` right now, when it already has it
 * loaded: its base URL and key. Null when the server is not running, does not
 * serve that model, has it unloaded, or does not answer. Reads only: it never
 * starts the server or loads a model. Text generation asks it so a task on a
 * model the server already holds reaches that copy instead of loading a second
 * one in-process.
 */
export async function modelServerServingLoaded(
	modelId: string
): Promise<{ baseUrl: string; key: string } | null> {
	const current = run;
	if (!current || current.readyAt === null || current.exit !== null) return null;
	if (!current.models.includes(modelId)) return null;
	let loaded: boolean;
	try {
		loaded = (await listRouterModels(current)).some(
			(model) => model.id === modelId && model.status === 'loaded'
		);
	} catch {
		// Not answering: the health check owns that. Nothing is served from here.
		return null;
	}
	if (!loaded || run !== current) return null;
	return { baseUrl: modelServerBaseUrl(current.port), key: current.key };
}

/** Stop the server and forget everything, so each test starts from a process that never ran it. */
export async function resetModelServerForTests(): Promise<void> {
	cancelRestart();
	await lifecycle.enqueue(LIFECYCLE_KEY, stopLocked);
	run = null;
	setState('stopped');
	lastError = null;
	restarts = 0;
	deps = {};
}
