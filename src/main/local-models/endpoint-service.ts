/**
 * The endpoint half of the Local Models service: what the IPC channels and the
 * CLI bridge call for user-run model servers. Both transports go through these
 * functions, so a Test from Settings and `maestro-cli models endpoints test`
 * cannot disagree about which record they used or where the key came from.
 *
 * The client (`endpoint-client.ts`) is pure transport and takes everything as
 * arguments. This layer is where the persisted state comes in: the configured
 * list (`localModelEndpoints`) and Settings -> Environment (`shellEnvVars`),
 * the only place an endpoint's API key is resolved from.
 *
 * One endpoint is not in that list: the Maestro model server
 * (`MODEL_SERVER_ENDPOINT_ID`), built in, keyed by Maestro, and started by the
 * call that needs it. Every function here hands a reference to it to
 * `server/server-endpoint.ts`, so the callers need no branch of their own.
 */

import { MODEL_SERVER_ENDPOINT_ID } from '../../shared/local-models/model-server';
import {
	findLocalModelEndpoint,
	parseLocalModelEndpoints,
	validateLocalModelEndpoint,
	type LocalModelEndpoint,
} from '../../shared/local-models/endpoints';
import { getSettingsStore } from '../stores/getters';
import {
	detectLocalEndpoints,
	endpointChat,
	endpointEmbed,
	endpointTranscribe,
	listEndpointModelsResult,
	testEndpoint,
	type DetectedEndpoint,
	type EndpointChatRequest,
	type EndpointChatResult,
	type EndpointEmbedRequest,
	type EndpointEmbedResult,
	type EndpointFailure,
	type EndpointModelsResult,
	type EndpointTestResult,
	type EndpointTranscribeRequest,
	type EndpointTranscribeResult,
} from './endpoint-client';
import { LocalModelEndpointError } from './errors';
import {
	listModelServerModels,
	modelServerCallTarget,
	modelServerUnsupported,
	refersToModelServer,
	testModelServer,
} from './server/server-endpoint';

/** The saved endpoints, read through the same validator that saves them. */
export function getConfiguredLocalModelEndpoints(): LocalModelEndpoint[] {
	return parseLocalModelEndpoints(getSettingsStore().get('localModelEndpoints', []));
}

function shellEnvVars(): Record<string, string> {
	return getSettingsStore().get('shellEnvVars', {}) as Record<string, string>;
}

/**
 * Turn what a caller handed in into an endpoint. A string names a saved
 * endpoint by id, id prefix, or name (the CLI's `test <ref>`, resolved by the
 * same lookup `remove` uses); an object is a record that may not be saved yet
 * (Settings' Test button runs before the user commits the form).
 */
function resolveEndpointRef(
	ref: unknown
): { ok: true; endpoint: LocalModelEndpoint } | { ok: false; error: EndpointFailure } {
	if (typeof ref === 'string') {
		const found = findLocalModelEndpoint(getConfiguredLocalModelEndpoints(), ref);
		return found.ok ? found : { ok: false, error: { kind: 'invalid', message: found.message } };
	}
	const validation = validateLocalModelEndpoint(ref);
	if (validation.ok) return validation;
	return {
		ok: false,
		error: {
			kind: 'invalid',
			message: validation.issues.map((issue) => issue.message).join(' '),
		},
	};
}

/** Running loopback servers that are not configured yet. Saves nothing. */
export async function detectNewLocalModelEndpoints(): Promise<DetectedEndpoint[]> {
	return detectLocalEndpoints(getConfiguredLocalModelEndpoints());
}

/** The models one endpoint serves, by saved id or by record. */
export async function listLocalModelEndpointModels(ref: unknown): Promise<EndpointModelsResult> {
	if (refersToModelServer(ref)) return listModelServerModels();
	const resolved = resolveEndpointRef(ref);
	if (!resolved.ok) return resolved;
	return listEndpointModelsResult(resolved.endpoint, { shellEnvVars: shellEnvVars() });
}

/** A one-token chat against one endpoint, by saved id or by record, with its latency. */
export async function testLocalModelEndpoint(
	ref: unknown,
	model?: unknown
): Promise<EndpointTestResult> {
	if (refersToModelServer(ref)) {
		return testModelServer(typeof model === 'string' ? model : undefined);
	}
	const resolved = resolveEndpointRef(ref);
	if (!resolved.ok) return resolved;
	return testEndpoint(resolved.endpoint, {
		shellEnvVars: shellEnvVars(),
		...(typeof model === 'string' && model.trim() !== '' ? { model: model.trim() } : {}),
	});
}

/**
 * Why a saved endpoint cannot be called right now, or the endpoint itself.
 *
 * This is the path real work takes (text generation, embeddings) and the one
 * task readiness asks, so it is stricter than Test: the id must match exactly
 * (an assignment stores the full id, and a prefix that later becomes ambiguous
 * must not quietly pick another server), and a disabled endpoint is refused
 * rather than called. The client leaves `enabled` to its caller; this is that
 * caller.
 */
export type UsableLocalModelEndpoint =
	| { ok: true; endpoint: LocalModelEndpoint }
	| { ok: false; problem: 'unknown' | 'disabled'; message: string; endpoint?: LocalModelEndpoint };

/** A SAVED endpoint by its exact id, or why it cannot be called. */
export function findUsableLocalModelEndpoint(endpointId: string): UsableLocalModelEndpoint {
	const endpoint = getConfiguredLocalModelEndpoints().find((entry) => entry.id === endpointId);
	if (!endpoint) {
		return {
			ok: false,
			problem: 'unknown',
			message: `No saved endpoint has the id "${endpointId}".`,
		};
	}
	if (!endpoint.enabled) {
		return {
			ok: false,
			problem: 'disabled',
			message: `${endpoint.name} is disabled. Enable it in the endpoint list to use it.`,
			endpoint,
		};
	}
	return { ok: true, endpoint };
}

/** {@link findUsableLocalModelEndpoint}, as a classified throw for a call about to be sent. */
function requireUsableEndpoint(endpointId: string): LocalModelEndpoint {
	const found = findUsableLocalModelEndpoint(endpointId);
	if (found.ok) return found.endpoint;
	throw new LocalModelEndpointError(found.message, {
		kind: 'invalid',
		endpointId,
		endpointName: found.endpoint?.name ?? endpointId,
		url: found.endpoint?.baseUrl ?? '',
	});
}

/** One chat completion against a saved, enabled endpoint, named by its exact id. */
export async function chatWithLocalModelEndpoint(
	endpointId: string,
	request: Omit<EndpointChatRequest, 'shellEnvVars'>
): Promise<EndpointChatResult> {
	if (endpointId === MODEL_SERVER_ENDPOINT_ID) {
		const target = await modelServerCallTarget(request.model);
		return endpointChat(target.endpoint, { ...request, apiKey: target.apiKey });
	}
	return endpointChat(requireUsableEndpoint(endpointId), {
		...request,
		shellEnvVars: shellEnvVars(),
	});
}

/** Embed inputs on a saved, enabled endpoint, named by its exact id. */
export async function embedWithLocalModelEndpoint(
	endpointId: string,
	request: Omit<EndpointEmbedRequest, 'shellEnvVars'>
): Promise<EndpointEmbedResult> {
	if (endpointId === MODEL_SERVER_ENDPOINT_ID) throw modelServerUnsupported('embeddings');
	return endpointEmbed(requireUsableEndpoint(endpointId), {
		...request,
		shellEnvVars: shellEnvVars(),
	});
}

/** Transcribe one clip on a saved, enabled endpoint, named by its exact id. */
export async function transcribeWithLocalModelEndpoint(
	endpointId: string,
	request: Omit<EndpointTranscribeRequest, 'shellEnvVars'>
): Promise<EndpointTranscribeResult> {
	if (endpointId === MODEL_SERVER_ENDPOINT_ID) throw modelServerUnsupported('speech-to-text');
	return endpointTranscribe(requireUsableEndpoint(endpointId), {
		...request,
		shellEnvVars: shellEnvVars(),
	});
}
