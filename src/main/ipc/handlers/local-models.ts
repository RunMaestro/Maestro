/**
 * Local Models IPC handlers (`localModels:*`).
 *
 * The core transport in front of `src/main/local-models/service.ts`. NOT gated
 * on any Encore Feature: Local Models is a core service with several consumers
 * (voice is one), so its catalog, downloads, and disk have to be reachable no
 * matter which consumer is switched on. A consumer that wants a gate applies it
 * on its own channels (see `acappella-models.ts`), never here.
 *
 * Registering these channels opens no socket and reads no remote metadata. The
 * only calls that reach the network are `download`, `resume`, and
 * `runtimes:install`, each of which a user pressed a button to send, plus the
 * `endpoints:*` calls, which talk to a model server the user runs.
 * `endpoints:detect` probes loopback only and saves nothing. `runTask` reaches
 * a model only when the user assigned one to that task. `taskReadiness` reads
 * disk and settings, and reaches the network only to list the models of an
 * endpoint a task is assigned to. `draftPullRequest` reads a local repository
 * and reaches a model only when the user assigned one to Git drafts.
 * `dictation:start` is the one call here that opens a device: the microphone,
 * and only for the window that asked, only while the Dictation task is ready.
 * `spokenNotices:*` makes sound on this machine: `agentFinished` only when the
 * user switched spoken notices on, `speak` because a person or an agent asked.
 * `hf:preview` and `hf:add` ask Hugging Face to describe the one repo the user
 * named; neither downloads a model. `hardware` reads the OS and a stored file.
 * `server:installEngine` downloads the model server engine and `server:start`
 * launches it, each because the user pressed that button; nothing here starts
 * the server on its own. `runOn:test` starts an agent's harness for one short
 * read-only turn on its Run on target, because the user pressed Test.
 *
 * Progress is BROADCAST, matching the multi-window invariant in
 * `src/main/utils/safe-send.ts`. A dictation is the exception: it belongs to
 * the one window recording it, so its interruption goes to that window alone.
 */

import { BrowserWindow, ipcMain, type WebContents } from 'electron';

import type {
	DetectedEndpoint,
	EndpointModelsResult,
	EndpointTestResult,
} from '../../local-models/endpoint-client';
import {
	detectNewLocalModelEndpoints,
	listLocalModelEndpointModels,
	testLocalModelEndpoint,
} from '../../local-models/endpoint-service';
import type { DownloadProgress, DownloadResult } from '../../local-models/model-downloader';
import type { ModelFootprint, VerifyResult } from '../../local-models/model-store';
import type { RuntimeInstallProgress } from '../../local-models/runtime/runtime-installer';
import {
	cancelDictation,
	onDictationInterrupted,
	startDictation,
	stopDictation,
} from '../../local-models/dictation';
import { draftPullRequestRequest } from '../../local-models/git-drafts';
import { testAgentRunOn } from '../../local-models/run-on-test';
import { routeTurnRequest } from '../../local-models/route-turn';
import type { RouteTurnResult } from '../../../shared/local-models/model-routing-task';
import type { RunOnTestResult } from '../../../shared/local-models/run-on';
import { listHarnessTierOptionsRequest } from '../../local-models/tier-options';
import type { HarnessTierOptions } from '../../../shared/local-models/tier-options';
import {
	announceAgentFinishedRequest,
	speakNoticeRequest,
} from '../../local-models/spoken-notices';
import { runLocalTaskRequest, type LocalTaskResult } from '../../local-models/task-router';
import { resolveTaskReadinessRequest } from '../../local-models/task-readiness';
import {
	onSemanticIndexProgress,
	semanticIndexProgress,
} from '../../local-models/semantic-indexer';
import { searchPastWorkRequest } from '../../local-models/work-search';
import {
	ensureTokenProxyPort,
	getTokenProxyReport,
	readTokenProxyBlock,
} from '../../local-models/proxy/service';
import { suggestTabCleanup } from '../../local-models/tab-cleanup';
import {
	getModelServerKey,
	onModelServerStateChange,
	startModelServer,
	stopModelServer,
} from '../../local-models/server/supervisor';
import {
	getModelServerReport,
	installModelServerEngine,
	onModelServerEngineProgress,
	updateModelServerConfigRequest,
} from '../../local-models/server/service';
import {
	clearSystemOneKeyRequest,
	getSystemOneReport,
	setSystemOneKeyRequest,
	testSystemOne,
	updateSystemOneSettingsRequest,
} from '../../local-models/system-one/service';
import {
	getSystemOneAgentAccessRequest,
	readSystemOneAgentUsage,
} from '../../local-models/system-one/agent-service';
import { readSystemOneLedger } from '../../local-models/system-one/decisions';
import type { SystemOneAgentAccess } from '../../../shared/local-models/system-one-agent';
import type { SystemOneLedgerPage } from '../../../shared/local-models/system-one-ledger';
import type { SystemOneUsageReport } from '../../../shared/local-models/system-one-spend';
import type {
	SystemOneReport,
	SystemOneTestResult,
} from '../../../shared/local-models/system-one-settings';
import type {
	ModelServerEngineProgress,
	ModelServerReport,
	ModelServerState,
	ModelServerStatus,
} from '../../../shared/local-models/model-server';
import type {
	DictationInterruption,
	DictationResult,
	DictationStartResult,
} from '../../../shared/local-models/dictation';
import type { SemanticIndexProgress } from '../../../shared/local-models/embedding-index';
import type { SpokenNoticeResult } from '../../../shared/spokenNotices';
import type { WorkSearchResult } from '../../../shared/local-models/work-search';
import type {
	TokenProxyBlockDetail,
	TokenProxyReport,
} from '../../../shared/local-models/token-proxy';
import type { LocalModelTaskReadiness } from '../../../shared/local-models/task-readiness';
import type { PullRequestDraftResult } from '../../../shared/gitDrafts';
import type { TabCleanupResult } from '../../../shared/tabCleanup';
import {
	cancelLocalModel,
	installLocalModel,
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
	type LocalModelInstallResult,
	type LocalRuntimeListing,
} from '../../local-models/service';
import { resolveHardwareProfile } from '../../local-models/hardware';
import {
	addHuggingFaceModel,
	listUserLocalModels,
	onUserLocalModelsChanged,
	previewHuggingFaceModel,
	removeUserLocalModel,
	type HuggingFaceModelAdded,
	type HuggingFaceModelPreview,
	type UserLocalModelRemoved,
} from '../../local-models/user-models';
import type { HardwareProfile } from '../../../shared/local-models/model-fit';
import type { LocalModelEntry } from '../../../shared/local-models/types';
import type { UserModelResult } from '../../../shared/local-models/user-models';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import type { SafeSendFn } from '../../utils/safe-send';

const LOG_CONTEXT = '[LocalModels]';

/** The push channel model download progress goes out on. */
export const LOCAL_MODEL_PROGRESS_CHANNEL = 'localModels:progress';

/** The push channel native-runtime install progress goes out on. */
export const LOCAL_RUNTIME_PROGRESS_CHANNEL = 'localModels:runtimes:progress';

/** The push channel the semantic indexer's progress goes out on. */
export const SEMANTIC_INDEX_PROGRESS_CHANNEL = 'localModels:semanticIndex:progress';

/** The push channel the model server's state changes go out on. */
export const MODEL_SERVER_CHANGED_CHANNEL = 'localModels:server:changed';

/** The push channel the model server engine's install progress goes out on. */
export const MODEL_SERVER_PROGRESS_CHANNEL = 'localModels:server:progress';

/** The push channel the user's added models go out on, whole, after every add or remove. */
export const USER_LOCAL_MODELS_CHANGED_CHANNEL = 'localModels:userModels:changed';

/** Pushed to the ONE window whose dictation ended on its own. Never broadcast. */
export const DICTATION_INTERRUPTED_CHANNEL = 'localModels:dictation:interrupted';

export interface LocalModelsHandlerDependencies {
	/** Broadcasts to every window and to the web-desktop bridge. */
	safeSend: SafeSendFn;
}

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/** Unsubscribes from the previous registration, so re-registering never doubles broadcasts. */
let releaseProgressListeners: (() => void) | null = null;

/**
 * The windows that have dictated, by owner id. A dictation is owned by the
 * window that started it: only that window may stop or cancel it, and it is
 * cancelled if the window goes away or reloads with the microphone still open.
 */
const dictationOwners = new Map<string, WebContents>();

/**
 * The window behind a dictation call, or null when there is none.
 *
 * A web-desktop client reaches these handlers through the bridge with a
 * placeholder event and no sender. Dictation records on THIS machine's
 * microphone, which is not where that person is speaking, so such a call is
 * refused by name instead of opening a device in another room.
 */
function dictationOwner(event: unknown): WebContents | null {
	const sender = (event as { sender?: Partial<WebContents> } | null)?.sender;
	return sender && typeof sender.id === 'number' && typeof sender.send === 'function'
		? (sender as WebContents)
		: null;
}

/** The owner id for a window, tracking it so its dictation dies with it. */
function claimDictationOwner(owner: WebContents): string {
	const ownerId = `window:${owner.id}`;
	if (dictationOwners.get(ownerId) === owner) return ownerId;
	dictationOwners.set(ownerId, owner);
	// A reload loses the page that was showing "recording"; nothing would ever
	// stop the microphone it left open.
	const abandon = () => void cancelDictation(ownerId);
	owner.on('did-navigate', abandon);
	owner.once('destroyed', () => {
		dictationOwners.delete(ownerId);
		abandon();
	});
	return ownerId;
}

/**
 * Register the core Local Models handlers.
 *
 * Wired from `setupIpcHandlers()` (src/main/ipc/bootstrap/index.ts), which is
 * what the running app calls. A handler registered only through
 * `registerAllHandlers()` in handlers/index.ts would be dead.
 */
export function registerLocalModelsHandlers(deps: LocalModelsHandlerDependencies): void {
	const { safeSend } = deps;

	releaseProgressListeners?.();
	const releaseModel = onLocalModelProgress((progress: DownloadProgress) => {
		safeSend(LOCAL_MODEL_PROGRESS_CHANNEL, progress);
	});
	const releaseRuntime = onLocalRuntimeInstallProgress((progress: RuntimeInstallProgress) => {
		safeSend(LOCAL_RUNTIME_PROGRESS_CHANNEL, progress);
	});
	const releaseIndex = onSemanticIndexProgress((progress: SemanticIndexProgress) => {
		safeSend(SEMANTIC_INDEX_PROGRESS_CHANNEL, progress);
	});
	const releaseDictation = onDictationInterrupted(
		(ownerId: string, interruption: DictationInterruption) => {
			const owner = dictationOwners.get(ownerId);
			if (owner && !owner.isDestroyed()) owner.send(DICTATION_INTERRUPTED_CHANNEL, interruption);
		}
	);
	const releaseServerState = onModelServerStateChange((state: ModelServerState) => {
		safeSend(MODEL_SERVER_CHANGED_CHANNEL, state);
	});
	const releaseServerProgress = onModelServerEngineProgress(
		(progress: ModelServerEngineProgress) => {
			safeSend(MODEL_SERVER_PROGRESS_CHANNEL, progress);
		}
	);
	const releaseUserModels = onUserLocalModelsChanged((entries: readonly LocalModelEntry[]) => {
		safeSend(USER_LOCAL_MODELS_CHANGED_CHANNEL, entries);
	});
	releaseProgressListeners = () => {
		releaseUserModels();
		releaseModel();
		releaseRuntime();
		releaseIndex();
		releaseDictation();
		releaseServerState();
		releaseServerProgress();
	};

	ipcMain.handle(
		'localModels:list',
		withIpcErrorLogging(
			handlerOpts('list'),
			async (): Promise<LocalModelListing[]> => listLocalModels()
		)
	);
	ipcMain.handle(
		'localModels:download',
		withIpcErrorLogging(
			handlerOpts('download'),
			// The model AND the runtime that reads it: this channel is the Local
			// Models tab's Download button, which means "make this model work".
			async (id: unknown): Promise<LocalModelInstallResult> => installLocalModel(id)
		)
	);
	ipcMain.handle(
		'localModels:pause',
		withIpcErrorLogging(
			handlerOpts('pause'),
			async (id: unknown): Promise<boolean> => pauseLocalModel(id)
		)
	);
	ipcMain.handle(
		'localModels:resume',
		withIpcErrorLogging(
			handlerOpts('resume'),
			async (id: unknown): Promise<DownloadResult> => resumeLocalModel(id)
		)
	);
	ipcMain.handle(
		'localModels:cancel',
		withIpcErrorLogging(
			handlerOpts('cancel'),
			async (id: unknown): Promise<boolean> => cancelLocalModel(id)
		)
	);
	ipcMain.handle(
		'localModels:verify',
		withIpcErrorLogging(
			handlerOpts('verify'),
			async (id: unknown): Promise<VerifyResult> => verifyLocalModel(id)
		)
	);
	ipcMain.handle(
		'localModels:remove',
		withIpcErrorLogging(
			handlerOpts('remove'),
			async (id: unknown): Promise<number> => removeLocalModel(id)
		)
	);
	ipcMain.handle(
		'localModels:remove-all',
		withIpcErrorLogging(
			handlerOpts('removeAll'),
			async (): Promise<number> => removeAllLocalModels()
		)
	);
	ipcMain.handle(
		'localModels:footprint',
		withIpcErrorLogging(
			handlerOpts('footprint'),
			async (): Promise<ModelFootprint> => localModelsFootprint()
		)
	);

	ipcMain.handle(
		'localModels:hardware',
		withIpcErrorLogging(
			handlerOpts('hardware'),
			// What the fit labels are judged against. Reads the OS and the stored
			// engine record; never runs a binary.
			async (): Promise<HardwareProfile> => resolveHardwareProfile()
		)
	);
	ipcMain.handle(
		'localModels:userModels',
		withIpcErrorLogging(
			handlerOpts('userModels'),
			async (): Promise<readonly LocalModelEntry[]> => listUserLocalModels()
		)
	);
	ipcMain.handle(
		'localModels:hf:preview',
		withIpcErrorLogging(
			handlerOpts('hf:preview'),
			async (repo: unknown, file: unknown): Promise<UserModelResult<HuggingFaceModelPreview>> =>
				previewHuggingFaceModel(repo, file)
		)
	);
	ipcMain.handle(
		'localModels:hf:add',
		withIpcErrorLogging(
			handlerOpts('hf:add'),
			async (repo: unknown, file: unknown): Promise<UserModelResult<HuggingFaceModelAdded>> =>
				addHuggingFaceModel(repo, file)
		)
	);
	ipcMain.handle(
		'localModels:hf:remove',
		withIpcErrorLogging(
			handlerOpts('hf:remove'),
			async (id: unknown): Promise<UserModelResult<UserLocalModelRemoved>> =>
				removeUserLocalModel(id)
		)
	);

	ipcMain.handle(
		'localModels:runtimes:list',
		withIpcErrorLogging(
			handlerOpts('runtimes:list'),
			async (): Promise<LocalRuntimeListing[]> => listLocalRuntimes()
		)
	);
	ipcMain.handle(
		'localModels:runtimes:install',
		withIpcErrorLogging(handlerOpts('runtimes:install'), async (id: unknown): Promise<boolean> => {
			await installLocalRuntime(id);
			return true;
		})
	);
	ipcMain.handle(
		'localModels:runtimes:footprint',
		withIpcErrorLogging(
			handlerOpts('runtimes:footprint'),
			async (): Promise<number> => localRuntimesFootprint()
		)
	);
	ipcMain.handle(
		'localModels:runtimes:remove-all',
		withIpcErrorLogging(
			handlerOpts('runtimes:remove-all'),
			async (): Promise<void> => removeAllLocalRuntimes()
		)
	);

	ipcMain.handle(
		'localModels:endpoints:detect',
		withIpcErrorLogging(
			handlerOpts('endpoints:detect'),
			async (): Promise<DetectedEndpoint[]> => detectNewLocalModelEndpoints()
		)
	);
	ipcMain.handle(
		'localModels:endpoints:listModels',
		withIpcErrorLogging(
			handlerOpts('endpoints:listModels'),
			async (ref: unknown): Promise<EndpointModelsResult> => listLocalModelEndpointModels(ref)
		)
	);
	ipcMain.handle(
		'localModels:endpoints:test',
		withIpcErrorLogging(
			handlerOpts('endpoints:test'),
			async (ref: unknown, model?: unknown): Promise<EndpointTestResult> =>
				testLocalModelEndpoint(ref, model)
		)
	);

	ipcMain.handle(
		'localModels:runTask',
		withIpcErrorLogging(
			handlerOpts('runTask'),
			async (taskId: unknown, input: unknown): Promise<LocalTaskResult> =>
				runLocalTaskRequest(taskId, input)
		)
	);

	ipcMain.handle(
		'localModels:taskReadiness',
		withIpcErrorLogging(
			handlerOpts('taskReadiness'),
			async (taskId?: unknown): Promise<LocalModelTaskReadiness[]> =>
				resolveTaskReadinessRequest(taskId)
		)
	);

	ipcMain.handle(
		'localModels:semanticIndex:status',
		withIpcErrorLogging(
			handlerOpts('semanticIndex:status'),
			async (): Promise<SemanticIndexProgress> => semanticIndexProgress()
		)
	);

	// The Maestro token proxy. `report` and `block` read; `ensurePort` is the
	// one write, and it only chooses and persists the port the first time.
	ipcMain.handle(
		'localModels:proxy:report',
		withIpcErrorLogging(
			handlerOpts('proxy:report'),
			async (): Promise<TokenProxyReport> => getTokenProxyReport()
		)
	);

	ipcMain.handle(
		'localModels:proxy:ensurePort',
		withIpcErrorLogging(
			handlerOpts('proxy:ensurePort'),
			async (): Promise<number> => ensureTokenProxyPort()
		)
	);

	ipcMain.handle(
		'localModels:proxy:block',
		withIpcErrorLogging(
			handlerOpts('proxy:block'),
			async (hash: unknown): Promise<TokenProxyBlockDetail | null> => readTokenProxyBlock(hash)
		)
	);

	// The Maestro model server. `report` and `key` read (the key is made on first
	// use); `start`, `stop`, `set` and `installEngine` are the card's buttons.
	ipcMain.handle(
		'localModels:server:report',
		withIpcErrorLogging(
			handlerOpts('server:report'),
			async (): Promise<ModelServerReport> => getModelServerReport()
		)
	);
	ipcMain.handle(
		'localModels:server:start',
		withIpcErrorLogging(
			handlerOpts('server:start'),
			async (): Promise<ModelServerStatus> => startModelServer()
		)
	);
	ipcMain.handle(
		'localModels:server:stop',
		withIpcErrorLogging(
			handlerOpts('server:stop'),
			async (): Promise<ModelServerStatus> => stopModelServer()
		)
	);
	ipcMain.handle(
		'localModels:server:set',
		withIpcErrorLogging(
			handlerOpts('server:set'),
			async (patch: unknown): Promise<ModelServerStatus> => updateModelServerConfigRequest(patch)
		)
	);
	ipcMain.handle(
		'localModels:server:key',
		withIpcErrorLogging(handlerOpts('server:key'), async (): Promise<string> => getModelServerKey())
	);
	ipcMain.handle(
		'localModels:server:installEngine',
		withIpcErrorLogging(
			handlerOpts('server:installEngine'),
			async (choice: unknown): Promise<ModelServerReport> => installModelServerEngine(choice)
		)
	);

	// System One: the engine, its key and the Test. `report` reads; no channel
	// returns a key, and `test` is the only one that sends anything anywhere.
	ipcMain.handle(
		'localModels:systemOne:report',
		withIpcErrorLogging(
			handlerOpts('systemOne:report'),
			async (): Promise<SystemOneReport> => getSystemOneReport()
		)
	);
	ipcMain.handle(
		'localModels:systemOne:set',
		withIpcErrorLogging(
			handlerOpts('systemOne:set'),
			async (patch: unknown): Promise<SystemOneReport> => updateSystemOneSettingsRequest(patch)
		)
	);
	ipcMain.handle(
		'localModels:systemOne:setKey',
		withIpcErrorLogging(
			handlerOpts('systemOne:setKey'),
			async (request: unknown): Promise<SystemOneReport> => setSystemOneKeyRequest(request)
		)
	);
	ipcMain.handle(
		'localModels:systemOne:clearKey',
		withIpcErrorLogging(
			handlerOpts('systemOne:clearKey'),
			async (request: unknown): Promise<SystemOneReport> => clearSystemOneKeyRequest(request)
		)
	);
	ipcMain.handle(
		'localModels:systemOne:test',
		withIpcErrorLogging(
			handlerOpts('systemOne:test'),
			async (): Promise<SystemOneTestResult> => testSystemOne()
		)
	);

	// Whether a System One request from one agent would be answered right now:
	// what the renderer's system prompt builder gates the System One section on.
	// Reads the settings and the day's count; sends nothing.
	ipcMain.handle(
		'localModels:systemOne:agentAccess',
		withIpcErrorLogging(
			handlerOpts('systemOne:agentAccess'),
			async (agentId: unknown): Promise<SystemOneAgentAccess> =>
				getSystemOneAgentAccessRequest(agentId)
		)
	);

	// What agents' own requests came to, per agent, with today's spend against
	// the budget: the table under "Let agents use System One". The same
	// function `maestro-cli s1 usage` reaches. Reads the ledger and the day's
	// count; sends nothing.
	ipcMain.handle(
		'localModels:systemOne:usage',
		withIpcErrorLogging(
			handlerOpts('systemOne:usage'),
			async (query: unknown): Promise<SystemOneUsageReport> => readSystemOneAgentUsage(query)
		)
	);

	// The decision ledger: what System One decided and what happened when it
	// could not. Reads `stats.db`; sends nothing and changes no setting.
	ipcMain.handle(
		'localModels:systemOne:ledger',
		withIpcErrorLogging(
			handlerOpts('systemOne:ledger'),
			async (query: unknown): Promise<SystemOneLedgerPage> => readSystemOneLedger(query)
		)
	);

	ipcMain.handle(
		'localModels:runOn:test',
		withIpcErrorLogging(
			handlerOpts('runOn:test'),
			async (request: unknown): Promise<RunOnTestResult> => testAgentRunOn(request)
		)
	);

	ipcMain.handle(
		'localModels:tiers:options',
		withIpcErrorLogging(
			handlerOpts('tiers:options'),
			async (request: unknown): Promise<HarnessTierOptions[]> =>
				listHarnessTierOptionsRequest(request)
		)
	);

	ipcMain.handle(
		'localModels:search',
		withIpcErrorLogging(
			handlerOpts('search'),
			async (request: unknown): Promise<WorkSearchResult> => searchPastWorkRequest(request)
		)
	);

	// How much model and effort one turn needs: what a send on the Auto model
	// asks before it launches. The same function `maestro-cli` reaches over
	// `model_route_turn`. A routing answers within its timeout and never rejects;
	// only a request that cannot be read does.
	ipcMain.handle(
		'localModels:routeTurn',
		withIpcErrorLogging(
			handlerOpts('routeTurn'),
			async (request: unknown): Promise<RouteTurnResult> => routeTurnRequest(request)
		)
	);

	ipcMain.handle(
		'localModels:draftPullRequest',
		withIpcErrorLogging(
			handlerOpts('draftPullRequest'),
			async (request: unknown): Promise<PullRequestDraftResult> => draftPullRequestRequest(request)
		)
	);

	ipcMain.handle(
		'localModels:suggestTabCleanup',
		withIpcErrorLogging(
			handlerOpts('suggestTabCleanup'),
			async (): Promise<TabCleanupResult> => suggestTabCleanup()
		)
	);

	// Spoken notices. Focus is read here, at the transport: the core stays free
	// of Electron, and "is Maestro in front" is a question about its windows.
	ipcMain.handle(
		'localModels:spokenNotices:agentFinished',
		withIpcErrorLogging(
			handlerOpts('spokenNotices:agentFinished'),
			async (notice: unknown): Promise<SpokenNoticeResult> =>
				announceAgentFinishedRequest(notice, {
					appFocused: BrowserWindow.getFocusedWindow() !== null,
					safeSend,
				})
		)
	);
	ipcMain.handle(
		'localModels:spokenNotices:speak',
		withIpcErrorLogging(
			handlerOpts('spokenNotices:speak'),
			async (text: unknown): Promise<SpokenNoticeResult> => speakNoticeRequest(text)
		)
	);

	// Dictation. Each handler needs the calling window, which
	// `withIpcErrorLogging` strips, so the sender is resolved first and passed
	// through as the handler's one argument.
	const dictationStart = withIpcErrorLogging(
		handlerOpts('dictation:start'),
		async (owner: WebContents | null): Promise<DictationStartResult> => {
			if (!owner) {
				return {
					started: false,
					code: 'no-microphone',
					message:
						'Dictation records on the computer running Maestro, so it is not available from a browser.',
				};
			}
			return startDictation(claimDictationOwner(owner));
		}
	);
	const dictationStop = withIpcErrorLogging(
		handlerOpts('dictation:stop'),
		async (owner: WebContents | null): Promise<DictationResult> =>
			owner ? stopDictation(claimDictationOwner(owner)) : { status: 'idle' }
	);
	const dictationCancel = withIpcErrorLogging(
		handlerOpts('dictation:cancel'),
		async (owner: WebContents | null): Promise<void> => {
			if (owner) await cancelDictation(claimDictationOwner(owner));
		}
	);
	ipcMain.handle('localModels:dictation:start', (event) =>
		dictationStart(event, dictationOwner(event))
	);
	ipcMain.handle('localModels:dictation:stop', (event) =>
		dictationStop(event, dictationOwner(event))
	);
	ipcMain.handle('localModels:dictation:cancel', (event) =>
		dictationCancel(event, dictationOwner(event))
	);
}
