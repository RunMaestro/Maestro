// `maestro-cli models list|install|pause|cancel|remove|verify|add-hf|remove-hf` -
// the local model Library and what is on disk.
//
// Every verb runs in the desktop over the WS bridge, through the same service
// functions (`src/main/local-models/service.ts`, and `user-models.ts` for the
// models the user added from Hugging Face) as the `localModels:*` IPC channels
// the Settings > Models rows call, so the CLI and the app read the same model
// store, write through the same downloader (a download started in one is joined
// by the other, never duplicated), and hash with the same verifier. The CLI only
// decides what the Settings row decides before it calls: which ids are real,
// that a pending model is never offered for download, and that removing a model
// a task runs on is named first.
//
// `list` groups the way the Library does (`groupLocalModelsForLibrary`), names
// each model's Library section in `--json` (the tab it is listed on), and
// `list --fit` judges each model with the same `modelFit()` the rows use,
// against the hardware profile the desktop read.

import { withMaestroClient } from '../services/maestro-client';
import { readLocalModelAssignments, readSettingValue } from '../services/storage';
import { ExitCode, exitWith } from '../exit-codes';
import {
	formatLocalModels,
	formatSuccess,
	formatWarning,
	type LocalModelDisplayStatus,
} from '../output/formatter';
import { formatSize } from '../../shared/formatters';
import { getLocalModel, LOCAL_MODEL_KIND_ORDER } from '../../shared/local-models/model-catalog';
import {
	CLOUD_ONLY_NOTE,
	groupLocalModelsForLibrary,
	localModelLibraryGroup,
	localModelLibrarySection,
	localModelRoleBadges,
} from '../../shared/local-models/library';
import {
	describeHardwareProfile,
	hardwareFitCaveat,
	MODEL_FIT_LABELS,
	modelFit,
	type HardwareProfile,
	type ModelFit,
} from '../../shared/local-models/model-fit';
import { parseUtilitySource, tasksUsingLocalModel } from '../../shared/local-models/tasks';
import { modelsSettingsLocation } from '../../shared/local-models/settings-location';
import {
	USER_MODEL_UNVERIFIED_DETAIL,
	USER_MODEL_UNVERIFIED_LABEL,
} from '../../shared/local-models/user-models';
import type { LocalModelEntry, LocalModelKind } from '../../shared/local-models/types';
import { voiceModelUsageLabel } from '../../shared/acappella/voice-models';
import type { LocalModelListing, LocalRuntimeEnsureResult } from '../../main/local-models/service';
import type { DownloadResult } from '../../main/local-models/model-downloader';
import type { ModelFootprint, VerifyResult } from '../../main/local-models/model-store';
import { failCommand, failFromError } from '../services/session-command';

/**
 * A model can be gigabytes, and the reply only comes when the job settles. If
 * this runs out the download keeps going in the app; only the wait ends.
 */
const INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Verify re-hashes every file, which takes a while for a multi-gigabyte model. */
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

interface JsonOption {
	json?: boolean;
}

interface ListOptions extends JsonOption {
	kind?: string;
	fit?: boolean;
}

interface AddHfOptions extends JsonOption {
	dryRun?: boolean;
}

interface RemoveOptions extends JsonOption {
	force?: boolean;
}

/** The catalog entry for an id, or a usage error naming how to find one. */
function requireModel(modelId: string, json: boolean | undefined): LocalModelEntry {
	const entry = getLocalModel(modelId);
	if (!entry) {
		failCommand(
			`Unknown model "${modelId}". See maestro-cli models list for model ids.`,
			json,
			ExitCode.InvalidUsage
		);
	}
	return entry;
}

/** One bridge round trip; a transport failure or a refused request exits. */
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

/**
 * Who runs a model: the tasks whose effective assignment is it, then the voice
 * capability that uses it. The same list the Settings row's "In use by" line
 * shows.
 */
function usedBy(modelId: string): string[] {
	const tasks = tasksUsingLocalModel(
		readLocalModelAssignments(),
		modelId,
		parseUtilitySource(readSettingValue('utilitySource'))
	).map((task) => task.label);
	const voice = voiceModelUsageLabel(modelId);
	return voice ? [...tasks, voice] : tasks;
}

function displayStatus(listing: LocalModelListing): LocalModelDisplayStatus {
	if (listing.status.status === 'not-installed' && listing.entry.pending) return 'pending';
	return listing.status.status;
}

export async function modelsList(options: ListOptions): Promise<void> {
	let kind: LocalModelKind | undefined;
	if (options.kind !== undefined) {
		const wanted = options.kind.trim();
		if (!LOCAL_MODEL_KIND_ORDER.includes(wanted as LocalModelKind)) {
			failCommand(
				`--kind must be one of: ${LOCAL_MODEL_KIND_ORDER.join(', ')}`,
				options.json,
				ExitCode.InvalidUsage
			);
		}
		kind = wanted as LocalModelKind;
	}

	const reply = await send<{
		success: boolean;
		error?: string;
		listings?: LocalModelListing[];
		footprint?: ModelFootprint;
		hardware?: HardwareProfile;
	}>(
		{ type: 'local_models_list', ...(options.fit ? { fit: true } : {}) },
		'local_models_list_result',
		options.json
	);
	const listings = (reply.listings ?? []).filter(
		(listing) => kind === undefined || listing.entry.kind === kind
	);
	const footprintBytes = reply.footprint?.bytes ?? 0;
	// The same rule and the same profile the Library rows are judged with.
	const hardware = options.fit ? reply.hardware : undefined;
	if (options.fit && !hardware)
		failCommand("The app did not report this computer's hardware", options.json);
	const fitOf = (entry: LocalModelEntry): ModelFit | undefined =>
		hardware ? modelFit(entry, hardware) : undefined;
	const fitCaveat = hardware ? hardwareFitCaveat(hardware) : null;

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				footprintBytes,
				...(hardware
					? {
							hardware,
							hardwareSummary: describeHardwareProfile(hardware),
							...(fitCaveat ? { fitCaveat } : {}),
						}
					: {}),
				models: listings.map((listing) => {
					const fit = fitOf(listing.entry);
					return {
						id: listing.entry.id,
						displayName: listing.entry.displayName,
						kind: listing.entry.kind,
						group: localModelLibraryGroup(listing.entry),
						section: localModelLibrarySection(listing.entry),
						status: displayStatus(listing),
						bytes: listing.entry.bytes,
						bytesOnDisk: listing.status.bytesOnDisk,
						license: listing.entry.license.spdx,
						runtime: listing.entry.runtime,
						goodAt: listing.entry.goodAt,
						...(listing.entry.roles ? { roles: listing.entry.roles } : {}),
						...(listing.entry.agentHarnesses
							? { agentHarnesses: listing.entry.agentHarnesses }
							: {}),
						...(listing.entry.userAdded ? { userAdded: true, verifiedByMaestro: false } : {}),
						...(fit ? { fit: fit.fit, fitReason: fit.reason } : {}),
						usedBy: usedBy(listing.entry.id),
						...(listing.entry.pending ? { pending: listing.entry.pending } : {}),
						...(listing.status.detail ? { detail: listing.status.detail } : {}),
					};
				}),
			})
		);
		return;
	}

	const groups = groupLocalModelsForLibrary(listings, (listing) => listing.entry);
	console.log(
		formatLocalModels(
			groups.map(({ group, items }) => ({
				label: group.label,
				models: items.map((listing) => {
					const status = displayStatus(listing);
					const fit = fitOf(listing.entry);
					return {
						id: listing.entry.id,
						displayName: listing.entry.displayName,
						status,
						size: formatSize(listing.entry.bytes),
						usedBy: usedBy(listing.entry.id),
						detail: status === 'pending' ? listing.entry.pending : listing.status.detail,
						goodAt: listing.entry.goodAt,
						badges: [
							...localModelRoleBadges(listing.entry),
							...(listing.entry.userAdded ? [USER_MODEL_UNVERIFIED_LABEL] : []),
						],
						...(fit
							? { fit: { level: fit.fit, label: MODEL_FIT_LABELS[fit.fit], reason: fit.reason } }
							: {}),
					};
				}),
			})),
			formatSize(footprintBytes),
			{
				...(hardware ? { hardware: describeHardwareProfile(hardware) } : {}),
				...(fitCaveat ? { fitCaveat } : {}),
				// A filtered list is an answer about one kind, not the whole Library.
				...(kind === undefined ? { cloudOnly: CLOUD_ONLY_NOTE } : {}),
			}
		)
	);
}

/**
 * Add a Hugging Face repo file to the Library as a user entry. The desktop asks
 * Hugging Face to describe the repo, pins its commit, and records the hash it
 * reports; nothing is downloaded until `models install`. `--dry-run` describes
 * the model (its license first) and saves nothing.
 */
export async function modelsAddHf(
	repo: string,
	file: string,
	options: AddHfOptions
): Promise<void> {
	const reply = await send<{
		success: boolean;
		error?: string;
		entry?: LocalModelEntry;
		added?: boolean;
	}>(
		{ type: 'local_models_hf_add', repo, file, ...(options.dryRun ? { dryRun: true } : {}) },
		'local_models_hf_add_result',
		options.json
	);
	const entry = reply.entry;
	if (!entry) failCommand('The app did not describe the model', options.json);
	const added = reply.added === true;

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				added,
				...(options.dryRun ? { dryRun: true } : {}),
				id: entry.id,
				displayName: entry.displayName,
				repo: entry.source.repo,
				revision: entry.source.revision,
				license: entry.license.spdx,
				licenseUrl: entry.license.url,
				bytes: entry.bytes,
				files: entry.files.map((part) => ({
					path: part.path,
					sha256: part.sha256,
					bytes: part.bytes,
				})),
				verifiedByMaestro: false,
			})
		);
		return;
	}

	if (options.dryRun) console.log(`${entry.displayName} (not added: --dry-run)`);
	else if (added) console.log(formatSuccess(`Added ${entry.displayName} to the Library`));
	else console.log(`${entry.displayName} was already in the Library.`);
	console.log(`  Id:       ${entry.id}`);
	console.log(`  License:  ${entry.license.spdx} (${entry.license.url})`);
	console.log(
		`  Size:     ${formatSize(entry.bytes)} in ${entry.files.length === 1 ? '1 file' : `${entry.files.length} files`}`
	);
	console.log(`  Source:   ${entry.source.repo}@${entry.source.revision.slice(0, 7)}`);
	console.log(formatWarning(`${USER_MODEL_UNVERIFIED_LABEL}. ${USER_MODEL_UNVERIFIED_DETAIL}`));
	if (!options.dryRun) console.log(`  Download it: maestro-cli models install ${entry.id}`);
}

/**
 * Take a model the user added out of the Library and delete its files. The
 * desktop decides which ids are user models (it owns the list), so an unknown
 * or curated id comes back as its refusal. The in-use guard is the same one
 * `models remove` applies.
 */
export async function modelsRemoveHf(modelId: string, options: RemoveOptions): Promise<void> {
	const tasks = tasksUsingLocalModel(
		readLocalModelAssignments(),
		modelId,
		parseUtilitySource(readSettingValue('utilitySource'))
	).map((task) => task.label);
	if (tasks.length > 0 && !options.force) {
		failCommand(
			`${getLocalModel(modelId)?.displayName ?? modelId} is assigned to ${tasks.join(', ')}. Removing it makes ${tasks.length === 1 ? 'that task' : 'those tasks'} unavailable. Re-run with --force to remove it anyway.`,
			options.json
		);
	}

	const reply = await send<{
		success: boolean;
		error?: string;
		id?: string;
		displayName?: string;
		bytes?: number;
	}>({ type: 'local_models_hf_remove', modelId }, 'local_models_hf_remove_result', options.json);
	const bytes = reply.bytes ?? 0;
	const name = reply.displayName ?? modelId;

	if (options.json) {
		console.log(JSON.stringify({ success: true, modelId, bytesReclaimed: bytes, tasks }));
		return;
	}
	console.log(formatSuccess(`Removed ${name} from the Library (${formatSize(bytes)} reclaimed)`));
	if (tasks.length > 0) {
		console.log(formatWarning(`Now unavailable: ${tasks.join(', ')}`));
	}
}

/** What the app answers a download with: the model's result, and its engine's. */
export type ModelDownloadOutcome = DownloadResult & { runtime?: LocalRuntimeEnsureResult };

/**
 * Ask the app to download one model and wait until the job settles. The round
 * trip behind `models install` and behind each model of `voice setup
 * --download`, which is the same Download button pressed for a bundle.
 */
export async function downloadModelOverBridge(
	modelId: string,
	json: boolean | undefined
): Promise<ModelDownloadOutcome> {
	const reply = await send<{ success: boolean; error?: string; result?: ModelDownloadOutcome }>(
		{ type: 'local_models_download', modelId },
		'local_models_download_result',
		json,
		INSTALL_TIMEOUT_MS
	);
	if (!reply.result) failCommand('Download failed', json);
	return reply.result;
}

/** The Library as the app reads it: every model joined to what is on disk. */
export async function listModelsOverBridge(
	json: boolean | undefined
): Promise<LocalModelListing[]> {
	const reply = await send<{ success: boolean; error?: string; listings?: LocalModelListing[] }>(
		{ type: 'local_models_list' },
		'local_models_list_result',
		json
	);
	return reply.listings ?? [];
}

export async function modelsInstall(modelId: string, options: JsonOption): Promise<void> {
	const entry = requireModel(modelId, options.json);
	if (entry.pending) {
		// The one download the catalog must never invite: weights nothing here can read.
		failCommand(
			`${entry.displayName} cannot run in this build, so it is not offered for download: ${entry.pending}`,
			options.json,
			ExitCode.InvalidUsage
		);
	}

	if (!options.json) {
		console.log(
			`Downloading ${entry.displayName} (${formatSize(entry.bytes)}), and its engine if that is missing. Progress shows in ${modelsSettingsLocation('library')}.`
		);
	}
	const result = await downloadModelOverBridge(modelId, options.json);

	if (result.status !== 'complete') {
		const why =
			result.status === 'error'
				? (result.error ?? 'Download failed')
				: `Download was ${result.status} in the app`;
		const mismatch = result.mismatch
			? ` (${result.mismatch.path}: expected ${result.mismatch.expected}, got ${result.mismatch.actual})`
			: '';
		if (options.json) {
			console.log(JSON.stringify({ ...result, success: false }));
			exitWith(ExitCode.GeneralError);
		}
		failCommand(`${why}${mismatch}`, false);
	}

	// The model arrived. Whether it can RUN also depends on its engine, which the
	// same call installs; a model reported as installed while its engine is
	// missing would send the caller to `models status` to find out why nothing works.
	const runtime = result.runtime;
	const runtimeFailed = runtime?.status === 'failed' || runtime?.status === 'unavailable';
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				modelId,
				status: result.status,
				...(runtime ? { runtime } : {}),
			})
		);
		return;
	}
	console.log(formatSuccess(`Installed ${entry.displayName}`));
	if (runtime?.status === 'installed') {
		console.log(`  Installed its engine too (${runtime.runtimeId}).`);
	}
	if (runtimeFailed && runtime) {
		console.log(
			formatWarning(
				runtime.status === 'unavailable'
					? `Its engine (${runtime.runtimeId}) has no build for this platform, so the model cannot run here.`
					: `Its engine (${runtime.runtimeId}) did not install: ${runtime.error ?? 'unknown error'}. Retry: maestro-cli models runtimes install ${runtime.runtimeId}`
			)
		);
	}
}

/**
 * Pause a running download and keep what arrived. There is no `resume` verb:
 * `models install` is the same call the row's Resume button makes, and it picks
 * the partial file back up.
 */
export async function modelsPause(modelId: string, options: JsonOption): Promise<void> {
	const entry = requireModel(modelId, options.json);

	const reply = await send<{ success: boolean; error?: string; paused?: boolean }>(
		{ type: 'local_models_pause', modelId },
		'local_models_pause_result',
		options.json
	);
	const paused = reply.paused === true;

	if (options.json) {
		console.log(JSON.stringify({ success: true, modelId, paused }));
		return;
	}
	if (!paused) {
		console.log(`${entry.displayName} is not downloading; nothing to pause.`);
		return;
	}
	console.log(formatSuccess(`Paused ${entry.displayName}`));
	console.log(`  Resume it: maestro-cli models install ${modelId}`);
}

/**
 * Cancel a download and delete everything it wrote, the partial file of a
 * paused one included. An installed model is not touched: that is `remove`.
 */
export async function modelsCancel(modelId: string, options: JsonOption): Promise<void> {
	const entry = requireModel(modelId, options.json);

	const reply = await send<{ success: boolean; error?: string; cancelled?: boolean }>(
		{ type: 'local_models_cancel', modelId },
		'local_models_cancel_result',
		options.json
	);
	const cancelled = reply.cancelled === true;

	if (options.json) {
		console.log(JSON.stringify({ success: true, modelId, cancelled }));
		return;
	}
	console.log(
		cancelled
			? formatSuccess(`Cancelled the download of ${entry.displayName}`)
			: `${entry.displayName} was not downloading; any partial file is cleared.`
	);
}

export async function modelsRemove(modelId: string, options: RemoveOptions): Promise<void> {
	const entry = requireModel(modelId, options.json);

	// Removing a model a task runs on turns that task unavailable. Settings names
	// the tasks and asks; here the ask is `--force`.
	const tasks = tasksUsingLocalModel(
		readLocalModelAssignments(),
		modelId,
		parseUtilitySource(readSettingValue('utilitySource'))
	).map((task) => task.label);
	if (tasks.length > 0 && !options.force) {
		failCommand(
			`${entry.displayName} is assigned to ${tasks.join(', ')}. Removing it makes ${tasks.length === 1 ? 'that task' : 'those tasks'} unavailable. Re-run with --force to remove it anyway.`,
			options.json
		);
	}

	const reply = await send<{ success: boolean; error?: string; bytes?: number }>(
		{ type: 'local_models_remove', modelId },
		'local_models_remove_result',
		options.json
	);
	const bytes = reply.bytes ?? 0;

	if (options.json) {
		console.log(JSON.stringify({ success: true, modelId, bytesReclaimed: bytes, tasks }));
		return;
	}
	console.log(formatSuccess(`Removed ${entry.displayName} (${formatSize(bytes)} reclaimed)`));
	if (tasks.length > 0) {
		console.log(formatWarning(`Now unavailable: ${tasks.join(', ')}`));
	}
	const voice = voiceModelUsageLabel(modelId);
	if (voice) console.log(formatWarning(`${voice} used this model.`));
}

export async function modelsVerify(modelId: string, options: JsonOption): Promise<void> {
	const entry = requireModel(modelId, options.json);

	const reply = await send<{ success: boolean; error?: string; result?: VerifyResult }>(
		{ type: 'local_models_verify', modelId },
		'local_models_verify_result',
		options.json,
		VERIFY_TIMEOUT_MS
	);
	const result = reply.result;
	if (!result) failCommand('Verify failed', options.json);

	if (options.json) {
		console.log(JSON.stringify({ ...result, success: result.ok }));
		if (!result.ok) exitWith(ExitCode.GeneralError);
		return;
	}
	if (!result.ok) {
		// Verify never deletes or re-downloads: say what disagreed and leave the
		// choice to spend the bandwidth again with the user.
		const mismatch = result.mismatch
			? ` (${result.mismatch.path}: expected ${result.mismatch.expected}, got ${result.mismatch.actual})`
			: '';
		failCommand(
			`${entry.displayName} is ${result.status}: ${result.detail ?? 'verify failed'}${mismatch}`,
			false
		);
	}
	console.log(formatSuccess(`${entry.displayName} verified`));
}
