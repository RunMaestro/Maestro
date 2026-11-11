/**
 * The Maestro token proxy: addressing and routing, as pure functions.
 *
 * The proxy is an HTTP server on this machine's loopback interface that an
 * agent reaches through its Local Models gateway (`gateway.ts`). The base URL
 * the agent is given encodes the upstream as its first path segment:
 *
 *   http://127.0.0.1:<port>/anthropic   ->  https://api.anthropic.com
 *   http://127.0.0.1:<port>/openai/v1   ->  https://api.openai.com/v1
 *   http://127.0.0.1:<port>/chatgpt     ->  https://chatgpt.com/backend-api/codex
 *
 * so one port serves every provider and a request never has to be inspected to
 * learn where it goes. A launch in the desktop app puts the agent in front of
 * the route (`/agent/<agent id>/anthropic`, see `tokenProxyAgentGatewayUrl`),
 * which is how the proxy knows whose request it carries and which mode that
 * agent chose. The server (`src/main/local-models/proxy/`) owns sockets
 * and lifecycle; everything that is only arithmetic on a URL lives here, so the
 * server, the settings UI and the CLI cannot disagree about what a gateway URL
 * means.
 */

import { classifyCredentialKind } from '../providerAuthIdentity';
import { formatCount } from '../formatters';
import type { ProxyCompressionEntry, ProxyRequestTotals, ProxyRequestUsage } from '../stats-types';
import { agentGatewaySupport, isLoopbackGatewayUrl } from './gateway';

/** The only interface the proxy listens on. Never a wildcard address. */
export const TOKEN_PROXY_HOST = '127.0.0.1';

/** The name every error and log line uses, so a failure names its source. */
export const TOKEN_PROXY_NAME = 'Maestro token proxy';

export type TokenProxyRouteId = 'anthropic' | 'openai' | 'chatgpt';

export interface TokenProxyRoute {
	/** The real upstream. A path here is prepended to the forwarded path. */
	upstream: string;
	/**
	 * What follows the port in the base URL an agent is given. Not always the
	 * bare route: `OPENAI_BASE_URL` conventionally ends in `/v1`.
	 */
	gatewayPath: string;
	/** Who this route is for, for a person. */
	label: string;
}

/**
 * Route prefix -> upstream. The proxy forwards to these hosts and no others: a
 * request cannot name its own destination, so the proxy cannot be used to reach
 * an arbitrary host.
 *
 * `chatgpt` is where Codex sends a ChatGPT login's traffic (it is not
 * api.openai.com, which rejects that token). It has not been confirmed against
 * a real run yet; `anthropic` and `openai` are the providers' documented API
 * hosts.
 */
export const TOKEN_PROXY_ROUTES: Record<TokenProxyRouteId, TokenProxyRoute> = {
	anthropic: {
		upstream: 'https://api.anthropic.com',
		gatewayPath: '/anthropic',
		label: 'Claude Code',
	},
	openai: {
		upstream: 'https://api.openai.com',
		gatewayPath: '/openai/v1',
		label: 'Codex with an OpenAI API key',
	},
	chatgpt: {
		upstream: 'https://chatgpt.com/backend-api/codex',
		gatewayPath: '/chatgpt',
		label: 'Codex with a ChatGPT login',
	},
};

/** Route prefix -> upstream base URL: the shape the server routes with. */
export type TokenProxyUpstreams = Record<string, string>;

/** The default upstream table, derived from {@link TOKEN_PROXY_ROUTES}. */
export function defaultTokenProxyUpstreams(): TokenProxyUpstreams {
	const upstreams: TokenProxyUpstreams = {};
	for (const [id, route] of Object.entries(TOKEN_PROXY_ROUTES)) upstreams[id] = route.upstream;
	return upstreams;
}

/**
 * The API a forwarded request speaks. Every path under a route is forwarded
 * (a provider CLI also calls token counting, model lists and the like); only
 * these three carry a message list a later phase may compress.
 */
export type TokenProxyRequestKind =
	| 'anthropic-messages'
	| 'openai-chat-completions'
	| 'openai-responses'
	| 'other';

/** Classify a forwarded path (the part after the route prefix, no query). */
export function classifyTokenProxyPath(method: string, path: string): TokenProxyRequestKind {
	if (method.toUpperCase() !== 'POST') return 'other';
	const trimmed = path.replace(/\/+$/, '');
	if (trimmed.endsWith('/v1/messages')) return 'anthropic-messages';
	if (trimmed.endsWith('/chat/completions')) return 'openai-chat-completions';
	if (trimmed.endsWith('/responses')) return 'openai-responses';
	return 'other';
}

export type TokenProxyTarget =
	| {
			ok: true;
			route: string;
			/** The route's upstream base URL, as the table has it. */
			upstream: string;
			/** The request path without the route prefix or the query. */
			path: string;
			/** The query string with its `?`, or empty. */
			query: string;
			kind: TokenProxyRequestKind;
			/** The agent the base URL named, or null when it named none. */
			agentId: string | null;
			/** Opaque host-issued launch token. Parsing it does not establish capability. */
			launchBinding?: string;
	  }
	| { ok: false; error: string };

/**
 * The path segment that puts an agent in front of a route. Not a route id, so
 * no upstream can ever be reached through it.
 */
export const TOKEN_PROXY_AGENT_SEGMENT = 'agent';

/** Reserved only after an agent prefix; never forwarded to a provider. */
export const TOKEN_PROXY_LAUNCH_SEGMENT = 'launch';

export function isTokenProxyLaunchBinding(value: unknown): value is string {
	return typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

/** Split `/agent/<id>` off the front of a request path, when it is there. */
function splitAgentPrefix(
	rawPath: string
): { agentId: string | null; path: string; launchBinding?: string } | null {
	const match = new RegExp(`^/${TOKEN_PROXY_AGENT_SEGMENT}(?:/([^/]*)(/.*)?)?$`).exec(rawPath);
	if (!match) return { agentId: null, path: rawPath };
	let agentId = '';
	try {
		agentId = decodeURIComponent(match[1] ?? '');
	} catch {
		return null;
	}
	if (agentId === '' || match[2] === undefined) return null;
	if (
		match[2] === `/${TOKEN_PROXY_LAUNCH_SEGMENT}` ||
		match[2].startsWith(`/${TOKEN_PROXY_LAUNCH_SEGMENT}/`)
	) {
		const launch = /^\/launch\/([^/]+)(\/.*)$/.exec(match[2]);
		if (!launch || !isTokenProxyLaunchBinding(launch[1])) return null;
		return { agentId, launchBinding: launch[1], path: launch[2] };
	}
	return { agentId, path: match[2] };
}

/**
 * Where a request goes. `requestUrl` is the request line's target
 * (`/anthropic/v1/messages?beta=true`). The path and query are carried over as
 * text, never re-encoded: a re-serialized URL is a different request. The
 * upstream receives the upstream base's own path, then `path`, then `query`.
 */
export function resolveTokenProxyTarget(
	method: string,
	requestUrl: string,
	upstreams: TokenProxyUpstreams = defaultTokenProxyUpstreams()
): TokenProxyTarget {
	const queryAt = requestUrl.indexOf('?');
	const rawPath = queryAt === -1 ? requestUrl : requestUrl.slice(0, queryAt);
	const query = queryAt === -1 ? '' : requestUrl.slice(queryAt);
	const scoped = splitAgentPrefix(rawPath);
	const match = scoped ? /^\/([^/]+)(\/.*)?$/.exec(scoped.path) : null;
	const route = match?.[1] ?? '';
	const upstream = Object.prototype.hasOwnProperty.call(upstreams, route)
		? upstreams[route]
		: undefined;
	if (!match || upstream === undefined) {
		const known = Object.keys(upstreams)
			.map((id) => `/${id}`)
			.join(', ');
		return {
			ok: false,
			error: `${TOKEN_PROXY_NAME} has no upstream for "${rawPath || '/'}". A gateway URL that points at it ends in one of: ${known}.`,
		};
	}
	const path = match[2] ?? '';
	return {
		ok: true,
		route,
		upstream,
		path,
		query,
		kind: classifyTokenProxyPath(method, path),
		agentId: scoped?.agentId ?? null,
		...(scoped?.launchBinding ? { launchBinding: scoped.launchBinding } : {}),
	};
}

/** The base URL an agent is given to reach `route` through the proxy. */
export function tokenProxyGatewayUrl(port: number, route: TokenProxyRouteId): string {
	return `http://${TOKEN_PROXY_HOST}:${port}${TOKEN_PROXY_ROUTES[route].gatewayPath}`;
}

/**
 * Whether an agent's stored gateway URL reaches the Maestro proxy on `port`.
 * Any loopback spelling counts (`localhost` as well as 127.0.0.1): the question
 * is whether the proxy has to be up for this agent, and a wrong route on the
 * right port is answered by the proxy itself, by name, which beats a refused
 * connection.
 */
export function gatewayPointsAtTokenProxy(
	gatewayUrl: string | null | undefined,
	port: number
): boolean {
	const raw = gatewayUrl?.trim() ?? '';
	if (raw === '' || !isLoopbackGatewayUrl(raw)) return false;
	try {
		return new URL(raw).port === String(port);
	} catch {
		return false;
	}
}

/**
 * The base URL one agent's process is given for a launch: the stored gateway
 * with `/agent/<agent id>` in front of its route. Only a gateway that reaches
 * the Maestro proxy on `port` is changed; any other URL (Headroom, LiteLLM, a
 * loopback proxy on another port) comes back as it was, because a path segment
 * added to somebody else's proxy is a different address there.
 *
 * The stored URL stays the plain one. The agent is a fact about the launch,
 * so a worktree agent that inherited its parent's gateway is still counted as
 * itself.
 */
export function tokenProxyAgentGatewayUrl(
	gatewayUrl: string,
	port: number,
	agentId: string,
	launchBinding?: string
): string {
	if (agentId === '' || !gatewayPointsAtTokenProxy(gatewayUrl, port)) return gatewayUrl;
	let parsed: URL;
	try {
		parsed = new URL(gatewayUrl.trim());
	} catch {
		return gatewayUrl;
	}
	if (launchBinding === undefined) {
		if (splitAgentPrefix(parsed.pathname)?.agentId) return gatewayUrl;
		const path = parsed.pathname.replace(/\/+$/, '');
		return `${parsed.protocol}//${parsed.host}/${TOKEN_PROXY_AGENT_SEGMENT}/${encodeURIComponent(agentId)}${path}`;
	}
	const scoped = splitAgentPrefix(parsed.pathname);
	if (!scoped || scoped.launchBinding) return gatewayUrl;
	if (scoped.agentId && scoped.agentId !== agentId) return gatewayUrl;
	if (!isTokenProxyLaunchBinding(launchBinding)) return gatewayUrl;
	const path = scoped.path.replace(/\/+$/, '');
	const launch = `/${TOKEN_PROXY_LAUNCH_SEGMENT}/${launchBinding}`;
	return `${parsed.protocol}//${parsed.host}/${TOKEN_PROXY_AGENT_SEGMENT}/${encodeURIComponent(agentId)}${launch}${path}${parsed.search}${parsed.hash}`;
}

/**
 * What the proxy does with one agent's requests.
 *
 * - `off`: the agent's gateway is not the Maestro proxy (it has none, or it
 *   points somewhere else).
 * - `passthrough`: requests are forwarded unchanged and counted.
 * - `compress`: a large tool result is shortened once the model has read it in
 *   full (`src/main/local-models/proxy/compress.ts`). The model's work is
 *   unchanged; the result is written to the provider's prompt cache twice, in
 *   full and then shortened, so a short session costs slightly more and a long
 *   one less.
 * - `compress-early`: a large tool result is shortened BEFORE the model first
 *   reads it. Nothing is cached twice, so it is the cheapest in every session.
 *   The model works from the shortened output, which is the trade.
 */
export type TokenProxyMode = 'off' | 'passthrough' | 'compress' | 'compress-early';

export const TOKEN_PROXY_MODES: readonly TokenProxyMode[] = [
	'off',
	'passthrough',
	'compress',
	'compress-early',
];

/**
 * What an agent's record holds once it is off the Maestro token proxy: no
 * mode, no background requests target, and no retrieval. Every writer that
 * moves an agent's gateway away from the proxy spreads this, so the fields
 * cannot drift apart.
 *
 * Shared, so the renderer's writers and the pure group-defaults publish
 * (`applyGroupDefaultsToSession`) clear the same fields.
 */
export const OFF_TOKEN_PROXY_FIELDS: Readonly<{
	tokenProxyMode: undefined;
	backgroundRequests: undefined;
	tokenProxyRetrieval: undefined;
}> = Object.freeze({
	tokenProxyMode: undefined,
	backgroundRequests: undefined,
	tokenProxyRetrieval: undefined,
});

/** Whether a record still holds any field {@link OFF_TOKEN_PROXY_FIELDS} clears. */
export function holdsTokenProxyFields(
	record: Readonly<Partial<Record<keyof typeof OFF_TOKEN_PROXY_FIELDS, unknown>>>
): boolean {
	return (Object.keys(OFF_TOKEN_PROXY_FIELDS) as Array<keyof typeof OFF_TOKEN_PROXY_FIELDS>).some(
		(key) => record[key] !== undefined
	);
}

/** The part of the mode that is stored on the agent. `off` is the gateway's absence. */
export type StoredTokenProxyMode = Exclude<TokenProxyMode, 'off'>;

/** What a request is carried as. A request that names no agent is `passthrough`. */
export type TokenProxyRequestMode = StoredTokenProxyMode;

export const TOKEN_PROXY_MODE_LABELS: Record<TokenProxyMode, string> = {
	off: 'Off',
	passthrough: 'Passthrough (count only)',
	compress: 'Compress tool results',
	'compress-early': 'Compress early',
};

/**
 * Said wherever a token figure from the proxy is shown. The proxy has no
 * tokenizer for the provider, so it counts 4 characters to a token. Against a
 * provider's own count that matched on a log of ordinary words and came out
 * about 1.9 times low on shell output full of paths and digits, so a saving
 * shown is an estimate that errs low, not a measurement.
 */
export const TOKEN_PROXY_ESTIMATE_NOTE =
	'Token counts are estimates at 4 characters per token. On paths, digits and stack traces the real saving can be about twice the figure shown.';

/**
 * Tokens saved, with the share of what arrived: `10,000 (25%)`. A dash when
 * the proxy read no request body in the range, because a passthrough request
 * is counted and nothing else. The figure is an estimate: show
 * {@link TOKEN_PROXY_ESTIMATE_NOTE} beside it.
 */
export function describeTokensSaved(totals: ProxyRequestTotals): string {
	if (totals.compressRequests === 0) return '-';
	const share =
		totals.originalTokens > 0 ? Math.round((totals.tokensSaved / totals.originalTokens) * 100) : 0;
	return `${formatCount(totals.tokensSaved)} (${share}%)`;
}

/** Mean time a request was held while the proxy read it. A dash when it read none. */
export function describeAddedLatency(totals: ProxyRequestTotals): string {
	return totals.compressRequests === 0 ? '-' : `${formatCount(totals.avgAddedLatencyMs)} ms`;
}

/** One sentence per mode: what it does and what it costs. Shown under the picker. */
export const TOKEN_PROXY_MODE_DESCRIPTIONS: Record<TokenProxyMode, string> = {
	off: "This agent's requests do not go through the Maestro proxy.",
	passthrough: 'Requests are forwarded unchanged and counted. Nothing is shortened.',
	compress:
		'A large tool result is shortened after the model has read it once in full. The model sees everything; the result is cached twice, so this costs more than Passthrough in a short session and less only in a long one.',
	'compress-early':
		'A large tool result is shortened before the model first reads it. The cheapest mode, because nothing is cached in full. The model works from the shortened output.',
};

/** Whether a mode reads and shortens request bodies. */
export function isCompressingTokenProxyMode(mode: TokenProxyMode): boolean {
	return mode === 'compress' || mode === 'compress-early';
}

/**
 * Retrieval: the per-agent switch that gives the agent's model the
 * `retrieve_compressed_original` tool, so it can ask the proxy for the lines a
 * compressed tool result left out. Stored as `tokenProxyRetrieval: true` on the
 * agent record; off is the field's absence. It has effect only in a compressing
 * mode, and it leaves with the proxy ({@link OFF_TOKEN_PROXY_FIELDS}).
 */
export const TOKEN_PROXY_RETRIEVAL_FIELD = 'tokenProxyRetrieval';

/** What the switch means in each position, for the Models tab and the CLI. */
export const TOKEN_PROXY_RETRIEVAL_DESCRIPTIONS: Readonly<Record<'on' | 'off', string>> =
	Object.freeze({
		on: 'The model can ask for the original lines of a tool result the proxy shortened, so Compress early may leave lines out. It reaches only originals this machine still holds.',
		off: 'The model cannot ask for an original, so Compress early only uses reductions that leave nothing out.',
	});

/** Why turning retrieval on is refused for an agent the proxy does not compress for. */
export const TOKEN_PROXY_RETRIEVAL_NEEDS_COMPRESSION =
	'Retrieval works only while the Maestro token proxy compresses this agent: set its proxy mode to compress or compress-early first.';

export type TokenProxyRetrievalEdit =
	| { ok: true; retrieval: true | undefined }
	| { ok: false; error: string };

/**
 * Read a retrieval value from the CLI, the bridge or a click. `true` turns it
 * on; `false` and `null` remove the field. Anything else is refused by name.
 */
export function parseTokenProxyRetrievalEdit(value: unknown): TokenProxyRetrievalEdit {
	if (value === true) return { ok: true, retrieval: true };
	if (value === false || value === null || value === undefined) {
		return { ok: true, retrieval: undefined };
	}
	return { ok: false, error: `${TOKEN_PROXY_RETRIEVAL_FIELD} must be true, false or null.` };
}

/** Narrow a value from the CLI, the bridge or a stored record. Never a cast. */
export function asTokenProxyMode(value: unknown): TokenProxyMode | undefined {
	return TOKEN_PROXY_MODES.includes(value as TokenProxyMode)
		? (value as TokenProxyMode)
		: undefined;
}

/** The stored half of {@link asTokenProxyMode}: anything but a compress mode is passthrough. */
export function asStoredTokenProxyMode(value: unknown): StoredTokenProxyMode {
	return value === 'compress' || value === 'compress-early' ? value : 'passthrough';
}

/**
 * An agent's proxy mode, from what is stored on it. `off` unless its gateway
 * reaches the proxy; then the stored mode, and `passthrough` when none is
 * stored: a gateway pointed at the proxy by hand changes nothing until the user
 * asks for compression.
 */
export function resolveTokenProxyMode(input: {
	gatewayUrl?: string | null;
	storedMode?: unknown;
	/** The proxy's port, or null when none has been chosen yet. */
	port: number | null;
}): TokenProxyMode {
	if (input.port === null || !gatewayPointsAtTokenProxy(input.gatewayUrl, input.port)) return 'off';
	return asStoredTokenProxyMode(input.storedMode);
}

/**
 * Which route an agent's traffic takes through the proxy, or null with the
 * reason when it cannot use the proxy at all. `env` is the agent's effective
 * environment (`resolveAgentEnvironment`): Codex with an API key talks to
 * api.openai.com, and with a ChatGPT login to a different host.
 */
export function tokenProxyRouteForAgent(
	toolType: string,
	env: Record<string, string>
): { ok: true; route: TokenProxyRouteId } | { ok: false; error: string } {
	const support = agentGatewaySupport(toolType);
	if (!support.supported) return { ok: false, error: support.reason };
	if (toolType === 'claude-code') return { ok: true, route: 'anthropic' };
	if (toolType === 'codex') {
		const apiKey = classifyCredentialKind(toolType, env).kind === 'api-key';
		return { ok: true, route: apiKey ? 'openai' : 'chatgpt' };
	}
	return { ok: false, error: `${TOKEN_PROXY_NAME} has no route for "${toolType}".` };
}

/** What the proxy is doing now. */
export interface TokenProxyStatus {
	/** The proxy's port, or null when none has been chosen yet. */
	port: number | null;
	/** Whether it is listening right now. */
	running: boolean;
	/** The local agents whose gateway points at it. */
	agentIds: string[];
	/** Why the last start failed, or null. Cleared by a start that works. */
	lastError: string | null;
	/** The base URL to give an agent, per route. Null until a port exists. */
	gatewayUrls: Record<TokenProxyRouteId, string> | null;
}

/** One agent that uses the proxy, as the report names it. */
export interface TokenProxyAgentRow {
	id: string;
	name: string;
	toolType: string;
	mode: StoredTokenProxyMode;
	gatewayUrl: string;
}

/**
 * Everything the Gateway section and `maestro-cli models proxy status` show:
 * the listener, the agents on it, what it carried, and what it last shortened.
 */
export interface TokenProxyReport {
	status: TokenProxyStatus;
	agents: TokenProxyAgentRow[];
	/** Null when usage statistics are off or the stats database is not ready. */
	usage: ProxyRequestUsage | null;
	recentCompressions: ProxyCompressionEntry[];
}

/** Inclusive, 1-based original lines. LF ends a line; a trailing LF adds no empty line. */
export interface TokenProxyOriginalLineRange {
	startLine: number;
	endLine: number;
}

export const TOKEN_PROXY_ORIGINAL_RANGE_MAX_LINES = 1000;
export const TOKEN_PROXY_ORIGINAL_RANGE_MAX_BYTES = 256 * 1024;

/** Validate before any archive access, including when the hash has no stored verdict. */
export function validateTokenProxyOriginalLineRange(value: unknown): TokenProxyOriginalLineRange {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		const range = value as Record<string, unknown>;
		const { startLine, endLine } = range;
		if (
			Object.keys(range).length === 2 &&
			Object.prototype.hasOwnProperty.call(range, 'startLine') &&
			Object.prototype.hasOwnProperty.call(range, 'endLine') &&
			typeof startLine === 'number' &&
			typeof endLine === 'number' &&
			Number.isSafeInteger(startLine) &&
			Number.isSafeInteger(endLine) &&
			startLine >= 1 &&
			endLine >= startLine &&
			endLine - startLine < TOKEN_PROXY_ORIGINAL_RANGE_MAX_LINES
		) {
			return { startLine, endLine };
		}
	}
	throw new RangeError(
		`Original line range requires only startLine and endLine: positive safe integers in ascending order, at most ${TOKEN_PROXY_ORIGINAL_RANGE_MAX_LINES} lines.`
	);
}

export interface TokenProxyOriginalRangeInfo {
	/** Archive key, not proof of provider/session ownership or a reverified full-file hash. */
	hash: string;
	source: 'original';
	requested: TokenProxyOriginalLineRange;
	/** Null for an empty original or a request starting past EOF. */
	returned: TokenProxyOriginalLineRange | null;
	/** Every requested line was returned. A byte/scan limit throws instead of truncating. */
	complete: boolean;
	/** More original bytes follow the returned selection; no total line count is inferred. */
	hasMore: boolean;
}

export interface TokenProxyOriginalRangeRead {
	/** Exact selected text, including original LF/CRLF terminators. */
	text: string;
	range: TokenProxyOriginalRangeInfo;
}

/** Both sides of one compressed block, from the content-addressed cache. */
export interface TokenProxyBlockDetail {
	hash: string;
	/** Full original, or the exact requested lines. Null when not stored. */
	original: string | null;
	/** Present only for range requests; null when the original is missing. */
	originalRange?: TokenProxyOriginalRangeInfo | null;
	/** The text sent in its place, marker included. */
	compressed: string;
	originalTokens: number;
	compressedTokens: number;
	compressors: string[];
	createdAt: number;
}

/**
 * What the provider counted for one request, from the `usage` in its answer.
 * Input is uncached input; OpenAI's cached tokens are moved out of its prompt
 * total into `cacheReadTokens`, and it reports no cache writes (0).
 */
export interface TokenProxyProviderUsage {
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
}

/** What the compression cache directory holds (`maestro-cli models proxy cache`). */
export interface TokenProxyCacheUsage {
	/** Verdict records. */
	entries: number;
	/** Bytes of every file under the directory, records and texts. */
	bytes: number;
	/** Last use of the least recently used entry, epoch ms; `null` when empty. */
	oldestUseAt: number | null;
}

/** What one prune of the compression cache removed, and what remains. */
export interface TokenProxyCachePruneResult {
	removedEntries: number;
	removedBytes: number;
	/** Text files with no record (left by a crash between writes) that were removed. */
	removedOrphans: number;
	usage: TokenProxyCacheUsage;
}

export type TokenProxyErrorCode =
	/** The request named no route the proxy knows. */
	| 'unknown-route'
	/** The upstream could not be reached, or dropped before answering. */
	| 'upstream-unreachable'
	/** The client asked to switch protocols (a WebSocket), which the proxy does not carry. */
	| 'upgrade-not-supported'
	/**
	 * The agent's Background requests target could not be used. The request was
	 * not sent to the provider (see `background-requests.ts`).
	 */
	| 'background-target-unavailable';

/**
 * The body of an error the PROXY raises (an upstream's own error is forwarded
 * untouched and never takes this shape). One object that both provider SDKs
 * read: Anthropic takes `error.message` under a top-level `type: "error"`,
 * OpenAI takes `error.message`.
 */
export function tokenProxyErrorBody(code: TokenProxyErrorCode, message: string): string {
	return JSON.stringify({
		type: 'error',
		error: { type: 'maestro_token_proxy_error', code, message },
	});
}
