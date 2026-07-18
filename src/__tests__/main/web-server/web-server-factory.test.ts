/**
 * @file web-server-factory.test.ts
 * @description Unit tests for web server factory with dependency injection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain, type BrowserWindow, type WebContents } from 'electron';

// Mock electron
vi.mock('electron', () => ({
	ipcMain: {
		once: vi.fn(),
		removeListener: vi.fn(),
	},
	app: {
		getPath: vi.fn().mockReturnValue('/tmp/userData'),
		getVersion: vi.fn().mockReturnValue('0.16.17'),
		on: vi.fn(),
	},
	BrowserWindow: {
		getAllWindows: vi.fn().mockReturnValue([]),
	},
}));

// Mock WebServer - use class syntax to make it a proper constructor
// Note: Mock the specific file path that web-server-factory.ts imports from
vi.mock('../../../main/web-server/WebServer', () => {
	return {
		WebServer: class MockWebServer {
			port: number;
			securityToken: string | undefined;
			setGetSessionsCallback = vi.fn();
			setGetSessionDetailCallback = vi.fn();
			setGetThemeCallback = vi.fn();
			setGetBionifyReadingModeCallback = vi.fn();
			setGetCustomCommandsCallback = vi.fn();
			setGetHistoryCallback = vi.fn();
			setWriteToSessionCallback = vi.fn();
			setExecuteCommandCallback = vi.fn();
			setInterruptSessionCallback = vi.fn();
			setSwitchModeCallback = vi.fn();
			setSelectSessionCallback = vi.fn();
			setSelectTabCallback = vi.fn();
			setNewTabCallback = vi.fn();
			setCloseTabCallback = vi.fn();
			setRenameTabCallback = vi.fn();
			setStarTabCallback = vi.fn();
			setReorderTabCallback = vi.fn();
			setToggleBookmarkCallback = vi.fn();
			setOpenFileTabCallback = vi.fn();
			setOpenBrowserTabCallback = vi.fn();
			setOpenTerminalTabCallback = vi.fn();
			setNewAITabWithPromptCallback = vi.fn();
			setRefreshFileTreeCallback = vi.fn();
			setRefreshAutoRunDocsCallback = vi.fn();
			setConfigureAutoRunCallback = vi.fn();
			setSessionAutoRunFolderCallback = vi.fn();
			setGetAutoRunDocsCallback = vi.fn();
			setGetAutoRunDocContentCallback = vi.fn();
			setSaveAutoRunDocCallback = vi.fn();
			setStopAutoRunCallback = vi.fn();
			// Auto Run parity additions - task reset, error recovery, playbook CRUD.
			// The factory wires these during createWebServer; without the stubs
			// the module-under-test throws TypeError on startup.
			setResetAutoRunDocTasksCallback = vi.fn();
			setResumeAutoRunErrorCallback = vi.fn();
			setSkipAutoRunDocumentCallback = vi.fn();
			setAbortAutoRunErrorCallback = vi.fn();
			setListPlaybooksCallback = vi.fn();
			setCreatePlaybookCallback = vi.fn();
			setUpdatePlaybookCallback = vi.fn();
			setDeletePlaybookCallback = vi.fn();
			setGetSettingsCallback = vi.fn();
			setSetSettingCallback = vi.fn();
			setGetGroupsCallback = vi.fn();
			setCreateGroupCallback = vi.fn();
			setRenameGroupCallback = vi.fn();
			setDeleteGroupCallback = vi.fn();
			setMoveSessionToGroupCallback = vi.fn();
			setCreateSessionCallback = vi.fn();
			setCreateWorktreeSessionCallback = vi.fn();
			setDeleteSessionCallback = vi.fn();
			setRenameSessionCallback = vi.fn();
			setUpdateSessionCwdCallback = vi.fn();
			setUpdateSessionSshCallback = vi.fn();
			setUpdateSessionConfigCallback = vi.fn();
			setGetGitStatusCallback = vi.fn();
			setGetGitDiffCallback = vi.fn();
			setGetGitBranchesForSessionCallback = vi.fn();
			setListWorktreesForSessionCallback = vi.fn();
			setGetGroupChatsCallback = vi.fn();
			setStartGroupChatCallback = vi.fn();
			setGetGroupChatStateCallback = vi.fn();
			setStopGroupChatCallback = vi.fn();
			setSendGroupChatMessageCallback = vi.fn();
			setMergeContextCallback = vi.fn();
			setTransferContextCallback = vi.fn();
			setSummarizeContextCallback = vi.fn();
			setCreateGistCallback = vi.fn();
			setGetCueSubscriptionsCallback = vi.fn();
			setToggleCueSubscriptionCallback = vi.fn();
			setGetCueActivityCallback = vi.fn();
			setTriggerCueSubscriptionCallback = vi.fn();
			setGetUsageDashboardCallback = vi.fn();
			setGetAchievementsCallback = vi.fn();
			setGenerateDirectorNotesSynopsisCallback = vi.fn();
			setWriteToTerminalCallback = vi.fn();
			setResizeTerminalCallback = vi.fn();
			setSpawnTerminalForWebCallback = vi.fn();
			setKillTerminalForWebCallback = vi.fn();
			setNotifyToastCallback = vi.fn();
			setNotifyCenterFlashCallback = vi.fn();
			setGetMarketplaceManifestCallback = vi.fn();
			setGetMarketplaceDocumentCallback = vi.fn();
			setGetMarketplaceReadmeCallback = vi.fn();
			setImportMarketplacePlaybookCallback = vi.fn();
			setListDesktopSessionsCallback = vi.fn();
			setGetSessionHistoryCallback = vi.fn();
			// Concerto: Movement (in-app panels) + Cadenza (HUD cards) bridge callbacks.
			// The factory wires these during createWebServer; without the stubs the
			// module-under-test throws TypeError on startup.
			setCadenzaViewCallback = vi.fn();
			setMovementViewCallback = vi.fn();
			setGetMovementStateCallback = vi.fn();
			setGetMovementDesignerInspectionCallback = vi.fn();
			setInteractMovementDesignerCallback = vi.fn();

			constructor(port: number, securityToken?: string) {
				this.port = port;
				this.securityToken = securityToken;
			}
		},
	};
});

// Mock themes
vi.mock('../../../main/themes', () => ({
	getThemeById: vi.fn().mockReturnValue({ id: 'dracula', name: 'Dracula' }),
}));

// Mock history manager
vi.mock('../../../main/history-manager', () => ({
	getHistoryManager: vi.fn().mockReturnValue({
		getEntries: vi.fn().mockReturnValue([]),
		getEntriesByProjectPath: vi.fn().mockReturnValue([]),
		getAllEntries: vi.fn().mockReturnValue([]),
	}),
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock marketplace-service so the import callback path is testable without
// hitting GitHub / the local cache. Each test that exercises the callback
// can override the per-fn return values.
vi.mock('../../../main/services/marketplace-service', () => ({
	getMarketplaceManifest: vi.fn(),
	refreshMarketplaceManifest: vi.fn(),
	getMarketplaceDocument: vi.fn(),
	getMarketplaceReadme: vi.fn(),
	importMarketplacePlaybook: vi.fn(),
}));

// Mock Sentry - captureException is called from the import callback's
// failure branch.
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import {
	createWebServerFactory,
	type WebServerFactoryDependencies,
} from '../../../main/web-server/web-server-factory';
import { WebServer } from '../../../main/web-server/WebServer';
import { getThemeById } from '../../../main/themes';
import { getHistoryManager } from '../../../main/history-manager';
import { logger } from '../../../main/utils/logger';
import { importMarketplacePlaybook } from '../../../main/services/marketplace-service';
import {
	applyMovementHtmlPayload,
	clearConcertoHtmlDocumentsForTests,
	getConcertoHtmlDocumentRevision,
} from '../../../main/concerto-html';

describe('web-server/web-server-factory', () => {
	let mockSettingsStore: WebServerFactoryDependencies['settingsStore'];
	let mockSessionsStore: WebServerFactoryDependencies['sessionsStore'];
	let mockGroupsStore: WebServerFactoryDependencies['groupsStore'];
	let mockMainWindow: Partial<BrowserWindow>;
	let mockWebContents: Partial<WebContents>;
	let mockProcessManager: { write: ReturnType<typeof vi.fn> };
	let deps: WebServerFactoryDependencies;

	beforeEach(() => {
		vi.clearAllMocks();
		clearConcertoHtmlDocumentsForTests();

		mockSettingsStore = {
			get: vi.fn((key: string, defaultValue?: any) => {
				const values: Record<string, any> = {
					webInterfaceUseCustomPort: false,
					webInterfaceCustomPort: 8080,
					persistentWebLink: false,
					webAuthToken: null,
					activeThemeId: 'dracula',
					customAICommands: [],
				};
				return values[key] ?? defaultValue;
			}),
			set: vi.fn(),
		};

		mockSessionsStore = {
			get: vi.fn((key: string, defaultValue?: any) => {
				if (key === 'sessions') {
					return [
						{
							id: 'session-1',
							name: 'Test Session',
							toolType: 'claude-code',
							state: 'idle',
							inputMode: 'ai',
							cwd: '/test/path',
							aiTabs: [
								{
									id: 'tab-1',
									logs: [{ source: 'stdout', text: 'Hello', timestamp: Date.now() }],
								},
							],
							activeTabId: 'tab-1',
						},
					];
				}
				return defaultValue;
			}),
		};

		mockGroupsStore = {
			get: vi.fn((key: string, defaultValue?: any) => {
				if (key === 'groups') {
					return [{ id: 'group-1', name: 'Test Group', emoji: '🧪' }];
				}
				return defaultValue;
			}),
		};

		mockWebContents = {
			send: vi.fn(),
			isDestroyed: vi.fn().mockReturnValue(false),
		};

		mockMainWindow = {
			isDestroyed: vi.fn().mockReturnValue(false),
			webContents: mockWebContents as WebContents,
		};

		mockProcessManager = {
			write: vi.fn().mockReturnValue(true),
		};

		deps = {
			settingsStore: mockSettingsStore,
			sessionsStore: mockSessionsStore,
			groupsStore: mockGroupsStore,
			getMainWindow: vi.fn().mockReturnValue(mockMainWindow as BrowserWindow),
			getProcessManager: vi.fn().mockReturnValue(mockProcessManager),
		};
	});

	describe('createWebServerFactory', () => {
		it('should return a function', () => {
			const factory = createWebServerFactory(deps);
			expect(typeof factory).toBe('function');
		});

		it('should create a WebServer when called', () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			expect(server).toBeDefined();
			expect(server).toBeInstanceOf(WebServer);
		});

		it('should register a bionify reading mode callback sourced from settings', () => {
			vi.mocked(mockSettingsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'bionifyReadingMode') return true;
				return defaultValue;
			});

			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer() as any;

			expect(server.setGetBionifyReadingModeCallback).toHaveBeenCalledTimes(1);
			const callback = server.setGetBionifyReadingModeCallback.mock.calls[0][0];
			expect(callback()).toBe(true);
			expect(mockSettingsStore.get).toHaveBeenCalledWith('bionifyReadingMode', false);
		});

		it('should use random port (0) when custom port is disabled', () => {
			vi.mocked(mockSettingsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'webInterfaceUseCustomPort') return false;
				if (key === 'webInterfaceCustomPort') return 9999;
				return defaultValue;
			});

			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			// Check that the server was created with port 0 (random)
			expect((server as any).port).toBe(0);
		});

		it('should use custom port when enabled', () => {
			vi.mocked(mockSettingsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'webInterfaceUseCustomPort') return true;
				if (key === 'webInterfaceCustomPort') return 9999;
				return defaultValue;
			});

			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			// Check that the server was created with custom port
			expect((server as any).port).toBe(9999);
		});

		it('should not pass security token when persistentWebLink is false', () => {
			vi.mocked(mockSettingsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'persistentWebLink') return false;
				return defaultValue;
			});

			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			expect((server as any).securityToken).toBeUndefined();
		});

		it('should use stored token when persistentWebLink is true and token is a valid UUID', () => {
			const validUuid = '550e8400-e29b-4bd4-a716-446655440000';
			vi.mocked(mockSettingsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'persistentWebLink') return true;
				if (key === 'webAuthToken') return validUuid;
				return defaultValue;
			});

			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			expect((server as any).securityToken).toBe(validUuid);
		});

		it('should reject invalid stored token and generate a new UUID', () => {
			vi.mocked(mockSettingsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'persistentWebLink') return true;
				if (key === 'webAuthToken') return 'not-a-valid-uuid';
				return defaultValue;
			});

			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			// Should have generated a new token, not used the invalid one
			expect((server as any).securityToken).not.toBe('not-a-valid-uuid');
			expect((server as any).securityToken).toBeDefined();
			expect(mockSettingsStore.set).toHaveBeenCalledWith('webAuthToken', expect.any(String));
			// Token written to settings must match the one given to the server
			const storedToken = vi
				.mocked(mockSettingsStore.set)
				.mock.calls.find(([key]) => key === 'webAuthToken')?.[1];
			expect((server as any).securityToken).toBe(storedToken);
			// Generated replacement must be a valid UUID v4
			expect(storedToken).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
			);
		});

		it('should generate and store new token when persistentWebLink is true and no token exists', () => {
			vi.mocked(mockSettingsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'persistentWebLink') return true;
				if (key === 'webAuthToken') return null;
				return defaultValue;
			});

			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			// Should have generated a token and stored it
			expect((server as any).securityToken).toBeDefined();
			expect(typeof (server as any).securityToken).toBe('string');
			expect(mockSettingsStore.set).toHaveBeenCalledWith('webAuthToken', expect.any(String));
			// Token written to settings must match the one given to the server
			const storedToken = vi
				.mocked(mockSettingsStore.set)
				.mock.calls.find(([key]) => key === 'webAuthToken')?.[1];
			expect((server as any).securityToken).toBe(storedToken);
			// Generated token must be a valid UUID v4
			expect(storedToken).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
			);
		});
	});

	describe('callback registrations', () => {
		let createWebServer: ReturnType<typeof createWebServerFactory>;
		let server: ReturnType<typeof createWebServer>;

		beforeEach(() => {
			createWebServer = createWebServerFactory(deps);
			server = createWebServer();
		});

		it('should register getSessionsCallback', () => {
			expect(server.setGetSessionsCallback).toHaveBeenCalled();
		});

		it('should register getSessionDetailCallback', () => {
			expect(server.setGetSessionDetailCallback).toHaveBeenCalled();
		});

		it('should register getThemeCallback', () => {
			expect(server.setGetThemeCallback).toHaveBeenCalled();
		});

		it('should register getCustomCommandsCallback', () => {
			expect(server.setGetCustomCommandsCallback).toHaveBeenCalled();
		});

		it('should register getHistoryCallback', () => {
			expect(server.setGetHistoryCallback).toHaveBeenCalled();
		});

		it('should register writeToSessionCallback', () => {
			expect(server.setWriteToSessionCallback).toHaveBeenCalled();
		});

		it('should register executeCommandCallback', () => {
			expect(server.setExecuteCommandCallback).toHaveBeenCalled();
		});

		it('should register interruptSessionCallback', () => {
			expect(server.setInterruptSessionCallback).toHaveBeenCalled();
		});

		it('should register switchModeCallback', () => {
			expect(server.setSwitchModeCallback).toHaveBeenCalled();
		});

		it('should register selectSessionCallback', () => {
			expect(server.setSelectSessionCallback).toHaveBeenCalled();
		});

		it('should register tab operation callbacks', () => {
			expect(server.setSelectTabCallback).toHaveBeenCalled();
			expect(server.setNewTabCallback).toHaveBeenCalled();
			expect(server.setCloseTabCallback).toHaveBeenCalled();
			expect(server.setRenameTabCallback).toHaveBeenCalled();
		});

		it('should register file and auto-run callbacks', () => {
			expect(server.setOpenFileTabCallback).toHaveBeenCalled();
			expect(server.setRefreshFileTreeCallback).toHaveBeenCalled();
			expect(server.setRefreshAutoRunDocsCallback).toHaveBeenCalled();
			expect(server.setConfigureAutoRunCallback).toHaveBeenCalled();
		});
	});

	describe('Concerto movement callback behavior', () => {
		beforeEach(() => {
			mockSettingsStore.get = vi.fn((key: string, defaultValue?: unknown) => {
				if (key === 'encoreFeatures') return { concerto: true };
				return defaultValue;
			}) as WebServerFactoryDependencies['settingsStore']['get'];
		});

		it('routes the main-process HTML revision to the renderer', async () => {
			const server = createWebServerFactory(deps)() as any;
			const callback = server.setMovementViewCallback.mock.calls[0][0];

			const resultPromise = callback({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<button>Continue</button>',
			});
			const request = (mockWebContents.send as ReturnType<typeof vi.fn>).mock.calls.find(
				(call) => call[0] === 'remote:movement'
			);
			expect(request).toEqual([
				'remote:movement',
				expect.objectContaining({ id: 'mockup', revision: 1 }),
				expect.any(String),
			]);
			const responseChannel = request?.[2] as string;
			const responseListener = vi
				.mocked(ipcMain.once)
				.mock.calls.find((call) => call[0] === responseChannel)?.[1];
			responseListener?.({} as never, true);

			await expect(resultPromise).resolves.toBe(true);
		});

		it('rejects a bodyless transition to HTML when no document exists', async () => {
			const server = createWebServerFactory(deps)() as any;
			const callback = server.setMovementViewCallback.mock.calls[0][0];

			await expect(callback({ op: 'update', id: 'native-panel', viewType: 'html' })).resolves.toBe(
				false
			);

			expect(
				(mockWebContents.send as ReturnType<typeof vi.fn>).mock.calls.some(
					([channel]) => channel === 'remote:movement'
				)
			).toBe(false);
		});

		it('passes the current HTML revision into inspection requests', async () => {
			applyMovementHtmlPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<button>Continue</button>',
			});
			const server = createWebServerFactory(deps)() as any;
			const callback = server.setGetMovementDesignerInspectionCallback.mock.calls[0][0];

			const resultPromise = callback('mockup');
			const request = (mockWebContents.send as ReturnType<typeof vi.fn>).mock.calls.find(
				(call) => call[0] === 'remote:getMovementDesignerInspection'
			);
			expect(request).toEqual([
				'remote:getMovementDesignerInspection',
				'mockup',
				1,
				expect.any(String),
			]);
			const responseChannel = request?.[3] as string;
			const responseListener = vi
				.mocked(ipcMain.once)
				.mock.calls.find((call) => call[0] === responseChannel)?.[1];
			responseListener?.({} as never, null);

			await expect(resultPromise).resolves.toBeNull();
		});

		it('defers concurrent HTML updates until the active inspection completes', async () => {
			applyMovementHtmlPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<button>Original</button>',
			});
			const server = createWebServerFactory(deps)() as any;
			const inspectionCallback = server.setGetMovementDesignerInspectionCallback.mock.calls[0][0];
			const movementCallback = server.setMovementViewCallback.mock.calls[0][0];

			const inspectionPromise = inspectionCallback('mockup');
			const inspectionRequest = (mockWebContents.send as ReturnType<typeof vi.fn>).mock.calls.find(
				(call) => call[0] === 'remote:getMovementDesignerInspection'
			);
			expect(inspectionRequest).toEqual([
				'remote:getMovementDesignerInspection',
				'mockup',
				1,
				expect.any(String),
			]);

			const updatePromise = movementCallback({
				op: 'update',
				id: 'mockup',
				viewType: 'html',
				body: '<button>Updated</button>',
			});
			expect(getConcertoHtmlDocumentRevision('movement', 'mockup')).toBe(1);
			expect(
				(mockWebContents.send as ReturnType<typeof vi.fn>).mock.calls.some(
					([channel]) => channel === 'remote:movement'
				)
			).toBe(false);

			(mockWebContents.send as ReturnType<typeof vi.fn>).mockImplementation(
				(channel: string, ...args: unknown[]) => {
					if (channel !== 'remote:movement') return;
					const responseChannel = args[1] as string;
					const responseListener = vi
						.mocked(ipcMain.once)
						.mock.calls.find((call) => call[0] === responseChannel)?.[1];
					queueMicrotask(() => responseListener?.({} as never, true));
				}
			);
			const inspectionResponseChannel = inspectionRequest?.[3] as string;
			const inspectionResponseListener = vi
				.mocked(ipcMain.once)
				.mock.calls.find((call) => call[0] === inspectionResponseChannel)?.[1];
			inspectionResponseListener?.({} as never, null);

			await expect(Promise.all([inspectionPromise, updatePromise])).resolves.toEqual([null, true]);
			expect(getConcertoHtmlDocumentRevision('movement', 'mockup')).toBe(2);
		});
	});

	describe('getSessionsCallback behavior', () => {
		it('should return sessions with mapped data', () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			// Get the callback that was registered
			const setGetSessionsCallback = server.setGetSessionsCallback as ReturnType<typeof vi.fn>;
			const callback = setGetSessionsCallback.mock.calls[0][0];

			const sessions = callback();

			expect(Array.isArray(sessions)).toBe(true);
			expect(sessions.length).toBeGreaterThan(0);
			expect(sessions[0]).toHaveProperty('id');
			expect(sessions[0]).toHaveProperty('name');
			expect(sessions[0]).toHaveProperty('toolType');
		});
	});

	// PR2 of the CLI surface refactor: read-only conversation-state inspection
	// surfaced via `maestro-cli session show <tabId>`. The callback wired here
	// is the desktop-side half of the contract; the CLI half is tested in
	// `src/__tests__/cli/commands/session.test.ts`.
	describe('getSessionHistoryCallback behavior', () => {
		// Session shape with three logs at known timestamps so --since / --tail
		// boundaries are unambiguous. Stored on `mockSessionsStore` per-test so
		// we can vary the ordering / source mix without churning the outer
		// fixture.
		const stockSession = (logs: Array<Record<string, unknown>>) => [
			{
				id: 'agent-a',
				name: 'Backend',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/test/path',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'claude-uuid-1',
						logs,
					},
				],
				activeTabId: 'tab-1',
			},
		];

		const getCallback = () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const setGetSessionHistoryCallback = server.setGetSessionHistoryCallback as ReturnType<
				typeof vi.fn
			>;
			return setGetSessionHistoryCallback.mock.calls[0][0];
		};

		it('returns null when the tab id does not match any open tab', () => {
			vi.mocked(mockSessionsStore.get).mockReturnValue(
				stockSession([{ id: 'log-1', source: 'user', text: 'hi', timestamp: 100 }])
			);

			const callback = getCallback();
			expect(callback('tab-bogus')).toBeNull();
		});

		it('returns the full transcript with derived roles when no filters are passed', () => {
			vi.mocked(mockSessionsStore.get).mockReturnValue(
				stockSession([
					{ id: 'log-1', source: 'user', text: 'hi', timestamp: 100 },
					{ id: 'log-2', source: 'ai', text: 'hello', timestamp: 200 },
					{ id: 'log-3', source: 'stdout', text: 'legacy reply', timestamp: 300 },
				])
			);

			const callback = getCallback();
			const result = callback('tab-1');

			expect(result).not.toBeNull();
			expect(result.tabId).toBe('tab-1');
			expect(result.agentId).toBe('agent-a');
			expect(result.agentSessionId).toBe('claude-uuid-1');
			expect(result.messages).toHaveLength(3);
			expect(result.messages.map((m: { role: string }) => m.role)).toEqual([
				'user',
				'assistant',
				// `stdout` collapses to `assistant` because legacy / non-AI agent
				// flows store assistant replies under that source.
				'assistant',
			]);
		});

		it('drops messages at or before --sinceMs (cursor is exclusive)', () => {
			vi.mocked(mockSessionsStore.get).mockReturnValue(
				stockSession([
					{ id: 'log-1', source: 'user', text: 'a', timestamp: 100 },
					{ id: 'log-2', source: 'ai', text: 'b', timestamp: 200 },
					{ id: 'log-3', source: 'user', text: 'c', timestamp: 300 },
				])
			);

			const callback = getCallback();
			const result = callback('tab-1', { sinceMs: 200 });

			// `> sinceMs` (not `>=`) keeps the cursor exclusive so a Discord
			// bot can reuse the last received timestamp without seeing the
			// same message twice on the next poll.
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].id).toBe('log-3');
		});

		it('returns an empty array for --tail 0 (the slice(-0) foot-gun)', () => {
			// Regression guard for the original `slice(-options.tail)` bug:
			// `-0 === 0`, so `slice(-0)` returned the full array and `--tail 0`
			// silently shipped the entire transcript instead of nothing.
			vi.mocked(mockSessionsStore.get).mockReturnValue(
				stockSession([
					{ id: 'log-1', source: 'user', text: 'a', timestamp: 100 },
					{ id: 'log-2', source: 'ai', text: 'b', timestamp: 200 },
				])
			);

			const callback = getCallback();
			const result = callback('tab-1', { tail: 0 });

			expect(result.messages).toEqual([]);
		});

		it('returns the last N messages when --tail is positive', () => {
			vi.mocked(mockSessionsStore.get).mockReturnValue(
				stockSession([
					{ id: 'log-1', source: 'user', text: 'a', timestamp: 100 },
					{ id: 'log-2', source: 'ai', text: 'b', timestamp: 200 },
					{ id: 'log-3', source: 'user', text: 'c', timestamp: 300 },
				])
			);

			const callback = getCallback();
			const result = callback('tab-1', { tail: 2 });

			expect(result.messages).toHaveLength(2);
			expect(result.messages.map((m: { id: string }) => m.id)).toEqual(['log-2', 'log-3']);
		});

		it('clamps --tail above the transcript length to the full transcript', () => {
			vi.mocked(mockSessionsStore.get).mockReturnValue(
				stockSession([
					{ id: 'log-1', source: 'user', text: 'a', timestamp: 100 },
					{ id: 'log-2', source: 'ai', text: 'b', timestamp: 200 },
				])
			);

			const callback = getCallback();
			const result = callback('tab-1', { tail: 99 });

			expect(result.messages).toHaveLength(2);
		});
	});

	describe('writeToSessionCallback behavior', () => {
		it('should return false when processManager is null', () => {
			deps.getProcessManager = vi.fn().mockReturnValue(null);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setWriteCallback = server.setWriteToSessionCallback as ReturnType<typeof vi.fn>;
			const callback = setWriteCallback.mock.calls[0][0];

			const result = callback('session-1', 'test data');

			expect(result).toBe(false);
			expect(logger.warn).toHaveBeenCalled();
		});

		it('should return false when session not found', () => {
			vi.mocked(mockSessionsStore.get).mockReturnValue([]);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setWriteCallback = server.setWriteToSessionCallback as ReturnType<typeof vi.fn>;
			const callback = setWriteCallback.mock.calls[0][0];

			const result = callback('non-existent-session', 'test data');

			expect(result).toBe(false);
		});

		it('should write to AI process when inputMode is ai', () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setWriteCallback = server.setWriteToSessionCallback as ReturnType<typeof vi.fn>;
			const callback = setWriteCallback.mock.calls[0][0];

			callback('session-1', 'test data');

			expect(mockProcessManager.write).toHaveBeenCalledWith('session-1-ai', 'test data');
		});
	});

	describe('executeCommandCallback behavior', () => {
		it('should return false when mainWindow is null', async () => {
			deps.getMainWindow = vi.fn().mockReturnValue(null);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setExecuteCallback = server.setExecuteCommandCallback as ReturnType<typeof vi.fn>;
			const callback = setExecuteCallback.mock.calls[0][0];

			const result = await callback('session-1', 'test command');

			expect(result).toBe(false);
			expect(logger.warn).toHaveBeenCalled();
		});

		it('should send command to renderer (omitting tabId routes to active tab)', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setExecuteCallback = server.setExecuteCommandCallback as ReturnType<typeof vi.fn>;
			const callback = setExecuteCallback.mock.calls[0][0];

			const result = await callback('session-1', 'test command', 'ai');

			expect(result).toBe(true);
			expect(mockWebContents.send).toHaveBeenCalledWith(
				'remote:executeCommand',
				'session-1',
				'test command',
				'ai',
				undefined,
				undefined,
				undefined
			);
		});

		it('forwards tabId to the renderer so `dispatch --session <tabId>` writes into the requested tab', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setExecuteCallback = server.setExecuteCommandCallback as ReturnType<typeof vi.fn>;
			const callback = setExecuteCallback.mock.calls[0][0];

			const result = await callback('session-1', 'follow up', 'ai', 'tab-7');

			expect(result).toBe(true);
			expect(mockWebContents.send).toHaveBeenCalledWith(
				'remote:executeCommand',
				'session-1',
				'follow up',
				'ai',
				'tab-7',
				undefined,
				undefined
			);
		});

		it('forwards force=true to the renderer so `dispatch --force` bypasses the renderer busy guard', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setExecuteCallback = server.setExecuteCommandCallback as ReturnType<typeof vi.fn>;
			const callback = setExecuteCallback.mock.calls[0][0];

			const result = await callback('session-1', 'concurrent write', 'ai', undefined, true);

			expect(result).toBe(true);
			expect(mockWebContents.send).toHaveBeenCalledWith(
				'remote:executeCommand',
				'session-1',
				'concurrent write',
				'ai',
				undefined,
				true,
				undefined
			);
		});

		it('forwards images so pasted attachments reach the renderer alongside the prompt', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setExecuteCallback = server.setExecuteCommandCallback as ReturnType<typeof vi.fn>;
			const callback = setExecuteCallback.mock.calls[0][0];

			const images = ['data:image/png;base64,abc', 'data:image/png;base64,def'];
			const result = await callback(
				'session-1',
				'look at this',
				'ai',
				undefined,
				undefined,
				images
			);

			expect(result).toBe(true);
			expect(mockWebContents.send).toHaveBeenCalledWith(
				'remote:executeCommand',
				'session-1',
				'look at this',
				'ai',
				undefined,
				undefined,
				images
			);
		});

		it('does not log raw command text at info level (info shows length only)', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setExecuteCallback = server.setExecuteCommandCallback as ReturnType<typeof vi.fn>;
			const callback = setExecuteCallback.mock.calls[0][0];

			await callback('session-1', 'super-secret-token-do-not-leak', 'ai');

			const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
			const forwardingInfoCall = infoCalls.find(
				(c: unknown[]) => typeof c[0] === 'string' && c[0].includes('[Web → Renderer]')
			);
			expect(forwardingInfoCall).toBeDefined();
			expect(forwardingInfoCall?.[0]).not.toContain('super-secret-token-do-not-leak');
			expect(forwardingInfoCall?.[0]).toContain('CommandLength: 30');
		});
	});

	describe('interruptSessionCallback behavior', () => {
		it('should return false when mainWindow is null', async () => {
			deps.getMainWindow = vi.fn().mockReturnValue(null);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setInterruptCallback = server.setInterruptSessionCallback as ReturnType<typeof vi.fn>;
			const callback = setInterruptCallback.mock.calls[0][0];

			const result = await callback('session-1');

			expect(result).toBe(false);
		});

		it('should send interrupt to renderer', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setInterruptCallback = server.setInterruptSessionCallback as ReturnType<typeof vi.fn>;
			const callback = setInterruptCallback.mock.calls[0][0];

			const result = await callback('session-1');

			expect(result).toBe(true);
			expect(mockWebContents.send).toHaveBeenCalledWith('remote:interrupt', 'session-1');
		});
	});

	describe('switchModeCallback behavior', () => {
		it('should send mode switch to renderer', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setSwitchModeCallback = server.setSwitchModeCallback as ReturnType<typeof vi.fn>;
			const callback = setSwitchModeCallback.mock.calls[0][0];

			const result = await callback('session-1', 'terminal');

			expect(result).toBe(true);
			expect(mockWebContents.send).toHaveBeenCalledWith(
				'remote:switchMode',
				'session-1',
				'terminal'
			);
		});
	});

	describe('getThemeCallback behavior', () => {
		it('should return theme from getThemeById', () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setThemeCallback = server.setGetThemeCallback as ReturnType<typeof vi.fn>;
			const callback = setThemeCallback.mock.calls[0][0];

			const theme = callback();

			expect(getThemeById).toHaveBeenCalled();
			expect(theme).toEqual({ id: 'dracula', name: 'Dracula' });
		});
	});

	describe('getHistoryCallback behavior', () => {
		it('should get entries for specific session', () => {
			const mockHistoryManager = {
				getEntries: vi.fn().mockReturnValue([{ id: 1 }]),
				getEntriesByProjectPath: vi.fn(),
				getAllEntries: vi.fn(),
			};
			vi.mocked(getHistoryManager).mockReturnValue(mockHistoryManager as any);

			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setHistoryCallback = server.setGetHistoryCallback as ReturnType<typeof vi.fn>;
			const callback = setHistoryCallback.mock.calls[0][0];

			callback(undefined, 'session-1');

			expect(mockHistoryManager.getEntries).toHaveBeenCalledWith('session-1');
		});

		it('should get entries by project path', () => {
			const mockHistoryManager = {
				getEntries: vi.fn(),
				getEntriesByProjectPath: vi.fn().mockReturnValue([{ id: 1 }]),
				getAllEntries: vi.fn(),
			};
			vi.mocked(getHistoryManager).mockReturnValue(mockHistoryManager as any);

			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setHistoryCallback = server.setGetHistoryCallback as ReturnType<typeof vi.fn>;
			const callback = setHistoryCallback.mock.calls[0][0];

			callback('/test/project');

			expect(mockHistoryManager.getEntriesByProjectPath).toHaveBeenCalledWith('/test/project');
		});

		it('should get all entries when no filter', () => {
			const mockHistoryManager = {
				getEntries: vi.fn(),
				getEntriesByProjectPath: vi.fn(),
				getAllEntries: vi.fn().mockReturnValue([{ id: 1 }]),
			};
			vi.mocked(getHistoryManager).mockReturnValue(mockHistoryManager as any);

			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setHistoryCallback = server.setGetHistoryCallback as ReturnType<typeof vi.fn>;
			const callback = setHistoryCallback.mock.calls[0][0];

			callback();

			expect(mockHistoryManager.getAllEntries).toHaveBeenCalled();
		});
	});

	describe('importMarketplacePlaybookCallback behavior', () => {
		// Helper that wires deps to a sessions array + sshRemotes array, builds
		// the factory, and returns the registered import callback.
		const setupImportCallback = (
			sessions: Array<Record<string, unknown>>,
			sshRemotes: Array<Record<string, unknown>>
		) => {
			mockSessionsStore.get = vi.fn((key: string, defaultValue?: any) => {
				if (key === 'sessions') return sessions;
				return defaultValue;
			}) as any;
			const originalSettingsGet = mockSettingsStore.get as ReturnType<typeof vi.fn>;
			mockSettingsStore.get = vi.fn((key: string, defaultValue?: any) => {
				if (key === 'sshRemotes') return sshRemotes;
				return originalSettingsGet(key, defaultValue);
			}) as any;
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const setImport = server.setImportMarketplacePlaybookCallback as ReturnType<typeof vi.fn>;
			return setImport.mock.calls[0][0] as (
				sessionId: string,
				playbookId: string,
				targetFolderName: string
			) => Promise<{ success: boolean; error?: string }>;
		};

		it('should fail loudly when sessionSshRemoteConfig.enabled but remoteId points at no entry', async () => {
			// Mirrors the desktop IPC test: a session with SSH explicitly
			// enabled but an unresolvable remoteId must NOT silently land the
			// playbook on the local filesystem.
			const callback = setupImportCallback(
				[
					{
						id: 'session-1',
						autoRunFolderPath: '/auto-run',
						sessionSshRemoteConfig: {
							enabled: true,
							remoteId: 'non-existent-remote',
						},
					},
				],
				[]
			);

			const result = await callback('session-1', 'pb', 'dest');

			expect(result.success).toBe(false);
			expect(result.error).toContain('SSH remote not found or disabled');
			expect(importMarketplacePlaybook).not.toHaveBeenCalled();
		});

		it('should fail loudly when the matching SSH remote entry is disabled', async () => {
			const callback = setupImportCallback(
				[
					{
						id: 'session-1',
						autoRunFolderPath: '/auto-run',
						sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					},
				],
				[{ id: 'remote-1', enabled: false }]
			);

			const result = await callback('session-1', 'pb', 'dest');

			expect(result.success).toBe(false);
			expect(result.error).toContain('SSH remote not found or disabled');
			expect(importMarketplacePlaybook).not.toHaveBeenCalled();
		});

		it('should fail loudly when sessionSshRemoteConfig.enabled but remoteId is null', async () => {
			const callback = setupImportCallback(
				[
					{
						id: 'session-1',
						autoRunFolderPath: '/auto-run',
						sessionSshRemoteConfig: { enabled: true, remoteId: null },
					},
				],
				[]
			);

			const result = await callback('session-1', 'pb', 'dest');

			expect(result.success).toBe(false);
			expect(result.error).toContain('SSH remote not found or disabled');
			expect(importMarketplacePlaybook).not.toHaveBeenCalled();
		});

		it('should treat sessionSshRemoteConfig.enabled === false as no SSH and import locally', async () => {
			// A session with `enabled: false` and a populated remoteId must
			// NOT be treated as remote - `enabled` is the source of truth.
			// We assert the resolver returned `undefined` for sshConfig (i.e.
			// no remote was looked up); whether the downstream import call
			// succeeds is irrelevant - we only care that the SSH gate let it
			// through as a local import.
			vi.mocked(importMarketplacePlaybook).mockResolvedValueOnce({
				playbook: { id: 'pb-1', name: 'pb', createdAt: 0, updatedAt: 0, documents: [] } as any,
				importedDocs: [],
				importedAssets: [],
			});
			const callback = setupImportCallback(
				[
					{
						id: 'session-1',
						autoRunFolderPath: '/auto-run',
						sessionSshRemoteConfig: { enabled: false, remoteId: 'remote-1' },
					},
				],
				[{ id: 'remote-1', enabled: true }]
			);

			await callback('session-1', 'pb', 'dest');

			expect(importMarketplacePlaybook).toHaveBeenCalledTimes(1);
			expect(importMarketplacePlaybook).toHaveBeenCalledWith(
				expect.objectContaining({ sshConfig: undefined })
			);
		});
	});

	describe('Cue subscription callbacks', () => {
		// Regression: previously this callback forwarded the request to the
		// renderer via `remote:getCueSubscriptions` and waited 30 s for a
		// response, but no renderer handler existed. Every `maestro-cli cue
		// list` call timed out. Now it must call the injected graph-data
		// dependency directly and flatten the result.
		it('flattens engine graph data into CueSubscriptionInfo[] without any IPC bounce', async () => {
			const getCueGraphData = vi.fn().mockReturnValue([
				{
					sessionId: 'agent-1',
					sessionName: 'Obsidian Digest',
					toolType: 'claude-code',
					subscriptions: [
						{
							name: 'Digest Script',
							event: 'time.scheduled',
							enabled: true,
							prompt: '',
							schedule_times: ['07:00'],
							action: 'command',
							pipeline_name: 'Obsidian Daily Pipe',
						},
						{
							name: 'Obsidian Daily Pipe-chain-1',
							event: 'agent.completed',
							enabled: true,
							prompt: 'follow up',
							source_session: 'Obsidian Digest',
							source_sub: 'Digest Script',
							pipeline_name: 'Obsidian Daily Pipe',
						},
					],
				},
				{
					sessionId: 'agent-2',
					sessionName: 'Obsidian Git',
					toolType: 'claude-code',
					subscriptions: [
						{
							name: 'Git Script',
							event: 'time.scheduled',
							enabled: false,
							prompt: '',
							schedule_times: ['07:00'],
							action: 'command',
							pipeline_name: 'Obsidian Daily Pipe',
						},
					],
				},
			]);

			const createWebServer = createWebServerFactory({ ...deps, getCueGraphData });
			const server = createWebServer() as any;

			expect(server.setGetCueSubscriptionsCallback).toHaveBeenCalledTimes(1);
			const callback = server.setGetCueSubscriptionsCallback.mock.calls[0][0];

			const all = await callback();
			expect(getCueGraphData).toHaveBeenCalledTimes(1);
			expect(all).toHaveLength(3);
			expect(all[0]).toMatchObject({
				// `sessionId::pipeline::name` - the pipeline discriminator
				// prevents collisions when two pipelines in the same session
				// each define a sub with the same name.
				id: 'agent-1::Obsidian Daily Pipe::Digest Script',
				name: 'Digest Script',
				eventType: 'time.scheduled',
				sessionId: 'agent-1',
				sessionName: 'Obsidian Digest',
				enabled: true,
				schedule: '07:00',
				triggerCount: 0,
			});
			expect(all[2]).toMatchObject({
				id: 'agent-2::Obsidian Daily Pipe::Git Script',
				name: 'Git Script',
				sessionId: 'agent-2',
				enabled: false,
			});
		});

		it('disambiguates ids when two pipelines in the same session share a sub name', async () => {
			// CodeRabbit #983 (major): without the pipeline discriminator,
			// both rows would emit id `agent-1::Foo` and a downstream toggle
			// would mutate the wrong subscription. Lock in distinct ids.
			const getCueGraphData = vi.fn().mockReturnValue([
				{
					sessionId: 'agent-1',
					sessionName: 'Worker',
					toolType: 'claude-code',
					subscriptions: [
						{
							name: 'Foo',
							event: 'time.heartbeat',
							enabled: true,
							prompt: '',
							interval_minutes: 5,
							pipeline_name: 'Pipeline A',
						},
						{
							name: 'Foo',
							event: 'time.heartbeat',
							enabled: true,
							prompt: '',
							interval_minutes: 5,
							pipeline_name: 'Pipeline B',
						},
					],
				},
			]);
			const createWebServer = createWebServerFactory({ ...deps, getCueGraphData });
			const server = createWebServer() as any;
			const callback = server.setGetCueSubscriptionsCallback.mock.calls[0][0];
			const all = await callback();
			expect(all).toHaveLength(2);
			expect(all[0].id).toBe('agent-1::Pipeline A::Foo');
			expect(all[1].id).toBe('agent-1::Pipeline B::Foo');
			expect(new Set(all.map((s: { id: string }) => s.id)).size).toBe(2);
		});

		it('falls back to the -chain-N stripped base name when pipeline_name is absent (legacy YAML)', async () => {
			const getCueGraphData = vi.fn().mockReturnValue([
				{
					sessionId: 'agent-1',
					sessionName: 'Worker',
					toolType: 'claude-code',
					subscriptions: [
						{
							name: 'LegacyPipe-chain-2',
							event: 'agent.completed',
							enabled: true,
							prompt: '',
							source_session: 'Worker',
						},
					],
				},
			]);
			const createWebServer = createWebServerFactory({ ...deps, getCueGraphData });
			const server = createWebServer() as any;
			const callback = server.setGetCueSubscriptionsCallback.mock.calls[0][0];
			const [entry] = await callback();
			expect(entry.id).toBe('agent-1::LegacyPipe::LegacyPipe-chain-2');
		});

		it('renders schedule_days alongside schedule_times in the CLI schedule string', async () => {
			// Greptile #982 + Pedram: previously `schedule_days` was silently
			// dropped from the flattened output, so day-pinned schedules
			// looked indistinguishable from every-day schedules in `cue list`.
			const getCueGraphData = vi.fn().mockReturnValue([
				{
					sessionId: 'agent-1',
					sessionName: 'Worker',
					toolType: 'claude-code',
					subscriptions: [
						{
							name: 'WeekdayMorning',
							event: 'time.scheduled',
							enabled: true,
							prompt: '',
							schedule_times: ['07:00'],
							schedule_days: ['mon', 'wed', 'fri'],
							pipeline_name: 'Sched',
						},
						{
							name: 'DaysOnly',
							event: 'time.scheduled',
							enabled: true,
							prompt: '',
							schedule_days: ['sat', 'sun'],
							pipeline_name: 'Sched',
						},
					],
				},
			]);
			const createWebServer = createWebServerFactory({ ...deps, getCueGraphData });
			const server = createWebServer() as any;
			const callback = server.setGetCueSubscriptionsCallback.mock.calls[0][0];
			const all = await callback();
			expect(all[0].schedule).toBe('07:00 (Mon, Wed, Fri)');
			expect(all[1].schedule).toBe('days: Sat, Sun');
		});

		it('filters by sessionId when one is supplied', async () => {
			const getCueGraphData = vi.fn().mockReturnValue([
				{
					sessionId: 'agent-1',
					sessionName: 'Obsidian Digest',
					toolType: 'claude-code',
					subscriptions: [
						{
							name: 'Digest Script',
							event: 'time.scheduled',
							enabled: true,
							prompt: '',
							schedule_times: ['07:00'],
						},
					],
				},
				{
					sessionId: 'agent-2',
					sessionName: 'Obsidian Git',
					toolType: 'claude-code',
					subscriptions: [
						{
							name: 'Git Script',
							event: 'time.scheduled',
							enabled: true,
							prompt: '',
							schedule_times: ['07:00'],
						},
					],
				},
			]);

			const createWebServer = createWebServerFactory({ ...deps, getCueGraphData });
			const server = createWebServer() as any;
			const callback = server.setGetCueSubscriptionsCallback.mock.calls[0][0];

			const filtered = await callback('agent-2');
			expect(filtered).toHaveLength(1);
			expect(filtered[0].sessionId).toBe('agent-2');
		});

		it('returns [] and warns when the engine dependency is missing', async () => {
			const createWebServer = createWebServerFactory({ ...deps, getCueGraphData: undefined });
			const server = createWebServer() as any;
			const callback = server.setGetCueSubscriptionsCallback.mock.calls[0][0];

			const result = await callback();
			expect(result).toEqual([]);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('getCueGraphData dependency not available'),
				'WebServer'
			);
		});
	});

	describe('Cue toggle callback', () => {
		// Regression: previously this callback forwarded the request to the
		// renderer via `remote:toggleCueSubscription` and waited 10 s for a
		// response, but no renderer handler existed. Every web-UI toggle
		// silently no-op'd. Now it must call the injected dep directly.
		// Subscription ids follow `${sessionId}::${pipeline}::${name}` so
		// two pipelines under one session that share a sub name don't
		// collide (CodeRabbit #983 major).
		it('delegates straight to setCueSubscriptionEnabled without any IPC bounce', async () => {
			const setCueSubscriptionEnabled = vi.fn().mockResolvedValue(true);
			const createWebServer = createWebServerFactory({ ...deps, setCueSubscriptionEnabled });
			const server = createWebServer() as any;

			expect(server.setToggleCueSubscriptionCallback).toHaveBeenCalledTimes(1);
			const callback = server.setToggleCueSubscriptionCallback.mock.calls[0][0];

			const ok = await callback('agent-1::Obsidian Daily Pipe::Digest Script', false);
			expect(setCueSubscriptionEnabled).toHaveBeenCalledWith(
				'agent-1::Obsidian Daily Pipe::Digest Script',
				false
			);
			expect(ok).toBe(true);
		});

		it('propagates a false return when the engine cannot find the subscription', async () => {
			const setCueSubscriptionEnabled = vi.fn().mockResolvedValue(false);
			const createWebServer = createWebServerFactory({ ...deps, setCueSubscriptionEnabled });
			const server = createWebServer() as any;
			const callback = server.setToggleCueSubscriptionCallback.mock.calls[0][0];

			const ok = await callback('agent-1::P::Missing', true);
			expect(ok).toBe(false);
		});

		it('returns false and warns when the dep is missing', async () => {
			const createWebServer = createWebServerFactory({
				...deps,
				setCueSubscriptionEnabled: undefined,
			});
			const server = createWebServer() as any;
			const callback = server.setToggleCueSubscriptionCallback.mock.calls[0][0];

			const ok = await callback('agent-1::P::Digest Script', false);
			expect(ok).toBe(false);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('setCueSubscriptionEnabled dependency not available'),
				'WebServer'
			);
		});
	});

	describe('Cue activity callback', () => {
		// Same dead-bridge fix as the subscriptions callback: previously this
		// forwarded `remote:getCueActivity` to the renderer with no listener,
		// so the web UI activity tab always rendered empty after a 30 s stall.
		const sampleRun = {
			runId: 'run-1',
			sessionId: 'agent-1',
			sessionName: 'Obsidian Digest',
			subscriptionName: 'Digest Script',
			pipelineName: 'Obsidian Daily Pipe',
			event: { type: 'time.scheduled' } as any,
			status: 'completed' as const,
			stdout: 'all good',
			stderr: '',
			exitCode: 0,
			durationMs: 1234,
			startedAt: '2026-05-11T07:00:00.000Z',
			endedAt: '2026-05-11T07:00:01.234Z',
		};

		it('maps engine CueRunResult[] into CueActivityEntry[] without IPC', async () => {
			const getCueActivityLog = vi.fn().mockReturnValue([sampleRun]);
			const createWebServer = createWebServerFactory({ ...deps, getCueActivityLog });
			const server = createWebServer() as any;

			expect(server.setGetCueActivityCallback).toHaveBeenCalledTimes(1);
			const callback = server.setGetCueActivityCallback.mock.calls[0][0];

			const entries = await callback();
			expect(getCueActivityLog).toHaveBeenCalledTimes(1);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				id: 'run-1',
				// Same identity contract as the subscriptions list, so a
				// web UI could navigate from an activity row to the toggle
				// callback without re-deriving the id.
				subscriptionId: 'agent-1::Obsidian Daily Pipe::Digest Script',
				subscriptionName: 'Digest Script',
				eventType: 'time.scheduled',
				sessionId: 'agent-1',
				status: 'completed',
				duration: 1234,
				result: 'all good',
			});
			expect(entries[0].timestamp).toBe(Date.parse('2026-05-11T07:00:00.000Z'));
		});

		it('falls back to base-name stripping for the subscriptionId when pipelineName is absent', async () => {
			const getCueActivityLog = vi.fn().mockReturnValue([
				{
					...sampleRun,
					pipelineName: undefined,
					subscriptionName: 'LegacyPipe-chain-2',
				},
			]);
			const createWebServer = createWebServerFactory({ ...deps, getCueActivityLog });
			const server = createWebServer() as any;
			const callback = server.setGetCueActivityCallback.mock.calls[0][0];

			const [entry] = await callback();
			expect(entry.subscriptionId).toBe('agent-1::LegacyPipe::LegacyPipe-chain-2');
		});

		it('filters by sessionId before applying limit', async () => {
			const getCueActivityLog = vi.fn().mockReturnValue([
				{ ...sampleRun, runId: 'run-a', sessionId: 'agent-1' },
				{ ...sampleRun, runId: 'run-b', sessionId: 'agent-2' },
				{ ...sampleRun, runId: 'run-c', sessionId: 'agent-1' },
			]);
			const createWebServer = createWebServerFactory({ ...deps, getCueActivityLog });
			const server = createWebServer() as any;
			const callback = server.setGetCueActivityCallback.mock.calls[0][0];

			const filtered = await callback('agent-1', 1);
			expect(filtered).toHaveLength(1);
			expect(filtered[0].id).toBe('run-a');
		});

		it('collapses timeout / stopped engine statuses into the web "failed" enum', async () => {
			const getCueActivityLog = vi.fn().mockReturnValue([
				{ ...sampleRun, runId: 'r1', status: 'timeout', stderr: 'took too long' },
				{ ...sampleRun, runId: 'r2', status: 'stopped', stderr: 'user kill' },
				{ ...sampleRun, runId: 'r3', status: 'failed', stderr: 'oops' },
			]);
			const createWebServer = createWebServerFactory({ ...deps, getCueActivityLog });
			const server = createWebServer() as any;
			const callback = server.setGetCueActivityCallback.mock.calls[0][0];

			const entries = await callback();
			expect(entries.map((e: any) => e.status)).toEqual(['failed', 'failed', 'failed']);
			// stderr should surface as `result` for non-completed runs so the
			// dashboard can show why it failed without re-fetching stdout.
			expect(entries[0].result).toBe('took too long');
		});

		it('returns [] and warns when the dep is missing', async () => {
			const createWebServer = createWebServerFactory({
				...deps,
				getCueActivityLog: undefined,
			});
			const server = createWebServer() as any;
			const callback = server.setGetCueActivityCallback.mock.calls[0][0];

			const entries = await callback();
			expect(entries).toEqual([]);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('getCueActivityLog dependency not available'),
				'WebServer'
			);
		});
	});
});
