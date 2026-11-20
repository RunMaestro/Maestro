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
import type {
	ProxyCompressionEntry,
	ProxyCoverage,
	ProxyEvidenceKind,
	ProxyFigure,
	ProxyFigureUnit,
	ProxyProviderClassStatus,
	ProxyProviderReportedness,
	ProxyProviderUsageClass,
	ProxyRequest,
	ProxyRequestTotals,
	ProxyRequestUsage,
	ProxyUnknownReason,
} from '../stats-types';
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
export function tokenProxyGatewayUrl(
	port: number,
	route: TokenProxyRouteId,
	toolType?: string
): string {
	const path = TOKEN_PROXY_ROUTES[route].gatewayPath;
	// A provider whose gateway URL carries the API version (OpenCode's SDK
	// `baseURL`) is given the route's `/v1`, which it then never appends itself.
	const support = toolType === undefined ? undefined : agentGatewaySupport(toolType);
	const versioned =
		support?.supported && support.urlIncludesApiVersion && !path.endsWith('/v1')
			? `${path}/v1`
			: path;
	return `http://${TOKEN_PROXY_HOST}:${port}${versioned}`;
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
 * - `compress`: a large tool result outside the protected recent part of a
 *   request is shortened (`src/main/local-models/proxy/compress.ts`). Recent
 *   results stay unchanged. Actual provider exposure and cache history are not
 *   tracked; cost effects depend on provider caching, retrieval and session history.
 * - `compress-early`: recent tool results are also eligible for shortening.
 *   Without retrieval it uses only the complete profile. Neither prior provider
 *   exposure nor a cost saving is guaranteed.
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

/** Payload token estimates establish neither provider usage nor cost savings. */
export const TOKEN_PROXY_ESTIMATE_NOTE =
	'Token counts are estimates at 4 characters per token. A smaller outgoing payload does not establish billed token or cost savings.';

/**
 * Tokens saved, with the share of what arrived: `10,000 (25%)`. A dash when
 * the proxy read no request body in the range, because a passthrough request
 * is counted and nothing else. The figure is an estimate: show
 * {@link TOKEN_PROXY_ESTIMATE_NOTE} beside it.
 */
export function describeTokensSaved(
	totals: Pick<ProxyRequestTotals, 'compressRequests' | 'originalTokens' | 'tokensSaved'>
): string {
	if (totals.compressRequests === 0) return '-';
	const share =
		totals.originalTokens > 0 ? Math.round((totals.tokensSaved / totals.originalTokens) * 100) : 0;
	return `${formatCount(totals.tokensSaved)} (${share}%)`;
}

/**
 * Mean time a request was held while the proxy read it, said against the
 * requests that carry a time (`timedRequests`), because a mean of 0 reads the
 * same whether it was measured or has no sample:
 *
 * - `-`: the proxy read no request body in the range.
 * - `unknown`: it read some and none carries a time, so there is no mean. Also an
 *   older desktop's mean of 0, which cannot be told from no sample.
 * - `14 ms`: the mean of one or more timed requests. A measured 0 stays `0 ms`.
 * - `14 ms (sample unknown)`: an older desktop sent a mean and not its sample.
 */
export function describeAddedLatency(totals: ProxyRequestTotals): string {
	if (totals.compressRequests === 0) return '-';
	const mean = `${formatCount(totals.avgAddedLatencyMs)} ms`;
	if (totals.timedRequests === undefined) {
		return totals.avgAddedLatencyMs > 0 ? `${mean} (sample unknown)` : 'unknown';
	}
	return totals.timedRequests === 0 ? 'unknown' : mean;
}

/** Eligibility policy per mode, without a provider-exposure or cost guarantee. */
export const TOKEN_PROXY_MODE_DESCRIPTIONS: Record<TokenProxyMode, string> = {
	off: "This agent's requests do not go through the Maestro proxy.",
	passthrough: 'Requests are forwarded unchanged and counted. Nothing is shortened.',
	compress:
		'Compresses eligible text outside the protected recent part of each request. Reuses cached verdicts. Cost savings depend on provider caching, retrieval and session history.',
	'compress-early':
		'Also makes recent tool-result text eligible for compression. The model can receive shortened output on its first exposure. Cost savings are not guaranteed.',
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

/**
 * Whether retrieval has effect for one agent now: the switch is on and the
 * proxy compresses its requests (its gateway reaches the proxy and the stored
 * mode is `compress` or `compress-early`). A stored `true` under passthrough
 * is kept but does nothing, so it gives the model no tool.
 */
export function isTokenProxyRetrievalInEffect(input: {
	retrieval?: unknown;
	gatewayUrl?: string | null;
	storedMode?: unknown;
	/** The proxy's port, or null when none has been chosen yet. */
	port: number | null;
}): boolean {
	return (
		input.retrieval === true &&
		isCompressingTokenProxyMode(
			resolveTokenProxyMode({
				gatewayUrl: input.gatewayUrl,
				storedMode: input.storedMode,
				port: input.port,
			})
		)
	);
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
 * The mode a request was carried as, from a stored string: null for a missing
 * value or one this build does not know. Unlike {@link asStoredTokenProxyMode} it
 * never falls back to `passthrough`, because a reader of history must not turn an
 * unknown mode into a known one.
 */
export function asTokenProxyRequestMode(value: unknown): TokenProxyRequestMode | null {
	return value === 'passthrough' || value === 'compress' || value === 'compress-early'
		? value
		: null;
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
 * The internal setting that names the proxy default the agents last followed.
 * When `defaultTokenProxyMode` differs from it, the agents still on the old
 * default are moved to the new one, then it is written. Absent on an install
 * that has never synced: the first sync records the default and moves nobody.
 */
export const TOKEN_PROXY_DEFAULT_APPLIED_SETTING = 'tokenProxyDefaultApplied';

/**
 * Whether an agent's stored routing is what a proxy default of `mode` gives it,
 * so it follows that default rather than overriding it. Off: no gateway at all
 * (a gateway of the user's own is a choice, not the default). Any other mode:
 * the gateway is the proxy and the stored mode is `mode`. Says nothing about
 * whether the agent CAN use the proxy; the caller checks that first.
 */
export function followsTokenProxyDefault(
	agent: { gatewayUrl?: string | null; tokenProxyMode?: unknown },
	mode: TokenProxyMode,
	port: number | null
): boolean {
	if (mode === 'off') return !agent.gatewayUrl?.trim();
	return (
		resolveTokenProxyMode({
			gatewayUrl: agent.gatewayUrl,
			storedMode: agent.tokenProxyMode,
			port,
		}) === mode
	);
}

/**
 * Which route an agent's traffic takes through the proxy, or null with the
 * reason when it cannot use the proxy at all. `env` is the agent's effective
 * environment (`resolveAgentEnvironment`): Codex with an API key talks to
 * api.openai.com, and with a ChatGPT login to a different host. `model` is the
 * agent's model (its own, or the provider default): OpenCode's route is the
 * provider its model names (`anthropic/...`, `openai/...`).
 */
export function tokenProxyRouteForAgent(
	toolType: string,
	env: Record<string, string>,
	model?: string
): { ok: true; route: TokenProxyRouteId } | { ok: false; error: string } {
	const support = agentGatewaySupport(toolType);
	if (!support.supported) return { ok: false, error: support.reason };
	if (toolType === 'claude-code') return { ok: true, route: 'anthropic' };
	if (toolType === 'codex') {
		const apiKey = classifyCredentialKind(toolType, env).kind === 'api-key';
		return { ok: true, route: apiKey ? 'openai' : 'chatgpt' };
	}
	if (toolType === 'opencode') {
		const provider = model?.trim().split('/')[0] ?? '';
		if (provider === 'anthropic') return { ok: true, route: 'anthropic' };
		if (provider === 'openai') return { ok: true, route: 'openai' };
		return {
			ok: false,
			error:
				provider === ''
					? `${TOKEN_PROXY_NAME} carries OpenCode only for an anthropic/... or openai/... model, and this agent names none. Set its model first.`
					: `${TOKEN_PROXY_NAME} carries OpenCode only for an anthropic/... or openai/... model, not "${model?.trim()}".`,
		};
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
	/**
	 * What the proxy could have shortened and did not. Separate from `usage` on
	 * purpose: `usage` is what was removed from requests, this is a measurement
	 * of text that was never sent, and the two are never added. Absent from an
	 * older desktop.
	 */
	readOpportunities?: TokenProxyReadOpportunities;
	/**
	 * The originals read back since the app started, by caller. Process lifetime,
	 * not a time range: it is kept apart from `usage` on purpose, and never added to
	 * it or subtracted from a saving there. Absent from an older desktop.
	 */
	recovery?: TokenProxyRecoveryObservations;
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
 *
 * The four numbers are always present for compatibility, and a class the answer
 * did not name is 0. `reportedness` says which numbers the provider gave: the
 * response reader always sets it. It is optional for usage built elsewhere (a
 * test fixture), and readers then treat every class as unknown (see
 * `proxyProviderClassReading()`).
 */
export interface TokenProxyProviderUsage {
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	reportedness?: ProxyProviderReportedness;
}

// ---------------------------------------------------------------------------
// Read opportunities: what the proxy could have shortened, and did not
// ---------------------------------------------------------------------------

/**
 * What a preview could remove from the text it would stand in for. It measures
 * text that was never sent, so `realized` is always false and no field is
 * named as a saving.
 */
export interface TokenProxyPotentialReduction {
	kind: 'potential-reduction';
	/** Always false: nothing here changed a request or reached a model. */
	realized: false;
	/** The re-read exactly as the agent sent it, before any compression the proxy applies. */
	basis: 'text-as-sent';
	tokenCountKind: 'character-estimate';
	fullChars: number;
	fullTokens: number;
	/** The whole preview text: its markers, hunk headers and lines. */
	previewChars: number;
	previewTokens: number;
	reducibleChars: number;
	reducibleTokens: number;
}

/**
 * Said wherever a read-opportunity figure is shown. A re-read preview and a
 * source outline can describe the same result, so their figures are
 * alternatives and are never added to each other or to tokens saved.
 */
export const TOKEN_PROXY_OPPORTUNITY_NOTE =
	'Observation only. Each figure compares the newest tool results the agent sent with a preview that was never applied. These previews changed no request and nothing was saved by them. Actual proxy compression is measured separately and may overlap these estimates. A re-read preview and a source outline can describe the same result: their figures are alternatives, not a sum. Token counts are estimates at 4 characters per token.';

export type TokenProxyOpportunityKind = 'unchanged-read' | 'read-delta' | 'code-outline';

export const TOKEN_PROXY_OPPORTUNITY_KIND_LABELS: Record<TokenProxyOpportunityKind, string> = {
	'unchanged-read': 'Unchanged re-read',
	'read-delta': 'Changed re-read',
	'code-outline': 'Source outline',
};

/** Why a request the proxy read was not examined for opportunities. */
export type TokenProxyObservationSkip =
	| 'busy'
	| 'too-large'
	| 'unreadable'
	| 'no-workspace'
	| 'failed';

export const TOKEN_PROXY_OBSERVATION_SKIP_LABELS: Record<TokenProxyObservationSkip, string> = {
	busy: 'an earlier request was still being examined',
	'too-large': 'the body is past the examination limit',
	unreadable: 'the body is not a message list the proxy can read',
	'no-workspace': 'the agent has no working directory to place a file under',
	failed: 'the examination failed (reported; the request was not affected)',
};

/**
 * Identity the proxy cannot see. It knows an agent from the gateway URL it was
 * given and a request body, and neither names a tab, a native session, a
 * subagent or a context window. Nothing is attributed or remembered by them.
 */
export const TOKEN_PROXY_UNAVAILABLE_IDENTITY = [
	'tab',
	'native-session',
	'subagent',
	'window',
] as const;

export type TokenProxyUnavailableIdentity = (typeof TOKEN_PROXY_UNAVAILABLE_IDENTITY)[number];

/** One preview the proxy built and did not use. It holds lines of a file. */
export interface TokenProxyOpportunity {
	kind: TokenProxyOpportunityKind;
	/** Epoch ms the request was examined. */
	observedAt: number;
	/** From the base URL the agent was given; null for a request that named no agent. */
	agentId: string | null;
	route: string;
	requestKind: TokenProxyRequestKind;
	tool: string | null;
	/** The tool call whose result a stand-in would replace. */
	callId: string | null;
	path: string;
	/** Leading hex of the SHA-256 of the exact text the agent sent. */
	sourceHash: string;
	/** The earlier read a re-read repeats. Null for an outline. */
	baseline: { callId: string | null; hash: string } | null;
	/** How the baseline counted as visible to the model. Null for an outline, which needs none. */
	baselineBasis: 'same-request-delivered-whole' | null;
	/** What the model was shown for the result itself. `replaced` means the proxy shortened it too, so the figures overlap. */
	delivery: 'whole' | 'replaced' | 'unproven';
	potential: TokenProxyPotentialReduction;
	/** The grammar behind an outline. Null for a re-read. */
	parser: { name: string; dialect: string | null } | null;
	/** Lines a delta adds and removes. Null for any other kind. */
	changes: { hunks: number; added: number; removed: number } | null;
	/** What a stand-in would carry: secrets redacted, cut at a line break for display. */
	text: string;
	/** Length of the preview before redaction and cutting. */
	textChars: number;
	/** Whether `text` is shorter than the preview. */
	cut: boolean;
	/** Whether a secret-shaped span was replaced in `text`. */
	redacted: boolean;
}

/** Reads among the newest tool results, as the analyzer related them. */
export type TokenProxyOpportunityReads = {
	examined: number;
	first: number;
	identical: number;
	changed: number;
	unsupported: number;
	unsupportedByReason: Record<string, number>;
};

/** Re-reads that could stand as a one-line marker or a small delta. */
export type TokenProxyOpportunityPreviews = {
	examined: number;
	unchanged: number;
	delta: number;
	unsupported: number;
	unsupportedByReason: Record<string, number>;
	potentialChars: number;
	potentialTokens: number;
};

/** Source files that could stand as an outline. An alternative to a re-read preview for the same result. */
export type TokenProxyOpportunityOutlines = {
	examined: number;
	outlined: number;
	unsupported: number;
	unsupportedByReason: Record<string, number>;
	potentialChars: number;
	potentialTokens: number;
};

/**
 * The read opportunities the proxy observed since the app started: phase 04's
 * analyzer, re-read previews and source outlines, run over requests the proxy
 * already reads (an agent in a compressing mode) and kept as fixed-size
 * tallies and a short list of recent previews. Nothing here is persisted,
 * applied, or part of any realized figure.
 */
export interface TokenProxyReadOpportunities {
	version: 1;
	mode: 'observation';
	note: typeof TOKEN_PROXY_OPPORTUNITY_NOTE;
	/** Always false: every figure measures text that was not sent. */
	realized: false;
	tokenCountKind: 'character-estimate';
	/** Epoch ms the tallies began: the app's start. */
	since: number;
	coverage: {
		scope: 'process-lifetime';
		/** Which results of a request are counted: those at its end, which it adds to the history. */
		attribution: 'newest-tool-results';
		/** Requests examined. A passthrough request is streamed unread and is never one. */
		observed: number;
		/** Examined requests with a read among their newest results. */
		withReads: number;
		/** Examined requests where a work bound left reads unexamined. */
		incomplete: number;
		/** Requests the proxy read but did not examine. */
		skipped: Record<TokenProxyObservationSkip, number>;
	};
	identity: {
		known: ['agent'];
		unavailable: TokenProxyUnavailableIdentity[];
		note: string;
	};
	/** The bounds in force, so a refusal or a skip can be explained. */
	limits: {
		bodyChars: number;
		readsPerRequest: number;
		previewPairs: number;
		outlineSources: number;
		recentPreviews: number;
		previewTextChars: number;
	};
	reads: TokenProxyOpportunityReads;
	previews: TokenProxyOpportunityPreviews;
	outlines: TokenProxyOpportunityOutlines;
	/** The newest previews, newest first. */
	recent: TokenProxyOpportunity[];
}

/** `partial-range 3, outside-workspace 5`, most frequent first. Empty when there are none. */
export function describeOpportunityReasons(reasons: Record<string, number>): string {
	return Object.entries(reasons)
		.filter(([, count]) => count > 0)
		.sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
		.map(([reason, count]) => `${reason} ${formatCount(count)}`)
		.join(', ');
}

// ---------------------------------------------------------------------------
// Telemetry vocabulary: what a request's row says, and how sure each number is
// ---------------------------------------------------------------------------

/**
 * Why compress mode forwarded a request's body without reading it: the values
 * `ProxyRequest.skipReason` holds. The server's log names them as
 * `TokenProxyCompressionSkip`, so a new reason reaches the row, the labels
 * below and the report together.
 */
export const TOKEN_PROXY_SKIP_REASONS = ['encoding', 'not-text', 'too-large', 'failed'] as const;
export type TokenProxySkipReason = (typeof TOKEN_PROXY_SKIP_REASONS)[number];

export const TOKEN_PROXY_SKIP_LABELS: Record<TokenProxySkipReason, string> = {
	encoding: 'a content encoding the proxy cannot decode',
	'not-text': 'a body that is not UTF-8 text',
	'too-large': 'a body past the read limit',
	failed: 'decoding or compressing failed, and the original was forwarded',
};

/** The skip reason a stored string names, or null for a value this build does not know. */
export function asTokenProxySkipReason(value: unknown): TokenProxySkipReason | null {
	return (TOKEN_PROXY_SKIP_REASONS as readonly unknown[]).includes(value)
		? (value as TokenProxySkipReason)
		: null;
}

export const TOKEN_PROXY_EVIDENCE_LABELS: Record<ProxyEvidenceKind, string> = {
	measured: 'measured',
	estimate: 'estimate',
	opportunity: 'opportunity, not applied',
};

export const TOKEN_PROXY_EVIDENCE_NOTES: Record<ProxyEvidenceKind, string> = {
	measured: 'Counted by Maestro on a request, or reported by the provider.',
	estimate: 'Characters divided by 4, on text the proxy read. Not a count a provider billed.',
	opportunity: 'What a preview showed could be removed. Nothing was removed and nothing was saved.',
};

/** Said wherever figures of more than one kind are shown together. */
export const TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE =
	'Measured counts, estimates and opportunities are different kinds of figure. They are shown apart and never added into one savings number.';

export const TOKEN_PROXY_UNKNOWN_LABELS: Record<ProxyUnknownReason, string> = {
	'not-recorded': 'not recorded (the request predates this measure)',
	'not-read': 'not read (the proxy did not read the body)',
	'not-observed': 'not observed (it happened where Maestro cannot see)',
	'insufficient-samples': 'too few samples to report',
	'on-demand-only': 'computed only on request, for one tab',
	'identity-unavailable': 'needs an identity the proxy cannot see',
	'not-evaluated': 'not evaluated',
};

/**
 * The fewest requests with a processing time from which a range shows a latency
 * distribution. A display policy, not a statistical guarantee: 30 samples do not
 * make p95 or p99 stable. A distribution drawn from fewer is withheld as
 * `insufficient-samples` (the count is still reported), so that a handful of
 * requests is not drawn as a tail.
 */
export const PROXY_LATENCY_MIN_SAMPLES = 30;

/** A figure with no value. Unknown is never zero. */
export function unknownProxyFigure<K extends ProxyEvidenceKind>(
	kind: K,
	unit: ProxyFigureUnit,
	unknown: ProxyUnknownReason
): ProxyFigure<K> {
	return { kind, unit, value: null, unknown };
}

/**
 * A figure with a value. A range in which no request supplied the value has no
 * value: the figure comes back unknown, for `whenNone`, instead of a zero (or a
 * division by it). A value that is not a finite number, or a count that exceeds
 * its range, is a bug in the caller and throws.
 */
export function proxyFigure<K extends ProxyEvidenceKind>(
	kind: K,
	unit: ProxyFigureUnit,
	value: number,
	coverage: ProxyCoverage,
	whenNone: ProxyUnknownReason
): ProxyFigure<K> {
	if (!Number.isFinite(value)) {
		throw new RangeError(`A ${kind} figure needs a finite number, not ${value}.`);
	}
	if (coverage.scope === 'range') {
		const { counted, of } = coverage;
		if (
			!Number.isSafeInteger(counted) ||
			!Number.isSafeInteger(of) ||
			counted < 0 ||
			counted > of
		) {
			throw new RangeError(`Coverage needs 0 <= counted <= of, not ${counted} of ${of}.`);
		}
		if (counted === 0) return unknownProxyFigure(kind, unit, whenNone);
	}
	return { kind, unit, value, coverage };
}

/**
 * Add two figures of the same kind and unit: the one way to total figures. A
 * figure of another kind or unit throws, because the sum would be a number that
 * means nothing (an estimate plus an opportunity is not a saving). An unknown
 * operand makes the sum unknown. Coverage adds with the values; a range cannot
 * be added to the process lifetime.
 */
export function addProxyFigures<K extends ProxyEvidenceKind>(
	a: ProxyFigure<K>,
	b: ProxyFigure<K>
): ProxyFigure<K> {
	if (a.kind !== b.kind) {
		throw new TypeError(`Figures of different kinds cannot be added: ${a.kind} and ${b.kind}.`);
	}
	if (a.unit !== b.unit) {
		throw new TypeError(`Figures in different units cannot be added: ${a.unit} and ${b.unit}.`);
	}
	if (a.value === null) return a;
	if (b.value === null) return b;
	const value = a.value + b.value;
	const left = a.coverage;
	const right = b.coverage;
	if (left.scope === 'range' && right.scope === 'range') {
		return {
			kind: a.kind,
			unit: a.unit,
			value,
			coverage: {
				scope: 'range',
				counted: left.counted + right.counted,
				of: left.of + right.of,
			},
		};
	}
	if (left.scope === 'process-lifetime' && right.scope === 'process-lifetime') {
		const since =
			left.since !== undefined && right.since !== undefined
				? Math.min(left.since, right.since)
				: undefined;
		return {
			kind: a.kind,
			unit: a.unit,
			value,
			coverage:
				since === undefined ? { scope: 'process-lifetime' } : { scope: 'process-lifetime', since },
		};
	}
	throw new TypeError('A figure for a range cannot be added to one for the process lifetime.');
}

/**
 * The first rule a request's block counts break, or null when they hold or are
 * absent (absent is unknown, which breaks nothing). It checks that every count
 * is a non-negative integer, that `candidates` equals `belowThreshold +
 * storeFailed + kept + blocksCompressed`, and that `cacheHits` and `modelFailed`
 * do not exceed the blocks decided (`kept + blocksCompressed`). It does not
 * check what the producer derives the recognized total from (`protected +
 * vetoed.* + candidates`), because no independent total is stored. A writer that
 * finds a problem stores no counts at all: counts that disagree are worse than
 * none.
 */
export function proxyBlockCountsProblem(
	request: Pick<ProxyRequest, 'blockCounts' | 'blocksCompressed' | 'cacheHits'>
): string | null {
	const counts = request.blockCounts;
	if (counts === undefined) return null;
	const { vetoed, ...own } = counts;
	const all = [
		...Object.values(own),
		...Object.values(vetoed),
		request.blocksCompressed,
		request.cacheHits,
	];
	if (!all.every((count) => Number.isSafeInteger(count) && count >= 0)) {
		return 'Every count must be a non-negative integer.';
	}
	const shortened = request.blocksCompressed;
	if (counts.candidates !== counts.belowThreshold + counts.storeFailed + counts.kept + shortened) {
		return 'candidates must equal belowThreshold + storeFailed + kept + blocksCompressed.';
	}
	const decided = counts.kept + shortened;
	if (request.cacheHits > decided) return 'cacheHits cannot exceed kept + blocksCompressed.';
	if (counts.modelFailed > decided) return 'modelFailed cannot exceed kept + blocksCompressed.';
	return null;
}

/**
 * What one stored provider count is, as a reader may use it:
 *
 * - a {@link ProxyProviderClassStatus}: the row records how the class got its
 *   number.
 * - `legacy`: the row has provider numbers and no record of how they were
 *   given, because it was written before that was tracked. A class the answer
 *   never named reads as 0 in it, so no class is claimed as reported.
 * - `absent`: the row has no provider usage at all (the answer named none, or a
 *   background target answered).
 */
export type ProxyProviderClassReading = ProxyProviderClassStatus | 'legacy' | 'absent';

export const TOKEN_PROXY_PROVIDER_CLASS_LABELS: Record<ProxyProviderClassReading, string> = {
	reported: 'reported by the provider',
	derived: 'derived from what the provider reported',
	'not-applicable': 'not a class this provider has (zero by definition)',
	unreported: 'not reported in the answer (unknown, not zero)',
	legacy: 'recorded before reporting was tracked (unknown)',
	absent: 'the answer named no usage (unknown)',
};

const PROVIDER_COUNT_FIELD = {
	input: 'providerInputTokens',
	cacheRead: 'providerCacheReadTokens',
	cacheWrite: 'providerCacheWriteTokens',
	output: 'providerOutputTokens',
} as const satisfies Record<ProxyProviderUsageClass, keyof ProxyRequest>;

/**
 * How a row's provider count for one class got its number. Every reader of a
 * stored provider number goes through this, because the number alone cannot
 * tell a zero the provider reported from a default for a class it never named.
 */
export function proxyProviderClassReading(
	row: Pick<ProxyRequest, (typeof PROVIDER_COUNT_FIELD)[ProxyProviderUsageClass]> &
		Pick<ProxyRequest, 'providerUsageReportedness'>,
	usageClass: ProxyProviderUsageClass
): ProxyProviderClassReading {
	const named = Object.values(PROVIDER_COUNT_FIELD).some((field) => row[field] !== undefined);
	if (!named) return 'absent';
	return row.providerUsageReportedness?.[usageClass] ?? 'legacy';
}

/** Whether a reading's number says something: reported, derived, or zero by definition. */
export function proxyProviderClassHasValue(reading: ProxyProviderClassReading): boolean {
	return reading === 'reported' || reading === 'derived' || reading === 'not-applicable';
}

/**
 * Who called the canonical block reader (`readTokenProxyBlock`), as far as the
 * code can tell.
 *
 * - `mcpRetrieveTool`: the MCP handler answering a call of
 *   `retrieve_compressed_original`.
 * - `otherReads`: every other call. That is the Gateway section's inspection,
 *   `maestro-cli models proxy block`, and any programmatic read. The actor is
 *   unknown: an agent can run the CLI as well as a person can, so these reads
 *   are not human activity.
 */
export type TokenProxyRecoveryCaller = 'mcpRetrieveTool' | 'otherReads';

/**
 * The eight counters of the canonical block reader, for every caller together
 * or for one caller. Each saturates at the largest safe integer.
 */
export interface TokenProxyRecoveryReadCounts {
	/** Reads whose hash and range passed validation. */
	invocations: number;
	/** Reads that asked for a line range. */
	rangedInvocations: number;
	/** Reads that returned original text. */
	recoveredOriginals: number;
	/** Reads of a hash with no compressed verdict: never shortened, kept whole, or unknown. */
	unavailableBlocks: number;
	/** Reads of a shortened block whose original text is no longer stored. */
	missingOriginals: number;
	/** Reads that failed in the archive and rethrew. */
	failedReads: number;
	/** UTF-8 bytes of the original text returned. */
	returnedOriginalBytes: number;
	returnedOriginalTokenEstimate: number;
}

/**
 * What the canonical block reader (`readTokenProxyBlock`) has returned since
 * the app started: a snapshot of saturating counters and what they leave
 * unknown. Process lifetime, not a time range, and in memory only.
 *
 * The counters on this object count every caller together, as they always did.
 * `byCaller` holds the same eight counters for each caller the code can tell
 * apart (`TokenProxyRecoveryCaller`). Until a counter saturates, each total is
 * the sum of its two parts. For the retrieve tool, `recoveredOriginals` is the
 * number of calls it answered with original text (a range past the end of the
 * original has no lines and counts as zero bytes), and the returned bytes are
 * the size of that text (the one-line header the tool adds is not counted).
 * The tool always sends a line range, so its `rangedInvocations` equals its
 * `invocations`.
 *
 * Bytes and counts are measured. `returnedOriginalTokenEstimate` is an estimate
 * (`tokenCountKind`). Returned archive text is not proof that a model received
 * it: `modelExposure` and `unobservedRetrievals` say so, and a tool response the
 * handler served is not proof that the model read it. `cliInvocations` is null
 * because the CLI is not told apart from other reads. Forwarding historical
 * tool text never increments a counter (`ProxyVetoCounts.retrieval` counts
 * retrieved text carried forward in history).
 */
export interface TokenProxyRecoveryObservations extends TokenProxyRecoveryReadCounts {
	scope: 'process-lifetime';
	coverage: 'canonical-block-reader';
	tokenCountKind: 'character-estimate';
	cliInvocations: null;
	modelExposure: 'unknown';
	unobservedRetrievals: 'unknown';
	/** The eight counters again, by caller. Independent copies of the live tallies. */
	byCaller: Record<TokenProxyRecoveryCaller, TokenProxyRecoveryReadCounts>;
	/** A counter, in the total or in either caller's part, reached the largest safe integer. */
	saturated: boolean;
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
