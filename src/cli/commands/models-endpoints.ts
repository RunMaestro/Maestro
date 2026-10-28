// `maestro-cli models endpoints list|add|update|remove|models|test|detect` - the
// model servers the user runs (Ollama, LM Studio, any OpenAI-compatible base URL).
//
// Two halves, split by what each verb needs:
//
// - list / add / update / remove edit the `localModelEndpoints` setting in the
//   settings file, exactly as the SSH remote verbs do, so they work with Maestro
//   closed. The settings watcher reloads every open window. The list is changed
//   through the SAME shared helpers (`addLocalModelEndpoint`,
//   `updateLocalModelEndpoint`, `removeLocalModelEndpoint`) the app validates
//   with, so the CLI cannot save a record the app would drop.
// - models / test / detect need the network and Settings -> Environment (where
//   an API key is looked up by name), so they run in the desktop over the WS
//   bridge, through the same endpoint-service functions as the
//   `localModels:endpoints:*` IPC channels.

import * as crypto from 'crypto';
import {
	readLocalModelEndpoints,
	readSettingValue,
	writeLocalModelEndpoints,
} from '../services/storage';
import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitWith } from '../exit-codes';
import {
	colorize,
	formatLocalModelEndpoints,
	formatSuccess,
	formatWarning,
} from '../output/formatter';
import {
	addLocalModelEndpoint,
	DEFAULT_ENDPOINT_BASE_URLS,
	findLocalModelEndpoint,
	isLocalModelEndpointKind,
	LOCAL_MODEL_ENDPOINT_KIND_LABELS,
	LOCAL_MODEL_ENDPOINT_KINDS,
	removeLocalModelEndpoint,
	resolveEndpointApiKey,
	updateLocalModelEndpoint,
	type LocalModelEndpoint,
} from '../../shared/local-models/endpoints';
import { formatSize } from '../../shared/formatters';
import type {
	DetectedEndpoint,
	EndpointModelsResult,
	EndpointTestResult,
} from '../../main/local-models/endpoint-client';
import { failCommand, failFromError } from '../services/session-command';

/**
 * The app's test budget is 30s (a cold model has to load before it answers one
 * token), so the bridge wait sits above it: a slow endpoint must come back as
 * the app's own timeout verdict, not as the CLI giving up first.
 */
const TEST_TIMEOUT_MS = 40_000;

interface JsonOption {
	json?: boolean;
}

interface AddOptions extends JsonOption {
	kind?: string;
	url?: string;
	name?: string;
	apiKeyEnv?: string;
	disabled?: boolean;
}

interface UpdateOptions extends JsonOption {
	kind?: string;
	url?: string;
	name?: string;
	apiKeyEnv?: string;
	clearApiKeyEnv?: boolean;
	enable?: boolean;
	disable?: boolean;
}

interface TestOptions extends JsonOption {
	model?: string;
}

function shellEnvVars(): Record<string, string> {
	const value = readSettingValue('shellEnvVars');
	return value && typeof value === 'object' ? (value as Record<string, string>) : {};
}

/** Whether a named key resolves now; `undefined` when the endpoint names none. */
function apiKeyResolved(
	endpoint: LocalModelEndpoint,
	env: Record<string, string>
): boolean | undefined {
	if (!endpoint.apiKeyEnvVar) return undefined;
	return resolveEndpointApiKey(endpoint, env) !== undefined;
}

export function modelsEndpointsList(options: JsonOption): void {
	const endpoints = readLocalModelEndpoints();
	const env = shellEnvVars();

	if (options.json) {
		for (const endpoint of endpoints) {
			const resolved = apiKeyResolved(endpoint, env);
			console.log(
				JSON.stringify({
					...endpoint,
					...(resolved === undefined ? {} : { apiKeyResolved: resolved }),
				})
			);
		}
		return;
	}

	console.log(
		formatLocalModelEndpoints(
			endpoints.map((endpoint) => ({
				...endpoint,
				kindLabel: LOCAL_MODEL_ENDPOINT_KIND_LABELS[endpoint.kind],
				apiKeyResolved: apiKeyResolved(endpoint, env),
			}))
		)
	);
}

export function modelsEndpointsAdd(options: AddOptions): void {
	const kind = options.kind?.trim() ?? '';
	if (!isLocalModelEndpointKind(kind)) {
		failCommand(
			`--kind must be one of: ${LOCAL_MODEL_ENDPOINT_KINDS.join(', ')}`,
			options.json,
			ExitCode.InvalidUsage
		);
	}

	// Ollama and LM Studio listen on known ports, so `add --kind ollama` alone is
	// the "Add detected Ollama" click. An OpenAI-compatible host has no default.
	const baseUrl = options.url?.trim() || DEFAULT_ENDPOINT_BASE_URLS[kind];
	if (!baseUrl) {
		failCommand(`--url is required for --kind ${kind}`, options.json, ExitCode.InvalidUsage);
	}

	const change = addLocalModelEndpoint(readLocalModelEndpoints(), {
		id: crypto.randomUUID(),
		name: options.name?.trim() || LOCAL_MODEL_ENDPOINT_KIND_LABELS[kind],
		kind,
		baseUrl,
		apiKeyEnvVar: options.apiKeyEnv,
		enabled: !options.disabled,
	});
	if (!change.ok) failCommand(change.message, options.json, ExitCode.InvalidUsage);

	writeLocalModelEndpoints(change.endpoints);
	const endpoint = change.endpoint;
	const resolved = apiKeyResolved(endpoint, shellEnvVars());

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				endpoint,
				...(resolved === undefined ? {} : { apiKeyResolved: resolved }),
			})
		);
		return;
	}
	console.log(formatSuccess(`Added endpoint "${endpoint.name}"`));
	console.log(`  ID:   ${endpoint.id}`);
	console.log(`  Kind: ${LOCAL_MODEL_ENDPOINT_KIND_LABELS[endpoint.kind]}`);
	console.log(`  URL:  ${endpoint.baseUrl}`);
	if (!endpoint.enabled) console.log('  Disabled');
	if (resolved === false) {
		// Saved anyway: the user may be about to add the variable. Say so now
		// rather than letting the first call fail as `missing-key`.
		console.log(
			formatWarning(
				`$${endpoint.apiKeyEnvVar} is not set in Settings -> Environment yet. Requests will be refused until it is.`
			)
		);
	}
}

/**
 * Edit one saved endpoint: the Edit form and the enabled switch of its Settings
 * row in one verb. Only the fields a flag names change; the id and the place in
 * the list are kept, so assignments that name the endpoint still resolve.
 */
export function modelsEndpointsUpdate(ref: string, options: UpdateOptions): void {
	// A declaration, not an arrow: only a declared `never` return narrows below.
	function usage(message: string): never {
		return failCommand(message, options.json, ExitCode.InvalidUsage);
	}
	if (options.enable && options.disable) usage('Pass --enable or --disable, not both.');
	if (options.apiKeyEnv !== undefined && options.clearApiKeyEnv) {
		usage('Pass --api-key-env or --clear-api-key-env, not both.');
	}
	const kind = options.kind?.trim();
	if (kind !== undefined && !isLocalModelEndpointKind(kind)) {
		usage(`--kind must be one of: ${LOCAL_MODEL_ENDPOINT_KINDS.join(', ')}`);
	}
	const changesSomething =
		kind !== undefined ||
		options.url !== undefined ||
		options.name !== undefined ||
		options.apiKeyEnv !== undefined ||
		options.clearApiKeyEnv ||
		options.enable ||
		options.disable;
	if (!changesSomething) {
		usage(
			'Nothing to change. Pass --name, --url, --kind, --api-key-env, --clear-api-key-env, --enable, or --disable.'
		);
	}

	const endpoints = readLocalModelEndpoints();
	const found = findLocalModelEndpoint(endpoints, ref);
	if (!found.ok) failCommand(found.message, options.json);
	const current = found.endpoint;

	const apiKeyEnvVar = options.clearApiKeyEnv
		? undefined
		: (options.apiKeyEnv ?? current.apiKeyEnvVar);
	const change = updateLocalModelEndpoint(endpoints, current.id, {
		name: options.name ?? current.name,
		kind: kind ?? current.kind,
		baseUrl: options.url ?? current.baseUrl,
		...(apiKeyEnvVar !== undefined ? { apiKeyEnvVar } : {}),
		enabled: options.enable ? true : options.disable ? false : current.enabled,
	});
	if (!change.ok) usage(change.message);

	writeLocalModelEndpoints(change.endpoints);
	const endpoint = change.endpoint;
	const resolved = apiKeyResolved(endpoint, shellEnvVars());

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				endpoint,
				...(resolved === undefined ? {} : { apiKeyResolved: resolved }),
			})
		);
		return;
	}
	console.log(formatSuccess(`Updated endpoint "${endpoint.name}" (${endpoint.id})`));
	console.log(`  Kind: ${LOCAL_MODEL_ENDPOINT_KIND_LABELS[endpoint.kind]}`);
	console.log(`  URL:  ${endpoint.baseUrl}`);
	console.log(`  ${endpoint.enabled ? 'Enabled' : 'Disabled'}`);
	if (resolved === false) {
		console.log(
			formatWarning(
				`$${endpoint.apiKeyEnvVar} is not set in Settings -> Environment yet. Requests will be refused until it is.`
			)
		);
	}
}

export function modelsEndpointsRemove(ref: string, options: JsonOption): void {
	const change = removeLocalModelEndpoint(readLocalModelEndpoints(), ref);
	if (!change.ok) failCommand(change.message, options.json);

	writeLocalModelEndpoints(change.endpoints);
	const { id, name } = change.endpoint;
	if (options.json) console.log(JSON.stringify({ success: true, id, name }));
	else console.log(formatSuccess(`Removed endpoint "${name}" (${id})`));
}

/**
 * The models one saved endpoint serves right now: the row's "List the models
 * this server serves now" button, and where the `<model>` half of
 * `models assign <task> endpoint:<endpoint>:<model>` comes from.
 */
export async function modelsEndpointsModels(ref: string, options: JsonOption): Promise<void> {
	let reply: { success: boolean; result?: EndpointModelsResult; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'local_models_endpoint_models', endpoint: ref },
				'local_models_endpoint_models_result'
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}

	if (!reply.success || !reply.result) {
		failCommand(reply.error || 'Could not list the endpoint models', options.json);
	}
	const result = reply.result;

	if (!result.ok) {
		// Same failure kinds as `test`, so a script branches on them the same way.
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: result.error }));
		} else {
			console.error(`Error: ${result.error.message} [${result.error.kind}]`);
		}
		exitWith(ExitCode.GeneralError);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, models: result.models }));
		return;
	}
	if (result.models.length === 0) {
		console.log('The server answered and lists no models.');
		return;
	}
	for (const model of result.models) {
		console.log(
			model.sizeBytes === undefined ? model.id : `${model.id}  ${formatSize(model.sizeBytes)}`
		);
	}
}

export async function modelsEndpointsTest(ref: string, options: TestOptions): Promise<void> {
	let reply: { success: boolean; result?: EndpointTestResult; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'local_models_endpoint_test', endpoint: ref, model: options.model },
				'local_models_endpoint_test_result',
				TEST_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}

	if (!reply.success || !reply.result) {
		failCommand(reply.error || 'Endpoint test failed', options.json);
	}
	const result = reply.result;

	if (!result.ok) {
		// The kind is what a script branches on: `missing-key` and `auth` are
		// fixed in Settings -> Environment, `network` means nothing is listening.
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: result.error }));
		} else {
			console.error(`Error: ${result.error.message} [${result.error.kind}]`);
		}
		exitWith(ExitCode.GeneralError);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, ...result }));
		return;
	}
	console.log(formatSuccess(`Endpoint answered in ${result.latencyMs} ms`));
	console.log(`  Model:  ${result.model}`);
	if (result.modelCount !== undefined) console.log(`  Models: ${result.modelCount} available`);
}

export async function modelsEndpointsDetect(options: JsonOption): Promise<void> {
	let reply: { success: boolean; detected?: DetectedEndpoint[]; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'local_models_endpoints_detect' },
				'local_models_endpoints_detect_result'
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}

	if (!reply.success) failCommand(reply.error || 'Detection failed', options.json);
	const detected = reply.detected ?? [];

	if (options.json) {
		console.log(JSON.stringify({ success: true, detected }));
		return;
	}
	if (detected.length === 0) {
		console.log('No new local model servers found on this machine.');
		return;
	}
	// Detection never saves anything. Print the exact command that does, so the
	// add stays an explicit choice.
	for (const server of detected) {
		console.log(
			`${colorize('cyan', server.name)} at ${server.baseUrl} (${server.models.length} model${server.models.length === 1 ? '' : 's'})`
		);
		console.log(
			`  Add it: maestro-cli models endpoints add --kind ${server.kind} --url ${server.baseUrl}`
		);
	}
}
