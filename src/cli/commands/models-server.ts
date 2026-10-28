// `maestro-cli models server status|start|stop|set|key` - the Maestro model
// server (llama.cpp's `llama-server`) from the command line.
//
// Every verb runs in the desktop over the WS bridge, through the same service
// functions the Model server card in Models -> Library calls, so a server
// started here is the one the card shows and the other way around.
//
//   status   the report: state, address, engine build and accelerator, models
//            served and loaded, where the key is kept, the log path
//   start    start it and wait until it answers
//   stop     stop it and wait until it exits
//   set      --bind local|network, --max-models <n>, --rotate-key, and
//            --build default|cpu|cuda|rocm (installs that build of the engine).
//            A running server restarts to apply any of them.
//   key      print the API key a harness needs (the card's Copy)
//
// Exit codes, for scripts: `status` exits non-zero when the server is `failed`
// (it could not start, or crashed too many times in a row). A server that is
// simply stopped is not a failure.

import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitWith } from '../exit-codes';
import { formatModelServerReport, formatSuccess } from '../output/formatter';
import {
	isModelServerBind,
	isModelServerMaxModels,
	MAX_MODEL_SERVER_MAX_MODELS,
	MODEL_SERVER_NAME,
	type ModelServerReport,
} from '../../shared/local-models/model-server';
import { isServerBuildChoice, SERVER_BUILD_CHOICES } from '../../shared/local-models/server-engine';
import { modelsSettingsLocation } from '../../shared/local-models/settings-location';
import { failCommand, failFromError } from '../services/session-command';

/** A status read: a config file, the engine manifest, one loopback request. */
const STATUS_TIMEOUT_MS = 15_000;
/** A start waits for `/health`, which the supervisor gives a minute. */
const START_TIMEOUT_MS = 3 * 60 * 1000;
const STOP_TIMEOUT_MS = 60_000;
/** `--build` downloads the engine: a CUDA build is over 600 MB. */
const INSTALL_TIMEOUT_MS = 60 * 60 * 1000;

interface JsonOption {
	json?: boolean;
}

type ReportReply = { success: boolean; error?: string; report?: ModelServerReport };

async function send<T extends { success: boolean; error?: string }>(
	payload: Record<string, unknown>,
	responseType: string,
	json: boolean | undefined,
	timeoutMs: number
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

function requireReport(reply: ReportReply, json: boolean | undefined): ModelServerReport {
	if (!reply.report) failCommand('The desktop app sent no model server report.', json);
	return reply.report;
}

/** Print a report: the whole record as JSON, or the formatted block. */
function printReport(report: ModelServerReport, json: boolean | undefined): void {
	if (json) console.log(JSON.stringify({ success: report.status.state !== 'failed', ...report }));
	else console.log(formatModelServerReport(report));
}

export async function modelsServerStatus(options: JsonOption): Promise<void> {
	const report = requireReport(
		await send<ReportReply>(
			{ type: 'local_models_server_status' },
			'local_models_server_status_result',
			options.json,
			STATUS_TIMEOUT_MS
		),
		options.json
	);
	printReport(report, options.json);
	if (report.status.state === 'failed') exitWith(ExitCode.GeneralError);
}

export async function modelsServerStart(options: JsonOption): Promise<void> {
	if (!options.json) console.log(`Starting the ${MODEL_SERVER_NAME}...`);
	const report = requireReport(
		await send<ReportReply>(
			{ type: 'local_models_server_start' },
			'local_models_server_start_result',
			options.json,
			START_TIMEOUT_MS
		),
		options.json
	);
	if (options.json) {
		printReport(report, true);
		return;
	}
	console.log(formatSuccess(`The ${MODEL_SERVER_NAME} is listening at ${report.status.baseUrl}`));
}

export async function modelsServerStop(options: JsonOption): Promise<void> {
	const report = requireReport(
		await send<ReportReply>(
			{ type: 'local_models_server_stop' },
			'local_models_server_stop_result',
			options.json,
			STOP_TIMEOUT_MS
		),
		options.json
	);
	if (options.json) {
		printReport(report, true);
		return;
	}
	console.log(formatSuccess(`The ${MODEL_SERVER_NAME} is stopped`));
}

interface SetOptions extends JsonOption {
	bind?: string;
	maxModels?: string;
	rotateKey?: boolean;
	build?: string;
}

export async function modelsServerSet(options: SetOptions): Promise<void> {
	const payload: Record<string, unknown> = { type: 'local_models_server_set' };
	if (options.bind !== undefined) {
		if (!isModelServerBind(options.bind)) {
			failCommand(
				`"${options.bind}" is not a bind mode. Use local or network.`,
				options.json,
				ExitCode.InvalidUsage
			);
		}
		payload.bind = options.bind;
	}
	if (options.maxModels !== undefined) {
		const count = Number(options.maxModels);
		if (!isModelServerMaxModels(count)) {
			failCommand(
				`--max-models must be a whole number from 1 to ${MAX_MODEL_SERVER_MAX_MODELS}.`,
				options.json,
				ExitCode.InvalidUsage
			);
		}
		payload.maxModels = count;
	}
	if (options.rotateKey) payload.rotateKey = true;
	if (options.build !== undefined) {
		if (!isServerBuildChoice(options.build)) {
			failCommand(
				`"${options.build}" is not a build. Use ${SERVER_BUILD_CHOICES.join(', ')}.`,
				options.json,
				ExitCode.InvalidUsage
			);
		}
		payload.build = options.build;
	}
	if (Object.keys(payload).length === 1) {
		failCommand(
			'Nothing to change. Pass --bind, --max-models, --rotate-key or --build.',
			options.json,
			ExitCode.InvalidUsage
		);
	}

	if (options.build !== undefined && !options.json) {
		console.log(
			`Installing the ${options.build} build of the engine. Progress shows in ${modelsSettingsLocation('sources')}.`
		);
	}
	const report = requireReport(
		await send<ReportReply>(
			payload,
			'local_models_server_set_result',
			options.json,
			options.build !== undefined ? INSTALL_TIMEOUT_MS : START_TIMEOUT_MS
		),
		options.json
	);
	if (options.json) {
		printReport(report, true);
		return;
	}
	console.log(formatSuccess(`Updated the ${MODEL_SERVER_NAME}`));
	if (options.rotateKey) {
		console.log(
			'The old key no longer works. Print the new one with: maestro-cli models server key'
		);
	}
	console.log(formatModelServerReport(report));
}

export async function modelsServerKey(options: JsonOption): Promise<void> {
	const reply = await send<{ success: boolean; error?: string; key?: string }>(
		{ type: 'local_models_server_key' },
		'local_models_server_key_result',
		options.json,
		STATUS_TIMEOUT_MS
	);
	if (!reply.key) failCommand('The desktop app sent no key.', options.json);
	if (options.json) console.log(JSON.stringify({ success: true, key: reply.key }));
	else console.log(reply.key);
}
