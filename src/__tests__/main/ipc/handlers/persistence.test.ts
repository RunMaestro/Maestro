import type { PianolaQueueItem } from '../../../../shared/pianola/pianola-dispatch';
import { registerProcessHandlers } from '../../../../main/ipc/handlers/process';
import * as promptManager from '../../../../main/prompt-manager';
import { registerCrossAgentHandlers } from '../../../../main/ipc/handlers/cross-agent';
import { cancelCrossAgentRequestsForSource } from '../../../../main/cross-agent/cross-agent-router';
import {
	bindQueueConsultRelease,
	sweepQueueConsultReleases,
	startReleasedQueueConsult,
} from '../../../../main/pianola/pianola-queue-routing';
import * as systemPromptService from '../../../../main/utils/maestro-system-prompt';
import type { StartCrossAgentRequestOptions } from '../../../../main/cross-agent/cross-agent-router';
import Conf from 'conf';
import { createPluginSessionLifecycle } from '../../../../main/plugins/plugin-session-lifecycle';
import { pianolaPersistenceConsumer } from '../../../../main/ipc/bootstrap/pianola-persistence';
import { PianolaSupervisor } from '../../../../main/pianola/pianola-supervisor';
import { configurePianolaScope } from '../../../../main/pianola/pianola-legacy-migration';
import {
	pianolaScopeSnapshotFromDesktop,
	validatePianolaScopeDelivery,
	runPianolaScopeCycle,
	type PianolaScopeCycleDeps,
	type PianolaScopeSnapshot,
} from '../../../../shared/pianola/pianola-scope-cycle';
import { currentTurnMessages } from '../../../../shared/currentTurn';
vi.mock('../../../../main/cue/cue-cli-executor', () => ({
	resolveMaestroCliScriptPath: () => '/fixture/cli.js',
}));
import { pianolaWatchScope } from '../../../../cli/commands/pianola-scope-watch';
import { MaestroClient } from '../../../../cli/services/maestro-client';
import * as workerStore from '../../../../cli/services/pianola-store';
import * as cliStorage from '../../../../cli/services/storage';
import type { BridgeConnectionOptions } from '../../../../shared/maestro-lib/client/bridge-connection';
import { nativeCurrentTurns } from '../../../../main/pianola/current-turn';
import { registerSessionCallbacks } from '../../../../main/web-server/callbacks/sessionCallbacks';
import { handleGetSessionHistory } from '../../../../main/web-server/handlers/messageHandlers/sessions';
import { classifyMessages } from '../../../../shared/pianola/pianola-classifier';
import type { CurrentTurnRead } from '../../../../shared/currentTurn';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AgentRun } from '../../../../shared/agent-run';
import { handleEnqueueCommand } from '../../../../main/web-server/handlers/messageHandlers/queue';
import * as queueSupervision from '../../../../main/web-server/handlers/messageHandlers/dispatchSupervision';
import * as tabAdmission from '../../../../main/web-server/handlers/messageHandlers/tabs';
import type {
	MessageHandlerContext,
	WebClient,
} from '../../../../main/web-server/handlers/messageHandlers/types';
import { EventEmitter } from 'events';
import { DispatchCallbackRegistry } from '../../../../main/dispatch-callbacks/dispatch-callback-registry';
import { handleProcessSpawn } from '../../../../main/ipc/handlers/process/handle-spawn';
import { AgentRunCaptureService } from '../../../../main/agent-run/capture-service';
import { getAgentDefinition } from '../../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../../shared/maestro-lib/providers/capabilities';
import {
	pianolaNewTabSpawns,
	PianolaNewTabDispatch,
} from '../../../../main/pianola/pianola-new-tab-dispatch';
import { createPianolaFsStore } from '../../../../shared/pianola/fs-store';
import { generateUUID } from '../../../../shared/uuid';
import type { QueuedItem } from '../../../../renderer/types';
/**
 * Tests for the persistence IPC handlers
 *
 * These tests verify the settings, sessions, groups, and CLI activity
 * IPC handlers for application data persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, app, BrowserWindow } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
	configureImageStore,
	__resetImageStoreCacheForTests,
} from '../../../../main/storage/session-image-store';
import {
	registerPersistenceHandlers,
	SESSION_LIFECYCLE_SYNC_CHANNEL,
	PersistenceHandlerDependencies,
	PersistenceHandlers,
	MaestroSettings,
	SessionsData,
	GroupsData,
} from '../../../../main/ipc/handlers/persistence';
import type Store from 'electron-store';
import type { StoredSession } from '../../../../main/stores/types';
import { WebServer } from '../../../../main/web-server';
import { registerQueueCallbacks } from '../../../../main/web-server/callbacks/queueCallbacks';
import type { QueueItemReceiptRequest } from '../../../../main/stores/queue-item-receipt';
import { broadcastBridgeEvent } from '../../../../main/web-server/handlers/bridgeHandlers';

// Mock electron's ipcMain and app
vi.mock('electron', () => ({
	ipcMain: {
		on: vi.fn(),
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	app: {
		getPath: vi.fn().mockReturnValue('/mock/user/data'),
		on: vi.fn(),
	},
	// settings:set notifies peer windows so a renderer never gets its own write
	// echoed back as an external change (see notifyPeerWindows).
	BrowserWindow: {
		getAllWindows: vi.fn(() => []),
	},
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	access: vi.fn(),
	realpath: vi.fn(),
	stat: vi.fn(),
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// The lifecycle push fans out to web-desktop clients through the bridge; mock it
// so the tests can assert what peers were told without a live WebSocket server.
vi.mock('../../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
}));

const { backupSessionsBeforeWipeMock } = vi.hoisted(() => ({
	backupSessionsBeforeWipeMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../main/stores/sessions-backup', () => ({
	backupSessionsBeforeWipe: backupSessionsBeforeWipeMock,
}));
const { backupGroupsBeforeWipeMock } = vi.hoisted(() => ({
	backupGroupsBeforeWipeMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../main/stores/groups-backup', () => ({
	backupGroupsBeforeWipe: backupGroupsBeforeWipeMock,
}));

const { deleteJourneyMock } = vi.hoisted(() => ({
	deleteJourneyMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../main/user-journey-manager', () => ({
	deleteJourney: deleteJourneyMock,
}));

// Mock the themes module
vi.mock('../../../../main/themes', () => ({
	getThemeById: vi.fn().mockReturnValue({
		id: 'dark',
		name: 'Dark',
		colors: {},
	}),
}));

vi.mock('../../../../main/plugins/plugin-media-tools', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/plugins/plugin-media-tools')>()),
	resolveMediaRuntime: vi.fn(),
	getMediaToolStatus: vi.fn(),
}));
import {
	resolveMediaRuntime,
	getMediaToolStatus,
} from '../../../../main/plugins/plugin-media-tools';

describe('persistence IPC handlers', () => {
	let handlers: Map<string, Function>;
	let persistence: PersistenceHandlers;
	let mockSettingsStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
		store: Record<string, any>;
	};
	let mockSessionsStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
		path: string;
	};
	let mockGroupsStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
	};
	let mockWebServer: {
		getWebClientCount: ReturnType<typeof vi.fn>;
		broadcastThemeChange: ReturnType<typeof vi.fn>;
		broadcastBionifyReadingModeChange: ReturnType<typeof vi.fn>;
		broadcastCustomCommands: ReturnType<typeof vi.fn>;
		broadcastSettingsChanged: ReturnType<typeof vi.fn>;
		broadcastSessionStateChange: ReturnType<typeof vi.fn>;
		broadcastSessionAdded: ReturnType<typeof vi.fn>;
		broadcastSessionRemoved: ReturnType<typeof vi.fn>;
	};
	let deps: PersistenceHandlerDependencies;
	let getWebServerFn: () => WebServer | null;
	let mockFlushSessionWrites: ReturnType<typeof vi.fn<() => Promise<void>>>;

	beforeEach(() => {
		nativeCurrentTurns.setEnabled(true);
		// Clear mocks
		vi.clearAllMocks();

		// Create mock stores
		mockSettingsStore = {
			get: vi.fn(),
			set: vi.fn(),
			store: { activeThemeId: 'dark', fontSize: 14 },
		};

		mockSessionsStore = {
			get: vi.fn().mockReturnValue([]),
			set: vi.fn(),
			path: '/mock/maestro-sessions.json',
		};

		mockGroupsStore = {
			get: vi.fn().mockReturnValue([]),
			set: vi.fn(),
		};

		mockWebServer = {
			getWebClientCount: vi.fn().mockReturnValue(0),
			broadcastThemeChange: vi.fn(),
			broadcastBionifyReadingModeChange: vi.fn(),
			broadcastCustomCommands: vi.fn(),
			broadcastSettingsChanged: vi.fn(),
			broadcastSessionStateChange: vi.fn(),
			broadcastSessionAdded: vi.fn(),
			broadcastSessionRemoved: vi.fn(),
		};

		getWebServerFn = () => mockWebServer as unknown as WebServer;
		mockFlushSessionWrites = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		deps = {
			settingsStore: mockSettingsStore as unknown as Store<MaestroSettings>,
			sessionsStore: mockSessionsStore as unknown as Store<SessionsData>,
			groupsStore: mockGroupsStore as unknown as Store<GroupsData>,
			getWebServer: getWebServerFn,
			flushSessionWrites: mockFlushSessionWrites,
		};
		persistence = registerPersistenceHandlers(deps);
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('native transcript commit -> captured turn -> host -> history wire', () => {
		it('measures owning IPC and history wire with feature off, enable and explicit observation', async () => {
			const measurements = [];
			for (const mode of [
				'off-unobserved',
				'enabled-worker-disabled',
				'enabled',
				'off-explicit',
			] as const) {
				const agentId = generateUUID();
				nativeCurrentTurns.setEnabled(mode === 'enabled' || mode === 'enabled-worker-disabled');
				const owner = {
					isDestroyed: () => false,
					webContents: { id: 42, isDestroyed: () => false },
				} as BrowserWindow;
				registerPersistenceHandlers({ ...deps, getWindowForSession: () => owner });
				const callbacks: Record<string, (...args: unknown[]) => unknown> = {};
				const server = new Proxy(
					{},
					{
						get: (_target, key: string) => (callback: (...args: unknown[]) => unknown) => {
							callbacks[key] = callback;
						},
					}
				);
				mockSessionsStore.get.mockReturnValue([
					{
						id: agentId,
						toolType: 'codex',
						cwd: process.cwd(),
						aiTabs: [{ id: 'stream-tab', createdAt: 7, logs: [] }],
					},
				]);
				registerSessionCallbacks(server as WebServer, {
					sessionsStore: deps.sessionsStore,
					groupsStore: deps.groupsStore,
					getProcessManager: () => ({ get: () => undefined }) as never,
				});
				const read = (interest?: string) =>
					(
						callbacks.setGetSessionHistoryCallback('stream-tab', {
							currentTurn: true,
							currentTurnInterest: interest,
						}) as {
							currentTurn: CurrentTurnRead;
						}
					).currentTurn;
				if (mode === 'off-explicit') expect(read().status).toBe('unknown');
				let sequence = 0;
				const publish = (
					upserts: { id: string; text: string; source: string; timestamp: number }[],
					orderIds: string[],
					targetTabId = 'stream-tab'
				) =>
					handlers.get('sessions:publishTranscript')!(
						{ sender: { id: 42 } },
						{
							sessionId: agentId,
							tabId: targetTabId,
							field: 'logs',
							upserts,
							removedIds: [],
							orderIds,
							observation: {
								sourceGeneration: agentId,
								sequence: ++sequence,
								createdAt: 7,
								provider: 'codex',
							},
						}
					);
				const user = { id: 'boundary', text: 'Inspect', source: 'user', timestamp: 1 };
				publish([user], [user.id]);
				const capture = new AgentRunCaptureService({
					getAgentRun: () => undefined,
					upsertAgentRun: (r) => r,
					appendAgentRunEvent: (e) => e,
					findActiveRunBySession: () => undefined,
				});
				const run = capture.captureSpawn({
					sessionId: agentId + '-ai-stream-tab',
					toolType: 'codex',
					cwd: process.cwd(),
					nativeTabSession: { agentId, tabId: 'stream-tab', createdAt: 7 },
				})!;
				nativeCurrentTurns.begin(run, user.id);
				if (mode === 'enabled-worker-disabled') {
					// Real internal host read before disable must not create a generic observer.
					expect(read('pianola').status).toBe('complete');
					const cursor = read('pianola').cursor;
					nativeCurrentTurns.setEnabled(false);
					expect(() => nativeCurrentTurns.assertDelivery(cursor, 1, undefined, '')).toThrow();
				}
				const framesBefore = vi
					.mocked(broadcastBridgeEvent)
					.mock.calls.filter(([channel]) => channel === 'sessions:transcriptCommitted').length;
				const bytes = vi.spyOn(Buffer, 'byteLength');
				const clone = vi.spyOn(globalThis, 'structuredClone');
				const cpu = process.cpuUsage(),
					rss = process.memoryUsage().rss,
					start = performance.now();
				try {
					for (let n = 0; n < 100; n++)
						publish(
							[{ id: 'stream', text: 'x'.repeat(128 * 1024) + n, source: 'ai', timestamp: 2 }],
							['boundary', 'stream']
						);
					const cloneCalls = clone.mock.calls.length;
					const elapsedMs = performance.now() - start,
						used = process.cpuUsage(cpu);
					const result = read('pianola'); // actual registered host history callback
					const inactive = mode === 'off-unobserved' || mode === 'enabled-worker-disabled';
					expect(result.status).toBe(inactive ? 'unknown' : 'complete');
					if (inactive) {
						expect(cloneCalls).toBe(0);
						expect(bytes).not.toHaveBeenCalled();
						expect(
							vi
								.mocked(broadcastBridgeEvent)
								.mock.calls.filter(([channel]) => channel === 'sessions:transcriptCommitted')
						).toHaveLength(framesBefore);
					} else expect(result.messages.at(-1)?.text).toHaveLength(128 * 1024 + 2);
					measurements.push({
						mode,
						patches: 100,
						rowBytes: 128 * 1024,
						cloneCalls,
						elapsedMs,
						cpu: used,
						rssBefore: rss,
						rssAfter: process.memoryUsage().rss,
						status: result.status,
					});
				} finally {
					clone.mockRestore();
					bytes.mockRestore();
				}
				if (mode === 'enabled') {
					const cpu = process.cpuUsage(),
						start = performance.now();
					for (let n = 0; n < 2050; n++) publish([user], [user.id], `evict-${n}`);
					expect(read().status).toBe('unknown');
					measurements.push({
						mode: 'tab-eviction',
						patches: 2050,
						elapsedMs: performance.now() - start,
						cpu: process.cpuUsage(cpu),
						status: 'unknown',
					});
				}

				// Enabling cannot recover a boundary that was skipped while off.
				if (mode === 'off-unobserved') {
					nativeCurrentTurns.setEnabled(true);
					publish(
						[{ id: 'stream', text: 'tail only', source: 'ai', timestamp: 2 }],
						['boundary', 'stream']
					);
					expect(read().status).toBe('incomplete');
				}
			}
			if (process.env.PIANOLA_RECORD_MEASUREMENTS === '1') {
				const root = path.resolve('.maestro/pianola-agent-supervision-20261104');
				writeFileSync(
					path.join(root, 'K04-HOST-MEASUREMENTS.json'),
					JSON.stringify(
						{
							measurements,
							limits:
								'Real registered owner IPC and history callbacks; Electron and bridge transport mocked. Streaming timing excludes final history read. No provider or network IO.',
						},
						null,
						2
					)
				);
			}
			nativeCurrentTurns.setEnabled(true);
		});

		it('reads the full native turn and wakes the production worker only after owner commit', async () => {
			const agentId = generateUUID();
			const owner = {
				isDestroyed: () => false,
				webContents: { id: 42, isDestroyed: () => false },
			} as BrowserWindow;
			registerPersistenceHandlers({ ...deps, getWindowForSession: () => owner });
			let sequence = 0;
			const user = { id: 'user', source: 'user', text: 'Inspect the naming', timestamp: 1 };
			const all = [user];
			const publish = (upserts: typeof all, sender = 42) =>
				handlers.get('sessions:publishTranscript')!(
					{ sender: { id: sender } },
					{
						sessionId: agentId,
						tabId: 'tab',
						field: 'logs',
						upserts,
						orderIds: all.map((row) => row.id),
						removedIds: [],
						observation: {
							sourceGeneration: agentId,
							sequence: sender === 42 ? ++sequence : sequence + 1,
							createdAt: 7,
							provider: 'codex',
						},
					}
				);
			publish([user]);
			const capture = new AgentRunCaptureService({
				getAgentRun: () => undefined,
				upsertAgentRun: (run) => run,
				appendAgentRunEvent: (event) => event,
				findActiveRunBySession: () => undefined,
			});
			const run = capture.captureSpawn({
				sessionId: `${agentId}-ai-tab`,
				toolType: 'codex',
				cwd: '/project',
				nativeTabSession: { agentId, tabId: 'tab', createdAt: 7 },
			})!;
			nativeCurrentTurns.begin(run, user.id);
			const output = [
				{ id: 'risk', source: 'ai', text: 'I will delete the production database.', timestamp: 2 },
				...Array.from({ length: 150 }, (_, i) => ({
					id: `progress-${i}`,
					source: 'ai',
					text: 'Working',
					timestamp: i + 3,
				})),
				{ id: 'question', source: 'ai', text: 'Should I call it count or total?', timestamp: 200 },
			];
			all.push(...output);
			publish(output);
			const sessions = [
				{
					id: agentId,
					name: 'Worker',
					cwd: '/project',
					toolType: 'codex',
					aiTabs: [{ id: 'tab', createdAt: 7, state: 'idle', logs: all.slice(-100) }],
				},
			];
			mockSessionsStore.get.mockReturnValue(sessions);
			const callbacks: Record<string, Function> = {};
			const server = new Proxy(
				{},
				{
					get: (_target, key: string) => (callback: Function) => {
						callbacks[key] = callback;
					},
				}
			);
			registerSessionCallbacks(server as WebServer, {
				sessionsStore: deps.sessionsStore,
				groupsStore: deps.groupsStore,
				getProcessManager: () => ({ get: () => undefined }) as never,
			});
			const send = vi.fn();
			const ctx = {
				send,
				callbacks: { getSessionHistory: callbacks.setGetSessionHistoryCallback },
			} as unknown as MessageHandlerContext;
			const request = (extra = {}) => {
				handleGetSessionHistory(ctx, {} as WebClient, {
					type: 'get_session_history',
					tabId: 'tab',
					currentTurn: true,
					currentTurnInterest: 'pianola',
					tail: 1,
					requestId: 'read',
					...extra,
				});
				return send.mock.calls.at(-1)![1] as { currentTurn: CurrentTurnRead; messages: unknown[] };
			};
			const committedFrames = () =>
				vi
					.mocked(broadcastBridgeEvent)
					.mock.calls.filter(([channel]) => channel === 'sessions:transcriptCommitted');
			const read = request();
			expect(committedFrames().at(-1)?.[1]).toEqual([read.currentTurn.cursor]);
			expect(read.currentTurn.status).toBe('complete');
			expect(read.currentTurn.messages).toHaveLength(153);
			expect(read.currentTurn.cursor).toMatchObject({
				agentId,
				tabId: 'tab',
				runId: run.id,
				turnId: 'user',
			});
			expect(
				classifyMessages(
					read.currentTurn.messages.map((row) => ({
						id: row.id,
						role: row.source === 'user' ? 'user' : 'assistant',
						source: row.source,
						content: row.text,
						timestamp: new Date(row.timestamp).toISOString(),
					}))
				)
			).toMatchObject({ kind: 'question', risk: 'high' });
			const census = callbacks.setListDesktopSessionsCallback();
			expect(census.sessions[0].supervision.currentTurn.cursor).toEqual(read.currentTurn.cursor);
			expect(census.sessions[0].supervision.currentTurn).not.toHaveProperty('messages');
			// Legacy callers still get the same persisted window and tail semantics.
			expect(callbacks.setGetSessionHistoryCallback('tab', { tail: 1 }).messages).toHaveLength(1);
			// A non-owning native renderer cannot revise this observation.
			const commitCount = committedFrames().length;
			publish([{ ...output.at(-1)!, text: 'Foreign' }], 43);
			expect(committedFrames()).toHaveLength(commitCount);
			expect(request().currentTurn.cursor).toEqual(read.currentTurn.cursor);
			publish([{ ...output.at(-1)!, text: 'Which variable should I choose?' }]);
			expect(request({ expectedCursor: read.currentTurn.cursor }).currentTurn).toMatchObject({
				status: 'gap',
				messages: [],
			});
			expect(request({ expectedCursor: {} })).toHaveProperty('code', 'INVALID_CURSOR');
			// Join the actual owner-validated IPC producer to BridgeConnection's
			// frame callback and the production worker/cycle/store consumer.
			vi.useFakeTimers();
			const root = path.resolve('.maestro/pianola-agent-supervision-20261104/Working');
			mkdirSync(root, { recursive: true });
			const directory = mkdtempSync(path.join(root, 'J02-owner-loop-'));
			vi.spyOn(cliStorage, 'getConfigDirectory').mockReturnValue(directory);
			vi.spyOn(cliStorage, 'getSyncDir').mockReturnValue(directory);
			const store = createPianolaFsStore({
				resolveDir: () => directory,
				indent: 2,
				trailingNewline: true,
			});
			const scopeId = '11111111-1111-4111-8111-111111111111';
			store.writeSupervisorTargets([
				{
					id: scopeId,
					kind: 'watch-scope',
					enabled: true,
					createdAt: 1,
					managerAgentId: 'manager',
					selection: {
						mode: 'agents-and-groups',
						label: 'Selected',
						agentIds: [agentId],
						groupIds: [],
						excludedAgentIds: [],
					},
				},
			]);
			let enabled = true;
			vi.spyOn(cliStorage, 'readSettingValue').mockImplementation(() => ({ pianola: enabled }));
			vi.spyOn(workerStore, 'readPianolaSupervisorTargets').mockImplementation(
				store.readSupervisorTargets
			);
			vi.spyOn(workerStore, 'readPianolaScopeCheckpoint').mockImplementation(
				store.readScopeCheckpoint
			);
			vi.spyOn(workerStore, 'writePianolaScopeCheckpoint').mockImplementation(
				store.writeScopeCheckpoint
			);
			vi.spyOn(workerStore, 'readPianolaDecisions').mockImplementation(store.readDecisions);
			vi.spyOn(workerStore, 'appendPianolaDecision').mockImplementation(store.appendDecision);
			vi.spyOn(workerStore, 'readPianolaRules').mockReturnValue([]);
			vi.spyOn(workerStore, 'getPianolaProfile').mockReturnValue({ entry: undefined } as never);
			let connection: BridgeConnectionOptions;
			vi.spyOn(MaestroClient.prototype, 'connect').mockImplementation(async function () {
				connection = (this as unknown as { options: BridgeConnectionOptions }).options;
			});
			vi.spyOn(MaestroClient.prototype, 'isOpen', 'get').mockReturnValue(true);
			vi.spyOn(MaestroClient.prototype, 'disconnect').mockImplementation(() => {});
			let censusCount = 0;
			vi.spyOn(MaestroClient.prototype, 'sendCommand').mockImplementation(async (message) => {
				if (message.type === 'list_desktop_sessions') {
					censusCount++;
					return { success: true, ...callbacks.setListDesktopSessionsCallback() } as never;
				}
				expect(message).toHaveProperty('currentTurnInterest', 'pianola');
				handleGetSessionHistory(ctx, {} as WebClient, message as never);
				return send.mock.calls.at(-1)![1] as never;
			});
			vi.mocked(broadcastBridgeEvent).mockImplementation((channel, args) => {
				if (channel === 'sessions:transcriptCommitted') {
					// A hint cannot run ahead of the committed native revision.
					expect(request().currentTurn.cursor).toEqual(args[0]);
				}
				connection?.onFrame?.({ type: 'bridge.event', channel, args });
			});
			const worker = pianolaWatchScope(scopeId, { dryRun: true });
			try {
				await vi.advanceTimersByTimeAsync(0);
				expect(censusCount).toBe(1);
				const next = {
					id: 'next-question',
					source: 'ai',
					text: 'Should I name it value?',
					timestamp: 201,
				};
				all.push(next);
				publish([next], 43); // unowned sync never emits the commit hint
				await vi.advanceTimersByTimeAsync(100);
				expect(censusCount).toBe(1);
				expect(store.readDecisions()).toHaveLength(0);
				publish([next]);
				await vi.advanceTimersByTimeAsync(49);
				expect(censusCount).toBe(1);
				await vi.advanceTimersByTimeAsync(1);
				expect(censusCount).toBe(2);
				expect(store.readDecisions()).toHaveLength(1);
				expect(store.readDecisions()[0].classification).toMatchObject({
					kind: 'question',
					risk: 'high',
				});
			} finally {
				enabled = false;
				connection!.onClose?.(1006, 'stop');
				await vi.advanceTimersByTimeAsync(20000);
				await worker;
				const cursor = request().currentTurn.cursor;
				nativeCurrentTurns.setEnabled(false);
				const clone = vi.spyOn(globalThis, 'structuredClone');
				const bytes = vi.spyOn(Buffer, 'byteLength');
				const hintsBefore = committedFrames().length;
				try {
					for (let i = 0; i < 100; i++)
						publish([{ id: 'stream', source: 'ai', text: 'x'.repeat(128 * 1024), timestamp: 300 }]);
					expect(clone).not.toHaveBeenCalled();
					expect(bytes).not.toHaveBeenCalled();
					expect(committedFrames()).toHaveLength(hintsBefore);
					expect(request().currentTurn.status).toBe('unknown');
					expect(() => nativeCurrentTurns.assertDelivery(cursor, 1, undefined, '')).toThrow();
				} finally {
					clone.mockRestore();
					bytes.mockRestore();
				}
				vi.mocked(broadcastBridgeEvent).mockImplementation(() => {});
				vi.restoreAllMocks();
				vi.useRealTimers();
				rmSync(directory, { recursive: true, force: true });
			}
		});
	});

	describe('host queue-item durable readback composition', () => {
		let realFs: typeof fs;
		let directory: string;
		let current: StoredSession[];
		let request: QueueItemReceiptRequest;
		let server: WebServer;
		const session = (item: QueueItemReceiptRequest['item']): StoredSession => ({
			id: 'agent',
			name: 'Agent',
			toolType: 'codex',
			cwd: '/project',
			projectRoot: '/project',
			aiTabs: [{ id: 'tab', createdAt: 1 }],
			executionQueue: [item],
		});
		const save = (
			updates: StoredSession[] = [],
			remove: string[] = [],
			baseline: StoredSession[] = []
		) => handlers.get('sessions:setMany')!({}, updates, remove, baseline);
		const confirm = () => server.confirmQueueItemFromMain(request);

		beforeEach(async () => {
			realFs = await vi.importActual<typeof fs>('fs/promises');
			directory = await realFs.mkdtemp(path.join(process.cwd(), '.queue-receipt-test-'));
			mockSessionsStore.path = path.join(directory, 'sessions.json');
			request = {
				agentId: 'agent',
				tabId: 'tab',
				itemId: 'item',
				pendingAdmissionId: 'dispatch',
				item: {
					id: 'item',
					tabId: 'tab',
					timestamp: 1,
					type: 'message',
					text: 'Exact intent',
					images: ['maestro-image://synthetic.png'],
					pendingAdmissionId: 'dispatch',
				},
			};
			current = [session(structuredClone(request.item))];
			mockSessionsStore.get.mockImplementation((_key, fallback) => current ?? fallback);
			mockSessionsStore.set.mockImplementation((_key, value) => {
				current = value;
			});
			mockFlushSessionWrites.mockImplementation(() =>
				realFs.writeFile(mockSessionsStore.path, JSON.stringify({ sessions: current }))
			);
			vi.mocked(fs.readFile).mockImplementation(realFs.readFile);
			await mockFlushSessionWrites();
			// Real registration and real WebServer host method, transport setters inert.
			server = Object.create(WebServer.prototype);
			for (const name of [
				'setEnqueueCommandCallback',
				'setListQueueCallback',
				'setRemoveQueueItemCallback',
				'setSetQueueItemPausedCallback',
				'setMergeQueueItemCallback',
				'setSteerQueueItemCallback',
			])
				Object.assign(server, { [name]: vi.fn() });
			registerQueueCallbacks(server, {
				getMainWindow: () => null,
				confirmQueueItem: persistence.confirmQueueItem,
				releaseQueueItem: persistence.releaseQueueItem,
			});
		});
		afterEach(async () => {
			cancelCrossAgentRequestsForSource('agent', 'tab');
			sweepQueueConsultReleases(true);
			vi.useRealTimers();
			pianolaNewTabSpawns.cancelHold('agent', 'tab');
			await realFs.rm(directory, { recursive: true, force: true });
		});

		/** Reuse B01's real writer/reader instead of inventing a Boolean receipt. */
		function queueAdapter(
			busy = false,
			mentions: boolean | 'handoff' | 'consult-first' | 'only' = false
		) {
			if (mentions)
				Object.assign(request.item, {
					text: 'Check @PeerA and @PeerB',
					crossAgentMention: true,
					mentionRouting: typeof mentions === 'string' ? mentions : 'parallel',
				});
			const store = createPianolaFsStore({
				resolveDir: () => path.join(directory, 'pianola'),
				indent: 2,
				trailingNewline: true,
			});
			const scopeId = generateUUID();
			store.writeSupervisorTargets([
				{
					id: scopeId,
					kind: 'watch-scope',
					enabled: true,
					createdAt: 1,
					managerAgentId: 'manager',
					selection: {
						label: 'Workers',
						mode: 'agents-and-groups',
						agentIds: ['agent'],
						groupIds: [],
						excludedAgentIds: [],
					},
				},
			]);
			const ledgerPath = path.join(directory, 'native-runs.json');
			const readNativeRuns = (): AgentRun[] =>
				existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : [];
			const upsertNativeRun = (run: AgentRun) => {
				writeFileSync(
					ledgerPath,
					JSON.stringify([...readNativeRuns().filter((r) => r.id !== run.id), run])
				);
				pianolaNewTabSpawns.observeRun(run);
				return run;
			};
			const capture = new AgentRunCaptureService({
				getAgentRun: (id) => readNativeRuns().find((r) => r.id === id),
				upsertAgentRun: upsertNativeRun,
				appendAgentRunEvent: (event) => event,
				findActiveRunBySession: (id) =>
					readNativeRuns().find((r) => r.sessionId === id && r.status === 'running'),
			});
			const client = { cliAuthenticated: true };
			const dispatchId = generateUUID();
			const input = {
				dispatchId,
				targetAgentId: 'agent',
				targetTabId: 'tab',
				prompt: String(request.item.text),
				background: true,
				hidden: false,
				held: false,
			};
			current = [
				{
					...session(request.item),
					executionQueue: [],
					...(mentions
						? {
								createdAt: 1,
								peerAgents: [
									{ sessionId: 'peer-a', read: true, write: mentions === 'handoff' },
									{ sessionId: 'peer-b', read: true, write: mentions === 'handoff' },
								],
							}
						: {}),
				},
				...(mentions
					? ['a', 'b'].map((id) => ({
							id: `peer-${id}`,
							name: `Peer${id.toUpperCase()}`,
							createdAt: 1,
							toolType: 'codex',
							cwd: directory,
						}))
					: []),
			];
			const rendererQueue: QueuedItem[] = [];
			let loseAck = false;
			let skipSave = false;
			const enqueue = vi.fn(async (...args: unknown[]) => {
				const control = args[9] as { item: QueuedItem };
				rendererQueue.push(control.item);
				if (!skipSave) await save([{ ...current[0], executionQueue: rendererQueue }]);
				if (loseAck) throw new Error('Lost renderer ack');
				return { success: true, queued: true, itemId: control.item.id, tabId: 'tab' };
			});
			const confirmItem = vi.fn((r: QueueItemReceiptRequest) => server.confirmQueueItemFromMain(r));
			let active = true;
			const deps = {
				routingSnapshot: () => ({
					agents: current as import('../../../../shared/maestro-lib/store/records').AgentRecord[],
					groups: [],
				}),
				readNativeRuns,
				store,
				callers: {
					resolve: () => ({
						run: { agentId: 'manager', tabId: 'manager-tab', spawnGeneration: 'run' },
						signal: new AbortController().signal,
						unattended: true,
						assertActive() {
							if (!active) throw new Error('CallerRunUnavailable');
						},
					}),
				},
				featureEnabled: () => true,
				snapshot: (): PianolaScopeSnapshot => ({
					complete: true,
					capturedAt: 100,
					owners: [
						{ id: 'agent', cwd: process.cwd(), isPianola: false, remote: false, groupId: null },
					],
					tabs: [
						{
							agentId: 'agent',
							tabId: 'tab',
							createdAt: 1,
							busy,
							paused: false,
							consult: false,
							ephemeral: false,
							cursorAvailable: false,
							cursor: null,
						},
					],
				}),
				ruleSetRevision: () => 'rules',
				newTab: vi.fn(),
				onReconcileError: vi.fn(),
				enqueueCommand: enqueue,
				confirmQueueItem: confirmItem,
				releaseQueueItem: (...args: Parameters<typeof persistence.releaseQueueItem>) =>
					server.releaseQueueItemFromMain(...args),
				queueItem: async (queued: { dispatchId: string } = { dispatchId }) =>
					({
						...request.item,
						id: queued.dispatchId,
						pendingAdmissionId: queued.dispatchId,
					}) as unknown as PianolaQueueItem,
			};
			const adapter = new PianolaNewTabDispatch(deps);
			const arm = vi.fn(() => undefined);
			return {
				adapter,
				capture,
				upsertNativeRun,
				deps,
				store,
				client,
				input,
				enqueue,
				confirmItem,
				rendererQueue,
				arm,
				scopeId,
				revoke: () => {
					active = false;
				},
				restore: () => {
					active = true;
				},
				loseAck: () => {
					loseAck = true;
				},
				skipSave: () => {
					skipSave = true;
				},
			};
		}
		async function readyQueue(mentions: boolean | 'handoff' | 'consult-first' | 'only' = false) {
			const f = queueAdapter(true, mentions);
			await f.adapter.runQueue(f.client, f.input, f.arm);
			const snapshot = f.deps.snapshot();
			snapshot.tabs[0].busy = false;
			snapshot.tabs[0].cursorAvailable = true;
			f.deps.snapshot = () => snapshot;
			return { ...f, snapshot };
		}

		async function managedLocalFixture(
			mode: boolean | 'handoff' | 'consult-first' | 'only' = true,
			mutation?: () => void
		) {
			request.item = { ...request.item, turnSettings: { model: 'host-model', effort: 'high' } };
			const f = await readyQueue(mode);
			f.revoke();
			const promptSpy = vi
				.spyOn(promptManager, 'getPrompt')
				.mockImplementation(
					(id) => `${id}: {{CONSULTED_AGENTS}}{{HANDOFF_AGENTS}}{{CONSULT_REPLIES}}{{USER_MESSAGE}}`
				);
			const systemSpy = vi
				.spyOn(systemPromptService, 'buildMaestroSystemPromptForSession')
				.mockResolvedValue('Host system prompt');
			let fastExit = false;
			let captureMissing = false;
			let unknownSpawn = false;
			const events = new EventEmitter();
			const spawn = vi.fn((config) => {
				const local = f.store
					.readDispatchAdmission(f.input.dispatchId)!
					.queueRouting!.steps.find(
						(s) =>
							s.kind === 'local' &&
							(config.pianolaQueueStepId ? s.requestId === config.pianolaQueueStepId : !s.stage)
					)!;
				expect(local.status).toBe('unknown'); // durable intent before the native side effect
				if (unknownSpawn) throw new Error('Native spawn acknowledgement lost');
				if (!captureMissing) {
					const run = f.capture.captureSpawn({
						sessionId: config.sessionId,
						toolType: config.toolType,
						cwd: config.cwd,
						tabId: 'tab',
						prompt: config.prompt,
						nativeTabSession: {
							agentId: 'agent',
							tabId: 'tab',
							createdAt: 1,
							initialSessionId: config.agentSessionId,
						},
					})!;
					pianolaNewTabSpawns.captured(
						config.sessionId,
						run.id,
						config.pianolaDispatchId,
						config.pianolaQueueItemId
					);
					f.snapshot.tabs[0].busy = true;
					if (fastExit) {
						void f.capture.captureExit({
							sessionId: config.sessionId,
							exitCode: 0,
							settlement: { outcome: 'completed', answerTail: 'Fast native output' } as never,
						});
						events.emit('exit', config.sessionId, 0);
					}
				}
				return { success: true, pid: 42 };
			});
			const manager = Object.assign(events, { spawn, get: () => undefined, getAll: () => [] });
			const definition = getAgentDefinition('codex')!;
			const processDeps = {
				getProcessManager: () => manager as never,
				getAgentDetector: () =>
					({
						getAgent: async () => {
							mutation?.();
							return {
								...definition,
								available: true,
								path: '/fixture/codex',
								capabilities: getAgentCapabilities('codex'),
							};
						},
					}) as never,
				agentConfigsStore: { get: (_key: string, fallback: unknown) => fallback } as never,
				settingsStore: { get: (_key: string, fallback: unknown) => fallback } as never,
				sessionsStore: mockSessionsStore as never,
				groupsStore: { get: () => [] } as never,
				getMainWindow: () => null,
				getWindowForSession: () => ({ webContents: { id: 7 } }) as never,
				getWebServer: () =>
					({
						prepareQueueSpawnFromMain: (...args: Parameters<typeof f.adapter.prepareQueueSpawn>) =>
							f.adapter.prepareQueueSpawn(...args),
					}) as never,
			};
			registerProcessHandlers(processDeps);
			const start = (event = { sender: { id: 7, isDestroyed: () => false } }) =>
				handlers.get('process:spawn')!(event, {
					sessionId: 'agent-ai-tab',
					pianolaDispatchId: f.input.dispatchId,
					pianolaQueueItemId: f.input.dispatchId,
					toolType: 'malicious-provider',
					cwd: '/foreign',
					command: 'foreign',
					args: ['--foreign'],
					prompt: 'Renderer tamper',
					images: ['data:image/png;base64,Zm9yZWlnbg=='],
					appendSystemPrompt: 'Foreign system prompt',
					sessionCustomEnvVars: { FOREIGN: 'yes' },
					agentContext: { text: 'Arbitrary continuation' },
				});
			return {
				...f,
				start,
				spawn,
				events,
				manager,
				processDeps,
				fast: () => {
					fastExit = true;
				},
				missing: () => {
					captureMissing = true;
				},
				unknown: () => {
					unknownSpawn = true;
				},
				cleanup: () => {
					events.emit('exit', 'agent-ai-tab', 0);
					promptSpy.mockRestore();
					systemSpy.mockRestore();
				},
			};
		}

		it.each([true, 'handoff'] as const)(
			'runs a host-derived LOCAL through owner IPC, release, native spawn and matching capture (%s)',
			async (mode) => {
				const f = await managedLocalFixture(mode);
				try {
					current[0].newSessionMessage = 'First turn instruction';
					const result = await f.start();
					expect(result.success).toBe(true);
					expect(f.deps.onReconcileError.mock.calls).toEqual([]);
					expect(f.spawn).toHaveBeenCalledOnce();
					const config = f.spawn.mock.calls[0][0];
					expect(config).toMatchObject({
						toolType: 'codex',
						cwd: '/project',
						appendSystemPrompt: 'Host system prompt',
					});
					expect(config.images).toEqual(request.item.images);
					expect(config.sessionCustomModel).toBe('host-model');
					expect(config.sessionCustomEffort).toBe('high');
					expect(config.prompt).toContain('First turn instruction');
					expect(config.prompt).toContain('PeerA and PeerB');
					expect(config.prompt).not.toContain('Renderer tamper');
					expect(config.customEnvVars?.FOREIGN).toBeUndefined();
					const runId = f.store.readDispatchAdmission(f.input.dispatchId)!.runId!;
					f.capture.captureSessionAnnouncement('agent-ai-tab', 'provider-local');
					current[0].aiTabs![0].agentSessionId = 'provider-local';
					f.snapshot.tabs[0].agentSessionId = 'provider-local';
					current[0].executionQueue = []; // own capture survives the drain removing its original row
					await f.capture.captureExit({
						sessionId: 'agent-ai-tab',
						exitCode: 0,
						settlement: { outcome: 'completed', answerTail: 'Authentic output' } as never,
					});
					f.events.emit('exit', 'agent-ai-tab', 0);
					const record = f.store.readDispatchAdmission(f.input.dispatchId)!;
					expect(record.queueRouting!.steps.find((s) => s.kind === 'local')).toMatchObject({
						runId,
						status: 'settled',
						agentSessionId: 'provider-local',
						terminal: { text: 'Authentic output' },
					});
					await expect(f.start()).rejects.toThrow(/Dispatch/);
					expect(f.spawn).toHaveBeenCalledOnce();
				} finally {
					f.cleanup();
				}
			}
		);

		it.each(['pause', 'peer', 'owner', 'row', 'fifo', 'generation', 'enrollment'] as const)(
			'refuses LOCAL %s changes during async native preparation',
			async (mutation) => {
				let f: Awaited<ReturnType<typeof managedLocalFixture>>;
				f = await managedLocalFixture(true, () => {
					if (mutation === 'pause') f.snapshot.tabs[0].paused = true;
					if (mutation === 'peer') current[0].peerAgents = [];
					if (mutation === 'owner')
						f.processDeps.getWindowForSession = () => ({ webContents: { id: 8 } }) as never;
					if (mutation === 'row') current[0].executionQueue[0].text = 'Replaced';
					if (mutation === 'fifo')
						current[0].executionQueue.unshift({
							id: 'human',
							type: 'message',
							text: 'Human turn',
							tabId: 'tab',
						});
					if (mutation === 'generation') f.snapshot.tabs[0].createdAt++;
					if (mutation === 'enrollment') {
						const checkpoint = f.store.readScopeCheckpoint(f.scopeId)!;
						checkpoint.status = 'suspended';
						f.store.writeScopeCheckpoint(checkpoint);
					}
				});
				try {
					await expect(f.start()).rejects.toThrow(/Dispatch|Pianola/);
					expect(f.spawn).not.toHaveBeenCalled();
				} finally {
					f.cleanup();
				}
			}
		);

		it.each(['fast', 'missing', 'unknown'] as const)(
			'preserves LOCAL capture/uncertainty without resend after %s native outcome',
			async (outcome) => {
				const f = await managedLocalFixture();
				try {
					f[outcome]();
					if (outcome === 'unknown')
						await expect(f.start()).rejects.toThrow('Native spawn acknowledgement lost');
					else await f.start();
					const record = f.store.readDispatchAdmission(f.input.dispatchId)!;
					const local = record.queueRouting!.steps.find((s) => s.kind === 'local')!;
					expect(local.status).toBe(outcome === 'fast' ? 'settled' : 'unknown');
					if (outcome !== 'fast') expect(local.terminal).toBeUndefined();
					if (outcome === 'fast') expect(local.terminal?.text).toBe('Fast native output');
					if (outcome === 'fast') {
						const restored = await new PianolaNewTabDispatch(f.deps).prepareQueueSpawn(
							'agent',
							'tab',
							f.input.dispatchId,
							() => {}
						);
						expect(restored.reconciled).toBe(true);
					} else
						await expect(
							new PianolaNewTabDispatch(f.deps).prepareQueueSpawn(
								'agent',
								'tab',
								f.input.dispatchId,
								() => {}
							)
						).rejects.toThrow('DispatchQueueReleaseUncertain');
					expect(f.spawn).toHaveBeenCalledOnce();
				} finally {
					f.events.emit('exit', 'agent-ai-tab', 0);
					pianolaNewTabSpawns.started(
						'agent-ai-tab',
						undefined,
						f.input.dispatchId,
						f.input.dispatchId
					);
					f.cleanup();
				}
			}
		);

		it.each(['owned-running', 'owned-terminal', 'human', 'reset', 'peer-revoke'] as const)(
			'allows only matching own LOCAL capture after queue removal (%s)',
			async (transition) => {
				const f = await managedLocalFixture();
				const consultEvents = new EventEmitter();
				const consultSpawn = vi.fn((_config: { sessionId: string }) => ({
					success: true,
					pid: 99,
				}));
				try {
					await f.start();
					current[0].executionQueue = [];
					f.capture.captureSessionAnnouncement('agent-ai-tab', 'native-provider');
					f.snapshot.tabs[0].agentSessionId = 'native-provider';
					if (transition === 'owned-terminal')
						await f.capture.captureExit({
							sessionId: 'agent-ai-tab',
							exitCode: 0,
							settlement: { outcome: 'completed', answerTail: 'Native terminal' } as never,
						});
					if (transition === 'human') {
						f.capture.captureSpawn({
							sessionId: 'agent-ai-tab',
							toolType: 'codex',
							cwd: '/project',
							tabId: 'tab',
							nativeTabSession: {
								agentId: 'agent',
								tabId: 'tab',
								createdAt: 1,
								initialSessionId: 'native-provider',
							},
						});
					}
					if (transition === 'reset') f.snapshot.tabs[0].agentSessionId = 'replacement';
					if (transition === 'peer-revoke') current[0].peerAgents = [];
					const manager = Object.assign(consultEvents, { spawn: consultSpawn, kill: vi.fn() });
					const record = f.store.readDispatchAdmission(f.input.dispatchId)!;
					const start = (target: string) =>
						startReleasedQueueConsult(
							{ dispatchId: f.input.dispatchId, generation: record.queueRelease!.generation },
							'agent',
							'tab',
							target,
							{
								processManager: manager as never,
								agentDetector: f.processDeps.getAgentDetector(),
								sshStore: null,
								getTargetSession: (id) => ({ id, name: id, toolType: 'codex', cwd: directory }),
								onChunk: () => {},
							}
						);
					if (transition.startsWith('owned-')) {
						await start('peer-a');
						await start('peer-b');
						expect(consultSpawn).toHaveBeenCalledTimes(2);
						await expect(start('peer-a')).rejects.toThrow(/AlreadyClaimed/);
					} else {
						await expect(start('peer-a')).rejects.toThrow(/Dispatch/);
						expect(consultSpawn).not.toHaveBeenCalled();
					}
				} finally {
					for (const [config] of consultSpawn.mock.calls)
						consultEvents.emit('exit', config.sessionId, 0);
					await f.capture.captureExit({ sessionId: 'agent-ai-tab', exitCode: 0 });
					f.cleanup();
				}
			}
		);

		it.each(['started', 'terminal'] as const)(
			'retains LOCAL ownership and Unknown on %s journal failure',
			async (phase) => {
				const f = await managedLocalFixture();
				const write = f.store.writeDispatchAdmission;
				let failed = false;
				f.store.writeDispatchAdmission = (record) => {
					const local = record.queueRouting?.steps.find((s) => s.kind === 'local');
					if (!failed && (phase === 'started' ? local?.status === 'started' : !!local?.terminal)) {
						failed = true;
						throw Object.assign(new Error('Local journal ENOSPC'), { code: 'ENOSPC' });
					}
					write(record);
				};
				try {
					await f.start();
					await f.capture.captureExit({
						sessionId: 'agent-ai-tab',
						exitCode: 0,
						settlement: { outcome: 'completed', answerTail: 'Native answer' } as never,
					});
					const record = f.store.readDispatchAdmission(f.input.dispatchId)!;
					expect(failed).toBe(true);
					expect(record.outcome).toBe('unknown');
					expect(record.queueRouting!.steps.find((s) => s.kind === 'local')).toMatchObject({
						status: 'unknown',
						startError: 'DispatchRoutingJournalUnknown',
					});
					expect(
						record.queueRouting!.steps.find((s) => s.kind === 'local')!.terminal
					).toBeUndefined();
					expect(f.deps.readNativeRuns().at(-1)!.status).toBe('completed');
					expect(f.deps.onReconcileError).toHaveBeenCalled();
					await expect(
						new PianolaNewTabDispatch(f.deps).prepareQueueSpawn(
							'agent',
							'tab',
							f.input.dispatchId,
							() => {}
						)
					).rejects.toThrow('DispatchQueueReleaseUncertain');
					expect(f.spawn).toHaveBeenCalledOnce();
				} finally {
					f.store.writeDispatchAdmission = write;
					f.cleanup();
				}
			}
		);

		it.each(['foreign-tab', 'foreign-generation', 'foreign-session'] as const)(
			'keeps LOCAL unknown for %s native capture',
			async (mismatch) => {
				const f = await managedLocalFixture();
				try {
					f.spawn.mockImplementation((config) => {
						const run = f.capture.captureSpawn({
							sessionId: config.sessionId,
							toolType: 'codex',
							cwd: '/project',
							tabId: 'tab',
							nativeTabSession: {
								agentId: 'agent',
								tabId: mismatch === 'foreign-tab' ? 'foreign' : 'tab',
								createdAt: mismatch === 'foreign-generation' ? 2 : 1,
								initialSessionId: mismatch === 'foreign-session' ? 'foreign' : undefined,
							},
						})!;
						pianolaNewTabSpawns.captured(
							config.sessionId,
							run.id,
							config.pianolaDispatchId,
							config.pianolaQueueItemId
						);
						return { success: true, pid: 42 };
					});
					const result = await f.start();
					expect(result.pianolaRunId).toBeUndefined();
					const record = f.store.readDispatchAdmission(f.input.dispatchId)!;
					expect(record.outcome).toBe('unknown');
					expect(record.runId).toBeUndefined();
					expect(
						record.queueRouting!.steps.find((s) => s.kind === 'local')!.terminal
					).toBeUndefined();
					expect(f.deps.onReconcileError).toHaveBeenCalled();
					await expect(
						new PianolaNewTabDispatch(f.deps).prepareQueueSpawn(
							'agent',
							'tab',
							f.input.dispatchId,
							() => {}
						)
					).rejects.toThrow('DispatchQueueReleaseUncertain');
				} finally {
					await f.capture.captureExit({ sessionId: 'agent-ai-tab', exitCode: 0 });
					f.cleanup();
				}
			}
		);

		async function managedConsultFixture(
			mode: boolean | 'handoff' | 'consult-first' | 'only' = true,
			existing?: Awaited<ReturnType<typeof managedLocalFixture>>
		) {
			const f = existing ?? (await readyQueue(mode));
			f.revoke(); // The original caller turn is no longer alive.
			const generation =
				existing && mode === 'handoff'
					? f.store.readDispatchAdmission(f.input.dispatchId)!.queueRelease!.generation
					: mode === 'consult-first'
						? (await f.adapter.admission.releaseQueue(f.input.dispatchId)).generation
						: (await f.adapter.prepareQueueSpawn('agent', 'tab', f.input.dispatchId, () => {}))
								.generation;
			const manager = Object.assign(new EventEmitter(), {
				spawn: vi.fn((_config: unknown) => ({ success: true, pid: 4242 })),
				kill: vi.fn(),
			});
			vi.spyOn(systemPromptService, 'buildMaestroSystemPromptForSession').mockResolvedValue(
				undefined
			);
			const chunks: unknown[] = [];
			const opts: Omit<StartCrossAgentRequestOptions, 'nativeAdmission'> = {
				processManager: manager as unknown as StartCrossAgentRequestOptions['processManager'],
				agentDetector: {
					getAgent: async () => ({ ...getAgentDefinition('codex'), available: true }),
				} as unknown as StartCrossAgentRequestOptions['agentDetector'],
				sshStore: null,
				getTargetSession: (id) => {
					const a = current.find((a) => a.id === id)!;
					return { id, name: String(a.name), toolType: 'codex', cwd: directory };
				},
				onChunk: (c) => chunks.push(c),
			};
			const start = (target = 'peer-a', gen = generation, id = f.input.dispatchId) =>
				mode === 'handoff'
					? f.adapter.admission.startQueueHandoff(id, gen!, target, opts)
					: startReleasedQueueConsult(
							{ dispatchId: id, generation: gen! },
							'agent',
							'tab',
							target,
							opts
						);
			return { ...f, generation, manager, opts, start, chunks };
		}

		it.each(
			(['parallel', 'only', 'consult-first', 'handoff'] as const).flatMap((mode) =>
				[
					'normal',
					'setup-both-fail',
					'setup-one-fail',
					'setup-cancel',
					'provider-setup-fail',
					'fast',
					'partial-unknown',
					'partial-unknown-false',
					'terminal-journal',
					'delete-row',
					'peer-revoke',
					'pause',
					'owner-reset',
					'foreign-socket',
					'double-drain',
					'failed',
					'callback-reset',
					'restart',
					...(mode === 'parallel'
						? ['local-last', 'local-output-tamper', 'reply-peer-revoke']
						: []),
					...(mode === 'consult-first'
						? [
								'reply-peer-revoke',
								'human-turn',
								'first-announcement',
								'callback-restore',
								'local-unknown',
								'local-cancel',
							]
						: []),
					...(mode === 'handoff'
						? [
								'handoff-peer-revoke',
								'human-turn',
								'first-announcement',
								'callback-restore',
								'local-unknown',
								'local-cancel',
								'empty-output',
								'output-tamper',
							]
						: []),
					...(['consult-first', 'handoff'].includes(mode)
						? [
								'deferred-pause',
								'deferred-reset',
								'deferred-owner',
								'deferred-target-deletion',
								'deferred-policy',
								'deferred-double',
							]
						: []),
				].map((scenario) => ({ mode, scenario }))
			)
		)(
			'composes the real renderer queue, native $mode branches and aggregate callback: $scenario',
			async ({ mode, scenario }) => {
				const f = await managedLocalFixture(mode === 'parallel' ? true : mode);
				const fires = vi.fn();
				const registry = new DispatchCallbackRegistry({ onFire: fires });
				const record = f.store.readDispatchAdmission(f.input.dispatchId)!;
				const callback = registry.register({
					targetAgentId: 'agent',
					targetTabId: 'tab',
					callerAgentId: 'agent',
					prompt: record.queuePrepare!.item.text,
					pendingAdmissionId: f.input.dispatchId,
					timeoutMs: 60000,
				});
				record.queuePrepare!.callbackId = callback.callbackId;
				record.queuePrepare!.callbackProof = {
					registration: {
						targetAgentId: 'agent',
						targetTabId: 'tab',
						callerAgentId: 'agent',
						prompt: record.queuePrepare!.item.text,
						pendingAdmissionId: f.input.dispatchId,
						timeoutMs: 60000,
					},
					expiresAt: callback.expiresAt,
					owner: f.snapshot.owners[0],
				};
				f.store.writeDispatchAdmission(record);
				Object.assign(f.deps, { callbackRegistry: () => registry });
				let destroyed = false;
				const owner = { id: 7, isDestroyed: () => destroyed };
				const peerManager = Object.assign(new EventEmitter(), {
					spawn: vi.fn((config: { sessionId: string }) => {
						if (scenario === 'partial-unknown') throw new Error('Spawn acknowledgement lost');
						if (scenario === 'partial-unknown-false' && peerManager.spawn.mock.calls.length === 2)
							return { success: false, pid: -1 };
						if (scenario === 'fast') {
							peerManager.emit('data', config.sessionId, 'Fast reply');
							peerManager.emit('exit', config.sessionId, 0);
						}
						return { success: true, pid: 4242 };
					}),
					kill: vi.fn(),
				});
				const settled = vi.fn();
				let continuation: Promise<void> | undefined;
				registerCrossAgentHandlers({
					getWebServer: () =>
						({
							prepareQueueSpawnFromMain: (
								...args: Parameters<typeof f.adapter.prepareQueueSpawn>
							) => f.adapter.prepareQueueSpawn(...args),
							startQueueHandoffFromMain: (
								...args: Parameters<typeof f.adapter.startQueueHandoff>
							) => f.adapter.startQueueHandoff(...args),
						}) as never,
					getWindowForSession: () => ({ webContents: owner }) as never,
					getProcessManager: () => peerManager as never,
					getAgentDetector: () =>
						({
							getAgent: async () => {
								if (scenario === 'provider-setup-fail') throw new Error('Provider setup failed');
								if (scenario === 'peer-revoke') current[0].peerAgents = [];
								if (scenario === 'pause') f.snapshot.tabs[0].paused = true;
								if (scenario === 'owner-reset') destroyed = true;
								return { ...getAgentDefinition('codex'), available: true };
							},
						}) as never,
					sessionsStore: mockSessionsStore as never,
					agentConfigsStore: { get: (_k: string, fallback: unknown) => fallback } as never,
					settingsStore: { get: (_k: string, fallback: unknown) => fallback } as never,
					sshStore: null,
					safeSend: (channel, result) => {
						if (channel === 'cross-agent:queue-settled') settled(result);
					},
				});
				const call = (channel: string, payload: unknown) =>
					handlers.get(channel)!(
						{ sender: owner, ...(scenario === 'foreign-socket' ? { clientId: 'foreign' } : {}) },
						payload
					);
				vi.stubGlobal('window', {
					maestro: {
						crossAgent: {
							prepareQueue: (payload: unknown) => call('cross-agent:prepare-queue', payload),
							send: (payload: unknown) => call('cross-agent:send', payload),
						},
						process: { spawn: (payload: unknown) => call('process:spawn', payload) },
						agents: { get: async () => ({ ...getAgentDefinition('codex'), available: true }) },
						settings: { set: vi.fn() },
						prompts: { get: async () => ({ success: true, content: '' }) },
						sessions: {
							setMany: async (updates: StoredSession[]) => {
								await save(updates);
							},
						},
					},
				});
				try {
					const { useAgentStore } = await import('../../../../renderer/stores/agentStore');
					const { useSessionStore } = await import('../../../../renderer/stores/sessionStore');
					const { settleManagedQueue } =
						await import('../../../../renderer/services/crossAgentConsultHold');
					const { createMockSession } = await import('../../../helpers/mockSession');
					const { createMockAITab } = await import('../../../helpers/mockTab');
					const { registerSessionPersistenceFlush } =
						await import('../../../../renderer/services/sessionPersistenceFlush');
					registerSessionPersistenceFlush(async () => {});
					settled.mockImplementation((result) => {
						if (scenario === 'reply-peer-revoke' && result.continuationStepId)
							current[0].peerAgents = [];
						if (result.continuationStepId || result.handoff) {
							if (scenario === 'deferred-pause') f.snapshot.tabs[0].paused = true;
							if (scenario === 'deferred-reset') f.snapshot.tabs[0].createdAt++;
							if (scenario === 'deferred-owner') destroyed = true;
							if (scenario === 'deferred-policy') f.store.writeSupervisorTargets([]);
							if (scenario === 'deferred-target-deletion') {
								current = current.filter((a) => a.id !== 'peer-b');
								useSessionStore.setState({
									sessions: useSessionStore.getState().sessions.filter((a) => a.id !== 'peer-b'),
								});
							}
						}
						continuation = settleManagedQueue(result);
						if (scenario === 'deferred-double' && (result.continuationStepId || result.handoff)) {
							void settleManagedQueue(result).catch(() => {});
						}
						void continuation.catch(() => {});
					});
					const sessions = current.map((a) =>
						createMockSession({
							...a,
							activeTabId: a.id === 'agent' ? 'tab' : '',
							aiTabs:
								a.aiTabs?.map((t: Record<string, unknown>) => createMockAITab(t as never)) ?? [],
						} as never)
					);
					useSessionStore.setState({ sessions, groups: [] });
					const item = useSessionStore.getState().sessions[0].executionQueue[0];
					const drain = () =>
						useAgentStore.getState().processQueuedItem('agent', item, {
							conductorProfile: '',
							customAICommands: [],
							speckitCommands: [],
							openspecCommands: [],
						});
					if (mode === 'handoff' && ['peer-revoke', 'pause', 'owner-reset'].includes(scenario)) {
						if (scenario === 'peer-revoke') current[0].peerAgents = [];
						if (scenario === 'pause') f.snapshot.tabs[0].paused = true;
						if (scenario === 'owner-reset') destroyed = true;
					}
					if (scenario === 'callback-restore') registry.cancel(callback.callbackId);
					if (scenario === 'local-unknown' && mode === 'handoff') f.unknown();
					if (scenario.startsWith('setup-')) {
						vi.mocked(systemPromptService.buildMaestroSystemPromptForSession).mockImplementation(
							async (target) => {
								if (
									typeof target === 'string' &&
									target !== 'agent' &&
									(scenario === 'setup-both-fail' ||
										(scenario === 'setup-one-fail' && target === 'peer-a'))
								)
									throw new Error('System prompt preparation failed');
								if (scenario === 'setup-cancel' && target === 'peer-a')
									cancelCrossAgentRequestsForSource('agent', 'tab');
								return 'Host system prompt';
							}
						);
					}
					const pending = drain();
					if (['peer-revoke', 'pause', 'owner-reset', 'foreign-socket'].includes(scenario)) {
						await expect(pending).rejects.toThrow();
						expect(peerManager.spawn).not.toHaveBeenCalled();
						expect(f.spawn).not.toHaveBeenCalled();
						expect(fires).not.toHaveBeenCalled();
						registerSessionPersistenceFlush(null);
						return;
					}
					if (scenario === 'local-unknown' && mode === 'handoff') {
						await expect(pending).rejects.toThrow('Native spawn acknowledgement lost');
						expect(fires).not.toHaveBeenCalled();
						expect(peerManager.spawn).not.toHaveBeenCalled();
						await expect(drain()).resolves.toBe(false);
						return;
					}
					if (scenario === 'double-drain') await expect(drain()).rejects.toThrow();
					await pending;
					if (scenario.startsWith('setup-') || scenario === 'provider-setup-fail') {
						// Parallel still owns the local child; handoff cannot start before its real exit.
						if (mode === 'parallel' || mode === 'handoff') {
							expect(fires).not.toHaveBeenCalled();
							await f.capture.captureExit({
								sessionId: 'agent-ai-tab',
								exitCode: 0,
								settlement: { outcome: 'completed', answerTail: 'Local native output' } as never,
							});
							f.events.emit('exit', 'agent-ai-tab', 0);
							await continuation;
						}
						const routing = f.store.readDispatchAdmission(f.input.dispatchId)!.queueRouting!;
						const branches = routing.steps.filter(
							(s) => s.kind === (mode === 'handoff' ? 'handoff' : 'consult')
						);
						expect(branches).toHaveLength(2);
						const failures = branches.filter((s) => s.terminal?.error || s.terminal?.canceled);
						expect(failures).toHaveLength(
							['setup-one-fail', 'setup-cancel'].includes(scenario) ? 1 : 2
						);
						for (const step of failures) {
							expect(step.processId).toBeUndefined();
							expect(step.agentSessionId).toBeUndefined();
						}
						if (['setup-one-fail', 'setup-cancel'].includes(scenario)) {
							expect(fires).not.toHaveBeenCalled();
							expect(peerManager.listenerCount('exit')).toBe(1);
							const live = branches.find((s) => !s.terminal)!;
							peerManager.emit('exit', 'cross-agent-foreign', 0);
							expect(fires).not.toHaveBeenCalled();
							peerManager.emit('data', `cross-agent-${live.requestId}`, 'Real surviving child');
							peerManager.emit('exit', `cross-agent-${live.requestId}`, 0);
							peerManager.emit('exit', `cross-agent-${live.requestId}`, 0);
						}
						await continuation;
						expect(fires).toHaveBeenCalledExactlyOnceWith(
							expect.objectContaining({ status: 'failed' })
						);
						expect(peerManager.spawn).toHaveBeenCalledTimes(
							['setup-one-fail', 'setup-cancel'].includes(scenario) ? 1 : 0
						);
						expect(peerManager.eventNames()).toEqual([]);
						expect(useSessionStore.getState().sessions[0].executionQueue).toHaveLength(0);
						await expect(drain()).rejects.toThrow();
						expect(peerManager.spawn).toHaveBeenCalledTimes(
							['setup-one-fail', 'setup-cancel'].includes(scenario) ? 1 : 0
						);
						return;
					}
					if (mode === 'handoff') expect(peerManager.spawn).not.toHaveBeenCalled();
					else expect(peerManager.spawn).toHaveBeenCalledTimes(2);
					expect(f.spawn).toHaveBeenCalledTimes(
						mode === 'only' || mode === 'consult-first' ? 0 : 1
					);
					if (
						!((mode === 'only' || mode === 'handoff') && scenario === 'fast') &&
						!['local-cancel', 'empty-output'].includes(scenario)
					)
						expect(fires).not.toHaveBeenCalled();
					const journal = f.store.readDispatchAdmission(f.input.dispatchId)!;
					expect(journal.queueRouting!.steps.filter((s) => s.kind === 'local')).toHaveLength(
						mode === 'only' ? 0 : mode === 'parallel' ? 2 : 1
					);
					if (mode === 'parallel') {
						const reply = journal.queueRouting!.steps.find((s) => s.stage === 'reply')!;
						await expect(
							call('process:spawn', {
								sessionId: 'agent-ai-tab',
								pianolaDispatchId: f.input.dispatchId,
								pianolaQueueItemId: f.input.dispatchId,
								pianolaQueueStepId: reply.requestId,
							})
						).rejects.toThrow();
						expect(f.spawn).toHaveBeenCalledTimes(1);
					}
					if (mode === 'consult-first' && scenario !== 'fast') {
						const local = journal.queueRouting!.steps.find((s) => s.kind === 'local')!;
						await expect(
							call('process:spawn', {
								sessionId: 'agent-ai-tab',
								pianolaDispatchId: f.input.dispatchId,
								pianolaQueueItemId: f.input.dispatchId,
								pianolaQueueStepId: local.requestId,
								agentContext: 'Forged replies',
							})
						).rejects.toThrow();
						expect(f.spawn).not.toHaveBeenCalled();
					}
					if (mode === 'parallel' && scenario !== 'local-last') {
						await f.capture.captureExit({
							sessionId: 'agent-ai-tab',
							exitCode: 0,
							settlement: { outcome: 'completed', answerTail: 'Local native output' } as never,
						});
						f.events.emit('exit', 'agent-ai-tab', 0);
						registry.noteSpawn('agent-ai-tab');
						registry.noteExit('agent-ai-tab', 0);
						expect(fires).not.toHaveBeenCalled();
					}
					if (scenario === 'local-output-tamper') {
						const tampered = f.store.readDispatchAdmission(f.input.dispatchId)!;
						tampered.queueRouting!.steps.find(
							(s) => s.kind === 'local' && !s.stage
						)!.terminal!.text = 'Unrelated output';
						f.store.writeDispatchAdmission(tampered);
					}
					if (scenario === 'callback-reset')
						f.snapshot.owners = f.snapshot.owners.map((o) => ({ ...o, cwd: '/replacement' }));
					if (scenario === 'restart') f.adapter.admission.dispose();
					if (scenario === 'delete-row') {
						deps.cancelQueueItem = (agentId, tabId, itemId) =>
							f.adapter.cancelQueueItem(agentId, tabId, itemId);
						await save(current.map((a) => (a.id === 'agent' ? { ...a, executionQueue: [] } : a)));
						expect(f.store.readDispatchAdmission(f.input.dispatchId)?.queueCancelled).toBe(true);
					}
					if (scenario === 'human-turn') {
						f.capture.captureSpawn({
							sessionId: 'agent-ai-tab',
							toolType: 'codex',
							cwd: '/project',
							tabId: 'tab',
							nativeTabSession: { agentId: 'agent', tabId: 'tab', createdAt: 1 },
						});
					}
					if (mode === 'handoff' && scenario !== 'local-unknown') {
						if (scenario === 'handoff-peer-revoke') current[0].peerAgents = [];
						if (scenario === 'first-announcement') {
							f.capture.captureSessionAnnouncement('agent-ai-tab', 'native-first-session');
							f.snapshot.tabs[0].agentSessionId = 'native-first-session';
							current[0].aiTabs[0].agentSessionId = 'native-first-session';
						}
						await f.capture.captureExit({
							sessionId: 'agent-ai-tab',
							exitCode: scenario === 'local-cancel' ? 1 : 0,
							settlement: {
								outcome: scenario === 'local-cancel' ? 'cancelled' : 'completed',
								answerTail: scenario === 'empty-output' ? '' : 'Local native output',
							} as never,
						});
						f.events.emit('exit', 'agent-ai-tab', 0);
						registry.noteSpawn('agent-ai-tab');
						registry.noteExit('agent-ai-tab', 0);
						if (scenario === 'output-tamper') {
							const changed = f.store.readDispatchAdmission(f.input.dispatchId)!;
							changed.queueRouting!.steps.find((s) => s.kind === 'local')!.terminal!.text =
								'Foreign answer';
							f.store.writeDispatchAdmission(changed);
						}
						await continuation?.catch(() => {});
					}
					if (mode === 'handoff' && scenario === 'human-turn') {
						expect(peerManager.spawn).not.toHaveBeenCalled();
						expect(fires).toHaveBeenCalledExactlyOnceWith(
							expect.objectContaining({ status: 'failed' })
						);
						return;
					}
					if (scenario === 'terminal-journal') {
						const write = f.store.writeDispatchAdmission.bind(f.store);
						vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((value) => {
							if (
								value.queueRouting?.steps.some(
									(s) => s.kind === (mode === 'handoff' ? 'handoff' : 'consult') && s.terminal
								)
							)
								throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
							return write(value);
						});
					}
					peerManager.emit('exit', 'cross-agent-foreign', 0);
					if (
						!((mode === 'only' || mode === 'handoff') && scenario === 'fast') &&
						!['local-cancel', 'empty-output'].includes(scenario)
					)
						expect(fires).not.toHaveBeenCalled();
					const consults = journal.queueRouting!.steps.filter(
						(s) => s.kind === (mode === 'handoff' ? 'handoff' : 'consult')
					);
					for (const [index, step] of consults.entries()) {
						peerManager.emit('data', `cross-agent-${step.requestId}`, 'Native reply');
						peerManager.emit(
							'exit',
							`cross-agent-${step.requestId}`,
							scenario === 'failed' ? 1 : 0
						);
						if (
							index === 0 &&
							scenario !== 'fast' &&
							!['local-cancel', 'empty-output'].includes(scenario)
						)
							expect(fires).not.toHaveBeenCalled();
					}
					if (mode === 'parallel' && scenario === 'local-last') {
						expect(fires).not.toHaveBeenCalled();
						await f.capture.captureExit({
							sessionId: 'agent-ai-tab',
							exitCode: 0,
							settlement: { outcome: 'completed', answerTail: 'Last local output' } as never,
						});
						f.events.emit('exit', 'agent-ai-tab', 0);
					}
					if (
						[
							'partial-unknown',
							'partial-unknown-false',
							'terminal-journal',
							'delete-row',
							'callback-reset',
							'restart',
							'local-output-tamper',
							'reply-peer-revoke',
							'handoff-peer-revoke',
							'human-turn',
							'local-unknown',
							'output-tamper',
						].includes(scenario) &&
						!(mode === 'consult-first' && scenario === 'local-unknown')
					) {
						expect(fires).not.toHaveBeenCalled();
						if (scenario === 'reply-peer-revoke') {
							await expect(continuation).rejects.toThrow();
							expect(f.spawn).toHaveBeenCalledTimes(mode === 'consult-first' ? 0 : 1);
						} else if (mode !== 'handoff') expect(settled).not.toHaveBeenCalled();
						expect(useSessionStore.getState().sessions[0].executionQueue).toHaveLength(1);
						await expect(drain()).resolves.toBe(false);
						registerSessionPersistenceFlush(null);
						return;
					}
					if (scenario.startsWith('deferred-') && scenario !== 'deferred-double') {
						await continuation?.catch(() => {});
						expect(fires).not.toHaveBeenCalled();
						expect(f.spawn).toHaveBeenCalledTimes(mode === 'handoff' ? 1 : 0);
						expect(peerManager.spawn).toHaveBeenCalledTimes(mode === 'handoff' ? 0 : 2);
						await expect(drain()).resolves.toBe(false);
						return;
					}
					if ((mode === 'parallel' || mode === 'consult-first') && scenario !== 'failed') {
						expect(fires).not.toHaveBeenCalled();
						if (scenario === 'local-unknown') {
							f.unknown();
							await expect(continuation).rejects.toThrow('Native spawn acknowledgement lost');
							expect(fires).not.toHaveBeenCalled();
							await expect(drain()).resolves.toBe(false);
							return;
						}
						await continuation;
						if (scenario === 'first-announcement') {
							f.capture.captureSessionAnnouncement('agent-ai-tab', 'native-first-session');
							f.snapshot.tabs[0].agentSessionId = 'native-first-session';
							current[0].aiTabs[0].agentSessionId = 'native-first-session';
						}
						expect(f.spawn).toHaveBeenCalledTimes(mode === 'parallel' ? 2 : 1);
						const replyConfig = f.spawn.mock.calls[mode === 'parallel' ? 1 : 0][0];
						expect(replyConfig.prompt).toContain('Check @PeerA and @PeerB');
						expect(replyConfig.prompt).toContain(
							scenario === 'fast' ? 'Fast reply' : 'Native reply'
						);
						if (mode === 'parallel')
							expect(replyConfig.prompt).toContain(
								scenario === 'local-last' ? 'Last local output' : 'Local native output'
							);
						await f.capture.captureExit({
							sessionId: 'agent-ai-tab',
							exitCode: scenario === 'local-cancel' ? 1 : 0,
							settlement: {
								outcome: scenario === 'local-cancel' ? 'cancelled' : 'completed',
								answerTail: 'Final combined answer',
							} as never,
						});
					}
					if (mode === 'handoff' && !['local-cancel', 'empty-output'].includes(scenario)) {
						for (const [config] of peerManager.spawn.mock.calls)
							expect(config).toMatchObject({
								prompt: expect.stringContaining('Local native output'),
							});
						expect(
							useSessionStore.getState().sessions[0].aiTabs[0].pendingMentionHandoff
						).toBeUndefined();
					}
					expect(fires).toHaveBeenCalledTimes(1);
					expect(fires.mock.calls[0][0]).toMatchObject({
						status: ['failed', 'local-cancel', 'empty-output'].includes(scenario)
							? 'failed'
							: 'completed',
						entry: { pendingAdmissionId: f.input.dispatchId },
					});
					expect(settled).toHaveBeenCalledTimes(
						((mode === 'parallel' || mode === 'consult-first') && scenario !== 'failed') ||
							(mode === 'handoff' && !['local-cancel', 'empty-output'].includes(scenario))
							? 2
							: 1
					);
					expect(useSessionStore.getState().sessions[0].executionQueue).toHaveLength(0);
					await expect(
						call('cross-agent:prepare-queue', {
							sourceSessionId: 'agent',
							sourceTabId: 'tab',
							dispatchId: f.input.dispatchId,
						})
					).rejects.toThrow();
					expect(peerManager.spawn).toHaveBeenCalledTimes(
						mode === 'handoff' && ['local-cancel', 'empty-output'].includes(scenario) ? 0 : 2
					);
					expect(
						useSessionStore
							.getState()
							.sessions[0].aiTabs[0].logs.filter(
								(log) => log.source === 'user' && log.queuedItemId === item.id
							)
					).toHaveLength(1);
					for (const step of consults) peerManager.emit('exit', `cross-agent-${step.requestId}`, 0);
					expect(fires).toHaveBeenCalledTimes(1);
					registerSessionPersistenceFlush(null);
				} finally {
					await f.capture.captureExit({ sessionId: 'agent-ai-tab', exitCode: 1 });
					f.events.emit('exit', 'agent-ai-tab', 1);
					// Fixture teardown: clear an uncertain native fence only after no-resend assertions.
					pianolaNewTabSpawns.started(
						'agent-ai-tab',
						undefined,
						f.input.dispatchId,
						f.input.dispatchId
					);
					f.cleanup();
					vi.unstubAllGlobals();
				}
			}
		);

		it('hands off only real own native terminal output to two pinned recipients exactly once', async () => {
			const local = await managedLocalFixture('handoff');
			try {
				await local.start();
				const f = await managedConsultFixture('handoff', local);
				await expect(f.start()).rejects.toThrow('LocalOutputUnavailable');
				await local.capture.captureExit({
					sessionId: 'agent-ai-tab',
					exitCode: 0,
					settlement: { outcome: 'completed', answerTail: 'Authentic local answer' } as never,
				});
				// The original row is gone and the source is still marked busy by its own run.
				current[0].executionQueue = [];
				const a = await f.start();
				const b = await f.start('peer-b');
				expect(f.manager.spawn).toHaveBeenCalledTimes(2);
				for (const [config] of f.manager.spawn.mock.calls) {
					expect(JSON.stringify(config)).toContain('Authentic local answer');
					expect(JSON.stringify(config)).not.toContain('Renderer tamper');
				}
				await expect(f.start()).rejects.toThrow('AlreadyClaimed');
				for (const r of [a, b]) {
					f.manager.emit('data', `cross-agent-${r.requestId}`, 'Received');
					f.manager.emit('exit', `cross-agent-${r.requestId}`, 0);
				}
				const record = f.store.readDispatchAdmission(f.input.dispatchId)!;
				expect(
					record.queueRouting!.steps.filter((s) => s.kind === 'handoff').map((s) => s.terminal)
				).toEqual([{ text: 'Received' }, { text: 'Received' }]);
				await expect(f.start()).rejects.toThrow('ReleaseUnavailable');
			} finally {
				local.cleanup();
			}
		});

		it.each([
			'output',
			'peer',
			'reset',
			'human',
			'deleted',
			'intent',
			'generation',
			'stop',
		] as const)(
			'blocks handoff after %s changes without permitting a new native branch',
			async (change) => {
				const local = await managedLocalFixture('handoff');
				try {
					await local.start();
					await local.capture.captureExit({
						sessionId: 'agent-ai-tab',
						exitCode: 0,
						settlement: { outcome: 'completed', answerTail: 'Native answer' } as never,
					});
					const f = await managedConsultFixture('handoff', local);
					const record = f.store.readDispatchAdmission(f.input.dispatchId)!;
					if (change === 'output') {
						record.queueRouting!.steps.find((s) => s.kind === 'local')!.terminal!.text =
							'Forged answer';
						f.store.writeDispatchAdmission(record);
					}
					if (change === 'peer') current[0].peerAgents![0].write = false;
					if (change === 'stop') sweepQueueConsultReleases(true);
					if (change === 'reset') f.snapshot.tabs[0].createdAt++;
					if (change === 'deleted') current.splice(1, 1);
					if (change === 'intent') {
						record.queuePrepare!.item.text = 'Different task';
						f.store.writeDispatchAdmission(record);
					}
					if (change === 'generation') {
						record.queueRelease!.generation = generateUUID();
						f.store.writeDispatchAdmission(record);
					}
					if (change === 'human') {
						const old = f.deps.readNativeRuns()[0];
						f.upsertNativeRun({ ...old, id: 'intervening-human', createdAt: old.createdAt + 1 });
					}
					await expect(f.start()).rejects.toThrow();
					expect(f.manager.spawn).not.toHaveBeenCalled();
				} finally {
					local.cleanup();
				}
			}
		);

		it.each([false, true])(
			'waits for both native consult replies then starts one host-derived continuation through owner IPC (fast=%s)',
			async (fast) => {
				const local = await managedLocalFixture('consult-first');
				try {
					const f = await managedConsultFixture('consult-first', local);
					if (fast)
						f.manager.spawn.mockImplementationOnce((config) => {
							const id = (config as { sessionId: string }).sessionId;
							f.manager.emit('data', id, 'Actual A');
							f.manager.emit('exit', id, 0);
							return { success: true, pid: 4242 };
						});
					await expect(local.start()).rejects.toThrow('RepliesUnavailable');
					const a = await f.start();
					const b = await f.start('peer-b');
					f.manager.emit('data', 'cross-agent-foreign', 'Foreign output');
					f.manager.emit('exit', 'cross-agent-foreign', 0);
					f.manager.emit('data', `cross-agent-${a.requestId}`, 'Actual A');
					f.manager.emit('exit', `cross-agent-${a.requestId}`, 0);
					await expect(local.start()).rejects.toThrow('RepliesUnavailable');
					f.manager.emit('data', `cross-agent-${b.requestId}`, 'Actual B');
					f.manager.emit('exit', `cross-agent-${b.requestId}`, 0);
					vi.mocked(promptManager.getPrompt).mockImplementation((id) =>
						id === 'cross-agent-consult-first' ? '{{USER_MESSAGE}}\n{{CONSULT_REPLIES}}' : id
					);
					const result = await local.start();
					expect(result.success).toBe(true);
					expect(local.spawn).toHaveBeenCalledOnce();
					const prompt = local.spawn.mock.calls[0][0].prompt;
					expect(prompt).toContain('Actual A');
					expect(prompt).toContain('Actual B');
					expect(prompt).toContain('Check @PeerA and @PeerB');
					expect(prompt).not.toContain('Arbitrary continuation');
					expect(prompt).not.toContain('Foreign output');
					await local.start();
					expect(local.spawn).toHaveBeenCalledOnce();
					await local.capture.captureExit({
						sessionId: 'agent-ai-tab',
						exitCode: 0,
						settlement: { outcome: 'completed', answerTail: 'Synthesis' } as never,
					});
					expect(
						f.store
							.readDispatchAdmission(f.input.dispatchId)!
							.queueRouting!.steps.find((s) => s.kind === 'local')!.terminal?.text
					).toBe('Synthesis');
				} finally {
					local.cleanup();
				}
			}
		);

		it.each(['error', 'cancel', 'unknown', 'tamper', 'peer', 'human', 'restart'] as const)(
			'does not release a consult-first continuation after %s',
			async (change) => {
				const local = await managedLocalFixture('consult-first');
				try {
					const f = await managedConsultFixture('consult-first', local);
					const a = await f.start();
					const b = await f.start('peer-b');
					f.manager.emit('data', `cross-agent-${a.requestId}`, 'A');
					f.manager.emit('exit', `cross-agent-${a.requestId}`, 0);
					if (change === 'cancel') cancelCrossAgentRequestsForSource('agent', 'tab');
					else if (change !== 'unknown') {
						f.manager.emit('data', `cross-agent-${b.requestId}`, 'B');
						f.manager.emit('exit', `cross-agent-${b.requestId}`, change === 'error' ? 1 : 0);
					}
					if (change === 'tamper') {
						const r = f.store.readDispatchAdmission(f.input.dispatchId)!;
						r.queueRouting!.steps[0].terminal!.text = 'Foreign reply';
						f.store.writeDispatchAdmission(r);
					}
					if (change === 'peer') current[0].peerAgents![0].read = false;
					if (change === 'human') {
						local.capture.captureSpawn({
							sessionId: 'agent-ai-tab',
							toolType: 'codex',
							cwd: directory,
							tabId: 'tab',
							prompt: 'Human intervening turn',
							nativeTabSession: { agentId: 'agent', tabId: 'tab', createdAt: 1 },
						});
						f.snapshot.tabs[0].busy = false;
					}
					if (change === 'restart') {
						f.adapter.admission.dispose();
					}
					await expect(local.start()).rejects.toThrow();
					expect(local.spawn).not.toHaveBeenCalled();
					await expect(f.start()).rejects.toThrow();
					expect(f.manager.spawn).toHaveBeenCalledTimes(2);
				} finally {
					local.cleanup();
				}
			}
		);

		it('preserves partial handoff Unknown across disposal without repeating either target', async () => {
			const local = await managedLocalFixture('handoff');
			try {
				await local.start();
				await local.capture.captureExit({
					sessionId: 'agent-ai-tab',
					exitCode: 0,
					settlement: { outcome: 'completed', answerTail: 'Real output' } as never,
				});
				const f = await managedConsultFixture('handoff', local);
				const a = await f.start();
				f.manager.spawn.mockImplementationOnce(() => {
					throw new Error('Lost native acknowledgement');
				});
				await f.start('peer-b');
				const record = f.store.readDispatchAdmission(f.input.dispatchId)!;
				expect(record.queueRouting!.steps.find((s) => s.targetAgentId === 'peer-b')).toMatchObject({
					status: 'unknown',
				});
				await expect(f.start('peer-b')).rejects.toThrow('AlreadyClaimed');
				f.adapter.admission.dispose();
				await expect(f.start()).rejects.toThrow('ReleaseUnavailable');
				await expect(f.start('peer-b')).rejects.toThrow('ReleaseUnavailable');
				// A legitimate already-started child still owns its terminal.
				f.manager.emit('data', `cross-agent-${a.requestId}`, 'Delivered A');
				f.manager.emit('exit', `cross-agent-${a.requestId}`, 0);
				expect(
					f.store.readDispatchAdmission(f.input.dispatchId)!.queueRouting!.steps[0].terminal?.text
				).toBe('Delivered A');
				expect(f.manager.spawn).toHaveBeenCalledTimes(2);
			} finally {
				local.cleanup();
			}
		});

		it.each(['peer', 'pause', 'output'] as const)(
			'revalidates handoff %s after asynchronous native preparation',
			async (change) => {
				const local = await managedLocalFixture('handoff');
				try {
					await local.start();
					await local.capture.captureExit({
						sessionId: 'agent-ai-tab',
						exitCode: 0,
						settlement: { outcome: 'completed', answerTail: 'Real output' } as never,
					});
					const f = await managedConsultFixture('handoff', local);
					vi.mocked(systemPromptService.buildMaestroSystemPromptForSession).mockImplementation(
						async () => {
							if (change === 'peer') current[0].peerAgents![0].write = false;
							if (change === 'pause') f.snapshot.tabs[0].paused = true;
							if (change === 'output') {
								const r = f.store.readDispatchAdmission(f.input.dispatchId)!;
								r.queueRouting!.steps.find((s) => s.kind === 'local')!.terminal!.text =
									'Tampered during await';
								f.store.writeDispatchAdmission(r);
							}
							return undefined;
						}
					);
					await f.start();
					expect(f.manager.spawn).not.toHaveBeenCalled();
					expect(
						f.store.readDispatchAdmission(f.input.dispatchId)!.queueRouting!.steps[0].terminal
							?.error
					).toBeTruthy();
					await expect(f.start()).rejects.toThrow();
				} finally {
					local.cleanup();
				}
			}
		);

		it.each(['ENOSPC', 'EACCES'])(
			'keeps a positive native spawn supervised after %s start-journal failure until Stop',
			async (code) => {
				const f = await managedConsultFixture();
				const write = f.store.writeDispatchAdmission.bind(f.store);
				vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
					if (record.queueRouting?.steps.some((s) => s.status === 'started'))
						throw Object.assign(new Error(code), { code });
					write(record);
				});
				const { requestId } = await f.start();
				expect(f.manager.spawn).toHaveBeenCalledTimes(1);
				expect(f.manager.listenerCount('exit')).toBeGreaterThan(0);
				expect(f.chunks).toEqual([]);
				const step = () =>
					f.store.readDispatchAdmission(f.input.dispatchId)!.queueRouting!.steps[0];
				expect(step()).toMatchObject({ status: 'unknown' });
				expect(step().terminal).toBeUndefined();
				await expect(f.start()).rejects.toThrow('ReleaseUnavailable');
				expect(cancelCrossAgentRequestsForSource('agent', 'tab')).toBe(1);
				expect(f.manager.kill).toHaveBeenCalledExactlyOnceWith(`cross-agent-${requestId}`);
				expect(f.manager.eventNames()).toEqual([]);
				expect(f.chunks).toEqual([
					expect.objectContaining({
						done: true,
						canceled: true,
						error: 'DispatchRoutingJournalUnknown',
					}),
				]);
				expect(step().terminal).toBeUndefined();
			}
		);

		it('keeps a real child through natural exit after start-journal failure without claiming success', async () => {
			const f = await managedConsultFixture();
			const write = f.store.writeDispatchAdmission.bind(f.store);
			vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
				if (record.queueRouting?.steps.some((s) => s.status === 'started'))
					throw new Error('EACCES');
				write(record);
			});
			const { requestId } = await f.start();
			f.manager.emit('session-id', `cross-agent-${requestId}`, 'actual-provider-session');
			f.manager.emit('data', `cross-agent-${requestId}`, 'Actual output');
			f.manager.emit('exit', `cross-agent-${requestId}`, 0);
			expect(f.manager.eventNames()).toEqual([]);
			expect(f.chunks).toEqual([
				expect.objectContaining({
					done: true,
					chunk: '',
					error: 'DispatchRoutingJournalUnknown',
					targetAgentSessionId: undefined,
				}),
			]);
			expect(
				f.store.readDispatchAdmission(f.input.dispatchId)!.queueRouting!.steps[0]
			).toMatchObject({ status: 'unknown' });
			await expect(f.start()).rejects.toThrow();
			expect(cancelCrossAgentRequestsForSource('agent', 'tab')).toBe(0);
		});

		it('retains watchdog ownership after a start-journal failure', async () => {
			const f = await managedConsultFixture();
			vi.useFakeTimers();
			const write = f.store.writeDispatchAdmission.bind(f.store);
			vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
				if (record.queueRouting?.steps.some((s) => s.status === 'started'))
					throw new Error('ENOSPC');
				write(record);
			});
			const { requestId } = await f.start();
			await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
			expect(f.manager.kill).toHaveBeenCalledExactlyOnceWith(`cross-agent-${requestId}`);
			expect(f.manager.eventNames()).toEqual([]);
			expect(f.chunks).toEqual([
				expect.objectContaining({ done: true, error: 'DispatchRoutingJournalUnknown' }),
			]);
			await expect(f.start()).rejects.toThrow();
			expect(f.manager.spawn).toHaveBeenCalledTimes(1);
		});

		it('keeps a failed terminal journal uncertain without emitting success or resending', async () => {
			const f = await managedConsultFixture();
			const { requestId } = await f.start();
			const write = f.store.writeDispatchAdmission.bind(f.store);
			vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
				if (record.queueRouting?.steps.some((s) => s.terminal)) throw new Error('EACCES');
				write(record);
			});
			f.manager.emit('data', `cross-agent-${requestId}`, 'Actual native answer');
			expect(() => f.manager.emit('exit', `cross-agent-${requestId}`, 0)).not.toThrow();
			expect(f.manager.eventNames()).toEqual([]);
			expect(f.chunks).toEqual([
				expect.objectContaining({ done: true, chunk: '', error: 'DispatchRoutingJournalUnknown' }),
			]);
			expect(
				f.store.readDispatchAdmission(f.input.dispatchId)!.queueRouting!.steps[0].terminal
			).toBeUndefined();
			await expect(f.start()).rejects.toThrow();
			expect(f.manager.spawn).toHaveBeenCalledTimes(1);
		});

		it('records a real fast exit before spawn acknowledgement without a later started write', async () => {
			const f = await managedConsultFixture();
			const requestId = f.store.readDispatchAdmission(f.input.dispatchId)!.queueRouting!.steps[0]
				.requestId;
			const write = f.store.writeDispatchAdmission.bind(f.store);
			vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
				if (record.queueRouting?.steps.some((s) => s.pid))
					throw new Error('ENOSPC late start journal');
				write(record);
			});
			f.manager.spawn.mockImplementationOnce(() => {
				f.manager.emit('data', `cross-agent-${requestId}`, 'Fast native answer');
				f.manager.emit('exit', `cross-agent-${requestId}`, 0);
				return { success: true, pid: 4242 };
			});
			await f.start();
			expect(
				f.store.readDispatchAdmission(f.input.dispatchId)!.queueRouting!.steps[0]
			).toMatchObject({ status: 'settled', terminal: { text: 'Fast native answer' } });
			expect(f.manager.eventNames()).toEqual([]);
			expect(f.chunks).toHaveLength(1);
			await expect(f.start()).rejects.toThrow();
			expect(f.manager.spawn).toHaveBeenCalledTimes(1);
		});

		it.each(['cancel', 'expiry', 'policy', 'dispose', 'stop'] as const)(
			'revokes %s release authority while preserving a live child and its terminal',
			async (reason) => {
				const f = await managedConsultFixture();
				const { requestId } = await f.start();
				if (reason === 'cancel') f.adapter.cancelQueueItem('agent', 'tab', f.input.dispatchId);
				if (reason === 'expiry') {
					vi.useFakeTimers();
					vi.setSystemTime(Date.now() + 86_400_001);
				}
				if (reason === 'policy') f.store.writeSupervisorTargets([]);
				if (reason === 'dispose') f.adapter.admission.dispose();
				const supervisor = new PianolaSupervisor({
					isEnabled: () => false,
					getPianolaAgentId: () => undefined,
				});
				if (reason === 'stop') supervisor.stopAll();
				supervisor.getHealth();
				await expect(f.start('peer-b')).rejects.toThrow('ReleaseUnavailable');
				expect(f.manager.kill).not.toHaveBeenCalled();
				f.manager.emit('data', `cross-agent-${requestId}`, 'Owned child after revocation');
				f.manager.emit('exit', `cross-agent-${requestId}`, 0);
				expect(
					f.store.readDispatchAdmission(f.input.dispatchId)!.queueRouting!.steps[0].terminal
				).toMatchObject({ text: 'Owned child after revocation' });
				expect(f.manager.eventNames()).toEqual([]);
			}
		);

		it('revokes a pending branch during native preparation before it may create a child', async () => {
			const f = await managedConsultFixture();
			vi.mocked(systemPromptService.buildMaestroSystemPromptForSession).mockImplementationOnce(
				async () => {
					sweepQueueConsultReleases(true);
					return undefined;
				}
			);
			await f.start();
			expect(f.manager.spawn).not.toHaveBeenCalled();
			expect(f.manager.eventNames()).toEqual([]);
			await expect(f.start()).rejects.toThrow('ReleaseUnavailable');
		});

		it('rechecks revocation after synchronous native intent persistence hooks', async () => {
			const f = await managedConsultFixture();
			const write = f.store.writeDispatchAdmission.bind(f.store);
			vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
				write(record);
				if (record.queueRouting?.steps.some((s) => s.status === 'unknown'))
					sweepQueueConsultReleases(true);
			});
			await f.start();
			expect(f.manager.spawn).not.toHaveBeenCalled();
			expect(f.manager.eventNames()).toEqual([]);
			await expect(f.start()).rejects.toThrow('ReleaseUnavailable');
		});

		it('does not register consult release closures for handoff-only routing', async () => {
			const f = await readyQueue('handoff');
			const release = await f.adapter.prepareQueueSpawn(
				'agent',
				'tab',
				f.input.dispatchId,
				() => {}
			);
			await expect(
				startReleasedQueueConsult(
					{ dispatchId: f.input.dispatchId, generation: release.generation },
					'agent',
					'tab',
					'peer-a',
					{} as never
				)
			).rejects.toThrow('ReleaseUnavailable');
			await expect(
				f.adapter.admission.startQueueConsult(
					f.input.dispatchId,
					release.generation,
					'peer-a',
					{} as never
				)
			).rejects.toThrow('ReleaseUnavailable');
		});

		it('bounds unused release retention and disposes both registries without creating send rights', async () => {
			const f = await managedConsultFixture();
			const revoke = vi.fn();
			const start = vi.fn();
			const ids = Array.from({ length: 260 }, () => generateUUID());
			for (const id of ids)
				bindQueueConsultRelease(id, {
					sourceAgentId: 'x',
					sourceTabId: 'y',
					generation: 'g',
					guard() {},
					localPrompt: () => '',
					revoke,
					start,
				});
			expect(revoke).toHaveBeenCalledTimes(4);
			await expect(f.start()).rejects.toThrow('ReleaseUnavailable');
			await expect(
				f.adapter.admission.startQueueConsult(f.input.dispatchId, f.generation, 'peer-a', f.opts)
			).rejects.toThrow('ReleaseUnavailable');
			sweepQueueConsultReleases(true);
			expect(revoke).toHaveBeenCalledTimes(260);
			expect(start).not.toHaveBeenCalled();
		});

		it('runs native managed consult branches after caller end and journals only their own terminal evidence', async () => {
			const f = await managedConsultFixture();
			const a = await f.start();
			const b = await f.start('peer-b');
			expect(a.requestId).not.toBe(b.requestId);
			expect(f.chunks).toEqual([]);
			expect(f.manager.spawn).toHaveBeenCalledTimes(2);
			f.manager.emit('data', 'cross-agent-foreign', 'foreign');
			f.manager.emit('exit', 'cross-agent-foreign', 0);
			f.manager.emit('session-id', `cross-agent-${a.requestId}`, 'native-a');
			f.manager.emit('data', `cross-agent-${a.requestId}`, 'Actual reply A');
			f.manager.emit('exit', `cross-agent-${a.requestId}`, 0);
			const journal = f.store.readDispatchAdmission(f.input.dispatchId)!;
			expect(journal.queueRouting?.steps[0]).toMatchObject({
				requestId: a.requestId,
				status: 'settled',
				processId: `cross-agent-${a.requestId}`,
				pid: 4242,
				agentSessionId: 'native-a',
				terminal: { text: 'Actual reply A' },
			});
			expect(journal.queueRouting?.steps[1]).toMatchObject({
				requestId: b.requestId,
				status: 'started',
			});
			expect(journal.queueRouting?.steps[1].terminal).toBeUndefined();
			f.manager.emit('exit', `cross-agent-${b.requestId}`, 0);
			await expect(f.start()).rejects.toThrow();
			expect(f.manager.spawn).toHaveBeenCalledTimes(2);
		});

		it('reaches managed consults through owning native IPC and refuses outcome IDs, foreign callers and unbound context', async () => {
			const f = await managedConsultFixture();
			const webContents = { id: 42, isDestroyed: () => false };
			registerCrossAgentHandlers({
				getProcessManager: () => f.opts.processManager,
				getAgentDetector: () => f.opts.agentDetector,
				sessionsStore: mockSessionsStore as never,
				agentConfigsStore: { get: () => ({}) } as never,
				settingsStore: { get: (_key: string, fallback: unknown) => fallback } as never,
				sshStore: null,
				safeSend: vi.fn(),
				getWindowForSession: () => ({ webContents }) as never,
			});
			const payload = {
				sourceSessionId: 'agent',
				sourceTabId: 'tab',
				targetSessionId: 'peer-a',
				userPrompt: 'Untrusted renderer replacement',
				transcript: [],
				strategy: { kind: 'full' },
				managedQueue: { dispatchId: f.input.dispatchId, generation: f.generation },
			};
			const send = handlers.get('cross-agent:send')!;
			await expect(send({ sender: { id: 43 } }, payload)).rejects.toThrow('OwnerMismatch');
			await expect(send({ sender: webContents, clientId: 'web' }, payload)).rejects.toThrow(
				'OwnerMismatch'
			);
			await expect(
				send(
					{ sender: webContents },
					{ ...payload, transcript: [{ source: 'ai', text: 'forged context' }] }
				)
			).rejects.toThrow('ContextUnavailable');
			await expect(
				send({ sender: webContents }, { ...payload, managedQueue: undefined })
			).rejects.toThrow('QueueConsumerRequired');
			await expect(
				send(
					{ sender: webContents },
					{ ...payload, managedQueue: { ...payload.managedQueue, generation: 'outcome-handle' } }
				)
			).rejects.toThrow();
			expect(f.manager.spawn).not.toHaveBeenCalled();
			const result = await send({ sender: webContents }, payload);
			expect(f.manager.spawn).toHaveBeenCalledTimes(1);
			const config = f.manager.spawn.mock.calls[0][0] as unknown as { prompt: string };
			expect(config.prompt).toContain('Check @PeerA and @PeerB');
			expect(config.prompt).not.toContain('Untrusted renderer replacement');
			f.manager.emit('data', `cross-agent-${result.requestId}`, 'Native IPC answer');
			f.manager.emit('exit', `cross-agent-${result.requestId}`, 0);
		});

		it('does not reconstruct a release from a journal after restart or repeat an unknown native acknowledgement', async () => {
			const f = await managedConsultFixture();
			const { PianolaDispatchAdmissionService } =
				await import('../../../../main/pianola/pianola-dispatch-admission');
			const restarted = new PianolaDispatchAdmissionService({
				...f.deps,
				readSnapshot: async () => f.snapshot,
				assertTargetReady: () => {},
				release: async () => 'unknown',
			});
			await expect(
				restarted.startQueueConsult(f.input.dispatchId, f.generation, 'peer-a', f.opts)
			).rejects.toThrow('ReleaseUnavailable');
			f.manager.spawn.mockImplementationOnce(() => {
				throw new Error('Unknown native acknowledgement');
			});
			await f.start();
			expect(
				f.store.readDispatchAdmission(f.input.dispatchId)!.queueRouting!.steps[0]
			).toMatchObject({ status: 'unknown', startError: 'Unknown native acknowledgement' });
			expect(
				f.store.readDispatchAdmission(f.input.dispatchId)!.queueRouting!.steps[0].terminal
			).toBeUndefined();
			await expect(f.start()).rejects.toThrow();
			expect(f.manager.spawn).toHaveBeenCalledTimes(1);
		});

		it.each([
			'generation',
			'item',
			'peer',
			'target',
			'pause',
			'fifo',
			'deleted-row',
			'policy',
			'owner',
			'unknown',
		] as const)('refuses managed consult %s without starting a provider', async (mutation) => {
			const f = await managedConsultFixture();
			if (mutation === 'generation') {
				await expect(f.start('peer-a', generateUUID())).rejects.toThrow();
				return;
			}
			if (mutation === 'item') {
				await expect(f.start('peer-a', f.generation, generateUUID())).rejects.toThrow();
				return;
			}
			if (mutation === 'peer') current[0].peerAgents = [];
			if (mutation === 'target') current.find((a) => a.id === 'peer-a')!.createdAt = 2;
			if (mutation === 'pause') f.snapshot.tabs[0].paused = true;
			if (mutation === 'fifo')
				current[0].executionQueue!.unshift({ id: 'predecessor', type: 'message', text: 'human' });
			if (mutation === 'deleted-row') current[0].executionQueue = [];
			if (mutation === 'policy') f.store.writeSupervisorTargets([]);
			if (mutation === 'owner')
				f.opts.assertNativeOwner = () => {
					throw new Error('OwnerChanged');
				};
			if (mutation === 'unknown') {
				const journal = f.store.readDispatchAdmission(f.input.dispatchId)!;
				journal.queueRouting!.steps[0].status = 'unknown';
				f.store.writeDispatchAdmission(journal);
			}
			try {
				await f.start();
			} catch {
				/* Host boundary can refuse before service registration. */
			}
			expect(f.manager.spawn).not.toHaveBeenCalled();
		});

		it.each(['pause', 'peer', 'rename', 'delete'] as const)(
			'rechecks %s after async provider preparation',
			async (mutation) => {
				const f = await managedConsultFixture();
				f.opts.agentDetector = {
					getAgent: async () => {
						if (mutation === 'pause') f.snapshot.tabs[0].paused = true;
						if (mutation === 'peer') current[0].peerAgents = [];
						if (mutation === 'rename') current.find((a) => a.id === 'peer-a')!.name = 'Replacement';
						if (mutation === 'delete') current = current.filter((a) => a.id !== 'peer-a');
						return { ...getAgentDefinition('codex'), available: true };
					},
				} as unknown as StartCrossAgentRequestOptions['agentDetector'];
				await f.start();
				expect(f.manager.spawn).not.toHaveBeenCalled();
				expect(
					f.store.readDispatchAdmission(f.input.dispatchId)!.queueRouting!.steps[0].terminal?.error
				).toMatch(/Dispatch|Pianola/);
			}
		);

		it.each(['success', 'refused', 'unknown', 'no-capture'] as const)(
			'drains busy->idle after caller end through D01 and native orchestration (%s)',
			async (outcome) => {
				const f = await readyQueue();
				f.revoke();
				const restarted = new PianolaNewTabDispatch(f.deps);
				const key = `agent-ai-tab`;
				const { generation } = await restarted.prepareQueueSpawn(
					'agent',
					'tab',
					f.input.dispatchId,
					() => {}
				);
				expect(current[0].executionQueue[0]).toMatchObject({ admissionRelease: { generation } });
				expect(() => pianolaNewTabSpawns.claim(key)).toThrow('DispatchQueueConsumerRequired');
				expect(() => pianolaNewTabSpawns.claim(key, f.input.dispatchId)).toThrow(
					'DispatchQueueConsumerRequired'
				);
				const events = new EventEmitter();
				const runs: unknown[] = [];
				const capture = new AgentRunCaptureService({
					upsertAgentRun: (run: unknown) => {
						runs.push(run);
						return run;
					},
					appendAgentRunEvent: (event: unknown) => event,
					findActiveRunBySession: () => undefined,
				} as never);
				const spawn = vi.fn((config) => {
					// This is the actual ProcessManager.spawn seam, after all asynchronous preflight.
					if (outcome === 'unknown') throw new Error('Native outcome unknown');
					if (outcome === 'refused') return { success: false, pid: -1 };
					if (outcome !== 'no-capture') events.emit('spawn', config);
					return { success: true, pid: 42 };
				});
				events.on('spawn', (config) => {
					const run = capture.captureSpawn({
						sessionId: config.sessionId,
						toolType: config.toolType,
						cwd: config.cwd,
						tabId: 'tab',
						prompt: config.prompt,
					});
					expect(run?.id).toBeTruthy();
					pianolaNewTabSpawns.captured(
						config.sessionId,
						run!.id,
						config.pianolaDispatchId,
						config.pianolaQueueItemId
					);
				});
				const manager = Object.assign(events, { spawn, get: () => undefined, getAll: () => [] });
				const definition = getAgentDefinition('codex')!;
				const attempt = handleProcessSpawn(
					{
						sessionId: key,
						tabId: 'tab',
						pianolaDispatchId: f.input.dispatchId,
						pianolaQueueItemId: f.input.dispatchId,
						toolType: 'codex',
						cwd: process.cwd(),
						command: definition.command,
						args: [],
						prompt: f.input.prompt,
					},
					{
						getProcessManager: () => manager as never,
						getAgentDetector: () =>
							({
								getAgent: async () => ({
									...definition,
									available: true,
									path: '/usr/local/bin/codex',
									capabilities: getAgentCapabilities('codex'),
								}),
							}) as never,
						agentConfigsStore: { get: (_key: string, fallback: unknown) => fallback } as never,
						settingsStore: { get: (_key: string, fallback: unknown) => fallback } as never,
						sessionsStore: mockSessionsStore as never,
						getMainWindow: () => null,
					}
				);
				if (outcome === 'refused' || outcome === 'unknown') {
					await expect(attempt).rejects.toThrow(
						outcome === 'unknown' ? 'Native outcome unknown' : /did not start/
					);
					await new Promise((resolve) => setImmediate(resolve));
					expect(spawn).toHaveBeenCalledOnce();
					expect(f.store.readDispatchAdmission(f.input.dispatchId)?.outcome).toBe(
						outcome === 'refused' ? 'rejected' : 'unknown'
					);
					expect(runs).toHaveLength(0);
					if (outcome === 'refused')
						await expect(
							restarted.prepareQueueSpawn('agent', 'tab', f.input.dispatchId, () => {})
						).rejects.toThrow('DispatchQueueNotStarted');
					// Test teardown only: production retains the uncertain one-shot claim.
					pianolaNewTabSpawns.started(key, undefined, f.input.dispatchId, f.input.dispatchId);
					return;
				}
				const result = await attempt;
				events.emit('exit', key, 0);
				await new Promise((resolve) => setImmediate(resolve));
				expect(result.success).toBe(true);
				expect(spawn).toHaveBeenCalledOnce();
				expect(runs).toHaveLength(outcome === 'success' ? 1 : 0);
				if (outcome === 'success') {
					expect(result.pianolaRunId).toBeTruthy();
					expect(f.store.readDispatchAdmission(f.input.dispatchId)).toMatchObject({
						outcome: 'accepted',
						runId: result.pianolaRunId,
					});
				} else {
					expect(result.pianolaRunId).toBeUndefined();
					expect(f.store.readDispatchAdmission(f.input.dispatchId)?.outcome).toBe('unknown');
				}
				if (outcome === 'success') {
					const replay = await new PianolaNewTabDispatch(f.deps).prepareQueueSpawn(
						'agent',
						'tab',
						f.input.dispatchId,
						() => {}
					);
					expect(replay).toEqual({ reconciled: true, runId: result.pianolaRunId });
				} else
					await expect(
						restarted.prepareQueueSpawn('agent', 'tab', f.input.dispatchId, () => {})
					).rejects.toThrow('DispatchQueueReleaseUncertain');
				expect(spawn).toHaveBeenCalledOnce();
			}
		);

		it.each(['two-prepared', 'behind-unannounced'] as const)(
			'drains initial provider continuity from disk/capture/announcement after restart (%s)',
			async (placement) => {
				const f = queueAdapter(false);
				const snapshot = f.deps.snapshot();
				snapshot.tabs[0].cursorAvailable = true;
				f.deps.snapshot = () => snapshot;
				const first = { ...f.input, dispatchId: generateUUID() };
				const second = { ...f.input, dispatchId: generateUUID() };
				const events = new EventEmitter();
				const spawn = vi.fn((config) => {
					const run = f.capture.captureSpawn({
						sessionId: config.sessionId,
						toolType: config.toolType,
						cwd: config.cwd,
						tabId: 'tab',
						nativeTabSession: {
							agentId: 'agent',
							tabId: 'tab',
							createdAt: 1,
							initialSessionId: current[0].aiTabs![0].agentSessionId,
						},
					})!;
					pianolaNewTabSpawns.captured(
						config.sessionId,
						run.id,
						config.pianolaDispatchId,
						config.pianolaQueueItemId
					);
					return { success: true, pid: 42 };
				});
				const manager = Object.assign(events, { spawn, get: () => undefined, getAll: () => [] });
				const definition = getAgentDefinition('codex')!;
				const start = async (dispatchId?: string) => {
					await handleProcessSpawn(
						{
							sessionId: 'agent-ai-tab',
							tabId: 'tab',
							...(dispatchId
								? { pianolaDispatchId: dispatchId, pianolaQueueItemId: dispatchId }
								: {}),
							toolType: 'codex',
							cwd: process.cwd(),
							command: definition.command,
							args: [],
							prompt: 'Queued work',
							agentSessionId: current[0].aiTabs![0].agentSessionId,
						},
						{
							getProcessManager: () => manager as never,
							getAgentDetector: () =>
								({
									getAgent: async () => ({
										...definition,
										available: true,
										path: '/usr/local/bin/codex',
										capabilities: getAgentCapabilities('codex'),
									}),
								}) as never,
							agentConfigsStore: { get: (_key: string, fallback: unknown) => fallback } as never,
							settingsStore: { get: (_key: string, fallback: unknown) => fallback } as never,
							sessionsStore: mockSessionsStore as never,
							getMainWindow: () => null,
						}
					);
					snapshot.tabs[0].busy = true;
					return f.deps.readNativeRuns().at(-1)!;
				};
				let firstRun: AgentRun;
				if (placement === 'two-prepared') {
					await f.adapter.runQueue(f.client, first, f.arm);
					await f.adapter.runQueue(f.client, second, f.arm);
					await f.adapter.prepareQueueSpawn('agent', 'tab', first.dispatchId, () => {});
					firstRun = await start(first.dispatchId);
				} else {
					firstRun = await start();
					await f.adapter.runQueue(f.client, second, f.arm);
					expect(
						f.store.readDispatchAdmission(second.dispatchId)?.queueAuthority?.initialSession
					).toEqual({ runId: firstRun.id });
				}
				f.capture.captureSessionAnnouncement('agent-ai-tab', 'first-provider-session');
				await f.capture.captureExit({ sessionId: 'agent-ai-tab', exitCode: 0 });
				events.emit('exit', 'agent-ai-tab', 0);
				snapshot.tabs[0].busy = false;
				Object.assign(snapshot.tabs[0], { agentSessionId: 'first-provider-session' });
				current[0].aiTabs![0].agentSessionId = 'first-provider-session';
				// Actual renderer consumption of the captured first row, then durable idle state.
				await save([
					{
						...current[0],
						executionQueue: current[0].executionQueue!.filter((row) => row.id !== first.dispatchId),
					},
				]);
				f.revoke();
				const restart = new PianolaNewTabDispatch({
					...f.deps,
					store: createPianolaFsStore({ resolveDir: () => path.join(directory, 'pianola') }),
				});
				await restart.prepareQueueSpawn('agent', 'tab', second.dispatchId, () => {});
				const secondRun = await start(second.dispatchId);
				await f.capture.captureExit({ sessionId: 'agent-ai-tab', exitCode: 0 });
				events.emit('exit', 'agent-ai-tab', 0);
				await new Promise((resolve) => setImmediate(resolve));
				expect(secondRun.id).not.toBe(firstRun.id);
				expect(f.store.readDispatchAdmission(second.dispatchId)).toMatchObject({
					outcome: 'accepted',
					runId: secondRun.id,
				});
				expect(
					await restart.prepareQueueSpawn('agent', 'tab', second.dispatchId, () => {})
				).toEqual({ reconciled: true, runId: secondRun.id });
				expect(() =>
					pianolaNewTabSpawns.claim('agent-ai-tab', second.dispatchId, second.dispatchId)
				).toThrow();
				expect(spawn).toHaveBeenCalledTimes(2);
			}
		);

		it.each([
			'missing',
			'foreign-tab',
			'foreign-run',
			'reset',
			'reset-empty',
			'recreated',
			'ambiguous',
			'unknown',
			'no-announcement',
			'legacy',
			'pinned-foreign-run',
			'native-guard',
			'conflicting',
			'pause',
			'policy',
		] as const)('refuses initial provider continuity with %s evidence', async (mutation) => {
			const f = queueAdapter(false);
			const snapshot = f.deps.snapshot();
			snapshot.tabs[0].cursorAvailable = true;
			f.deps.snapshot = () => snapshot;
			await f.adapter.runQueue(f.client, f.input, f.arm);
			const run = f.capture.captureSpawn({
				sessionId: 'agent-ai-tab',
				toolType: 'codex',
				cwd: process.cwd(),
				tabId: 'tab',
				nativeTabSession: { agentId: 'agent', tabId: 'tab', createdAt: 1 },
			})!;
			if (mutation !== 'no-announcement')
				f.capture.captureSessionAnnouncement('agent-ai-tab', 'provider');
			if (mutation === 'conflicting')
				f.capture.captureSessionAnnouncement('agent-ai-tab', 'replacement');
			await f.capture.captureExit({ sessionId: 'agent-ai-tab', exitCode: 0 });
			const captured = f.deps.readNativeRuns()[0];
			if (mutation === 'foreign-tab') f.upsertNativeRun({ ...captured, tabId: 'other' });
			if (mutation === 'foreign-run') f.upsertNativeRun({ ...captured, sessionId: 'other-ai-tab' });
			if (mutation === 'missing') f.upsertNativeRun({ ...captured, metadata: {} });
			if (mutation === 'unknown') f.upsertNativeRun({ ...captured, status: 'running' });
			if (mutation === 'ambiguous') f.upsertNativeRun({ ...captured, id: `${run.id}:other` });
			Object.assign(snapshot.tabs[0], {
				agentSessionId:
					mutation === 'reset'
						? 'replacement'
						: mutation === 'reset-empty'
							? undefined
							: 'provider',
				...(mutation === 'recreated' ? { createdAt: 2 } : {}),
				paused: mutation === 'pause',
			});
			current[0].aiTabs![0].agentSessionId = snapshot.tabs[0].agentSessionId;
			await save(current);
			if (mutation === 'policy') f.store.writeSupervisorTargets([]);
			if (mutation === 'legacy' || mutation === 'pinned-foreign-run') {
				const journal = f.store.readDispatchAdmission(f.input.dispatchId)!;
				if (mutation === 'legacy') delete journal.queueAuthority!.initialSession;
				else journal.queueAuthority!.initialSession = { runId: 'foreign-capture' };
				f.store.writeDispatchAdmission(journal);
			}
			if (mutation === 'native-guard') {
				await new PianolaNewTabDispatch(f.deps).prepareQueueSpawn(
					'agent',
					'tab',
					f.input.dispatchId,
					() => {}
				);
				f.upsertNativeRun({ ...captured, metadata: {} });
				expect(() =>
					pianolaNewTabSpawns.claim('agent-ai-tab', f.input.dispatchId, f.input.dispatchId)
				).toThrow('DispatchTargetIdentityChangedOrBusy');
				expect(current[0].executionQueue![0].pendingAdmissionId).toBe(f.input.dispatchId);
				await new Promise((resolve) => setImmediate(resolve));
				return;
			}
			await expect(
				new PianolaNewTabDispatch(f.deps).prepareQueueSpawn(
					'agent',
					'tab',
					f.input.dispatchId,
					() => {}
				)
			).rejects.toThrow();
			expect(current[0].executionQueue![0]).not.toHaveProperty('admissionRelease');
			expect(f.store.readDispatchAdmission(f.input.dispatchId)).toMatchObject({
				phase: 'bound',
				outcome: 'queued',
			});
		});

		it.each(['pause', 'delete', 'model', 'conversation', 'owner', 'policy', 'cancel'] as const)(
			'revalidates %s immediately before a managed native claim',
			async (mutation) => {
				const f = await readyQueue();
				const adapter = new PianolaNewTabDispatch(f.deps);
				const key = 'agent-ai-tab';
				await adapter.prepareQueueSpawn('agent', 'tab', f.input.dispatchId, () => {});
				const guard = pianolaNewTabSpawns.claim(key, f.input.dispatchId, f.input.dispatchId);
				if (mutation === 'pause') current[0].executionQueue[0].paused = true;
				if (mutation === 'delete') current[0].executionQueue = [];
				if (mutation === 'model')
					current[0].executionQueue[0].turnSettings = { model: 'different' };
				if (mutation === 'conversation') f.snapshot.tabs[0].agentSessionId = 'changed';
				if (mutation === 'owner') f.snapshot.owners[0].isPianola = true;
				if (mutation === 'policy') f.store.writeSupervisorTargets([]);
				if (mutation === 'cancel') adapter.cancelQueueItem('agent', 'tab', f.input.dispatchId);
				expect(guard).toThrow();
				guard.notStarted();
				await new Promise((resolve) => setImmediate(resolve));
				expect(f.store.readDispatchAdmission(f.input.dispatchId)).toMatchObject({
					outcome: 'rejected',
				});
			}
		);

		it('serializes duplicate idle requests and never retries a release lost on renderer restart', async () => {
			const f = await readyQueue();
			const adapter = new PianolaNewTabDispatch(f.deps);
			const results = await Promise.allSettled([
				adapter.prepareQueueSpawn('agent', 'tab', f.input.dispatchId, () => {}),
				adapter.prepareQueueSpawn('agent', 'tab', f.input.dispatchId, () => {}),
			]);
			expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
			await expect(
				new PianolaNewTabDispatch(f.deps).prepareQueueSpawn(
					'agent',
					'tab',
					f.input.dispatchId,
					() => {}
				)
			).rejects.toThrow('DispatchQueueReleaseUncertain');
			pianolaNewTabSpawns.cancelHold('agent', 'tab');
		});

		it('records cancellation durably and refuses a stale saved held row after restart', async () => {
			const f = await readyQueue();
			f.adapter.cancelQueueItem('agent', 'tab', f.input.dispatchId);
			expect(f.store.readDispatchAdmission(f.input.dispatchId)).toMatchObject({
				queueCancelled: true,
				phase: 'settled',
				outcome: 'rejected',
			});
			await expect(
				new PianolaNewTabDispatch(f.deps).prepareQueueSpawn(
					'agent',
					'tab',
					f.input.dispatchId,
					() => {}
				)
			).rejects.toThrow('DispatchQueueCancelled');
		});

		it.each(['same-host', 'host-restart', 'missing-proof', 'changed-caller'] as const)(
			'binds callback admission only to real capture (%s)',
			async (mode) => {
				const f = queueAdapter(true);
				const snapshot = f.deps.snapshot();
				snapshot.owners.push({
					id: 'manager',
					cwd: process.cwd(),
					isPianola: true,
					remote: false,
					groupId: null,
				});
				snapshot.tabs.push({
					...snapshot.tabs[0],
					agentId: 'manager',
					tabId: 'manager-tab',
					createdAt: 7,
				});
				let registry = new DispatchCallbackRegistry({ onFire: vi.fn() });
				const deps = { ...f.deps, snapshot: () => snapshot, callbackRegistry: () => registry };
				const adapter = new PianolaNewTabDispatch(deps);
				const result = await adapter.runQueue(
					f.client,
					f.input,
					() =>
						registry.register({
							targetAgentId: 'agent',
							targetTabId: 'tab',
							callerAgentId: 'manager',
							callerTabId: 'manager-tab',
							prompt: f.input.prompt,
							timeoutMs: 60000,
							pendingAdmissionId: f.input.dispatchId,
						}).callbackId
				);
				registry.noteSpawn('agent-ai-tab');
				registry.noteExit('agent-ai-tab', 0);
				expect(registry.get(result.callbackId!)?.state).toBe('pending');
				f.revoke();
				snapshot.tabs[0].busy = false;
				snapshot.tabs[0].cursorAvailable = true;
				if (mode !== 'same-host') registry = new DispatchCallbackRegistry({ onFire: vi.fn() });
				if (mode === 'missing-proof') {
					const record = f.store.readDispatchAdmission(f.input.dispatchId)!;
					delete record.queuePrepare!.callbackProof;
					f.store.writeDispatchAdmission(record);
				}
				if (mode === 'changed-caller') snapshot.tabs[1].createdAt = 8;
				const restarted = new PianolaNewTabDispatch(deps);
				if (mode === 'missing-proof' || mode === 'changed-caller') {
					await expect(
						restarted.prepareQueueSpawn('agent', 'tab', f.input.dispatchId, () => {})
					).rejects.toThrow('DispatchCallbackReconstructionUnavailable');
					expect(registry.list()).toHaveLength(0);
					return;
				}
				await restarted.prepareQueueSpawn('agent', 'tab', f.input.dispatchId, () => {});
				const key = 'agent-ai-tab';
				expect(registry.list()[0].state).toBe('pending');
				registry.noteSpawn(key); // even a foreign spawn observation cannot arm it
				expect(registry.list()[0].state).toBe('pending');
				const guard = pianolaNewTabSpawns.claim(key, f.input.dispatchId, f.input.dispatchId);
				guard();
				pianolaNewTabSpawns.captured(key, 'foreign-preflight-run');
				pianolaNewTabSpawns.started(key);
				expect(registry.list()[0].state).toBe('pending');
				pianolaNewTabSpawns.captured(
					key,
					'real-callback-run',
					f.input.dispatchId,
					f.input.dispatchId
				);
				expect(registry.list()[0].state).toBe('armed');
				expect(registry.list()[0].pendingAdmissionId).toBeUndefined();
				pianolaNewTabSpawns.started(key, undefined, f.input.dispatchId, f.input.dispatchId);
				await new Promise((resolve) => setImmediate(resolve));
				expect(f.store.readDispatchAdmission(f.input.dispatchId)?.runId).toBe('real-callback-run');
			}
		);

		it('journals a user deletion from the actual serialized persistence save', async () => {
			const f = await readyQueue();
			const cancel = vi.fn((agentId: string, tabId: string, itemId: string) =>
				f.adapter.cancelQueueItem(agentId, tabId, itemId)
			);
			deps.cancelQueueItem = cancel;
			await save([{ ...current[0], executionQueue: [] }], [], structuredClone(current));
			expect(cancel).toHaveBeenCalledWith('agent', 'tab', f.input.dispatchId);
			expect(f.store.readDispatchAdmission(f.input.dispatchId)).toMatchObject({
				queueCancelled: true,
				outcome: 'rejected',
			});
		});

		it('releases a durable standing task after caller end and host restart, with an idle baseline and no native send', async () => {
			const f = await readyQueue();
			f.revoke();
			Object.assign(f.snapshot.tabs[0], {
				cursor: { id: 'idle-after-predecessor', count: 4, textLength: 20 },
			});
			const restarted = new PianolaNewTabDispatch(f.deps);
			const release = await restarted.admission.releaseQueue(f.input.dispatchId);
			expect(release.receipt).toMatchObject({ outcome: 'unknown', supervision: 'enrolled' });
			expect(release.generation).toBeTruthy();
			release.guard();
			const record = f.store.readDispatchAdmission(f.input.dispatchId)!;
			expect(record).toMatchObject({
				phase: 'released',
				queueRelease: {
					generation: release.generation,
					baseline: { id: 'idle-after-predecessor', count: 4, textLength: 20 },
				},
			});
			expect(record.queueAuthority!.expiresAt - record.queueAuthority!.acceptedAt).toBe(86_400_000);
			const disk = JSON.parse(await realFs.readFile(mockSessionsStore.path, 'utf8'));
			expect(disk.sessions[0].executionQueue[0].admissionRelease.generation).toBe(
				release.generation
			);
			expect(f.store.readScopeCheckpoint(f.scopeId)!.tabs[0]).toMatchObject({
				baselineBusy: false,
				baseline: { id: 'idle-after-predecessor', count: 4, textLength: 20 },
			});
			expect(f.deps.newTab).not.toHaveBeenCalled();
			await expect(
				new PianolaNewTabDispatch(f.deps).admission.releaseQueue(f.input.dispatchId)
			).rejects.toThrow('DispatchQueueReleaseUncertain');
		});

		it.each([
			'policy-off',
			'owner',
			'excluded',
			'feature-off',
			'paused',
			'busy',
			'conversation',
			'replacement',
			'deleted-tab',
			'deleted-item',
			'changed-item',
			'predecessor',
			'connection-hold',
			'authority-missing',
			'expired',
		])('keeps queue held for %s after caller end', async (mode) => {
			const f = await readyQueue();
			f.revoke();
			const targets = f.store.readSupervisorTargets();
			if (mode === 'policy-off') targets[0].enabled = false;
			if (mode === 'owner') targets[0].managerAgentId = 'other-manager';
			if (mode === 'excluded') targets[0].selection!.excludedAgentIds = ['agent'];
			f.store.writeSupervisorTargets(targets);
			if (mode === 'feature-off') f.deps.featureEnabled = () => false;
			if (mode === 'busy') f.snapshot.tabs[0].busy = true;
			if (mode === 'conversation')
				Object.assign(f.snapshot.tabs[0], { agentSessionId: 'different' });
			if (mode === 'replacement') f.snapshot.tabs[0].createdAt++;
			if (mode === 'deleted-tab') current[0].aiTabs = [];
			if (mode === 'deleted-item') current[0].executionQueue = [];
			if (mode === 'paused') current[0].executionQueue[0].paused = true;
			if (mode === 'changed-item') current[0].executionQueue[0].text = 'other';
			if (mode === 'predecessor' || mode === 'connection-hold')
				current[0].executionQueue.unshift({
					id: 'earlier',
					tabId: mode === 'predecessor' ? 'tab' : 'another',
					waitingForConnection: mode === 'connection-hold',
				});
			if (mode === 'authority-missing' || mode === 'expired') {
				const record = f.store.readDispatchAdmission(f.input.dispatchId)!;
				if (mode === 'authority-missing') delete record.queueAuthority;
				else {
					record.queueAuthority!.acceptedAt = 1;
					record.queueAuthority!.expiresAt = 2;
				}
				f.store.writeDispatchAdmission(record);
			}
			await expect(
				new PianolaNewTabDispatch(f.deps).admission.releaseQueue(f.input.dispatchId)
			).rejects.toThrow();
			expect(f.store.readDispatchAdmission(f.input.dispatchId)!.phase).toBe('bound');
			expect(current[0].executionQueue.some((r: any) => r.admissionRelease)).toBe(false);
		});

		it('allows user resume independently of the host hold without changing the prepared intent', async () => {
			const f = queueAdapter();
			const make = f.deps.queueItem;
			f.deps.queueItem = async () => ({ ...(await make()), paused: true });
			await f.adapter.runQueue(f.client, f.input, f.arm);
			const snapshot = f.deps.snapshot();
			snapshot.tabs[0].cursorAvailable = true;
			f.deps.snapshot = () => snapshot;
			await expect(f.adapter.admission.releaseQueue(f.input.dispatchId)).rejects.toThrow(
				'DispatchQueueChangedOrPaused'
			);
			const before = structuredClone(current[0]);
			const resumed = structuredClone(before);
			resumed.executionQueue[0].paused = false;
			await save([resumed], [], [before]);
			expect(current[0].executionQueue[0].admissionRelease).toBeUndefined();
			const released = await f.adapter.admission.releaseQueue(f.input.dispatchId);
			released.guard();
			expect(f.store.readDispatchAdmission(f.input.dispatchId)!.queuePrepare!.item.paused).toBe(
				true
			);
			expect(current[0].executionQueue[0].paused).toBe(false);
		});

		it('allows skipped user-held predecessors but revalidates policy after release', async () => {
			const f = await readyQueue();
			current[0].executionQueue.unshift({ id: 'paused-first', tabId: 'tab', paused: true });
			const release = await f.adapter.admission.releaseQueue(f.input.dispatchId);
			release.guard();
			const targets = f.store.readSupervisorTargets();
			targets[0].enabled = false;
			f.store.writeSupervisorTargets(targets);
			expect(() => release.guard()).toThrow('PianolaPolicyChanged');
		});

		it('serializes duplicate drain requests and refuses a second release after a lost ack', async () => {
			const f = await readyQueue();
			const results = await Promise.allSettled([
				f.adapter.admission.releaseQueue(f.input.dispatchId),
				f.adapter.admission.releaseQueue(f.input.dispatchId),
			]);
			expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
			expect(f.store.readDispatchAdmission(f.input.dispatchId)!.phase).toBe('released');
		});

		it('keeps the fresh generation across stale full saves and refuses forged generations', async () => {
			const f = await readyQueue();
			const stale = structuredClone(current[0]);
			const release = await f.adapter.admission.releaseQueue(f.input.dispatchId);
			await save([stale], [], [stale]);
			expect(current[0].executionQueue[0].admissionRelease.generation).toBe(release.generation);
			const forged = structuredClone(current[0]);
			forged.executionQueue[0].admissionRelease = { generation: 'forged' };
			await save([forged], [], [structuredClone(current[0])]);
			expect(current[0].executionQueue[0].admissionRelease.generation).toBe(release.generation);
			// User pause is independent of the technical generation, and invalidates the guard.
			const paused = structuredClone(current[0]);
			paused.executionQueue[0].paused = true;
			await save([paused], [], [structuredClone(current[0])]);
			expect(() => release.guard()).toThrow('DispatchQueueChangedOrPaused');
		});

		it.each([
			'readback-pause',
			'readback-delete',
			'readback-conversation',
			'readback-policy',
			'release-flush',
			'journal-ack',
		])('holds safely at the %s boundary', async (boundary) => {
			const f = await readyQueue();
			if (boundary.startsWith('readback-')) {
				const read = realFs.readFile;
				vi.mocked(fs.readFile).mockImplementation(
					async (...args: Parameters<typeof fs.readFile>) => {
						const result = await read(...args);
						if (boundary === 'readback-pause') current[0].executionQueue[0].paused = true;
						if (boundary === 'readback-delete') current[0].executionQueue = [];
						if (boundary === 'readback-conversation') current[0].aiTabs[0].agentSessionId = 'new';
						if (boundary === 'readback-policy') {
							const targets = f.store.readSupervisorTargets();
							targets[0].enabled = false;
							f.store.writeSupervisorTargets(targets);
						}
						return result;
					}
				);
			}
			if (boundary === 'release-flush')
				mockFlushSessionWrites.mockImplementation(async () => {
					if (current[0].executionQueue[0].admissionRelease) throw new Error('disk full');
					await realFs.writeFile(mockSessionsStore.path, JSON.stringify({ sessions: current }));
				});
			if (boundary === 'journal-ack') {
				const write = f.store.writeDispatchAdmission.bind(f.store);
				vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
					write(record);
					if (record.phase === 'released') throw new Error('lost journal ack');
				});
			}
			await expect(f.adapter.admission.releaseQueue(f.input.dispatchId)).rejects.toThrow();
			const record = f.store.readDispatchAdmission(f.input.dispatchId)!;
			expect(record.phase).toBe(boundary.startsWith('readback-') ? 'bound' : 'released');
			if (!boundary.startsWith('readback-')) {
				expect(record.outcome).toBe('unknown');
				await expect(
					new PianolaNewTabDispatch(f.deps).admission.releaseQueue(f.input.dispatchId)
				).rejects.toThrow('DispatchQueueReleaseUncertain');
			}
		});

		it.each([false, true])(
			'queue prepare composes actual disk proof and one held row with busy=%s, without enrollment',
			async (busy) => {
				const f = queueAdapter(busy);
				const result = await f.adapter.runQueue(f.client, f.input, f.arm);
				expect(result).toMatchObject({
					durable: true,
					receipt: {
						outcome: 'queued',
						queueItemId: f.input.dispatchId,
						supervision: 'unavailable',
					},
				});
				expect(f.store.readScopeCheckpoint(f.scopeId)).toBeNull();
				expect(f.rendererQueue).toHaveLength(1);
				expect(f.rendererQueue[0].pendingAdmissionId).toBe(f.input.dispatchId);
				const disk = JSON.parse(await realFs.readFile(mockSessionsStore.path, 'utf8'));
				expect(disk.sessions[0].executionQueue[0]).toEqual(f.rendererQueue[0]);
				const restarted = new PianolaNewTabDispatch(f.deps);
				expect(await restarted.runQueue(f.client, f.input, f.arm)).toMatchObject({ durable: true });
				expect(f.enqueue).toHaveBeenCalledOnce();
				expect(f.arm).toHaveBeenCalledOnce();
				await expect(
					restarted.runQueue(f.client, { ...f.input, prompt: 'other intent' }, f.arm)
				).rejects.toThrow('DispatchIntentMismatch');
			}
		);
		it.each(['enqueue-ack', 'readback', 'journal-ack'])(
			'reconciles real B01 evidence after caller revocation at %s without a second enqueue',
			async (boundary) => {
				const f = queueAdapter();
				const enqueue = f.enqueue.getMockImplementation()!;
				f.enqueue.mockImplementation(async (...args) => {
					const result = await enqueue(...args);
					if (boundary === 'enqueue-ack') f.revoke();
					return result;
				});
				const confirm = f.confirmItem.getMockImplementation()!;
				f.confirmItem.mockImplementation(async (request) => {
					if (boundary === 'readback') f.revoke();
					return confirm(request);
				});
				const write = f.store.writeDispatchAdmission.bind(f.store);
				vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
					if (boundary === 'journal-ack' && record.outcome === 'queued') f.revoke();
					write(record);
				});
				expect(await f.adapter.runQueue(f.client, f.input, f.arm)).toMatchObject({
					durable: true,
					receipt: { outcome: 'queued' },
				});
				f.restore();
				expect(
					await new PianolaNewTabDispatch(f.deps).runQueue(f.client, f.input, f.arm)
				).toMatchObject({ durable: true });
				expect(f.enqueue).toHaveBeenCalledOnce();
				expect(f.rendererQueue).toHaveLength(1);
			}
		);
		it.each([false, true])(
			'host handler composes journal and B01 after caller ends, outcome write fails=%s',
			async (failWrite) => {
				const f = queueAdapter();
				const send = vi.fn();
				const ctx = { callbacks: {}, send } as unknown as MessageHandlerContext;
				// Inject host routing/adapter ownership only; admission, disk journal and B01 stay real.
				const routing = vi
					.spyOn(queueSupervision, 'dispatchSupervision')
					.mockReturnValue({ managed: true });
				const adapter = vi.spyOn(tabAdmission, 'newTabAdmission').mockReturnValue(f.adapter);
				const confirm = f.confirmItem.getMockImplementation()!;
				f.confirmItem.mockImplementation(async (request) => {
					const proof = await confirm(request);
					f.revoke();
					return proof;
				});
				const write = f.store.writeDispatchAdmission.bind(f.store);
				vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
					if (failWrite && record.outcome === 'queued')
						throw new Error('Outcome persistence failed');
					write(record);
				});
				const message = {
					type: 'enqueue_command',
					sessionId: 'agent',
					tabId: 'tab',
					command: f.input.prompt,
					background: true,
					dispatchId: f.input.dispatchId,
				};
				try {
					handleEnqueueCommand(ctx, f.client as WebClient, message);
					await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
					expect(send.mock.calls[0][1]).toMatchObject({
						success: !failWrite,
						durable: !failWrite,
						unknown: failWrite,
						admission: { outcome: failWrite ? 'unknown' : 'queued' },
					});
					if (failWrite) expect(send.mock.calls[0][1].error).toMatch(/Do not resend/);
					f.restore();
					handleEnqueueCommand(ctx, f.client as WebClient, message);
					await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
					expect(f.enqueue).toHaveBeenCalledOnce();
				} finally {
					routing.mockRestore();
					adapter.mockRestore();
				}
			}
		);

		it('refuses caller revocation before the uncertainty commit', async () => {
			const f = queueAdapter();
			const item = f.deps.queueItem;
			f.deps.queueItem = async () => {
				f.revoke();
				return item();
			};
			await expect(f.adapter.runQueue(f.client, f.input, f.arm)).rejects.toThrow(
				'CallerRunUnavailable'
			);
			expect(f.enqueue).not.toHaveBeenCalled();
			expect(f.store.readDispatchAdmission(f.input.dispatchId)?.queuePrepare).toBeUndefined();
		});
		it('keeps failed outcome persistence unknown after real durable readback and caller revocation', async () => {
			const f = queueAdapter();
			const write = f.store.writeDispatchAdmission.bind(f.store);
			vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
				if (record.outcome === 'queued') {
					f.revoke();
					throw new Error('Outcome disk failure');
				}
				write(record);
			});
			expect(await f.adapter.runQueue(f.client, f.input, f.arm)).toMatchObject({
				durable: false,
				receipt: { outcome: 'unknown' },
			});
			expect(f.store.readDispatchAdmission(f.input.dispatchId)?.outcome).toBe('unknown');
			f.restore();
			vi.mocked(f.store.writeDispatchAdmission).mockImplementation(write);
			expect(await f.adapter.runQueue(f.client, f.input, f.arm)).toMatchObject({ durable: true });
			expect(f.enqueue).toHaveBeenCalledOnce();
		});

		it('does not enqueue after an uncertain prepare journal commit, even on reconciliation', async () => {
			const f = queueAdapter();
			const write = f.store.writeDispatchAdmission.bind(f.store);
			vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
				write(record);
				if (record.queuePrepare && record.outcome === 'unknown')
					throw new Error('Lost journal ack');
			});
			expect(await f.adapter.runQueue(f.client, f.input, f.arm)).toMatchObject({
				durable: false,
				receipt: { outcome: 'unknown', queueItemId: f.input.dispatchId },
			});
			expect(f.store.readDispatchAdmission(f.input.dispatchId)?.queuePrepare?.phase).toBe(
				'unknown'
			);
			await f.adapter.runQueue(f.client, f.input, f.arm);
			expect(f.enqueue).not.toHaveBeenCalled();
		});

		it('reconciles a lost renderer acknowledgment only through actual disk proof', async () => {
			const f = queueAdapter();
			f.loseAck();
			expect(await f.adapter.runQueue(f.client, f.input, f.arm)).toMatchObject({ durable: true });
			expect(f.confirmItem).toHaveBeenCalledOnce();
			expect(f.enqueue).toHaveBeenCalledOnce();
		});
		it.each(['session', 'item', 'payload'])(
			'does not resend a prepared row after removed or changed %s',
			async (removed) => {
				const f = queueAdapter();
				await f.adapter.runQueue(f.client, f.input, f.arm);
				if (removed === 'session') current = [];
				else if (removed === 'item') current[0].executionQueue = [];
				else current[0].executionQueue![0].text = 'different';
				expect(await f.adapter.runQueue(f.client, f.input, f.arm)).toMatchObject({
					durable: false,
					receipt: { outcome: 'unknown', queueItemId: f.input.dispatchId },
				});
				expect(f.enqueue).toHaveBeenCalledOnce();
			}
		);
		it.each(['write', 'read', 'flush', 'no-save', 'missing-di'])(
			'keeps %s failure unknown without a second enqueue',
			async (failure) => {
				const f = queueAdapter();
				const normalSet = mockSessionsStore.set.getMockImplementation();
				const normalFlush = mockFlushSessionWrites.getMockImplementation();
				if (failure === 'write')
					mockSessionsStore.set.mockImplementation(() => {
						throw new Error('write failed');
					});
				if (failure === 'read') vi.mocked(fs.readFile).mockRejectedValue(new Error('read failed'));
				if (failure === 'flush')
					mockFlushSessionWrites.mockRejectedValue(new Error('flush failed'));
				if (failure === 'no-save') f.skipSave();
				if (failure === 'missing-di') registerQueueCallbacks(server, { getMainWindow: () => null });
				expect(await f.adapter.runQueue(f.client, f.input, f.arm)).toMatchObject({
					durable: false,
					receipt: { outcome: 'unknown' },
				});
				mockSessionsStore.set.mockImplementation(normalSet!);
				mockFlushSessionWrites.mockImplementation(normalFlush!);
				vi.mocked(fs.readFile).mockImplementation(realFs.readFile);
				registerQueueCallbacks(server, {
					getMainWindow: () => null,
					confirmQueueItem: persistence.confirmQueueItem,
					releaseQueueItem: persistence.releaseQueueItem,
				});
				await f.adapter.runQueue(f.client, f.input, f.arm);
				expect(f.enqueue).toHaveBeenCalledOnce();
			}
		);

		it('confirms the exact saved row and hold through the registered host adapter', async () => {
			expect(await save(current)).toBe(true);
			expect(await confirm()).toEqual({ durable: true, request });
			expect(handlers.has('sessions:confirmQueueItem')).toBe(false);
		});
		it('fails closed when host persistence is unavailable', async () => {
			registerQueueCallbacks(server, { getMainWindow: () => null });
			expect(await confirm()).toEqual({ durable: false, reason: 'store-unavailable' });
		});
		it.each(['session', 'tab', 'item'])(
			'refuses a removed %s after a successful boolean save',
			async (removed) => {
				const pending = save(
					removed === 'session'
						? []
						: [{ ...current[0], ...(removed === 'tab' ? { aiTabs: [] } : { executionQueue: [] }) }],
					removed === 'session' ? ['agent'] : []
				);
				const receipt = confirm();
				expect(await pending).toBe(true);
				expect(await receipt).toEqual({ durable: false, reason: `${removed}-missing` });
			}
		);
		it('does not mistake a tombstoned stale update and successful flush for storage', async () => {
			const stale = structuredClone(current);
			const removed = save([], ['agent']);
			const resurrected = save(stale);
			const receipt = confirm();
			expect(await removed).toBe(true);
			expect(await resurrected).toBe(true);
			expect(current).toEqual([]);
			expect(await receipt).toEqual({ durable: false, reason: 'session-missing' });
		});
		it.each([
			{ text: 'Changed' },
			{ images: ['maestro-image://other.png'] },
			{ type: 'command', command: '/changed' },
			{ pendingAdmissionId: 'other' },
			{ pendingAdmissionId: undefined },
			{ tabId: 'other' },
			{ customModel: 'other' },
		])('refuses changed authoritative intent or hold: %j', async (patch) => {
			current = [session({ ...request.item, ...patch } as QueueItemReceiptRequest['item'])];
			expect(await confirm()).toEqual({ durable: false, reason: 'item-changed' });
		});
		it('does not accept a stale incoming payload preserved against the current stored row', async () => {
			const baseline = structuredClone(current);
			current = [session({ ...request.item, text: 'Peer intent' })];
			expect(await save(baseline, [], baseline)).toBe(true);
			expect(await confirm()).toEqual({ durable: false, reason: 'item-changed' });
		});
		it('compares post-flush disk, not a pre-flush snapshot or boolean', async () => {
			mockFlushSessionWrites.mockResolvedValue(undefined);
			await realFs.writeFile(
				mockSessionsStore.path,
				JSON.stringify({ sessions: [session({ ...request.item, text: 'Old disk' })] })
			);
			expect(await confirm()).toEqual({ durable: false, reason: 'item-changed' });
		});
		it('rejects flush failure and allows a subsequent successful proof', async () => {
			mockFlushSessionWrites.mockRejectedValueOnce(
				Object.assign(new Error('disk full'), { code: 'ENOSPC' })
			);
			await expect(confirm()).rejects.toThrow('disk full');
			expect(await confirm()).toEqual({ durable: true, request });
		});
		it('does not accept a failed save that left only the in-memory cache populated', async () => {
			current = [];
			await mockFlushSessionWrites();
			mockFlushSessionWrites.mockRejectedValueOnce(
				Object.assign(new Error('disk full'), { code: 'ENOSPC' })
			);
			expect(await save([session(request.item)])).toBe(false);
			mockFlushSessionWrites.mockResolvedValue(undefined);
			expect(await confirm()).toEqual({ durable: false, reason: 'session-missing' });
		});
		it('refuses a changed hold expectation when a stale renderer save preserves the stored hold', async () => {
			const baseline = structuredClone(current);
			const changed = { ...request.item, pendingAdmissionId: 'other' };
			expect(await save([session(changed)], [], baseline)).toBe(true);
			request = { ...request, pendingAdmissionId: 'other', item: changed };
			expect(await confirm()).toEqual({ durable: false, reason: 'item-changed' });
		});
		it('cannot confirm a new item after a store write fails', async () => {
			current = [];
			await mockFlushSessionWrites();
			mockSessionsStore.set.mockImplementationOnce(() => {
				throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
			});
			expect(await save([session(request.item)])).toBe(false);
			expect(await confirm()).toEqual({ durable: false, reason: 'session-missing' });
		});
		it('refuses duplicate item identities', async () => {
			current[0].executionQueue.push(structuredClone(request.item));
			expect(await confirm()).toEqual({ durable: false, reason: 'item-changed' });
		});
		it('does not accept a missing file after a purportedly successful flush', async () => {
			await realFs.unlink(mockSessionsStore.path);
			mockFlushSessionWrites.mockResolvedValue(undefined);
			expect(await confirm()).toEqual({ durable: false, reason: 'store-unavailable' });
		});
		it('serializes a competing item deletion after the save and before readback', async () => {
			const first = save(current);
			const second = save([{ ...current[0], executionQueue: [] }]);
			const receipt = confirm();
			expect(await first).toBe(true);
			expect(await second).toBe(true);
			expect(await receipt).toEqual({ durable: false, reason: 'item-missing' });
		});
		it('keeps a competing save behind the readback lock and pins caller intent', async () => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			mockFlushSessionWrites.mockImplementationOnce(async () => {
				await gate;
				await realFs.writeFile(mockSessionsStore.path, JSON.stringify({ sessions: current }));
			});
			const receipt = confirm();
			const deletion = save([{ ...current[0], executionQueue: [] }]);
			const expected = structuredClone(request);
			Object.assign(request.item, { text: 'Caller mutation' });
			release();
			expect(await receipt).toEqual({ durable: true, request: expected });
			expect(await deletion).toBe(true);
			expect(await server.confirmQueueItemFromMain(expected)).toEqual({
				durable: false,
				reason: 'item-missing',
			});
		});
		it('refuses a cache mutation during the asynchronous authoritative file read', async () => {
			vi.mocked(fs.readFile).mockImplementationOnce(
				async (...args: Parameters<typeof fs.readFile>) => {
					const bytes = await realFs.readFile(...args);
					current = [];
					return bytes;
				}
			);
			expect(await confirm()).toEqual({ durable: false, reason: 'session-missing' });
		});
		it('rejects mismatched identity bindings without flushing', async () => {
			request.pendingAdmissionId = 'unrelated';
			mockFlushSessionWrites.mockClear();
			expect(await confirm()).toEqual({ durable: false, reason: 'invalid-request' });
			expect(mockFlushSessionWrites).not.toHaveBeenCalled();
		});
	});

	describe('sessions:getActiveSessionId', () => {
		it('should return empty string when no active session is set', async () => {
			mockSessionsStore.get.mockReturnValue('');
			const handler = handlers.get('sessions:getActiveSessionId');
			const result = await handler!({} as any);
			expect(mockSessionsStore.get).toHaveBeenCalledWith('activeSessionId', '');
			expect(result).toBe('');
		});
	});

	describe('sessions:setActiveSessionId', () => {
		// The write is debounced (see registerPersistenceHandlers) to avoid a full
		// sessions-store re-serialize on every session/tab switch.
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it('debounces the disk write, then flushes after the interval', async () => {
			const setHandler = handlers.get('sessions:setActiveSessionId');
			await setHandler!({} as any, 'test-session-123');

			// Not written synchronously.
			expect(mockSessionsStore.set).not.toHaveBeenCalled();

			// Flushes once the debounce elapses.
			vi.advanceTimersByTime(400);
			expect(mockSessionsStore.set).toHaveBeenCalledTimes(1);
			expect(mockSessionsStore.set).toHaveBeenCalledWith('activeSessionId', 'test-session-123');
		});

		it('coalesces a burst of rapid switches into a single write (last wins)', async () => {
			const setHandler = handlers.get('sessions:setActiveSessionId');
			await setHandler!({} as any, 'a');
			await setHandler!({} as any, 'b');
			await setHandler!({} as any, 'c');

			vi.advanceTimersByTime(400);
			expect(mockSessionsStore.set).toHaveBeenCalledTimes(1);
			expect(mockSessionsStore.set).toHaveBeenCalledWith('activeSessionId', 'c');
		});

		it('reads back the pending id before it is flushed (read-through)', async () => {
			const setHandler = handlers.get('sessions:setActiveSessionId');
			const getHandler = handlers.get('sessions:getActiveSessionId');
			await setHandler!({} as any, 'pending-id');

			// Store not yet written, but the getter returns the pending value.
			expect(mockSessionsStore.set).not.toHaveBeenCalled();
			expect(await getHandler!({} as any)).toBe('pending-id');
			expect(mockSessionsStore.get).not.toHaveBeenCalledWith('activeSessionId', '');
		});

		it('flushes synchronously on before-quit', async () => {
			const setHandler = handlers.get('sessions:setActiveSessionId');
			await setHandler!({} as any, 'quit-id');
			expect(mockSessionsStore.set).not.toHaveBeenCalled();

			// Invoke the registered before-quit listener.
			const onCalls = vi.mocked(app.on).mock.calls as unknown as Array<[string, () => void]>;
			const beforeQuit = onCalls.find(([event]) => event === 'before-quit')?.[1];
			expect(beforeQuit).toBeDefined();
			beforeQuit!();

			expect(mockSessionsStore.set).toHaveBeenCalledWith('activeSessionId', 'quit-id');
		});

		describe('session.activated plugin event', () => {
			let emitPluginEvent: ReturnType<typeof vi.fn>;
			let setHandler: (event: unknown, id: string) => Promise<unknown>;

			beforeEach(() => {
				handlers.clear();
				emitPluginEvent = vi.fn();
				const deps: PersistenceHandlerDependencies = {
					settingsStore: mockSettingsStore as unknown as Store<MaestroSettings>,
					sessionsStore: mockSessionsStore as unknown as Store<SessionsData>,
					groupsStore: mockGroupsStore as unknown as Store<GroupsData>,
					getWebServer: getWebServerFn,
					emitPluginEvent,
				};
				registerPersistenceHandlers(deps);
				setHandler = handlers.get('sessions:setActiveSessionId') as typeof setHandler;
			});

			it('emits a metadata-only session.activated after its own short debounce', async () => {
				await setHandler({}, 'sess-1');
				expect(emitPluginEvent).not.toHaveBeenCalled();

				vi.advanceTimersByTime(100);
				expect(emitPluginEvent).toHaveBeenCalledTimes(1);
				const event = emitPluginEvent.mock.calls[0][0];
				expect(event.topic).toBe('session.activated');
				expect(event.payload).toEqual({ sessionId: 'sess-1' });
				expect(typeof event.at).toBe('string');
			});

			it('coalesces a burst of switches into one event for the session landed on', async () => {
				await setHandler({}, 'a');
				await setHandler({}, 'b');
				await setHandler({}, 'c');

				vi.advanceTimersByTime(100);
				expect(emitPluginEvent).toHaveBeenCalledTimes(1);
				expect(emitPluginEvent.mock.calls[0][0].payload).toEqual({ sessionId: 'c' });
			});

			it('does not re-emit when the same session is re-focused', async () => {
				await setHandler({}, 'same');
				vi.advanceTimersByTime(100);
				await setHandler({}, 'same');
				vi.advanceTimersByTime(100);

				expect(emitPluginEvent).toHaveBeenCalledTimes(1);
			});

			it('ignores an empty session id', async () => {
				await setHandler({}, '');
				vi.advanceTimersByTime(100);

				expect(emitPluginEvent).not.toHaveBeenCalled();
			});

			// Regression: the plugin focus verbs (index.ts) emit session.activated
			// directly, bypassing flushSessionActivated's dedupe. If the plugin path
			// does not record its id via noteSessionActivated, the two paths desync:
			// after the user is on A and a plugin focuses B, returning to A would be
			// wrongly suppressed and subscribers stay stuck on B.
			it('keeps the plugin path in sync so returning to a prior session still emits', async () => {
				handlers.clear();
				const localEmit = vi.fn();
				const { noteSessionActivated } = registerPersistenceHandlers({
					settingsStore: mockSettingsStore as unknown as Store<MaestroSettings>,
					sessionsStore: mockSessionsStore as unknown as Store<SessionsData>,
					groupsStore: mockGroupsStore as unknown as Store<GroupsData>,
					getWebServer: getWebServerFn,
					emitPluginEvent: localEmit,
				});
				const localSetHandler = handlers.get('sessions:setActiveSessionId') as (
					event: unknown,
					id: string
				) => Promise<unknown>;

				// User navigates to A: the flush path emits A (lastEmitted = A).
				await localSetHandler({}, 'A');
				vi.advanceTimersByTime(100);
				expect(localEmit).toHaveBeenCalledTimes(1);
				expect(localEmit.mock.calls[0][0].payload).toEqual({ sessionId: 'A' });

				// A plugin calls sessions.focus(B): index.ts emits B directly, then
				// records it through the shared dedupe. Simulate that record here.
				noteSessionActivated('B');

				// User returns to A: A differs from the last-emitted id (now B), so it
				// must still be emitted rather than suppressed as a repeat.
				await localSetHandler({}, 'A');
				vi.advanceTimersByTime(100);
				expect(localEmit).toHaveBeenCalledTimes(2);
				expect(localEmit.mock.calls[1][0].payload).toEqual({ sessionId: 'A' });
			});

			// Regression (race): a direct plugin focus must supersede an already-queued
			// debounced flush for a DIFFERENT session, or that stale timer fires after
			// the plugin's emit and re-announces the wrong session.
			it('cancels a pending debounced flush when the plugin directly focuses another session', async () => {
				handlers.clear();
				const localEmit = vi.fn();
				const { noteSessionActivated } = registerPersistenceHandlers({
					settingsStore: mockSettingsStore as unknown as Store<MaestroSettings>,
					sessionsStore: mockSessionsStore as unknown as Store<SessionsData>,
					groupsStore: mockGroupsStore as unknown as Store<GroupsData>,
					getWebServer: getWebServerFn,
					emitPluginEvent: localEmit,
				});
				const localSetHandler = handlers.get('sessions:setActiveSessionId') as (
					event: unknown,
					id: string
				) => Promise<unknown>;

				// User navigates to A: its 100ms flush is now armed but has NOT fired.
				await localSetHandler({}, 'A');
				expect(localEmit).not.toHaveBeenCalled();

				// A plugin directly focuses B mid-window (index.ts emits B on the bus
				// and records it here). This must cancel the pending A flush.
				noteSessionActivated('B');

				// Let the original A timer elapse: it must be dead, so A is never emitted
				// after B. Subscribers stay on B (the real active session).
				vi.advanceTimersByTime(100);
				expect(localEmit).not.toHaveBeenCalled();

				// And a later genuine navigation back to A still emits (B was the last
				// recorded id, so A is not a duplicate).
				await localSetHandler({}, 'A');
				vi.advanceTimersByTime(100);
				expect(localEmit).toHaveBeenCalledTimes(1);
				expect(localEmit.mock.calls[0][0].payload).toEqual({ sessionId: 'A' });
			});
		});
	});

	describe('settings:get', () => {
		it('should retrieve setting by key', async () => {
			mockSettingsStore.get.mockReturnValue('dark');

			const handler = handlers.get('settings:get');
			const result = await handler!({} as any, 'activeThemeId');

			expect(mockSettingsStore.get).toHaveBeenCalledWith('activeThemeId');
			expect(result).toBe('dark');
		});

		it('should return undefined for missing key', async () => {
			mockSettingsStore.get.mockReturnValue(undefined);

			const handler = handlers.get('settings:get');
			const result = await handler!({} as any, 'nonExistentKey');

			expect(mockSettingsStore.get).toHaveBeenCalledWith('nonExistentKey');
			expect(result).toBeUndefined();
		});

		it('should retrieve nested key values', async () => {
			mockSettingsStore.get.mockReturnValue({ ctrl: true, key: 'k' });

			const handler = handlers.get('settings:get');
			const result = await handler!({} as any, 'shortcuts.openCommandPalette');

			expect(mockSettingsStore.get).toHaveBeenCalledWith('shortcuts.openCommandPalette');
			expect(result).toEqual({ ctrl: true, key: 'k' });
		});
	});

	it('reads media status using the live host setting', async () => {
		const runtime = { binaries: {}, models: {} };
		const status = { profiles: [], models: [], missing: ['model-directory'] };
		mockSettingsStore.get.mockReturnValue('/models');
		vi.mocked(resolveMediaRuntime).mockResolvedValue(runtime);
		vi.mocked(getMediaToolStatus).mockReturnValue(status as never);
		expect(await handlers.get('settings:mediaStatus')!({})).toEqual(status);
		expect(resolveMediaRuntime).toHaveBeenCalledWith('/models');
		expect(getMediaToolStatus).toHaveBeenCalledWith(runtime);
	});

	describe('settings:set', () => {
		it.each(['mediaModelDirectory.child', 'mediaModelDirectory.child.deep'])(
			'rejects nested media key %s without overwriting the directory',
			async (key) => {
				mockSettingsStore.get.mockReturnValue('/canonical/models');
				expect(await handlers.get('settings:set')!({}, key, 'replacement')).toBe(false);
				expect(mockSettingsStore.set).not.toHaveBeenCalled();
			}
		);

		it.each(['relative/models', '~/models', 42, null, {}])(
			'rejects invalid media directory %j without writing',
			async (value) => {
				expect(await handlers.get('settings:set')!({}, 'mediaModelDirectory', value)).toBe(false);
				expect(mockSettingsStore.set).not.toHaveBeenCalled();
			}
		);

		it('stores a canonical existing media directory', async () => {
			vi.mocked(fs.realpath).mockResolvedValue('/canonical/models');
			vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as never);
			expect(await handlers.get('settings:set')!({}, 'mediaModelDirectory', '/alias/models')).toBe(
				true
			);
			expect(mockSettingsStore.set).toHaveBeenCalledWith(
				'mediaModelDirectory',
				'/canonical/models'
			);
		});

		it('rejects missing or non-directory media paths without overwriting the setting', async () => {
			vi.mocked(fs.realpath).mockRejectedValueOnce(new Error('ENOENT'));
			expect(await handlers.get('settings:set')!({}, 'mediaModelDirectory', '/missing')).toBe(
				false
			);
			vi.mocked(fs.realpath).mockResolvedValue('/file');
			vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as never);
			expect(await handlers.get('settings:set')!({}, 'mediaModelDirectory', '/file')).toBe(false);
			expect(mockSettingsStore.set).not.toHaveBeenCalled();
		});

		it('allows clearing the host directory for the environment fallback', async () => {
			expect(await handlers.get('settings:set')!({}, 'mediaModelDirectory', '')).toBe(true);
			expect(mockSettingsStore.set).toHaveBeenCalledWith('mediaModelDirectory', '');
		});

		it('should store setting value', async () => {
			const handler = handlers.get('settings:set');
			const result = await handler!({} as any, 'fontSize', 16);

			expect(mockSettingsStore.set).toHaveBeenCalledWith('fontSize', 16);
			expect(result).toBe(true);
		});

		it('should persist string value', async () => {
			const handler = handlers.get('settings:set');
			const result = await handler!({} as any, 'fontFamily', 'Monaco');

			expect(mockSettingsStore.set).toHaveBeenCalledWith('fontFamily', 'Monaco');
			expect(result).toBe(true);
		});

		// usageStats holds lifetime high-water marks. The merge lives here, not
		// in the renderer, because the caller's own copy cannot be trusted: a
		// renderer mid-hydration still holds zeros, and a second window holds a
		// stale snapshot. Either one used to be able to overwrite a real peak.
		describe('usageStats peaks', () => {
			const stored = {
				maxAgents: 89,
				maxDefinedAgents: 89,
				maxSimultaneousAutoRuns: 8,
				maxSimultaneousQueries: 8,
				maxQueueDepth: 16,
			};

			it('refuses a write that would lower a stored peak', async () => {
				mockSettingsStore.get.mockReturnValue(stored);

				const handler = handlers.get('settings:set');
				const result = await handler!({} as any, 'usageStats', {
					maxAgents: 12,
					maxDefinedAgents: 12,
					maxSimultaneousAutoRuns: 1,
					maxSimultaneousQueries: 2,
					maxQueueDepth: 0,
				});

				expect(mockSettingsStore.set).toHaveBeenCalledWith('usageStats', stored);
				expect(result).toBe(true);
			});

			it('raises only the counters that were beaten', async () => {
				mockSettingsStore.get.mockReturnValue(stored);

				const handler = handlers.get('settings:set');
				await handler!({} as any, 'usageStats', { ...stored, maxQueueDepth: 21 });

				expect(mockSettingsStore.set).toHaveBeenCalledWith('usageStats', {
					...stored,
					maxQueueDepth: 21,
				});
			});

			// The exact shape of the incident: an unhydrated renderer sends its
			// zeroed defaults maxed against a live snapshot.
			it('survives a write from a caller whose baseline is zeroed', async () => {
				mockSettingsStore.get.mockReturnValue(stored);

				const handler = handlers.get('settings:set');
				await handler!({} as any, 'usageStats', {
					maxAgents: 88,
					maxDefinedAgents: 88,
					maxSimultaneousAutoRuns: 1,
					maxSimultaneousQueries: 3,
					maxQueueDepth: 2,
				});

				expect(mockSettingsStore.set).toHaveBeenCalledWith('usageStats', stored);
			});

			it('accepts the first write when nothing is stored yet', async () => {
				mockSettingsStore.get.mockReturnValue(undefined);

				const handler = handlers.get('settings:set');
				await handler!({} as any, 'usageStats', { maxAgents: 4 });

				expect(mockSettingsStore.set).toHaveBeenCalledWith('usageStats', {
					maxAgents: 4,
					maxDefinedAgents: 0,
					maxSimultaneousAutoRuns: 0,
					maxSimultaneousQueries: 0,
					maxQueueDepth: 0,
				});
			});

			it('leaves every other key untouched by the merge', async () => {
				mockSettingsStore.get.mockReturnValue({ maxAgents: 99 });

				const handler = handlers.get('settings:set');
				await handler!({} as any, 'onboardingStats', { wizardStartCount: 5 });

				expect(mockSettingsStore.set).toHaveBeenCalledWith('onboardingStats', {
					wizardStartCount: 5,
				});
			});
		});

		// autoRunStats is lifetime Conductor time, runs and badges. A Cue credit
		// applied to a zeroed renderer copy once replaced 1,352 hours with 10.
		describe('autoRunStats totals', () => {
			const stored = {
				cumulativeTimeMs: 4_869_514_889,
				cueTimeMs: 1_655_880_000,
				longestRunMs: 82_370_665,
				longestRunTimestamp: 1_783_641_600_000,
				totalRuns: 326,
				currentBadgeLevel: 6,
				lastBadgeUnlockLevel: 6,
				lastAcknowledgedBadgeLevel: 6,
				badgeHistory: [{ level: 2, unlockedAt: 1_764_668_373_382 }],
			};

			it('refuses a write from a caller whose baseline was zeroed', async () => {
				mockSettingsStore.get.mockReturnValue(stored);

				const handler = handlers.get('settings:set');
				await handler!({} as any, 'autoRunStats', {
					cumulativeTimeMs: 60_000,
					cueTimeMs: 60_000,
					longestRunMs: 0,
					longestRunTimestamp: 0,
					totalRuns: 0,
					currentBadgeLevel: 0,
					lastBadgeUnlockLevel: 0,
					lastAcknowledgedBadgeLevel: 0,
					badgeHistory: [],
				});

				expect(mockSettingsStore.set).toHaveBeenCalledWith('autoRunStats', stored);
			});

			it('takes a genuine increase', async () => {
				mockSettingsStore.get.mockReturnValue(stored);

				const handler = handlers.get('settings:set');
				await handler!({} as any, 'autoRunStats', {
					...stored,
					cumulativeTimeMs: stored.cumulativeTimeMs + 60_000,
				});

				expect(mockSettingsStore.set).toHaveBeenCalledWith('autoRunStats', {
					...stored,
					cumulativeTimeMs: stored.cumulativeTimeMs + 60_000,
				});
			});
		});

		it('should handle nested keys', async () => {
			const handler = handlers.get('settings:set');
			const result = await handler!({} as any, 'shortcuts.newTab', { ctrl: true, key: 't' });

			expect(mockSettingsStore.set).toHaveBeenCalledWith('shortcuts.newTab', {
				ctrl: true,
				key: 't',
			});
			expect(result).toBe(true);
		});

		it('should notify other windows but never the window that wrote', async () => {
			const { BrowserWindow } = await import('electron');
			const makeWindow = (id: number) => ({
				isDestroyed: () => false,
				webContents: { id, send: vi.fn(), isDestroyed: () => false },
			});
			const writer = makeWindow(1);
			const peer = makeWindow(2);
			(BrowserWindow.getAllWindows as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
				writer,
				peer,
			]);

			const handler = handlers.get('settings:set');
			await handler!({ sender: { id: 1 } } as any, 'fontSize', 16);

			// Echoing the write back to its own window makes that renderer reload
			// settings asynchronously on top of whatever is being typed.
			expect(writer.webContents.send).not.toHaveBeenCalled();
			expect(peer.webContents.send).toHaveBeenCalledWith('settings:externalChange');
		});

		it('should broadcast theme changes to connected web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(3);
			const { getThemeById } = await import('../../../../main/themes');

			const handler = handlers.get('settings:set');
			await handler!({} as any, 'activeThemeId', 'light');

			expect(mockSettingsStore.set).toHaveBeenCalledWith('activeThemeId', 'light');
			expect(getThemeById).toHaveBeenCalledWith('light');
			expect(mockWebServer.broadcastThemeChange).toHaveBeenCalled();
		});

		it('should not broadcast theme changes when no web clients connected', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(0);

			const handler = handlers.get('settings:set');
			await handler!({} as any, 'activeThemeId', 'light');

			expect(mockWebServer.broadcastThemeChange).not.toHaveBeenCalled();
		});

		it('should cascade every settings change to peer windows (settings are global)', async () => {
			const { BrowserWindow } = await import('electron');
			const peer = {
				isDestroyed: () => false,
				webContents: { id: 2, send: vi.fn(), isDestroyed: () => false },
			};
			(BrowserWindow.getAllWindows as unknown as ReturnType<typeof vi.fn>).mockReturnValue([peer]);

			const handler = handlers.get('settings:set');

			// A UI-driven theme switch must reach every other window, not just the sender.
			await handler!({ sender: { id: 1 } } as any, 'activeThemeId', 'light');
			expect(peer.webContents.send).toHaveBeenCalledWith('settings:externalChange');

			// Not theme-specific: any setting cascades so all windows stay in unison.
			peer.webContents.send.mockClear();
			await handler!({ sender: { id: 1 } } as any, 'fontSize', 16);
			expect(peer.webContents.send).toHaveBeenCalledWith('settings:externalChange');
		});

		it('should not cascade when the settings write fails', async () => {
			mockSettingsStore.set.mockImplementationOnce(() => {
				const err = new Error('disk full') as NodeJS.ErrnoException;
				err.code = 'ENOSPC';
				throw err;
			});

			const { BrowserWindow } = await import('electron');
			const peer = {
				isDestroyed: () => false,
				webContents: { id: 2, send: vi.fn(), isDestroyed: () => false },
			};
			(BrowserWindow.getAllWindows as unknown as ReturnType<typeof vi.fn>).mockReturnValue([peer]);

			const handler = handlers.get('settings:set');
			const result = await handler!({ sender: { id: 1 } } as any, 'activeThemeId', 'light');

			expect(result).toBe(false);
			expect(peer.webContents.send).not.toHaveBeenCalled();
		});

		it('should broadcast bionify reading mode changes to connected web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);

			const handler = handlers.get('settings:set');
			await handler!({} as any, 'bionifyReadingMode', true);

			expect(mockSettingsStore.set).toHaveBeenCalledWith('bionifyReadingMode', true);
			expect(mockWebServer.broadcastBionifyReadingModeChange).toHaveBeenCalledWith(true);
		});

		it('should not broadcast bionify reading mode changes when no web clients connected', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(0);

			const handler = handlers.get('settings:set');
			await handler!({} as any, 'bionifyReadingMode', true);

			expect(mockWebServer.broadcastBionifyReadingModeChange).not.toHaveBeenCalled();
		});

		it('should broadcast custom commands changes to connected web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const customCommands = [{ name: 'test', prompt: 'test prompt' }];

			const handler = handlers.get('settings:set');
			await handler!({} as any, 'customAICommands', customCommands);

			expect(mockWebServer.broadcastCustomCommands).toHaveBeenCalledWith(customCommands);
		});

		it('should not broadcast custom commands when no web clients connected', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(0);

			const handler = handlers.get('settings:set');
			await handler!({} as any, 'customAICommands', []);

			expect(mockWebServer.broadcastCustomCommands).not.toHaveBeenCalled();
		});

		it('should broadcast generic web settings (e.g. maxOutputLines) to connected web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(1);
			mockSettingsStore.get.mockImplementation((key: string, def: unknown) => {
				if (key === 'maxOutputLines') return 25;
				return def;
			});

			const handler = handlers.get('settings:set');
			await handler!({} as any, 'maxOutputLines', 25);

			expect(mockSettingsStore.set).toHaveBeenCalledWith('maxOutputLines', 25);
			expect(mockWebServer.broadcastSettingsChanged).toHaveBeenCalledTimes(1);
			expect(mockWebServer.broadcastSettingsChanged).toHaveBeenCalledWith(
				expect.objectContaining({ maxOutputLines: 25 })
			);
		});

		it('should not broadcast generic web settings when no web clients are connected', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(0);

			const handler = handlers.get('settings:set');
			await handler!({} as any, 'maxOutputLines', 25);

			expect(mockWebServer.broadcastSettingsChanged).not.toHaveBeenCalled();
		});

		it('should not broadcast for keys outside the web-relevant set', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(1);

			const handler = handlers.get('settings:set');
			await handler!({} as any, 'someUnrelatedSetting', 'value');

			expect(mockWebServer.broadcastSettingsChanged).not.toHaveBeenCalled();
		});

		it('should handle null webServer gracefully', async () => {
			// Re-register handlers with null webServer
			handlers.clear();
			const deps: PersistenceHandlerDependencies = {
				settingsStore: mockSettingsStore as unknown as Store<MaestroSettings>,
				sessionsStore: mockSessionsStore as unknown as Store<SessionsData>,
				groupsStore: mockGroupsStore as unknown as Store<GroupsData>,
				getWebServer: () => null,
				flushSessionWrites: mockFlushSessionWrites,
			};
			registerPersistenceHandlers(deps);

			const handler = handlers.get('settings:set');
			const result = await handler!({} as any, 'activeThemeId', 'dark');

			expect(result).toBe(true);
			expect(mockSettingsStore.set).toHaveBeenCalledWith('activeThemeId', 'dark');
		});

		it('should return false on ENOSPC write error', async () => {
			const error = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
			error.code = 'ENOSPC';
			mockSettingsStore.set.mockImplementation(() => {
				throw error;
			});

			const handler = handlers.get('settings:set');
			const result = await handler!({} as any, 'fontSize', 16);

			expect(result).toBe(false);
		});
	});

	describe('settings:getAll', () => {
		it('should return all settings', async () => {
			const handler = handlers.get('settings:getAll');
			const result = await handler!({} as any);

			expect(result).toEqual({ activeThemeId: 'dark', fontSize: 14 });
		});

		it('should return empty object when no settings exist', async () => {
			mockSettingsStore.store = {};

			const handler = handlers.get('settings:getAll');
			const result = await handler!({} as any);

			expect(result).toEqual({});
		});
	});

	describe('sessions:getAll', () => {
		it('should load sessions from store', async () => {
			const mockSessions = [
				{ id: 'session-1', name: 'Session 1', cwd: '/test' },
				{ id: 'session-2', name: 'Session 2', cwd: '/test2' },
			];
			mockSessionsStore.get.mockReturnValue(mockSessions);

			const handler = handlers.get('sessions:getAll');
			const result = await handler!({} as any);

			expect(mockSessionsStore.get).toHaveBeenCalledWith('sessions', []);
			expect(result).toEqual(mockSessions);
		});

		it('should return empty array for missing sessions', async () => {
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:getAll');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});

		it('heals closed-tab stacks to their stored form and rewrites the store once', async () => {
			const sessions = [
				{
					id: 'session-1',
					toolType: 'claude-code',
					closedTabHistory: [
						{ tab: { id: 'closed', logs: [{ id: 'l1' }] }, index: 0, closedAt: 1 },
					],
					unifiedClosedTabHistory: [
						{
							type: 'ai',
							tab: { id: 'closed', agentSessionId: 'provider-1', logs: [{ id: 'l1' }] },
							unifiedIndex: 0,
							closedAt: 1,
						},
					],
				},
				{ id: 'session-2', toolType: 'claude-code', unifiedClosedTabHistory: [] },
			];
			mockSessionsStore.get.mockReturnValue(sessions);

			const result = (await handlers.get('sessions:getAll')!({} as any)) as any[];

			expect(result[0]).not.toHaveProperty('closedTabHistory');
			expect(result[0].unifiedClosedTabHistory[0].tab.logs).toEqual([]);
			expect(result[1]).not.toHaveProperty('unifiedClosedTabHistory');
			expect(mockSessionsStore.set).toHaveBeenCalledWith('sessions', result);
		});

		it('should compact oversized tool output before returning legacy sessions', async () => {
			const oversizedOutput = 'x'.repeat(50_000);
			const sessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					aiLogs: [
						{
							id: 'legacy-tool',
							metadata: { toolState: { status: 'completed', output: oversizedOutput } },
						},
					],
					aiTabs: [
						{
							id: 'tab-1',
							logs: [
								{
									id: 'tool-1',
									metadata: { toolState: { status: 'completed', output: oversizedOutput } },
								},
							],
						},
					],
					snoozedTabs: [
						{
							type: 'group',
							members: [
								{
									type: 'ai',
									tab: {
										id: 'snoozed-tab',
										logs: [
											{
												id: 'snoozed-tool',
												metadata: {
													toolState: {
														status: 'completed',
														output: oversizedOutput,
													},
												},
											},
										],
									},
								},
							],
						},
					],
				},
			];
			mockSessionsStore.get.mockReturnValue(sessions);

			const handler = handlers.get('sessions:getAll');
			const result = (await handler!({} as any)) as typeof sessions;
			const output = result[0].aiTabs[0].logs[0].metadata.toolState.output;
			const legacyOutput = result[0].aiLogs[0].metadata.toolState.output;
			const snoozedOutput =
				result[0].snoozedTabs[0].members[0].tab.logs[0].metadata.toolState.output;

			expect(output.length).toBeLessThan(5_000);
			expect(output).toContain('[tool output truncated');
			expect(legacyOutput).toBe(output);
			expect(snoozedOutput).toBe(output);
			expect(mockSessionsStore.set).toHaveBeenCalledWith('sessions', result);
		});
	});

	describe('browser session bootstrap', () => {
		const stored = {
			id: 's1',
			name: 'Agent',
			cwd: '/test',
			projectRoot: '/test',
			state: 'idle',
			inputMode: 'ai',
			toolType: 'claude-code',
			createdAt: 100,
			aiLogs: [{ id: 'legacy-ai', text: 'legacy message' }],
			shellLogs: [{ id: 'old-shell', text: 'old shell output' }],
			agentCommands: [{ command: '/old', description: 'Old' }],
			aiCommandHistory: ['old prompt'],
			aiTabs: [
				{ id: 't1', logs: [{ id: 'old-log', text: 'old message' }] },
				{ id: 't2', logs: [{ id: 'other-log', text: 'other message' }] },
			],
			snoozedTabs: [
				{
					type: 'group',
					members: [{ type: 'ai', tab: { id: 'parked', logs: [{ id: 'parked-log' }] } }],
				},
			],
		};

		it('keeps responsive owner inventory and falls back only for a missing owner during bootstrap', async () => {
			vi.useFakeTimers();
			mockSessionsStore.get.mockReturnValue([
				{
					...stored,
					state: 'busy',
					busySource: 'ai',
					thinkingStartTime: 1,
					aiTabs: stored.aiTabs.map((tab) => ({ ...tab, state: 'busy', thinkingStartTime: 1 })),
				},
				{ ...stored, id: 'missing-owner' },
			]);
			const browserTabs = [
				{
					id: 'private',
					url: 'https://example.test',
					title: 'Live private tab',
					ephemeral: true,
					partition: 'live-temporary',
				},
			];
			const terminalTabs = [{ id: 'live-terminal', pid: 0, ptyInitialized: true }];
			const win = {
				isDestroyed: () => false,
				webContents: {
					id: 1,
					isDestroyed: () => false,
					send: (
						channel: string,
						payload: { sessionId: string; tabId: string; requestId: string; metadataOnly?: boolean }
					) => {
						if (channel !== 'sessions:transcriptRequest' || payload.sessionId !== stored.id) return;
						expect(payload.metadataOnly).toBe(true);
						handlers.get('sessions:publishTranscript')!(
							{ sender: { id: 1 } },
							{
								sessionId: payload.sessionId,
								field: 'shellLogs',
								upserts: [],
								removedIds: [],
								orderIds: [],
								snapshot: true,
								tabInventory: [
									{ id: 't1', state: 'idle', clearRuntimeFields: ['thinkingStartTime'] },
									{ id: 'new-live-tab', name: 'Acknowledged before disk flush' },
								],
								runtime: { state: 'waiting_input', browserTabs, terminalTabs },
								clearRuntimeFields: ['busySource', 'thinkingStartTime', 'statusMessage'],
							},
							payload.requestId
						);
					},
				},
			};
			// Partial window fixture models the trusted native publication endpoint.
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([win] as unknown as BrowserWindow[]);
			try {
				const pending = handlers.get('sessions:getBootstrap')!({ type: 'bridge' });
				await vi.advanceTimersByTimeAsync(5000);
				const [bootstrap, fallback] = await pending;
				expect(fallback.id).toBe('missing-owner');
				expect(
					fallback.aiTabs.map((tab: { id: string; logs: unknown[] }) => ({
						id: tab.id,
						logs: tab.logs,
					}))
				).toEqual([
					{ id: 't1', logs: [] },
					{ id: 't2', logs: [] },
				]);
				expect(bootstrap.browserTabs).toEqual(browserTabs);
				expect(bootstrap.terminalTabs).toEqual(terminalTabs);
				expect(bootstrap.state).toBe('waiting_input');
				expect(bootstrap.busySource).toBeUndefined();
				expect(bootstrap.thinkingStartTime).toBeUndefined();
				expect(bootstrap.aiTabs[0].state).toBe('idle');
				expect(bootstrap.aiTabs[0].thinkingStartTime).toBeUndefined();
				expect(bootstrap.aiTabs).toEqual([
					expect.objectContaining({ id: 't1', logs: [] }),
					expect.objectContaining({
						id: 'new-live-tab',
						name: 'Acknowledged before disk flush',
						logs: [],
					}),
				]);
				expect(bootstrap.deferredContent.tabIds).toEqual(['t1', 'new-live-tab']);
				expect(bootstrap.transcriptSnapshots).toEqual([
					{
						sessionId: stored.id,
						runtime: { state: 'waiting_input', browserTabs, terminalTabs },
						clearRuntimeFields: ['busySource', 'thinkingStartTime', 'statusMessage'],
					},
				]);
				expect(fallback).not.toHaveProperty('transcriptSnapshots');
				expect(broadcastBridgeEvent).not.toHaveBeenCalled();
				expect(bootstrap.aiTabs[0].logs).toEqual([]);
				expect(mockSessionsStore.set).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
				vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
			}
		});
		it('reads the unflushed canonical host conversation instead of stale disk rows', async () => {
			mockSessionsStore.get.mockReturnValue([stored]);
			const logs = [
				{ id: 'owner-live-row', timestamp: 1, source: 'stdout', text: 'not yet debounced to disk' },
			];
			let requestId = '';
			const peerSend = vi.fn();
			const peer = {
				isDestroyed: () => false,
				webContents: { id: 2, isDestroyed: () => false, send: peerSend },
			};
			const win = {
				isDestroyed: () => false,
				webContents: {
					id: 1,
					isDestroyed: () => false,
					send: (
						channel: string,
						payload: { sessionId: string; tabId: string; requestId: string }
					) => {
						if (channel !== 'sessions:transcriptRequest') return;
						requestId = payload.requestId;
						handlers.get('sessions:publishTranscript')!(
							{ sender: { id: 1 } },
							{
								sessionId: payload.sessionId,
								tabId: payload.tabId,
								field: 'logs',
								upserts: logs,
								removedIds: [],
								orderIds: logs.map((row) => row.id),
								snapshot: true,
								runtime: {
									state: 'idle',
									agentError: { message: 'provider exited' },
									agentErrorPaused: true,
								},
								clearRuntimeFields: ['thinkingStartTime'],
							},
							payload.requestId
						);
					},
				},
			};
			// Partial window fixture models the trusted native publication endpoint.
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
				win,
				peer,
			] as unknown as BrowserWindow[]);
			try {
				const content = await handlers.get('sessions:getDeferredContent')!(
					{ type: 'bridge' },
					's1',
					'new-live-tab',
					false
				);
				expect(content.logs).toEqual(logs);
				expect(content.transcriptSnapshots).toEqual([
					expect.objectContaining({
						runtime: {
							state: 'idle',
							agentError: { message: 'provider exited' },
							agentErrorPaused: true,
						},
						clearRuntimeFields: ['thinkingStartTime'],
					}),
				]);
				expect(
					peerSend.mock.calls.filter(([channel]) => channel === 'sessions:transcriptSync')
				).toEqual([]);
				expect(broadcastBridgeEvent).not.toHaveBeenCalledWith(
					'sessions:transcriptSync',
					expect.anything()
				);
				// A late duplicate remains private after its waiter has been resolved.
				expect(
					handlers.get('sessions:publishTranscript')!(
						{ sender: { id: 1 } },
						{
							sessionId: 's1',
							tabId: 't1',
							field: 'logs',
							upserts: logs,
							removedIds: [],
							orderIds: logs.map((row) => row.id),
							snapshot: true,
						},
						requestId
					)
				).toBe(false);
				expect(
					peerSend.mock.calls.filter(([channel]) => channel === 'sessions:transcriptSync')
				).toEqual([]);
				expect(broadcastBridgeEvent).not.toHaveBeenCalledWith(
					'sessions:transcriptSync',
					expect.anything()
				);
				expect(mockSessionsStore.set).not.toHaveBeenCalled();
			} finally {
				vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
			}
		});
		it('rejects a missing live owner rather than silently substituting disk transcript', async () => {
			vi.useFakeTimers();
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
			mockSessionsStore.get.mockReturnValue([stored]);
			try {
				const failed = expect(
					handlers.get('sessions:getDeferredContent')!({ type: 'bridge' }, 's1', 't1', false)
				).rejects.toThrow('Owning host renderer did not provide the current transcript');
				await vi.advanceTimersByTimeAsync(5000);
				await failed;
			} finally {
				vi.useRealTimers();
			}
		});
		it('refuses remote clients attempting to mint host transcript identities', () => {
			expect(() =>
				handlers.get('sessions:publishTranscript')!(
					{ type: 'bridge' },
					{
						sessionId: 's1',
						field: 'logs',
						upserts: [{ id: 'client-forged' }],
						removedIds: [],
						orderIds: [],
					}
				)
			).toThrow('Only the owning host renderer');
		});
		it('sends metadata first and reads one conversation on demand', async () => {
			mockSessionsStore.get.mockReturnValue([stored]);
			const [thin] = await handlers.get('sessions:getBootstrap')!({} as any);
			expect(thin.aiTabs.map((tab: { logs: unknown[] }) => tab.logs)).toEqual([[], []]);
			expect(thin.snoozedTabs[0].members[0].tab.logs).toEqual([]);
			expect(thin.agentCommands).toBeUndefined();
			expect(thin.aiCommandHistory).toBeUndefined();
			expect(thin.aiLogs).toEqual([]);
			expect(thin.shellLogs).toEqual([]);
			expect(thin.deferredContent).toEqual({
				tabIds: ['t1', 't2', 'parked'],
				commands: true,
			});
			expect(stored.aiTabs[0].logs).toEqual([{ id: 'old-log', text: 'old message' }]);
			expect(
				await handlers.get('sessions:getDeferredContent')!({} as any, 's1', 't1', true)
			).toEqual({
				logs: stored.aiTabs[0].logs,
				shellLogs: stored.shellLogs,
				agentCommands: stored.agentCommands,
				aiCommandHistory: stored.aiCommandHistory,
			});
		});

		it.each(['sessions:setAll', 'sessions:setMany'])(
			'%s preserves unloaded data while saving browser edits',
			async (channel) => {
				mockSessionsStore.get.mockReturnValue([stored, { ...stored, id: 's2' }]);
				const [thin] = await handlers.get('sessions:getBootstrap')!({} as any);
				const changed = {
					...thin,
					name: 'Renamed',
					aiTabs: [
						{ ...thin.aiTabs[0], logs: [{ id: 'new-log', text: 'new message' }] },
						thin.aiTabs[1],
					],
					aiCommandHistory: ['new prompt'],
					shellLogs: [{ id: 'new-shell', text: 'new shell output' }],
				};
				await handlers.get(channel)!({} as any, [changed], []);
				const saved = mockSessionsStore.set.mock.calls.at(-1)![1] as (typeof stored)[];
				expect(saved.map((agent) => agent.id)).toEqual(['s1', 's2']);
				expect(saved[0].name).toBe('Renamed');
				expect(saved[0].aiTabs[0].logs.map((log) => log.id)).toEqual(['old-log', 'new-log']);
				expect(saved[0].aiTabs[1].logs).toEqual(stored.aiTabs[1].logs);
				expect(saved[0].snoozedTabs[0].members[0].tab.logs).toEqual([{ id: 'parked-log' }]);
				expect(saved[0].agentCommands).toEqual(stored.agentCommands);
				expect(saved[0].aiCommandHistory).toEqual(['old prompt', 'new prompt']);
				expect(saved[0].aiLogs).toEqual(stored.aiLogs);
				expect(saved[0].shellLogs.map((log) => log.id)).toEqual(['old-shell', 'new-shell']);
				expect((saved[0] as StoredSession).deferredContent).toBeUndefined();
			}
		);

		it.each(['sessions:setAll', 'sessions:setMany'])(
			'%s saves a rename after another client closes an unloaded tab',
			async (channel) => {
				const afterClose = { ...stored, aiTabs: [stored.aiTabs[0]], snoozedTabs: [] };
				mockSessionsStore.get.mockReturnValueOnce([stored]).mockReturnValue([afterClose]);
				const [thin] = await handlers.get('sessions:getBootstrap')!({} as any);
				await handlers.get(channel)!({} as any, [
					{
						...thin,
						name: 'Renamed',
						activeTabId: 't2',
						unifiedTabOrder: [
							{ type: 'ai', id: 't1' },
							{ type: 'ai', id: 't2' },
						],
					},
				]);
				const [saved] = mockSessionsStore.set.mock.calls.at(-1)![1];
				expect(saved.name).toBe('Renamed');
				expect(saved.aiTabs.map((tab: { id: string }) => tab.id)).toEqual(['t1']);
				expect(saved.aiTabs[0].logs).toEqual(stored.aiTabs[0].logs);
				expect(saved.snoozedTabs).toEqual([]);
				expect(saved.activeTabId).toBe('t1');
				expect(saved.unifiedTabOrder).toEqual([{ type: 'ai', id: 't1' }]);
			}
		);

		it.each(['sessions:setAll', 'sessions:setMany'])(
			'%s ignores an obsolete deferred agent while saving another agent',
			async (channel) => {
				mockSessionsStore.get.mockReturnValueOnce([stored]);
				const [obsolete] = await handlers.get('sessions:getBootstrap')!({} as any);
				mockSessionsStore.get.mockReturnValue([{ ...stored, id: 'survivor' }]);
				await handlers.get(channel)!({} as any, [
					obsolete,
					{ ...stored, id: 'survivor', name: 'Renamed' },
				]);
				const saved = mockSessionsStore.set.mock.calls.at(-1)![1];
				expect(saved.map((session: StoredSession) => [session.id, session.name])).toEqual([
					['survivor', 'Renamed'],
				]);
			}
		);

		it('does not resurrect a tab that the browser deliberately closed', async () => {
			mockSessionsStore.get.mockReturnValue([stored]);
			const [thin] = await handlers.get('sessions:getBootstrap')!({} as any);
			await handlers.get('sessions:setMany')!({} as any, [{ ...thin, aiTabs: [thin.aiTabs[0]] }]);
			const saved = mockSessionsStore.set.mock.calls.at(-1)![1];
			expect(saved[0].aiTabs.map((tab: { id: string }) => tab.id)).toEqual(['t1']);
		});
	});

	describe('sessions:setAll', () => {
		it('should write sessions to store', async () => {
			const sessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:setAll');
			const result = await handler!({} as any, sessions);

			expect(mockSessionsStore.set).toHaveBeenCalledWith('sessions', sessions);
			expect(mockFlushSessionWrites).toHaveBeenCalledOnce();
			expect(result).toBe(true);
		});

		it('should compact oversized tool output before writing sessions', async () => {
			const oversizedOutput = 'x'.repeat(50_000);
			const sessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
					aiTabs: [
						{
							id: 'tab-1',
							logs: [{ metadata: { toolState: { output: oversizedOutput } } }],
						},
					],
				},
			];
			mockSessionsStore.get.mockReturnValue([]);

			await handlers.get('sessions:setAll')!({} as any, sessions);

			const persisted = mockSessionsStore.set.mock.calls[0][1];
			const output = persisted[0].aiTabs[0].logs[0].metadata.toolState.output;
			expect(output.length).toBeLessThan(5_000);
			expect(output).toContain('[tool output truncated');
		});

		it('should detect new sessions and broadcast to web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions: any[] = [];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const newSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, newSessions);

			expect(mockWebServer.broadcastSessionAdded).toHaveBeenCalledWith({
				id: 'session-1',
				name: 'Session 1',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/test',
				groupId: null,
				groupName: null,
				groupEmoji: null,
				parentSessionId: null,
				worktreeBranch: null,
				autoRunFolderPath: null,
			});
		});

		it('should preserve stored sessions omitted from a bootstrap snapshot', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, []);

			expect(mockSessionsStore.set).toHaveBeenCalledWith('sessions', previousSessions);
			expect(mockWebServer.broadcastSessionRemoved).not.toHaveBeenCalled();
		});

		it('should detect state changes and broadcast to web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const updatedSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'busy',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, updatedSessions);

			expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalledWith('session-1', 'busy', {
				name: 'Session 1',
				toolType: 'claude-code',
				inputMode: 'ai',
				cwd: '/test',
				cliActivity: undefined,
			});
		});

		it('should detect name changes and broadcast to web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const updatedSessions = [
				{
					id: 'session-1',
					name: 'Renamed Session',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, updatedSessions);

			expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalled();
		});

		it('should detect inputMode changes and broadcast to web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const updatedSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'terminal',
					toolType: 'claude-code',
				},
			];

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, updatedSessions);

			expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalled();
		});

		it('should detect cliActivity changes and broadcast to web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
					cliActivity: null,
				},
			];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const updatedSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
					cliActivity: { active: true },
				},
			];

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, updatedSessions);

			expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalled();
		});

		// Characterization tests for cliActivity diff semantics. PR-A commit 2 will
		// swap the JSON.stringify comparison for a shallow field compare; these
		// tests pin down the exact (prev, curr) pairs that must continue to
		// broadcast (or stay silent) so the swap is verifiable.
		describe('cliActivity diff (lock-in for shallow-compare swap)', () => {
			const baseSession = {
				id: 'session-1',
				name: 'Session 1',
				cwd: '/test',
				state: 'idle' as const,
				inputMode: 'ai' as const,
				toolType: 'claude-code',
			};
			const playbookA = { playbookId: 'pb-a', playbookName: 'Build', startedAt: 1000 };
			const playbookB = { playbookId: 'pb-b', playbookName: 'Test', startedAt: 2000 };

			beforeEach(() => {
				mockWebServer.getWebClientCount.mockReturnValue(2);
			});

			it('does not broadcast when both prev and curr have no cliActivity', async () => {
				mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);
				const handler = handlers.get('sessions:setAll');
				await handler!({} as any, [{ ...baseSession }]);
				expect(mockWebServer.broadcastSessionStateChange).not.toHaveBeenCalled();
			});

			it('broadcasts when cliActivity goes from undefined to playbook', async () => {
				mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);
				const handler = handlers.get('sessions:setAll');
				await handler!({} as any, [{ ...baseSession, cliActivity: playbookA }]);
				expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalledTimes(1);
			});

			it('broadcasts when cliActivity goes from playbook to undefined', async () => {
				mockSessionsStore.get.mockReturnValue([{ ...baseSession, cliActivity: playbookA }]);
				const handler = handlers.get('sessions:setAll');
				await handler!({} as any, [{ ...baseSession }]);
				expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalledTimes(1);
			});

			it('broadcasts when playbookId changes', async () => {
				mockSessionsStore.get.mockReturnValue([{ ...baseSession, cliActivity: playbookA }]);
				const handler = handlers.get('sessions:setAll');
				await handler!({} as any, [
					{ ...baseSession, cliActivity: { ...playbookA, playbookId: 'pb-c' } },
				]);
				expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalledTimes(1);
			});

			it('broadcasts when playbookName changes', async () => {
				mockSessionsStore.get.mockReturnValue([{ ...baseSession, cliActivity: playbookA }]);
				const handler = handlers.get('sessions:setAll');
				await handler!({} as any, [
					{ ...baseSession, cliActivity: { ...playbookA, playbookName: 'NewName' } },
				]);
				expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalledTimes(1);
			});

			it('broadcasts when startedAt changes', async () => {
				mockSessionsStore.get.mockReturnValue([{ ...baseSession, cliActivity: playbookA }]);
				const handler = handlers.get('sessions:setAll');
				await handler!({} as any, [
					{ ...baseSession, cliActivity: { ...playbookA, startedAt: 9999 } },
				]);
				expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalledTimes(1);
			});

			it('does not broadcast when cliActivity reference changes but fields match', async () => {
				mockSessionsStore.get.mockReturnValue([{ ...baseSession, cliActivity: playbookA }]);
				const handler = handlers.get('sessions:setAll');
				// New object, same field values - should be treated as unchanged.
				await handler!({} as any, [{ ...baseSession, cliActivity: { ...playbookA } }]);
				expect(mockWebServer.broadcastSessionStateChange).not.toHaveBeenCalled();
			});

			it('broadcasts when entire playbook is swapped', async () => {
				mockSessionsStore.get.mockReturnValue([{ ...baseSession, cliActivity: playbookA }]);
				const handler = handlers.get('sessions:setAll');
				await handler!({} as any, [{ ...baseSession, cliActivity: playbookB }]);
				expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalledTimes(1);
			});
		});

		it('should not broadcast when no web clients connected', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(0);
			const sessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, sessions);

			expect(mockWebServer.broadcastSessionAdded).not.toHaveBeenCalled();
		});

		it('should not broadcast when session unchanged', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const sessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue(sessions);

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, sessions);

			expect(mockWebServer.broadcastSessionStateChange).not.toHaveBeenCalled();
			expect(mockWebServer.broadcastSessionAdded).not.toHaveBeenCalled();
			expect(mockWebServer.broadcastSessionRemoved).not.toHaveBeenCalled();
		});

		it('should handle multiple sessions with mixed changes', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
				{
					id: 'session-2',
					name: 'Session 2',
					cwd: '/test2',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const newSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'busy',
					inputMode: 'ai',
					toolType: 'claude-code',
				}, // state changed
				{
					id: 'session-3',
					name: 'Session 3',
					cwd: '/test3',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				}, // new
			];

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, newSessions);

			expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalledWith(
				'session-1',
				'busy',
				expect.any(Object)
			);
			expect(mockWebServer.broadcastSessionRemoved).not.toHaveBeenCalled();
			expect(mockWebServer.broadcastSessionAdded).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'session-3' })
			);
			expect(mockSessionsStore.set).toHaveBeenCalledWith('sessions', [
				newSessions[0],
				newSessions[1],
				previousSessions[1],
			]);
		});

		it('should return false on ENOSPC write error', async () => {
			const error = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
			error.code = 'ENOSPC';
			mockSessionsStore.set.mockImplementation(() => {
				throw error;
			});
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:setAll');
			const result = await handler!({} as any, [{ id: 's1', name: 'S1', state: 'idle' }]);

			expect(result).toBe(false);
		});

		it('should return false on JSON serialization error', async () => {
			mockSessionsStore.set.mockImplementation(() => {
				throw new TypeError('Converting circular structure to JSON');
			});
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:setAll');
			const result = await handler!({} as any, [{ id: 's1', name: 'S1', state: 'idle' }]);

			expect(result).toBe(false);
		});
	});

	describe('sessions:setMany', () => {
		const baseSession = {
			id: 's1',
			name: 'Session 1',
			cwd: '/test',
			projectRoot: '/test',
			state: 'idle' as const,
			inputMode: 'ai' as const,
			toolType: 'claude-code',
		};

		it.each(['sessions:setAll', 'sessions:setMany'])(
			'%s cannot persist a new remote human queue claim',
			async (channel) => {
				mockSessionsStore.get.mockReturnValue([]);
				const incoming = {
					...baseSession,
					executionQueue: [
						{ id: 'remote-item', type: 'message', text: 'Read mail', querySource: 'user' },
					],
				};
				await handlers.get(channel)!({ type: 'bridge' } as any, [incoming], []);
				const saved = mockSessionsStore.set.mock.calls.at(-1)![1] as (typeof incoming)[];
				expect(saved[0].executionQueue[0].querySource).toBe('auto');
			}
		);

		it.each(['sessions:setAll', 'sessions:setMany'])(
			'%s demotes changed remote queue claims with an observed baseline',
			async (channel) => {
				const item = { id: 'host-item', type: 'message', text: 'Read mail', querySource: 'user' };
				const untouched = { ...item, id: 'unchanged-item' };
				const stored = { ...baseSession, executionQueue: [item, untouched] };
				const baseline = structuredClone(stored);
				const incoming = {
					...stored,
					executionQueue: [{ ...item, text: 'Different operation' }, untouched],
				};
				mockSessionsStore.get.mockReturnValue([stored]);
				const handler = handlers.get(channel)!;
				const result =
					channel === 'sessions:setAll'
						? await handler({ type: 'bridge' } as any, [incoming], [baseline])
						: await handler({ type: 'bridge' } as any, [incoming], [], [baseline]);
				expect(result).toBe(true);
				const saved = mockSessionsStore.set.mock.calls.at(-1)![1] as (typeof stored)[];
				expect(saved[0].executionQueue).toEqual([
					{ ...item, text: 'Different operation', querySource: 'auto' },
					untouched,
				]);
				expect(stored.executionQueue).toEqual([item, untouched]);
				expect(baseline.executionQueue).toEqual([item, untouched]);
			}
		);

		it('notifies Pianola of added and removed agents only after a durable write', async () => {
			const onSessionsPersisted = vi.fn(() => {
				expect(mockFlushSessionWrites).toHaveBeenCalledOnce();
			});
			registerPersistenceHandlers({
				settingsStore: mockSettingsStore as unknown as Store<MaestroSettings>,
				sessionsStore: mockSessionsStore as unknown as Store<SessionsData>,
				groupsStore: mockGroupsStore as unknown as Store<GroupsData>,
				getWebServer: getWebServerFn,
				flushSessionWrites: mockFlushSessionWrites,
				onSessionsPersisted,
			});
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);
			const newcomer = { ...baseSession, id: 's2' };
			await handlers.get('sessions:setMany')!({} as any, [newcomer], ['s1']);
			expect(onSessionsPersisted).toHaveBeenCalledWith([newcomer], [newcomer], ['s1']);
		});

		it.each(['persistence', 'plugin'] as const)(
			'composes %s lifecycle, owner enrollment, native census and the first real question',
			async (adapter) => {
				const root = path.resolve('.maestro/pianola-agent-supervision-20261104/Working');
				mkdirSync(root, { recursive: true });
				const directory = mkdtempSync(path.join(root, 'm01-adapter-'));
				vi.stubEnv('MAESTRO_USER_DATA', directory);
				const store = createPianolaFsStore({
					resolveDir: () => directory,
					indent: 2,
					trailingNewline: true,
				});
				const scopeId = generateUUID();
				const agentId = generateUUID();
				let tabId = generateUUID();
				const make = (id: string, tab: string, extra = {}) => ({
					...baseSession,
					id,
					cwd: directory,
					toolType: 'codex',
					groupId: null,
					aiTabs: [{ id: tab, createdAt: 10, state: 'idle', logs: [] }],
					...extra,
				});
				let agent = make(agentId, tabId);
				let sessions = [make('manager', 'manager-tab', { isPianola: true })];
				const disk = new Conf<{
					sessions: Array<Record<string, unknown>>;
					activeSessionId: string;
				}>({
					cwd: directory,
					configName: 'plugin-sessions',
					defaults: { sessions, activeSessionId: 'manager' },
				});
				const file = path.join(directory, 'sessions.json');
				writeFileSync(file, JSON.stringify(sessions));
				mockSessionsStore.get.mockImplementation((key, fallback) =>
					key === 'sessions' ? sessions : fallback
				);
				mockSessionsStore.set.mockImplementation((key, value) => {
					if (key === 'sessions') {
						sessions = value;
						if (adapter === 'plugin') disk.set('sessions', value);
					}
				});
				mockFlushSessionWrites.mockImplementation(async () =>
					writeFileSync(file, JSON.stringify(sessions))
				);
				let enabled = true;
				const spawn = vi.fn(() =>
					Object.assign(new EventEmitter(), { pid: undefined, exitCode: 0, signalCode: null })
				);
				const supervisor = new PianolaSupervisor({
					isEnabled: () => enabled,
					getPianolaAgentId: () => 'manager',
					spawnChild: spawn as never,
				});
				const consumer = vi.fn(pianolaPersistenceConsumer(() => supervisor));
				const plugin = createPluginSessionLifecycle({
					readSessions: () => disk.get('sessions'),
					writeSessions: (rows) => {
						disk.set('sessions', rows);
						sessions = rows as typeof sessions;
					},
					flush: mockFlushSessionWrites,
					getActiveSessionId: () => disk.get('activeSessionId'),
					setActiveSessionId: (id) => disk.set('activeSessionId', id),
					getSupervisor: () => supervisor,
				});
				const owner = {
					isDestroyed: () => false,
					webContents: { id: 42, isDestroyed: () => false },
				} as BrowserWindow;
				registerPersistenceHandlers({
					...deps,
					getWindowForSession: () => owner,
					onSessionsPersisted: consumer,
				});
				const callbacks: Record<string, () => Record<string, unknown>> = {};
				registerSessionCallbacks(
					new Proxy(
						{},
						{
							get: (_target, key: string) => (fn: () => Record<string, unknown>) => {
								callbacks[key] = fn;
							},
						}
					) as WebServer,
					{
						sessionsStore: deps.sessionsStore,
						groupsStore: deps.groupsStore,
						settingsStore: { get: () => ({ pianola: true }) } as never,
						getProcessManager: () => ({ get: () => undefined }) as never,
					}
				);
				const census = () =>
					pianolaScopeSnapshotFromDesktop({
						success: true,
						...callbacks.setListDesktopSessionsCallback(),
					});
				let sequence = 0;
				const publish = (
					rows: Array<{ id: string; source: string; text: string; timestamp: number }>,
					order: string[],
					empty = false,
					sender = 42
				) =>
					handlers.get('sessions:publishTranscript')!(
						{ sender: { id: sender } },
						{
							sessionId: agentId,
							tabId,
							field: 'logs',
							upserts: rows,
							orderIds: order,
							removedIds: [],
							...(empty && { snapshot: true }),
							runtime: { state: 'idle' },
							observation: {
								sourceGeneration: agentId,
								sequence: sender === 42 ? ++sequence : 1,
								createdAt: agent.aiTabs[0].createdAt,
								provider: 'codex',
								emptyCreation: adapter === 'persistence' && empty,
							},
						}
					);
				const configure = () =>
					configurePianolaScope(
						{
							id: scopeId,
							kind: 'watch-scope',
							enabled: true,
							createdAt: 1,
							managerAgentId: 'manager',
							selection: {
								mode: 'agents-and-groups',
								label: 'Whole agent',
								agentIds: [agentId],
								groupIds: [],
								excludedAgentIds: [],
								...(adapter === 'plugin' && { futureLocalAgents: true }),
							},
						},
						{
							store,
							snapshot: census,
							canFence: () => false,
							featureEnabled: () => true,
							ownerAuthorized: () => true,
							readRules: store.readRulesResult,
						}
					);
				const watch: PianolaScopeCycleDeps['watch'] = {
					...(adapter === 'plugin' && {
						resolveProfile: () => ({
							profile: 'Ask the manager for routine naming decisions.',
							updatedAt: 1,
						}),
					}),
					readRules: () => [],
					recordDecision: store.appendDecision,
					now: () => new Date().toISOString(),
					genId: generateUUID,
					log: vi.fn(),
					notify: vi.fn(),
				};
				const readTranscript = vi.fn(async () => {
					const currentTurn = nativeCurrentTurns.read({
						agentId,
						tabId,
						createdAt: agent.aiTabs[0].createdAt,
						provider: 'codex',
						agentSessionId: null,
						open: true,
					});
					return { agentId, tabId, currentTurn, messages: currentTurnMessages(currentTurn) };
				});
				const requestJudgment = vi.fn<NonNullable<PianolaScopeCycleDeps['requestJudgment']>>(
					async () => ({ status: 'accepted' as const })
				);
				const cycle = () =>
					runPianolaScopeCycle(
						scopeId,
						{
							store,
							readSnapshot: async () => census(),
							readTranscript,
							watch,
							dispatch: async () => ({ status: 'accepted' }),
							requestJudgment,
						},
						{ dryRun: false }
					);
				try {
					if (adapter === 'plugin') {
						expect(await configure()).toMatchObject({ status: 'registered' });
						const selection = store.readSupervisorTargets()[0].selection;
						expect(
							selection?.mode === 'agents-and-groups' && selection.futureAgentBaselineIds
						).toEqual(['manager']);
						const result = await plugin.create({
							id: agentId,
							title: 'Plugin child',
							agentId: 'codex',
							projectPath: directory,
						});
						expect(result).toMatchObject({
							id: agentId,
							title: 'Plugin child',
							agentId: 'codex',
							status: 'idle',
						});
						agent = sessions.find((s) => s.id === agentId)! as typeof agent;
						tabId = agent.aiTabs[0].id;
						const before = readFileSync(disk.path, 'utf8');
						const checkpoint = store.readScopeCheckpoint(scopeId);
						disk.set('activeSessionId', 'manager');
						const durable = readFileSync(disk.path, 'utf8');
						await expect(plugin.create({ id: agentId, title: 'Duplicate' })).rejects.toThrow(
							'Session already exists'
						);
						expect(readFileSync(disk.path, 'utf8')).toBe(durable);
						expect(disk.get('activeSessionId')).toBe('manager');
						expect(store.readScopeCheckpoint(scopeId)).toEqual(checkpoint);
						expect(
							JSON.parse(before).sessions.filter((s: { id: string }) => s.id === agentId)
						).toHaveLength(1);
						expect(spawn).toHaveBeenCalledOnce();
					} else {
						expect(await handlers.get('sessions:setMany')!({}, [agent], [])).toBe(true);
					}
					expect(
						JSON.parse(readFileSync(file, 'utf8')).map((row: { id: string }) => row.id)
					).toContain(agentId);
					expect(consumer).toHaveBeenCalledTimes(adapter === 'persistence' ? 1 : 0);
					expect(spawn).toHaveBeenCalledTimes(adapter === 'persistence' ? 0 : 1);
					// An unknown empty disk window and a non-owner publisher cannot enroll.
					expect(census().tabs.find((tab) => tab.tabId === tabId)?.cursorAvailable).toBe(false);
					publish([], [], true, 99);
					if (adapter === 'persistence')
						await expect(configure()).rejects.toThrow('Migration cursor unavailable');
					else {
						await cycle();
						expect(store.readScopeCheckpoint(scopeId)?.tabs[0].coverage?.status).toBe('blocked');
					}
					publish([], [], true);
					expect(census().tabs.find((tab) => tab.tabId === tabId)).toMatchObject({
						cursorAvailable: true,
						cursor: null,
					});
					if (adapter === 'persistence')
						expect(await configure()).toMatchObject({ status: 'registered' });
					else await cycle();
					expect(store.readScopeCheckpoint(scopeId)?.tabs[0]).toMatchObject({
						baseline: null,
						emptyEnrollment: { runId: null, turnId: null },
					});
					await cycle();
					expect(readTranscript).not.toHaveBeenCalled();
					expect(requestJudgment).not.toHaveBeenCalled();
					// Duplicate durable notifications reconcile one scope, never initial tab watches.
					await handlers.get('sessions:setMany')!({}, [agent], []);
					await handlers.get('sessions:setMany')!({}, [agent], []);
					expect(spawn).toHaveBeenCalledOnce();
					expect(
						store.readSupervisorTargets().every((target) => target.kind === 'watch-scope')
					).toBe(true);
					const captureFirstQuestion = async () => {
						const user = {
							id: 'first-user',
							source: 'user',
							text: 'Inspect naming',
							timestamp: 11,
						};
						publish([user], [user.id]);
						await cycle(); // First user row is not yet a captured turn.
						expect(requestJudgment).not.toHaveBeenCalled();
						const capture = new AgentRunCaptureService({
							getAgentRun: () => undefined,
							upsertAgentRun: (r) => r,
							appendAgentRunEvent: (e) => e,
							findActiveRunBySession: () => undefined,
						});
						const run = capture.captureSpawn({
							sessionId: `${agentId}-ai-${tabId}`,
							toolType: 'codex',
							cwd: directory,
							transcriptBoundaryId: user.id,
							nativeTabSession: { agentId, tabId, createdAt: agent.aiTabs[0].createdAt },
						})!;
						nativeCurrentTurns.begin(run, user.id);
						const question = {
							id: 'first-question',
							source: 'ai',
							text: 'Should I name it count or total?',
							timestamp: 12,
						};
						publish([question], [user.id, question.id]);
						const result = await cycle();
						expect(result.issues).toEqual([]);
						expect(readTranscript).toHaveBeenCalledOnce();
						expect(
							store
								.readDecisions()
								.some((decision) => decision.classification.evidence.messageId === question.id)
						).toBe(true);
					};
					if (adapter === 'persistence') await captureFirstQuestion();
					// Later sibling and worktree inventory uses the same persisted owner census.
					const sibling = { id: generateUUID(), createdAt: 20, state: 'idle', logs: [] };
					const child = make(generateUUID(), generateUUID(), { parentSessionId: agentId });
					if (adapter === 'plugin') {
						const futureId = generateUUID();
						await plugin.create({ id: futureId, agentId: 'codex', projectPath: directory });
						expect(store.readSupervisorTargets()).toHaveLength(1);
						// No owner snapshot yet: even a host-born tab cannot be classified.
						await cycle();
						expect(
							store.readScopeCheckpoint(scopeId)?.tabs.find((t) => t.agentId === futureId)?.coverage
								?.status
						).toBe('blocked');
						const future = sessions.find((s) => s.id === futureId)!;
						await handlers.get('sessions:publishTranscript')!(
							{ sender: { id: 42 } },
							{
								sessionId: futureId,
								tabId: future.aiTabs[0].id,
								field: 'logs',
								snapshot: true,
								upserts: [],
								removedIds: [],
								orderIds: [],
								runtime: { state: 'idle' },
								observation: {
									sourceGeneration: futureId,
									sequence: 1,
									createdAt: future.aiTabs[0].createdAt,
									provider: 'codex',
								},
							}
						);
						await cycle();
						expect(
							store.readScopeCheckpoint(scopeId)?.tabs.find((t) => t.agentId === futureId)
						).toMatchObject({ baseline: null, emptyEnrollment: { runId: null, turnId: null } });
					}
					const updated = { ...agent, aiTabs: [...agent.aiTabs, sibling] };
					await handlers.get('sessions:setMany')!({}, [updated, child], []);
					for (const [id, tab] of [
						[agentId, sibling],
						[child.id, child.aiTabs[0]],
					] as const) {
						await handlers.get('sessions:publishTranscript')!(
							{ sender: { id: 42 } },
							{
								sessionId: id,
								tabId: tab.id,
								field: 'logs',
								snapshot: true,
								upserts: [],
								removedIds: [],
								orderIds: [],
								runtime: { state: 'idle' },
								observation: {
									sourceGeneration: id + tab.id,
									sequence: 1,
									createdAt: tab.createdAt,
									provider: 'codex',
									emptyCreation: true,
								},
							}
						);
					}
					await cycle();
					expect(store.readScopeCheckpoint(scopeId)?.tabs).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ agentId, tabId: sibling.id, baseline: null }),
							expect.objectContaining({
								agentId: child.id,
								tabId: child.aiTabs[0].id,
								baseline: null,
							}),
						])
					);
					expect(spawn).toHaveBeenCalledOnce();
					// Paused tabs stay nonactionable; exclusion removes ownership on the next census.
					await handlers.get('sessions:setMany')!({}, [{ ...updated, agentErrorPaused: true }], []);
					await cycle();
					expect(
						store.readScopeCheckpoint(scopeId)?.tabs.find((tab) => tab.tabId === sibling.id)?.status
					).toBe('suspended');
					const targets = store.readSupervisorTargets();
					targets[0].selection!.excludedAgentIds.push(child.id);
					store.writeSupervisorTargets(targets);
					await cycle();
					expect(
						store.readScopeCheckpoint(scopeId)?.tabs.find((tab) => tab.agentId === child.id)
							?.coverage?.status
					).toBe('excluded');
					const before = consumer.mock.calls.length;
					mockFlushSessionWrites.mockRejectedValueOnce(
						Object.assign(new Error('disk full'), { code: 'ENOSPC' })
					);
					expect(
						await handlers.get('sessions:setMany')!({}, [make('failed', 'failed-tab')], [])
					).toBe(false);
					expect(consumer).toHaveBeenCalledTimes(before);
					if (adapter === 'plugin') {
						await handlers.get('sessions:setMany')!({}, [updated], ['failed']);
						await cycle();
						await captureFirstQuestion();
						expect(requestJudgment).toHaveBeenCalledOnce();
						const guard = requestJudgment.mock.calls[0]?.[1];
						expect(guard).toBeDefined();
						expect(() => validatePianolaScopeDelivery(guard, census(), store, false)).not.toThrow();
						expect(await plugin.remove(agentId)).toBe(true);
						expect(() => validatePianolaScopeDelivery(guard, census(), store)).toThrow(
							'Scope or pending ask changed'
						);
						expect(await plugin.remove(agentId)).toBe(false);
						expect(census().owners.some((o) => o.id === agentId)).toBe(false);
					} else await handlers.get('sessions:setMany')!({}, [], [agentId]);
					await cycle();
					expect(store.readScopeCheckpoint(scopeId)?.tabs[0].status).toBe('closed');
					// Feature-off persistence cannot start a watcher or retain a native empty baseline.
					enabled = false;
					nativeCurrentTurns.setEnabled(false);
					if (adapter === 'plugin')
						await plugin.create({ id: 'off-agent', agentId: 'codex', projectPath: directory });
					else await handlers.get('sessions:setMany')!({}, [make('off-agent', 'off-tab')], []);
					expect(spawn).toHaveBeenCalledOnce();
					expect(store.readScopeCheckpoint(scopeId)?.status).toBe('suspended');
					expect(census().tabs.find((tab) => tab.agentId === 'off-agent')?.cursorAvailable).toBe(
						false
					);
				} finally {
					supervisor.stopAll();
					expect(supervisor.getHealth()).toEqual([]);
					nativeCurrentTurns.setEnabled(true);
					vi.unstubAllEnvs();
					rmSync(directory, { recursive: true, force: true });
				}
			}
		);

		it('writes the merged sessions array to the store', async () => {
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);

			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [{ ...baseSession, name: 'Updated' }], []);

			expect(mockSessionsStore.set).toHaveBeenCalledWith(
				'sessions',
				expect.arrayContaining([expect.objectContaining({ id: 's1', name: 'Updated' })])
			);
		});

		it('normalizes the closed-tab stack of a raw write with no baseline', async () => {
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);

			await handlers.get('sessions:setMany')!(
				{} as any,
				[
					{
						...baseSession,
						toolType: 'claude-code',
						closedTabHistory: [{ tab: { id: 'closed', logs: [] }, index: 0, closedAt: 1 }],
						unifiedClosedTabHistory: [
							{
								type: 'ai',
								tab: {
									id: 'closed',
									agentSessionId: 'provider-1',
									logs: [{ id: 'l1' }],
									state: 'busy',
								},
								unifiedIndex: 0,
								closedAt: 1,
							},
						],
					},
				],
				[]
			);

			const persisted = mockSessionsStore.set.mock.calls[0][1];
			expect(persisted[0]).not.toHaveProperty('closedTabHistory');
			expect(persisted[0].unifiedClosedTabHistory[0].tab).toMatchObject({
				id: 'closed',
				logs: [],
				state: 'idle',
			});
		});

		it('compacts oversized tool output before writing merged sessions', async () => {
			const oversizedOutput = 'x'.repeat(50_000);
			mockSessionsStore.get.mockReturnValue([]);

			await handlers.get('sessions:setMany')!(
				{} as any,
				[
					{
						...baseSession,
						aiTabs: [
							{
								id: 'tab-1',
								logs: [{ metadata: { toolState: { output: oversizedOutput } } }],
							},
						],
					},
				],
				[]
			);

			const persisted = mockSessionsStore.set.mock.calls[0][1];
			const output = persisted[0].aiTabs[0].logs[0].metadata.toolState.output;
			expect(output.length).toBeLessThan(5_000);
			expect(output).toContain('[tool output truncated');
		});

		it('returns true on success', async () => {
			mockSessionsStore.get.mockReturnValue([]);
			const handler = handlers.get('sessions:setMany');
			const result = await handler!({} as any, [], []);
			expect(result).toBe(true);
		});

		it('is a no-op when given empty updates and empty removeIds', async () => {
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);
			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [], []);

			// merged should equal previous (no add, no remove)
			expect(mockSessionsStore.set).toHaveBeenCalledWith('sessions', [
				expect.objectContaining({ id: 's1' }),
			]);
		});

		it('replaces an existing session by id', async () => {
			mockSessionsStore.get.mockReturnValue([
				{ ...baseSession, name: 'Old' },
				{ ...baseSession, id: 's2', name: 'Other' },
			]);
			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [{ ...baseSession, name: 'New' }], []);

			const merged = mockSessionsStore.set.mock.calls[0][1];
			expect(merged).toHaveLength(2);
			expect(merged.find((s: any) => s.id === 's1').name).toBe('New');
			expect(merged.find((s: any) => s.id === 's2').name).toBe('Other');
		});

		it('appends a new session to the end', async () => {
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);
			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [{ ...baseSession, id: 's2', name: 'Two' }], []);

			const merged = mockSessionsStore.set.mock.calls[0][1];
			expect(merged.map((s: any) => s.id)).toEqual(['s1', 's2']);
		});

		it('removes sessions whose id is in removeIds', async () => {
			mockSessionsStore.get.mockReturnValue([
				{ ...baseSession, id: 's1' },
				{ ...baseSession, id: 's2' },
			]);
			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [], ['s1']);

			const merged = mockSessionsStore.set.mock.calls[0][1];
			expect(merged.map((s: any) => s.id)).toEqual(['s2']);
		});

		it('backs up before explicit removals empty the registry', async () => {
			const stored = [{ ...baseSession }];
			mockSessionsStore.get.mockReturnValue(stored);

			await handlers.get('sessions:setMany')!({} as any, [], ['s1']);

			expect(backupSessionsBeforeWipeMock).toHaveBeenCalledWith(
				stored,
				[],
				'/mock/maestro-sessions.json'
			);
			expect(mockSessionsStore.set).toHaveBeenCalledWith('sessions', []);
		});

		it('serializes additions behind a final-agent backup', async () => {
			let stored = [{ ...baseSession }];
			mockSessionsStore.get.mockImplementation((key: string, fallback: unknown) =>
				key === 'sessions' ? stored : fallback
			);
			mockSessionsStore.set.mockImplementation((key: string, value: StoredSession[]) => {
				if (key === 'sessions') stored = value;
			});
			let releaseBackup: (() => void) | undefined;
			backupSessionsBeforeWipeMock.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						releaseBackup = resolve;
					})
			);

			const removal = handlers.get('sessions:setMany')!({} as any, [], ['s1']);
			await vi.waitFor(() => expect(backupSessionsBeforeWipeMock).toHaveBeenCalled());

			const addition = handlers.get('sessions:setAll')!({} as any, [
				{ ...baseSession, id: 'created-concurrently' },
			]);
			await Promise.resolve();
			expect(mockSessionsStore.set).not.toHaveBeenCalled();

			releaseBackup?.();
			await Promise.all([removal, addition]);

			expect(stored.map((session) => session.id)).toEqual(['created-concurrently']);
		});

		it('handles mixed updates and removes in one call', async () => {
			mockSessionsStore.get.mockReturnValue([
				{ ...baseSession, id: 's1' },
				{ ...baseSession, id: 's2' },
				{ ...baseSession, id: 's3' },
			]);
			const handler = handlers.get('sessions:setMany');
			await handler!(
				{} as any,
				[
					{ ...baseSession, id: 's2', name: 'Updated' },
					{ ...baseSession, id: 's4', name: 'New' },
				],
				['s1']
			);

			const merged = mockSessionsStore.set.mock.calls[0][1];
			// s1 removed, s2 updated, s3 untouched, s4 appended
			expect(merged.map((s: any) => s.id)).toEqual(['s2', 's3', 's4']);
			expect(merged.find((s: any) => s.id === 's2').name).toBe('Updated');
		});

		it('preserves existing order when updating', async () => {
			mockSessionsStore.get.mockReturnValue([
				{ ...baseSession, id: 'a' },
				{ ...baseSession, id: 'b' },
				{ ...baseSession, id: 'c' },
			]);
			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [{ ...baseSession, id: 'b', name: 'B-updated' }], []);

			const merged = mockSessionsStore.set.mock.calls[0][1];
			expect(merged.map((s: any) => s.id)).toEqual(['a', 'b', 'c']);
		});

		it('lets remove win when an id appears in both updates and removeIds', async () => {
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);
			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [{ ...baseSession, name: 'Should be ignored' }], ['s1']);

			const merged = mockSessionsStore.set.mock.calls[0][1];
			expect(merged).toEqual([]);
		});

		it('treats updates with unseen ids as adds (broadcastSessionAdded)', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [{ ...baseSession, id: 'new1' }], []);

			expect(mockWebServer.broadcastSessionAdded).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'new1' })
			);
			expect(mockWebServer.broadcastSessionStateChange).not.toHaveBeenCalled();
		});

		it('broadcasts state changes for updated sessions when web clients connected', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			mockSessionsStore.get.mockReturnValue([{ ...baseSession, state: 'idle' }]);

			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [{ ...baseSession, state: 'busy' }], []);

			expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalledWith(
				's1',
				'busy',
				expect.any(Object)
			);
		});

		it('broadcasts removals for ids that existed', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);

			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [], ['s1']);

			expect(mockWebServer.broadcastSessionRemoved).toHaveBeenCalledWith('s1');
		});

		it("deletes a removed agent's User Journey, and only for ids that existed", async () => {
			deleteJourneyMock.mockClear();
			mockSessionsStore.get.mockReturnValue([{ ...baseSession, id: 's1' }]);

			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [], ['s1', 'nonexistent']);

			expect(deleteJourneyMock).toHaveBeenCalledTimes(1);
			expect(deleteJourneyMock).toHaveBeenCalledWith('s1');
		});

		it('does not broadcast removals for ids that did not exist', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			mockSessionsStore.get.mockReturnValue([{ ...baseSession, id: 's1' }]);

			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [], ['nonexistent']);

			expect(mockWebServer.broadcastSessionRemoved).not.toHaveBeenCalled();
		});

		it('does not broadcast when no web clients are connected', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(0);
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);

			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [{ ...baseSession, state: 'busy' }], ['nonexistent']);

			expect(mockWebServer.broadcastSessionStateChange).not.toHaveBeenCalled();
			expect(mockWebServer.broadcastSessionAdded).not.toHaveBeenCalled();
			expect(mockWebServer.broadcastSessionRemoved).not.toHaveBeenCalled();
		});

		it('does not broadcast state-change for an unchanged session', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);

			const handler = handlers.get('sessions:setMany');
			// New object with identical primitives - should be silent.
			await handler!({} as any, [{ ...baseSession }], []);

			expect(mockWebServer.broadcastSessionStateChange).not.toHaveBeenCalled();
		});

		it('returns false on ENOSPC write error (recoverable)', async () => {
			const error = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
			error.code = 'ENOSPC';
			mockSessionsStore.set.mockImplementation(() => {
				throw error;
			});
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:setMany');
			const result = await handler!({} as any, [{ ...baseSession }], []);

			expect(result).toBe(false);
		});

		it('returns false on ENFILE write error (recoverable)', async () => {
			const error = new Error('ENFILE: too many open files') as NodeJS.ErrnoException;
			error.code = 'ENFILE';
			mockSessionsStore.set.mockImplementation(() => {
				throw error;
			});
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:setMany');
			const result = await handler!({} as any, [{ ...baseSession }], []);

			expect(result).toBe(false);
		});

		it('returns false when a deferred write reports a recoverable disk error', async () => {
			const error = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
			error.code = 'ENOSPC';
			mockFlushSessionWrites.mockRejectedValueOnce(error);
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:setMany');
			const result = await handler!({} as any, [{ ...baseSession }], []);

			expect(result).toBe(false);
			expect(mockSessionsStore.set).toHaveBeenCalledOnce();
			expect(mockFlushSessionWrites).toHaveBeenCalledOnce();
		});

		it('does not acknowledge an unexpected deferred write failure', async () => {
			const error = new Error('EIO: input/output error') as NodeJS.ErrnoException;
			error.code = 'EIO';
			mockFlushSessionWrites.mockRejectedValueOnce(error);
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:setMany');

			await expect(handler!({} as any, [{ ...baseSession }], [])).rejects.toBe(error);
			expect(mockSessionsStore.set).toHaveBeenCalledOnce();
			expect(mockFlushSessionWrites).toHaveBeenCalledOnce();
		});

		it('rethrows unexpected errors so withIpcErrorLogging can surface them to Sentry', async () => {
			mockSessionsStore.set.mockImplementation(() => {
				throw new TypeError('Converting circular structure to JSON');
			});
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:setMany');

			await expect(handler!({} as any, [{ ...baseSession }], [])).rejects.toThrow(
				'Converting circular structure to JSON'
			);
		});
	});

	// One store, several renderers: each desktop window and every web-desktop
	// browser tab keeps its own session tree and flushes it back here. These
	// tests cover the delta that tells the others what entered and left, plus the
	// guard that stops a stale peer flush from resurrecting a closed agent
	// (issues #1398 / #1492).
	describe('cross-client agent lifecycle sync', () => {
		const baseSession = {
			id: 's1',
			name: 'Session 1',
			cwd: '/test',
			projectRoot: '/test',
			state: 'idle' as const,
			inputMode: 'ai' as const,
			toolType: 'claude-code',
		};

		/** The payload of the last `sessions:lifecycleSync` bridge push, if any. */
		const lastBridgePayload = () => {
			const calls = vi
				.mocked(broadcastBridgeEvent)
				.mock.calls.filter(([channel]) => channel === SESSION_LIFECYCLE_SYNC_CHANNEL);
			if (calls.length === 0) return null;
			return (calls[calls.length - 1][1] as [{ added: any[]; removedIds: string[] }])[0];
		};

		it('tells peers about an agent another client just created', async () => {
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [{ ...baseSession, id: 'from-web' }], []);

			expect(lastBridgePayload()).toEqual({
				added: [expect.objectContaining({ id: 'from-web' })],
				removedIds: [],
			});
		});

		it('sends full new agents to desktop windows and thin agents to browsers', async () => {
			const peer = {
				isDestroyed: () => false,
				webContents: { id: 7, isDestroyed: () => false, send: vi.fn() },
			};
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([peer] as any);
			mockSessionsStore.get.mockReturnValue([]);
			await handlers.get('sessions:setMany')!({} as any, [
				{ ...baseSession, aiTabs: [{ id: 't1', logs: [{ id: 'l1', text: 'saved' }] }] },
			]);
			expect(peer.webContents.send).toHaveBeenCalledWith(
				SESSION_LIFECYCLE_SYNC_CHANNEL,
				expect.objectContaining({
					added: [
						expect.objectContaining({
							aiTabs: [{ id: 't1', logs: [{ id: 'l1', text: 'saved' }] }],
						}),
					],
				})
			);
			expect(lastBridgePayload()?.added[0].aiTabs[0].logs).toEqual([]);
			expect(lastBridgePayload()?.added[0].deferredContent.tabIds).toEqual(['t1']);
		});

		it('tells peers about an agent another client just closed', async () => {
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);

			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [], ['s1']);

			expect(lastBridgePayload()).toEqual({ added: [], removedIds: ['s1'] });
		});

		it('reaches every window except the one that wrote', async () => {
			const makeWindow = (id: number) => ({
				isDestroyed: () => false,
				webContents: { id, isDestroyed: () => false, send: vi.fn() },
			});
			const sender = makeWindow(1);
			const peer = makeWindow(2);
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([sender, peer] as any);
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);

			const handler = handlers.get('sessions:setMany');
			await handler!({ sender: sender.webContents } as any, [], ['s1']);

			expect(sender.webContents.send).not.toHaveBeenCalled();
			expect(peer.webContents.send).toHaveBeenCalledWith(SESSION_LIFECYCLE_SYNC_CHANNEL, {
				added: [],
				removedIds: ['s1'],
			});
		});

		it('survives a bridge call that carries no sender', async () => {
			const peer = {
				isDestroyed: () => false,
				webContents: { id: 7, isDestroyed: () => false, send: vi.fn() },
			};
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([peer] as any);
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);

			const handler = handlers.get('sessions:setMany');
			// The web bridge dispatches with a synthetic event that has no `sender`.
			await handler!({ senderFrame: null } as any, [], ['s1']);

			expect(peer.webContents.send).toHaveBeenCalledWith(
				SESSION_LIFECYCLE_SYNC_CHANNEL,
				expect.objectContaining({ removedIds: ['s1'] })
			);
		});

		it('refuses to re-add an agent a peer closed moments ago', async () => {
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);
			const handler = handlers.get('sessions:setMany');
			await handler!({} as any, [], ['s1']);

			// The peer's flush was already in flight, still carrying the agent.
			mockSessionsStore.get.mockReturnValue([]);
			await handler!({} as any, [{ ...baseSession }], []);

			const merged = mockSessionsStore.set.mock.calls.at(-1)![1];
			expect(merged).toEqual([]);
		});

		it('keeps refusing a resurrection long after the close', async () => {
			// The client that missed the close can be away for hours - a suspended
			// mobile browser, a laptop lid - so the guard is bounded by how many
			// closes it remembers, never by how long ago they were.
			vi.useFakeTimers();
			try {
				mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);
				const handler = handlers.get('sessions:setMany');
				await handler!({} as any, [], ['s1']);

				vi.advanceTimersByTime(6 * 60 * 60 * 1000);

				mockSessionsStore.get.mockReturnValue([]);
				await handler!({} as any, [{ ...baseSession }], []);

				const merged = mockSessionsStore.set.mock.calls.at(-1)![1];
				expect(merged).toEqual([]);
			} finally {
				vi.useRealTimers();
			}
		});

		it('blocks a resurrection arriving through the bootstrap setAll path too', async () => {
			mockSessionsStore.get.mockReturnValue([{ ...baseSession }]);
			await handlers.get('sessions:setMany')!({} as any, [], ['s1']);

			mockSessionsStore.get.mockReturnValue([]);
			await handlers.get('sessions:setAll')!({} as any, [{ ...baseSession }]);

			const merged = mockSessionsStore.set.mock.calls.at(-1)![1];
			expect(merged).toEqual([]);
		});

		it('still accepts updates for an agent that is legitimately live', async () => {
			mockSessionsStore.get.mockReturnValue([{ ...baseSession, id: 'other' }]);
			await handlers.get('sessions:setMany')!({} as any, [], ['s1']);

			// 's1' was never stored, so nothing was tombstoned and a later write
			// naming it is an ordinary add, not a resurrection.
			mockSessionsStore.get.mockReturnValue([{ ...baseSession, id: 'other' }]);
			await handlers.get('sessions:setMany')!({} as any, [{ ...baseSession }], []);

			const merged = mockSessionsStore.set.mock.calls.at(-1)![1];
			expect(merged.map((sess: any) => sess.id)).toEqual(['other', 's1']);
		});

		it("preserves agents omitted from one client's opening snapshot", async () => {
			// A client that loaded before a peer created an agent has no idea it
			// exists; treating its absence as a close would delete a live agent.
			mockSessionsStore.get.mockReturnValue([
				{ ...baseSession, id: 's1' },
				{ ...baseSession, id: 'created-elsewhere' },
			]);

			await handlers.get('sessions:setAll')!({} as any, [{ ...baseSession, id: 's1' }]);

			const persisted = mockSessionsStore.set.mock.calls.at(-1)![1];
			expect(persisted.map((session: any) => session.id)).toEqual(['s1', 'created-elsewhere']);
			expect(lastBridgePayload()).toBeNull();
		});

		it('reports agents a bootstrap snapshot introduces', async () => {
			mockSessionsStore.get.mockReturnValue([]);

			await handlers.get('sessions:setAll')!({} as any, [{ ...baseSession, id: 'fresh' }]);

			expect(lastBridgePayload()).toEqual({
				added: [expect.objectContaining({ id: 'fresh' })],
				removedIds: [],
			});
		});
	});

	describe('groups:getAll', () => {
		it('should load groups from store', async () => {
			const mockGroups = [
				{ id: 'group-1', name: 'Group 1' },
				{ id: 'group-2', name: 'Group 2' },
			];
			mockGroupsStore.get.mockReturnValue(mockGroups);

			const handler = handlers.get('groups:getAll');
			const result = await handler!({} as any);

			expect(mockGroupsStore.get).toHaveBeenCalledWith('groups', []);
			expect(result).toEqual(mockGroups);
		});

		it('should return empty array for missing groups', async () => {
			mockGroupsStore.get.mockReturnValue([]);

			const handler = handlers.get('groups:getAll');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});
	});

	describe('groups:setAll', () => {
		it('orders recovery reads after an accepted group deletion awaiting its backup', async () => {
			const original = [{ id: 'last', name: 'Last group', emoji: 'G', collapsed: false }];
			let groups = original;
			mockGroupsStore.get.mockImplementation(() => groups);
			mockGroupsStore.set.mockImplementation((_key, value) => {
				groups = value;
			});
			let release!: () => void;
			let started!: () => void;
			const backingUp = new Promise<void>((resolve) => {
				started = resolve;
			});
			backupGroupsBeforeWipeMock.mockImplementationOnce(() => {
				started();
				return new Promise<void>((resolve) => {
					release = resolve;
				});
			});
			const accepted = handlers.get('groups:setAll')!({}, [], original);
			await backingUp;
			let readSettled = false;
			const recovery = handlers.get('groups:getAll')!({}).then((value: unknown) => {
				readSettled = true;
				return value;
			});
			try {
				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(readSettled).toBe(false);
			} finally {
				release();
				await accepted;
			}
			expect(await recovery).toEqual([]);
		});
		it('merges concurrent fields and preserves groups the writer never saw', async () => {
			let groups = [{ id: 'base', name: 'Original', emoji: 'A', collapsed: false }];
			mockGroupsStore.get.mockImplementation(() => groups);
			mockGroupsStore.set.mockImplementation((_key, value) => {
				groups = value;
			});
			const baseline = groups;
			const handler = handlers.get('groups:setAll')!;
			expect(
				await handler(
					{},
					[...baseline, { id: 'peer', name: 'Peer', emoji: 'P', collapsed: false }],
					baseline
				)
			).toBe(true);
			await Promise.all([
				handler({}, [{ ...baseline[0], emoji: 'B' }], baseline),
				handler({}, [{ ...baseline[0], name: 'Renamed' }], baseline),
			]);
			expect(groups).toEqual([
				{ id: 'base', name: 'Renamed', emoji: 'B', collapsed: false },
				{ id: 'peer', name: 'Peer', emoji: 'P', collapsed: false },
			]);
		});
		it('deletes only observed groups, promotes children, and does not resurrect peer deletions', async () => {
			const root = { id: 'root', name: 'Root', emoji: 'R', collapsed: false };
			const child = {
				id: 'child',
				name: 'Child',
				emoji: 'C',
				collapsed: false,
				parentGroupId: 'root',
			};
			let groups = [root, child];
			mockGroupsStore.get.mockImplementation(() => groups);
			mockGroupsStore.set.mockImplementation((_key, value) => {
				groups = value;
			});
			const handler = handlers.get('groups:setAll')!;
			await handler({}, [], [root]);
			expect(groups).toEqual([{ id: 'child', name: 'Child', emoji: 'C', collapsed: false }]);
			await handler({}, [{ ...root, name: 'Stale rename' }], [root]);
			expect(groups).toEqual([{ id: 'child', name: 'Child', emoji: 'C', collapsed: false }]);
		});
		it('refuses writes without a baseline and reports disk failure', async () => {
			const handler = handlers.get('groups:setAll')!;
			expect(await handler({}, [])).toBe(false);
			expect(mockGroupsStore.set).not.toHaveBeenCalled();
			mockGroupsStore.set.mockImplementation(() => {
				throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
			});
			expect(await handler({}, [{ id: 'g1', name: 'G1', emoji: 'G', collapsed: false }], [])).toBe(
				false
			);
		});
	});

	describe('cli:getActivity', () => {
		it('should return activities from CLI activity file', async () => {
			const mockActivities = [
				{ sessionId: 'session-1', action: 'started', timestamp: Date.now() },
				{ sessionId: 'session-2', action: 'completed', timestamp: Date.now() },
			];

			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ activities: mockActivities }));

			const handler = handlers.get('cli:getActivity');
			const result = await handler!({} as any);

			expect(app.getPath).toHaveBeenCalledWith('userData');
			expect(fs.readFile).toHaveBeenCalledWith(
				path.join('/mock/user/data', 'cli-activity.json'),
				'utf-8'
			);
			expect(result).toEqual(mockActivities);
		});

		it('should return empty array when file does not exist', async () => {
			const error = new Error('ENOENT: no such file or directory');
			(error as any).code = 'ENOENT';
			vi.mocked(fs.readFile).mockRejectedValue(error);

			const handler = handlers.get('cli:getActivity');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});

		it('should return empty array for corrupted JSON', async () => {
			vi.mocked(fs.readFile).mockResolvedValue('not valid json');

			const handler = handlers.get('cli:getActivity');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});

		it('should return empty array when activities property is missing', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({}));

			const handler = handlers.get('cli:getActivity');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});

		it('should return empty array for empty activities', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ activities: [] }));

			const handler = handlers.get('cli:getActivity');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});
	});
	describe('multi-client observed writes', () => {
		it.each(['sessions:setMany', 'sessions:setAll'])(
			'clears a sent image whose baseline still holds it inline (%s)',
			async (channel) => {
				// The renderer keeps the pasted image as a data URL; disk holds its ref.
				configureImageStore(path.join(os.tmpdir(), `maestro-image-store-${process.pid}`));
				const pasted = 'data:image/png;base64,iVBORw0KGgo=';
				const drafted = {
					id: 'shared',
					name: 'Agent',
					toolType: 'claude-code',
					cwd: '/host',
					aiTabs: [{ id: 'one', logs: [], inputValue: 'look', stagedImages: [pasted] }],
					executionQueue: [{ id: 'queued', type: 'message', text: 'look', images: [pasted] }],
				};
				let stored: StoredSession[] = [];
				mockSessionsStore.get.mockImplementation((key) => (key === 'sessions' ? stored : ''));
				mockSessionsStore.set.mockImplementation((key, value) => {
					if (key === 'sessions') stored = value;
				});
				const save = (sessions: unknown[], baselines: unknown[]) =>
					channel === 'sessions:setMany'
						? handlers.get(channel)!({}, sessions, [], baselines)
						: handlers.get(channel)!({}, sessions, baselines);

				try {
					await save([drafted], []);
					expect(stored[0].aiTabs[0].stagedImages?.[0]).toMatch(/^maestro-image:\/\//);

					const sent = {
						...drafted,
						aiTabs: [
							{
								id: 'one',
								logs: [{ id: 'user', text: 'look', images: [pasted] }],
								inputValue: '',
								stagedImages: [],
							},
						],
						executionQueue: [],
					};
					await save([sent], [drafted]);

					expect(stored[0].aiTabs[0].stagedImages).toEqual([]);
					expect(stored[0].executionQueue).toEqual([]);
				} finally {
					__resetImageStoreCacheForTests();
				}
			}
		);
		it('broadcasts merged host state instead of stale fields from a remote save', async () => {
			const baseline = {
				id: 'shared',
				name: 'Before',
				toolType: 'claude-code',
				cwd: path.join('synthetic', 'before'),
				state: 'idle',
				inputMode: 'ai',
			};
			mockSessionsStore.get.mockReturnValue([{ ...baseline, name: 'Host renamed', state: 'busy' }]);
			mockWebServer.getWebClientCount.mockReturnValue(1);
			const cwd = path.join('synthetic', 'after');
			await handlers.get('sessions:setMany')!(
				{ type: 'bridge' },
				[{ ...baseline, name: 'Stale client rename', inputMode: 'terminal', cwd }],
				[],
				[baseline]
			);
			const persisted = mockSessionsStore.set.mock.calls.find(([key]) => key === 'sessions')![1][0];
			expect(persisted).toMatchObject({
				name: 'Host renamed',
				state: 'busy',
				inputMode: 'ai',
				cwd,
			});
			expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalledWith(
				'shared',
				'busy',
				expect.objectContaining({ name: 'Host renamed', inputMode: 'ai', cwd })
			);
		});
		it.each(['sessions:setMany', 'sessions:setAll'])(
			'retains host transcript, new tabs, consumed queue and read-state across stale %s',
			async (channel) => {
				const baseline = {
					id: 'shared',
					name: 'Before',
					toolType: 'claude-code',
					cwd: '/host',
					activeTabId: 'one',
					aiTabs: [
						{
							id: 'one',
							logs: [{ id: 'log', text: 'old' }],
							hasUnread: true,
							inputValue: 'host draft',
						},
					],
					executionQueue: [{ id: 'accepted', type: 'message', text: 'already running' }],
				};
				let stored: StoredSession[] = [
					{
						...baseline,
						aiTabs: [
							{
								...baseline.aiTabs[0],
								logs: [
									{ id: 'log', text: 'finished' },
									{ id: 'reply', text: 'host response' },
								],
								hasUnread: false,
							},
							{ id: 'host-new-tab', logs: [] },
						],
						executionQueue: [],
					},
				];
				mockSessionsStore.get.mockImplementation((key) =>
					key === 'sessions' ? stored : 'host-focus'
				);
				mockSessionsStore.set.mockImplementation((key, value) => {
					if (key === 'sessions') stored = value;
				});
				const stale = {
					...baseline,
					name: 'Renamed remotely',
					activeTabId: 'other',
					aiTabs: [{ ...baseline.aiTabs[0], inputValue: 'client draft' }],
				};
				if (channel === 'sessions:setMany')
					await handlers.get(channel)!({ type: 'bridge' }, [stale], [], [baseline]);
				else await handlers.get(channel)!({ type: 'bridge' }, [stale], [baseline]);
				expect(stored[0].name).toBe('Renamed remotely');
				expect(stored[0].executionQueue).toEqual([]);
				expect(stored[0].activeTabId).toBe('one');
				expect(stored[0].aiTabs).toEqual([
					{
						...baseline.aiTabs[0],
						logs: [
							{ id: 'log', text: 'finished' },
							{ id: 'reply', text: 'host response' },
						],
						hasUnread: false,
					},
					{ id: 'host-new-tab', logs: [] },
				]);
			}
		);
		it('merges simultaneous queue additions without resurrecting a consumed item or closed tab', async () => {
			const baseline = {
				id: 'shared',
				name: 'Agent',
				toolType: 'claude-code',
				cwd: '/host',
				aiTabs: [
					{ id: 'closed', logs: [] },
					{ id: 'open', logs: [] },
				],
				executionQueue: [{ id: 'consumed', type: 'message' }],
			};
			let stored: StoredSession[] = [
				{
					...baseline,
					aiTabs: [baseline.aiTabs[1]],
					executionQueue: [{ id: 'host-item', type: 'message' }],
				},
			];
			mockSessionsStore.get.mockImplementation(() => stored);
			mockSessionsStore.set.mockImplementation((_key, value) => {
				stored = value;
			});
			await handlers.get('sessions:setMany')!(
				{ type: 'bridge' },
				[
					{
						...baseline,
						executionQueue: [...baseline.executionQueue, { id: 'client-item', type: 'message' }],
					},
				],
				[],
				[baseline]
			);
			expect(stored[0].executionQueue.map((item: { id: string }) => item.id)).toEqual([
				'host-item',
				'client-item',
			]);
			expect(stored[0].aiTabs.map((tab: { id: string }) => tab.id)).toEqual(['open']);
		});
		it('does not erase host-only credentials omitted from masked bootstrap and save', async () => {
			const baseline = { id: 'shared', name: 'Before', toolType: 'claude-code', cwd: '/host' };
			mockSessionsStore.get.mockReturnValue([
				{ ...baseline, customEnvVars: { API_KEY: 'host-only' }, remoteEnv: { TOKEN: 'private' } },
			]);
			await handlers.get('sessions:setMany')!(
				{ type: 'bridge' },
				[{ ...baseline, name: 'After' }],
				[],
				[baseline]
			);
			const persisted = mockSessionsStore.set.mock.calls.find(([key]) => key === 'sessions')![1][0];
			expect(persisted).toMatchObject({
				name: 'After',
				customEnvVars: { API_KEY: 'host-only' },
				remoteEnv: { TOKEN: 'private' },
			});
		});
		it('remote navigation never replaces the host pointer', async () => {
			await handlers.get('sessions:setActiveSessionId')!({}, 'host-agent');
			await handlers.get('sessions:setActiveSessionId')!({ type: 'bridge' }, 'remote-agent');
			expect(await handlers.get('sessions:getActiveSessionId')!({})).toBe('host-agent');
		});
	});
});
