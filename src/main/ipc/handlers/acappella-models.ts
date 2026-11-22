/**
 * A Cappella model IPC handlers.
 *
 * Voice's gated transport in front of the core Local Models service
 * (`src/main/local-models/service.ts`) plus the capability gate. Every model and
 * runtime operation delegates to that service, which the ungated core channels
 * in `local-models.ts` also call, so there is one implementation behind both.
 * This file adds only what is voice's own: the Encore gate, readiness, and the
 * voice slots on a runtime listing.
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
 *     feature that keeps your disk hostage. `models:remove-all` and
 *     `models:footprint` are scoped by `isVoiceReclaimableModelDir`, so the
 *     models another consumer runs (embeddings, the injection classifier, and
 *     any model a task other than voice routing is assigned to) survive voice
 *     being switched off.
 *
 * Progress is BROADCAST on `models:progress`, matching the multi-window
 * invariant in `src/main/utils/safe-send.ts`. Throttling happens at the source
 * (the downloader) rather than here.
 */

import { ipcMain } from 'electron';

import type { VoiceReadiness } from '../../../shared/acappella/readiness';
import { requireACappellaEnabled } from '../../../shared/acappella/feature-flag';
import { resolveVoiceReadiness } from '../../acappella/models/capability-gate';
import type { DownloadProgress, DownloadResult } from '../../local-models/model-downloader';
import type { ModelFootprint, VerifyResult } from '../../local-models/model-store';
import { readVoiceProviderSettings } from '../../acappella/providers/provider-registry';
import { registerACappellaRuntimeConsumer } from '../../acappella/runtime-consumer';
import type { RuntimeInstallProgress } from '../../local-models/runtime/runtime-installer';
import {
	cancelLocalModel,
	downloadLocalModel,
	installLocalRuntime,
	listLocalModels,
	listLocalRuntimes,
	localModelsFootprint,
	localRuntimesFootprint,
	onLocalModelProgress,
	onLocalRuntimeInstallProgress,
	pauseLocalModel,
	removeAllLocalModels,
	removeAllLocalRuntimes,
	removeLocalModel,
	resumeLocalModel,
	verifyLocalModel,
	type LocalModelListing,
	type LocalRuntimeListing,
} from '../../local-models/service';
import {
	isVoiceReclaimableModelDir,
	modelsAssignedOutsideVoice,
	voiceSlotsForRuntime,
} from '../../../shared/acappella/voice-models';
import type { LocalModelAssignments } from '../../../shared/local-models/tasks';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import type { SafeSendFn } from '../../utils/safe-send';

const LOG_CONTEXT = '[ACappellaModels]';

/** The push channel download progress goes out on. */
export const ACAPPELLA_MODEL_PROGRESS_CHANNEL = 'models:progress';

/** The push channel native-runtime install progress goes out on. */
export const ACAPPELLA_RUNTIME_PROGRESS_CHANNEL = 'runtimes:progress';

/**
 * One catalog entry joined to what is on disk. This is the row Voice Setup
 * renders; it is the core listing, unchanged.
 */
export type VoiceModelListing = LocalModelListing;

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

/** The Encore gate. See `src/shared/acappella/feature-flag.ts`. */
const requireEnabled = requireACappellaEnabled;

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
 * Which model directories "Remove All" and the footprint count as voice's.
 *
 * Read per call, because the answer depends on the task assignments as they
 * are right now: a model another task is assigned to is not voice's to delete
 * (see `isVoiceReclaimableModelDir`).
 */
function voiceReclaimFilter(
	settingsStore: ACappellaModelsHandlerDependencies['settingsStore']
): (id: string) => boolean {
	const assignedElsewhere = modelsAssignedOutsideVoice(
		settingsStore.get('localModelAssignments', {}) as LocalModelAssignments | undefined
	);
	return (id) => isVoiceReclaimableModelDir(id, assignedElsewhere);
}

/**
 * One native runtime joined to what is on disk, plus the voice slots that stop
 * working without it. The core listing names the MODELS that need a runtime;
 * which voice slot those models fill is voice's own derivation.
 */
export interface VoiceRuntimeListing extends LocalRuntimeListing {
	/** Slots that stop working without it. */
	slots: string[];
}

/** Unsubscribes from the previous registration, so re-registering never doubles broadcasts. */
let releaseProgressListeners: (() => void) | null = null;

/**
 * Register the A Cappella model handlers.
 *
 * Wired from `setupIpcHandlers()` (src/main/ipc/bootstrap/index.ts), which is
 * what the running app calls. A handler registered only through
 * `registerAllHandlers()` in handlers/index.ts would be dead.
 */
export function registerACappellaModelsHandlers(deps: ACappellaModelsHandlerDependencies): void {
	const { settingsStore, safeSend } = deps;

	// Tells the core loader which runtimes voice runs on. Before any handler can
	// answer, and whether or not the feature is on (see `runtime-consumer.ts`).
	registerACappellaRuntimeConsumer();

	// Re-registering drops the previous listeners, so broadcasts never double.
	releaseProgressListeners?.();
	const releaseModel = onLocalModelProgress((progress: DownloadProgress) => {
		safeSend(ACAPPELLA_MODEL_PROGRESS_CHANNEL, progress);
	});
	// Fanned out by the service, so an install started from the core channels is
	// visible to Voice Setup too.
	const releaseRuntime = onLocalRuntimeInstallProgress((progress: RuntimeInstallProgress) => {
		safeSend(ACAPPELLA_RUNTIME_PROGRESS_CHANNEL, progress);
	});
	releaseProgressListeners = () => {
		releaseModel();
		releaseRuntime();
	};

	// Every model call is the core service's. Listing is a pure disk read against
	// the frozen catalog: no metadata request, no HEAD, no revision lookup.
	const wrappedList = withIpcErrorLogging(
		handlerOpts('list'),
		async (): Promise<VoiceModelListing[]> => listLocalModels()
	);
	const wrappedDownload = withIpcErrorLogging(
		handlerOpts('download'),
		async (rawId: unknown): Promise<DownloadResult> => downloadLocalModel(rawId)
	);
	const wrappedPause = withIpcErrorLogging(
		handlerOpts('pause'),
		async (rawId: unknown): Promise<boolean> => pauseLocalModel(rawId)
	);
	const wrappedResume = withIpcErrorLogging(
		handlerOpts('resume'),
		async (rawId: unknown): Promise<DownloadResult> => resumeLocalModel(rawId)
	);
	const wrappedCancel = withIpcErrorLogging(
		handlerOpts('cancel'),
		async (rawId: unknown): Promise<boolean> => cancelLocalModel(rawId)
	);
	const wrappedVerify = withIpcErrorLogging(
		handlerOpts('verify'),
		async (rawId: unknown): Promise<VerifyResult> => verifyLocalModel(rawId)
	);
	const wrappedRemove = withIpcErrorLogging(
		handlerOpts('remove'),
		async (rawId: unknown): Promise<number> => removeLocalModel(rawId)
	);
	const wrappedRemoveAll = withIpcErrorLogging(
		handlerOpts('removeAll'),
		async (): Promise<number> => removeAllLocalModels(voiceReclaimFilter(settingsStore))
	);
	const wrappedFootprint = withIpcErrorLogging(
		handlerOpts('footprint'),
		async (): Promise<ModelFootprint> => localModelsFootprint(voiceReclaimFilter(settingsStore))
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

	// -- Native runtimes ------------------------------------------------------
	//
	// Same shape as the model channels above: the local tier needs a runtime as
	// well as a model, fetched on consent from a pinned npm tarball whose SHA-256
	// is in the build. The service owns the shared in-flight install and the
	// loader reset; voice only adds the slots each runtime serves.

	const wrappedRuntimeList = withIpcErrorLogging(
		handlerOpts('runtimes:list'),
		async (): Promise<VoiceRuntimeListing[]> =>
			(await listLocalRuntimes()).map((listing) => ({
				...listing,
				slots: voiceSlotsForRuntime(listing.id),
			}))
	);

	const wrappedRuntimeInstall = withIpcErrorLogging(
		handlerOpts('runtimes:install'),
		async (rawId: unknown): Promise<boolean> => {
			await installLocalRuntime(rawId);
			return true;
		}
	);

	const wrappedRuntimeFootprint = withIpcErrorLogging(
		handlerOpts('runtimes:footprint'),
		async (): Promise<number> => localRuntimesFootprint()
	);

	const wrappedRuntimeRemoveAll = withIpcErrorLogging(
		handlerOpts('runtimes:remove-all'),
		async (): Promise<void> => removeAllLocalRuntimes()
	);

	ipcMain.handle('runtimes:list', async (event): Promise<VoiceRuntimeListing[]> => {
		requireEnabled(settingsStore);
		return wrappedRuntimeList(event);
	});

	ipcMain.handle('runtimes:install', async (event, id: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return wrappedRuntimeInstall(event, id);
	});

	// Ungated, alongside `models:footprint` and `models:remove-all`: the
	// reclaim-disk offer exists precisely for the moment after the feature has
	// been switched off, and a runtime is the larger half of what it frees.
	ipcMain.handle('runtimes:footprint', wrappedRuntimeFootprint);
	ipcMain.handle('runtimes:remove-all', wrappedRuntimeRemoveAll);
}
