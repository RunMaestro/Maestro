/**
 * Local Models endpoints: model servers the USER runs, which Maestro talks to.
 *
 * The other kind of model source is a download (see `model-catalog.ts`): bytes
 * Maestro fetches, verifies, and loads itself. An endpoint is the opposite. It is
 * an already-running server (Ollama, LM Studio, or any OpenAI-compatible base URL
 * such as a LiteLLM or vLLM host) that serves text generation and embeddings with
 * nothing to download. Many users already run one, which makes it the cheapest
 * route to a working local model.
 *
 * The configured list is persisted under the `localModelEndpoints` setting.
 * Everything here is pure so the renderer, the main process, and the CLI all
 * validate an endpoint by the same rules.
 */

import { isBlankEnvValue, isValidEnvVarName } from '../agentEnvironment';
import {
	isModelServerEndpointRef,
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_NAME,
} from './model-server';

/**
 * Which wire dialect the server speaks. All three serve `/v1/chat/completions`;
 * they differ in how models are listed (`/api/tags` for Ollama, `/v1/models` for
 * the others) and in the extras a client may fall back to.
 */
export type LocalModelEndpointKind = 'ollama' | 'lmstudio' | 'openai-compatible';

export const LOCAL_MODEL_ENDPOINT_KINDS: readonly LocalModelEndpointKind[] = [
	'ollama',
	'lmstudio',
	'openai-compatible',
];

/** Where each local server listens out of the box. `openai-compatible` has no default. */
export const DEFAULT_ENDPOINT_BASE_URLS: Readonly<Partial<Record<LocalModelEndpointKind, string>>> =
	{
		ollama: 'http://127.0.0.1:11434',
		lmstudio: 'http://127.0.0.1:1234',
	};

/** What each kind is called in front of a person, and the name a detected server is offered under. */
export const LOCAL_MODEL_ENDPOINT_KIND_LABELS: Readonly<Record<LocalModelEndpointKind, string>> = {
	ollama: 'Ollama',
	lmstudio: 'LM Studio',
	'openai-compatible': 'OpenAI-compatible',
};

export interface LocalModelEndpoint {
	/** Stable id, assigned when the endpoint is added. Never derived from the URL. */
	id: string;
	/** What the user calls it ("Ollama on the workstation"). */
	name: string;
	kind: LocalModelEndpointKind;
	/** Scheme, host, optional port and path prefix. Stored without a trailing slash. */
	baseUrl: string;
	/**
	 * The NAME of an environment variable holding the API key, never the key.
	 *
	 * Settings are a plain JSON file that ends up in debug packages, backups, and
	 * `maestro-cli settings list`, so a secret written into an endpoint record
	 * would leak through every one of them. Instead the key lives where the user
	 * already keeps secrets, the global Settings -> Environment layer
	 * (`shellEnvVars`), and is looked up by name at call time with
	 * {@link resolveEndpointApiKey}. Rotating a key is then one edit in one place,
	 * and a key the user removes stops being sent on the next request.
	 */
	apiKeyEnvVar?: string;
	/** A disabled endpoint stays configured but is never called. */
	enabled: boolean;
}

export type LocalModelEndpointField =
	| 'id'
	| 'name'
	| 'kind'
	| 'baseUrl'
	| 'apiKeyEnvVar'
	| 'enabled';

export interface LocalModelEndpointIssue {
	field: LocalModelEndpointField;
	message: string;
}

export type LocalModelEndpointValidation =
	| { ok: true; endpoint: LocalModelEndpoint }
	| { ok: false; issues: LocalModelEndpointIssue[] };

export function isLocalModelEndpointKind(value: unknown): value is LocalModelEndpointKind {
	return (
		typeof value === 'string' && (LOCAL_MODEL_ENDPOINT_KINDS as readonly string[]).includes(value)
	);
}

/**
 * Why a base URL is unusable, or `null` when it is fine.
 *
 * Only http and https are accepted: anything else is not a model server. A URL
 * carrying `user:password@` is refused outright rather than stripped, because the
 * credentials would be persisted to settings in the clear, which is the exact
 * leak `apiKeyEnvVar` exists to prevent. Query strings and fragments are refused
 * too: the client appends paths like `/v1/models` to the base, and a `?` or `#`
 * in the middle would swallow them.
 */
export function endpointBaseUrlProblem(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === '') return 'Base URL is required.';
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return `"${trimmed}" is not a valid URL.`;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return `Only http and https URLs are supported (got "${url.protocol.replace(/:$/, '')}").`;
	}
	if (url.hostname === '') return 'Base URL has no host.';
	if (url.username !== '' || url.password !== '') {
		return 'Do not put credentials in the URL. Name an environment variable for the API key instead.';
	}
	if (url.search !== '' || url.hash !== '') {
		return 'Base URL must not contain a query string or fragment.';
	}
	return null;
}

/**
 * Canonical spelling of a valid base URL: trimmed, no trailing slash, so
 * `${baseUrl}/v1/models` never produces a double slash. Call only after
 * {@link endpointBaseUrlProblem} returned `null`.
 */
export function normalizeEndpointBaseUrl(raw: string): string {
	const url = new URL(raw.trim());
	const path = url.pathname.replace(/\/+$/, '');
	return `${url.protocol}//${url.host}${path}`;
}

/**
 * Validate one endpoint record, returning a normalized copy when it is valid.
 * Every problem is reported at once so a form can mark all bad fields together.
 */
export function validateLocalModelEndpoint(value: unknown): LocalModelEndpointValidation {
	const issues: LocalModelEndpointIssue[] = [];
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { ok: false, issues: [{ field: 'id', message: 'Endpoint must be an object.' }] };
	}
	const record = value as Record<string, unknown>;

	const id = typeof record.id === 'string' ? record.id.trim() : '';
	if (id === '') issues.push({ field: 'id', message: 'Endpoint id is required.' });

	const name = typeof record.name === 'string' ? record.name.trim() : '';
	if (name === '') issues.push({ field: 'name', message: 'Endpoint name is required.' });

	if (!isLocalModelEndpointKind(record.kind)) {
		issues.push({
			field: 'kind',
			message: `Kind must be one of: ${LOCAL_MODEL_ENDPOINT_KINDS.join(', ')}.`,
		});
	}

	const rawUrl = typeof record.baseUrl === 'string' ? record.baseUrl : '';
	const urlProblem = endpointBaseUrlProblem(rawUrl);
	if (urlProblem) issues.push({ field: 'baseUrl', message: urlProblem });

	let apiKeyEnvVar: string | undefined;
	if (record.apiKeyEnvVar !== undefined && record.apiKeyEnvVar !== null) {
		const envName = typeof record.apiKeyEnvVar === 'string' ? record.apiKeyEnvVar.trim() : '';
		if (envName === '') {
			apiKeyEnvVar = undefined;
		} else if (!isValidEnvVarName(envName)) {
			issues.push({
				field: 'apiKeyEnvVar',
				message: `"${envName}" is not a valid environment variable name.`,
			});
		} else {
			apiKeyEnvVar = envName;
		}
	}

	if (typeof record.enabled !== 'boolean') {
		issues.push({ field: 'enabled', message: 'Enabled must be true or false.' });
	}

	if (issues.length > 0) return { ok: false, issues };
	return {
		ok: true,
		endpoint: {
			id,
			name,
			kind: record.kind as LocalModelEndpointKind,
			baseUrl: normalizeEndpointBaseUrl(rawUrl),
			...(apiKeyEnvVar ? { apiKeyEnvVar } : {}),
			enabled: record.enabled as boolean,
		},
	};
}

/**
 * Read the persisted `localModelEndpoints` setting. Anything that is not a list
 * reads as empty, invalid records are dropped, and a repeated id keeps its first
 * record, so a hand-edited settings file cannot hand a caller an endpoint it
 * would refuse to save. That includes a record claiming the Maestro model
 * server's id, which is built in and never saved.
 */
export function parseLocalModelEndpoints(value: unknown): LocalModelEndpoint[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const endpoints: LocalModelEndpoint[] = [];
	for (const entry of value) {
		const result = validateLocalModelEndpoint(entry);
		if (!result.ok || seen.has(result.endpoint.id)) continue;
		if (result.endpoint.id === MODEL_SERVER_ENDPOINT_ID) continue;
		seen.add(result.endpoint.id);
		endpoints.push(result.endpoint);
	}
	return endpoints;
}

/**
 * The API key for an endpoint, read at call time from Settings -> Environment.
 * `undefined` when the endpoint names no variable, or the variable is missing or
 * blank (a blank value means "unset" everywhere in Maestro; see
 * `isBlankEnvValue`). The caller decides whether a missing key is an error: a
 * local Ollama needs none.
 */
export function resolveEndpointApiKey(
	endpoint: Pick<LocalModelEndpoint, 'apiKeyEnvVar'>,
	shellEnvVars: Record<string, string> | undefined
): string | undefined {
	if (!endpoint.apiKeyEnvVar) return undefined;
	const value = shellEnvVars?.[endpoint.apiKeyEnvVar];
	if (value === undefined || isBlankEnvValue(value)) return undefined;
	return value.trim();
}

/**
 * Whether a source serves the Anthropic Messages route (`/v1/messages`) beside
 * its OpenAI routes. The record's `kind` is the mark: the Maestro model server
 * (llama-server) and Ollama were measured with Claude Code on that route, and
 * LM Studio documents it. An `openai-compatible` source is a base URL and
 * nothing else, so Maestro cannot tell, and a caller that must send that route
 * (the token proxy's background routing) refuses it by name.
 */
export function endpointServesAnthropicMessages(
	endpoint: Pick<LocalModelEndpoint, 'id' | 'kind'>
): boolean {
	return (
		endpoint.id === MODEL_SERVER_ENDPOINT_ID ||
		endpoint.kind === 'ollama' ||
		endpoint.kind === 'lmstudio'
	);
}

/** Every spelling of "this machine" a base URL can carry. `URL` keeps IPv6 hosts bracketed. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a base URL points at this machine. Detection only ever probes URLs
 * that pass this, so an auto-detect can never reach out to the network.
 */
export function isLoopbackEndpointUrl(baseUrl: string): boolean {
	try {
		return LOOPBACK_HOSTNAMES.has(new URL(baseUrl).hostname.toLowerCase());
	} catch {
		return false;
	}
}

/**
 * Whether two base URLs name the same server: same scheme, port, and path, and
 * the same host, where every loopback spelling counts as one host. A user who
 * configured `http://localhost:11434` must not be offered `http://127.0.0.1:11434`
 * as a newly detected Ollama.
 */
export function isSameEndpointServer(a: string, b: string): boolean {
	let left: URL;
	let right: URL;
	try {
		left = new URL(a.trim());
		right = new URL(b.trim());
	} catch {
		return false;
	}
	const hostOf = (url: URL) => {
		const host = url.hostname.toLowerCase();
		return LOOPBACK_HOSTNAMES.has(host) ? 'loopback' : host;
	};
	const pathOf = (url: URL) => url.pathname.replace(/\/+$/, '');
	return (
		left.protocol === right.protocol &&
		left.port === right.port &&
		hostOf(left) === hostOf(right) &&
		pathOf(left) === pathOf(right)
	);
}

export type LocalModelEndpointLookup =
	| { ok: true; endpoint: LocalModelEndpoint }
	| { ok: false; message: string };

/**
 * Find a configured endpoint the way a person names one: an exact id, a unique
 * id prefix (the CLI prints ids in full but nobody retypes a UUID), or a unique
 * name, case-insensitively. An ambiguous reference is refused with the
 * candidates listed rather than resolved to whichever came first, because the
 * callers remove and test endpoints, and the wrong one is a silent mistake.
 */
export function findLocalModelEndpoint(
	endpoints: readonly LocalModelEndpoint[],
	ref: string
): LocalModelEndpointLookup {
	const needle = ref.trim();
	if (needle === '') return { ok: false, message: 'Name an endpoint by id or name.' };
	const exact = endpoints.find((endpoint) => endpoint.id === needle);
	if (exact) return { ok: true, endpoint: exact };

	const byPrefix = endpoints.filter((endpoint) => endpoint.id.startsWith(needle));
	const lowered = needle.toLowerCase();
	const byName = endpoints.filter((endpoint) => endpoint.name.toLowerCase() === lowered);
	const matches = [...new Set([...byPrefix, ...byName])];
	if (matches.length === 1) return { ok: true, endpoint: matches[0] };
	if (matches.length === 0) return { ok: false, message: `No endpoint matches "${needle}".` };
	return {
		ok: false,
		message: `"${needle}" matches ${matches.length} endpoints: ${matches
			.map((endpoint) => `${endpoint.name} (${endpoint.id})`)
			.join(', ')}. Use the full id.`,
	};
}

export type LocalModelEndpointListChange =
	| { ok: true; endpoints: LocalModelEndpoint[]; endpoint: LocalModelEndpoint }
	| { ok: false; message: string };

/**
 * The refusal for any edit of the Maestro model server through the endpoint
 * list: it is built in, and only its own card and `maestro-cli models server`
 * control it.
 */
function builtInServerRefusal(action: 'add' | 'edit' | 'remove'): LocalModelEndpointListChange {
	const what =
		action === 'add'
			? `The id "${MODEL_SERVER_ENDPOINT_ID}" belongs to the ${MODEL_SERVER_NAME}`
			: `The ${MODEL_SERVER_NAME} is built in and cannot be ${action === 'edit' ? 'edited' : 'removed'} here`;
	return {
		ok: false,
		message: `${what}. Control it from the Model server card, or with maestro-cli models server.`,
	};
}

/**
 * Append an endpoint to the configured list. The candidate goes through the
 * same validator the setting is read with, and it is refused when its id is
 * taken or when the same server is already configured under another name
 * (every loopback spelling counts as one host, see {@link isSameEndpointServer}),
 * since two records for one server only split its settings in two.
 */
export function addLocalModelEndpoint(
	endpoints: readonly LocalModelEndpoint[],
	candidate: unknown
): LocalModelEndpointListChange {
	const validation = validateLocalModelEndpoint(candidate);
	if (!validation.ok) {
		return { ok: false, message: validation.issues.map((issue) => issue.message).join(' ') };
	}
	const endpoint = validation.endpoint;
	if (endpoint.id === MODEL_SERVER_ENDPOINT_ID) return builtInServerRefusal('add');
	if (endpoints.some((existing) => existing.id === endpoint.id)) {
		return { ok: false, message: `An endpoint with id "${endpoint.id}" already exists.` };
	}
	const sameServer = endpoints.find((existing) =>
		isSameEndpointServer(existing.baseUrl, endpoint.baseUrl)
	);
	if (sameServer) {
		return {
			ok: false,
			message: `${endpoint.baseUrl} is already configured as "${sameServer.name}" (${sameServer.id}).`,
		};
	}
	return { ok: true, endpoints: [...endpoints, endpoint], endpoint };
}

/**
 * Replace one configured endpoint, keeping its id and its place in the list.
 * The edit goes through the same validator as {@link addLocalModelEndpoint},
 * and it is refused when the new base URL names a server ANOTHER record
 * already holds; the record's own URL never conflicts with itself, so renaming
 * or toggling `enabled` always passes.
 */
export function updateLocalModelEndpoint(
	endpoints: readonly LocalModelEndpoint[],
	id: string,
	candidate: unknown
): LocalModelEndpointListChange {
	if (id === MODEL_SERVER_ENDPOINT_ID) return builtInServerRefusal('edit');
	const index = endpoints.findIndex((endpoint) => endpoint.id === id);
	if (index === -1) return { ok: false, message: `No endpoint has id "${id}".` };
	const validation = validateLocalModelEndpoint({
		...(typeof candidate === 'object' && candidate !== null ? candidate : {}),
		id,
	});
	if (!validation.ok) {
		return { ok: false, message: validation.issues.map((issue) => issue.message).join(' ') };
	}
	const endpoint = validation.endpoint;
	const sameServer = endpoints.find(
		(existing) => existing.id !== id && isSameEndpointServer(existing.baseUrl, endpoint.baseUrl)
	);
	if (sameServer) {
		return {
			ok: false,
			message: `${endpoint.baseUrl} is already configured as "${sameServer.name}" (${sameServer.id}).`,
		};
	}
	const next = [...endpoints];
	next[index] = endpoint;
	return { ok: true, endpoints: next, endpoint };
}

/**
 * Drop one endpoint, named by id, id prefix, or name ({@link findLocalModelEndpoint}).
 * The Maestro model server, named by its id or its name, is refused: it is not
 * in this list to remove.
 */
export function removeLocalModelEndpoint(
	endpoints: readonly LocalModelEndpoint[],
	ref: string
): LocalModelEndpointListChange {
	if (isModelServerEndpointRef(ref)) return builtInServerRefusal('remove');
	const found = findLocalModelEndpoint(endpoints, ref);
	if (!found.ok) return found;
	return {
		ok: true,
		endpoints: endpoints.filter((endpoint) => endpoint.id !== found.endpoint.id),
		endpoint: found.endpoint,
	};
}
