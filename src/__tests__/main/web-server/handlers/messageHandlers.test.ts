import { MAESTRO_PUBLISHER_KEYS } from '../../../../shared/plugins/publisher-keys';
import { RELAY_PUBLISHER_KEY } from '../../../../shared/plugins/relay-identity';
/**
 * Tests for WebSocketMessageHandler
 *
 * The MessageHandler is the core of web → desktop synchronization.
 * When ANYTHING happens on the web interface (remote control), it must
 * be forwarded to the desktop and executed. This is the "remote control" contract.
 *
 * Actions that MUST work (web → desktop):
 * - Send command (AI or terminal)
 * - Switch mode (AI ↔ terminal)
 * - Select session
 * - Select tab
 * - Create new tab
 * - Close tab
 * - Rename tab
 * - Subscribe to session updates
 * - Open file tab
 * - Refresh file tree
 * - Refresh auto-run documents
 * - Select session with focus (window foregrounding)
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	WebSocketMessageHandler,
	type WebClient,
	type WebClientMessage,
	type MessageHandlerCallbacks,
} from '../../../../main/web-server/handlers/messageHandlers';
import {
	getActivePluginManager,
	isPluginsFeatureEnabled,
	getHeadlessAgentRunner,
} from '../../../../main/plugins/plugin-manager-singleton';
import type { PluginManager } from '../../../../main/plugins/plugin-manager';
import { pluginToolRunIdentity } from '../../../../main/plugins/plugin-tool-run-identity';
import {
	initDispatchCallbacks,
	getDispatchCallbackRegistry,
	disposeDispatchCallbacks,
} from '../../../../main/dispatch-callbacks';

// The feedback service shells out to `gh` and the debug package reads real
// stores; the handler tests only care what reaches them and what comes back.
vi.mock('../../../../main/feedback', () => ({
	checkFeedbackGhAuth: vi.fn().mockResolvedValue({ authenticated: true }),
	searchFeedbackIssues: vi.fn().mockResolvedValue({ issues: [] }),
	submitFeedbackConversation: vi.fn().mockResolvedValue({
		success: true,
		issueUrl: 'https://github.com/RunMaestro/Maestro/issues/1',
	}),
	subscribeFeedbackIssue: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../../../../main/debug-package', () => ({
	generateDebugPackage: vi.fn().mockResolvedValue({
		success: true,
		path: '/tmp/p.zip',
		filesIncluded: ['a'],
		totalSizeBytes: 9,
	}),
}));

import {
	searchFeedbackIssues,
	submitFeedbackConversation,
	subscribeFeedbackIssue,
} from '../../../../main/feedback';
import { generateDebugPackage } from '../../../../main/debug-package';

// The endpoint service reads settings and dials model servers; the handler
// tests only care that the CLI's message reaches it and the verdict comes back.
vi.mock('../../../../main/local-models/endpoint-service', () => ({
	detectNewLocalModelEndpoints: vi
		.fn()
		.mockResolvedValue([
			{ kind: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', models: [] },
		]),
	testLocalModelEndpoint: vi.fn().mockResolvedValue({ ok: true, model: 'qwen3', latencyMs: 42 }),
	listLocalModelEndpointModels: vi
		.fn()
		.mockResolvedValue({ ok: true, models: [{ id: 'qwen3:4b', sizeBytes: 1024 }] }),
}));

import {
	detectNewLocalModelEndpoints,
	listLocalModelEndpointModels,
	testLocalModelEndpoint,
} from '../../../../main/local-models/endpoint-service';

// The task router reads assignments and calls models; the handler tests only
// care that `maestro-cli models run` reaches it and the verdict comes back.
vi.mock('../../../../main/local-models/task-router', () => ({
	runLocalTaskRequest: vi.fn().mockResolvedValue({ status: 'off' }),
}));

import { runLocalTaskRequest } from '../../../../main/local-models/task-router';

// The readiness resolver reads the model store and lists endpoints; the handler
// tests only care that `maestro-cli models status` reaches it.
vi.mock('../../../../main/local-models/task-readiness', () => ({
	resolveTaskReadinessRequest: vi
		.fn()
		.mockResolvedValue([{ taskId: 'injection-screen', state: 'unavailable' }]),
}));

import { resolveTaskReadinessRequest } from '../../../../main/local-models/task-readiness';

vi.mock('../../../../main/local-models/git-drafts', () => ({
	draftPullRequestRequest: vi.fn().mockResolvedValue({
		success: true,
		title: 'Add retry',
		body: 'Retries.',
		baseBranch: 'main',
		commitCount: 2,
		truncated: false,
	}),
}));
import { draftPullRequestRequest } from '../../../../main/local-models/git-drafts';

vi.mock('../../../../main/local-models/spoken-notices', () => ({
	speakNoticeRequest: vi.fn().mockResolvedValue({
		spoken: true,
		text: 'The build is green.',
		lineSource: 'given',
	}),
}));

vi.mock('../../../../main/local-models/dictation', () => ({
	transcribeAudioFileRequest: vi.fn().mockResolvedValue({
		status: 'ok',
		text: 'ship the fix today',
		audioMs: 2100,
		source: { type: 'local', modelId: 'parakeet-tdt-0.6b-v2' },
		durationMs: 310,
	}),
}));
import { transcribeAudioFileRequest } from '../../../../main/local-models/dictation';
import { speakNoticeRequest } from '../../../../main/local-models/spoken-notices';

vi.mock('../../../../main/local-models/semantic-indexer', () => ({
	semanticIndexProgress: vi.fn(() => ({
		state: 'indexing',
		indexed: 3,
		total: 10,
		bySourceType: {
			history: { indexed: 3, total: 8 },
			'directors-notes': { indexed: 0, total: 1 },
			transcript: { indexed: 0, total: 1 },
		},
		modelId: 'local:bge-small-en-v1.5',
	})),
}));
import { semanticIndexProgress } from '../../../../main/local-models/semantic-indexer';

vi.mock('../../../../main/local-models/proxy/service', () => ({
	getTokenProxyReport: vi.fn(async () => ({
		status: { port: 48123, running: true, agentIds: ['a'], lastError: null, gatewayUrls: null },
		agents: [
			{ id: 'a', name: 'Alpha', toolType: 'claude-code', mode: 'compress', gatewayUrl: 'x' },
		],
		usage: null,
		recentCompressions: [],
	})),
	readTokenProxyBlock: vi.fn(async () => ({
		hash: 'a'.repeat(64),
		original: 'long',
		compressed: 'short',
	})),
}));
import {
	getTokenProxyReport,
	readTokenProxyBlock,
} from '../../../../main/local-models/proxy/service';

vi.mock('../../../../main/local-models/server/supervisor', () => ({
	startModelServer: vi.fn(async () => ({ state: 'running' })),
	stopModelServer: vi.fn(async () => ({ state: 'stopped' })),
	getModelServerKey: vi.fn(async () => 'sk-maestro-key'),
}));
import {
	getModelServerKey,
	startModelServer,
	stopModelServer,
} from '../../../../main/local-models/server/supervisor';

vi.mock('../../../../main/local-models/server/server-endpoint', () => ({
	modelServerForHarness: vi.fn(async () => ({
		ok: true,
		baseUrl: 'http://127.0.0.1:47811',
		key: 'sk-maestro-key',
	})),
}));
import { modelServerForHarness } from '../../../../main/local-models/server/server-endpoint';

vi.mock('../../../../main/local-models/run-on-test', () => ({
	testAgentRunOn: vi.fn(async () => ({
		ok: true,
		model: 'qwen3:latest',
		label: 'qwen3:latest on Ollama',
		reply: 'ready',
		durationMs: 4200,
		contextTokens: 40960,
	})),
}));
import { testAgentRunOn } from '../../../../main/local-models/run-on-test';

vi.mock('../../../../main/local-models/tier-options', () => ({
	listHarnessTierOptionsRequest: vi.fn(async () => [
		{
			harness: 'codex',
			name: 'Codex',
			installed: true,
			catalog: [{ id: 'gpt-6-luna', priority: 4 }],
			runOn: { supported: true },
			sources: [],
			problems: [],
		},
	]),
}));
import { listHarnessTierOptionsRequest } from '../../../../main/local-models/tier-options';

vi.mock('../../../../main/local-models/server/service', () => ({
	getModelServerReport: vi.fn(async () => ({
		status: { state: 'running', baseUrl: 'http://127.0.0.1:47811' },
		engine: { installed: true },
		loaded: [],
		installing: null,
	})),
	installModelServerEngine: vi.fn(async () => ({})),
	updateModelServerConfigRequest: vi.fn(async () => ({ state: 'running' })),
}));
import {
	getModelServerReport,
	installModelServerEngine,
	updateModelServerConfigRequest,
} from '../../../../main/local-models/server/service';

vi.mock('../../../../main/local-models/system-one/service', () => {
	const report = {
		settings: { engine: 'jev-cloud' },
		engineLabel: 'Jev (TypeSafe cloud)',
		keys: { 'jev-cloud': { source: 'stored', storage: 'os' }, openjev: { source: 'none' } },
		problem: null,
	};
	return {
		getSystemOneReport: vi.fn(async () => report),
		updateSystemOneSettingsRequest: vi.fn(async () => report),
		setSystemOneKeyRequest: vi.fn(async () => report),
		clearSystemOneKeyRequest: vi.fn(async () => report),
		testSystemOne: vi.fn(async () => ({
			ok: true,
			engine: 'jev-cloud',
			engineLabel: 'Jev (TypeSafe cloud)',
			probability: 0.97,
			latencyMs: 212,
		})),
	};
});
import {
	clearSystemOneKeyRequest,
	getSystemOneReport,
	setSystemOneKeyRequest,
	testSystemOne,
	updateSystemOneSettingsRequest,
} from '../../../../main/local-models/system-one/service';

vi.mock('../../../../main/local-models/system-one/decisions', () => ({
	readSystemOneLedger: vi.fn(() => ({
		entries: [
			{
				id: 'decision-1',
				taskId: 'cue-gate',
				engine: 'jev-cloud',
				questionIds: ['proceed'],
				outcome: 'failed-open',
				code: 'timeout',
				startedAt: 1_800_000_000_000,
				latencyMs: 1500,
			},
		],
		total: 1,
		retentionDays: 30,
		notice: null,
	})),
}));
import { readSystemOneLedger } from '../../../../main/local-models/system-one/decisions';

vi.mock('../../../../main/local-models/system-one/agent-service', () => ({
	readSystemOneAgentUsage: vi.fn(async () => ({
		since: 1_800_000_000_000,
		retentionDays: 30,
		rows: [],
		totals: { requests: 0, cachedRequests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
		budget: {
			dayStartedAt: 1_800_000_000_000,
			dailyBudgetUsd: 1,
			spentTodayUsd: 0,
			remainingTodayUsd: 1,
		},
		engine: 'jev-cloud',
		engineLabel: 'Jev (TypeSafe cloud)',
		notice: null,
	})),
	runAgentSystemOneRequest: vi.fn(async () => ({
		ok: true,
		kind: 'ask',
		verb: 'yes',
		answers: { q: { type: 'noul', probability: 0.93 } },
		engine: 'jev-cloud',
		engineLabel: 'Jev (TypeSafe cloud)',
		calibrated: true,
		model: 'jev-1.13.0',
		cached: false,
		latencyMs: 180,
		tokens: { inputTokens: 120, outputTokens: 1 },
		costUsd: 0.000005,
		redacted: false,
	})),
	getSystemOneAgentAccessRequest: vi.fn(async () => ({
		allowed: true,
		gate: null,
		message: null,
		engine: 'jev-cloud',
		engineLabel: 'Jev (TypeSafe cloud)',
		calibrated: true,
		budget: {
			dayStartedAt: 1_800_000_000_000,
			dailyBudgetUsd: 1,
			spentTodayUsd: 0,
			remainingTodayUsd: 1,
		},
	})),
}));
import {
	getSystemOneAgentAccessRequest,
	readSystemOneAgentUsage,
	runAgentSystemOneRequest,
} from '../../../../main/local-models/system-one/agent-service';

vi.mock('../../../../main/local-models/route-turn', () => ({
	routeTurnRequest: vi.fn(async () => ({
		tier: 'medium',
		effort: 'low',
		engine: { id: 'embedding-router', label: 'Embedding router', calibrated: false },
		latencyMs: 24,
	})),
}));
import { routeTurnRequest } from '../../../../main/local-models/route-turn';

vi.mock('../../../../main/local-models/model-usage', () => ({
	readModelUsage: vi.fn(async (range?: unknown) => ({ range: range ?? 'week', sources: [] })),
}));
import { readModelUsage } from '../../../../main/local-models/model-usage';

vi.mock('../../../../main/local-models/model-routing-corrections', () => ({
	recordModelRoutingCorrectionRequest: vi.fn(async () => ({
		ok: true,
		replaced: false,
		total: 1,
	})),
}));
import { recordModelRoutingCorrectionRequest } from '../../../../main/local-models/model-routing-corrections';

vi.mock('../../../../main/local-models/tab-cleanup', () => ({
	suggestTabCleanup: vi.fn().mockResolvedValue({
		success: true,
		suggestions: [
			{
				tabId: 'tab-1',
				agentId: 'agent-1',
				action: 'close',
				reason: 'Untouched for a month.',
				agentName: 'Backend',
				label: 'Fix login bug',
				kind: 'open',
				tabType: 'ai',
				lastActivityAt: 1,
				messageCount: 4,
			},
		],
		considered: 3,
		protectedCount: 1,
		droppedCount: 0,
		truncated: false,
	}),
}));

vi.mock('../../../../main/local-models/work-search', () => ({
	searchPastWorkRequest: vi.fn().mockResolvedValue({
		status: 'ok',
		mode: 'semantic',
		hits: [{ sourceType: 'history', sourceId: 'e1', agentId: 'agent-1', score: 0.8 }],
		durationMs: 4,
	}),
}));
import { searchPastWorkRequest } from '../../../../main/local-models/work-search';
import { suggestTabCleanup } from '../../../../main/local-models/tab-cleanup';

// The Local Models service reads the model store and runs the downloader; the
// handler tests only care that `maestro-cli models list|install|verify|remove`
// reach the same service functions the Settings rows call.
vi.mock('../../../../main/local-models/hardware', () => ({
	resolveHardwareProfile: vi.fn().mockResolvedValue({
		platform: 'darwin',
		arch: 'arm64',
		totalMemoryBytes: 16 * 1024 ** 3,
		unifiedMemory: true,
		gpus: [],
	}),
}));

vi.mock('../../../../main/local-models/user-models', () => ({
	previewHuggingFaceModel: vi.fn().mockResolvedValue({
		ok: true,
		value: { entry: { id: 'hf-owner-model' }, alreadyAdded: false },
	}),
	addHuggingFaceModel: vi.fn().mockResolvedValue({
		ok: true,
		value: { entry: { id: 'hf-owner-model' }, added: true },
	}),
	removeUserLocalModel: vi.fn().mockResolvedValue({
		ok: true,
		value: { id: 'hf-owner-model', displayName: 'model', bytes: 512 },
	}),
}));

vi.mock('../../../../main/local-models/service', () => ({
	listLocalModels: vi.fn().mockResolvedValue([{ entry: { id: 'bge-small-en-v1.5' } }]),
	localModelsFootprint: vi.fn().mockResolvedValue({ bytes: 42, models: [] }),
	installLocalModel: vi.fn().mockResolvedValue({
		modelId: 'bge-small-en-v1.5',
		status: 'complete',
		runtime: { runtimeId: 'onnx', status: 'installed' },
	}),
	listLocalRuntimes: vi.fn().mockResolvedValue([
		{
			id: 'llama',
			label: 'llama.cpp',
			models: ['qwen3-1.7b-instruct-q4km'],
			installed: true,
			stale: false,
			downloadable: true,
			bytes: 1000,
		},
	]),
	installLocalRuntime: vi.fn().mockResolvedValue(undefined),
	verifyLocalModel: vi
		.fn()
		.mockResolvedValue({ id: 'bge-small-en-v1.5', ok: true, status: 'installed' }),
	removeLocalModel: vi.fn().mockResolvedValue(2048),
	pauseLocalModel: vi.fn().mockReturnValue(true),
	cancelLocalModel: vi.fn().mockResolvedValue(false),
}));

import {
	cancelLocalModel,
	installLocalModel,
	installLocalRuntime,
	listLocalModels,
	listLocalRuntimes,
	pauseLocalModel,
	removeLocalModel,
	verifyLocalModel,
} from '../../../../main/local-models/service';

import { resolveHardwareProfile } from '../../../../main/local-models/hardware';
import {
	addHuggingFaceModel,
	previewHuggingFaceModel,
	removeUserLocalModel,
} from '../../../../main/local-models/user-models';

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getActivePluginManager: vi.fn(),
	isPluginsFeatureEnabled: vi.fn(),
	getHeadlessAgentRunner: vi.fn(() => null),
}));

/**
 * Symlink creation requires elevation / Developer Mode on Windows and throws
 * EPERM otherwise. Probe once and cache so the symlink-confinement tests run on
 * Unix/CI (where they're meaningful) but skip gracefully where the OS forbids
 * creating symlinks. This is purely an environment capability check - the
 * product's realpath-based confinement is platform-neutral.
 */
let _canSymlink: boolean | undefined;
function canSymlink(): boolean {
	if (_canSymlink !== undefined) return _canSymlink;
	let probeDir: string | undefined;
	try {
		probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-symlink-probe-'));
		fs.symlinkSync(probeDir, path.join(probeDir, 'self-link'));
		_canSymlink = true;
	} catch {
		_canSymlink = false;
	} finally {
		if (probeDir) {
			try {
				fs.rmSync(probeDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	}
	return _canSymlink;
}

/**
 * Create a mock WebSocket client
 */
function createMockClient(id: string = 'test-client'): WebClient {
	return {
		id,
		connectedAt: Date.now(),
		socket: {
			readyState: WebSocket.OPEN,
			send: vi.fn(),
			once: vi.fn(),
			off: vi.fn(),
		} as unknown as WebSocket,
	};
}

/**
 * Create mock callbacks with all methods as vi.fn()
 */
function createMockCallbacks(): MessageHandlerCallbacks {
	return {
		getSessionDetail: vi.fn().mockReturnValue({
			state: 'idle',
			inputMode: 'ai',
			agentSessionId: 'claude-123',
		}),
		executeCommand: vi.fn().mockResolvedValue(true),
		consultAgent: vi.fn().mockResolvedValue({ success: true, answer: 'Because HMAC.' }),
		noteAgentDelegation: vi.fn(),
		switchMode: vi.fn().mockResolvedValue(true),
		selectSession: vi.fn().mockResolvedValue(true),
		selectTab: vi.fn().mockResolvedValue(true),
		newTab: vi.fn().mockResolvedValue({ tabId: 'new-tab-123' }),
		closeTab: vi.fn().mockResolvedValue(true),
		renameTab: vi.fn().mockResolvedValue(true),
		starTab: vi.fn().mockResolvedValue(true),
		reorderTab: vi.fn().mockResolvedValue(true),
		toggleBookmark: vi.fn().mockResolvedValue(true),
		openFileTab: vi.fn().mockResolvedValue(true),
		refreshFileTree: vi.fn().mockResolvedValue(true),
		openBrowserTab: vi.fn().mockResolvedValue({ success: true, tabId: 'browser-tab-1' }),
		closeBrowserTab: vi.fn().mockResolvedValue(true),
		openTerminalTab: vi.fn().mockResolvedValue({ success: true, tabId: 'terminal-tab-1' }),
		writeTerminalTab: vi
			.fn()
			.mockResolvedValue({ success: true, tabId: 'terminal-tab-1', tabName: 'Dev server' }),
		listTerminalTabs: vi.fn().mockResolvedValue([]),
		readTerminalTab: vi.fn().mockResolvedValue({
			success: true,
			tabId: 'terminal-tab-1',
			tabName: 'Dev server',
			cwd: '/home/user/project',
			state: 'busy',
			content: 'line one\nline two',
			totalLines: 2,
		}),
		newAITabWithPrompt: vi.fn().mockResolvedValue({ success: true, tabId: 'tab-mock-123' }),
		enqueueCommand: vi.fn().mockResolvedValue({
			success: true,
			tabId: 'tab-mock-123',
			queued: true,
			queuePosition: 1,
			queueLength: 1,
			itemId: 'item-1',
		}),
		listQueue: vi.fn().mockResolvedValue({
			success: true,
			queues: [{ sessionId: 'session-1', name: 'Session 1', state: 'busy', items: [] }],
		}),
		removeQueueItem: vi.fn().mockResolvedValue({ success: true, removed: true }),
		setQueueItemPaused: vi.fn().mockResolvedValue({ success: true, found: true, paused: true }),
		mergeQueueItem: vi
			.fn()
			.mockResolvedValue({ success: true, merged: true, mergedIntoId: 'item-8' }),
		steerQueueItem: vi.fn().mockResolvedValue({
			success: true,
			result: { outcome: 'delivered', verdict: 'delivered' },
		}),
		refreshAutoRunDocs: vi.fn().mockResolvedValue(true),
		configureAutoRun: vi.fn().mockResolvedValue({ success: true }),
		getSessions: vi.fn().mockReturnValue([
			{
				id: 'session-1',
				name: 'Session 1',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/home/user/project',
			},
		]),
		getLiveSessionInfo: vi.fn().mockReturnValue(undefined),
		isSessionLive: vi.fn().mockReturnValue(false),
		getAutoRunDocs: vi.fn().mockResolvedValue([]),
		getAutoRunDocContent: vi.fn().mockResolvedValue(''),
		saveAutoRunDoc: vi.fn().mockResolvedValue(true),
		stopAutoRun: vi.fn().mockResolvedValue(true),
		getSettings: vi.fn().mockReturnValue({}),
		setSetting: vi.fn().mockResolvedValue(true),
		getGroups: vi.fn().mockReturnValue([]),
		createGroup: vi.fn().mockResolvedValue({ id: 'group-1' }),
		renameGroup: vi.fn().mockResolvedValue(true),
		updateGroup: vi.fn().mockResolvedValue(true),
		updateGroupSettings: vi.fn().mockResolvedValue({ success: true }),
		deleteGroup: vi.fn().mockResolvedValue(true),
		moveSessionToGroup: vi.fn().mockResolvedValue(true),
		createSession: vi.fn().mockResolvedValue({ sessionId: 'new-session-1' }),
		createWorktreeSession: vi
			.fn()
			.mockResolvedValue({ success: true, sessionId: 'new-worktree-1' }),
		deleteSession: vi.fn().mockResolvedValue(true),
		renameSession: vi.fn().mockResolvedValue(true),
		updateSessionCwd: vi.fn().mockResolvedValue({ success: true }),
		updateSessionConfig: vi.fn().mockResolvedValue({ success: true }),
		getGitStatus: vi.fn().mockResolvedValue({ files: [], branch: 'main' }),
		getGitDiff: vi.fn().mockResolvedValue({ diff: '' }),
		getGitBranchesForSession: vi
			.fn()
			.mockResolvedValue({ branches: ['main', 'feature/x'], currentBranch: 'main' }),
		listWorktreesForSession: vi.fn().mockResolvedValue({ worktrees: [] }),
		getGroupChats: vi.fn().mockResolvedValue([]),
		startGroupChat: vi.fn().mockResolvedValue({ chatId: 'chat-1' }),
		getGroupChatState: vi.fn().mockResolvedValue(null),
		stopGroupChat: vi.fn().mockResolvedValue(true),
		sendGroupChatMessage: vi.fn().mockResolvedValue(true),
		steerGroupChat: vi.fn().mockResolvedValue({
			outcome: 'delivered',
			verdict: 'delivered',
			targets: ['Moderator'],
		}),
		mergeContext: vi.fn().mockResolvedValue(true),
		transferContext: vi.fn().mockResolvedValue(true),
		summarizeContext: vi.fn().mockResolvedValue(true),
		createGist: vi.fn().mockResolvedValue({ success: true, gistUrl: 'https://gist.example' }),
		getCueSubscriptions: vi.fn().mockResolvedValue([]),
		toggleCueSubscription: vi.fn().mockResolvedValue(true),
		setCueSubscriptionGate: vi.fn().mockResolvedValue({ ok: true, updated: ['Triage'] }),
		setCueSubscriptionInjectionScreen: vi.fn().mockResolvedValue({ ok: true, updated: ['Triage'] }),
		getCueActivity: vi.fn().mockResolvedValue([]),
		triggerCueSubscription: vi.fn().mockResolvedValue(true),
		listCuePipelines: vi.fn().mockResolvedValue({ pipelines: [] }),
		getCuePipeline: vi.fn().mockResolvedValue(null),
		setCuePipeline: vi.fn().mockResolvedValue({ ok: true }),
		removeCuePipeline: vi.fn().mockResolvedValue({ ok: true }),
		getUsageDashboard: vi.fn().mockResolvedValue({}),
		getAchievements: vi.fn().mockResolvedValue([]),
		writeToTerminal: vi.fn().mockReturnValue(true),
		resizeTerminal: vi.fn().mockReturnValue(true),
		spawnTerminalForWeb: vi.fn().mockResolvedValue({ success: true, pid: 123 }),
		killTerminalForWeb: vi.fn().mockReturnValue(true),
		// Auto Run parity additions (playbook CRUD + task reset + error recovery)
		resetAutoRunDocTasks: vi.fn().mockResolvedValue(true),
		resumeAutoRunError: vi.fn().mockResolvedValue(true),
		skipAutoRunDocument: vi.fn().mockResolvedValue(true),
		abortAutoRunError: vi.fn().mockResolvedValue(true),
		listPlaybooks: vi.fn().mockResolvedValue([]),
		createPlaybook: vi.fn().mockResolvedValue({
			id: 'pb-1',
			name: 'My Playbook',
			createdAt: 0,
			updatedAt: 0,
			documents: [],
			loopEnabled: false,
			prompt: '',
		}),
		updatePlaybook: vi.fn().mockResolvedValue({
			id: 'pb-1',
			name: 'My Playbook',
			createdAt: 0,
			updatedAt: 0,
			documents: [],
			loopEnabled: false,
			prompt: '',
		}),
		deletePlaybook: vi.fn().mockResolvedValue(true),
		notifyToast: vi.fn().mockResolvedValue(true),
		notifyCenterFlash: vi.fn().mockResolvedValue(true),
		getDebugPackageDeps: vi.fn().mockReturnValue({ settingsStore: {} }),
		getMarketplaceManifest: vi.fn().mockResolvedValue({
			manifest: { lastUpdated: '2026-01-01', playbooks: [] },
			fromCache: false,
		}),
		getMarketplaceDocument: vi.fn().mockResolvedValue({ content: '# doc' }),
		getMarketplaceReadme: vi.fn().mockResolvedValue({ content: '# readme' }),
		importMarketplacePlaybook: vi.fn().mockResolvedValue({
			success: true,
			playbook: {
				id: 'p1',
				name: 'Sample',
				createdAt: 0,
				updatedAt: 0,
				documents: [],
				loopEnabled: false,
				prompt: '',
			},
			importedDocs: [],
			importedAssets: [],
		}),
		listDesktopSessions: vi.fn().mockReturnValue([]),
		getSessionHistory: vi.fn().mockReturnValue(null),
	};
}

describe('WebSocketMessageHandler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let callbacks: MessageHandlerCallbacks;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		callbacks = createMockCallbacks();
		handler.setCallbacks(callbacks);
	});

	describe('External toast duration units', () => {
		it.each([5, 60])(
			'accepts legacy %s seconds and normalizes to renderer milliseconds',
			async (duration) => {
				handler.handleMessage(client, {
					type: 'notify_toast',
					title: 'Timeout test',
					message: 'Hello',
					duration,
					requestId: 'timeout',
				});
				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(callbacks.notifyToast).toHaveBeenCalledWith(
					expect.objectContaining({ duration: duration * 1000 })
				);
				expect(
					JSON.parse(vi.mocked(client.socket.send).mock.calls.at(-1)![0] as string)
				).toMatchObject({ type: 'notify_toast_result', success: true, requestId: 'timeout' });
			}
		);
		it.each([0, -1, 61, NaN, Infinity])('rejects invalid duration %s', (duration) => {
			handler.handleMessage(client, {
				type: 'notify_toast',
				title: 'Timeout test',
				message: 'Hello',
				duration,
			});
			expect(callbacks.notifyToast).not.toHaveBeenCalled();
			expect(
				JSON.parse(vi.mocked(client.socket.send).mock.calls.at(-1)![0] as string)
			).toMatchObject({ success: false });
		});
	});

	describe('Notification inbox', () => {
		it('forwards validated actions and returns the resulting snapshot with the request ID', async () => {
			callbacks.notificationInbox = vi.fn().mockResolvedValue({
				success: true,
				unreadCount: 1,
				open: true,
				notifications: [{ id: 'n1' }],
			});
			handler.setCallbacks(callbacks);
			handler.handleMessage(client, {
				type: 'notification_inbox',
				action: 'read',
				id: 'n2',
				requestId: 'request-1',
			});
			await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
			expect(callbacks.notificationInbox).toHaveBeenCalledWith({
				action: 'read',
				id: 'n2',
				unread: undefined,
			});
			expect(JSON.parse(vi.mocked(client.socket.send).mock.calls[0][0] as string)).toMatchObject({
				type: 'notification_inbox_result',
				requestId: 'request-1',
				success: true,
				unreadCount: 1,
			});
		});
		it.each([{ action: 'bogus' }, { action: 'clear', id: {} }, { action: 'list', unread: 'yes' }])(
			'rejects malformed requests: %j',
			(request) => {
				callbacks.notificationInbox = vi.fn();
				handler.handleMessage(client, { type: 'notification_inbox', ...request });
				expect(callbacks.notificationInbox).not.toHaveBeenCalled();
				expect(JSON.parse(vi.mocked(client.socket.send).mock.calls[0][0] as string).success).toBe(
					false
				);
			}
		);
		it('reports an unavailable renderer instead of claiming success', async () => {
			handler.handleMessage(client, { type: 'notification_inbox', action: 'clear' });
			await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
			expect(JSON.parse(vi.mocked(client.socket.send).mock.calls[0][0] as string)).toMatchObject({
				success: false,
				error: 'Notification inbox unavailable',
			});
		});
	});

	describe('Ping/Pong Health Check', () => {
		it('should respond to ping with pong', () => {
			handler.handleMessage(client, { type: 'ping' });

			expect(client.socket.send).toHaveBeenCalledTimes(1);
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('pong');
			expect(response.timestamp).toBeDefined();
		});
	});

	describe('Session Subscription', () => {
		it('should subscribe client to session updates', () => {
			handler.handleMessage(client, { type: 'subscribe', sessionId: 'session-1' });

			expect(client.subscribedSessionId).toBe('session-1');
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('subscribed');
			expect(response.sessionId).toBe('session-1');
		});

		it('should handle subscribe without sessionId', () => {
			handler.handleMessage(client, { type: 'subscribe' });

			expect(client.subscribedSessionId).toBeUndefined();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('subscribed');
		});
	});

	// `maestro-cli dispatch` and `ask` admit a consult in the CLI, spend for it
	// there, and send the place in the chain its target takes. Main spends
	// nothing: it only carries that place to whatever spawns the target's turn.
	describe('Consult chain (maestro-cli dispatch / ask)', () => {
		const chain = { chainId: 'chain-a', depth: 2 };

		it('hands send_command the chain as the last executeCommand argument', async () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Take this over',
				inputMode: 'ai',
				consultChain: chain,
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'Take this over',
					'ai',
					undefined,
					false,
					undefined,
					false,
					chain
				);
			});
		});

		it('hands new_ai_tab_with_prompt the chain for the new tab', async () => {
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 'Take this over',
				background: true,
				consultChain: chain,
			});

			await vi.waitFor(() => {
				expect(callbacks.newAITabWithPrompt).toHaveBeenCalledWith(
					'session-1',
					'Take this over',
					true,
					// Not hidden: the message did not ask for it.
					false,
					chain
				);
			});
		});

		it('hands enqueue_command the chain for the queued item', async () => {
			handler.handleMessage(client, {
				type: 'enqueue_command',
				sessionId: 'session-1',
				command: 'Take this over',
				inputMode: 'ai',
				tabId: 'tab-1',
				background: true,
				held: true,
				consultChain: chain,
			});

			await vi.waitFor(() => {
				expect(callbacks.enqueueCommand).toHaveBeenCalledWith(
					'session-1',
					'Take this over',
					'ai',
					'tab-1',
					undefined,
					true,
					true,
					chain
				);
			});
		});

		it('hands cross_agent_ask the chain for the consult', async () => {
			handler.handleMessage(client, {
				type: 'cross_agent_ask',
				sessionId: 'session-1',
				question: 'q',
				consultChain: chain,
			});

			await vi.waitFor(() => {
				expect(callbacks.consultAgent).toHaveBeenCalledWith(
					expect.objectContaining({ targetSessionId: 'session-1', consultChain: chain })
				);
			});
		});

		it.each([
			['an id the counter would refuse', { chainId: '../escape', depth: 1 }],
			['a bare string', 'chain-a'],
			['null', null],
		])('reads %s as no chain, and still delivers', async (_what, consultChain) => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Take this over',
				inputMode: 'ai',
				consultChain,
			});
			handler.handleMessage(client, {
				type: 'cross_agent_ask',
				sessionId: 'session-1',
				question: 'q',
				consultChain,
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalled();
				expect(callbacks.consultAgent).toHaveBeenCalled();
			});
			expect((callbacks.executeCommand as any).mock.calls[0][7]).toBeUndefined();
			expect((callbacks.consultAgent as any).mock.calls[0][0]).not.toHaveProperty('consultChain');
		});
	});

	describe('Cross-Agent Ask (maestro-cli ask)', () => {
		it('forwards the asking agent tab so the consult pill lands in that conversation', async () => {
			handler.handleMessage(client, {
				type: 'cross_agent_ask',
				sessionId: 'session-1',
				question: 'q',
				fromSessionId: 'caller-1',
				fromTabId: 'caller-tab',
			});

			await vi.waitFor(() => {
				expect(callbacks.consultAgent).toHaveBeenCalledWith(
					expect.objectContaining({ fromSessionId: 'caller-1', fromTabId: 'caller-tab' })
				);
			});
			// An ask records its own pill in the renderer; the dispatch notice is not used.
			expect(callbacks.noteAgentDelegation).not.toHaveBeenCalled();
		});

		it('consults the target and returns the answer without touching its open tab', async () => {
			handler.handleMessage(client, {
				type: 'cross_agent_ask',
				sessionId: 'session-1',
				question: 'How does the gate work?',
				fromSessionId: 'caller-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.consultAgent).toHaveBeenCalled();
			});
			expect(callbacks.consultAgent).toHaveBeenCalledWith(
				expect.objectContaining({
					targetSessionId: 'session-1',
					question: 'How does the gate work?',
					fromSessionId: 'caller-1',
					withContext: false,
				})
			);
			// A consult must never reach the dispatch path, which writes into the
			// target's ACTIVE tab and interrupts whatever the human has open there.
			expect(callbacks.executeCommand).not.toHaveBeenCalled();

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('cross_agent_ask_result');
			expect(response.success).toBe(true);
			expect(response.answer).toBe('Because HMAC.');
		});

		it('does not apply the busy guard - a consult spawns its own process', async () => {
			(callbacks.getSessionDetail as any).mockReturnValue({ state: 'busy', inputMode: 'ai' });

			handler.handleMessage(client, {
				type: 'cross_agent_ask',
				sessionId: 'session-1',
				question: 'q',
			});

			await vi.waitFor(() => {
				expect(callbacks.consultAgent).toHaveBeenCalled();
			});
		});

		it('rejects a missing question without spawning anything', () => {
			handler.handleMessage(client, {
				type: 'cross_agent_ask',
				sessionId: 'session-1',
				question: '   ',
			});

			expect(callbacks.consultAgent).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('cross_agent_ask_result');
			expect(response.success).toBe(false);
		});

		it('reports an unknown target rather than consulting nothing', () => {
			(callbacks.getSessionDetail as any).mockReturnValue(null);

			handler.handleMessage(client, {
				type: 'cross_agent_ask',
				sessionId: 'ghost',
				question: 'q',
			});

			expect(callbacks.consultAgent).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.success).toBe(false);
			expect(response.error).toContain('not found');
		});

		it('clamps an absurd timeout instead of holding a process for a day', async () => {
			handler.handleMessage(client, {
				type: 'cross_agent_ask',
				sessionId: 'session-1',
				question: 'q',
				timeoutMs: 24 * 60 * 60 * 1000,
			});

			await vi.waitFor(() => {
				expect(callbacks.consultAgent).toHaveBeenCalled();
			});
			expect((callbacks.consultAgent as any).mock.calls[0][0].timeoutMs).toBe(60 * 60 * 1000);
		});
	});

	describe('Send Command (Web → Desktop)', () => {
		it('should forward AI command to desktop', async () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Hello Claude!',
				inputMode: 'ai',
			});

			// Wait for async callback
			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'Hello Claude!',
					'ai',
					undefined,
					false,
					undefined,
					false,
					undefined
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('command_result');
			expect(response.success).toBe(true);
		});

		it('marks a delivered CLI dispatch in the calling agent transcript', async () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Take care of the advisory bug',
				inputMode: 'ai',
				tabId: 'target-tab',
				fromSessionId: 'caller-1',
				fromTabId: 'caller-tab',
			});

			await vi.waitFor(() => {
				expect(callbacks.noteAgentDelegation).toHaveBeenCalledWith({
					kind: 'dispatch',
					fromSessionId: 'caller-1',
					fromTabId: 'caller-tab',
					targetSessionId: 'session-1',
					targetTabId: 'target-tab',
					prompt: 'Take care of the advisory bug',
				});
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.success).toBe(true);
		});

		it('does not mark a dispatch the renderer rejected, or one with no caller', async () => {
			(callbacks.executeCommand as any).mockResolvedValueOnce(false);
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'rejected',
				inputMode: 'ai',
				fromSessionId: 'caller-1',
			});
			await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalledTimes(1));

			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'typed by a human',
				inputMode: 'ai',
			});
			await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalledTimes(2));

			expect(callbacks.noteAgentDelegation).not.toHaveBeenCalled();
		});

		it('does not mark an agent dispatching into its own conversation', async () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'loop',
				inputMode: 'ai',
				fromSessionId: 'session-1',
				fromTabId: 'tab-a',
			});
			await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
			expect(callbacks.noteAgentDelegation).not.toHaveBeenCalled();
		});

		it('should forward terminal command to desktop', async () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'ls -la',
				inputMode: 'terminal',
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'ls -la',
					'terminal',
					undefined,
					false,
					undefined,
					false,
					undefined
				);
			});
		});

		it('should reject command when session is busy', () => {
			(callbacks.getSessionDetail as any).mockReturnValue({ state: 'busy', inputMode: 'ai' });

			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'test',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('busy');
			expect(callbacks.executeCommand).not.toHaveBeenCalled();
		});

		it('omits tabId from command_result on the no-tabId path so callers do not chain to a stale snapshot', async () => {
			// The server's `activeTabId` snapshot can diverge from the renderer's
			// actual write target if the user switches tabs between IPC send and
			// receive. Echoing it would mislead `dispatch --session <returnedTabId>`
			// callers chaining a follow-up. We only echo when the caller passed an
			// explicit, authoritative tabId.
			(callbacks.getSessionDetail as any).mockReturnValue({
				state: 'idle',
				inputMode: 'ai',
				activeTabId: 'tab-active-77',
			});

			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Hello',
				inputMode: 'ai',
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalled();
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('command_result');
			expect(response.success).toBe(true);
			expect(response.tabId).toBeUndefined();
		});

		it('forwards an explicit tabId to the executeCommand callback and echoes it in command_result', async () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Hello',
				inputMode: 'ai',
				tabId: 'tab-explicit',
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'Hello',
					'ai',
					'tab-explicit',
					false,
					undefined,
					false,
					undefined
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('command_result');
			expect(response.tabId).toBe('tab-explicit');
		});

		it('accepts image-only sends in AI mode (no command, images present)', async () => {
			// The web composer allows submitting in AI mode when only images
			// are staged (no typed text). The server must not reject those
			// requests as "missing command" - instead it forwards an empty
			// command alongside the images so the renderer can attach them
			// to a default image-only prompt.
			const images = ['data:image/png;base64,abc'];
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				inputMode: 'ai',
				images,
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'',
					'ai',
					undefined,
					false,
					images,
					false,
					undefined
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('command_result');
			expect(response.success).toBe(true);
		});

		it('rejects send with neither command nor images', () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				inputMode: 'ai',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.executeCommand).not.toHaveBeenCalled();
		});

		it('forwards pasted images so the renderer can attach them to the prompt', async () => {
			const images = ['data:image/png;base64,abc', 'data:image/png;base64,def'];
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'look at this',
				inputMode: 'ai',
				images,
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'look at this',
					'ai',
					undefined,
					false,
					images,
					false,
					undefined
				);
			});
		});

		it('should bypass busy guard and forward command when force=true', async () => {
			(callbacks.getSessionDetail as any).mockReturnValue({ state: 'busy', inputMode: 'ai' });

			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'concurrent write',
				inputMode: 'ai',
				force: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'concurrent write',
					'ai',
					undefined,
					true,
					undefined,
					false,
					undefined
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('command_result');
			expect(response.success).toBe(true);
		});

		it('forwards background=true to executeCommand (dispatch backgrounds by default)', async () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'quietly',
				inputMode: 'ai',
				background: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'quietly',
					'ai',
					undefined,
					false,
					undefined,
					true,
					undefined
				);
			});
		});

		it('reads a non-boolean background as no preference on send_command', async () => {
			// 'yes' / 1 / null are not an opt-in. Anything looser than a literal
			// true would stop an existing caller from focusing.
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'hello',
				inputMode: 'ai',
				background: 'yes',
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'hello',
					'ai',
					undefined,
					false,
					undefined,
					false,
					undefined
				);
			});
		});

		it('should reject command when session not found', () => {
			(callbacks.getSessionDetail as any).mockReturnValue(null);

			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'nonexistent',
				command: 'test',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not found');
		});

		it('should reject command with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'send_command',
				command: 'test',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing');
		});

		it('should reject command with missing command', () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
		});

		it('should handle command execution failure', async () => {
			(callbacks.executeCommand as any).mockRejectedValue(new Error('Execution failed'));

			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'test',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('error');
				expect(lastResponse.message).toContain('Execution failed');
			});
		});
	});

	describe('Switch Mode (Web → Desktop)', () => {
		it('should forward mode switch to AI', async () => {
			handler.handleMessage(client, {
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'ai',
			});

			await vi.waitFor(() => {
				expect(callbacks.switchMode).toHaveBeenCalledWith('session-1', 'ai', false);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('mode_switch_result');
			expect(response.success).toBe(true);
			expect(response.mode).toBe('ai');
		});

		it('should forward mode switch to terminal', async () => {
			handler.handleMessage(client, {
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'terminal',
			});

			await vi.waitFor(() => {
				expect(callbacks.switchMode).toHaveBeenCalledWith('session-1', 'terminal', false);
			});
		});

		it('should reject mode switch with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'switch_mode',
				mode: 'ai',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.switchMode).not.toHaveBeenCalled();
		});

		it('should reject mode switch with missing mode', () => {
			handler.handleMessage(client, {
				type: 'switch_mode',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
		});
	});

	describe('Select Session (Web → Desktop)', () => {
		it('should forward session selection to desktop', async () => {
			handler.handleMessage(client, {
				type: 'select_session',
				sessionId: 'session-2',
			});

			await vi.waitFor(() => {
				expect(callbacks.selectSession).toHaveBeenCalledWith('session-2', undefined, undefined);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('select_session_result');
			expect(response.success).toBe(true);
		});

		it('should forward session selection with tabId', async () => {
			handler.handleMessage(client, {
				type: 'select_session',
				sessionId: 'session-2',
				tabId: 'tab-5',
			});

			await vi.waitFor(() => {
				expect(callbacks.selectSession).toHaveBeenCalledWith('session-2', 'tab-5', undefined);
			});
		});

		it('should reject session selection with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'select_session',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.selectSession).not.toHaveBeenCalled();
		});
	});

	describe('Select Tab (Web → Desktop)', () => {
		it('should forward tab selection to desktop', async () => {
			handler.handleMessage(client, {
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'tab-2',
			});

			await vi.waitFor(() => {
				expect(callbacks.selectTab).toHaveBeenCalledWith('session-1', 'tab-2');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('select_tab_result');
			expect(response.success).toBe(true);
			expect(response.tabId).toBe('tab-2');
		});

		it('should reject tab selection with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'select_tab',
				tabId: 'tab-2',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.selectTab).not.toHaveBeenCalled();
		});

		it('should reject tab selection with missing tabId', () => {
			handler.handleMessage(client, {
				type: 'select_tab',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
		});

		it('should handle tab selection failure', async () => {
			(callbacks.selectTab as any).mockRejectedValue(new Error('Tab not found'));

			handler.handleMessage(client, {
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'nonexistent',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('error');
				expect(lastResponse.message).toContain('Tab not found');
			});
		});
	});

	describe('New Tab (Web → Desktop)', () => {
		it('should create new tab and return tabId', async () => {
			handler.handleMessage(client, {
				type: 'new_tab',
				sessionId: 'session-1',
			});

			// Nothing on the wire means today's behaviour: the tab is focused.
			// `--background` is additive, so an absent field is never an opt-in.
			await vi.waitFor(() => {
				expect(callbacks.newTab).toHaveBeenCalledWith('session-1', false);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('new_tab_result');
			expect(response.success).toBe(true);
			expect(response.tabId).toBe('new-tab-123');
			expect(response.background).toBe(false);
		});

		it('creates the tab in the background when asked', async () => {
			handler.handleMessage(client, {
				type: 'new_tab',
				sessionId: 'session-1',
				background: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.newTab).toHaveBeenCalledWith('session-1', true);
			});
		});

		it('should reject new tab with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'new_tab',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.newTab).not.toHaveBeenCalled();
		});

		it('should handle new tab creation failure', async () => {
			(callbacks.newTab as any).mockResolvedValue(null);

			handler.handleMessage(client, {
				type: 'new_tab',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
				expect(response.type).toBe('new_tab_result');
				expect(response.success).toBe(false);
			});
		});
	});

	describe('Close Tab (Web → Desktop)', () => {
		it('should close tab on desktop', async () => {
			handler.handleMessage(client, {
				type: 'close_tab',
				sessionId: 'session-1',
				tabId: 'tab-to-close',
			});

			await vi.waitFor(() => {
				expect(callbacks.closeTab).toHaveBeenCalledWith('session-1', 'tab-to-close');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('close_tab_result');
			expect(response.success).toBe(true);
		});

		it('should reject close tab with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'close_tab',
				tabId: 'tab-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
		});

		it('should reject close tab with missing tabId', () => {
			handler.handleMessage(client, {
				type: 'close_tab',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
		});
	});

	describe('Rename Tab (Web → Desktop)', () => {
		it('should rename tab on desktop', async () => {
			handler.handleMessage(client, {
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-to-rename',
				newName: 'New Tab Name',
			});

			await vi.waitFor(() => {
				expect(callbacks.renameTab).toHaveBeenCalledWith(
					'session-1',
					'tab-to-rename',
					'New Tab Name'
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('rename_tab_result');
			expect(response.success).toBe(true);
			expect(response.newName).toBe('New Tab Name');
		});

		it('should allow renaming to empty string (clear name)', async () => {
			handler.handleMessage(client, {
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
				newName: '',
			});

			await vi.waitFor(() => {
				expect(callbacks.renameTab).toHaveBeenCalledWith('session-1', 'tab-1', '');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('rename_tab_result');
			expect(response.success).toBe(true);
		});

		it('should return explicit failure when desktop rename fails', async () => {
			vi.mocked(callbacks.renameTab).mockResolvedValueOnce({
				success: false,
				error: 'Tab not found: tab-1',
			});

			handler.handleMessage(client, {
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
				newName: 'New Name',
			});

			await vi.waitFor(() => {
				expect(callbacks.renameTab).toHaveBeenCalledWith('session-1', 'tab-1', 'New Name');
			});
			await vi.waitFor(() => {
				expect(client.socket.send).toHaveBeenCalled();
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('rename_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toBe('Tab not found: tab-1');
		});

		it('should not report a definitive rename result while desktop confirmation is unknown', async () => {
			vi.mocked(callbacks.renameTab).mockResolvedValueOnce({
				success: false,
				error: 'The desktop did not confirm the rename; it may still be applying',
				unconfirmed: true,
			});

			handler.handleMessage(client, {
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
				newName: 'Slow Name',
			});

			await vi.waitFor(() => {
				expect(callbacks.renameTab).toHaveBeenCalledWith('session-1', 'tab-1', 'Slow Name');
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(client.socket.send).not.toHaveBeenCalled();
		});

		it('should return explicit failure when desktop rename throws', async () => {
			vi.mocked(callbacks.renameTab).mockRejectedValueOnce(new Error('disk full'));

			handler.handleMessage(client, {
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
				newName: 'New Name',
			});

			await vi.waitFor(() => {
				expect(callbacks.renameTab).toHaveBeenCalledWith('session-1', 'tab-1', 'New Name');
			});
			await vi.waitFor(() => {
				expect(client.socket.send).toHaveBeenCalled();
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('rename_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toBe('Failed to rename tab: disk full');
		});

		it('should reject rename tab with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'rename_tab',
				tabId: 'tab-1',
				newName: 'New Name',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId or tabId');
		});

		it('should reject rename tab with missing tabId', () => {
			handler.handleMessage(client, {
				type: 'rename_tab',
				sessionId: 'session-1',
				newName: 'New Name',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId or tabId');
		});
	});

	describe('Get Sessions', () => {
		it('should return sessions list with live info', () => {
			(callbacks.getLiveSessionInfo as any).mockReturnValue({
				sessionId: 'session-1',
				agentSessionId: 'live-claude-456',
				enabledAt: 123456789,
			});
			(callbacks.isSessionLive as any).mockReturnValue(true);

			handler.handleMessage(client, { type: 'get_sessions' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('sessions_list');
			expect(response.sessions).toHaveLength(1);
			expect(response.sessions[0].agentSessionId).toBe('live-claude-456');
			expect(response.sessions[0].isLive).toBe(true);
		});
	});

	describe('Open File Tab (Web → Desktop)', () => {
		it('should forward open file tab to desktop with sessionId and filePath', async () => {
			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
				filePath: '/home/user/project/src/index.ts',
			});

			await vi.waitFor(() => {
				// The handler forwards `path.resolve(sessionRoot, filePath)`, which on
				// Windows carries the CWD drive letter. Route the expectation through
				// the same primitive so it stays platform-symmetric (no-op on POSIX).
				expect(callbacks.openFileTab).toHaveBeenCalledWith(
					'session-1',
					path.resolve(path.resolve('/home/user/project'), '/home/user/project/src/index.ts'),
					{ background: false, switchToAgent: true, mediaMode: 'play' }
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_file_tab_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
			expect(response.filePath).toBe('/home/user/project/src/index.ts');
		});

		it('keeps switchToAgent=false meaning --no-switch, NOT --background', async () => {
			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
				filePath: '/home/user/project/src/index.ts',
				switchToAgent: false,
			});

			// The weaker, older ask: stay on the current agent, but still activate
			// the tab in the target one. Folding it into `background` would silently
			// change behaviour for every caller already passing `--no-switch`.
			await vi.waitFor(() => {
				expect(callbacks.openFileTab).toHaveBeenCalledWith(
					'session-1',
					path.resolve(path.resolve('/home/user/project'), '/home/user/project/src/index.ts'),
					{ background: false, switchToAgent: false, mediaMode: 'play' }
				);
			});
		});

		it('forwards background:true as the stronger, independent ask', async () => {
			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
				filePath: '/home/user/project/src/index.ts',
				background: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.openFileTab).toHaveBeenCalledWith(
					'session-1',
					path.resolve(path.resolve('/home/user/project'), '/home/user/project/src/index.ts'),
					{ background: true, switchToAgent: true, mediaMode: 'play' }
				);
			});
		});

		it('carries both flags when both are passed, background being stronger', async () => {
			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
				filePath: '/home/user/project/src/index.ts',
				background: true,
				switchToAgent: false,
			});

			await vi.waitFor(() => {
				expect(callbacks.openFileTab).toHaveBeenCalledWith(
					'session-1',
					path.resolve(path.resolve('/home/user/project'), '/home/user/project/src/index.ts'),
					{ background: true, switchToAgent: false, mediaMode: 'play' }
				);
			});
		});

		it("forwards mediaMode 'queue' so audio/video is queued without playing", async () => {
			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
				filePath: '/home/user/project/ep1.mp3',
				mediaMode: 'queue',
			});

			await vi.waitFor(() => {
				expect(callbacks.openFileTab).toHaveBeenCalledWith(
					'session-1',
					path.resolve(path.resolve('/home/user/project'), '/home/user/project/ep1.mp3'),
					{ background: false, switchToAgent: true, mediaMode: 'queue' }
				);
			});
		});

		it("treats any mediaMode other than 'queue' as play", async () => {
			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
				filePath: '/home/user/project/ep1.mp3',
				// Untrusted wire input: the handler narrows anything unknown to play.
				mediaMode: 'shuffle' as never,
			});

			await vi.waitFor(() => {
				expect(callbacks.openFileTab).toHaveBeenCalledWith(
					'session-1',
					path.resolve(path.resolve('/home/user/project'), '/home/user/project/ep1.mp3'),
					{ background: false, switchToAgent: true, mediaMode: 'play' }
				);
			});
		});

		it('should reject open file tab with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'open_file_tab',
				filePath: '/home/user/project/src/index.ts',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_file_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or filePath');
			expect(callbacks.openFileTab).not.toHaveBeenCalled();
		});

		it('should reject open file tab with missing filePath', () => {
			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_file_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or filePath');
			expect(callbacks.openFileTab).not.toHaveBeenCalled();
		});

		it('should handle open file tab callback failure', async () => {
			(callbacks.openFileTab as any).mockRejectedValue(new Error('File not found'));

			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
				filePath: '/home/user/project/nonexistent/file.ts',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('open_file_tab_result');
				expect(lastResponse.success).toBe(false);
				expect(lastResponse.error).toContain('File not found');
			});
		});

		it('should forward paths that resolve outside the worktree', async () => {
			// Opening files outside the worktree is intentionally allowed - a paired
			// client already has shell-level access (execute_command), so confining
			// preview tabs to the worktree gated nothing the connection token didn't.
			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
				filePath: '/home/user/project/../../etc/passwd',
			});

			await vi.waitFor(() => {
				expect(callbacks.openFileTab).toHaveBeenCalledWith(
					'session-1',
					path.resolve(path.resolve('/home/user/project'), '/home/user/project/../../etc/passwd'),
					{ background: false, switchToAgent: true, mediaMode: 'play' }
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_file_tab_result');
			expect(response.success).toBe(true);
		});
	});

	describe('Open Browser Tab (Web → Desktop)', () => {
		it('should forward open browser tab with sessionId and url', async () => {
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'session-1',
				url: 'https://example.com/',
			});

			// An absent field is not an opt-in: today's behaviour is preserved.
			await vi.waitFor(() => {
				expect(callbacks.openBrowserTab).toHaveBeenCalledWith('session-1', 'https://example.com/', {
					background: false,
				});
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_browser_tab_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
			expect(response.url).toBe('https://example.com/');
			expect(response.background).toBe(false);
		});

		it('should forward the background flag and return the created tab id', async () => {
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'session-1',
				url: 'https://example.com/',
				background: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.openBrowserTab).toHaveBeenCalledWith('session-1', 'https://example.com/', {
					background: true,
				});
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.success).toBe(true);
			expect(response.background).toBe(true);
			// The tab id is the handle the caller needs to close it again.
			expect(response.tabId).toBe('browser-tab-1');
		});

		it('treats a non-boolean background as no preference', async () => {
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'session-1',
				url: 'https://example.com/',
				background: 'yes',
			});

			// Only a literal `true` opts in. Anything else leaves the verb doing
			// exactly what it does today.
			await vi.waitFor(() => {
				expect(callbacks.openBrowserTab).toHaveBeenCalledWith('session-1', 'https://example.com/', {
					background: false,
				});
			});
		});

		it('should reject missing sessionId or url', () => {
			handler.handleMessage(client, { type: 'open_browser_tab', sessionId: 'session-1' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_browser_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or url');
			expect(callbacks.openBrowserTab).not.toHaveBeenCalled();
		});

		it('should reject invalid URL', () => {
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'session-1',
				url: 'not a url',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_browser_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid URL');
			expect(callbacks.openBrowserTab).not.toHaveBeenCalled();
		});

		it('should reject non-http(s) protocols', () => {
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'session-1',
				url: 'file:///etc/passwd',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_browser_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Unsupported URL protocol');
			expect(callbacks.openBrowserTab).not.toHaveBeenCalled();
		});

		it('should normalize bare host:port as http://', async () => {
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'session-1',
				url: 'localhost:3000',
			});

			await vi.waitFor(() => {
				expect(callbacks.openBrowserTab).toHaveBeenCalledWith(
					'session-1',
					'http://localhost:3000/',
					{ background: false }
				);
			});
		});

		it('should reject when session does not exist', () => {
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'ghost-session',
				url: 'https://example.com/',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_browser_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toBe('Session not found');
			expect(callbacks.openBrowserTab).not.toHaveBeenCalled();
		});

		it('should handle callback failure', async () => {
			(callbacks.openBrowserTab as any).mockRejectedValue(new Error('boom'));
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'session-1',
				url: 'https://example.com/',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('open_browser_tab_result');
				expect(lastResponse.success).toBe(false);
				expect(lastResponse.error).toContain('boom');
			});
		});
	});

	describe('Close Browser Tab (Web → Desktop)', () => {
		it('should forward close browser tab with the tab id', async () => {
			handler.handleMessage(client, { type: 'close_browser_tab', tabId: 'browser-tab-1' });

			await vi.waitFor(() => {
				expect(callbacks.closeBrowserTab).toHaveBeenCalledWith('browser-tab-1');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('close_browser_tab_result');
			expect(response.success).toBe(true);
			expect(response.tabId).toBe('browser-tab-1');
		});

		it('should reject a missing tab id', () => {
			handler.handleMessage(client, { type: 'close_browser_tab' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('close_browser_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing tabId');
			expect(callbacks.closeBrowserTab).not.toHaveBeenCalled();
		});

		it('should report not-found rather than a false success when no such tab exists', async () => {
			(callbacks.closeBrowserTab as any).mockResolvedValue(false);
			handler.handleMessage(client, { type: 'close_browser_tab', tabId: 'ghost-tab' });

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.success).toBe(false);
				expect(lastResponse.error).toContain('ghost-tab');
			});
		});

		it('should handle callback failure', async () => {
			(callbacks.closeBrowserTab as any).mockRejectedValue(new Error('boom'));
			handler.handleMessage(client, { type: 'close_browser_tab', tabId: 'browser-tab-1' });

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('close_browser_tab_result');
				expect(lastResponse.success).toBe(false);
				expect(lastResponse.error).toContain('boom');
			});
		});
	});

	describe('Open Terminal Tab (Web → Desktop)', () => {
		it('forwards an explicit human-input request to the terminal opener', async () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				inputRequired: true,
			});
			await vi.waitFor(() => {
				expect(callbacks.openTerminalTab).toHaveBeenCalledWith(
					'session-1',
					expect.objectContaining({ inputRequired: true }),
					{ background: false }
				);
			});
		});

		it('rejects a malformed human-input signal', () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				inputRequired: 'yes',
			});
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
			expect((client.socket.send as any).mock.calls[0][0]).toContain('Invalid inputRequired');
		});

		it('should forward open terminal tab with sessionId', async () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
			});

			// open_terminal_tab carried no placement field at all before this. It now
			// carries one, and an absent value still means "switch", as it always did.
			await vi.waitFor(() => {
				expect(callbacks.openTerminalTab).toHaveBeenCalledWith(
					'session-1',
					{
						cwd: undefined,
						shell: undefined,
						name: undefined,
						command: undefined,
					},
					{ background: false }
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
			expect(response.background).toBe(false);
			// The id is the handle for send-terminal, so it has to survive the hop.
			expect(response.tabId).toBe('terminal-tab-1');
		});

		it('creates the terminal in the background when asked', async () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				background: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.openTerminalTab).toHaveBeenCalledWith('session-1', expect.anything(), {
					background: true,
				});
			});
		});

		it('should forward optional shell and name', async () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				shell: 'bash',
				name: 'build logs',
			});

			await vi.waitFor(() => {
				expect(callbacks.openTerminalTab).toHaveBeenCalledWith(
					'session-1',
					{
						cwd: undefined,
						shell: 'bash',
						name: 'build logs',
						command: undefined,
					},
					{ background: false }
				);
			});
		});

		it('should forward a startup command', async () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				name: 'Dev server',
				command: 'npm run dev',
			});

			await vi.waitFor(() => {
				expect(callbacks.openTerminalTab).toHaveBeenCalledWith(
					'session-1',
					expect.objectContaining({ name: 'Dev server', command: 'npm run dev' }),
					{ background: false }
				);
			});
		});

		it('should treat a whitespace-only command as no command', async () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				command: '   ',
			});

			await vi.waitFor(() => {
				expect(callbacks.openTerminalTab).toHaveBeenCalledWith(
					'session-1',
					expect.objectContaining({ command: undefined }),
					{ background: false }
				);
			});
		});

		it('should reject non-string command', () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				command: 42 as unknown as string,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid command');
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});

		it('should reject cwd outside the agent working directory', async () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				cwd: '/home/user/project/../../etc',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('open_terminal_tab_result');
				expect(lastResponse.success).toBe(false);
				expect(lastResponse.error).toContain('Invalid cwd');
			});
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});

		// Skipped where the OS forbids symlink creation (e.g. Windows without
		// Developer Mode), since the `beforeEach` below calls `fs.symlinkSync`.
		describe.skipIf(!canSymlink())('symlink-safe cwd confinement', () => {
			let sessionRoot: string;
			let outside: string;
			const createdPaths: string[] = [];

			beforeEach(() => {
				const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-openterm-'));
				sessionRoot = fs.mkdtempSync(path.join(tmpBase, 'root-'));
				outside = fs.mkdtempSync(path.join(tmpBase, 'outside-'));
				fs.mkdirSync(path.join(sessionRoot, 'sub'));
				fs.symlinkSync(outside, path.join(sessionRoot, 'link-to-outside'));
				createdPaths.push(tmpBase);

				(callbacks.getSessions as any).mockReturnValue([
					{
						id: 'session-real',
						name: 'Real Session',
						toolType: 'claude-code',
						state: 'idle',
						inputMode: 'ai',
						cwd: sessionRoot,
					},
				]);
			});

			afterAll(() => {
				for (const p of createdPaths) {
					try {
						fs.rmSync(p, { recursive: true, force: true });
					} catch {
						// best-effort cleanup
					}
				}
			});

			it('should allow a real subdirectory of the session root', async () => {
				handler.handleMessage(client, {
					type: 'open_terminal_tab',
					sessionId: 'session-real',
					cwd: 'sub',
				});

				await vi.waitFor(() => {
					expect(callbacks.openTerminalTab).toHaveBeenCalledWith(
						'session-real',
						expect.objectContaining({
							// realpathSync.native, not realpathSync: the product resolves via
							// fs.promises.realpath (native), which expands Windows 8.3 short
							// names (RUNNER~1 -> runneradmin); the JS realpathSync does not.
							cwd: fs.realpathSync.native(path.join(sessionRoot, 'sub')),
						}),
						{ background: false }
					);
				});
			});

			it('should reject a symlink pointing outside the session root', async () => {
				handler.handleMessage(client, {
					type: 'open_terminal_tab',
					sessionId: 'session-real',
					cwd: 'link-to-outside',
				});

				await vi.waitFor(() => {
					const calls = (client.socket.send as any).mock.calls;
					const lastResponse = JSON.parse(calls[calls.length - 1][0]);
					expect(lastResponse.type).toBe('open_terminal_tab_result');
					expect(lastResponse.success).toBe(false);
					expect(lastResponse.error).toContain('outside the agent working directory');
				});
				expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
			});
		});

		it('should reject missing sessionId', () => {
			handler.handleMessage(client, { type: 'open_terminal_tab' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId');
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});

		it('should reject when session does not exist', () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'ghost-session',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toBe('Session not found');
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});

		it('should reject non-string cwd', () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				cwd: 42 as unknown as string,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid cwd');
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});

		it('should reject non-string shell', () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				shell: true as unknown as string,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid shell');
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});

		it('should reject non-string/non-null name', () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				name: 123 as unknown as string,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid name');
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});
	});

	describe('Write Terminal Tab (Web → Desktop)', () => {
		it('should forward the data and echo back the tab that received it', async () => {
			handler.handleMessage(client, {
				type: 'write_terminal_tab',
				sessionId: 'session-1',
				data: 'npm run dev\n',
			});

			await vi.waitFor(() => {
				expect(callbacks.writeTerminalTab).toHaveBeenCalledWith('session-1', {
					tabRef: undefined,
					data: 'npm run dev\n',
				});
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const response = JSON.parse(calls[calls.length - 1][0]);
				expect(response.type).toBe('write_terminal_tab_result');
				expect(response.success).toBe(true);
				expect(response.tabId).toBe('terminal-tab-1');
				expect(response.tabName).toBe('Dev server');
			});
		});

		it('should forward an explicit tabRef', async () => {
			handler.handleMessage(client, {
				type: 'write_terminal_tab',
				sessionId: 'session-1',
				tabRef: 'Dev server',
				data: '',
			});

			await vi.waitFor(() => {
				expect(callbacks.writeTerminalTab).toHaveBeenCalledWith('session-1', {
					tabRef: 'Dev server',
					data: '',
				});
			});
		});

		it('should surface the resolution error from the desktop app', async () => {
			(callbacks.writeTerminalTab as any).mockResolvedValue({
				success: false,
				error: 'No terminal tab is open for this agent. Use open-terminal first.',
			});
			handler.handleMessage(client, {
				type: 'write_terminal_tab',
				sessionId: 'session-1',
				data: 'ls\n',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const response = JSON.parse(calls[calls.length - 1][0]);
				expect(response.type).toBe('write_terminal_tab_result');
				expect(response.success).toBe(false);
				expect(response.error).toContain('No terminal tab is open');
			});
		});

		it('should reject empty data rather than writing a bare newline', () => {
			handler.handleMessage(client, {
				type: 'write_terminal_tab',
				sessionId: 'session-1',
				data: '',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('write_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid data');
			expect(callbacks.writeTerminalTab).not.toHaveBeenCalled();
		});

		it('should reject non-string tabRef', () => {
			handler.handleMessage(client, {
				type: 'write_terminal_tab',
				sessionId: 'session-1',
				tabRef: 7 as unknown as string,
				data: 'ls\n',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid tabRef');
			expect(callbacks.writeTerminalTab).not.toHaveBeenCalled();
		});

		it('should reject when the session does not exist', () => {
			handler.handleMessage(client, {
				type: 'write_terminal_tab',
				sessionId: 'ghost-session',
				data: 'ls\n',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.success).toBe(false);
			expect(response.error).toBe('Session not found');
			expect(callbacks.writeTerminalTab).not.toHaveBeenCalled();
		});
	});

	describe('List Terminal Tabs (Web → Desktop)', () => {
		it('should return the tabs the desktop app reports', async () => {
			(callbacks.listTerminalTabs as any).mockResolvedValue([
				{
					tabId: 'terminal-tab-1',
					agentId: 'session-1',
					agentName: 'Test Session',
					name: 'Dev server',
					cwd: '/home/user/project',
					pid: 4242,
					state: 'busy',
					active: true,
					startupCommand: 'npm run dev',
				},
			]);
			handler.handleMessage(client, { type: 'list_terminal_tabs', sessionId: 'session-1' });

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const response = JSON.parse(calls[calls.length - 1][0]);
				expect(response.type).toBe('list_terminal_tabs_result');
				expect(response.success).toBe(true);
				expect(response.tabs).toHaveLength(1);
				expect(response.tabs[0].tabId).toBe('terminal-tab-1');
			});
			expect(callbacks.listTerminalTabs).toHaveBeenCalledWith('session-1');
		});

		it('should list every agent when no sessionId is given', async () => {
			handler.handleMessage(client, { type: 'list_terminal_tabs' });

			await vi.waitFor(() => {
				expect(callbacks.listTerminalTabs).toHaveBeenCalledWith(undefined);
			});
		});
	});

	describe('Group Chat (CLI/Web → Desktop)', () => {
		const lastResponse = () => {
			const calls = (client.socket.send as any).mock.calls;
			return JSON.parse(calls[calls.length - 1][0]);
		};

		it('starts a chat with one participant and forwards the moderator and opening message', async () => {
			handler.handleMessage(client, {
				type: 'start_group_chat',
				topic: 'Release rc',
				participantIds: ['session-1'],
				moderatorAgentId: 'claude-code',
				message: '@rc cut the release',
				requestId: 'req-1',
			});

			await vi.waitFor(() => {
				expect(lastResponse()).toMatchObject({
					type: 'start_group_chat_result',
					success: true,
					chatId: 'chat-1',
					requestId: 'req-1',
				});
			});
			expect(callbacks.startGroupChat).toHaveBeenCalledWith('Release rc', ['session-1'], {
				moderatorAgentId: 'claude-code',
				message: '@rc cut the release',
			});
		});

		it('reports the renderer error, with the chat id when the chat was created', async () => {
			(callbacks.startGroupChat as any).mockResolvedValue({
				chatId: 'chat-2',
				error: 'Chat created, but the opening message failed: boom',
			});
			handler.handleMessage(client, {
				type: 'start_group_chat',
				topic: 'Release',
				participantIds: ['session-1'],
				requestId: 'req-2',
			});

			await vi.waitFor(() => {
				expect(lastResponse()).toMatchObject({
					type: 'start_group_chat_result',
					success: false,
					chatId: 'chat-2',
					error: 'Chat created, but the opening message failed: boom',
				});
			});
		});

		it('says the app did not answer when the renderer times out', async () => {
			(callbacks.startGroupChat as any).mockResolvedValue(null);
			handler.handleMessage(client, {
				type: 'start_group_chat',
				topic: 'Release',
				participantIds: ['session-1'],
			});

			await vi.waitFor(() => {
				expect(lastResponse()).toMatchObject({
					success: false,
					error: 'The desktop app did not answer',
				});
			});
		});

		it('refuses a start with no participants, tagging the error with the requestId', () => {
			handler.handleMessage(client, {
				type: 'start_group_chat',
				topic: 'Release',
				participantIds: [],
				requestId: 'req-3',
			});

			expect(lastResponse()).toMatchObject({
				type: 'error',
				message: 'At least 1 participant is required',
				requestId: 'req-3',
			});
			expect(callbacks.startGroupChat).not.toHaveBeenCalled();
		});

		it('tags a missing chatId error with the requestId so the CLI does not time out', () => {
			handler.handleMessage(client, { type: 'get_group_chat_state', requestId: 'req-4' });

			expect(lastResponse()).toMatchObject({
				type: 'error',
				message: 'Missing chatId',
				requestId: 'req-4',
			});
		});

		describe('steer_group_chat', () => {
			it('steers new text and answers with the result', async () => {
				handler.handleMessage(client, {
					type: 'steer_group_chat',
					chatId: 'chat-1',
					message: 'also check the docs',
					readOnly: true,
					requestId: 'req-s1',
				});

				await vi.waitFor(() => {
					expect(lastResponse()).toMatchObject({
						type: 'steer_group_chat_result',
						success: true,
						chatId: 'chat-1',
						result: { outcome: 'delivered', verdict: 'delivered', targets: ['Moderator'] },
						requestId: 'req-s1',
					});
				});
				expect(callbacks.steerGroupChat).toHaveBeenCalledWith('chat-1', {
					message: 'also check the docs',
					readOnly: true,
				});
			});

			it('steers a queued item by id', async () => {
				(callbacks.steerGroupChat as any).mockResolvedValue({
					outcome: 'settled',
					verdict: 'absorbed',
					targets: ['Alice'],
				});
				handler.handleMessage(client, {
					type: 'steer_group_chat',
					chatId: 'chat-1',
					itemId: 'item-1',
					requestId: 'req-s2',
				});

				await vi.waitFor(() => {
					expect(lastResponse()).toMatchObject({
						type: 'steer_group_chat_result',
						success: true,
						requestId: 'req-s2',
					});
				});
				expect(callbacks.steerGroupChat).toHaveBeenCalledWith('chat-1', { itemId: 'item-1' });
			});

			it('answers a refusal as a result, not an error', async () => {
				(callbacks.steerGroupChat as any).mockResolvedValue({
					outcome: 'not-steerable',
					blockedReason: 'room-idle',
					detail: 'Nothing is running in this room, so there is nothing to steer.',
				});
				handler.handleMessage(client, {
					type: 'steer_group_chat',
					chatId: 'chat-1',
					message: 'hello',
					requestId: 'req-s3',
				});

				await vi.waitFor(() => {
					expect(lastResponse()).toMatchObject({
						type: 'steer_group_chat_result',
						success: false,
						result: { outcome: 'not-steerable', blockedReason: 'room-idle' },
						requestId: 'req-s3',
					});
				});
			});

			it('rejects a missing chatId', () => {
				handler.handleMessage(client, {
					type: 'steer_group_chat',
					message: 'hello',
					requestId: 'req-s4',
				});

				expect(lastResponse()).toMatchObject({
					type: 'error',
					message: 'Missing chatId',
					requestId: 'req-s4',
				});
				expect(callbacks.steerGroupChat).not.toHaveBeenCalled();
			});

			it.each([
				['neither', {}],
				['only blank text', { message: '   ' }],
				['both', { message: 'hello', itemId: 'item-1' }],
			])('rejects %s a message and an item id', (_label, fields) => {
				handler.handleMessage(client, {
					type: 'steer_group_chat',
					chatId: 'chat-1',
					requestId: 'req-s5',
					...fields,
				});

				expect(lastResponse()).toMatchObject({
					type: 'error',
					message: 'Pass a queued item id or a message, not both',
					requestId: 'req-s5',
				});
				expect(callbacks.steerGroupChat).not.toHaveBeenCalled();
			});

			it('rejects readOnly together with a queued item id', () => {
				handler.handleMessage(client, {
					type: 'steer_group_chat',
					chatId: 'chat-1',
					itemId: 'item-1',
					readOnly: true,
					requestId: 'req-s7',
				});

				expect(lastResponse()).toMatchObject({
					type: 'error',
					message: 'readOnly applies to new text; a queued item keeps its own',
					requestId: 'req-s7',
				});
				expect(callbacks.steerGroupChat).not.toHaveBeenCalled();
			});

			it('reports a callback that throws, tagged with the requestId', async () => {
				(callbacks.steerGroupChat as any).mockRejectedValue(new Error('queue gone'));
				handler.handleMessage(client, {
					type: 'steer_group_chat',
					chatId: 'chat-1',
					message: 'hello',
					requestId: 'req-s6',
				});

				await vi.waitFor(() => {
					expect(lastResponse()).toMatchObject({
						type: 'error',
						message: 'Failed to steer group chat: queue gone',
						requestId: 'req-s6',
					});
				});
			});
		});
	});

	describe('Read Terminal Tab (Web → Desktop)', () => {
		it('should return the scrollback along with the tab it came from', async () => {
			handler.handleMessage(client, {
				type: 'read_terminal_tab',
				sessionId: 'session-1',
				tail: 50,
			});

			await vi.waitFor(() => {
				expect(callbacks.readTerminalTab).toHaveBeenCalledWith('session-1', {
					tabRef: undefined,
					tail: 50,
				});
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const response = JSON.parse(calls[calls.length - 1][0]);
				expect(response.type).toBe('read_terminal_tab_result');
				expect(response.success).toBe(true);
				expect(response.content).toBe('line one\nline two');
				expect(response.tabName).toBe('Dev server');
				// `state` is what lets a caller tell a finished command from a
				// running one, so it has to survive the hop.
				expect(response.state).toBe('busy');
				expect(response.totalLines).toBe(2);
			});
		});

		it('should forward an explicit tabRef', async () => {
			handler.handleMessage(client, {
				type: 'read_terminal_tab',
				sessionId: 'session-1',
				tabRef: 'Dev server',
			});

			await vi.waitFor(() => {
				expect(callbacks.readTerminalTab).toHaveBeenCalledWith('session-1', {
					tabRef: 'Dev server',
					tail: undefined,
				});
			});
		});

		it('should reject a missing sessionId', async () => {
			handler.handleMessage(client, { type: 'read_terminal_tab' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('read_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId');
			expect(callbacks.readTerminalTab).not.toHaveBeenCalled();
		});

		it('should reject a non-positive tail', async () => {
			handler.handleMessage(client, {
				type: 'read_terminal_tab',
				sessionId: 'session-1',
				tail: 0,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid tail');
			expect(callbacks.readTerminalTab).not.toHaveBeenCalled();
		});

		it('should surface a failed read rather than reporting empty output', async () => {
			(callbacks.readTerminalTab as any).mockResolvedValue({
				success: false,
				error: 'Terminal "Dev server" has no live buffer yet.',
			});
			handler.handleMessage(client, {
				type: 'read_terminal_tab',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const response = JSON.parse(calls[calls.length - 1][0]);
				expect(response.success).toBe(false);
				expect(response.error).toContain('no live buffer');
				expect(response.content).toBeUndefined();
			});
		});
	});

	describe('New AI Tab With Prompt (Web → Desktop)', () => {
		it('marks a CLI dispatch into a fresh tab with the new tab id', async () => {
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 'Build it',
				fromSessionId: 'caller-1',
				fromTabId: 'caller-tab',
			});

			await vi.waitFor(() => {
				expect(callbacks.noteAgentDelegation).toHaveBeenCalledWith({
					kind: 'dispatch',
					fromSessionId: 'caller-1',
					fromTabId: 'caller-tab',
					targetSessionId: 'session-1',
					targetTabId: 'tab-mock-123',
					prompt: 'Build it',
					newTab: true,
				});
			});
		});

		it('should forward sessionId and prompt to callback', async () => {
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 'Summarize the repo',
			});

			await vi.waitFor(() => {
				// The MESSAGE default is foreground. `dispatch --new-tab` sends
				// background:true explicitly; `tab new --prompt` sends false.
				expect(callbacks.newAITabWithPrompt).toHaveBeenCalledWith(
					'session-1',
					'Summarize the repo',
					false,
					false,
					undefined
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('new_ai_tab_with_prompt_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
			// PR1: surface the freshly-created tabId so `dispatch --new-tab`
			// can return an addressable id without owning a persistent channel.
			expect(response.tabId).toBe('tab-mock-123');
		});

		it('forwards background=true to newAITabWithPrompt (dispatch --new-tab backgrounds by default)', async () => {
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 'Summarize the repo',
				background: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.newAITabWithPrompt).toHaveBeenCalledWith(
					'session-1',
					'Summarize the repo',
					true,
					false,
					undefined
				);
			});
		});

		it('forwards hidden=true for a background dispatch (dispatch --new-tab hides by default)', async () => {
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 'Summarize the repo',
				background: true,
				hidden: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.newAITabWithPrompt).toHaveBeenCalledWith(
					'session-1',
					'Summarize the repo',
					true,
					true,
					undefined
				);
			});
		});

		it('never hides a foreground tab, even when asked', async () => {
			// A focused tab the strip does not draw would strand the user on it.
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 'Summarize the repo',
				hidden: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.newAITabWithPrompt).toHaveBeenCalledWith(
					'session-1',
					'Summarize the repo',
					false,
					false,
					undefined
				);
			});
		});

		it('should reject missing sessionId', () => {
			handler.handleMessage(client, { type: 'new_ai_tab_with_prompt', prompt: 'hello' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('new_ai_tab_with_prompt_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or prompt');
			expect(callbacks.newAITabWithPrompt).not.toHaveBeenCalled();
		});

		it('should reject missing prompt', () => {
			handler.handleMessage(client, { type: 'new_ai_tab_with_prompt', sessionId: 'session-1' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('new_ai_tab_with_prompt_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or prompt');
			expect(callbacks.newAITabWithPrompt).not.toHaveBeenCalled();
		});

		it('should reject non-string prompt without throwing', () => {
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 42 as unknown as string,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('new_ai_tab_with_prompt_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or prompt');
			expect(callbacks.newAITabWithPrompt).not.toHaveBeenCalled();
		});

		it('should reject when session does not exist', () => {
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'ghost-session',
				prompt: 'hello',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('new_ai_tab_with_prompt_result');
			expect(response.success).toBe(false);
			expect(response.error).toBe('Session not found');
			expect(callbacks.newAITabWithPrompt).not.toHaveBeenCalled();
		});

		it('should handle callback failure', async () => {
			(callbacks.newAITabWithPrompt as any).mockRejectedValue(new Error('boom'));
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 'hello',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('new_ai_tab_with_prompt_result');
				expect(lastResponse.success).toBe(false);
				expect(lastResponse.error).toContain('boom');
			});
		});
	});

	describe('Dispatch Callbacks (dispatch --notify-on-complete)', () => {
		const lastSend = (): Record<string, unknown> => {
			const calls = vi.mocked(client.socket.send).mock.calls;
			return JSON.parse(String(calls[calls.length - 1][0]));
		};

		beforeEach(() => {
			initDispatchCallbacks({ enqueue: vi.fn().mockResolvedValue({ success: true }) });
		});

		afterEach(() => {
			disposeDispatchCallbacks();
		});

		it('arms a callback on new_ai_tab_with_prompt and echoes the callbackId', async () => {
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 'go',
				notifyOnComplete: 'caller-1',
			});

			await vi.waitFor(() => {
				const response = lastSend();
				expect(response.type).toBe('new_ai_tab_with_prompt_result');
				expect(response.success).toBe(true);
				expect(response.callbackId).toBeTruthy();
			});
			expect(getDispatchCallbackRegistry()!.hasArmedFor('session-1', 'tab-mock-123')).toBe(true);
		});

		it('arms a callback on send_command for an explicit tab', async () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'go',
				inputMode: 'ai',
				tabId: 'tab-7',
				notifyOnComplete: 'caller-1',
			});

			await vi.waitFor(() => {
				const response = lastSend();
				expect(response.type).toBe('command_result');
				expect(response.callbackId).toBeTruthy();
			});
			expect(getDispatchCallbackRegistry()!.hasArmedFor('session-1', 'tab-7')).toBe(true);
		});

		it('rejects send_command without an explicit target tab', () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'go',
				inputMode: 'ai',
				notifyOnComplete: 'caller-1',
			});

			const response = lastSend();
			expect(response.type).toBe('error');
			expect(String(response.message)).toContain('requires an explicit target tab');
			expect(callbacks.executeCommand).not.toHaveBeenCalled();
		});

		it('cancels the armed callback when the dispatch is rejected', async () => {
			vi.mocked(callbacks.executeCommand!).mockResolvedValue(false);
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'go',
				inputMode: 'ai',
				tabId: 'tab-7',
				notifyOnComplete: 'caller-1',
			});

			await vi.waitFor(() => expect(lastSend().type).toBe('command_result'));
			expect(getDispatchCallbackRegistry()!.hasArmedFor('session-1', 'tab-7')).toBe(false);
			// A rejected dispatch must not read as success, and must not hand back
			// a callbackId the caller would then wait on forever. This path was
			// dead until `executeCommand` started reporting real delivery.
			const response = lastSend();
			expect(response.success).toBe(false);
			expect(response.callbackId).toBeUndefined();
		});

		it('refuses a second callback on the same tab', async () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'go',
				inputMode: 'ai',
				tabId: 'tab-7',
				notifyOnComplete: 'caller-1',
			});
			await vi.waitFor(() => expect(lastSend().type).toBe('command_result'));

			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'again',
				inputMode: 'ai',
				tabId: 'tab-7',
				notifyOnComplete: 'caller-1',
			});
			expect(String(lastSend().message)).toContain('CALLBACK_ALREADY_ARMED');
		});

		it('refuses a callback that would wake the dispatch target itself', () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'go',
				inputMode: 'ai',
				tabId: 'tab-7',
				notifyOnComplete: 'session-1',
			});
			expect(String(lastSend().message)).toContain('cannot be the dispatch target itself');
		});

		it('refuses an unknown callback agent', () => {
			vi.mocked(callbacks.getSessionDetail!).mockImplementation((id: string) =>
				id === 'session-1' ? ({ state: 'idle', inputMode: 'ai' } as never) : null
			);
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'go',
				inputMode: 'ai',
				tabId: 'tab-7',
				notifyOnComplete: 'ghost',
			});
			expect(String(lastSend().message)).toContain('Callback agent not found');
		});

		it('arms a callback on enqueue_command for an explicit tab', async () => {
			handler.handleMessage(client, {
				type: 'enqueue_command',
				sessionId: 'session-1',
				command: 'go',
				inputMode: 'ai',
				tabId: 'tab-9',
				notifyOnComplete: 'caller-1',
			});

			await vi.waitFor(() => {
				const response = lastSend();
				expect(response.type).toBe('enqueue_command_result');
				expect(response.callbackId).toBeTruthy();
			});
			expect(getDispatchCallbackRegistry()!.hasArmedFor('session-1', 'tab-9')).toBe(true);
		});

		it('rejects an unknown callback agent BEFORE creating the new tab', async () => {
			vi.mocked(callbacks.getSessionDetail!).mockImplementation((id: string) =>
				id === 'session-1' ? ({ state: 'idle', inputMode: 'ai' } as never) : null
			);
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 'go',
				notifyOnComplete: 'ghost',
			});

			const response = lastSend();
			expect(response.type).toBe('new_ai_tab_with_prompt_result');
			expect(response.success).toBe(false);
			expect(String(response.error)).toContain('Callback agent not found');
			// The whole point: no orphaned tab running a prompt nobody is waiting on.
			expect(callbacks.newAITabWithPrompt).not.toHaveBeenCalled();
		});

		it('rejects a self-targeting new-tab callback before creating the tab', () => {
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 'go',
				notifyOnComplete: 'session-1',
			});

			expect(String(lastSend().error)).toContain('cannot be the dispatch target itself');
			expect(callbacks.newAITabWithPrompt).not.toHaveBeenCalled();
		});

		it('leaves plain dispatches untouched', async () => {
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 'go',
			});
			await vi.waitFor(() => expect(lastSend().type).toBe('new_ai_tab_with_prompt_result'));
			expect(lastSend().callbackId).toBeUndefined();
			expect(getDispatchCallbackRegistry()!.list()).toHaveLength(0);
		});
	});

	describe('Enqueue Command (dispatch --queue)', () => {
		it('marks a queued CLI dispatch as queued', async () => {
			handler.handleMessage(client, {
				type: 'enqueue_command',
				sessionId: 'session-1',
				command: 'Later please',
				inputMode: 'ai',
				fromSessionId: 'caller-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.noteAgentDelegation).toHaveBeenCalledWith({
					kind: 'dispatch',
					fromSessionId: 'caller-1',
					targetSessionId: 'session-1',
					targetTabId: 'tab-mock-123',
					prompt: 'Later please',
					queued: true,
				});
			});
		});

		const lastSend = (): Record<string, unknown> => {
			const calls = vi.mocked(client.socket.send).mock.calls;
			return JSON.parse(String(calls[calls.length - 1][0]));
		};

		it('forwards sessionId/command/tab/background to the callback and replies with queue info', async () => {
			handler.handleMessage(client, {
				type: 'enqueue_command',
				sessionId: 'session-1',
				command: 'Do it',
				inputMode: 'ai',
				tabId: 'tab-1',
				background: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.enqueueCommand).toHaveBeenCalledWith(
					'session-1',
					'Do it',
					'ai',
					'tab-1',
					undefined,
					true,
					false,
					undefined
				);
			});

			await vi.waitFor(() => {
				const response = lastSend();
				expect(response.type).toBe('enqueue_command_result');
				expect(response.success).toBe(true);
				expect(response.queued).toBe(true);
				expect(response.queuePosition).toBe(1);
				expect(response.itemId).toBe('item-1');
				expect(response.tabId).toBe('tab-mock-123');
			});
		});

		it('rejects an enqueue with neither command nor images without calling the callback', () => {
			handler.handleMessage(client, {
				type: 'enqueue_command',
				sessionId: 'session-1',
				inputMode: 'ai',
			});

			const response = lastSend();
			expect(response.type).toBe('enqueue_command_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or command');
			expect(callbacks.enqueueCommand).not.toHaveBeenCalled();
		});

		it('rejects when the session does not exist', () => {
			vi.mocked(callbacks.getSessionDetail).mockReturnValue(null);

			handler.handleMessage(client, {
				type: 'enqueue_command',
				sessionId: 'ghost',
				command: 'hi',
			});

			const response = lastSend();
			expect(response.type).toBe('enqueue_command_result');
			expect(response.success).toBe(false);
			expect(response.error).toBe('Session not found');
			expect(callbacks.enqueueCommand).not.toHaveBeenCalled();
		});

		it('replies with an error result when the callback rejects', async () => {
			vi.mocked(callbacks.enqueueCommand).mockRejectedValue(new Error('boom'));

			handler.handleMessage(client, {
				type: 'enqueue_command',
				sessionId: 'session-1',
				command: 'hi',
			});

			await vi.waitFor(() => {
				const response = lastSend();
				expect(response.type).toBe('enqueue_command_result');
				expect(response.success).toBe(false);
				expect(response.error).toContain('boom');
			});
		});
	});

	describe('List Queue (queue list)', () => {
		const lastSend = (): Record<string, unknown> => {
			const calls = vi.mocked(client.socket.send).mock.calls;
			return JSON.parse(String(calls[calls.length - 1][0]));
		};

		it('forwards an optional sessionId to the callback and replies with the queues', async () => {
			handler.handleMessage(client, {
				type: 'list_queue',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.listQueue).toHaveBeenCalledWith('session-1');
			});
			await vi.waitFor(() => {
				const response = lastSend();
				expect(response.type).toBe('list_queue_result');
				expect(response.success).toBe(true);
				expect(Array.isArray(response.queues)).toBe(true);
			});
		});

		it('passes undefined when no sessionId is provided (all agents)', async () => {
			handler.handleMessage(client, { type: 'list_queue' });

			await vi.waitFor(() => {
				expect(callbacks.listQueue).toHaveBeenCalledWith(undefined);
			});
		});

		it('replies with an error result when the callback rejects', async () => {
			vi.mocked(callbacks.listQueue).mockRejectedValue(new Error('boom'));

			handler.handleMessage(client, { type: 'list_queue' });

			await vi.waitFor(() => {
				const response = lastSend();
				expect(response.type).toBe('list_queue_result');
				expect(response.success).toBe(false);
				expect(response.error).toContain('boom');
			});
		});
	});

	describe('Remove Queue Item (queue remove)', () => {
		const lastSend = (): Record<string, unknown> => {
			const calls = vi.mocked(client.socket.send).mock.calls;
			return JSON.parse(String(calls[calls.length - 1][0]));
		};

		it('forwards sessionId + itemId to the callback and replies removed:true', async () => {
			handler.handleMessage(client, {
				type: 'remove_queue_item',
				sessionId: 'session-1',
				itemId: 'item-9',
			});

			await vi.waitFor(() => {
				expect(callbacks.removeQueueItem).toHaveBeenCalledWith('session-1', 'item-9');
			});
			await vi.waitFor(() => {
				const response = lastSend();
				expect(response.type).toBe('remove_queue_item_result');
				expect(response.success).toBe(true);
				expect(response.removed).toBe(true);
			});
		});

		it('rejects missing sessionId or itemId without calling the callback', () => {
			handler.handleMessage(client, { type: 'remove_queue_item', sessionId: 'session-1' });

			const response = lastSend();
			expect(response.type).toBe('remove_queue_item_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or itemId');
			expect(callbacks.removeQueueItem).not.toHaveBeenCalled();
		});
	});

	describe('Set Queue Item Paused (queue hold / resume)', () => {
		const lastSend = (): Record<string, unknown> => {
			const calls = vi.mocked(client.socket.send).mock.calls;
			return JSON.parse(String(calls[calls.length - 1][0]));
		};

		it('forwards sessionId, itemId, and paused to the callback', async () => {
			handler.handleMessage(client, {
				type: 'set_queue_item_paused',
				sessionId: 'session-1',
				itemId: 'item-9',
				paused: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.setQueueItemPaused).toHaveBeenCalledWith('session-1', 'item-9', true);
			});
			await vi.waitFor(() => {
				const response = lastSend();
				expect(response.type).toBe('set_queue_item_paused_result');
				expect(response).toMatchObject({ success: true, found: true, paused: true });
			});
		});

		it('rejects a missing paused flag without calling the callback', () => {
			handler.handleMessage(client, {
				type: 'set_queue_item_paused',
				sessionId: 'session-1',
				itemId: 'item-9',
			});

			const response = lastSend();
			expect(response.type).toBe('set_queue_item_paused_result');
			expect(response.success).toBe(false);
			expect(callbacks.setQueueItemPaused).not.toHaveBeenCalled();
		});

		it('forwards held:true on enqueue_command (dispatch --held)', async () => {
			handler.handleMessage(client, {
				type: 'enqueue_command',
				sessionId: 'session-1',
				command: 'Later',
				held: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.enqueueCommand).toHaveBeenCalledWith(
					'session-1',
					'Later',
					undefined,
					undefined,
					undefined,
					false,
					true,
					undefined
				);
			});
		});
	});

	describe('Merge Queue Item (queue merge)', () => {
		const lastSend = (): Record<string, unknown> => {
			const calls = vi.mocked(client.socket.send).mock.calls;
			return JSON.parse(String(calls[calls.length - 1][0]));
		};

		it('forwards sessionId and itemId and returns the item it merged into', async () => {
			handler.handleMessage(client, {
				type: 'merge_queue_item',
				sessionId: 'session-1',
				itemId: 'item-9',
			});

			await vi.waitFor(() => {
				expect(callbacks.mergeQueueItem).toHaveBeenCalledWith('session-1', 'item-9');
			});
			await vi.waitFor(() => {
				const response = lastSend();
				expect(response.type).toBe('merge_queue_item_result');
				expect(response).toMatchObject({ success: true, merged: true, mergedIntoId: 'item-8' });
			});
		});

		it('rejects a missing itemId without calling the callback', () => {
			handler.handleMessage(client, { type: 'merge_queue_item', sessionId: 'session-1' });

			const response = lastSend();
			expect(response.type).toBe('merge_queue_item_result');
			expect(response.success).toBe(false);
			expect(callbacks.mergeQueueItem).not.toHaveBeenCalled();
		});
	});

	describe('Steer Queue Item (queue steer)', () => {
		const lastSend = (): Record<string, unknown> => {
			const calls = vi.mocked(client.socket.send).mock.calls;
			return JSON.parse(String(calls[calls.length - 1][0]));
		};

		it('forwards sessionId + itemId to the callback and relays its result', async () => {
			handler.handleMessage(client, {
				type: 'steer_queue_item',
				sessionId: 'session-1',
				itemId: 'item-9',
			});

			await vi.waitFor(() => {
				expect(callbacks.steerQueueItem).toHaveBeenCalledWith('session-1', 'item-9');
			});
			await vi.waitFor(() => {
				const response = lastSend();
				expect(response.type).toBe('steer_queue_item_result');
				expect(response.success).toBe(true);
				expect(response.result).toEqual({ outcome: 'delivered', verdict: 'delivered' });
			});
		});

		it('rejects missing sessionId or itemId without calling the callback', () => {
			handler.handleMessage(client, { type: 'steer_queue_item', sessionId: 'session-1' });

			const response = lastSend();
			expect(response.type).toBe('steer_queue_item_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or itemId');
			expect(callbacks.steerQueueItem).not.toHaveBeenCalled();
		});
	});

	describe('Get Auto Run State (auto-run-status)', () => {
		const lastSend = (): Record<string, unknown> => {
			const calls = vi.mocked(client.socket.send).mock.calls;
			return JSON.parse(String(calls[calls.length - 1][0]));
		};

		it('answers with the live broadcast state, not the session detail', () => {
			// Regression: the handler read `autoRunState` off the session detail, which
			// never carries it, so a running Auto Run always read as not running.
			const live = { isRunning: true, totalTasks: 16, completedTasks: 3 };
			callbacks.getAutoRunState = vi.fn().mockReturnValue(live);
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, { type: 'get_auto_run_state', sessionId: 'session-1' });

			expect(callbacks.getAutoRunState).toHaveBeenCalledWith('session-1');
			expect(lastSend()).toMatchObject({
				type: 'auto_run_state',
				sessionId: 'session-1',
				state: live,
			});
		});

		it('answers null when nothing is running', () => {
			callbacks.getAutoRunState = vi.fn().mockReturnValue(undefined);
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, { type: 'get_auto_run_state', sessionId: 'session-1' });

			expect(lastSend()).toMatchObject({ type: 'auto_run_state', state: null });
		});
	});

	describe('Refresh File Tree (Web → Desktop)', () => {
		it('should forward refresh file tree to desktop', async () => {
			handler.handleMessage(client, {
				type: 'refresh_file_tree',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.refreshFileTree).toHaveBeenCalledWith('session-1');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('refresh_file_tree_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
		});

		it('should reject refresh file tree with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'refresh_file_tree',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId');
			expect(callbacks.refreshFileTree).not.toHaveBeenCalled();
		});

		it('should handle refresh file tree callback failure', async () => {
			(callbacks.refreshFileTree as any).mockRejectedValue(new Error('Tree refresh failed'));

			handler.handleMessage(client, {
				type: 'refresh_file_tree',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('error');
				expect(lastResponse.message).toContain('Tree refresh failed');
			});
		});
	});

	describe('Refresh Auto Run Docs (Web → Desktop)', () => {
		it('forwards background placement on refresh_auto_run_docs', async () => {
			// The renderer switches to the target agent to get it refreshed;
			// background callers get the refresh without the switch.
			handler.handleMessage(client, {
				type: 'refresh_auto_run_docs',
				sessionId: 'session-1',
				background: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.refreshAutoRunDocs).toHaveBeenCalledWith('session-1', true);
			});
		});

		it('should forward refresh auto run docs to desktop', async () => {
			handler.handleMessage(client, {
				type: 'refresh_auto_run_docs',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.refreshAutoRunDocs).toHaveBeenCalledWith('session-1', false);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('refresh_auto_run_docs_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
		});

		it('should reject refresh auto run docs with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'refresh_auto_run_docs',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId');
			expect(callbacks.refreshAutoRunDocs).not.toHaveBeenCalled();
		});

		it('should handle refresh auto run docs callback failure', async () => {
			(callbacks.refreshAutoRunDocs as any).mockRejectedValue(new Error('Auto-run refresh failed'));

			handler.handleMessage(client, {
				type: 'refresh_auto_run_docs',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('error');
				expect(lastResponse.message).toContain('Auto-run refresh failed');
			});
		});
	});

	describe('Configure Auto Run (Web → Desktop)', () => {
		it('should forward configure auto run with valid config', async () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }, { filename: 'doc2.md', resetOnCompletion: true }],
				prompt: 'Custom prompt',
				loopEnabled: true,
				maxLoops: 3,
				launch: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.configureAutoRun).toHaveBeenCalledWith('session-1', {
					documents: [{ filename: 'doc1.md' }, { filename: 'doc2.md', resetOnCompletion: true }],
					prompt: 'Custom prompt',
					loopEnabled: true,
					maxLoops: 3,
					saveAsPlaybook: undefined,
					launch: true,
					worktree: undefined,
				});
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('configure_auto_run_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
		});

		it('should reject configure auto run with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				documents: [{ filename: 'doc1.md' }],
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should reject configure auto run with missing documents', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('documents');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should reject configure auto run with empty documents array', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [],
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('documents');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should forward configure auto run with saveAsPlaybook', async () => {
			(callbacks.configureAutoRun as any).mockResolvedValue({
				success: true,
				playbookId: 'pb-123',
			});

			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				saveAsPlaybook: 'My Playbook',
			});

			await vi.waitFor(() => {
				expect(callbacks.configureAutoRun).toHaveBeenCalledWith('session-1', {
					documents: [{ filename: 'doc1.md' }],
					prompt: undefined,
					loopEnabled: undefined,
					maxLoops: undefined,
					saveAsPlaybook: 'My Playbook',
					launch: undefined,
					worktree: undefined,
				});
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('configure_auto_run_result');
			expect(response.success).toBe(true);
			expect(response.playbookId).toBe('pb-123');
		});

		it('should handle configure auto run callback failure', async () => {
			(callbacks.configureAutoRun as any).mockRejectedValue(
				new Error('Auto-run configuration failed')
			);

			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('error');
				expect(lastResponse.message).toContain('Auto-run configuration failed');
			});
		});

		it('should forward configure auto run with worktree config', async () => {
			(callbacks.configureAutoRun as any).mockResolvedValue({ success: true });

			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				launch: true,
				worktree: {
					enabled: true,
					path: '/tmp/worktree',
					branchName: 'feature/auto-run',
					createPROnCompletion: true,
					prTargetBranch: 'main',
				},
			});

			await vi.waitFor(() => {
				expect(callbacks.configureAutoRun).toHaveBeenCalledWith('session-1', {
					documents: [{ filename: 'doc1.md' }],
					prompt: undefined,
					loopEnabled: undefined,
					maxLoops: undefined,
					saveAsPlaybook: undefined,
					launch: true,
					worktree: {
						enabled: true,
						path: '/tmp/worktree',
						branchName: 'feature/auto-run',
						baseBranch: '',
						createPROnCompletion: true,
						prTargetBranch: 'main',
					},
				});
			});
		});

		it('should reject worktree missing required fields', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				launch: true,
				worktree: { enabled: true, path: '/tmp/wt', branchName: '' },
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('worktree.branchName');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should reject non-object worktree', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				launch: true,
				worktree: 'not-an-object',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('worktree must be an object');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should forward per-run model and effort overrides', async () => {
			(callbacks.configureAutoRun as any).mockResolvedValue({ success: true });

			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				launch: true,
				model: 'opus',
				effort: 'high',
			});

			await vi.waitFor(() => {
				expect(callbacks.configureAutoRun).toHaveBeenCalledWith(
					'session-1',
					expect.objectContaining({ model: 'opus', effort: 'high' })
				);
			});
		});

		it('should leave model and effort undefined when not provided', async () => {
			(callbacks.configureAutoRun as any).mockResolvedValue({ success: true });

			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				launch: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.configureAutoRun).toHaveBeenCalled();
			});
			const config = (callbacks.configureAutoRun as any).mock.calls[0][1];
			expect(config.model).toBeUndefined();
			expect(config.effort).toBeUndefined();
			expect(config.ignoreModelHints).toBeUndefined();
		});

		it('should forward ignoreModelHints when set', async () => {
			(callbacks.configureAutoRun as any).mockResolvedValue({ success: true });

			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				launch: true,
				model: 'opus',
				ignoreModelHints: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.configureAutoRun).toHaveBeenCalledWith(
					'session-1',
					expect.objectContaining({ model: 'opus', ignoreModelHints: true })
				);
			});
		});

		it('should reject a non-boolean ignoreModelHints', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				ignoreModelHints: 'yes',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('ignoreModelHints must be a boolean');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should reject non-string model', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				model: 42,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('model must be a non-empty string');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should reject empty/whitespace model', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				model: '   ',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('model must be a non-empty string');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should reject non-string effort', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				effort: { level: 'high' },
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('effort must be a non-empty string');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should reject empty effort', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				effort: '',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('effort must be a non-empty string');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should handle missing configureAutoRun callback', () => {
			const handlerNoCallbacks = new WebSocketMessageHandler();
			handlerNoCallbacks.setCallbacks({
				getSessionDetail: vi.fn(),
			});

			handlerNoCallbacks.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});
	});

	describe('Run-in-Worktree git APIs (Web → Desktop)', () => {
		it('should reject get_git_branches without sessionId', () => {
			handler.handleMessage(client, { type: 'get_git_branches' });
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId');
		});

		it('should forward get_git_branches and emit branches list', async () => {
			handler.handleMessage(client, {
				type: 'get_git_branches',
				sessionId: 'session-1',
				requestId: 'req-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.getGitBranchesForSession).toHaveBeenCalledWith('session-1');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('git_branches');
			expect(response.branches).toEqual(['main', 'feature/x']);
			expect(response.currentBranch).toBe('main');
			expect(response.requestId).toBe('req-1');
		});

		it('should reject list_worktrees without sessionId', () => {
			handler.handleMessage(client, { type: 'list_worktrees' });
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId');
		});

		it('should forward list_worktrees and emit worktrees list', async () => {
			(callbacks.listWorktreesForSession as any).mockResolvedValueOnce({
				worktrees: [{ path: '/repo/wt-1', branch: 'feat/x', isBare: false }],
			});

			handler.handleMessage(client, {
				type: 'list_worktrees',
				sessionId: 'session-1',
				requestId: 'req-2',
			});

			await vi.waitFor(() => {
				expect(callbacks.listWorktreesForSession).toHaveBeenCalledWith('session-1');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('worktrees_list');
			expect(response.worktrees).toEqual([{ path: '/repo/wt-1', branch: 'feat/x', isBare: false }]);
			expect(response.requestId).toBe('req-2');
		});

		it('should error when get_git_branches callback is not configured', () => {
			const handlerNoCb = new WebSocketMessageHandler();
			handlerNoCb.setCallbacks({});
			handlerNoCb.handleMessage(client, {
				type: 'get_git_branches',
				sessionId: 'session-1',
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});

		it('should error when list_worktrees callback is not configured', () => {
			const handlerNoCb = new WebSocketMessageHandler();
			handlerNoCb.setCallbacks({});
			handlerNoCb.handleMessage(client, {
				type: 'list_worktrees',
				sessionId: 'session-1',
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});
	});

	describe('Select Session with Focus (Web → Desktop)', () => {
		it('should forward session selection with focus flag', async () => {
			handler.handleMessage(client, {
				type: 'select_session',
				sessionId: 'session-2',
				focus: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.selectSession).toHaveBeenCalledWith('session-2', undefined, true);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('select_session_result');
			expect(response.success).toBe(true);
		});

		it('should forward session selection with focus and tabId', async () => {
			handler.handleMessage(client, {
				type: 'select_session',
				sessionId: 'session-2',
				tabId: 'tab-3',
				focus: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.selectSession).toHaveBeenCalledWith('session-2', 'tab-3', true);
			});
		});

		it('should forward session selection without focus flag', async () => {
			handler.handleMessage(client, {
				type: 'select_session',
				sessionId: 'session-2',
			});

			await vi.waitFor(() => {
				expect(callbacks.selectSession).toHaveBeenCalledWith('session-2', undefined, undefined);
			});
		});
	});

	describe('Movement ID validation', () => {
		it.each(['begin', 'add', 'update', 'move', 'remove', 'progress'] as const)(
			'rejects surrounding whitespace for movement %s',
			(op) => {
				callbacks.movementView = vi.fn().mockResolvedValue(true);
				handler.handleMessage(client, {
					type: 'movement',
					op,
					id: ' item-1 ',
					body: op === 'add' ? '{}' : undefined,
					x: op === 'move' ? 10 : undefined,
					y: op === 'move' ? 20 : undefined,
					title: op === 'progress' ? 'Item 1' : undefined,
					phase: op === 'progress' ? 'composing' : undefined,
				});

				expect(callbacks.movementView).not.toHaveBeenCalled();
				const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
				expect(response).toMatchObject({
					type: 'movement_result',
					success: false,
					error: 'Movement item id must not contain surrounding whitespace',
				});
			}
		);

		it('rejects surrounding whitespace before designer inspection', () => {
			callbacks.getMovementDesignerInspection = vi.fn();
			handler.handleMessage(client, {
				type: 'get_movement_designer_inspection',
				id: ' item-1 ',
			});

			expect(callbacks.getMovementDesignerInspection).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'movement_designer_inspection_result',
				success: false,
				error: 'Movement item id must not contain surrounding whitespace',
			});
		});

		it('rejects surrounding whitespace before designer interaction', () => {
			callbacks.interactMovementDesigner = vi.fn();
			handler.handleMessage(client, {
				type: 'interact_movement_designer',
				id: ' item-1 ',
				action: { kind: 'click', selector: '#save' },
			});

			expect(callbacks.interactMovementDesigner).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'movement_designer_interaction_result',
				success: false,
				error: 'Movement item id must not contain surrounding whitespace',
			});
		});
	});

	describe('Movement progress validation', () => {
		it('forwards a valid Concerto phase without HTML content', async () => {
			callbacks.movementView = vi.fn().mockResolvedValue(true);
			handler.setCallbacks({ movementView: callbacks.movementView });
			handler.handleMessage(client, {
				type: 'movement',
				op: 'progress',
				id: 'checkout',
				title: 'Checkout flow',
				phase: 'reviewing',
				step: 2,
				steps: 3,
				notes: [
					{ value: 'eighth' },
					{ value: 'eighth', dotted: true },
					{ value: 'quarter', triad: true },
				],
			});

			await vi.waitFor(() => {
				expect(callbacks.movementView).toHaveBeenCalledWith({
					op: 'progress',
					id: 'checkout',
					title: 'Checkout flow',
					phase: 'reviewing',
					step: 2,
					steps: 3,
					notes: [
						{ value: 'eighth' },
						{ value: 'eighth', dotted: true },
						{ value: 'quarter', triad: true },
					],
					viewType: undefined,
					x: undefined,
					y: undefined,
					width: undefined,
					height: undefined,
					body: undefined,
				});
			});
		});

		it.each([
			{ phase: 'sketching', title: 'Checkout flow' },
			{ phase: 'composing', title: '   ' },
			{ phase: 'refining', title: 'Checkout flow', step: 0, steps: 4 },
			{ phase: 'refining', title: 'Checkout flow', step: 5, steps: 4 },
			{ phase: 'refining', title: 'Checkout flow', step: 1, steps: 9 },
			{
				phase: 'refining',
				title: 'Checkout flow',
				step: 1,
				steps: 2,
				notes: [{ value: 'eighth' }, { value: 'eighth', tie: true }],
			},
		])('rejects invalid progress metadata: $phase / $title', (progress) => {
			callbacks.movementView = vi.fn().mockResolvedValue(true);
			handler.handleMessage(client, {
				type: 'movement',
				op: 'progress',
				id: 'checkout',
				...progress,
			});

			expect(callbacks.movementView).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({ type: 'movement_result', success: false });
		});
	});

	describe('Movement HTML validation', () => {
		it('forwards a host-rendered begin shell without HTML content', async () => {
			callbacks.movementView = vi.fn().mockResolvedValue(true);
			handler.setCallbacks({ movementView: callbacks.movementView });
			handler.handleMessage(client, {
				type: 'movement',
				op: 'begin',
				id: 'mockup',
				title: 'Checkout mockup',
				x: 24,
				y: 32,
			});

			await vi.waitFor(() => {
				expect(callbacks.movementView).toHaveBeenCalledWith({
					op: 'begin',
					id: 'mockup',
					title: 'Checkout mockup',
					viewType: 'html',
					x: 24,
					y: 32,
					width: undefined,
					height: undefined,
					body: undefined,
					phase: undefined,
					step: undefined,
					steps: undefined,
					notes: undefined,
				});
			});
		});

		it('requires a title for a begin shell', () => {
			callbacks.movementView = vi.fn().mockResolvedValue(true);
			handler.handleMessage(client, {
				type: 'movement',
				op: 'begin',
				id: 'mockup',
			});

			expect(callbacks.movementView).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'movement_result',
				success: false,
				error: 'Movement begin requires a non-empty title',
			});
		});

		it.each(['add', 'update'] as const)(
			'requires HTML content for a movement %s that explicitly selects html',
			(op) => {
				callbacks.movementView = vi.fn().mockResolvedValue(true);
				handler.handleMessage(client, {
					type: 'movement',
					op,
					id: 'mockup',
					viewType: 'html',
				});

				expect(callbacks.movementView).not.toHaveBeenCalled();
				const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
				expect(response).toMatchObject({
					type: 'movement_result',
					success: false,
					error: `Movement ${op} requires HTML content when viewType is 'html'`,
				});
			}
		);
	});

	describe('Cue Pipeline Mutations (Web/CLI → Desktop)', () => {
		it('cue_pipeline_list returns the daemon-supplied list verbatim', async () => {
			const pipelines = [
				{ id: 'pipeline-Foo', name: 'Foo', color: '#06b6d4', nodes: [], edges: [] },
			];
			(callbacks.listCuePipelines as ReturnType<typeof vi.fn>).mockResolvedValue({ pipelines });

			handler.handleMessage(client, { type: 'cue_pipeline_list', requestId: 'req-1' });

			await vi.waitFor(() => {
				expect(callbacks.listCuePipelines).toHaveBeenCalledTimes(1);
			});
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response.type).toBe('cue_pipeline_list_result');
			expect(response.pipelines).toEqual(pipelines);
			expect(response.requestId).toBe('req-1');
		});

		it('cue_pipeline_get rejects empty identifier', () => {
			handler.handleMessage(client, { type: 'cue_pipeline_get' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing identifier');
		});

		it('cue_pipeline_get returns the daemon-supplied pipeline (or null)', async () => {
			const pipeline = { id: 'pipeline-Foo', name: 'Foo', color: '#06b6d4', nodes: [], edges: [] };
			(callbacks.getCuePipeline as ReturnType<typeof vi.fn>).mockResolvedValue(pipeline);

			handler.handleMessage(client, { type: 'cue_pipeline_get', identifier: 'Foo' });

			await vi.waitFor(() => {
				expect(callbacks.getCuePipeline).toHaveBeenCalledWith('Foo');
			});
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response.type).toBe('cue_pipeline_get_result');
			expect(response.pipeline).toEqual(pipeline);
		});

		it('cue_pipeline_set forwards identifier, payload, and policy', async () => {
			const payload = { id: 'pipeline-Foo', name: 'Foo', color: '#06b6d4', nodes: [], edges: [] };
			handler.handleMessage(client, {
				type: 'cue_pipeline_set',
				identifier: 'Foo',
				pipeline: payload,
				policy: 'add',
			});

			await vi.waitFor(() => {
				expect(callbacks.setCuePipeline).toHaveBeenCalledWith('Foo', payload, 'add');
			});
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response.type).toBe('cue_pipeline_set_result');
			expect(response.result).toEqual({ ok: true });
		});

		it('cue_pipeline_set rejects invalid policy', () => {
			handler.handleMessage(client, {
				type: 'cue_pipeline_set',
				identifier: 'Foo',
				pipeline: {},
				policy: 'destroy',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Invalid policy');
		});

		it('cue_pipeline_set rejects missing payload', () => {
			handler.handleMessage(client, {
				type: 'cue_pipeline_set',
				identifier: 'Foo',
				policy: 'add',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing pipeline payload');
		});

		it('cue_pipeline_set surfaces structured failure results unchanged', async () => {
			(callbacks.setCuePipeline as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: false,
				code: 'already_exists',
				message: 'pipeline "Foo" already exists',
			});
			handler.handleMessage(client, {
				type: 'cue_pipeline_set',
				identifier: 'Foo',
				pipeline: { id: 'pipeline-Foo', name: 'Foo', color: '#06b6d4', nodes: [], edges: [] },
				policy: 'add',
			});

			await vi.waitFor(() => {
				expect(callbacks.setCuePipeline).toHaveBeenCalled();
			});
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response.type).toBe('cue_pipeline_set_result');
			expect(response.result.ok).toBe(false);
			expect(response.result.code).toBe('already_exists');
		});

		it('cue_pipeline_remove forwards identifier and surfaces result', async () => {
			handler.handleMessage(client, {
				type: 'cue_pipeline_remove',
				identifier: 'Foo',
			});

			await vi.waitFor(() => {
				expect(callbacks.removeCuePipeline).toHaveBeenCalledWith('Foo');
			});
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response.type).toBe('cue_pipeline_remove_result');
			expect(response.result).toEqual({ ok: true });
		});
	});

	describe('Unknown Message Types', () => {
		it('should echo unknown message types for debugging', () => {
			handler.handleMessage(client, {
				type: 'unknown_type',
				someData: 'test',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('echo');
			expect(response.originalType).toBe('unknown_type');
		});
	});

	describe('Callback Not Configured', () => {
		it('should handle missing executeCommand callback', () => {
			const handlerNoCallbacks = new WebSocketMessageHandler();
			handlerNoCallbacks.setCallbacks({
				getSessionDetail: vi.fn().mockReturnValue({ state: 'idle', inputMode: 'ai' }),
			});

			handlerNoCallbacks.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'test',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});

		it('should handle missing switchMode callback', () => {
			const handlerNoCallbacks = new WebSocketMessageHandler();

			handlerNoCallbacks.handleMessage(client, {
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'terminal',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});

		it('should handle missing selectSession callback', () => {
			const handlerNoCallbacks = new WebSocketMessageHandler();

			handlerNoCallbacks.handleMessage(client, {
				type: 'select_session',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});

		it('should handle missing selectTab callback', () => {
			const handlerNoCallbacks = new WebSocketMessageHandler();

			handlerNoCallbacks.handleMessage(client, {
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});
	});

	describe('File Tree Path Traversal Protection', () => {
		it('should reject get_file_tree when session has no cwd', () => {
			callbacks.getSessionDetail = vi.fn().mockReturnValue(null);
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, {
				type: 'get_file_tree',
				sessionId: 'session-1',
				path: '/etc/passwd',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Cannot resolve session working directory');
		});

		it('should reject get_file_tree when sessionId is empty', () => {
			callbacks.getSessionDetail = vi.fn().mockReturnValue(null);
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, {
				type: 'get_file_tree',
				sessionId: '',
				path: '/',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Cannot resolve session working directory');
		});

		it('should reject get_file_tree for path outside session cwd', () => {
			callbacks.getSessionDetail = vi.fn().mockReturnValue({
				state: 'idle',
				inputMode: 'ai',
				cwd: '/home/user/project',
			});
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, {
				type: 'get_file_tree',
				sessionId: 'session-1',
				path: '/etc',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('outside the session working directory');
		});
	});

	describe('Terminal Session Ownership', () => {
		it('should reject terminal_write when client is not subscribed to session', () => {
			client.subscribedSessionId = 'other-session';

			handler.handleMessage(client, {
				type: 'terminal_write',
				sessionId: 'session-1',
				data: 'ls\r',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('terminal_write_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Not subscribed');
		});

		it('should reject terminal_resize when client is not subscribed to session', () => {
			client.subscribedSessionId = 'other-session';

			handler.handleMessage(client, {
				type: 'terminal_resize',
				sessionId: 'session-1',
				cols: 80,
				rows: 24,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('terminal_resize_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Not subscribed');
		});

		it('should allow terminal_write when client is subscribed to the session', () => {
			client.subscribedSessionId = 'session-1';

			handler.handleMessage(client, {
				type: 'terminal_write',
				sessionId: 'session-1',
				data: 'ls\r',
			});

			expect(callbacks.writeToTerminal).toHaveBeenCalledWith('session-1', 'ls\r');
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('terminal_write_result');
			expect(response.success).toBe(true);
		});

		it('should allow terminal_resize when client is subscribed to the session', () => {
			client.subscribedSessionId = 'session-1';

			handler.handleMessage(client, {
				type: 'terminal_resize',
				sessionId: 'session-1',
				cols: 120,
				rows: 40,
			});

			expect(callbacks.resizeTerminal).toHaveBeenCalledWith('session-1', 120, 40);
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('terminal_resize_result');
			expect(response.success).toBe(true);
		});
	});

	describe('Trigger Cue Subscription (sourceAgentId)', () => {
		it('should pass sourceAgentId through to triggerCueSubscription callback', async () => {
			handler.handleMessage(client, {
				type: 'trigger_cue_subscription',
				subscriptionName: 'my-sub',
				sourceAgentId: 'agent-xyz-123',
			});

			await vi.waitFor(() => {
				expect(callbacks.triggerCueSubscription).toHaveBeenCalledWith(
					'my-sub',
					undefined,
					'agent-xyz-123'
				);
			});
		});

		it('should pass prompt and sourceAgentId together', async () => {
			handler.handleMessage(client, {
				type: 'trigger_cue_subscription',
				subscriptionName: 'my-sub',
				prompt: 'custom prompt',
				sourceAgentId: 'agent-abc',
			});

			await vi.waitFor(() => {
				expect(callbacks.triggerCueSubscription).toHaveBeenCalledWith(
					'my-sub',
					'custom prompt',
					'agent-abc'
				);
			});
		});

		it('should pass undefined sourceAgentId when not provided', async () => {
			handler.handleMessage(client, {
				type: 'trigger_cue_subscription',
				subscriptionName: 'my-sub',
			});

			await vi.waitFor(() => {
				expect(callbacks.triggerCueSubscription).toHaveBeenCalledWith(
					'my-sub',
					undefined,
					undefined
				);
			});
		});

		it('should return trigger_cue_subscription_result on success', async () => {
			handler.handleMessage(client, {
				type: 'trigger_cue_subscription',
				subscriptionName: 'my-sub',
				sourceAgentId: 'agent-xyz',
			});

			await vi.waitFor(() => {
				expect(client.socket.send).toHaveBeenCalled();
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('trigger_cue_subscription_result');
			expect(response.success).toBe(true);
			expect(response.subscriptionName).toBe('my-sub');
		});

		it('should reject missing subscriptionName', () => {
			handler.handleMessage(client, {
				type: 'trigger_cue_subscription',
				sourceAgentId: 'agent-xyz',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.triggerCueSubscription).not.toHaveBeenCalled();
		});
	});

	// ============================================================
	// Auto Run parity - reset tasks + playbook CRUD validation
	// These tests pin the path-safety rules called out in the PR
	// review: neither the web client nor a compromised dev tool may
	// escape the Auto Run root via absolute / traversal filenames.
	// ============================================================
	describe('reset_auto_run_doc_tasks path validation', () => {
		it('forwards relative subfolder paths to the callback', async () => {
			handler.handleMessage(client, {
				type: 'reset_auto_run_doc_tasks',
				sessionId: 'session-1',
				filename: 'loop/step-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.resetAutoRunDocTasks).toHaveBeenCalledWith('session-1', 'loop/step-1');
			});
		});

		it('rejects POSIX-absolute filenames', () => {
			handler.handleMessage(client, {
				type: 'reset_auto_run_doc_tasks',
				sessionId: 'session-1',
				filename: '/etc/passwd',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toMatch(/Invalid filename/);
			expect(callbacks.resetAutoRunDocTasks).not.toHaveBeenCalled();
		});

		it('rejects Windows drive-letter absolute filenames', () => {
			handler.handleMessage(client, {
				type: 'reset_auto_run_doc_tasks',
				sessionId: 'session-1',
				filename: 'C:/tmp/doc.md',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.resetAutoRunDocTasks).not.toHaveBeenCalled();
		});

		it('rejects traversal sequences', () => {
			handler.handleMessage(client, {
				type: 'reset_auto_run_doc_tasks',
				sessionId: 'session-1',
				filename: '../secrets.md',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.resetAutoRunDocTasks).not.toHaveBeenCalled();
		});
	});

	describe('playbook document validation', () => {
		const validPayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
			type: 'create_playbook' as const,
			sessionId: 'session-1',
			playbook: {
				name: 'p',
				documents: [{ filename: 'a' }],
				loopEnabled: false,
				prompt: '',
				...overrides,
			},
		});

		it('accepts relative subfolder filenames', async () => {
			handler.handleMessage(client, {
				...validPayload({ documents: [{ filename: 'loop/step-1', resetOnCompletion: true }] }),
			});

			await vi.waitFor(() => {
				expect(callbacks.createPlaybook).toHaveBeenCalled();
			});
			const [, playbook] = (callbacks.createPlaybook as any).mock.calls[0];
			expect(playbook.documents).toEqual([{ filename: 'loop/step-1', resetOnCompletion: true }]);
		});

		it('rejects absolute POSIX filenames', () => {
			handler.handleMessage(client, {
				...validPayload({ documents: [{ filename: '/etc/passwd' }] }),
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toMatch(/Invalid playbook documents/);
			expect(callbacks.createPlaybook).not.toHaveBeenCalled();
		});

		it('rejects Windows drive-letter absolute filenames', () => {
			handler.handleMessage(client, {
				...validPayload({ documents: [{ filename: 'C:\\tmp\\doc.md' }] }),
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.createPlaybook).not.toHaveBeenCalled();
		});

		it('rejects backslash separators', () => {
			handler.handleMessage(client, {
				...validPayload({ documents: [{ filename: 'loop\\step-1' }] }),
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.createPlaybook).not.toHaveBeenCalled();
		});

		it('rejects `..` traversal segments', () => {
			handler.handleMessage(client, {
				...validPayload({ documents: [{ filename: '../secrets' }] }),
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.createPlaybook).not.toHaveBeenCalled();
		});

		it('rejects non-boolean resetOnCompletion rather than coercing it', () => {
			// Review feedback - a truthy non-boolean value was being silently
			// flipped to true. The validator now refuses anything that isn't
			// strictly a boolean.
			handler.handleMessage(client, {
				...validPayload({
					documents: [{ filename: 'a', resetOnCompletion: 'yes' as unknown as boolean }],
				}),
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.createPlaybook).not.toHaveBeenCalled();
		});

		it('defaults resetOnCompletion to false when omitted', async () => {
			handler.handleMessage(client, {
				...validPayload({ documents: [{ filename: 'a' }] }),
			});
			await vi.waitFor(() => {
				expect(callbacks.createPlaybook).toHaveBeenCalled();
			});
			const [, playbook] = (callbacks.createPlaybook as any).mock.calls[0];
			expect(playbook.documents[0].resetOnCompletion).toBe(false);
		});
	});

	describe('Create Gist', () => {
		it('replies with create_gist_result on success', async () => {
			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
				description: 'My gist',
				isPublic: false,
			});

			await vi.waitFor(() => {
				expect(callbacks.createGist).toHaveBeenCalledWith(
					'session-1',
					'My gist',
					false,
					undefined,
					false
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('create_gist_result');
			expect(response.success).toBe(true);
			expect(response.gistUrl).toBe('https://gist.example');
		});

		it('defaults description to "" and isPublic to false when omitted', async () => {
			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.createGist).toHaveBeenCalledWith('session-1', '', false, undefined, false);
			});
		});

		it('replies with create_gist_result (not error) when sessionId is missing', () => {
			handler.handleMessage(client, { type: 'create_gist' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('create_gist_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('sessionId');
			expect(callbacks.createGist).not.toHaveBeenCalled();
		});

		it('rejects non-boolean isPublic to prevent private→public leaks', () => {
			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
				isPublic: 'false',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('create_gist_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('isPublic');
			expect(callbacks.createGist).not.toHaveBeenCalled();
		});

		it('surfaces rejected callback errors as create_gist_result', async () => {
			(callbacks.createGist as any).mockRejectedValue(new Error('boom'));

			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				expect(client.socket.send).toHaveBeenCalled();
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('create_gist_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('boom');
		});

		it('forwards agentSessionId so a headless session can be published', async () => {
			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
				agentSessionId: 'provider-session-9',
			});

			await vi.waitFor(() => {
				expect(callbacks.createGist).toHaveBeenCalledWith(
					'session-1',
					'',
					false,
					'provider-session-9',
					false
				);
			});
		});

		// The secret screen refuses in the main process; the bridge must hand the
		// masked findings back to the CLI rather than flattening them to an error.
		it('returns a secret-screen refusal with its masked findings', async () => {
			const refusal = {
				success: false,
				error: 'Found 1 possible secret in the gist. Nothing was sent.',
				code: 'SECRETS_FOUND',
				secretFindings: [{ kind: 'github-token', line: 4, preview: '••••••••abcd' }],
			};
			(callbacks.createGist as any).mockResolvedValue(refusal);

			handler.handleMessage(client, { type: 'create_gist', sessionId: 'session-1' });

			await vi.waitFor(() => {
				expect(client.socket.send).toHaveBeenCalled();
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response).toMatchObject({ type: 'create_gist_result', ...refusal });
		});

		it('forwards allowSecrets only when it is a literal true', async () => {
			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
				allowSecrets: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.createGist).toHaveBeenCalledWith('session-1', '', false, undefined, true);
			});
		});

		it('rejects a non-boolean allowSecrets instead of reading it as consent', () => {
			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
				allowSecrets: 'true',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('create_gist_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('allowSecrets');
			expect(callbacks.createGist).not.toHaveBeenCalled();
		});

		it('rejects a blank agentSessionId instead of publishing the open tabs', () => {
			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
				agentSessionId: '',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('create_gist_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('agentSessionId');
			expect(callbacks.createGist).not.toHaveBeenCalled();
		});

		it('rejects a non-string agentSessionId', () => {
			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
				agentSessionId: 42,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('create_gist_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('agentSessionId');
			expect(callbacks.createGist).not.toHaveBeenCalled();
		});

		it('replies with create_gist_result when createGist callback is unconfigured', () => {
			callbacks.createGist = undefined;
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('create_gist_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('not configured');
		});
	});

	describe('Marketplace (Playbook Exchange)', () => {
		it('returns the manifest payload on marketplace_get_manifest', async () => {
			handler.handleMessage(client, {
				type: 'marketplace_get_manifest',
				requestId: 'req-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.getMarketplaceManifest).toHaveBeenCalledWith({ refresh: false });
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_get_manifest_result');
			expect(response.success).toBe(true);
			expect(response.manifest).toBeDefined();
			expect(response.requestId).toBe('req-1');
		});

		it('forwards refresh:true when requested', async () => {
			handler.handleMessage(client, {
				type: 'marketplace_get_manifest',
				refresh: true,
				requestId: 'req-2',
			});

			await vi.waitFor(() => {
				expect(callbacks.getMarketplaceManifest).toHaveBeenCalledWith({ refresh: true });
			});
		});

		it('rejects marketplace_get_document with traversal in filename via typed result', () => {
			handler.handleMessage(client, {
				type: 'marketplace_get_document',
				playbookPath: 'category/sample',
				filename: '../../etc/passwd',
				requestId: 'req-3',
			});

			expect(callbacks.getMarketplaceDocument).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			// Validation failures use the request-scoped result type so a CLI
			// waiting on `marketplace_get_document_result` doesn't time out
			// (coderabbit feedback).
			expect(response.type).toBe('marketplace_get_document_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid filename');
			expect(response.requestId).toBe('req-3');
		});

		// Coderabbit feedback: defensive validation must reject any traversal
		// segment / backslash in playbookPath at the entry point, not just
		// absolute / tilde / Windows-drive prefixes - downstream resolvers
		// have other guards but shouldn't be relied on in isolation.
		it.each([
			['../../etc/passwd', 'parent traversal'],
			['./foo', 'leading dot segment'],
			['foo/./bar', 'embedded dot segment'],
			['foo/../bar', 'embedded parent traversal'],
			['foo\\bar', 'embedded backslash'],
		])('rejects marketplace_get_document playbookPath with %s (%s)', (playbookPath) => {
			handler.handleMessage(client, {
				type: 'marketplace_get_document',
				playbookPath,
				filename: 'README',
				requestId: 'req-traversal',
			});

			expect(callbacks.getMarketplaceDocument).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_get_document_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Local filesystem paths are not allowed');
		});

		it('rejects marketplace_get_document for absolute playbookPath via typed result', () => {
			handler.handleMessage(client, {
				type: 'marketplace_get_document',
				playbookPath: '/etc/passwd',
				filename: 'README',
				requestId: 'req-3b',
			});

			expect(callbacks.getMarketplaceDocument).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_get_document_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Local filesystem paths are not allowed');
		});

		it('returns document content on marketplace_get_document', async () => {
			handler.handleMessage(client, {
				type: 'marketplace_get_document',
				playbookPath: 'category/sample',
				filename: 'STEP_1',
				requestId: 'req-4',
			});

			await vi.waitFor(() => {
				expect(callbacks.getMarketplaceDocument).toHaveBeenCalledWith('category/sample', 'STEP_1');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_get_document_result');
			expect(response.success).toBe(true);
			expect(response.content).toBe('# doc');
		});

		it('returns README content on marketplace_get_readme', async () => {
			handler.handleMessage(client, {
				type: 'marketplace_get_readme',
				playbookPath: 'category/sample',
				requestId: 'req-5',
			});

			await vi.waitFor(() => {
				expect(callbacks.getMarketplaceReadme).toHaveBeenCalledWith('category/sample');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_get_readme_result');
			expect(response.success).toBe(true);
			expect(response.content).toBe('# readme');
		});

		it('imports a playbook on marketplace_import_playbook', async () => {
			handler.handleMessage(client, {
				type: 'marketplace_import_playbook',
				sessionId: 'session-1',
				playbookId: 'pb-1',
				targetFolderName: 'my-folder',
				requestId: 'req-6',
			});

			await vi.waitFor(() => {
				expect(callbacks.importMarketplacePlaybook).toHaveBeenCalledWith(
					'session-1',
					'pb-1',
					'my-folder'
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_import_playbook_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
		});

		it('rejects marketplace_import_playbook missing required fields via typed result', () => {
			handler.handleMessage(client, {
				type: 'marketplace_import_playbook',
				sessionId: 'session-1',
				playbookId: 'pb-1',
				requestId: 'req-7',
			});

			expect(callbacks.importMarketplacePlaybook).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_import_playbook_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('targetFolderName');
		});

		it('rejects marketplace_import_playbook with separators in targetFolderName', () => {
			handler.handleMessage(client, {
				type: 'marketplace_import_playbook',
				sessionId: 'session-1',
				playbookId: 'pb-1',
				targetFolderName: '../escape',
				requestId: 'req-7b',
			});

			expect(callbacks.importMarketplacePlaybook).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_import_playbook_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('separators');
		});

		it('replies with marketplace_get_manifest_result when callback unconfigured', () => {
			callbacks.getMarketplaceManifest = undefined;
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, {
				type: 'marketplace_get_manifest',
				requestId: 'req-8',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_get_manifest_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('not configured');
		});
	});

	// PR2 of the CLI surface refactor: read-only session inspection used by
	// `maestro-cli session list` and `session show <tabId>`. The handlers here
	// are deliberately stateless so external pollers (Maestro-Discord, Cue
	// follow-ups) can call them at arbitrary cadence.
	describe('List Desktop Sessions (CLI → Desktop)', () => {
		it('returns the desktop_sessions_list payload from the callback', () => {
			(callbacks.listDesktopSessions as any).mockReturnValue([
				{
					tabId: 'tab-1',
					sessionId: 'tab-1',
					agentId: 'agent-a',
					agentName: 'Backend',
					toolType: 'claude-code',
					name: 'Refactor parser',
					agentSessionId: 'claude-uuid-1',
					state: 'idle',
					createdAt: 1714268000000,
					starred: false,
				},
			]);

			handler.handleMessage(client, { type: 'list_desktop_sessions', requestId: 'req-1' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('desktop_sessions_list');
			expect(response.success).toBe(true);
			expect(response.sessions).toHaveLength(1);
			expect(response.sessions[0].tabId).toBe('tab-1');
			expect(response.requestId).toBe('req-1');
		});

		it('returns an empty list when the callback is unconfigured rather than echoing', () => {
			// Unknown-type echo would confuse the CLI's request/response pairing
			// (`MaestroClient` matches by responseType). Returning the empty
			// success shape keeps the wire contract intact even when the desktop
			// hasn't wired up the callback yet - older builds on a newer CLI.
			callbacks.listDesktopSessions = undefined;
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, { type: 'list_desktop_sessions', requestId: 'req-1' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('desktop_sessions_list');
			expect(response.success).toBe(true);
			expect(response.sessions).toEqual([]);
		});
	});

	describe('Get Session History (CLI → Desktop)', () => {
		const mockHistory = {
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: 'claude-uuid-1',
			messages: [
				{
					id: 'log-1',
					role: 'user' as const,
					source: 'user',
					content: 'Hello',
					timestamp: '2026-04-28T10:00:00.000Z',
				},
			],
		};

		it('forwards tabId / sinceMs / tail to the callback and returns the result', () => {
			(callbacks.getSessionHistory as any).mockReturnValue(mockHistory);

			handler.handleMessage(client, {
				type: 'get_session_history',
				tabId: 'tab-1',
				sinceMs: 1714268000000,
				tail: 5,
				requestId: 'req-2',
			});

			expect(callbacks.getSessionHistory).toHaveBeenCalledWith('tab-1', {
				sinceMs: 1714268000000,
				tail: 5,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('session_history_result');
			expect(response.success).toBe(true);
			expect(response.tabId).toBe('tab-1');
			expect(response.messages).toHaveLength(1);
			expect(response.requestId).toBe('req-2');
		});

		it('emits MISSING_TAB_ID when tabId is omitted', () => {
			handler.handleMessage(client, {
				type: 'get_session_history',
				requestId: 'req-2',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('session_history_result');
			expect(response.success).toBe(false);
			expect(response.code).toBe('MISSING_TAB_ID');
			expect(callbacks.getSessionHistory).not.toHaveBeenCalled();
		});

		it('emits TAB_NOT_FOUND when the desktop has no matching tab', () => {
			(callbacks.getSessionHistory as any).mockReturnValue(null);

			handler.handleMessage(client, {
				type: 'get_session_history',
				tabId: 'tab-bogus',
				requestId: 'req-3',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('session_history_result');
			expect(response.success).toBe(false);
			expect(response.code).toBe('TAB_NOT_FOUND');
		});

		it('coerces a negative tail to undefined rather than passing it through', () => {
			// Negative tail would silently invert `slice(-N)` semantics on the
			// desktop side ("everything except the last N" instead of "last N").
			// Drop it at the boundary so a buggy caller can never poison the
			// desktop's read.
			(callbacks.getSessionHistory as any).mockReturnValue(mockHistory);

			handler.handleMessage(client, {
				type: 'get_session_history',
				tabId: 'tab-1',
				tail: -3,
			});

			expect(callbacks.getSessionHistory).toHaveBeenCalledWith('tab-1', {
				sinceMs: undefined,
				tail: undefined,
			});
		});
	});

	describe('Update Session Cwd (Web → Desktop)', () => {
		it('forwards the new cwd to the callback and echoes it in the result', async () => {
			(callbacks.updateSessionCwd as any).mockResolvedValue({ success: true });

			handler.handleMessage(client, {
				type: 'update_session_cwd',
				sessionId: 'session-1',
				newCwd: '/Users/me/cases/archive/2024-Q4/case-123',
				requestId: 'req-1',
			});

			await new Promise((resolve) => setImmediate(resolve));

			expect(callbacks.updateSessionCwd).toHaveBeenCalledWith(
				'session-1',
				'/Users/me/cases/archive/2024-Q4/case-123'
			);
			expect(client.socket.send).toHaveBeenCalledWith(
				expect.stringContaining('"type":"update_session_cwd_result"')
			);
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload).toMatchObject({
				type: 'update_session_cwd_result',
				success: true,
				sessionId: 'session-1',
				newCwd: '/Users/me/cases/archive/2024-Q4/case-123',
				requestId: 'req-1',
			});
		});

		it('surfaces the renderer-supplied error when the update is refused', async () => {
			(callbacks.updateSessionCwd as any).mockResolvedValue({
				success: false,
				error: 'Agent process is running; stop it before changing cwd',
			});

			handler.handleMessage(client, {
				type: 'update_session_cwd',
				sessionId: 'session-1',
				newCwd: '/tmp/elsewhere',
			});

			await new Promise((resolve) => setImmediate(resolve));

			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload).toMatchObject({
				type: 'update_session_cwd_result',
				success: false,
				error: 'Agent process is running; stop it before changing cwd',
			});
		});

		it('rejects update with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'update_session_cwd',
				newCwd: '/tmp/foo',
			});

			expect(callbacks.updateSessionCwd).not.toHaveBeenCalled();
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload.type).toBe('error');
			expect(payload.message).toContain('sessionId');
		});

		it('rejects update with empty newCwd', () => {
			handler.handleMessage(client, {
				type: 'update_session_cwd',
				sessionId: 'session-1',
				newCwd: '   ',
			});

			expect(callbacks.updateSessionCwd).not.toHaveBeenCalled();
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload.type).toBe('error');
			expect(payload.message).toContain('newCwd');
		});
	});

	describe('Create Worktree Session (CLI → Desktop)', () => {
		it('forwards parent + trimmed config to the callback and echoes the new id', async () => {
			(callbacks.createWorktreeSession as any).mockResolvedValue({
				success: true,
				sessionId: 'wt-1',
			});

			handler.handleMessage(client, {
				type: 'create_worktree_session',
				parentSessionId: 'parent-1',
				branchName: '  feature/foo  ',
				baseBranch: '  rc  ',
				requestId: 'req-1',
			});

			await new Promise((resolve) => setImmediate(resolve));

			expect(callbacks.createWorktreeSession).toHaveBeenCalledWith(
				'parent-1',
				{
					branchName: 'feature/foo',
					baseBranch: 'rc',
				},
				false
			);
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload).toMatchObject({
				type: 'create_worktree_session_result',
				success: true,
				sessionId: 'wt-1',
				requestId: 'req-1',
			});
		});

		it('surfaces the renderer-supplied error', async () => {
			(callbacks.createWorktreeSession as any).mockResolvedValue({
				success: false,
				error: 'Parent agent parent-9 not found',
			});

			handler.handleMessage(client, {
				type: 'create_worktree_session',
				parentSessionId: 'parent-9',
				branchName: 'feature/bar',
			});

			await new Promise((resolve) => setImmediate(resolve));

			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload).toMatchObject({
				type: 'create_worktree_session_result',
				success: false,
				error: 'Parent agent parent-9 not found',
			});
		});

		it('rejects a missing parentSessionId', () => {
			handler.handleMessage(client, {
				type: 'create_worktree_session',
				branchName: 'feature/bar',
			});

			expect(callbacks.createWorktreeSession).not.toHaveBeenCalled();
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload.type).toBe('error');
			expect(payload.message).toContain('parentSessionId');
		});

		it('rejects a missing/empty branchName', () => {
			handler.handleMessage(client, {
				type: 'create_worktree_session',
				parentSessionId: 'parent-1',
				branchName: '   ',
			});

			expect(callbacks.createWorktreeSession).not.toHaveBeenCalled();
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload.type).toBe('error');
			expect(payload.message).toContain('branchName');
		});
	});

	describe('Group hierarchy forwarding', () => {
		it('forwards parentGroupId when creating a nested group', async () => {
			handler.handleMessage(client, {
				type: 'create_group',
				name: 'Project',
				emoji: '📁',
				parentGroupId: 'company',
				requestId: 'request-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.createGroup).toHaveBeenCalledWith('Project', '📁', 'company', {
					emoji: '📁',
				});
			});
		});

		it('forwards a normalized icon and color when creating a group', async () => {
			handler.handleMessage(client, {
				type: 'create_group',
				name: 'Project',
				icon: 'Rocket',
				color: '#ef4444',
			});

			await vi.waitFor(() => {
				expect(callbacks.createGroup).toHaveBeenCalledWith('Project', undefined, undefined, {
					icon: 'rocket',
					color: '#EF4444',
				});
			});
		});

		it('rejects an unknown icon at the socket boundary', () => {
			handler.handleMessage(client, {
				type: 'create_group',
				name: 'Project',
				icon: 'sparkle-pony',
			});

			expect(callbacks.createGroup).not.toHaveBeenCalled();
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload.type).toBe('error');
			expect(payload.message).toContain('Unknown icon');
		});

		it('rejects an emoji and an icon together at the socket boundary', () => {
			handler.handleMessage(client, {
				type: 'create_group',
				name: 'Project',
				emoji: '🚀',
				icon: 'rocket',
			});

			expect(callbacks.createGroup).not.toHaveBeenCalled();
		});

		it('rejects non-string parentGroupId values instead of creating a root group', () => {
			handler.handleMessage(client, {
				type: 'create_group',
				name: 'Project',
				parentGroupId: 42,
			});

			expect(callbacks.createGroup).not.toHaveBeenCalled();
		});

		it('forwards a validated update_group request', async () => {
			handler.handleMessage(client, {
				type: 'update_group',
				groupId: 'group-1',
				name: 'Renamed',
				icon: 'Shield',
				color: '#22c55e',
				requestId: 'request-2',
			});

			await vi.waitFor(() => {
				expect(callbacks.updateGroup).toHaveBeenCalledWith('group-1', {
					name: 'Renamed',
					icon: 'shield',
					color: '#22C55E',
				});
			});
		});

		it('forwards an explicit clear list on update_group', async () => {
			handler.handleMessage(client, {
				type: 'update_group',
				groupId: 'group-1',
				clear: ['icon', 'parent'],
			});

			await vi.waitFor(() => {
				expect(callbacks.updateGroup).toHaveBeenCalledWith('group-1', {
					clear: ['icon', 'parent'],
				});
			});
		});

		it('rejects an update_group with no groupId', () => {
			handler.handleMessage(client, { type: 'update_group', name: 'Renamed' });

			expect(callbacks.updateGroup).not.toHaveBeenCalled();
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload.message).toContain('groupId');
		});

		it('rejects an update_group that changes nothing', () => {
			handler.handleMessage(client, { type: 'update_group', groupId: 'group-1' });

			expect(callbacks.updateGroup).not.toHaveBeenCalled();
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload.message).toContain('Nothing to update');
		});

		it('rejects an update_group with an unknown clear target', () => {
			handler.handleMessage(client, {
				type: 'update_group',
				groupId: 'group-1',
				clear: ['collapsed'],
			});

			expect(callbacks.updateGroup).not.toHaveBeenCalled();
		});

		it('forwards a hide request on update_group', async () => {
			handler.handleMessage(client, { type: 'update_group', groupId: 'group-1', hidden: true });

			await vi.waitFor(() => {
				expect(callbacks.updateGroup).toHaveBeenCalledWith('group-1', { hidden: true });
			});
		});

		it('forwards a show request on update_group', async () => {
			handler.handleMessage(client, { type: 'update_group', groupId: 'group-1', hidden: false });

			await vi.waitFor(() => {
				expect(callbacks.updateGroup).toHaveBeenCalledWith('group-1', { hidden: false });
			});
		});

		it('rejects an update_group whose hidden is not a boolean', () => {
			handler.handleMessage(client, { type: 'update_group', groupId: 'group-1', hidden: 'true' });

			expect(callbacks.updateGroup).not.toHaveBeenCalled();
		});

		describe('update_group_settings', () => {
			const lastFrame = () =>
				JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]) as Record<string, unknown>;

			it('forwards a validated request and answers with the whole result', async () => {
				vi.mocked(callbacks.updateGroupSettings).mockResolvedValue({
					success: true,
					defaults: { nudgeMessage: 'N' },
					shortLabel: 'BE',
					changed: ['Nudge Message'],
					publish: {
						agents: [{ id: 'a', name: 'A' }],
						skipped: [],
						changed: ['Nudge Message'],
						unpublished: [],
						replaced: [],
						providerBound: [],
					},
				});
				handler.handleMessage(client, {
					type: 'update_group_settings',
					groupId: 'group-1',
					requestId: 'r1',
					configPatch: { nudgeMessage: 'N' },
					shortLabel: 'BE',
					publish: true,
				});

				await vi.waitFor(() => expect(lastFrame().type).toBe('update_group_settings_result'));
				expect(callbacks.updateGroupSettings).toHaveBeenCalledWith('group-1', {
					configPatch: { nudgeMessage: 'N' },
					shortLabel: 'BE',
					publish: true,
				});
				expect(lastFrame()).toMatchObject({
					success: true,
					requestId: 'r1',
					groupId: 'group-1',
					shortLabel: 'BE',
					publish: { agents: [{ id: 'a', name: 'A' }] },
				});
			});

			it('relays a refusal from the app', async () => {
				vi.mocked(callbacks.updateGroupSettings).mockResolvedValue({
					success: false,
					error: 'Group not found',
				});
				handler.handleMessage(client, {
					type: 'update_group_settings',
					groupId: 'group-1',
					shortLabel: 'BE',
				});

				await vi.waitFor(() => expect(lastFrame().type).toBe('update_group_settings_result'));
				expect(lastFrame()).toMatchObject({ success: false, error: 'Group not found' });
			});

			it('rejects a request with no groupId', () => {
				handler.handleMessage(client, { type: 'update_group_settings', shortLabel: 'BE' });

				expect(callbacks.updateGroupSettings).not.toHaveBeenCalled();
				expect(lastFrame().message).toContain('groupId');
			});

			it('rejects a request that changes nothing', () => {
				handler.handleMessage(client, { type: 'update_group_settings', groupId: 'group-1' });

				expect(callbacks.updateGroupSettings).not.toHaveBeenCalled();
				expect(lastFrame().message).toContain('Nothing to update');
			});

			it('rejects a key that is not a group default before the renderer is asked', () => {
				handler.handleMessage(client, {
					type: 'update_group_settings',
					groupId: 'group-1',
					configPatch: { bookmarked: true },
				});

				expect(callbacks.updateGroupSettings).not.toHaveBeenCalled();
				expect(lastFrame().message).toContain('bookmarked');
			});
		});
	});

	describe('Cue gate (maestro-cli cue gate)', () => {
		const lastFrame = () =>
			JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]) as Record<string, unknown>;

		it('sets a gate with its policy and reports every subscription changed', async () => {
			vi.mocked(callbacks.setCueSubscriptionGate).mockResolvedValue({
				ok: true,
				updated: ['Triage', 'Triage-cmd-a'],
			});
			handler.handleMessage(client, {
				type: 'set_cue_subscription_gate',
				requestId: 'g1',
				subscriptionId: 'a1::Triage::Triage',
				gate: '  the issue reports a bug  ',
				gateOnUnavailable: 'skip',
			});

			await vi.waitFor(() => expect(lastFrame().type).toBe('set_cue_subscription_gate_result'));
			expect(callbacks.setCueSubscriptionGate).toHaveBeenCalledWith('a1::Triage::Triage', {
				condition: '  the issue reports a bug  ',
				onUnavailable: 'skip',
			});
			expect(lastFrame()).toMatchObject({
				success: true,
				requestId: 'g1',
				subscriptionId: 'a1::Triage::Triage',
				updated: ['Triage', 'Triage-cmd-a'],
				gate: 'the issue reports a bug',
				gateOnUnavailable: 'skip',
			});
		});

		it('removes a gate on an explicit null', async () => {
			handler.handleMessage(client, {
				type: 'set_cue_subscription_gate',
				subscriptionId: 'a1::Triage::Triage',
				gate: null,
			});

			await vi.waitFor(() => expect(lastFrame().type).toBe('set_cue_subscription_gate_result'));
			expect(callbacks.setCueSubscriptionGate).toHaveBeenCalledWith('a1::Triage::Triage', null);
			expect(lastFrame()).toMatchObject({ success: true, gate: null });
		});

		it('passes the engine refusal back as a failed result', async () => {
			vi.mocked(callbacks.setCueSubscriptionGate).mockResolvedValue({
				ok: false,
				error: 'Could not write the gate.',
			});
			handler.handleMessage(client, {
				type: 'set_cue_subscription_gate',
				subscriptionId: 'a1::Triage::Missing',
				gate: 'the issue reports a bug',
			});

			await vi.waitFor(() => expect(lastFrame().type).toBe('set_cue_subscription_gate_result'));
			expect(lastFrame()).toMatchObject({ success: false, error: 'Could not write the gate.' });
			expect(lastFrame()).not.toHaveProperty('updated');
		});

		it('refuses a frame that is neither a removal nor a usable condition', () => {
			const refused = (frame: Record<string, unknown>) => {
				handler.handleMessage(client, { type: 'set_cue_subscription_gate', ...frame });
				return lastFrame();
			};

			// A dropped `gate` field must not be read as "remove the gate".
			expect(refused({ subscriptionId: 'a1::T::T' })).toMatchObject({
				type: 'error',
				message: expect.stringContaining('Missing gate'),
			});
			expect(refused({ subscriptionId: 'a1::T::T', gate: '   ' }).type).toBe('error');
			expect(refused({ subscriptionId: 'a1::T::T', gate: 'x'.repeat(1001) }).type).toBe('error');
			expect(
				refused({ subscriptionId: 'a1::T::T', gate: 'a bug', gateOnUnavailable: 'maybe' })
			).toMatchObject({ type: 'error', message: expect.stringContaining('gateOnUnavailable') });
			expect(refused({ gate: 'a bug' })).toMatchObject({
				type: 'error',
				message: expect.stringContaining('Missing subscriptionId'),
			});
			expect(callbacks.setCueSubscriptionGate).not.toHaveBeenCalled();
		});
	});

	describe('Cue injection screen (maestro-cli cue screen)', () => {
		const lastFrame = () =>
			JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]) as Record<string, unknown>;
		const RESULT = 'set_cue_subscription_injection_screen_result';

		it('sets the mode and threshold and reports every subscription changed', async () => {
			vi.mocked(callbacks.setCueSubscriptionInjectionScreen).mockResolvedValue({
				ok: true,
				updated: ['Triage', 'Triage-cmd-a'],
			});
			handler.handleMessage(client, {
				type: 'set_cue_subscription_injection_screen',
				requestId: 's1',
				subscriptionId: 'a1::Triage::Triage',
				mode: 'on',
				threshold: 0.6,
			});

			await vi.waitFor(() => expect(lastFrame().type).toBe(RESULT));
			expect(callbacks.setCueSubscriptionInjectionScreen).toHaveBeenCalledWith(
				'a1::Triage::Triage',
				{ mode: 'on', threshold: 0.6 }
			);
			expect(lastFrame()).toMatchObject({
				success: true,
				requestId: 's1',
				subscriptionId: 'a1::Triage::Triage',
				updated: ['Triage', 'Triage-cmd-a'],
				mode: 'on',
				threshold: 0.6,
			});
		});

		it('sets a mode with no threshold', async () => {
			handler.handleMessage(client, {
				type: 'set_cue_subscription_injection_screen',
				subscriptionId: 'a1::Triage::Triage',
				mode: 'off',
			});

			await vi.waitFor(() => expect(lastFrame().type).toBe(RESULT));
			expect(callbacks.setCueSubscriptionInjectionScreen).toHaveBeenCalledWith(
				'a1::Triage::Triage',
				{ mode: 'off' }
			);
			expect(lastFrame()).not.toHaveProperty('threshold');
		});

		it('passes the engine refusal back as a failed result', async () => {
			vi.mocked(callbacks.setCueSubscriptionInjectionScreen).mockResolvedValue({
				ok: false,
				error: 'Could not write the screen.',
			});
			handler.handleMessage(client, {
				type: 'set_cue_subscription_injection_screen',
				subscriptionId: 'a1::Triage::Missing',
				mode: 'on',
			});

			await vi.waitFor(() => expect(lastFrame().type).toBe(RESULT));
			expect(lastFrame()).toMatchObject({ success: false, error: 'Could not write the screen.' });
			expect(lastFrame()).not.toHaveProperty('updated');
		});

		it('refuses a frame with no mode, an unknown mode, or a bad threshold', () => {
			const refused = (frame: Record<string, unknown>) => {
				handler.handleMessage(client, {
					type: 'set_cue_subscription_injection_screen',
					...frame,
				});
				return lastFrame();
			};

			// A dropped `mode` must not be read as "back to the default": that
			// would switch off a screen someone turned on.
			expect(refused({ subscriptionId: 'a1::T::T' })).toMatchObject({
				type: 'error',
				message: expect.stringContaining('Invalid mode'),
			});
			expect(refused({ subscriptionId: 'a1::T::T', mode: 'sometimes' }).type).toBe('error');
			expect(refused({ subscriptionId: 'a1::T::T', mode: 'on', threshold: 0 })).toMatchObject({
				type: 'error',
				message: expect.stringContaining('above 0 and at most 1'),
			});
			expect(refused({ subscriptionId: 'a1::T::T', mode: 'on', threshold: '0.5' }).type).toBe(
				'error'
			);
			expect(refused({ mode: 'on' })).toMatchObject({
				type: 'error',
				message: expect.stringContaining('Missing subscriptionId'),
			});
			expect(callbacks.setCueSubscriptionInjectionScreen).not.toHaveBeenCalled();
		});
	});
});

describe('WebSocketMessageHandler - plugin MCP tool bridge', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const invokeTool = vi.fn();
	const tool = {
		id: 'acme/dostuff',
		localId: 'dostuff',
		pluginId: 'acme',
		name: 'Do Stuff',
		description: 'does stuff',
		inputSchema: { type: 'object' },
	};
	const fakeManager = {
		getContributions: () => ({ tools: [tool] }),
		invokeTool,
	} as unknown as PluginManager;

	function lastResult(): Record<string, unknown> {
		const calls = (client.socket.send as unknown as { mock: { calls: unknown[][] } }).mock.calls;
		return JSON.parse(calls[calls.length - 1][0] as string) as Record<string, unknown>;
	}

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		handler.setCallbacks(createMockCallbacks());
		client = createMockClient();
		invokeTool.mockReset();
		vi.mocked(getActivePluginManager).mockReturnValue(fakeManager);
		vi.mocked(isPluginsFeatureEnabled).mockReturnValue(true);
		vi.mocked(getHeadlessAgentRunner).mockReturnValue(null);
	});

	it('lists declared tools with an MCP-safe name + the real toolId', () => {
		handler.handleMessage(client, { type: 'plugins_list_tools' });
		const res = lastResult();
		expect(res.type).toBe('plugins_list_tools_result');
		expect(res.tools).toEqual([
			{
				name: 'acme__dostuff',
				toolId: 'acme/dostuff',
				description: 'does stuff',
				inputSchema: { type: 'object' },
			},
		]);
	});

	it('lists no tools when the plugins flag is off', () => {
		vi.mocked(isPluginsFeatureEnabled).mockReturnValue(false);
		handler.handleMessage(client, { type: 'plugins_list_tools' });
		expect(lastResult().tools).toEqual([]);
	});

	it('rejects an unknown toolId and never invokes', async () => {
		handler.handleMessage(client, { type: 'plugins_call_tool', toolId: 'acme/ghost', args: {} });
		await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
		const res = lastResult();
		expect(res.ok).toBe(false);
		expect(String(res.error)).toContain('Unknown tool');
		expect(invokeTool).not.toHaveBeenCalled();
	});

	it('rejects a call when the plugins flag is off', async () => {
		vi.mocked(isPluginsFeatureEnabled).mockReturnValue(false);
		handler.handleMessage(client, {
			type: 'plugins_call_tool',
			toolId: 'acme/dostuff',
			args: {},
		});
		await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
		expect(lastResult().error).toBe('PluginsDisabled');
		expect(invokeTool).not.toHaveBeenCalled();
	});

	it('blocks a high-risk call (destructive args) and never invokes', async () => {
		handler.handleMessage(client, {
			type: 'plugins_call_tool',
			toolId: 'acme/dostuff',
			args: { cmd: 'delete the production database and drop all tables' },
		});
		await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
		const res = lastResult();
		expect(res.ok).toBe(false);
		expect(res.blocked).toBe(true);
		expect(invokeTool).not.toHaveBeenCalled();
	});

	it('invokes a low-risk call and returns the result', async () => {
		invokeTool.mockResolvedValue({ done: true });
		handler.handleMessage(client, {
			type: 'plugins_call_tool',
			toolId: 'acme/dostuff',
			args: { value: 1 },
		});
		await vi.waitFor(() => expect(invokeTool).toHaveBeenCalled());
		await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
		const res = lastResult();
		expect(res.ok).toBe(true);
		expect(res.result).toEqual({ done: true });
		expect(invokeTool).toHaveBeenCalledWith('acme/dostuff', { value: 1 }, { callerAgentId: null });
	});

	it('binds tool identity to a run proof, ignoring forged model arguments and tabId', async () => {
		invokeTool.mockResolvedValue({ done: true });
		const runToken = pluginToolRunIdentity.issue('agent-a');
		try {
			handler.handleMessage(client, {
				type: 'plugins_call_tool',
				toolId: 'acme/dostuff',
				args: { agentId: 'agent-b' },
				tabId: 'agent-b',
				runToken,
			});
			await vi.waitFor(() => expect(invokeTool).toHaveBeenCalled());
			expect(invokeTool).toHaveBeenCalledWith(
				'acme/dostuff',
				{ agentId: 'agent-b' },
				{ callerAgentId: 'agent-a' }
			);
		} finally {
			pluginToolRunIdentity.revoke(runToken);
		}
	});

	it('records a receipt only after a successful active tool call for the armed run', async () => {
		const token = pluginToolRunIdentity.issue('agent-a', 60_000, 'acme/dostuff');
		try {
			invokeTool.mockResolvedValue({ messageIds: ['123'], privateBody: 'do not retain' });
			handler.handleMessage(client, {
				type: 'plugins_call_tool',
				toolId: 'acme/dostuff',
				args: { agentId: 'agent-b' },
				runToken: token,
			});
			await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
			expect(lastResult().ok).toBe(true);
			expect(pluginToolRunIdentity.getReceipts(token)).toEqual([
				{
					runId: expect.stringMatching(/^[0-9a-f]{32}$/),
					agentId: 'agent-a',
					toolId: 'acme/dostuff',
					messageIds: ['123'],
				},
			]);
		} finally {
			pluginToolRunIdentity.revoke(token);
		}
	});

	it('records no receipt when the tool fails or its plugin deactivates', async () => {
		const token = pluginToolRunIdentity.issue('agent-a', 60_000, 'acme/dostuff');
		try {
			handler.handleMessage(client, {
				type: 'plugins_call_tool',
				toolId: 'acme/dostuff',
				args: { cmd: 'delete the production database and drop all tables' },
				runToken: token,
			});
			await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalledTimes(1));
			expect(lastResult().blocked).toBe(true);
			expect(pluginToolRunIdentity.getReceipts(token)).toEqual([]);
			invokeTool.mockRejectedValueOnce(new Error('Discord rejected the send'));
			handler.handleMessage(client, {
				type: 'plugins_call_tool',
				toolId: 'acme/dostuff',
				runToken: token,
			});
			await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalledTimes(2));
			expect(pluginToolRunIdentity.getReceipts(token)).toEqual([]);
			invokeTool.mockImplementationOnce(async () => {
				vi.mocked(isPluginsFeatureEnabled).mockReturnValue(false);
				return { messageIds: ['124'] };
			});
			handler.handleMessage(client, {
				type: 'plugins_call_tool',
				toolId: 'acme/dostuff',
				runToken: token,
			});
			await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalledTimes(3));
			expect(pluginToolRunIdentity.getReceipts(token)).toEqual([]);
		} finally {
			pluginToolRunIdentity.revoke(token);
		}
	});

	it('delivers authenticated trusted Relay reply text unchanged through the MCP host boundary', async () => {
		const relayTool = {
			...tool,
			id: 'sh.maestro.relay/send',
			pluginId: 'sh.maestro.relay',
			localId: 'send',
			name: 'Send reply',
			description: 'Send a message',
		};
		vi.mocked(getActivePluginManager).mockReturnValue({
			getContributions: () => ({ tools: [relayTool] }),
			getActiveRecords: () => [
				{
					id: 'sh.maestro.relay',
					signature: { status: 'trusted', signerKey: RELAY_PUBLISHER_KEY },
				},
			],
			invokeTool,
		} as unknown as PluginManager);
		const runToken = pluginToolRunIdentity.issue('agent-a');
		const args = {
			text: 'Ein Release kann alle Plugins enthalten. Discuss deployment and secrets.',
			threadId: '30',
		};
		invokeTool.mockResolvedValue({ messageIds: ['100'] });
		try {
			handler.handleMessage(client, {
				type: 'plugins_call_tool',
				toolId: relayTool.id,
				args,
				runToken,
			});
			await vi.waitFor(() => expect(lastResult().ok).toBe(true));
			expect(invokeTool).toHaveBeenCalledWith(relayTool.id, args, { callerAgentId: 'agent-a' });
			expect(lastResult().result).toEqual({ messageIds: ['100'] });
		} finally {
			pluginToolRunIdentity.revoke(runToken);
		}
	});

	it.each(['missing', 'forged', 'expired', 'revoked'])(
		'denies a Relay reply with a %s run proof despite forged identity arguments',
		async (proof) => {
			const relayTool = {
				...tool,
				id: 'sh.maestro.relay/send',
				pluginId: 'sh.maestro.relay',
				localId: 'send',
			};
			vi.mocked(getActivePluginManager).mockReturnValue({
				getContributions: () => ({ tools: [relayTool] }),
				getActiveRecords: () => [
					{
						id: 'sh.maestro.relay',
						signature: { status: 'trusted', signerKey: RELAY_PUBLISHER_KEY },
					},
				],
				invokeTool,
			} as unknown as PluginManager);
			let runToken: string | undefined;
			if (proof === 'forged') runToken = 'f'.repeat(64);
			if (proof === 'expired') {
				const now = vi.spyOn(Date, 'now').mockReturnValue(1);
				runToken = pluginToolRunIdentity.issue('agent-a', 1);
				now.mockReturnValue(3);
			} else if (proof === 'revoked') {
				runToken = pluginToolRunIdentity.issue('agent-a');
				pluginToolRunIdentity.revoke(runToken);
			}
			try {
				handler.handleMessage(client, {
					type: 'plugins_call_tool',
					toolId: relayTool.id,
					args: { text: 'Release discussion', callerAgentId: 'agent-a', skipRisk: true },
					tabId: 'agent-a',
					runToken,
				});
				await vi.waitFor(() => expect(lastResult().error).toBe('Verified caller required'));
				expect(invokeTool).not.toHaveBeenCalled();
			} finally {
				if (runToken) pluginToolRunIdentity.revoke(runToken);
				vi.restoreAllMocks();
			}
		}
	);

	it.each([undefined, MAESTRO_PUBLISHER_KEYS[0], 'user-trusted-other-publisher'])(
		'rejects exact Relay replies signed by an unpinned trusted publisher: %s',
		async (signerKey) => {
			const relayTool = {
				...tool,
				id: 'sh.maestro.relay/send',
				pluginId: 'sh.maestro.relay',
				localId: 'send',
			};
			vi.mocked(getActivePluginManager).mockReturnValue({
				getContributions: () => ({ tools: [relayTool] }),
				getActiveRecords: () => [
					{ id: 'sh.maestro.relay', signature: { status: 'trusted', signerKey } },
				],
				invokeTool,
			} as unknown as PluginManager);
			const runToken = pluginToolRunIdentity.issue('agent-a');
			try {
				handler.handleMessage(client, {
					type: 'plugins_call_tool',
					toolId: relayTool.id,
					args: { text: 'Release discussion' },
					runToken,
				});
				await vi.waitFor(() =>
					expect(String(lastResult().error)).toContain('pinned Relay publisher')
				);
				expect(invokeTool).not.toHaveBeenCalled();
			} finally {
				pluginToolRunIdentity.revoke(runToken);
			}
		}
	);

	it.each(['unsigned', 'untrusted', 'invalid', undefined])(
		'denies a Relay reply without live trusted signature status: %s',
		async (status) => {
			const relayTool = {
				...tool,
				id: 'sh.maestro.relay/send',
				pluginId: 'sh.maestro.relay',
				localId: 'send',
			};
			vi.mocked(getActivePluginManager).mockReturnValue({
				getContributions: () => ({ tools: [relayTool] }),
				getActiveRecords: () => [
					{ id: 'sh.maestro.relay', signature: status ? { status } : undefined },
				],
				invokeTool,
			} as unknown as PluginManager);
			const runToken = pluginToolRunIdentity.issue('agent-a');
			try {
				handler.handleMessage(client, {
					type: 'plugins_call_tool',
					toolId: relayTool.id,
					args: { text: 'Release discussion' },
					runToken,
				});
				await vi.waitFor(() =>
					expect(String(lastResult().error)).toContain('trusted signed plugin')
				);
				expect(invokeTool).not.toHaveBeenCalled();
			} finally {
				pluginToolRunIdentity.revoke(runToken);
			}
		}
	);

	it.each([
		{ id: 'sh.maestro.relay/admin', pluginId: 'sh.maestro.relay', localId: 'admin' },
		{ id: 'other.plugin/send', pluginId: 'other.plugin', localId: 'send' },
		{ id: 'sh.maestro.relay/send', pluginId: 'other.plugin', localId: 'send' },
		{ id: 'sh.maestro.relay/send', pluginId: 'sh.maestro.relay', localId: 'admin' },
	])(
		'retains the risk ceiling for other tools or mismatched declared identities: %j',
		async (identity) => {
			const declared = { ...tool, ...identity };
			vi.mocked(getActivePluginManager).mockReturnValue({
				getContributions: () => ({ tools: [declared] }),
				getActiveRecords: () => [
					{
						id: 'sh.maestro.relay',
						signature: { status: 'trusted', signerKey: RELAY_PUBLISHER_KEY },
					},
				],
				invokeTool,
			} as unknown as PluginManager);
			const runToken = pluginToolRunIdentity.issue('agent-a');
			try {
				handler.handleMessage(client, {
					type: 'plugins_call_tool',
					toolId: declared.id,
					args: { text: 'Release', force: true },
					runToken,
				});
				await vi.waitFor(() => expect(lastResult().blocked).toBe(true));
				expect(invokeTool).not.toHaveBeenCalled();
			} finally {
				pluginToolRunIdentity.revoke(runToken);
			}
		}
	);

	it('propagates Relay destination authorization refusal instead of claiming a sent reply', async () => {
		const relayTool = {
			...tool,
			id: 'sh.maestro.relay/send',
			pluginId: 'sh.maestro.relay',
			localId: 'send',
		};
		vi.mocked(getActivePluginManager).mockReturnValue({
			getContributions: () => ({ tools: [relayTool] }),
			getActiveRecords: () => [
				{
					id: 'sh.maestro.relay',
					signature: { status: 'trusted', signerKey: RELAY_PUBLISHER_KEY },
				},
			],
			invokeTool,
		} as unknown as PluginManager);
		invokeTool.mockRejectedValue(new Error('Thread is not bound to caller'));
		const runToken = pluginToolRunIdentity.issue('agent-a');
		try {
			handler.handleMessage(client, {
				type: 'plugins_call_tool',
				toolId: relayTool.id,
				args: { text: 'Release', threadId: 'foreign' },
				runToken,
			});
			await vi.waitFor(() => expect(lastResult().error).toBe('Thread is not bound to caller'));
			expect(lastResult().ok).toBe(false);
		} finally {
			pluginToolRunIdentity.revoke(runToken);
		}
	});

	it('runs a local CLI request through the host runner and returns its provider session', async () => {
		const run = vi.fn(async () => ({ success: true, response: 'hello', sessionId: 'provider-1' }));
		vi.mocked(getHeadlessAgentRunner).mockReturnValue(run);
		client.cliAuthenticated = true;
		(client.socket as unknown as { _socket: { remoteAddress: string } })._socket = {
			remoteAddress: '127.0.0.1',
		};
		handler.handleMessage(client, {
			type: 'plugins_send_agent',
			agentId: 'agent-a',
			prompt: 'hello',
		});
		await vi.waitFor(() => expect(run).toHaveBeenCalled());
		expect(run).toHaveBeenCalledWith(
			'agent-a',
			'hello',
			undefined,
			expect.any(AbortSignal),
			'user',
			undefined,
			// No `model` on the message: no turn settings are passed at all, so the
			// agent's own model runs.
			undefined
		);
		expect(client.socket.off).toHaveBeenCalledWith('close', expect.any(Function));
		expect(lastResult()).toMatchObject({
			type: 'plugins_send_agent_result',
			available: true,
			success: true,
			response: 'hello',
			sessionId: 'provider-1',
		});
	});

	it.each(['sonnet', 'auto'])(
		'hands the runner the model of this one turn (%s), and carries its Auto report back',
		async (model) => {
			const auto = { label: 'Auto → low · haiku', detail: 'Auto: the router chose tier low.' };
			const run = vi.fn(async () => ({
				success: true,
				response: 'hello',
				sessionId: 'provider-1',
				...(model === 'auto' ? { auto } : {}),
			}));
			vi.mocked(getHeadlessAgentRunner).mockReturnValue(run);
			client.cliAuthenticated = true;
			(client.socket as unknown as { _socket: { remoteAddress: string } })._socket = {
				remoteAddress: '127.0.0.1',
			};
			handler.handleMessage(client, {
				type: 'plugins_send_agent',
				agentId: 'agent-a',
				prompt: 'hello',
				model,
			});
			await vi.waitFor(() => expect(run).toHaveBeenCalled());
			expect(run).toHaveBeenCalledWith(
				'agent-a',
				'hello',
				undefined,
				expect.any(AbortSignal),
				'user',
				undefined,
				undefined,
				// `requirePluginTools`, which sits ahead of the turn settings.
				false,
				{ model }
			);
			await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
			expect(lastResult()).toMatchObject({
				type: 'plugins_send_agent_result',
				available: true,
				success: true,
				response: 'hello',
			});
			if (model === 'auto') expect(lastResult().auto).toEqual(auto);
			else expect(lastResult()).not.toHaveProperty('auto');
		}
	);

	// The CLI admitted the send against a consult chain and already spent for
	// it. This process spawns the agent, so the chain rides the turn settings.
	it('hands the runner the consult chain the CLI admitted the send at', async () => {
		const run = vi.fn(async () => ({ success: true, response: 'hello', sessionId: 'provider-1' }));
		vi.mocked(getHeadlessAgentRunner).mockReturnValue(run);
		client.cliAuthenticated = true;
		(client.socket as unknown as { _socket: { remoteAddress: string } })._socket = {
			remoteAddress: '127.0.0.1',
		};
		handler.handleMessage(client, {
			type: 'plugins_send_agent',
			agentId: 'agent-a',
			prompt: 'hello',
			model: 'sonnet',
			consultChain: { chainId: 'chain-a', depth: 2 },
		});
		await vi.waitFor(() => expect(run).toHaveBeenCalled());
		expect(run).toHaveBeenCalledWith(
			'agent-a',
			'hello',
			undefined,
			expect.any(AbortSignal),
			'user',
			undefined,
			undefined,
			false,
			{ model: 'sonnet', consultChain: { chainId: 'chain-a', depth: 2 } }
		);
	});

	it.each([
		['an id the counter would refuse', { chainId: '../escape', depth: 1 }],
		['a bare string', 'chain-a'],
		['null', null],
	])('reads %s as no consult chain, and still runs the send', async (_what, consultChain) => {
		const run = vi.fn(async () => ({ success: true, response: 'hello', sessionId: 'provider-1' }));
		vi.mocked(getHeadlessAgentRunner).mockReturnValue(run);
		client.cliAuthenticated = true;
		(client.socket as unknown as { _socket: { remoteAddress: string } })._socket = {
			remoteAddress: '127.0.0.1',
		};
		handler.handleMessage(client, {
			type: 'plugins_send_agent',
			agentId: 'agent-a',
			prompt: 'hello',
			consultChain,
		});
		await vi.waitFor(() => expect(run).toHaveBeenCalled());
		// No model and no usable chain: no turn settings at all.
		expect(vi.mocked(run).mock.calls[0][7]).toBeUndefined();
	});

	it.each([
		['a flag', '-x'],
		['a number', 7],
		['an empty string', ''],
		['a name with a space before it', ' sonnet'],
		['a name with a line break', 'son\nnet'],
		['an object', { model: 'sonnet' }],
		['null', null],
	])('refuses %s as the model of a CLI send, and starts no run', async (_what, model) => {
		const run = vi.fn();
		vi.mocked(getHeadlessAgentRunner).mockReturnValue(run);
		client.cliAuthenticated = true;
		(client.socket as unknown as { _socket: { remoteAddress: string } })._socket = {
			remoteAddress: '127.0.0.1',
		};
		handler.handleMessage(client, {
			type: 'plugins_send_agent',
			agentId: 'agent-a',
			prompt: 'hello',
			model,
		});
		await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
		expect(lastResult()).toMatchObject({
			type: 'plugins_send_agent_result',
			available: true,
			success: false,
			error: 'Invalid headless agent request',
		});
		expect(run).not.toHaveBeenCalled();
	});

	it('aborts a desktop-routed CLI send when its socket closes', async () => {
		let finishRun!: (reply: { success: boolean; response: string | null; sessionId: null }) => void;
		const run = vi.fn(
			() =>
				new Promise<{ success: boolean; response: string | null; sessionId: null }>((resolve) => {
					finishRun = resolve;
				})
		);
		vi.mocked(getHeadlessAgentRunner).mockReturnValue(run);
		client.cliAuthenticated = true;
		(client.socket as unknown as { _socket: { remoteAddress: string } })._socket = {
			remoteAddress: '127.0.0.1',
		};
		handler.handleMessage(client, {
			type: 'plugins_send_agent',
			agentId: 'agent-a',
			prompt: 'hello',
		});
		await vi.waitFor(() => expect(run).toHaveBeenCalled());
		const signal = vi.mocked(run).mock.calls[0][3] as AbortSignal;
		const onClose = vi.mocked(client.socket.once).mock.calls[0][1] as () => void;
		expect(signal.aborted).toBe(false);
		onClose();
		expect(signal.aborted).toBe(true);
		finishRun({ success: false, response: null, sessionId: null });
		await vi.waitFor(() => expect(client.socket.off).toHaveBeenCalledWith('close', onClose));
	});

	it('requires the declared tool and an actual runner receipt for a CLI delivery check', async () => {
		const run = vi.fn(async () => ({
			success: true,
			response: '{"messageIds":["invented"]}',
			sessionId: 'provider-1',
			toolReceipts: [],
		}));
		vi.mocked(getHeadlessAgentRunner).mockReturnValue(run);
		client.cliAuthenticated = true;
		(client.socket as unknown as { _socket: { remoteAddress: string } })._socket = {
			remoteAddress: '127.0.0.1',
		};
		handler.handleMessage(client, {
			type: 'plugins_send_agent',
			agentId: 'agent-a',
			prompt: 'report',
			requiredToolId: 'acme/absent',
		});
		await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalledTimes(1));
		expect(run).not.toHaveBeenCalled();
		expect(lastResult()).toMatchObject({
			success: false,
			error: 'Required plugin tool unavailable',
		});

		handler.handleMessage(client, {
			type: 'plugins_send_agent',
			agentId: 'agent-a',
			prompt: 'report',
			requiredToolId: 'acme/dostuff',
		});
		await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalledTimes(2));
		expect(run).toHaveBeenCalledWith(
			'agent-a',
			'report',
			undefined,
			expect.any(AbortSignal),
			'user',
			undefined,
			'acme/dostuff'
		);
		expect(lastResult()).toMatchObject({
			success: false,
			response: null,
			error: 'Required plugin tool returned no delivery receipt',
		});
	});

	it('preserves the provider failure when a required receipt is missing', async () => {
		vi.mocked(getHeadlessAgentRunner).mockReturnValue(
			vi.fn(async () => ({
				success: false,
				response: null,
				sessionId: null,
				error: 'Failed to authenticate: OAuth session expired and could not be refreshed',
				toolReceipts: [],
			}))
		);
		client.cliAuthenticated = true;
		(client.socket as unknown as { _socket: { remoteAddress: string } })._socket = {
			remoteAddress: '127.0.0.1',
		};
		handler.handleMessage(client, {
			type: 'plugins_send_agent',
			agentId: 'agent-a',
			prompt: 'report',
			requiredToolId: 'acme/dostuff',
		});
		await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
		expect(lastResult()).toMatchObject({
			success: false,
			response: null,
			error: 'Failed to authenticate: OAuth session expired and could not be refreshed',
			toolReceipts: [],
		});
	});

	it('returns a verified required tool receipt from the headless runner', async () => {
		const receipt = {
			runId: 'a'.repeat(32),
			agentId: 'agent-a',
			toolId: 'acme/dostuff',
			messageIds: ['123'],
		};
		vi.mocked(getHeadlessAgentRunner).mockReturnValue(
			vi.fn(async () => ({
				success: true,
				response: 'done',
				sessionId: 'provider-1',
				toolReceipts: [receipt],
			}))
		);
		client.cliAuthenticated = true;
		(client.socket as unknown as { _socket: { remoteAddress: string } })._socket = {
			remoteAddress: '127.0.0.1',
		};
		handler.handleMessage(client, {
			type: 'plugins_send_agent',
			agentId: 'agent-a',
			prompt: 'report',
			requiredToolId: 'acme/dostuff',
		});
		await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
		expect(lastResult()).toMatchObject({ success: true, toolReceipts: [receipt] });
	});

	it('fails a required delivery check when the plugin deactivates during the run', async () => {
		const run = vi.fn(async () => {
			vi.mocked(isPluginsFeatureEnabled).mockReturnValue(false);
			return {
				success: true,
				response: 'done',
				sessionId: 'provider-1',
				toolReceipts: [
					{
						runId: 'a'.repeat(32),
						agentId: 'agent-a',
						toolId: 'acme/dostuff',
						messageIds: ['123'],
					},
				],
			};
		});
		vi.mocked(getHeadlessAgentRunner).mockReturnValue(run);
		client.cliAuthenticated = true;
		(client.socket as unknown as { _socket: { remoteAddress: string } })._socket = {
			remoteAddress: '127.0.0.1',
		};
		handler.handleMessage(client, {
			type: 'plugins_send_agent',
			agentId: 'agent-a',
			prompt: 'report',
			requiredToolId: 'acme/dostuff',
		});
		await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
		expect(lastResult()).toMatchObject({
			success: false,
			response: null,
			error: 'Required plugin tool became unavailable',
		});
	});

	it('refuses the headless runner to a non-loopback web client', async () => {
		const run = vi.fn();
		vi.mocked(getHeadlessAgentRunner).mockReturnValue(run);
		client.cliAuthenticated = true;
		(client.socket as unknown as { _socket: { remoteAddress: string } })._socket = {
			remoteAddress: '192.0.2.5',
		};
		handler.handleMessage(client, {
			type: 'plugins_send_agent',
			agentId: 'agent-a',
			prompt: 'hello',
		});
		await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
		expect(lastResult()).toMatchObject({ available: false });
		expect(run).not.toHaveBeenCalled();
	});

	it('refuses a loopback browser or proxy without the CLI secret', async () => {
		const run = vi.fn();
		vi.mocked(getHeadlessAgentRunner).mockReturnValue(run);
		(client.socket as unknown as { _socket: { remoteAddress: string } })._socket = {
			remoteAddress: '127.0.0.1',
		};
		handler.handleMessage(client, {
			type: 'plugins_send_agent',
			agentId: 'agent-a',
			prompt: 'hello',
		});
		await vi.waitFor(() => expect(client.socket.send).toHaveBeenCalled());
		expect(lastResult()).toMatchObject({ available: false });
		expect(run).not.toHaveBeenCalled();
	});
	describe('Local Models endpoints (maestro-cli models endpoints)', () => {
		const lastResponse = () => {
			const calls = (client.socket.send as any).mock.calls;
			return JSON.parse(calls[calls.length - 1][0]);
		};

		it('local_models_endpoints_detect answers with the detected servers', async () => {
			handler.handleMessage(client, { type: 'local_models_endpoints_detect', requestId: 'd1' });
			await vi.waitFor(() =>
				expect(lastResponse().type).toBe('local_models_endpoints_detect_result')
			);
			expect(detectNewLocalModelEndpoints).toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'd1',
				detected: [{ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }],
			});
		});

		it('local_models_endpoint_test passes the reference and model through', async () => {
			handler.handleMessage(client, {
				type: 'local_models_endpoint_test',
				requestId: 't1',
				endpoint: 'ollama',
				model: 'qwen3',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_endpoint_test_result'));
			expect(testLocalModelEndpoint).toHaveBeenCalledWith('ollama', 'qwen3');
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 't1',
				result: { ok: true, model: 'qwen3', latencyMs: 42 },
			});
		});

		it('local_models_endpoint_models passes the reference through and returns the verdict', async () => {
			handler.handleMessage(client, {
				type: 'local_models_endpoint_models',
				requestId: 'm1',
				endpoint: 'ollama',
			});
			await vi.waitFor(() =>
				expect(lastResponse().type).toBe('local_models_endpoint_models_result')
			);
			expect(listLocalModelEndpointModels).toHaveBeenCalledWith('ollama');
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'm1',
				result: { ok: true, models: [{ id: 'qwen3:4b', sizeBytes: 1024 }] },
			});
		});

		it('local_models_endpoint_models carries an unreachable server as a verdict', async () => {
			vi.mocked(listLocalModelEndpointModels).mockResolvedValueOnce({
				ok: false,
				error: { kind: 'network', message: 'Nothing is listening' },
			} as never);
			handler.handleMessage(client, {
				type: 'local_models_endpoint_models',
				requestId: 'm2',
				endpoint: 'ollama',
			});
			await vi.waitFor(() =>
				expect(lastResponse().type).toBe('local_models_endpoint_models_result')
			);
			expect(lastResponse()).toMatchObject({
				success: true,
				result: { ok: false, error: { kind: 'network' } },
			});
		});

		it('local_models_endpoint_test reports a thrown failure as success: false', async () => {
			vi.mocked(testLocalModelEndpoint).mockRejectedValueOnce(new Error('store gone'));
			handler.handleMessage(client, {
				type: 'local_models_endpoint_test',
				requestId: 't2',
				endpoint: 'x',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_endpoint_test_result'));
			expect(lastResponse()).toMatchObject({ success: false, error: 'store gone' });
		});

		it('local_models_run_task passes the task id and input through', async () => {
			const input = { prompt: 'diff' };
			handler.handleMessage(client, {
				type: 'local_models_run_task',
				requestId: 'r1',
				taskId: 'git-drafts',
				input,
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_run_task_result'));
			expect(runLocalTaskRequest).toHaveBeenCalledWith('git-drafts', input);
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'r1',
				result: { status: 'off' },
			});
		});

		it('local_models_run_task reports a refused request as success: false', async () => {
			vi.mocked(runLocalTaskRequest).mockRejectedValueOnce(new Error('Unknown task "x".'));
			handler.handleMessage(client, {
				type: 'local_models_run_task',
				requestId: 'r2',
				taskId: 'x',
				input: { prompt: 'p' },
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_run_task_result'));
			expect(lastResponse()).toMatchObject({ success: false, error: 'Unknown task "x".' });
		});

		it('local_models_git_draft passes the repository and target branch through', async () => {
			handler.handleMessage(client, {
				type: 'local_models_git_draft',
				requestId: 'g1',
				cwd: '/repo',
				baseBranch: 'main',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_git_draft_result'));
			expect(draftPullRequestRequest).toHaveBeenCalledWith({ cwd: '/repo', baseBranch: 'main' });
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'g1',
				result: { success: true, title: 'Add retry', body: 'Retries.' },
			});
		});

		it('local_models_git_draft reports a refused request as success: false', async () => {
			vi.mocked(draftPullRequestRequest).mockRejectedValueOnce(
				new Error('A pull request draft needs a repository path (cwd).')
			);
			handler.handleMessage(client, { type: 'local_models_git_draft', requestId: 'g2' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_git_draft_result'));
			expect(lastResponse()).toMatchObject({
				success: false,
				error: 'A pull request draft needs a repository path (cwd).',
			});
		});

		it('local_models_transcribe passes the file path through and returns the transcript', async () => {
			handler.handleMessage(client, {
				type: 'local_models_transcribe',
				requestId: 't1',
				path: '/clips/note.wav',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_transcribe_result'));
			expect(transcribeAudioFileRequest).toHaveBeenCalledWith('/clips/note.wav');
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 't1',
				result: { status: 'ok', text: 'ship the fix today' },
			});
		});

		it('local_models_transcribe reports a refused request as success: false', async () => {
			vi.mocked(transcribeAudioFileRequest).mockRejectedValueOnce(
				new Error('An absolute path to a WAV file is required.')
			);
			handler.handleMessage(client, { type: 'local_models_transcribe', requestId: 't2' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_transcribe_result'));
			expect(lastResponse()).toMatchObject({
				success: false,
				error: 'An absolute path to a WAV file is required.',
			});
		});

		it('notify_speak passes the text through and answers once it was spoken', async () => {
			handler.handleMessage(client, {
				type: 'notify_speak',
				requestId: 'sp1',
				text: 'The build is green.',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('notify_speak_result'));
			expect(speakNoticeRequest).toHaveBeenCalledWith('The build is green.');
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'sp1',
				result: { spoken: true, text: 'The build is green.' },
			});
		});

		it('notify_speak returns a refusal as a verdict, not an error', async () => {
			vi.mocked(speakNoticeRequest).mockResolvedValueOnce({
				spoken: false,
				code: 'voice-session-active',
				message: 'A voice session is live, so the notice was not spoken.',
			});
			handler.handleMessage(client, { type: 'notify_speak', requestId: 'sp2', text: 'hello' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('notify_speak_result'));
			expect(lastResponse()).toMatchObject({
				success: true,
				result: { spoken: false, code: 'voice-session-active' },
			});
		});

		it('notify_speak reports a bad request as success: false', async () => {
			vi.mocked(speakNoticeRequest).mockRejectedValueOnce(new Error('Text to speak is required.'));
			handler.handleMessage(client, { type: 'notify_speak', requestId: 'sp3' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('notify_speak_result'));
			expect(lastResponse()).toMatchObject({
				success: false,
				error: 'Text to speak is required.',
			});
		});

		it('local_models_task_readiness passes the task id through and returns the verdicts', async () => {
			handler.handleMessage(client, {
				type: 'local_models_task_readiness',
				requestId: 'q1',
				taskId: 'injection-screen',
			});
			await vi.waitFor(() =>
				expect(lastResponse().type).toBe('local_models_task_readiness_result')
			);
			expect(resolveTaskReadinessRequest).toHaveBeenCalledWith('injection-screen');
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'q1',
				readiness: [{ taskId: 'injection-screen', state: 'unavailable' }],
			});
		});

		it('local_models_tab_cleanup answers with the suggestions and takes nothing from the message', async () => {
			handler.handleMessage(client, {
				type: 'local_models_tab_cleanup',
				requestId: 'tc-1',
				sessions: [],
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_tab_cleanup_result'));
			expect(suggestTabCleanup).toHaveBeenCalledWith();
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'tc-1',
				result: {
					success: true,
					considered: 3,
					suggestions: [{ tabId: 'tab-1', agentId: 'agent-1', action: 'close' }],
				},
			});
		});

		it('local_models_tab_cleanup carries a task that is off as a successful round trip', async () => {
			vi.mocked(suggestTabCleanup).mockResolvedValueOnce({
				success: false,
				status: 'off',
				error: 'Tab cleanup suggestions is off.',
			});
			handler.handleMessage(client, { type: 'local_models_tab_cleanup', requestId: 'tc-2' });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('tc-2'));
			expect(lastResponse()).toMatchObject({
				type: 'local_models_tab_cleanup_result',
				success: true,
				result: { success: false, status: 'off' },
			});
		});

		it('local_models_semantic_index_status answers with the indexer record', async () => {
			handler.handleMessage(client, {
				type: 'local_models_semantic_index_status',
				requestId: 'si-1',
			});
			await vi.waitFor(() =>
				expect(lastResponse().type).toBe('local_models_semantic_index_status_result')
			);
			expect(semanticIndexProgress).toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'si-1',
				progress: {
					state: 'indexing',
					indexed: 3,
					total: 10,
					bySourceType: { history: { indexed: 3, total: 8 } },
					modelId: 'local:bge-small-en-v1.5',
				},
			});
		});

		it('local_models_semantic_index_status reports a failed read as success: false', async () => {
			vi.mocked(semanticIndexProgress).mockImplementationOnce(() => {
				throw new Error('indexer exploded');
			});
			handler.handleMessage(client, {
				type: 'local_models_semantic_index_status',
				requestId: 'si-2',
			});
			await vi.waitFor(() =>
				expect(lastResponse().type).toBe('local_models_semantic_index_status_result')
			);
			expect(lastResponse()).toMatchObject({ success: false, error: 'indexer exploded' });
		});

		it('local_models_proxy_status answers with the proxy report', async () => {
			handler.handleMessage(client, { type: 'local_models_proxy_status', requestId: 'px-1' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_proxy_status_result'));
			expect(getTokenProxyReport).toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'px-1',
				report: {
					status: { port: 48123, running: true },
					agents: [{ id: 'a', mode: 'compress' }],
				},
			});
		});

		it('local_models_proxy_status reports a failed read as success: false', async () => {
			vi.mocked(getTokenProxyReport).mockRejectedValueOnce(new Error('state file unreadable'));
			handler.handleMessage(client, { type: 'local_models_proxy_status', requestId: 'px-2' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_proxy_status_result'));
			expect(lastResponse()).toMatchObject({ success: false, error: 'state file unreadable' });
		});

		it('local_models_server_status answers with the model server report', async () => {
			handler.handleMessage(client, { type: 'local_models_server_status', requestId: 'ms-1' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_server_status_result'));
			expect(getModelServerReport).toHaveBeenCalled();
			expect(startModelServer).not.toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'ms-1',
				report: { status: { state: 'running', baseUrl: 'http://127.0.0.1:47811' } },
			});
		});

		it('local_models_server_start and _stop call the supervisor and answer with the report', async () => {
			handler.handleMessage(client, { type: 'local_models_server_start', requestId: 'ms-2' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_server_start_result'));
			expect(startModelServer).toHaveBeenCalledTimes(1);
			expect(lastResponse()).toMatchObject({
				success: true,
				report: { status: { state: 'running' } },
			});

			handler.handleMessage(client, { type: 'local_models_server_stop', requestId: 'ms-3' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_server_stop_result'));
			expect(stopModelServer).toHaveBeenCalledTimes(1);
		});

		it('local_models_server_start reports a failed start with its reason', async () => {
			vi.mocked(startModelServer).mockRejectedValueOnce(
				new Error('Another program is using 127.0.0.1:47811.')
			);
			handler.handleMessage(client, { type: 'local_models_server_start', requestId: 'ms-4' });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('ms-4'));
			expect(lastResponse()).toMatchObject({
				success: false,
				error: 'Another program is using 127.0.0.1:47811.',
			});
		});

		it('local_models_server_set applies the settings, then the build', async () => {
			const order: string[] = [];
			vi.mocked(updateModelServerConfigRequest).mockImplementationOnce(async () => {
				order.push('settings');
				return { state: 'running' } as never;
			});
			vi.mocked(installModelServerEngine).mockImplementationOnce(async () => {
				order.push('build');
				return {} as never;
			});
			handler.handleMessage(client, {
				type: 'local_models_server_set',
				bind: 'network',
				maxModels: 2,
				rotateKey: true,
				build: 'cpu',
				requestId: 'ms-5',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('ms-5'));
			expect(updateModelServerConfigRequest).toHaveBeenCalledWith({
				bind: 'network',
				maxModels: 2,
				rotateKey: true,
			});
			expect(installModelServerEngine).toHaveBeenCalledWith('cpu');
			expect(order).toEqual(['settings', 'build']);
			expect(lastResponse()).toMatchObject({ success: true });
		});

		it('local_models_server_set with only a build leaves the settings alone', async () => {
			// The previous case called it once, and this file does not reset mocks between cases.
			vi.mocked(updateModelServerConfigRequest).mockClear();
			handler.handleMessage(client, {
				type: 'local_models_server_set',
				build: 'default',
				requestId: 'ms-6',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('ms-6'));
			expect(updateModelServerConfigRequest).not.toHaveBeenCalled();
			expect(installModelServerEngine).toHaveBeenCalledWith('default');
		});

		it('local_models_server_key answers with the key', async () => {
			handler.handleMessage(client, { type: 'local_models_server_key', requestId: 'ms-7' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_server_key_result'));
			expect(getModelServerKey).toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({ success: true, key: 'sk-maestro-key' });
		});

		it('local_models_server_ensure makes the server ready and answers with its address and key', async () => {
			handler.handleMessage(client, {
				type: 'local_models_server_ensure',
				model: ' gpt-oss-20b ',
				requestId: 'ms-8',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_server_ensure_result'));
			expect(modelServerForHarness).toHaveBeenCalledWith('gpt-oss-20b');
			expect(lastResponse()).toMatchObject({
				success: true,
				baseUrl: 'http://127.0.0.1:47811',
				key: 'sk-maestro-key',
			});
		});

		it('local_models_server_ensure answers with the reason when the server cannot serve the model', async () => {
			vi.mocked(modelServerForHarness).mockResolvedValueOnce({
				ok: false,
				error: 'gpt-oss 20B is not downloaded.',
			});
			handler.handleMessage(client, {
				type: 'local_models_server_ensure',
				model: 'gpt-oss-20b',
				requestId: 'ms-9',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('ms-9'));
			expect(lastResponse()).toMatchObject({
				success: false,
				error: 'gpt-oss 20B is not downloaded.',
			});
			// A refusal carries no address and no key.
			expect(lastResponse()).not.toHaveProperty('key');
		});

		it('local_models_server_ensure refuses a request that names no model', async () => {
			vi.mocked(modelServerForHarness).mockClear();
			handler.handleMessage(client, { type: 'local_models_server_ensure', requestId: 'ms-10' });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('ms-10'));
			expect(lastResponse()).toMatchObject({ success: false });
			expect(modelServerForHarness).not.toHaveBeenCalled();
		});

		it('local_models_run_on_test tests the stored agent and answers with the verdict', async () => {
			handler.handleMessage(client, {
				type: 'local_models_run_on_test',
				agentId: ' agent-1 ',
				// Only the agent's id crosses the bridge: a caller cannot hand the
				// test a command, a directory or a target of its own.
				target: { type: 'source', endpointId: 'ep-other', model: 'm' },
				subject: { customPath: '/tmp/evil' },
				requestId: 'ro-1',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_run_on_test_result'));
			expect(testAgentRunOn).toHaveBeenCalledWith({ agentId: 'agent-1' });
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'ro-1',
				result: { ok: true, model: 'qwen3:latest', reply: 'ready' },
			});
		});

		it('local_models_run_on_test carries a refusal as a successful round trip', async () => {
			vi.mocked(testAgentRunOn).mockResolvedValueOnce({
				ok: false,
				code: 'run-on-source-disabled',
				message: 'The source "Ollama" is disabled.',
			});
			handler.handleMessage(client, {
				type: 'local_models_run_on_test',
				agentId: 'agent-1',
				requestId: 'ro-2',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('ro-2'));
			expect(lastResponse()).toMatchObject({
				success: true,
				result: { ok: false, code: 'run-on-source-disabled' },
			});
		});

		it('local_models_run_on_test refuses a request that names no agent', async () => {
			vi.mocked(testAgentRunOn).mockClear();
			handler.handleMessage(client, { type: 'local_models_run_on_test', requestId: 'ro-3' });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('ro-3'));
			expect(lastResponse()).toMatchObject({ success: false });
			expect(testAgentRunOn).not.toHaveBeenCalled();
		});

		it('system_one_status answers with the report, and asks the engine nothing', async () => {
			handler.handleMessage(client, { type: 'system_one_status', requestId: 's1-1' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('system_one_status_result'));
			expect(getSystemOneReport).toHaveBeenCalled();
			expect(testSystemOne).not.toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 's1-1',
				report: { engineLabel: 'Jev (TypeSafe cloud)' },
			});
		});

		it('system_one_set hands the patch to the service, and reports a refusal with its reason', async () => {
			const patch = { engine: 'openjev', openJevUrl: 'https://gpu.lan:8000' };
			handler.handleMessage(client, { type: 'system_one_set', patch, requestId: 's1-2' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('system_one_set_result'));
			expect(updateSystemOneSettingsRequest).toHaveBeenCalledWith(patch);
			expect(lastResponse()).toMatchObject({ success: true, requestId: 's1-2' });

			vi.mocked(updateSystemOneSettingsRequest).mockRejectedValueOnce(
				new Error('"gpt" is not an engine.')
			);
			handler.handleMessage(client, {
				type: 'system_one_set',
				patch: { engine: 'gpt' },
				requestId: 's1-3',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('s1-3'));
			expect(lastResponse()).toMatchObject({ success: false, error: '"gpt" is not an engine.' });
		});

		it('system_one_key_set stores the key and never sends it back', async () => {
			const key = 'sk-bridge-test-0123456789abcdef';
			handler.handleMessage(client, {
				type: 'system_one_key_set',
				engine: 'jev-cloud',
				key,
				requestId: 's1-4',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('system_one_key_set_result'));
			expect(setSystemOneKeyRequest).toHaveBeenCalledWith({ engine: 'jev-cloud', key });
			expect(JSON.stringify(lastResponse())).not.toContain(key);
		});

		it('system_one_key_clear forgets the key of the engine named, or of the one in force', async () => {
			handler.handleMessage(client, { type: 'system_one_key_clear', requestId: 's1-5' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('system_one_key_clear_result'));
			expect(clearSystemOneKeyRequest).toHaveBeenCalledWith({ engine: undefined });

			handler.handleMessage(client, {
				type: 'system_one_key_clear',
				engine: 'openjev',
				requestId: 's1-6',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('s1-6'));
			expect(clearSystemOneKeyRequest).toHaveBeenLastCalledWith({ engine: 'openjev' });
		});

		it('system_one_test answers with the verdict, a failed one included', async () => {
			handler.handleMessage(client, { type: 'system_one_test', requestId: 's1-7' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('system_one_test_result'));
			expect(lastResponse()).toMatchObject({ success: true, result: { ok: true, latencyMs: 212 } });

			vi.mocked(testSystemOne).mockResolvedValueOnce({
				ok: false,
				engine: 'jev-cloud',
				engineLabel: 'Jev (TypeSafe cloud)',
				code: 'timeout',
				error: 'Jev (TypeSafe cloud) did not answer within 1500 ms.',
			});
			handler.handleMessage(client, { type: 'system_one_test', requestId: 's1-8' });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('s1-8'));
			expect(lastResponse()).toMatchObject({
				success: true,
				result: { ok: false, code: 'timeout' },
			});
		});

		it('system_one_ledger answers with the page for the query, and reports a bad query', async () => {
			const query = { taskId: 'cue-gate', outcome: 'timeout', limit: 10 };
			handler.handleMessage(client, { type: 'system_one_ledger', query, requestId: 's1-9' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('system_one_ledger_result'));
			expect(readSystemOneLedger).toHaveBeenLastCalledWith(query);
			expect(lastResponse()).toMatchObject({
				success: true,
				page: { total: 1, entries: [{ id: 'decision-1', code: 'timeout' }] },
			});

			vi.mocked(readSystemOneLedger).mockImplementationOnce(() => {
				throw new Error('"sideways" is not an outcome.');
			});
			handler.handleMessage(client, {
				type: 'system_one_ledger',
				query: { outcome: 'sideways' },
				requestId: 's1-10',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('s1-10'));
			expect(lastResponse()).toMatchObject({
				success: false,
				error: '"sideways" is not an outcome.',
			});
		});

		it('system_one_agent_request hands the request and the caller to the service, and answers with its response', async () => {
			const request = { kind: 'ask', verb: 'yes', state: 'The build is red.', questions: {} };
			handler.handleMessage(client, {
				type: 'system_one_agent_request',
				request,
				fromSessionId: 'agent-1',
				fromTabId: 'tab-7',
				// A caller cannot name the key, the engine or the budget: none of these is read.
				apiKey: 'sk-mine',
				engine: 'openjev',
				requestId: 's1-agent-1',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('system_one_agent_result'));

			expect(runAgentSystemOneRequest).toHaveBeenLastCalledWith(request, {
				agentId: 'agent-1',
				tabId: 'tab-7',
			});
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 's1-agent-1',
				response: { ok: true, engine: 'jev-cloud', calibrated: true, cached: false },
			});
		});

		it('system_one_agent_request passes on a caller with no tab, and one that names nobody', async () => {
			handler.handleMessage(client, {
				type: 'system_one_agent_request',
				request: { kind: 'rank' },
				fromSessionId: '  agent-2  ',
				requestId: 's1-agent-2',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('s1-agent-2'));
			expect(runAgentSystemOneRequest).toHaveBeenLastCalledWith(
				{ kind: 'rank' },
				{ agentId: 'agent-2' }
			);

			handler.handleMessage(client, {
				type: 'system_one_agent_request',
				request: { kind: 'batch' },
				// A tab with no agent names nobody.
				fromTabId: 'tab-9',
				requestId: 's1-agent-3',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('s1-agent-3'));
			expect(runAgentSystemOneRequest).toHaveBeenLastCalledWith({ kind: 'batch' }, undefined);
		});

		it('system_one_usage hands the query and the caller to the service, and reports a bad query', async () => {
			const query = { agentId: 'agent-2', since: 1_800_000_000_000 };
			handler.handleMessage(client, {
				type: 'system_one_usage',
				query,
				fromSessionId: ' agent-1 ',
				requestId: 's1-usage-1',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('system_one_usage_result'));

			expect(readSystemOneAgentUsage).toHaveBeenLastCalledWith(query, 'agent-1');
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 's1-usage-1',
				report: { retentionDays: 30, engine: 'jev-cloud', rows: [] },
			});

			// A caller that names nobody: a person at a terminal.
			handler.handleMessage(client, { type: 'system_one_usage', requestId: 's1-usage-2' });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('s1-usage-2'));
			expect(readSystemOneAgentUsage).toHaveBeenLastCalledWith(undefined, undefined);

			vi.mocked(readSystemOneAgentUsage).mockRejectedValueOnce(
				new Error('since is a time in epoch milliseconds.')
			);
			handler.handleMessage(client, {
				type: 'system_one_usage',
				query: { since: 'yesterday' },
				requestId: 's1-usage-3',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('s1-usage-3'));
			expect(lastResponse()).toMatchObject({
				success: false,
				error: 'since is a time in epoch milliseconds.',
			});
		});

		it('system_one_access asks the service about the agent that was named, and answers with what it says', async () => {
			handler.handleMessage(client, {
				type: 'system_one_access',
				agentId: 'agent-7',
				requestId: 's1-access-1',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('system_one_access_result'));

			// The agent asked ABOUT, not the caller: the CLI builds a prompt for the agent it spawns.
			expect(getSystemOneAgentAccessRequest).toHaveBeenLastCalledWith('agent-7');
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 's1-access-1',
				access: { allowed: true, gate: null, engine: 'jev-cloud', calibrated: true },
			});

			// A refusal is an answer, not a failed round trip: the builder reads the gate.
			vi.mocked(getSystemOneAgentAccessRequest).mockResolvedValueOnce({
				allowed: false,
				gate: 'agents-off',
				message: 'System One is off for agents. Continue without System One.',
				engine: 'jev-cloud',
				engineLabel: 'Jev (TypeSafe cloud)',
				calibrated: true,
				budget: { dayStartedAt: 0, dailyBudgetUsd: 1, spentTodayUsd: 0, remainingTodayUsd: 1 },
			});
			handler.handleMessage(client, { type: 'system_one_access', requestId: 's1-access-2' });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('s1-access-2'));
			expect(getSystemOneAgentAccessRequest).toHaveBeenLastCalledWith(undefined);
			expect(lastResponse()).toMatchObject({
				success: true,
				access: { allowed: false, gate: 'agents-off' },
			});

			vi.mocked(getSystemOneAgentAccessRequest).mockRejectedValueOnce(
				new Error('settings unreadable')
			);
			handler.handleMessage(client, { type: 'system_one_access', requestId: 's1-access-3' });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('s1-access-3'));
			expect(lastResponse()).toMatchObject({ success: false, error: 'settings unreadable' });
		});

		it('model_route_turn routes the turn the request names, and carries no decision as an answer', async () => {
			const request = { prompt: 'rename the helper', agentId: 'agent-7', timeoutMs: 5000 };
			handler.handleMessage(client, {
				type: 'model_route_turn',
				request,
				// The caller is another agent: the turn being routed is agent-7's, not its own.
				fromSessionId: 'agent-caller',
				requestId: 'route-1',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('model_route_turn_result'));

			expect(routeTurnRequest).toHaveBeenLastCalledWith(request);
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'route-1',
				result: { tier: 'medium', effort: 'low', engine: { id: 'embedding-router' } },
			});

			// Off, slow or down is a result the caller resolves to the agent's default.
			vi.mocked(routeTurnRequest).mockResolvedValueOnce({
				skipped: 'off',
				detail: 'Model routing is off.',
				latencyMs: 0,
			});
			handler.handleMessage(client, { type: 'model_route_turn', request, requestId: 'route-2' });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('route-2'));
			expect(lastResponse()).toMatchObject({ success: true, result: { skipped: 'off' } });

			// Only a request that cannot be read is a failed round trip.
			vi.mocked(routeTurnRequest).mockRejectedValueOnce(
				new Error("A routing request's prompt is text.")
			);
			handler.handleMessage(client, { type: 'model_route_turn', requestId: 'route-3' });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('route-3'));
			expect(lastResponse()).toMatchObject({
				success: false,
				error: "A routing request's prompt is text.",
			});
		});

		it('get_model_usage answers with the record for the range, and carries a failure under its own type', async () => {
			handler.handleMessage(client, {
				type: 'get_model_usage',
				range: 'month',
				requestId: 'usage-1',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('model_usage'));

			expect(readModelUsage).toHaveBeenLastCalledWith('month');
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'usage-1',
				data: { range: 'month', sources: [] },
			});

			// No range is the service's to default, not the handler's.
			handler.handleMessage(client, { type: 'get_model_usage', requestId: 'usage-2' });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('usage-2'));
			expect(readModelUsage).toHaveBeenLastCalledWith(undefined);

			// A refused range answers as `model_usage` with the request's id: an
			// `error` message carries no id and the CLI would wait out its timeout.
			vi.mocked(readModelUsage).mockRejectedValueOnce(
				new Error('Invalid range. Must be one of: day, week, month, quarter, year, all')
			);
			handler.handleMessage(client, {
				type: 'get_model_usage',
				range: 'fortnight',
				requestId: 'usage-3',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('usage-3'));
			expect(lastResponse()).toMatchObject({
				type: 'model_usage',
				success: false,
				error: 'Invalid range. Must be one of: day, week, month, quarter, year, all',
			});
		});

		it('model_route_correct records the correction the request names, and carries a refusal as an answer', async () => {
			const request = { prompt: 'rename the helper', tier: 'high' };
			const routedBefore = vi.mocked(routeTurnRequest).mock.calls.length;
			handler.handleMessage(client, {
				type: 'model_route_correct',
				request,
				requestId: 'correct-1',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('model_route_correct_result'));

			expect(recordModelRoutingCorrectionRequest).toHaveBeenLastCalledWith(request);
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'correct-1',
				result: { ok: true, replaced: false, total: 1 },
			});
			// A correction is not a routing: the router is not asked.
			expect(routeTurnRequest).toHaveBeenCalledTimes(routedBefore);

			// A correction the store refuses is a result with the reason in it.
			vi.mocked(recordModelRoutingCorrectionRequest).mockResolvedValueOnce({
				ok: false,
				message: 'There is no prompt to record a correction for.',
			});
			handler.handleMessage(client, {
				type: 'model_route_correct',
				request: { prompt: '  ', tier: 'low' },
				requestId: 'correct-2',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('correct-2'));
			expect(lastResponse()).toMatchObject({
				type: 'model_route_correct_result',
				success: true,
				result: { ok: false, message: 'There is no prompt to record a correction for.' },
			});

			// Only a request that cannot be read is a failed round trip.
			vi.mocked(recordModelRoutingCorrectionRequest).mockRejectedValueOnce(
				new Error("A routing correction's tier is one of low, medium, high.")
			);
			handler.handleMessage(client, { type: 'model_route_correct', requestId: 'correct-3' });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('correct-3'));
			expect(recordModelRoutingCorrectionRequest).toHaveBeenLastCalledWith(undefined);
			expect(lastResponse()).toMatchObject({
				type: 'model_route_correct_result',
				success: false,
				error: "A routing correction's tier is one of low, medium, high.",
			});
		});

		it('system_one_agent_request carries a refusal as a successful round trip, and a bug as a failed one', async () => {
			vi.mocked(runAgentSystemOneRequest).mockResolvedValueOnce({
				ok: false,
				code: 'budget',
				gate: 'budget-day',
				message: "System One's budget for today is spent. Continue without System One.",
			});
			handler.handleMessage(client, {
				type: 'system_one_agent_request',
				request: {},
				requestId: 's1-agent-4',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('s1-agent-4'));
			expect(lastResponse()).toMatchObject({
				success: true,
				response: { ok: false, code: 'budget', gate: 'budget-day' },
			});

			vi.mocked(runAgentSystemOneRequest).mockRejectedValueOnce(new Error('engine bug'));
			handler.handleMessage(client, {
				type: 'system_one_agent_request',
				request: {},
				requestId: 's1-agent-5',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('s1-agent-5'));
			expect(lastResponse()).toMatchObject({ success: false, error: 'engine bug' });
		});

		it('local_models_tier_options answers with what the harness can launch a tier on', async () => {
			handler.handleMessage(client, {
				type: 'local_models_tier_options',
				harness: 'codex',
				refresh: true,
				// Only the harness and the refresh flag are read.
				catalog: [{ id: 'made-up' }],
				requestId: 'to-1',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_tier_options_result'));
			expect(listHarnessTierOptionsRequest).toHaveBeenCalledWith({
				harness: 'codex',
				refresh: true,
			});
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'to-1',
				options: [{ harness: 'codex', catalog: [{ id: 'gpt-6-luna', priority: 4 }] }],
			});
		});

		it('local_models_tier_options answers a harness with no tiers as an error', async () => {
			vi.mocked(listHarnessTierOptionsRequest).mockRejectedValueOnce(
				new Error('Unknown harness "nope".')
			);
			handler.handleMessage(client, {
				type: 'local_models_tier_options',
				harness: 'nope',
				requestId: 'to-2',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('to-2'));
			expect(lastResponse()).toMatchObject({ success: false, error: 'Unknown harness "nope".' });
		});

		it('local_models_proxy_block answers with both sides of the block', async () => {
			const hash = 'a'.repeat(64);
			handler.handleMessage(client, { type: 'local_models_proxy_block', hash, requestId: 'pb-1' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_proxy_block_result'));
			expect(readTokenProxyBlock).toHaveBeenCalledWith(hash);
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'pb-1',
				block: { hash, original: 'long', compressed: 'short' },
			});
		});

		it('local_models_proxy_block answers null for a block the cache does not hold, and an error for a value that is not a hash', async () => {
			vi.mocked(readTokenProxyBlock).mockResolvedValueOnce(null);
			handler.handleMessage(client, {
				type: 'local_models_proxy_block',
				hash: 'b'.repeat(64),
				requestId: 'pb-2',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('pb-2'));
			expect(lastResponse()).toMatchObject({ success: true, block: null });

			vi.mocked(readTokenProxyBlock).mockRejectedValueOnce(
				new Error('A compressed block is named by its SHA-256 hash')
			);
			handler.handleMessage(client, {
				type: 'local_models_proxy_block',
				hash: '../x',
				requestId: 'pb-3',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('pb-3'));
			expect(lastResponse()).toMatchObject({
				success: false,
				error: 'A compressed block is named by its SHA-256 hash',
			});
		});

		it('local_models_search passes the request through and answers with the verdict', async () => {
			const request = { query: 'retry logic', mode: 'semantic', limit: 5 };
			handler.handleMessage(client, { type: 'local_models_search', request, requestId: 's1' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_search_result'));
			expect(searchPastWorkRequest).toHaveBeenCalledWith(request);
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 's1',
				result: { status: 'ok', mode: 'semantic', hits: [{ sourceId: 'e1', score: 0.8 }] },
			});
		});

		it('local_models_search reports a refused request as success: false', async () => {
			vi.mocked(searchPastWorkRequest).mockRejectedValueOnce(new Error('A search needs a query.'));
			handler.handleMessage(client, { type: 'local_models_search', requestId: 's2' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_search_result'));
			expect(lastResponse()).toMatchObject({ success: false, error: 'A search needs a query.' });
		});

		it('local_models_list answers with the listings and the footprint', async () => {
			handler.handleMessage(client, { type: 'local_models_list', requestId: 'l1' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_list_result'));
			expect(listLocalModels).toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'l1',
				listings: [{ entry: { id: 'bge-small-en-v1.5' } }],
				footprint: { bytes: 42 },
			});
		});

		it('local_models_list reads the hardware only when the fit was asked for', async () => {
			vi.mocked(resolveHardwareProfile).mockClear();
			vi.mocked(addHuggingFaceModel).mockClear();
			vi.mocked(previewHuggingFaceModel).mockClear();
			handler.handleMessage(client, { type: 'local_models_list', requestId: 'l2' });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('l2'));
			expect(resolveHardwareProfile).not.toHaveBeenCalled();
			expect(lastResponse().hardware).toBeUndefined();

			handler.handleMessage(client, { type: 'local_models_list', requestId: 'l3', fit: true });
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('l3'));
			expect(lastResponse()).toMatchObject({
				success: true,
				hardware: { unifiedMemory: true, totalMemoryBytes: 16 * 1024 ** 3 },
			});
		});

		it('local_models_hf_add adds the repo file and answers with its entry', async () => {
			vi.mocked(resolveHardwareProfile).mockClear();
			vi.mocked(addHuggingFaceModel).mockClear();
			vi.mocked(previewHuggingFaceModel).mockClear();
			handler.handleMessage(client, {
				type: 'local_models_hf_add',
				requestId: 'hf1',
				repo: 'owner/repo',
				file: 'model.gguf',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_hf_add_result'));
			expect(addHuggingFaceModel).toHaveBeenCalledWith('owner/repo', 'model.gguf');
			expect(previewHuggingFaceModel).not.toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'hf1',
				added: true,
				entry: { id: 'hf-owner-model' },
			});
		});

		it('local_models_hf_add with dryRun describes the model and saves nothing', async () => {
			vi.mocked(resolveHardwareProfile).mockClear();
			vi.mocked(addHuggingFaceModel).mockClear();
			vi.mocked(previewHuggingFaceModel).mockClear();
			handler.handleMessage(client, {
				type: 'local_models_hf_add',
				requestId: 'hf2',
				repo: 'owner/repo',
				file: 'model.gguf',
				dryRun: true,
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('hf2'));
			expect(previewHuggingFaceModel).toHaveBeenCalledWith('owner/repo', 'model.gguf');
			expect(addHuggingFaceModel).not.toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({ success: true, added: false, dryRun: true });
		});

		it('local_models_hf_add reports a refusal as success: false with its message', async () => {
			vi.mocked(addHuggingFaceModel).mockResolvedValueOnce({
				ok: false,
				message: 'owner/repo is gated on Hugging Face.',
			});
			handler.handleMessage(client, {
				type: 'local_models_hf_add',
				requestId: 'hf3',
				repo: 'owner/repo',
				file: 'model.gguf',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('hf3'));
			expect(lastResponse()).toMatchObject({
				success: false,
				error: 'owner/repo is gated on Hugging Face.',
			});
		});

		it('local_models_hf_remove answers with the bytes reclaimed, or the refusal', async () => {
			handler.handleMessage(client, {
				type: 'local_models_hf_remove',
				requestId: 'hf4',
				modelId: 'hf-owner-model',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_hf_remove_result'));
			expect(removeUserLocalModel).toHaveBeenCalledWith('hf-owner-model');
			expect(lastResponse()).toMatchObject({
				success: true,
				id: 'hf-owner-model',
				displayName: 'model',
				bytes: 512,
			});

			vi.mocked(removeUserLocalModel).mockResolvedValueOnce({
				ok: false,
				message: 'No model you added has the id "x".',
			});
			handler.handleMessage(client, {
				type: 'local_models_hf_remove',
				requestId: 'hf5',
				modelId: 'x',
			});
			await vi.waitFor(() => expect(lastResponse().requestId).toBe('hf5'));
			expect(lastResponse()).toMatchObject({
				success: false,
				error: 'No model you added has the id "x".',
			});
		});

		it('local_models_download passes the model id through and returns the result', async () => {
			handler.handleMessage(client, {
				type: 'local_models_download',
				requestId: 'dl1',
				modelId: 'bge-small-en-v1.5',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_download_result'));
			// The model AND its engine: the same call the Settings button makes.
			expect(installLocalModel).toHaveBeenCalledWith('bge-small-en-v1.5');
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'dl1',
				result: { status: 'complete', runtime: { runtimeId: 'onnx', status: 'installed' } },
			});
		});

		it('local_models_runtimes_list returns every engine', async () => {
			handler.handleMessage(client, { type: 'local_models_runtimes_list', requestId: 'rl1' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_runtimes_list_result'));
			expect(listLocalRuntimes).toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'rl1',
				runtimes: [{ id: 'llama', installed: true }],
			});
		});

		it('local_models_runtime_install installs one engine and answers with its listing', async () => {
			handler.handleMessage(client, {
				type: 'local_models_runtime_install',
				requestId: 'ri1',
				runtimeId: 'llama',
			});
			await vi.waitFor(() =>
				expect(lastResponse().type).toBe('local_models_runtime_install_result')
			);
			expect(installLocalRuntime).toHaveBeenCalledWith('llama');
			expect(lastResponse()).toMatchObject({
				success: true,
				requestId: 'ri1',
				runtime: { id: 'llama', installed: true },
			});
		});

		it('local_models_runtime_install reports a refused install as a failure', async () => {
			vi.mocked(installLocalRuntime).mockRejectedValueOnce(new Error('UnknownLocalRuntime'));
			handler.handleMessage(client, {
				type: 'local_models_runtime_install',
				requestId: 'ri2',
				runtimeId: 'nope',
			});
			await vi.waitFor(() =>
				expect(lastResponse().type).toBe('local_models_runtime_install_result')
			);
			expect(lastResponse()).toMatchObject({
				success: false,
				requestId: 'ri2',
				error: 'UnknownLocalRuntime',
			});
		});

		it('local_models_pause passes the model id through and says whether it paused', async () => {
			handler.handleMessage(client, {
				type: 'local_models_pause',
				requestId: 'p1',
				modelId: 'bge-small-en-v1.5',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_pause_result'));
			expect(pauseLocalModel).toHaveBeenCalledWith('bge-small-en-v1.5');
			expect(lastResponse()).toMatchObject({ success: true, requestId: 'p1', paused: true });
		});

		it('local_models_pause reports an unknown model as success: false', async () => {
			vi.mocked(pauseLocalModel).mockImplementationOnce(() => {
				throw new Error('UnknownLocalModel: nope');
			});
			handler.handleMessage(client, {
				type: 'local_models_pause',
				requestId: 'p2',
				modelId: 'nope',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_pause_result'));
			expect(lastResponse()).toMatchObject({ success: false, error: 'UnknownLocalModel: nope' });
		});

		it('local_models_cancel passes the model id through and says whether a job ran', async () => {
			handler.handleMessage(client, {
				type: 'local_models_cancel',
				requestId: 'c1',
				modelId: 'bge-small-en-v1.5',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_cancel_result'));
			expect(cancelLocalModel).toHaveBeenCalledWith('bge-small-en-v1.5');
			expect(lastResponse()).toMatchObject({ success: true, requestId: 'c1', cancelled: false });
		});

		it('local_models_verify passes the model id through and returns the verdict', async () => {
			handler.handleMessage(client, {
				type: 'local_models_verify',
				requestId: 'v1',
				modelId: 'bge-small-en-v1.5',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_verify_result'));
			expect(verifyLocalModel).toHaveBeenCalledWith('bge-small-en-v1.5');
			expect(lastResponse()).toMatchObject({ success: true, result: { ok: true } });
		});

		it('local_models_remove answers with the bytes reclaimed', async () => {
			handler.handleMessage(client, {
				type: 'local_models_remove',
				requestId: 'rm1',
				modelId: 'bge-small-en-v1.5',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_remove_result'));
			expect(removeLocalModel).toHaveBeenCalledWith('bge-small-en-v1.5');
			expect(lastResponse()).toMatchObject({ success: true, requestId: 'rm1', bytes: 2048 });
		});

		it('local_models_remove reports an unknown model as success: false', async () => {
			vi.mocked(removeLocalModel).mockRejectedValueOnce(new Error('UnknownLocalModel'));
			handler.handleMessage(client, {
				type: 'local_models_remove',
				requestId: 'rm2',
				modelId: 'nope',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('local_models_remove_result'));
			expect(lastResponse()).toMatchObject({ success: false, error: 'UnknownLocalModel' });
		});

		it('local_models_task_readiness reports an unknown task as success: false', async () => {
			vi.mocked(resolveTaskReadinessRequest).mockRejectedValueOnce(new Error('Unknown task "x".'));
			handler.handleMessage(client, {
				type: 'local_models_task_readiness',
				requestId: 'q2',
				taskId: 'x',
			});
			await vi.waitFor(() =>
				expect(lastResponse().type).toBe('local_models_task_readiness_result')
			);
			expect(lastResponse()).toMatchObject({ success: false, error: 'Unknown task "x".' });
		});
	});

	describe('Feedback and support package (maestro-cli feedback / support-package)', () => {
		const lastResponse = () => {
			const calls = (client.socket.send as any).mock.calls;
			return JSON.parse(calls[calls.length - 1][0]);
		};

		it('support_package_create writes into an absolute dir with only the section toggles', async () => {
			handler.handleMessage(client, {
				type: 'support_package_create',
				requestId: 'sp-1',
				outputDir: '/tmp/out',
				options: { includeLogs: false, evil: 'x' },
			});
			await vi.waitFor(() => expect(generateDebugPackage).toHaveBeenCalled());
			expect(vi.mocked(generateDebugPackage).mock.calls[0][0]).toBe('/tmp/out');
			expect(vi.mocked(generateDebugPackage).mock.calls[0][2]).toEqual({ includeLogs: false });
			await vi.waitFor(() => expect(lastResponse().type).toBe('support_package_create_result'));
			expect(lastResponse()).toMatchObject({
				success: true,
				path: '/tmp/p.zip',
				requestId: 'sp-1',
			});
		});

		it('support_package_create returns a secret-screen refusal and writes nothing', async () => {
			const secretFindings = [
				{ kind: 'slack-token', line: 12, preview: '••••••••wxyz', source: 'logs.json' },
			];
			vi.mocked(generateDebugPackage).mockResolvedValueOnce({
				success: false,
				error: 'Found 1 possible secret in the support package. Nothing was sent.',
				code: 'SECRETS_FOUND',
				secretFindings,
				filesIncluded: [],
				totalSizeBytes: 0,
			} as any);
			handler.handleMessage(client, {
				type: 'support_package_create',
				requestId: 'sp-secret',
				outputDir: '/tmp/out',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('support_package_create_result'));
			expect(lastResponse()).toMatchObject({
				success: false,
				code: 'SECRETS_FOUND',
				secretFindings,
				requestId: 'sp-secret',
			});
			expect(lastResponse().path).toBeUndefined();
		});

		it('support_package_create passes allowSecrets only for a literal true', async () => {
			vi.mocked(generateDebugPackage).mockClear();
			handler.handleMessage(client, {
				type: 'support_package_create',
				requestId: 'sp-allow',
				outputDir: '/tmp/out',
				options: { allowSecrets: true },
			});
			await vi.waitFor(() => expect(generateDebugPackage).toHaveBeenCalledTimes(1));
			expect(vi.mocked(generateDebugPackage).mock.calls[0][2]).toEqual({ allowSecrets: true });

			handler.handleMessage(client, {
				type: 'support_package_create',
				requestId: 'sp-allow-2',
				outputDir: '/tmp/out',
				options: { allowSecrets: 'yes' },
			});
			await vi.waitFor(() => expect(generateDebugPackage).toHaveBeenCalledTimes(2));
			expect(vi.mocked(generateDebugPackage).mock.calls[1][2]).toEqual({});
		});

		it('support_package_create refuses a relative outputDir', async () => {
			handler.handleMessage(client, {
				type: 'support_package_create',
				requestId: 'sp-2',
				outputDir: 'relative/dir',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('support_package_create_result'));
			expect(lastResponse().success).toBe(false);
		});

		it('feedback_search passes the query through', async () => {
			handler.handleMessage(client, { type: 'feedback_search', requestId: 'fs', query: 'tabs' });
			await vi.waitFor(() => expect(lastResponse().type).toBe('feedback_search_result'));
			expect(searchFeedbackIssues).toHaveBeenCalledWith({ query: 'tabs' });
			expect(lastResponse()).toMatchObject({ success: true, issues: [] });
		});

		it('feedback_submit hands the support-package collectors over only when asked', async () => {
			handler.handleMessage(client, {
				type: 'feedback_submit',
				requestId: 'sub',
				payload: { category: 'bug_report', includeDebugPackage: true },
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('feedback_submit_result'));
			expect(vi.mocked(submitFeedbackConversation).mock.calls[0][1]).toEqual({ settingsStore: {} });
			expect(lastResponse().issueUrl).toContain('/issues/1');
		});

		it('feedback_submit refuses more screenshots than the modal allows', async () => {
			handler.handleMessage(client, {
				type: 'feedback_submit',
				requestId: 'sub2',
				payload: {
					attachments: new Array(6).fill({ name: 'a', dataUrl: 'data:image/png;base64,' }),
				},
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('feedback_submit_result'));
			expect(lastResponse().success).toBe(false);
		});

		it('feedback_subscribe forwards the issue number and comment', async () => {
			handler.handleMessage(client, {
				type: 'feedback_subscribe',
				requestId: 'fsub',
				issueNumber: 42,
				comment: 'same here',
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('feedback_subscribe_result'));
			expect(subscribeFeedbackIssue).toHaveBeenCalledWith({
				issueNumber: 42,
				comment: 'same here',
				allowSecrets: false,
			});
		});

		it('feedback_subscribe forwards allowSecrets and returns a secret-screen refusal', async () => {
			const secretFindings = [{ kind: 'openai-key', line: 1, preview: '••••••••9xYz' }];
			vi.mocked(subscribeFeedbackIssue).mockResolvedValueOnce({
				success: false,
				error: 'Found 1 possible secret in the comment. Nothing was sent.',
				code: 'SECRETS_FOUND',
				secretFindings,
			} as any);
			handler.handleMessage(client, {
				type: 'feedback_subscribe',
				requestId: 'fsub-secret',
				issueNumber: 42,
				comment: 'my key is sk-...',
				allowSecrets: true,
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('feedback_subscribe_result'));
			expect(subscribeFeedbackIssue).toHaveBeenLastCalledWith({
				issueNumber: 42,
				comment: 'my key is sk-...',
				allowSecrets: true,
			});
			expect(lastResponse()).toMatchObject({ success: false, secretFindings });
		});

		it('feedback_submit returns a secret-screen refusal with its findings', async () => {
			const secretFindings = [
				{ kind: 'anthropic-key', line: 1, preview: '••••••••AbCd', source: 'Actual' },
			];
			vi.mocked(submitFeedbackConversation).mockResolvedValueOnce({
				success: false,
				error: 'Found 1 possible secret in the feedback. Nothing was sent.',
				code: 'SECRETS_FOUND',
				secretFindings,
			} as any);
			handler.handleMessage(client, {
				type: 'feedback_submit',
				requestId: 'sub-secret',
				payload: { category: 'bug_report' },
			});
			await vi.waitFor(() => expect(lastResponse().type).toBe('feedback_submit_result'));
			expect(lastResponse()).toMatchObject({
				success: false,
				code: 'SECRETS_FOUND',
				secretFindings,
			});
		});
	});
});
