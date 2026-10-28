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
	  }
	| { ok: false; error: string };

/**
 * The path segment that puts an agent in front of a route. Not a route id, so
 * no upstream can ever be reached through it.
 */
export const TOKEN_PROXY_AGENT_SEGMENT = 'agent';

/** Split `/agent/<id>` off the front of a request path, when it is there. */
function splitAgentPrefix(rawPath: string): { agentId: string | null; path: string } | null {
	const match = new RegExp(`^/${TOKEN_PROXY_AGENT_SEGMENT}(?:/([^/]*)(/.*)?)?$`).exec(rawPath);
	if (!match) return { agentId: null, path: rawPath };
	let agentId = '';
	try {
		agentId = decodeURIComponent(match[1] ?? '');
	} catch {
		return null;
	}
	if (agentId === '' || match[2] === undefined) return null;
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
	agentId: string
): string {
	if (agentId === '' || !gatewayPointsAtTokenProxy(gatewayUrl, port)) return gatewayUrl;
	let parsed: URL;
	try {
		parsed = new URL(gatewayUrl.trim());
	} catch {
		return gatewayUrl;
	}
	if (splitAgentPrefix(parsed.pathname)?.agentId) return gatewayUrl;
	const path = parsed.pathname.replace(/\/+$/, '');
	return `${parsed.protocol}//${parsed.host}/${TOKEN_PROXY_AGENT_SEGMENT}/${encodeURIComponent(agentId)}${path}`;
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
 * mode, and no background requests target. Every writer that moves an agent's
 * gateway away from the proxy spreads this, so the two cannot drift apart.
 *
 * Shared, so the renderer's writers and the pure group-defaults publish
 * (`applyGroupDefaultsToSession`) clear the same two fields.
 */
export const OFF_TOKEN_PROXY_FIELDS: Readonly<{
	tokenProxyMode: undefined;
	backgroundRequests: undefined;
}> = Object.freeze({ tokenProxyMode: undefined, backgroundRequests: undefined });

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

/** Both sides of one compressed block, from the content-addressed cache. */
export interface TokenProxyBlockDetail {
	hash: string;
	/** The text the agent sent. Null when the cache no longer holds it. */
	original: string | null;
	/** The text sent in its place, marker included. */
	compressed: string;
	originalTokens: number;
	compressedTokens: number;
	compressors: string[];
	createdAt: number;
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
