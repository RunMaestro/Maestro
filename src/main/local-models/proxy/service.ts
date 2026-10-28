/**
 * The Maestro token proxy's lifecycle: which port it owns, and when it listens.
 *
 * The server (`server.ts`) carries requests and has no opinions. This module
 * decides the things around it:
 *
 * 1. **The port is chosen once and kept.** An agent's stored gateway URL names
 *    the port, so a port that moved between launches would leave every such
 *    agent pointing at nothing (or at whatever took the old one). It is picked
 *    the first time something asks for it (`ensureTokenProxyPort`), written to
 *    `userData/token-proxy.json`, and reused from then on. When that port is
 *    taken at start, the proxy does NOT move: it fails by name.
 * 2. **It listens only while an agent needs it.** `syncTokenProxy()` starts it
 *    when at least one local agent's gateway points at it and stops it when
 *    none do. It runs at startup and after every write of the sessions store
 *    (the store raises no change event of its own; see `deferred-writes.ts`),
 *    which every gateway edit goes through. Until a port exists it is a no-op,
 *    so a user who never uses the proxy pays nothing.
 * 3. **A launch never trusts that it is up.** `ensureTokenProxyForGateway()` is
 *    called by the spawn paths that live in this process (desktop, Cue, and
 *    through `applyAgentGatewayToSpawn()` Group Chat and cross-agent consults)
 *    for an agent whose gateway points here. It starts the proxy if needed and, when
 *    it cannot, fails the launch with a message that names the proxy. Without
 *    it a port held by another program would receive the agent's request,
 *    credentials included.
 *
 * 4. **It knows whose request it carries, and how that agent wants it carried.**
 *    A launch in this process gives the agent a base URL with its id in it
 *    (`tokenProxyLaunchGatewayUrl`). The server asks `modeFor` per request,
 *    which reads the agent's stored `tokenProxyMode`, so a mode the user
 *    changes applies to the next request, mid-turn. A request that names no
 *    agent, or an agent that is gone, is a passthrough.
 *
 * 5. **It knows where an agent's background requests go.** The server asks
 *    `backgroundRouteFor` per Anthropic Messages request, which reads the
 *    agent's stored `backgroundRequests`. The target is looked up and made
 *    ready (the Maestro model server started, the model loaded) only for a
 *    request the server has already decided IS a background request, so an
 *    agent's own turn never starts anything. A target that cannot be used
 *    fails that request by name; it is never sent to the provider instead.
 *
 * `maestro-cli send` spawns in the CLI's own process and cannot start anything
 * here. It relies on (2): the proxy is already up while the app is, and with
 * the app closed the agent's connection to the gateway URL is refused, which is
 * the error the user sees. A CLI launch also carries no agent id, so its
 * requests are passthrough and are counted without an agent.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
	backgroundRequestsUnavailable,
	parseBackgroundRequests,
	type BackgroundRequestsRefusalCode,
} from '../../../shared/local-models/background-requests';
import { endpointServesAnthropicMessages } from '../../../shared/local-models/endpoints';
import { resolveAgentGateway } from '../../../shared/local-models/gateway';
import { formatRunOnSpec, type RunOnSourceTarget } from '../../../shared/local-models/run-on';
import {
	asStoredTokenProxyMode,
	gatewayPointsAtTokenProxy,
	TOKEN_PROXY_HOST,
	TOKEN_PROXY_NAME,
	TOKEN_PROXY_ROUTES,
	tokenProxyAgentGatewayUrl,
	tokenProxyGatewayUrl,
	type TokenProxyAgentRow,
	type TokenProxyBlockDetail,
	type TokenProxyReport,
	type TokenProxyRequestMode,
	type TokenProxyRouteId,
	type TokenProxyStatus,
} from '../../../shared/local-models/token-proxy';
import { atomicWriteJson, createKeyedWriteQueue } from '../../utils/atomic-json-store';
import { logger } from '../../utils/logger';
import type { SafeSendFn } from '../../utils/safe-send';
import { captureException } from '../../utils/sentry';
import { isTcpPort, pickFreePort } from '../../utils/tcp-port';
import { localModelsDataDir } from '../paths';
import { resolveSourceCallTarget, type SourceCallTarget } from '../run-on';
import { reportLocalTaskUnavailable } from '../task-notices';
import { compressRequestBody } from './compress';
import { getCompressionCache, isContentHash } from './compression-cache';
import { readTokenProxyUsage, recordTokenProxyRequest } from './request-stats';
import {
	createTokenProxyServer,
	type TokenProxyBackgroundRoute,
	type TokenProxyBackgroundTarget,
	type TokenProxyRequestLog,
	type TokenProxyServer,
	type TokenProxyServerOptions,
} from './server';

const LOG_CONTEXT = '[TokenProxy]';

/** The file that remembers the port, relative to the data dir. */
export const TOKEN_PROXY_STATE_FILE = 'token-proxy.json';

export interface TokenProxyDeps {
	/** The stored agent records (the main-process sessions store). */
	sessions: () => Array<Record<string, unknown>>;
	/** Where the state file lives. Defaults to the Maestro data dir. */
	dataDir?: () => string;
	/** Builds the server. A seam for tests. */
	createServer?: (options: TokenProxyServerOptions) => TokenProxyServer;
	/** Raises the one toast that says the `token-proxy` model could not run. */
	safeSend?: SafeSendFn;
}

export type { TokenProxyStatus };

export type TokenProxyEnsureResult = { ok: true } | { ok: false; error: string };

let deps: TokenProxyDeps | null = null;
let server: TokenProxyServer | null = null;
/** `undefined` until the state file has been read once. */
let knownPort: number | null | undefined;
let lastError: string | null = null;

// Every start, stop and port choice runs on one chain: a stop requested while
// a start is still binding must wait for it, not race it.
const lifecycle = createKeyedWriteQueue();
const LIFECYCLE_KEY = 'token-proxy';

/** Point the proxy at the app's stores. Starts nothing. */
export function configureTokenProxy(next: TokenProxyDeps): void {
	deps = next;
}

function stateFilePath(): string {
	return path.join((deps?.dataDir ?? localModelsDataDir)(), TOKEN_PROXY_STATE_FILE);
}

/** The persisted port, or null. Reads the file once per process. */
async function readPort(): Promise<number | null> {
	if (knownPort !== undefined) return knownPort;
	let port: number | null = null;
	try {
		const parsed = JSON.parse(await fs.readFile(stateFilePath(), 'utf-8')) as { port?: unknown };
		if (isTcpPort(parsed?.port)) port = parsed.port;
		else logger.warn(`Ignoring ${TOKEN_PROXY_STATE_FILE}: it holds no usable port`, LOG_CONTEXT);
	} catch (error) {
		// No file is the normal state for a user who has never used the proxy.
		if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			logger.warn(`Could not read ${TOKEN_PROXY_STATE_FILE}`, LOG_CONTEXT, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	knownPort = port;
	return port;
}

function agentsPointingAt(port: number): string[] {
	if (!deps) return [];
	const ids: string[] = [];
	for (const record of deps.sessions()) {
		if (typeof record?.gatewayUrl !== 'string') continue;
		if (!gatewayPointsAtTokenProxy(record.gatewayUrl, port)) continue;
		// An agent on an SSH remote cannot reach this machine's loopback, and
		// its launch is refused for it (`gateway-loopback-on-remote`).
		if ((record.sessionSshRemoteConfig as { enabled?: boolean } | undefined)?.enabled === true) {
			continue;
		}
		ids.push(String(record.id));
	}
	return ids;
}

/** The stored record of one agent, or undefined when there is none. */
function agentRecord(agentId: string): Record<string, unknown> | undefined {
	return deps?.sessions().find((record) => record?.id === agentId);
}

/**
 * How one agent's requests are carried, read from its stored record each time
 * so a change applies to the next request. Passthrough for a request that
 * names no agent and for an agent that no longer exists: compression is
 * something an agent asks for, never a default.
 */
function modeFor(agentId: string | null): TokenProxyRequestMode {
	if (agentId === null) return 'passthrough';
	return asStoredTokenProxyMode(agentRecord(agentId)?.tokenProxyMode);
}

/** Why a source cannot be sent a request, as a background requests refusal. */
const SOURCE_REFUSAL_CODES: Readonly<
	Record<Extract<SourceCallTarget, { ok: false }>['reason'], BackgroundRequestsRefusalCode>
> = {
	missing: 'background-source-missing',
	disabled: 'background-source-disabled',
	'server-failed': 'background-server-failed',
};

/**
 * Make one background target ready for a request: its source looked up, the
 * Maestro model server started when the target is on it, and the source
 * checked for the one route a background request uses.
 */
async function resolveBackgroundTarget(
	target: RunOnSourceTarget
): Promise<TokenProxyBackgroundTarget> {
	const source = await resolveSourceCallTarget(target);
	if (!source.ok) {
		return {
			ok: false,
			error: backgroundRequestsUnavailable(
				SOURCE_REFUSAL_CODES[source.reason],
				target,
				source.endpoint,
				source.detail
			),
		};
	}
	if (!endpointServesAnthropicMessages(source.endpoint)) {
		return {
			ok: false,
			error: backgroundRequestsUnavailable(
				'background-source-not-anthropic',
				target,
				source.endpoint
			),
		};
	}
	return { ok: true, baseUrl: source.endpoint.baseUrl, key: source.key, model: target.model };
}

/**
 * Where one agent's background requests go, read from its stored record each
 * time so a change applies to the next request. Null for a request that names
 * no agent and for an agent that sends them nowhere. A stored value that is
 * not a target still answers with a route, one that fails by name: a setting
 * the user made is never read as "send it to the provider".
 */
function backgroundRouteFor(agentId: string | null): TokenProxyBackgroundRoute | null {
	if (agentId === null) return null;
	const record = agentRecord(agentId);
	const parsed = parseBackgroundRequests(record?.backgroundRequests);
	const toolType = typeof record?.toolType === 'string' ? record.toolType : '';
	if (!parsed.ok) {
		const error = backgroundRequestsUnavailable(
			'background-invalid-target',
			null,
			null,
			parsed.error
		);
		return { toolType, resolve: async () => ({ ok: false, error }) };
	}
	if (!parsed.backgroundRequests) return null;
	const target = parsed.backgroundRequests.target;
	const routedTo = formatRunOnSpec(target);
	return {
		toolType,
		routedTo,
		resolve: () =>
			resolveBackgroundTarget(target).catch((error: unknown) => {
				// A target that cannot be used is an answer, not a throw. A throw
				// means the lookup itself is broken: the server still fails the
				// request by name, and this is how the bug is heard about.
				void captureException(error instanceof Error ? error : new Error(String(error)), {
					operation: 'tokenProxy:resolveBackgroundTarget',
					agentId,
					routedTo,
				});
				throw error;
			}),
	};
}

function logRequest(entry: TokenProxyRequestLog): void {
	const compression = entry.compression;
	const background = entry.background;
	const data = {
		route: entry.route,
		kind: entry.kind,
		agentId: entry.agentId,
		mode: entry.mode,
		method: entry.method,
		path: entry.path,
		status: entry.status,
		requestBytes: entry.requestBytes,
		sentBytes: entry.sentBytes,
		responseBytes: entry.responseBytes,
		durationMs: entry.durationMs,
		outcome: entry.outcome,
		...(compression
			? {
					compression: {
						skipped: compression.skipped,
						error: compression.error,
						changed: compression.changed,
						addedLatencyMs: compression.addedLatencyMs,
						originalTokens: compression.originalTokens,
						sentTokens: compression.sentTokens,
						compressed: compression.stats?.compressed,
						cacheHits: compression.stats?.cacheHits,
					},
				}
			: {}),
		...(background
			? {
					routedTo: background.routedTo,
					background: {
						skipped: background.skipped,
						error: background.error,
						addedLatencyMs: background.addedLatencyMs,
					},
				}
			: {}),
	};
	if (compression?.skipped === 'failed') {
		logger.warn(
			`${TOKEN_PROXY_NAME} could not compress a request and sent it as it arrived: ${compression.error ?? 'unknown error'}`,
			LOG_CONTEXT,
			data
		);
	}
	if (entry.outcome === 'upstream-failed' || entry.outcome === 'unknown-route') {
		logger.warn(entry.error ?? `${TOKEN_PROXY_NAME} failed a request`, LOG_CONTEXT, data);
		return;
	}
	if (background?.skipped === 'failed') {
		logger.warn(
			`${TOKEN_PROXY_NAME} could not read a request for background routing and sent it to the provider: ${background.error ?? 'unknown error'}`,
			LOG_CONTEXT,
			data
		);
	}
	logger.info(
		`${entry.method} /${entry.route}${entry.path} -> ${entry.status}: ${entry.sentBytes} bytes sent, ${entry.responseBytes} bytes received${background?.routedTo ? `, routed to ${background.routedTo}` : ''}`,
		LOG_CONTEXT,
		data
	);
}

/** Why a start on `port` failed, as the end of a sentence. */
function startFailureReason(port: number, error: unknown): string {
	if ((error as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
		return `another program is using ${TOKEN_PROXY_HOST}:${port}. Quit that program, or clear the gateway on the agents that point at this port`;
	}
	return error instanceof Error ? error.message : String(error);
}

/** Listen on `port`. Throws with the reason; records it as `lastError`. */
async function start(port: number): Promise<void> {
	if (server) return;
	let next: TokenProxyServer;
	try {
		next = (deps?.createServer ?? createTokenProxyServer)({
			onRequest: (entry) => {
				logRequest(entry);
				recordTokenProxyRequest(entry);
			},
			modeFor,
			backgroundRouteFor,
			compress: (kind, body, { early }) =>
				compressRequestBody(kind, body, {
					early,
					onModelUnavailable: (verdict) =>
						reportLocalTaskUnavailable({
							safeSend: deps?.safeSend,
							taskId: 'token-proxy',
							verdict,
						}),
				}),
		});
		await next.listen(port);
	} catch (error) {
		lastError = startFailureReason(port, error);
		logger.error(`${TOKEN_PROXY_NAME} could not start: ${lastError}`, LOG_CONTEXT);
		throw new Error(lastError);
	}
	server = next;
	lastError = null;
	logger.info(`${TOKEN_PROXY_NAME} listening on ${TOKEN_PROXY_HOST}:${port}`, LOG_CONTEXT);
}

/**
 * Stop listening. The port is released at once; a request in flight finishes
 * unless `force` is set (an agent whose gateway was cleared mid-turn keeps the
 * turn it already started).
 */
async function stop(force: boolean): Promise<void> {
	const closing = server;
	if (!closing) return;
	server = null;
	logger.info(`${TOKEN_PROXY_NAME} stopped`, LOG_CONTEXT);
	const drained = closing.close({ force });
	if (force) await drained;
	else void drained;
}

/**
 * The proxy's port, chosen and persisted on the first call. This is the only
 * function that creates the state file: call it when the user asks for the
 * proxy's address, not at startup.
 */
export function ensureTokenProxyPort(): Promise<number> {
	return lifecycle.enqueue(LIFECYCLE_KEY, async () => {
		const existing = await readPort();
		if (existing !== null) return existing;
		const port = await pickFreePort(TOKEN_PROXY_HOST);
		await atomicWriteJson(stateFilePath(), { port });
		knownPort = port;
		logger.info(`${TOKEN_PROXY_NAME} will use port ${port}`, LOG_CONTEXT);
		return port;
	});
}

/**
 * Bring the listener in line with the stored agents: up when at least one
 * local agent's gateway points at the proxy, down when none do. Never throws:
 * a failed start is logged and reported by `getTokenProxyStatus()`, and the
 * launch that needs the proxy fails by name in `ensureTokenProxyForGateway()`.
 */
export function syncTokenProxy(): Promise<void> {
	return lifecycle.enqueue(LIFECYCLE_KEY, async () => {
		const port = await readPort();
		if (port === null) return;
		if (agentsPointingAt(port).length === 0) {
			await stop(false);
			return;
		}
		try {
			await start(port);
		} catch {
			// Recorded and logged by start().
		}
	});
}

/**
 * Called by a launch whose agent has a gateway. A gateway that is not the
 * Maestro proxy is none of this module's business (`ok`). One that is gets a
 * running proxy or a failure that names it; the caller must then refuse the
 * launch rather than send the turn to a port the proxy does not hold.
 */
export function ensureTokenProxyForGateway(gatewayUrl: string): Promise<TokenProxyEnsureResult> {
	return lifecycle.enqueue(LIFECYCLE_KEY, async (): Promise<TokenProxyEnsureResult> => {
		const port = await readPort();
		if (port === null || !gatewayPointsAtTokenProxy(gatewayUrl, port)) return { ok: true };
		try {
			await start(port);
			return { ok: true };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				error: `This agent's Local Models gateway (${gatewayUrl}) is the ${TOKEN_PROXY_NAME}, which could not start: ${reason}. The turn was not sent.`,
			};
		}
	});
}

/**
 * The base URL to give one agent's process for a launch: its stored gateway,
 * with the agent in front of the route when that gateway is the Maestro proxy
 * (`tokenProxyAgentGatewayUrl`). Any other gateway, and no gateway, come back
 * as they were. Reads the port; never chooses one.
 */
export async function tokenProxyLaunchGatewayUrl(
	agentId: string | undefined,
	gatewayUrl: string | undefined
): Promise<string | undefined> {
	if (!agentId || !gatewayUrl) return gatewayUrl;
	const port = await readPort();
	return port === null ? gatewayUrl : tokenProxyAgentGatewayUrl(gatewayUrl, port, agentId);
}

export interface SpawnGatewayInput {
	/** The Maestro agent whose stored gateway applies. */
	agentId: string;
	/** That agent's provider, e.g. `claude-code`. */
	toolType: string;
	/** The arguments the spawn was about to use. */
	args: string[];
	/** The agent's effective custom vars; a base-URL variable set here wins. */
	customEnvVars?: Record<string, string>;
	/** The SSH remote the process runs on, when it runs on one. */
	remote?: { name: string } | null;
}

export type SpawnGatewayResult =
	| {
			ok: true;
			args: string[];
			customEnvVars: Record<string, string> | undefined;
			/** What was applied, or null when the agent has no gateway in effect. */
			gateway: { envVar: string; url: string } | null;
	  }
	| { ok: false; error: string };

/**
 * Apply an agent's Local Models gateway to a spawn that does not build a launch
 * plan (a Group Chat participant, a cross-agent consult). The same three steps
 * the plan-based paths take, in one call so a new spawn site cannot do two of
 * them: give the proxy the agent's id, resolve the gateway with the same rules
 * (`resolveAgentGateway`), and make sure the proxy is up before the turn goes
 * to its port. A gateway that cannot be used comes back as an error the caller
 * must refuse the spawn with; it never falls back to a direct connection.
 */
export async function applyAgentGatewayToSpawn(
	input: SpawnGatewayInput
): Promise<SpawnGatewayResult> {
	const unchanged: SpawnGatewayResult = {
		ok: true,
		args: input.args,
		customEnvVars: input.customEnvVars,
		gateway: null,
	};
	const stored = agentRecord(input.agentId)?.gatewayUrl;
	if (typeof stored !== 'string' || stored.trim() === '') return unchanged;

	const gateway = resolveAgentGateway({
		toolType: input.toolType,
		gatewayUrl: await tokenProxyLaunchGatewayUrl(input.agentId, stored),
		userEnvVars: input.customEnvVars,
		remote: input.remote ?? null,
	});
	if (gateway.kind === 'refused') return { ok: false, error: gateway.message };
	if (gateway.kind !== 'inject') return unchanged;

	const proxy = await ensureTokenProxyForGateway(gateway.url);
	if (!proxy.ok) return { ok: false, error: proxy.error };
	return {
		ok: true,
		// A global option: ahead of the agent's own arguments, subcommand included.
		args: [...gateway.args, ...input.args],
		customEnvVars: { ...(input.customEnvVars ?? {}), ...gateway.envVars },
		gateway: { envVar: gateway.envVar, url: gateway.url },
	};
}

/** What the proxy is doing now. Reads only; never chooses a port. */
export async function getTokenProxyStatus(): Promise<TokenProxyStatus> {
	const port = await readPort();
	let gatewayUrls: TokenProxyStatus['gatewayUrls'] = null;
	if (port !== null) {
		const urls = {} as Record<TokenProxyRouteId, string>;
		for (const route of Object.keys(TOKEN_PROXY_ROUTES) as TokenProxyRouteId[]) {
			urls[route] = tokenProxyGatewayUrl(port, route);
		}
		gatewayUrls = urls;
	}
	return {
		port,
		running: server !== null,
		agentIds: port === null ? [] : agentsPointingAt(port),
		lastError,
		gatewayUrls,
	};
}

/**
 * The proxy's whole picture, for the Gateway section and `maestro-cli models
 * proxy status`: the listener, the agents on it with their mode, what it
 * carried lately, and the blocks it last shortened. Reads only.
 */
export async function getTokenProxyReport(): Promise<TokenProxyReport> {
	const status = await getTokenProxyStatus();
	const agents: TokenProxyAgentRow[] = [];
	for (const id of status.agentIds) {
		const record = agentRecord(id);
		if (!record) continue;
		agents.push({
			id,
			name: typeof record.name === 'string' ? record.name : id,
			toolType: typeof record.toolType === 'string' ? record.toolType : '',
			mode: asStoredTokenProxyMode(record.tokenProxyMode),
			gatewayUrl: String(record.gatewayUrl),
		});
	}
	return { status, agents, ...readTokenProxyUsage() };
}

/**
 * Both sides of one compressed block, from the content-addressed cache: what
 * the agent sent and what went out in its place. Null for a hash the cache
 * holds no compressed verdict for. `hash` arrives over IPC and the CLI, so it
 * is checked before it is used as a path.
 */
export async function readTokenProxyBlock(hash: unknown): Promise<TokenProxyBlockDetail | null> {
	if (!isContentHash(hash)) {
		throw new Error(
			'A compressed block is named by its SHA-256 hash: 64 lowercase hex characters.'
		);
	}
	const cache = getCompressionCache();
	const verdict = await cache.read(hash);
	if (!verdict || verdict.outcome !== 'compressed') return null;
	return {
		hash,
		original: await cache.readOriginal(hash),
		compressed: verdict.text,
		originalTokens: verdict.originalTokens,
		compressedTokens: verdict.compressedTokens,
		compressors: [...verdict.compressors],
		createdAt: verdict.createdAt,
	};
}

/** Stop the proxy and cut what it is carrying. For app shutdown and tests. */
export function stopTokenProxy(): Promise<void> {
	return lifecycle.enqueue(LIFECYCLE_KEY, () => stop(true));
}

/** Forget everything, so each test starts from a process that never ran it. */
export async function resetTokenProxyForTests(): Promise<void> {
	await stopTokenProxy();
	deps = null;
	knownPort = undefined;
	lastError = null;
}
