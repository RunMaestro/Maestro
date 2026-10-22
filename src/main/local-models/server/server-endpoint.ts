/**
 * The Maestro model server as a Local Models source: the built-in endpoint
 * `maestro-server` (`MODEL_SERVER_ENDPOINT_ID`).
 *
 * The endpoint service routes every call that names that id here, so the paths
 * that already take an endpoint (task assignments, model listing, Test, and
 * later an agent's Run on) reach the server with no second code path. Three
 * things set it apart from a saved endpoint:
 *
 *   - **It is never saved.** The record is built per call from where the server
 *     listens (`modelServerEndpoint`), and the endpoint list refuses to add, edit
 *     or remove it. Only the Model server card and `maestro-cli models server`
 *     control it.
 *   - **Maestro holds its key.** The key is sealed in the server's own config
 *     file and handed to each call as `apiKey`; no `apiKeyEnvVar` is involved.
 *   - **A call starts it.** A task assigned to it is something the user turned
 *     on, so the call goes through `ensureModelServerFor`, which starts the
 *     server and loads the model when needed. A server that cannot is refused by
 *     name, as an endpoint error every endpoint caller already handles. Listing
 *     never starts it: the models are the installed catalog text models it would
 *     serve.
 *
 * It serves text generation only: no embedding or speech route is offered.
 */

import {
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_NAME,
	isModelServerEndpointRef,
	modelServerEndpoint,
	type ModelServerErrorCode,
} from '../../../shared/local-models/model-server';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import { modelsSettingsLocation } from '../../../shared/local-models/settings-location';
import {
	testEndpoint,
	toEndpointFailure,
	type EndpointModelsResult,
	type EndpointTestResult,
} from '../endpoint-client';
import {
	isLocalModelEndpointError,
	LocalModelEndpointError,
	type LocalModelEndpointErrorKind,
} from '../errors';
import { isServerEngineInstalled } from './engine-store';
import { collectServerModels } from './presets';
import { ensureModelServerFor, getModelServerKey, modelServerServingLoaded } from './supervisor';

/** Where one call goes: the server's record and the key to send with it. */
export interface ModelServerCallTarget {
	endpoint: LocalModelEndpoint;
	apiKey: string;
}

/**
 * Whether what a caller handed the endpoint service means the server: its id or
 * name as a string, or a record carrying its id.
 */
export function refersToModelServer(ref: unknown): boolean {
	if (typeof ref === 'string') return isModelServerEndpointRef(ref);
	return (
		typeof ref === 'object' &&
		ref !== null &&
		(ref as { id?: unknown }).id === MODEL_SERVER_ENDPOINT_ID
	);
}

/**
 * How each reason the server gives maps onto the endpoint error kinds callers
 * switch on: a server that will not come up reads like one that cannot be
 * reached, and a missing piece reads like a setting to fix.
 */
const ENSURE_FAILURE_KINDS: Readonly<Record<ModelServerErrorCode, LocalModelEndpointErrorKind>> = {
	'engine-not-installed': 'invalid',
	'no-models': 'no-models',
	'model-unsupported': 'invalid',
	'model-not-installed': 'invalid',
	'port-in-use': 'network',
	'key-unavailable': 'invalid',
	'key-required': 'invalid',
	'invalid-setting': 'invalid',
	'preset-invalid': 'invalid',
	'start-failed': 'network',
	'load-failed': 'network',
};

function serverError(message: string, kind: LocalModelEndpointErrorKind): LocalModelEndpointError {
	return new LocalModelEndpointError(message, {
		kind,
		endpointId: MODEL_SERVER_ENDPOINT_ID,
		endpointName: MODEL_SERVER_NAME,
		url: '',
	});
}

/**
 * Make the server ready for `model` (starting it and loading the model when
 * needed) and return where to send the call. Throws a `LocalModelEndpointError`
 * naming the reason when it cannot; the caller must not send the call elsewhere.
 */
export async function modelServerCallTarget(model: string): Promise<ModelServerCallTarget> {
	const ensured = await ensureModelServerFor(model);
	if (!ensured.ok) throw serverError(ensured.error, ENSURE_FAILURE_KINDS[ensured.code]);
	return { endpoint: modelServerEndpoint(ensured.baseUrl), apiKey: await getModelServerKey() };
}

/** The server, ready for one model: where a harness reaches it and its key. */
export type ModelServerForHarness =
	| { ok: true; baseUrl: string; key: string }
	| { ok: false; error: string };

/**
 * {@link modelServerCallTarget} for a harness (an agent's Run on target): the
 * server's root and key, or the reason it cannot serve the model, as a result.
 * A result and not a throw because it crosses the CLI bridge, and because its
 * caller refuses a launch with the reason rather than catching an error.
 */
export async function modelServerForHarness(model: string): Promise<ModelServerForHarness> {
	try {
		const target = await modelServerCallTarget(model);
		return { ok: true, baseUrl: target.endpoint.baseUrl, key: target.apiKey };
	} catch (error) {
		if (isLocalModelEndpointError(error)) return { ok: false, error: error.message };
		throw error;
	}
}

/**
 * Where to send a call for local model `modelId` when the running server
 * already has it loaded, or null. Never starts the server or loads a model.
 */
export async function loadedModelServerTarget(
	modelId: string
): Promise<ModelServerCallTarget | null> {
	const serving = await modelServerServingLoaded(modelId);
	if (!serving) return null;
	return { endpoint: modelServerEndpoint(serving.baseUrl), apiKey: serving.key };
}

/**
 * The models the server offers: every installed catalog text model, by catalog
 * id (the name a request sends). Read from disk, so it neither needs the server
 * running nor starts it. Without the engine there is nothing to serve them with,
 * and that is the answer.
 */
export async function listModelServerModels(): Promise<EndpointModelsResult> {
	if (!(await isServerEngineInstalled())) {
		return {
			ok: false,
			error: {
				kind: 'invalid',
				message: `The ${MODEL_SERVER_NAME} engine (llama-server) is not downloaded. Install it in ${modelsSettingsLocation('sources')}.`,
			},
		};
	}
	const models = await collectServerModels();
	return { ok: true, models: models.map((model) => ({ id: model.id })) };
}

/**
 * A one-token chat through the server, timed. A Test is a person asking, so it
 * starts the server when it is stopped, like any call does. With no model
 * named, the first installed one is used.
 */
export async function testModelServer(model?: string): Promise<EndpointTestResult> {
	let modelCount: number | undefined;
	let chosen = model?.trim() || undefined;
	if (!chosen) {
		const listing = await listModelServerModels();
		if (!listing.ok) return listing;
		modelCount = listing.models.length;
		chosen = listing.models[0]?.id;
		if (!chosen) {
			return {
				ok: false,
				error: {
					kind: 'no-models',
					message: `The ${MODEL_SERVER_NAME} has no text model to serve. Download one in ${modelsSettingsLocation('library')}.`,
				},
			};
		}
	}
	let target: ModelServerCallTarget;
	try {
		target = await modelServerCallTarget(chosen);
	} catch (error) {
		if (isLocalModelEndpointError(error)) return { ok: false, error: toEndpointFailure(error) };
		throw error;
	}
	const result = await testEndpoint(target.endpoint, { apiKey: target.apiKey, model: chosen });
	return result.ok && modelCount !== undefined ? { ...result, modelCount } : result;
}

/** The refusal for a need the server does not serve. */
export function modelServerUnsupported(
	what: 'embeddings' | 'speech-to-text'
): LocalModelEndpointError {
	return serverError(
		`The ${MODEL_SERVER_NAME} serves text generation only, not ${what}. Assign a local model or another endpoint.`,
		'invalid'
	);
}
