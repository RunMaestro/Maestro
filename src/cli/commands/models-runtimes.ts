// `maestro-cli models runtimes list|install` - the native runtimes ("engines")
// local models run on.
//
// A model is weights; a runtime is the native library that reads them (ONNX
// Runtime, llama.cpp). Runtimes are downloaded rather than bundled, so a model
// can be installed and still not run. `models install` fetches a model's
// runtime with it; these two verbs are the Engines card in Settings -> Local
// Models: see what is on disk, and install or update one on its own.
//
// Both run in the desktop over the WS bridge, through the same service
// functions (`listLocalRuntimes`, `installLocalRuntime`) the card calls, so an
// install started here is joined by one started in the app, never duplicated.

import { withMaestroClient } from '../services/maestro-client';
import { ExitCode } from '../exit-codes';
import { formatSuccess } from '../output/formatter';
import { formatSize } from '../../shared/formatters';
import { getLocalModel } from '../../shared/local-models/model-catalog';
import { getNativeRuntime, NATIVE_RUNTIMES } from '../../shared/local-models/native-runtimes';
import { modelsSettingsLocation } from '../../shared/local-models/settings-location';
import type { LocalRuntimeListing } from '../../main/local-models/service';
import { failCommand, failFromError } from '../services/session-command';

/** A runtime is tens of megabytes across many tarballs; the reply comes when it is usable. */
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

interface JsonOption {
	json?: boolean;
}

async function send<T extends { success: boolean; error?: string }>(
	payload: Record<string, unknown>,
	responseType: string,
	json: boolean | undefined,
	timeoutMs?: number
): Promise<T> {
	let reply: T;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<T>(payload, responseType, timeoutMs)
		);
	} catch (error) {
		failFromError(error, json);
	}
	if (!reply.success) failCommand(reply.error || 'Request failed', json);
	return reply;
}

/** One word for a runtime's state, the same four the Engines card shows. */
export function runtimeStateLabel(runtime: LocalRuntimeListing): string {
	if (!runtime.downloadable) return runtime.installed ? 'installed' : 'unavailable';
	if (!runtime.installed) return 'not installed';
	return runtime.stale ? 'needs update' : 'installed';
}

function modelNames(runtime: LocalRuntimeListing): string {
	return runtime.models.map((id) => getLocalModel(id)?.displayName ?? id).join(', ');
}

export async function modelsRuntimesList(options: JsonOption): Promise<void> {
	const reply = await send<{
		success: boolean;
		error?: string;
		runtimes?: LocalRuntimeListing[];
	}>({ type: 'local_models_runtimes_list' }, 'local_models_runtimes_list_result', options.json);
	const runtimes = reply.runtimes ?? [];

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				runtimes: runtimes.map((runtime) => ({ ...runtime, state: runtimeStateLabel(runtime) })),
			})
		);
		return;
	}

	for (const runtime of runtimes) {
		const size = runtime.downloadable ? `, ${formatSize(runtime.bytes)}` : '';
		console.log(`${runtime.id}  ${runtime.label}  [${runtimeStateLabel(runtime)}${size}]`);
		console.log(`  Runs: ${modelNames(runtime)}`);
		if (!runtime.downloadable && !runtime.installed) {
			console.log('  No build is published for this platform.');
		}
	}
}

export async function modelsRuntimesInstall(runtimeId: string, options: JsonOption): Promise<void> {
	const descriptor = getNativeRuntime(runtimeId as (typeof NATIVE_RUNTIMES)[number]['id']);
	if (!descriptor) {
		failCommand(
			`Unknown runtime "${runtimeId}". Runtimes: ${NATIVE_RUNTIMES.map((runtime) => runtime.id).join(', ')}.`,
			options.json,
			ExitCode.InvalidUsage
		);
	}

	if (!options.json) {
		console.log(
			`Installing ${descriptor.label}. Progress shows in ${modelsSettingsLocation('library', 'engines')}.`
		);
	}
	const reply = await send<{
		success: boolean;
		error?: string;
		runtime?: LocalRuntimeListing;
	}>(
		{ type: 'local_models_runtime_install', runtimeId },
		'local_models_runtime_install_result',
		options.json,
		INSTALL_TIMEOUT_MS
	);

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				runtime: reply.runtime
					? { ...reply.runtime, state: runtimeStateLabel(reply.runtime) }
					: undefined,
			})
		);
		return;
	}
	console.log(formatSuccess(`Installed ${descriptor.label}`));
}
