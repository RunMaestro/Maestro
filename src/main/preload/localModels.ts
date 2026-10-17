/**
 * Preload API for the core Local Models service.
 *
 * Provides the `window.maestro.localModels` namespace. Unlike
 * `window.maestro.voice.models`, nothing here is gated on an Encore Feature:
 * Local Models is a core service, and voice is one consumer of it. Both
 * namespaces reach the same main-process service, so a download started from
 * one is the same transfer the other sees.
 *
 * Nothing in here touches the network except {@link download}, {@link resume},
 * `runtimes.install`, and the `endpoints.*` calls, which talk to model servers
 * the user runs. `list()` is a disk read against a frozen local catalog.
 * `taskReadiness()` lists an endpoint's models only when a task is assigned to
 * one. `draftPullRequest()` reaches a model only when Git drafts is assigned
 * one, and `suggestTabCleanup()` only when Tab cleanup suggestions is.
 * `semanticIndex.*` reads the indexer's in-memory progress. `dictation.start()`
 * is the one call that opens a device: the microphone, for this window only.
 * `spokenNotices.*` makes sound on this machine's speakers. `server.start()`
 * launches the model server and `server.installEngine()` downloads its engine.
 * `runOn.test()` starts an agent's harness for one short turn on its Run on
 * target.
 */

import { ipcRenderer } from 'electron';
import type {
	LocalModelInstallResult,
	LocalModelListing,
	LocalRuntimeListing,
} from '../local-models/service';
import type {
	DetectedEndpoint,
	EndpointModelsResult,
	EndpointTestResult,
} from '../local-models/endpoint-client';
import type { LocalModelEndpoint } from '../../shared/local-models/endpoints';
import type { RunOnTestRequest, RunOnTestResult } from '../../shared/local-models/run-on';
import type { HarnessTierOptions } from '../../shared/local-models/tier-options';
import type {
	TokenProxyBlockDetail,
	TokenProxyReport,
} from '../../shared/local-models/token-proxy';
import type { DownloadProgress, DownloadResult } from '../local-models/model-downloader';
import type { ModelFootprint, VerifyResult } from '../local-models/model-store';
import type { RuntimeInstallProgress } from '../local-models/runtime/runtime-installer';
import type { LocalTaskInput, LocalTaskResult } from '../local-models/task-router';
import type { LocalModelTaskId } from '../../shared/local-models/tasks';
import type { LocalModelTaskReadiness } from '../../shared/local-models/task-readiness';
import type { PullRequestDraftRequest, PullRequestDraftResult } from '../../shared/gitDrafts';
import type {
	DictationInterruption,
	DictationResult,
	DictationStartResult,
} from '../../shared/local-models/dictation';
import type { SemanticIndexProgress } from '../../shared/local-models/embedding-index';
import type { AgentFinishedNotice, SpokenNoticeResult } from '../../shared/spokenNotices';
import type { WorkSearchRequest, WorkSearchResult } from '../../shared/local-models/work-search';
import type {
	RouteTurnRequest,
	RouteTurnResult,
} from '../../shared/local-models/model-routing-task';
import type { TabCleanupResult } from '../../shared/tabCleanup';
import type {
	ModelServerBind,
	ModelServerEngineProgress,
	ModelServerReport,
	ModelServerState,
	ModelServerStatus,
} from '../../shared/local-models/model-server';
import type { ServerBuildChoice } from '../../shared/local-models/server-engine';
import type { SystemOneRemoteEngineId } from '../../shared/local-models/system-one';
import type { SystemOneAgentAccess } from '../../shared/local-models/system-one-agent';
import type {
	SystemOneLedgerPage,
	SystemOneLedgerQuery,
} from '../../shared/local-models/system-one-ledger';
import type {
	SystemOneUsageQuery,
	SystemOneUsageReport,
} from '../../shared/local-models/system-one-spend';
import type {
	SystemOneReport,
	SystemOneSettingsPatch,
	SystemOneTestResult,
} from '../../shared/local-models/system-one-settings';
import type { HardwareProfile } from '../../shared/local-models/model-fit';
import type { LocalModelEntry } from '../../shared/local-models/types';
import type { UserModelResult } from '../../shared/local-models/user-models';
import type {
	HuggingFaceModelAdded,
	HuggingFaceModelPreview,
	UserLocalModelRemoved,
} from '../local-models/user-models';

/** Subscribe to one broadcast channel; returns the unsubscribe. */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
	const wrappedHandler = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload);
	ipcRenderer.on(channel, wrappedHandler);
	return () => ipcRenderer.removeListener(channel, wrappedHandler);
}

/**
 * `window.maestro.localModels.runtimes.*` - the native engines local models run
 * on. `install()` is the only call here that opens a connection, and a second
 * call for a runtime already installing joins the first.
 */
function createLocalRuntimesApi() {
	return {
		/** Every native runtime joined to its on-disk state and download size. */
		list: (): Promise<LocalRuntimeListing[]> => ipcRenderer.invoke('localModels:runtimes:list'),

		/** Download, verify, and install one runtime. Resolves when it is usable. */
		install: (runtimeId: string): Promise<boolean> =>
			ipcRenderer.invoke('localModels:runtimes:install', runtimeId),

		/** Disk used by downloaded runtimes. */
		footprint: (): Promise<number> => ipcRenderer.invoke('localModels:runtimes:footprint'),

		/** Delete every downloaded runtime. */
		removeAll: (): Promise<void> => ipcRenderer.invoke('localModels:runtimes:remove-all'),

		/** Install progress. Broadcast, so every window sees the same transfer. */
		onProgress: (handler: (progress: RuntimeInstallProgress) => void): (() => void) =>
			subscribe('localModels:runtimes:progress', handler),
	};
}

/**
 * `window.maestro.localModels.endpoints.*` - model servers the user runs
 * (Ollama, LM Studio, OpenAI-compatible). The configured list itself is the
 * `localModelEndpoints` setting. An endpoint is named by saved id or passed as
 * a whole record, so a form can test before it saves. Failures come back as
 * `{ ok: false, error }` rather than a rejection, keeping the error `kind`.
 */
function createLocalModelEndpointsApi() {
	return {
		/**
		 * Probe the default Ollama and LM Studio ports on loopback and return the
		 * running servers that are not configured. Adds nothing.
		 */
		detect: (): Promise<DetectedEndpoint[]> => ipcRenderer.invoke('localModels:endpoints:detect'),

		/** The models one endpoint serves right now. */
		listModels: (endpoint: string | LocalModelEndpoint): Promise<EndpointModelsResult> =>
			ipcRenderer.invoke('localModels:endpoints:listModels', endpoint),

		/** A one-token chat, reporting latency. `model` defaults to the first listed. */
		test: (endpoint: string | LocalModelEndpoint, model?: string): Promise<EndpointTestResult> =>
			ipcRenderer.invoke('localModels:endpoints:test', endpoint, model),
	};
}

/**
 * `window.maestro.localModels.runOn.*` - an agent's Run on target. The target
 * itself is a field of the agent record; this is the one call that needs the
 * main process.
 */
function createRunOnApi() {
	return {
		/**
		 * Send one short read-only turn through the agent's harness on its Run on
		 * target (the stored one, or `request.target` for a form not saved yet). A
		 * target that cannot run comes back as `{ ok: false, code, message }`.
		 */
		test: (request: RunOnTestRequest): Promise<RunOnTestResult> =>
			ipcRenderer.invoke('localModels:runOn:test', request),
	};
}

/**
 * `window.maestro.localModels.tiers.*` - what a harness can launch a tier on.
 * The mapping itself is the `harnessTierDefaults` setting; this is the one call
 * that needs the main process.
 */
function createTiersApi() {
	return {
		/**
		 * The catalogue and Run on targets of one harness, or of every installed
		 * harness that can select a model. A read: it starts no server and saves
		 * nothing. `refresh` asks each harness again instead of its cached list.
		 */
		options: (request?: { harness?: string; refresh?: boolean }): Promise<HarnessTierOptions[]> =>
			ipcRenderer.invoke('localModels:tiers:options', request ?? {}),
	};
}

/**
 * `window.maestro.localModels.huggingFace.*` - models the user adds by repo id
 * and file name. `preview()` and `add()` ask Hugging Face to describe that one
 * repo; neither downloads the model. A refusal the user can act on comes back
 * as `{ ok: false, message }` rather than a rejection.
 */
function createHuggingFaceApi() {
	return {
		/** Describe the model a repo file would add: license, size, revision. Saves nothing. */
		preview: (repo: string, file: string): Promise<UserModelResult<HuggingFaceModelPreview>> =>
			ipcRenderer.invoke('localModels:hf:preview', repo, file),

		/** Add the model to the Library as a user entry. Listed, not downloaded. */
		add: (repo: string, file: string): Promise<UserModelResult<HuggingFaceModelAdded>> =>
			ipcRenderer.invoke('localModels:hf:add', repo, file),

		/** Take a user model out of the Library and delete its files. */
		remove: (modelId: string): Promise<UserModelResult<UserLocalModelRemoved>> =>
			ipcRenderer.invoke('localModels:hf:remove', modelId),

		/** The models the user added. A memory read. */
		list: (): Promise<LocalModelEntry[]> => ipcRenderer.invoke('localModels:userModels'),

		/** The whole list, after every add or remove. Broadcast to every window. */
		onChanged: (handler: (entries: LocalModelEntry[]) => void): (() => void) =>
			subscribe('localModels:userModels:changed', handler),
	};
}

/**
 * `window.maestro.localModels.semanticIndex.*` - the background indexer behind
 * semantic search. Read-only: the indexer is driven by the Semantic search
 * assignment and the `semanticIndexCue` setting, not by a call from here.
 */
function createSemanticIndexApi() {
	return {
		/** What the indexer is doing and how far along it is. Reads memory only. */
		status: (): Promise<SemanticIndexProgress> =>
			ipcRenderer.invoke('localModels:semanticIndex:status'),

		/** Progress pushes, throttled at the source. Broadcast to every window. */
		onProgress: (handler: (progress: SemanticIndexProgress) => void): (() => void) =>
			subscribe('localModels:semanticIndex:progress', handler),
	};
}

/**
 * `window.maestro.localModels.proxy.*` - the Maestro token proxy: what it is
 * doing, what it carried, and the blocks it shortened. An agent's mode is not
 * set here: it is a field on the agent, written through the sessions store
 * like its gateway URL.
 */
function createTokenProxyApi() {
	return {
		/** The listener, the agents on it, usage totals and recent compressions. */
		report: (): Promise<TokenProxyReport> => ipcRenderer.invoke('localModels:proxy:report'),

		/** The proxy's port, chosen and persisted on the first call. */
		ensurePort: (): Promise<number> => ipcRenderer.invoke('localModels:proxy:ensurePort'),

		/** Both sides of one compressed block, or null when the cache has none. */
		block: (hash: string): Promise<TokenProxyBlockDetail | null> =>
			ipcRenderer.invoke('localModels:proxy:block', hash),
	};
}

/**
 * `window.maestro.localModels.server.*` - the Maestro model server (llama.cpp's
 * `llama-server`). Nothing here starts it on its own: `start()` is the Start
 * button, and `installEngine()` is the only call that downloads.
 */
function createModelServerApi() {
	return {
		/** State, engine, loaded models and install progress. Reads only. */
		report: (): Promise<ModelServerReport> => ipcRenderer.invoke('localModels:server:report'),

		/** Start it. Rejects with why it could not (no engine, port taken, ...). */
		start: (): Promise<ModelServerStatus> => ipcRenderer.invoke('localModels:server:start'),

		/** Stop it and wait for it to exit. */
		stop: (): Promise<ModelServerStatus> => ipcRenderer.invoke('localModels:server:stop'),

		/** Change the bind mode or model count, or rotate the key. A running server restarts. */
		set: (patch: {
			bind?: ModelServerBind;
			maxModels?: number;
			rotateKey?: boolean;
		}): Promise<ModelServerStatus> => ipcRenderer.invoke('localModels:server:set', patch),

		/** The server's API key, made on first use. For Copy; never log it. */
		key: (): Promise<string> => ipcRenderer.invoke('localModels:server:key'),

		/** Download, verify and install the engine for a build choice. */
		installEngine: (choice: ServerBuildChoice): Promise<ModelServerReport> =>
			ipcRenderer.invoke('localModels:server:installEngine', choice),

		/** The server's state changed. Broadcast; read `report()` for the rest. */
		onChanged: (handler: (state: ModelServerState) => void): (() => void) =>
			subscribe('localModels:server:changed', handler),

		/** Engine install progress. Broadcast, so every window sees the same install. */
		onProgress: (handler: (progress: ModelServerEngineProgress) => void): (() => void) =>
			subscribe('localModels:server:progress', handler),
	};
}

/**
 * `window.maestro.localModels.systemOne.*` - the System One engine: which one
 * answers, where its key comes from, the Test, and the decision ledger. No call
 * here returns a key: `setKey` is write-only, and the report says only where a
 * key comes from. `test()` is the one call that sends a request to the engine.
 */
function createSystemOneApi() {
	return {
		/** The engine in force, its key sources and the fail policies. Reads only. */
		report: (): Promise<SystemOneReport> => ipcRenderer.invoke('localModels:systemOne:report'),

		/**
		 * Change the engine, the OpenJev URL, a pinned model, the timeout, a fail
		 * policy, "Keep inputs in the ledger", or what agents may do and spend.
		 */
		set: (patch: SystemOneSettingsPatch): Promise<SystemOneReport> =>
			ipcRenderer.invoke('localModels:systemOne:set', patch),

		/** Seal and store a key for a remote engine, replacing the one it had. */
		setKey: (request: { engine: SystemOneRemoteEngineId; key: string }): Promise<SystemOneReport> =>
			ipcRenderer.invoke('localModels:systemOne:setKey', request),

		/** Forget the key Maestro stores for a remote engine. */
		clearKey: (request: { engine: SystemOneRemoteEngineId }): Promise<SystemOneReport> =>
			ipcRenderer.invoke('localModels:systemOne:clearKey', request),

		/** Ask the engine in force one fixed question. A failure is a result, not a rejection. */
		test: (): Promise<SystemOneTestResult> => ipcRenderer.invoke('localModels:systemOne:test'),

		/**
		 * The decision ledger, newest first: what each System One run decided, or
		 * what its fail policy did with no answer. Reads only.
		 */
		ledger: (query?: SystemOneLedgerQuery): Promise<SystemOneLedgerPage> =>
			ipcRenderer.invoke('localModels:systemOne:ledger', query),

		/**
		 * Whether a System One request from this agent would be answered right now,
		 * by which engine, and what is left of the day's budget. Reads only. The
		 * system prompt builder asks on every spawn, so a switch turned off is
		 * gone from the next agent's prompt.
		 */
		agentAccess: (agentId?: string): Promise<SystemOneAgentAccess> =>
			ipcRenderer.invoke('localModels:systemOne:agentAccess', agentId),

		/**
		 * What agents' own requests came to since a time, per agent, with today's
		 * spend against the budget. Reads the decision ledger and the day's count.
		 */
		usage: (query?: SystemOneUsageQuery): Promise<SystemOneUsageReport> =>
			ipcRenderer.invoke('localModels:systemOne:usage', query),

		/** The settings or a key changed, here or from the CLI. Read `report()` for the rest. */
		onChanged: (handler: () => void): (() => void) =>
			subscribe('localModels:systemOne:changed', handler),
	};
}

/**
 * `window.maestro.localModels.dictation.*` - record one clip of speech and get
 * its transcript, through the Dictation task's assignment. No voice session is
 * started and the voice floor is never opened.
 *
 * The recording is made in the main process (the app window has no microphone)
 * and belongs to the window that started it. Every outcome is an answer, never
 * a rejection: a refusal carries a `code` and a `message` written for a person.
 */
function createDictationApi() {
	return {
		/**
		 * Open the microphone and start recording. Resolves `{ started: true }`
		 * once audio is really being captured, or with why it is not (task off or
		 * unavailable, microphone denied, a voice session is live, ...).
		 */
		start: (): Promise<DictationStartResult> => ipcRenderer.invoke('localModels:dictation:start'),

		/** Close the microphone and transcribe what was recorded. */
		stop: (): Promise<DictationResult> => ipcRenderer.invoke('localModels:dictation:stop'),

		/** Close the microphone and discard the recording and any pending transcript. */
		cancel: (): Promise<void> => ipcRenderer.invoke('localModels:dictation:cancel'),

		/**
		 * This window's recording ended on its own (the microphone was lost, or
		 * the length cap was reached). Call `stop()` for what was captured.
		 */
		onInterrupted: (handler: (interruption: DictationInterruption) => void): (() => void) =>
			subscribe('localModels:dictation:interrupted', handler),
	};
}

/**
 * `window.maestro.localModels.spokenNotices.*` - say one line aloud on the
 * computer running Maestro, with a local voice and no voice session.
 *
 * Every outcome is an answer, never a rejection: a line that was not spoken
 * carries a `code` and a `message` written for a person. Nothing is ever
 * spoken while a voice session is live.
 */
function createSpokenNoticesApi() {
	return {
		/**
		 * Report that an agent finished a turn. Main decides whether to speak
		 * about it (the `spokenNotices` setting, window focus) and writes the line.
		 */
		agentFinished: (notice: AgentFinishedNotice): Promise<SpokenNoticeResult> =>
			ipcRenderer.invoke('localModels:spokenNotices:agentFinished', notice),

		/** Speak this text now, whatever the setting says. The Test button. */
		speak: (text: string): Promise<SpokenNoticeResult> =>
			ipcRenderer.invoke('localModels:spokenNotices:speak', text),
	};
}

/**
 * Creates the Local Models API object for contextBridge exposure.
 */
export function createLocalModelsApi() {
	return {
		/** Every catalog model joined to its on-disk status and install paths. */
		list: (): Promise<LocalModelListing[]> => ipcRenderer.invoke('localModels:list'),

		/**
		 * Start or resume a download. Resolves when the model is installed, paused,
		 * cancelled, or has failed; watch {@link onProgress} for the detail.
		 */
		download: (modelId: string): Promise<LocalModelInstallResult> =>
			ipcRenderer.invoke('localModels:download', modelId),

		/** Abort the transfer, keep the partial file. */
		pause: (modelId: string): Promise<boolean> => ipcRenderer.invoke('localModels:pause', modelId),

		/** Continue from the partial file rather than starting over. */
		resume: (modelId: string): Promise<DownloadResult> =>
			ipcRenderer.invoke('localModels:resume', modelId),

		/** Abort and delete everything the download wrote. */
		cancel: (modelId: string): Promise<boolean> =>
			ipcRenderer.invoke('localModels:cancel', modelId),

		/** Re-hash an installed model. A mismatch is reported, never repaired. */
		verify: (modelId: string): Promise<VerifyResult> =>
			ipcRenderer.invoke('localModels:verify', modelId),

		/** Delete one model. Resolves to the bytes reclaimed. */
		remove: (modelId: string): Promise<number> => ipcRenderer.invoke('localModels:remove', modelId),

		/** Delete every installed model. Resolves to the bytes reclaimed. */
		removeAll: (): Promise<number> => ipcRenderer.invoke('localModels:remove-all'),

		/** Disk used by local models, including directories no longer in the catalog. */
		footprint: (): Promise<ModelFootprint> => ipcRenderer.invoke('localModels:footprint'),

		/**
		 * What this computer has to run a model on: RAM, unified memory, GPUs. The
		 * input to `modelFit()`. Reads the OS and a stored file; runs nothing.
		 */
		hardware: (): Promise<HardwareProfile> => ipcRenderer.invoke('localModels:hardware'),

		huggingFace: createHuggingFaceApi(),

		/** Download progress, throttled at the source. Broadcast to every window. */
		onProgress: (handler: (progress: DownloadProgress) => void): (() => void) =>
			subscribe('localModels:progress', handler),

		/**
		 * Run a text-generation task through the user's assignment for it. Answers
		 * `off` or `use-utility-agent` without touching a model; the caller keeps
		 * its existing path for the latter. Never falls back to another source.
		 */
		runTask: (
			taskId: LocalModelTaskId,
			input: Omit<LocalTaskInput, 'signal'>
		): Promise<LocalTaskResult> => ipcRenderer.invoke('localModels:runTask', taskId, input),

		/**
		 * Whether a task's assigned source would answer now, and if not why and
		 * what to do. Omit the task id for every task (registry order); a named
		 * task answers a one-entry list.
		 */
		taskReadiness: (taskId?: LocalModelTaskId): Promise<LocalModelTaskReadiness[]> =>
			ipcRenderer.invoke('localModels:taskReadiness', taskId),

		/**
		 * Draft a pull request title and body for a local branch with the Git
		 * drafts assignment. Returns text only: nothing is pushed or created. A
		 * task that is off or unavailable answers `success: false` with the reason.
		 */
		draftPullRequest: (request: PullRequestDraftRequest): Promise<PullRequestDraftResult> =>
			ipcRenderer.invoke('localModels:draftPullRequest', request),

		/**
		 * Search past work (History entries, Director's Notes, tab transcripts) by
		 * meaning on the Semantic search assignment, or by exact text. Answers `off`
		 * or `unavailable` with the reason when a semantic search cannot run; it
		 * never falls back to text matches.
		 */
		search: (request: WorkSearchRequest): Promise<WorkSearchResult> =>
			ipcRenderer.invoke('localModels:search', request),

		/**
		 * Ask the Tab cleanup assignment which tabs could be closed, snoozed, or
		 * brought back from snooze, across every agent. Read-only: it returns a
		 * list and changes no tab. A task that is off or unavailable answers
		 * `success: false` with the reason.
		 */
		suggestTabCleanup: (): Promise<TabCleanupResult> =>
			ipcRenderer.invoke('localModels:suggestTabCleanup'),

		/**
		 * Ask the Model routing assignment how much model and effort one turn
		 * needs: the question a send on the Auto model asks. Answers a tier and an
		 * effort, or why there is no decision (the task is off, the router was slow
		 * or down). A routing never rejects and never outlasts its timeout.
		 */
		routeTurn: (request: RouteTurnRequest): Promise<RouteTurnResult> =>
			ipcRenderer.invoke('localModels:routeTurn', request),

		dictation: createDictationApi(),

		spokenNotices: createSpokenNoticesApi(),

		semanticIndex: createSemanticIndexApi(),

		proxy: createTokenProxyApi(),

		server: createModelServerApi(),

		systemOne: createSystemOneApi(),

		runtimes: createLocalRuntimesApi(),

		endpoints: createLocalModelEndpointsApi(),

		runOn: createRunOnApi(),

		tiers: createTiersApi(),
	};
}

export type LocalModelsApi = ReturnType<typeof createLocalModelsApi>;
