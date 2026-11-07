/**
 * The Maestro model server: llama.cpp's own `llama-server`, run and watched by
 * Maestro so an agent harness (Claude Code, Codex, OpenCode) can use the models
 * in the Library over HTTP. It speaks the OpenAI Chat Completions, OpenAI
 * Responses and Anthropic Messages protocols.
 *
 * This module holds what every surface shares (the main-process supervisor, the
 * Models card, `maestro-cli models server`): the bind modes, the status shape,
 * the error codes and the defaults. Everything here is data and pure functions.
 * The supervisor is `src/main/local-models/server/supervisor.ts`.
 */

import type { SecretStorage } from '../secretStorage';
import type { LocalModelEndpoint } from './endpoints';
import type { ServerAcceleratorReport } from './server-accelerator';
import type { ServerBuildChoice, ServerBuildKind } from './server-engine';

export const MODEL_SERVER_NAME = 'Maestro model server';

/**
 * Who can reach the server.
 *
 *   - `local`: this machine only. It listens on `127.0.0.1`.
 *   - `network`: other machines too. It listens on `0.0.0.0`, every interface.
 *
 * Both modes require the server's API key. A network bind without one is
 * refused, and Local only uses it too, so another program on the machine (or a
 * web page the browser has open) cannot use the server without it.
 */
export type ModelServerBind = 'local' | 'network';

export const MODEL_SERVER_BINDS: readonly ModelServerBind[] = Object.freeze(['local', 'network']);

export const DEFAULT_MODEL_SERVER_BIND: ModelServerBind = 'local';

/** The address the server listens on in each mode. */
export const MODEL_SERVER_BIND_HOSTS: Readonly<Record<ModelServerBind, string>> = Object.freeze({
	local: '127.0.0.1',
	network: '0.0.0.0',
});

/** How this machine reaches the server, in either mode. */
export const MODEL_SERVER_LOOPBACK_HOST = '127.0.0.1';

/**
 * Models loaded at the same time (llama-server's `--models-max`). One by default:
 * a model the server loads is a second copy of gigabytes of weights, and two
 * large models resident at once is how a laptop starts swapping. Loading another
 * model unloads the least recently used one. The setting raises it.
 */
export const DEFAULT_MODEL_SERVER_MAX_MODELS = 1;

/** The highest `maxModels` accepted. `0` means "unlimited" to llama-server and is never sent. */
export const MAX_MODEL_SERVER_MAX_MODELS = 16;

/**
 * The smallest context an agent harness can work in. Measured 2026-10-11 with
 * Claude Code 2.1.296 against the server: its first prompt is about 14,400
 * tokens, and a 16,384 context failed with "Prompt is too long" where 40,960
 * worked.
 */
export const MODEL_SERVER_AGENT_MIN_CONTEXT = 40_960;

/**
 * What the server is doing.
 *
 *   - `stopped`: not running. The state at app start, and after Stop.
 *   - `starting`: spawned, not yet answering `/health`.
 *   - `running`: answering, and serving the models it was started with.
 *   - `restarting`: it stopped on its own, and a restart is scheduled.
 *   - `stopping`: a stop is in progress.
 *   - `failed`: it could not start, or it crashed too many times in a row. It
 *     stays stopped until something asks for it again; `lastError` says why.
 */
export type ModelServerState =
	| 'stopped'
	| 'starting'
	| 'running'
	| 'restarting'
	| 'stopping'
	| 'failed';

/**
 * Where the server's key is kept: sealed with the key the OS holds for the app
 * (`os`), or, on a machine with no OS key store (Linux with no keyring), under a
 * key built into the app (`obscured`). The card says which.
 */
export type ModelServerKeyStorage = SecretStorage;

export interface ModelServerStatus {
	state: ModelServerState;
	/** The port the server keeps, or null before it was first started. */
	port: number | null;
	bind: ModelServerBind;
	/** The address it listens on (or will): `127.0.0.1` or `0.0.0.0`. */
	host: string;
	/** Where this machine reaches it, `http://127.0.0.1:<port>`. Null without a port. */
	baseUrl: string | null;
	maxModels: number;
	pid: number | null;
	/** Epoch ms the running server became ready. */
	startedAt: number | null;
	/** Crashes in a row since it last ran long enough to count as recovered. */
	restarts: number;
	lastError: string | null;
	/** Catalog ids the running server serves. Empty while it is not running. */
	models: string[];
	/** The ones loaded in memory right now. */
	loadedModels: string[];
	/** Null until a key exists. */
	keyStorage: ModelServerKeyStorage | null;
	/** The server's own log: its stdout and stderr, size-capped. */
	logPath: string;
}

/**
 * Why the server could not do what was asked.
 *
 *   - `engine-not-installed`: the `llama-server` engine is not downloaded.
 *   - `no-models`: no text model is downloaded for it to serve.
 *   - `model-unsupported`: the id is not a catalog text model the server can run.
 *   - `model-not-installed`: that model is not downloaded.
 *   - `port-in-use`: another program holds the server's port.
 *   - `key-unavailable`: the stored key could not be read or made.
 *   - `key-required`: a start without a key, which the server refuses.
 *   - `invalid-setting`: a bind mode or model count it does not accept.
 *   - `preset-invalid`: a model path the presets file cannot carry.
 *   - `start-failed`: it exited before it was ready, or never answered.
 *   - `load-failed`: it is running but could not load the model.
 */
export type ModelServerErrorCode =
	| 'engine-not-installed'
	| 'no-models'
	| 'model-unsupported'
	| 'model-not-installed'
	| 'port-in-use'
	| 'key-unavailable'
	| 'key-required'
	| 'invalid-setting'
	| 'preset-invalid'
	| 'start-failed'
	| 'load-failed';

/**
 * The answer to "make the server ready for this model": where to send the
 * requests, and the model name to send, or why it cannot. A caller that gets
 * `ok: false` must refuse what it was about to do, never send it elsewhere.
 */
export type ModelServerEnsureResult =
	| { ok: true; baseUrl: string; model: string }
	| { ok: false; code: ModelServerErrorCode; error: string };

export function isModelServerBind(value: unknown): value is ModelServerBind {
	return typeof value === 'string' && (MODEL_SERVER_BINDS as readonly string[]).includes(value);
}

export function isModelServerMaxModels(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= MAX_MODEL_SERVER_MAX_MODELS
	);
}

/** `http://127.0.0.1:<port>`: the root a harness on this machine is pointed at. */
export function modelServerBaseUrl(port: number): string {
	return `http://${MODEL_SERVER_LOOPBACK_HOST}:${port}`;
}

// ---------------------------------------------------------------------------
// The report: what the Model server card and `maestro-cli models server status` show
// ---------------------------------------------------------------------------

/** One build this platform can install, for the build picker. */
export interface ModelServerBuildOption {
	choice: ServerBuildChoice;
	/** "Metal", "Vulkan", "CPU", "CUDA 12.4". */
	label: string;
	kind: ServerBuildKind;
	/** Compressed download, companions included. */
	downloadBytes: number;
}

/** The `llama-server` engine: what is installed, and what could be. */
export interface ModelServerEngineInfo {
	installed: boolean;
	/** Installed, but not the build this app pins: Install again fetches the pin. */
	stale: boolean;
	/** The installed release tag, or null when nothing is installed. */
	release: string | null;
	/** The installed build: what the user chose, its label and kind. Null when nothing is installed. */
	choice: ServerBuildChoice | null;
	label: string | null;
	kind: ServerBuildKind | null;
	/** What `--list-devices` found at install time, or null. */
	accelerator: ServerAcceleratorReport | null;
	/** Bytes the installed engine occupies on disk. */
	bytes: number;
	/** The builds this platform has, `default` first. Empty on a platform with none. */
	builds: ModelServerBuildOption[];
}

/** A model the running server has in memory. */
export interface ModelServerLoadedModel {
	id: string;
	displayName: string;
	/**
	 * Approximate memory: the size of its weights file. The context cache comes
	 * on top, so the real figure is somewhat higher.
	 */
	approxBytes: number;
}

export type ModelServerEnginePhase = 'downloading' | 'verifying' | 'extracting' | 'done';

/** An engine install in progress. Broadcast, so every window sees the same one. */
export interface ModelServerEngineProgress {
	choice: ServerBuildChoice;
	phase: ModelServerEnginePhase;
	bytes: number;
	totalBytes: number;
}

export interface ModelServerReport {
	status: ModelServerStatus;
	engine: ModelServerEngineInfo;
	loaded: ModelServerLoadedModel[];
	/** The engine install running now, or null. */
	installing: ModelServerEngineProgress | null;
}

/** One line for the card and the CLI: where the server is reachable from, in words. */
export function modelServerBindLabel(bind: ModelServerBind): string {
	return bind === 'network'
		? `Network (${MODEL_SERVER_BIND_HOSTS.network}, other machines can reach it)`
		: `Local only (${MODEL_SERVER_BIND_HOSTS.local})`;
}

// ---------------------------------------------------------------------------
// The server as a Local Models source
// ---------------------------------------------------------------------------

/**
 * The server's id as a Local Models endpoint. It is built in: it is never saved
 * in `localModelEndpoints`, the endpoint list refuses to add, edit or remove a
 * record with this id, and only the Model server card (and `maestro-cli models
 * server`) controls it. An assignment names it like any endpoint
 * (`endpoint:maestro-server:<catalog id>`), and the call starts the server and
 * loads the model when it is not up yet.
 */
export const MODEL_SERVER_ENDPOINT_ID = 'maestro-server';

/** Whether a person's reference (an id or a name, as `findLocalModelEndpoint` reads one) means the server. */
export function isModelServerEndpointRef(ref: unknown): boolean {
	if (typeof ref !== 'string') return false;
	const needle = ref.trim();
	return (
		needle === MODEL_SERVER_ENDPOINT_ID || needle.toLowerCase() === MODEL_SERVER_NAME.toLowerCase()
	);
}

/**
 * The server as an endpoint record, for the endpoint client. `openai-compatible`
 * because llama-server lists on `/v1/models` and chats on
 * `/v1/chat/completions`. It carries no `apiKeyEnvVar`: Maestro holds the key
 * itself and hands it to each call.
 */
export function modelServerEndpoint(baseUrl: string): LocalModelEndpoint {
	return {
		id: MODEL_SERVER_ENDPOINT_ID,
		name: MODEL_SERVER_NAME,
		kind: 'openai-compatible',
		baseUrl,
		enabled: true,
	};
}
