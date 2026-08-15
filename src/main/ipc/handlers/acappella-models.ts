/**
 * A Cappella model IPC handlers.
 *
 * The transport in front of the model store, the downloader, and the capability
 * gate. Thin by the same rule as `acappella.ts`: every policy that matters lives
 * in `src/main/acappella/models/`, and this file only turns channels into calls.
 *
 * Two properties this module is responsible for:
 *
 *   - **Enabling the Encore Feature touches the network exactly never.**
 *     Registering these channels constructs nothing, opens no socket, and reads
 *     no remote metadata. `models:list` is a disk read against a frozen local
 *     catalog. The first byte of traffic in the whole subsystem is a
 *     `models:download` the user pressed a button to send.
 *   - **Disk is reclaimable after the feature is switched off.** `models:remove`,
 *     `models:remove-all`, and `models:footprint` stay callable with the flag
 *     off, following the `stop-session` precedent: a feature that hides the
 *     button that frees 1.4 GB the moment you stop wanting the feature is a
 *     feature that keeps your disk hostage.
 *
 * Progress is BROADCAST on `models:progress`, matching the multi-window
 * invariant in `src/main/utils/safe-send.ts`. Throttling happens at the source
 * (the downloader) rather than here.
 */

import { ipcMain } from 'electron';

import {
	VOICE_MODEL_CATALOG,
	getVoiceModel,
	type VoiceModelEntry,
} from '../../../shared/acappella/model-catalog';
import type { VoiceReadiness } from '../../../shared/acappella/readiness';
import { resolveVoiceReadiness } from '../../acappella/models/capability-gate';
import {
	getModelDownloader,
	type DownloadProgress,
	type DownloadResult,
} from '../../acappella/models/model-downloader';
import {
	installPathFor,
	listStatuses,
	remove,
	removeAll,
	totalFootprint,
	verify,
	type ModelFootprint,
	type ModelStatus,
	type VerifyResult,
} from '../../acappella/models/model-store';
import { readVoiceProviderSettings } from '../../acappella/providers/provider-registry';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import type { SafeSendFn } from '../../utils/safe-send';

const LOG_CONTEXT = '[ACappellaModels]';

/** The push channel download progress goes out on. */
export const ACAPPELLA_MODEL_PROGRESS_CHANNEL = 'models:progress';

/**
 * One catalog entry joined to what is on disk. This is the row Voice Setup
 * renders: the bill of materials and its install state in one object, so the UI
 * never has to correlate two lists.
 */
export interface VoiceModelListing {
	entry: VoiceModelEntry;
	status: ModelStatus;
	/** Absolute install paths, one per catalog file, for the "where does this go" line. */
	installPaths: string[];
}

export interface ACappellaModelsHandlerDependencies {
	settingsStore: {
		get: (key: string, defaultValue?: unknown) => unknown;
	};
	/** Broadcasts to every window and to the web-desktop bridge. */
	safeSend: SafeSendFn;
}

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

function isACappellaEnabled(
	settingsStore: ACappellaModelsHandlerDependencies['settingsStore']
): boolean {
	const flags = (settingsStore.get('encoreFeatures', {}) ?? {}) as Record<string, unknown>;
	return flags.aCappella === true;
}

function requireEnabled(settingsStore: ACappellaModelsHandlerDependencies['settingsStore']): void {
	if (!isACappellaEnabled(settingsStore)) throw new Error('ACappellaDisabled');
}

/** Reject anything that is not a catalog id before it can reach a path join. */
function requireModelId(raw: unknown): string {
	if (typeof raw !== 'string' || !getVoiceModel(raw)) throw new Error('UnknownVoiceModel');
	return raw;
}

/**
 * Readiness for the current settings.
 *
 * Read fresh every call rather than cached: a model finishing its download, a
 * file going corrupt, and an API key being pasted all change the answer, and a
 * stale "not ready" is a disabled button nobody can explain.
 */
export async function readVoiceReadiness(
	settingsStore: ACappellaModelsHandlerDependencies['settingsStore']
): Promise<VoiceReadiness> {
	const stored = (settingsStore.get('acappella', {}) ?? {}) as { handsFree?: unknown };
	// No `hasApiKey` override: keys live in the OS keychain, never in settings, so
	// the gate's default (which reads the keychain) is the only correct answer.
	return resolveVoiceReadiness({
		settings: readVoiceProviderSettings(settingsStore),
		handsFreeEnabled: stored.handsFree === true,
	});
}

/**
 * Register the A Cappella model handlers.
 *
 * Wired from `setupIpcHandlers()` (src/main/ipc/bootstrap/index.ts), which is
 * what the running app calls. A handler registered only through
 * `registerAllHandlers()` in handlers/index.ts would be dead.
 */
export function registerACappellaModelsHandlers(deps: ACappellaModelsHandlerDependencies): void {
	const { settingsStore, safeSend } = deps;

	// Subscribed once, for the life of the app. The downloader is a singleton and
	// its listener set would otherwise grow one entry per registration.
	getModelDownloader().onProgress((progress: DownloadProgress) => {
		safeSend(ACAPPELLA_MODEL_PROGRESS_CHANNEL, progress);
	});

	const wrappedList = withIpcErrorLogging(
		handlerOpts('list'),
		// A pure disk read against the frozen catalog. No metadata request, no HEAD,
		// no revision lookup: the catalog already knows every size and hash, which is
		// the whole reason it is pinned.
		async (): Promise<VoiceModelListing[]> => {
			const statuses = await listStatuses();
			return VOICE_MODEL_CATALOG.map((entry, index) => ({
				entry,
				status: statuses[index],
				installPaths: entry.files.map((file) => installPathFor(entry, file)),
			}));
		}
	);

	const wrappedDownload = withIpcErrorLogging(
		handlerOpts('download'),
		async (rawId: unknown): Promise<DownloadResult> =>
			getModelDownloader().download(requireModelId(rawId))
	);

	const wrappedPause = withIpcErrorLogging(
		handlerOpts('pause'),
		async (rawId: unknown): Promise<boolean> => getModelDownloader().pause(requireModelId(rawId))
	);

	const wrappedResume = withIpcErrorLogging(
		handlerOpts('resume'),
		async (rawId: unknown): Promise<DownloadResult> =>
			getModelDownloader().resume(requireModelId(rawId))
	);

	const wrappedCancel = withIpcErrorLogging(
		handlerOpts('cancel'),
		async (rawId: unknown): Promise<boolean> => getModelDownloader().cancel(requireModelId(rawId))
	);

	const wrappedVerify = withIpcErrorLogging(
		handlerOpts('verify'),
		async (rawId: unknown): Promise<VerifyResult> => verify(requireModelId(rawId))
	);

	const wrappedRemove = withIpcErrorLogging(
		handlerOpts('remove'),
		async (rawId: unknown): Promise<number> => {
			const id = requireModelId(rawId);
			// Cancel first: deleting the directory under a live writer would let the
			// writer recreate the file it was told to stop writing.
			await getModelDownloader().cancel(id);
			return remove(id);
		}
	);

	const wrappedRemoveAll = withIpcErrorLogging(
		handlerOpts('removeAll'),
		async (): Promise<number> => {
			await getModelDownloader().cancelAll();
			return removeAll();
		}
	);

	const wrappedFootprint = withIpcErrorLogging(
		handlerOpts('footprint'),
		async (): Promise<ModelFootprint> => totalFootprint()
	);

	const wrappedReadiness = withIpcErrorLogging(
		handlerOpts('readiness'),
		async (): Promise<VoiceReadiness> => readVoiceReadiness(settingsStore)
	);

	ipcMain.handle('models:list', async (event): Promise<VoiceModelListing[]> => {
		requireEnabled(settingsStore);
		return wrappedList(event);
	});

	ipcMain.handle('models:download', async (event, id: unknown): Promise<DownloadResult> => {
		requireEnabled(settingsStore);
		return wrappedDownload(event, id);
	});

	ipcMain.handle('models:pause', async (event, id: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return wrappedPause(event, id);
	});

	ipcMain.handle('models:resume', async (event, id: unknown): Promise<DownloadResult> => {
		requireEnabled(settingsStore);
		return wrappedResume(event, id);
	});

	// Ungated: a download in flight when the feature is switched off must still be
	// stoppable, or the app keeps pulling gigabytes for a feature that is now off.
	ipcMain.handle('models:cancel', wrappedCancel);

	ipcMain.handle('models:verify', async (event, id: unknown): Promise<VerifyResult> => {
		requireEnabled(settingsStore);
		return wrappedVerify(event, id);
	});

	// Ungated, with `models:footprint` and `models:remove-all`: the reclaim-disk
	// offer appears exactly when the Encore Feature has just been turned OFF.
	ipcMain.handle('models:remove', wrappedRemove);
	ipcMain.handle('models:remove-all', wrappedRemoveAll);
	ipcMain.handle('models:footprint', wrappedFootprint);

	ipcMain.handle('models:readiness', async (event): Promise<VoiceReadiness> => {
		requireEnabled(settingsStore);
		return wrappedReadiness(event);
	});
}
