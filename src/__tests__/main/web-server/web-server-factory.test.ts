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
			// Auto Run parity additions — task reset, error recovery, playbook CRUD.
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
			broadcastSettingsChanged = vi.fn();

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

// Mock Sentry — captureException is called from the import callback's
// failure branch.
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../../main/utils/remote-git', () => ({
	execGit: vi.fn(),
}));

vi.mock('../../../main/stores', () => ({
	getSshRemoteById: vi.fn(),
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
import { execGit } from '../../../main/utils/remote-git';
import { getSshRemoteById } from '../../../main/stores';

describe('web-server/web-server-factory', () => {
	let mockSettingsStore: WebServerFactoryDependencies['settingsStore'];
	let mockSessionsStore: WebServerFactoryDependencies['sessionsStore'];
	let mockGroupsStore: WebServerFactoryDependencies['groupsStore'];
	let mockMainWindow: Partial<BrowserWindow>;
	let mockWebContents: Partial<WebContents>;
	let mockProcessManager: {
		write: ReturnType<typeof vi.fn>;
		resize: ReturnType<typeof vi.fn>;
		get: ReturnType<typeof vi.fn>;
		spawnTerminalTab: ReturnType<typeof vi.fn>;
		kill: ReturnType<typeof vi.fn>;
	};
	let deps: WebServerFactoryDependencies;

	beforeEach(() => {
		vi.clearAllMocks();

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
			resize: vi.fn().mockReturnValue(true),
			get: vi.fn().mockReturnValue(null),
			spawnTerminalTab: vi.fn().mockResolvedValue({ success: true, pid: 1234 }),
			kill: vi.fn().mockReturnValue(true),
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

	describe('listDesktopSessionsCallback behavior', () => {
		it('flattens open AI tabs into CLI-addressable desktop session entries', () => {
			vi.mocked(mockSessionsStore.get).mockReturnValue([
				{
					id: 'agent-1',
					name: 'Agent One',
					toolType: 'codex',
					aiTabs: [
						{
							id: 'tab-busy',
							name: 'Busy Tab',
							agentSessionId: 'provider-1',
							state: 'busy',
							createdAt: 123,
							starred: true,
						},
						{ id: 'tab-idle', state: 'idle' },
						null,
						{ id: 123 },
					],
				},
			] as any);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const callback = (server.setListDesktopSessionsCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			expect(callback()).toEqual([
				{
					tabId: 'tab-busy',
					sessionId: 'tab-busy',
					agentId: 'agent-1',
					agentName: 'Agent One',
					toolType: 'codex',
					name: 'Busy Tab',
					agentSessionId: 'provider-1',
					state: 'busy',
					createdAt: 123,
					starred: true,
				},
				{
					tabId: 'tab-idle',
					sessionId: 'tab-idle',
					agentId: 'agent-1',
					agentName: 'Agent One',
					toolType: 'codex',
					name: null,
					agentSessionId: null,
					state: 'idle',
					createdAt: 0,
					starred: false,
				},
			]);
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

		it('maps non-chat log sources to CLI roles and stable fallback ids', () => {
			vi.mocked(mockSessionsStore.get).mockReturnValue(
				stockSession([
					{ source: 'thinking', text: 'plan', timestamp: 100 },
					{ source: 'tool', text: 'tool output', timestamp: 200 },
					{ source: 'system', text: 'system note', timestamp: 300 },
					{ source: 'stderr', text: 'stderr output', timestamp: 400 },
					{ source: 'custom', text: 123, timestamp: 'bad' },
				])
			);

			const callback = getCallback();
			const result = callback('tab-1');

			expect(result.messages.map((m: { role: string }) => m.role)).toEqual([
				'thinking',
				'tool',
				'system',
				'error',
				'unknown',
			]);
			expect(result.messages[0].id).toBe('tab-1-100');
			expect(result.messages[4]).toEqual(
				expect.objectContaining({
					id: 'tab-1-0',
					content: '',
					source: 'custom',
					timestamp: new Date(0).toISOString(),
				})
			);
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

	describe('terminal callback behavior', () => {
		it('writes and resizes the dedicated web terminal process', () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const writeCallback = (server.setWriteToTerminalCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const resizeCallback = (server.setResizeTerminalCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			expect(writeCallback('session-1', 'ls\n')).toBe(true);
			expect(resizeCallback('session-1', 120, 40)).toBe(true);
			expect(mockProcessManager.write).toHaveBeenCalledWith('session-1-terminal', 'ls\n');
			expect(mockProcessManager.resize).toHaveBeenCalledWith('session-1-terminal', 120, 40);
		});

		it('returns false when terminal callbacks have no process manager', () => {
			deps.getProcessManager = vi.fn().mockReturnValue(null);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const writeCallback = (server.setWriteToTerminalCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const resizeCallback = (server.setResizeTerminalCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const spawnCallback = (server.setSpawnTerminalForWebCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const killCallback = (server.setKillTerminalForWebCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			expect(writeCallback('session-1', 'x')).toBe(false);
			expect(resizeCallback('session-1', 80, 24)).toBe(false);
			expect(killCallback('session-1')).toBe(false);
			return expect(spawnCallback('session-1', { cwd: '/tmp' })).resolves.toEqual({
				success: false,
				pid: 0,
			});
		});

		it('spawns a web terminal with configured shell settings', async () => {
			vi.mocked(mockSettingsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'customShellPath') return '/bin/zsh';
				if (key === 'shellArgs') return '-l';
				if (key === 'shellEnvVars') return { TERM: 'xterm-256color' };
				return defaultValue;
			});
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const spawnCallback = (server.setSpawnTerminalForWebCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const result = await spawnCallback('session-1', { cwd: '/workspace', cols: 100, rows: 30 });

			expect(result).toEqual({ success: true, pid: 1234 });
			expect(mockProcessManager.spawnTerminalTab).toHaveBeenCalledWith({
				sessionId: 'session-1-terminal',
				cwd: '/workspace',
				shell: '/bin/zsh',
				shellArgs: '-l',
				shellEnvVars: { TERM: 'xterm-256color' },
				cols: 100,
				rows: 30,
			});
		});

		it('does not spawn a duplicate web terminal and treats missing terminal as already killed', async () => {
			mockProcessManager.get.mockReturnValueOnce({ pid: 99 }).mockReturnValueOnce(null);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const spawnCallback = (server.setSpawnTerminalForWebCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const killCallback = (server.setKillTerminalForWebCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			await expect(spawnCallback('session-1', { cwd: '/workspace' })).resolves.toEqual({
				success: true,
				pid: 0,
			});
			expect(killCallback('session-1')).toBe(true);
			expect(mockProcessManager.spawnTerminalTab).not.toHaveBeenCalled();
			expect(mockProcessManager.kill).not.toHaveBeenCalled();
		});

		it('kills an existing web terminal process', () => {
			mockProcessManager.get.mockReturnValue({ pid: 99 });
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const killCallback = (server.setKillTerminalForWebCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			expect(killCallback('session-1')).toBe(true);
			expect(mockProcessManager.kill).toHaveBeenCalledWith('session-1-terminal');
		});
	});

	describe('web tab request-response callback behavior', () => {
		const finishLastIpcOnce = (result: unknown) => {
			const [channel, handler] = vi.mocked(ipcMain.once).mock.calls.at(-1) ?? [];
			expect(channel).toEqual(expect.stringContaining('remote:'));
			(handler as (event: unknown, result: unknown) => void)({}, result);
			return channel;
		};

		const getRegisteredCallback = (server: any, setterName: string) => {
			return (server[setterName] as ReturnType<typeof vi.fn>).mock.calls[0][0];
		};

		it('opens a browser tab after renderer acknowledgement', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = (server.setOpenBrowserTabCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			const pending = callback('session-1', 'https://example.com');
			const channel = finishLastIpcOnce(true);

			await expect(pending).resolves.toBe(true);
			expect(mockWebContents.send).toHaveBeenCalledWith(
				'remote:openBrowserTab',
				'session-1',
				'https://example.com',
				channel
			);
		});

		it('opens a terminal tab after renderer acknowledgement', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = (server.setOpenTerminalTabCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const config = { cwd: '/repo', shell: '/bin/bash', name: 'server' };

			const pending = callback('session-1', config);
			const channel = finishLastIpcOnce(true);

			await expect(pending).resolves.toBe(true);
			expect(mockWebContents.send).toHaveBeenCalledWith(
				'remote:openTerminalTab',
				'session-1',
				config,
				channel
			);
		});

		it('returns new AI tab metadata from renderer acknowledgement objects', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = (server.setNewAITabWithPromptCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			const pending = callback('session-1', 'summarize');
			let channel = finishLastIpcOnce({ success: true, tabId: 'tab-new' });

			await expect(pending).resolves.toEqual({ success: true, tabId: 'tab-new' });
			expect(mockWebContents.send).toHaveBeenCalledWith(
				'remote:newAITabWithPrompt',
				'session-1',
				'summarize',
				channel
			);

			const legacyPending = callback('session-1', 'legacy');
			channel = finishLastIpcOnce(true);
			await expect(legacyPending).resolves.toEqual({ success: true });
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:newAITabWithPrompt',
				'session-1',
				'legacy',
				channel
			);
		});

		it('times out tab request-response callbacks and ignores duplicate acknowledgements', async () => {
			vi.useFakeTimers();
			try {
				const createWebServer = createWebServerFactory(deps);
				const server = createWebServer();
				const openBrowserTab = getRegisteredCallback(server, 'setOpenBrowserTabCallback');
				const openTerminalTab = getRegisteredCallback(server, 'setOpenTerminalTabCallback');
				const newAITabWithPrompt = getRegisteredCallback(server, 'setNewAITabWithPromptCallback');

				const acknowledged = openBrowserTab('session-1', 'https://example.com');
				const [, acknowledgeBrowser] = vi.mocked(ipcMain.once).mock.calls.at(-1) ?? [];
				(acknowledgeBrowser as (event: unknown, result: unknown) => void)({}, true);
				(acknowledgeBrowser as (event: unknown, result: unknown) => void)({}, false);
				await expect(acknowledged).resolves.toBe(true);

				let pending = openBrowserTab('session-1', 'https://timeout.example');
				let [channel, handler] = vi.mocked(ipcMain.once).mock.calls.at(-1) ?? [];
				vi.advanceTimersByTime(5000);
				await expect(pending).resolves.toBe(false);
				expect(ipcMain.removeListener).toHaveBeenCalledWith(channel, handler);

				pending = openTerminalTab('session-1', { cwd: '/repo' });
				[channel, handler] = vi.mocked(ipcMain.once).mock.calls.at(-1) ?? [];
				vi.advanceTimersByTime(5000);
				await expect(pending).resolves.toBe(false);
				expect(ipcMain.removeListener).toHaveBeenCalledWith(channel, handler);

				const aiPending = newAITabWithPrompt('session-1', 'prompt');
				[channel, handler] = vi.mocked(ipcMain.once).mock.calls.at(-1) ?? [];
				vi.advanceTimersByTime(5000);
				await expect(aiPending).resolves.toEqual({ success: false });
				expect(ipcMain.removeListener).toHaveBeenCalledWith(channel, handler);
			} finally {
				vi.useRealTimers();
			}
		});

		it('times out renderer request-response callback groups with documented fallbacks', async () => {
			vi.useFakeTimers();
			try {
				const createWebServer = createWebServerFactory(deps);
				const server = createWebServer();
				const expectTimeout = async (
					setterName: string,
					invoke: (callback: any) => Promise<unknown>,
					expected: unknown
				) => {
					const callback = getRegisteredCallback(server, setterName);
					const pending = invoke(callback);
					const [channel, handler] = vi.mocked(ipcMain.once).mock.calls.at(-1) ?? [];

					vi.runOnlyPendingTimers();

					await expect(pending).resolves.toEqual(expected);
					expect(ipcMain.removeListener).toHaveBeenCalledWith(channel, handler);
				};

				await expectTimeout(
					'setConfigureAutoRunCallback',
					(callback) => callback('session-1', { enabled: true }),
					{ success: false, error: 'Timeout' }
				);
				await expectTimeout(
					'setSessionAutoRunFolderCallback',
					(callback) => callback('session-1', '/repo/.maestro'),
					{ success: false, error: 'Timeout' }
				);
				await expectTimeout('setGetAutoRunDocsCallback', (callback) => callback('session-1'), []);
				await expectTimeout(
					'setGetAutoRunDocContentCallback',
					(callback) => callback('session-1', 'plan.md'),
					''
				);
				await expectTimeout(
					'setSaveAutoRunDocCallback',
					(callback) => callback('session-1', 'plan.md', 'body'),
					false
				);
				await expectTimeout('setSetSettingCallback', (callback) => callback('fontSize', 16), false);
				await expectTimeout(
					'setCreateSessionCallback',
					(callback) => callback('New Agent', 'codex', '/repo'),
					null
				);
				await expectTimeout(
					'setCreateWorktreeSessionCallback',
					(callback) => callback('session-1', { branchName: 'feature/x' }),
					{ success: false, error: 'Timeout' }
				);
				await expectTimeout(
					'setRenameSessionCallback',
					(callback) => callback('session-1', 'Renamed'),
					false
				);
				await expectTimeout(
					'setUpdateSessionCwdCallback',
					(callback) => callback('session-1', '/repo2'),
					{ success: false, error: 'Renderer did not respond in time' }
				);
				await expectTimeout(
					'setUpdateSessionSshCallback',
					(callback) => callback('session-1', { enabled: true }),
					{ success: false, error: 'Renderer did not respond in time' }
				);
				await expectTimeout('setCreateGroupCallback', (callback) => callback('Group', 'G'), null);
				await expectTimeout(
					'setRenameGroupCallback',
					(callback) => callback('group-1', 'Renamed'),
					false
				);
				await expectTimeout(
					'setMoveSessionToGroupCallback',
					(callback) => callback('session-1', null),
					false
				);
				await expectTimeout('setGetGitStatusCallback', (callback) => callback('session-1'), {
					branch: '',
					files: [],
					ahead: 0,
					behind: 0,
				});
				await expectTimeout('setGetGitDiffCallback', (callback) => callback('session-1', 'a.ts'), {
					diff: '',
					files: [],
				});
				await expectTimeout(
					'setResetAutoRunDocTasksCallback',
					(callback) => callback('session-1', 'plan.md'),
					false
				);
				await expectTimeout('setGetGroupChatsCallback', (callback) => callback(), []);
				await expectTimeout(
					'setStartGroupChatCallback',
					(callback) => callback('topic', ['session-1']),
					null
				);
				await expectTimeout('setGetGroupChatStateCallback', (callback) => callback('chat-1'), null);
				await expectTimeout('setStopGroupChatCallback', (callback) => callback('chat-1'), false);
				await expectTimeout(
					'setSendGroupChatMessageCallback',
					(callback) => callback('chat-1', 'hello'),
					false
				);
				await expectTimeout(
					'setMergeContextCallback',
					(callback) => callback('source', 'target'),
					false
				);
				await expectTimeout(
					'setTransferContextCallback',
					(callback) => callback('source', 'target'),
					false
				);
				await expectTimeout(
					'setSummarizeContextCallback',
					(callback) => callback('session-1'),
					false
				);
				await expectTimeout(
					'setCreateGistCallback',
					(callback) => callback('session-1', 'desc', true),
					{ success: false, error: 'Timed out waiting for gist creation' }
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it('removes response listeners and returns false when web contents are unavailable', async () => {
			vi.mocked(mockWebContents.isDestroyed!).mockReturnValue(true);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = (server.setOpenBrowserTabCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			await expect(callback('session-1', 'https://example.com')).resolves.toBe(false);
			expect(ipcMain.removeListener).toHaveBeenCalledWith(
				expect.stringContaining('remote:openBrowserTab:response:'),
				expect.any(Function)
			);
		});

		it('bridges Auto Run document callbacks through renderer request-response IPC', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const configure = (server.setConfigureAutoRunCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const setFolder = (server.setSessionAutoRunFolderCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const listDocs = (server.setGetAutoRunDocsCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const readDoc = (server.setGetAutoRunDocContentCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const saveDoc = (server.setSaveAutoRunDocCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			const configurePending = configure('session-1', { enabled: true });
			let channel = finishLastIpcOnce({ success: true });
			await expect(configurePending).resolves.toEqual({ success: true });
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:configureAutoRun',
				'session-1',
				{ enabled: true },
				channel
			);

			const folderPending = setFolder('session-1', '/repo/.maestro');
			channel = finishLastIpcOnce(undefined);
			await expect(folderPending).resolves.toEqual({ success: false, error: 'No response' });
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:setAutoRunFolder',
				'session-1',
				'/repo/.maestro',
				channel
			);

			const docsPending = listDocs('session-1');
			channel = finishLastIpcOnce([{ filename: 'plan.md' }]);
			await expect(docsPending).resolves.toEqual([{ filename: 'plan.md' }]);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:getAutoRunDocs',
				'session-1',
				channel
			);

			const readPending = readDoc('session-1', 'plan.md');
			channel = finishLastIpcOnce('body');
			await expect(readPending).resolves.toBe('body');
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:getAutoRunDocContent',
				'session-1',
				'plan.md',
				channel
			);

			const savePending = saveDoc('session-1', 'plan.md', 'next');
			channel = finishLastIpcOnce(true);
			await expect(savePending).resolves.toBe(true);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:saveAutoRunDoc',
				'session-1',
				'plan.md',
				'next',
				channel
			);
		});

		it('sends fire-and-forget Auto Run refresh when renderer is available', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = (server.setRefreshAutoRunDocsCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			await expect(callback('session-1')).resolves.toBe(true);

			expect(mockWebContents.send).toHaveBeenCalledWith('remote:refreshAutoRunDocs', 'session-1');
		});

		it('returns empty Auto Run document content when renderer sends nullish content', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = (server.setGetAutoRunDocContentCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			const pending = callback('session-1', 'missing.md');
			finishLastIpcOnce(null);

			await expect(pending).resolves.toBe('');
		});

		it('updates settings through renderer IPC and broadcasts the refreshed snapshot', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const getSettings = (server.setGetSettingsCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const setSetting = (server.setSetSettingCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			expect(getSettings()).toEqual(
				expect.objectContaining({
					theme: 'dracula',
					fontSize: 14,
					defaultSaveToHistory: true,
				})
			);

			const pending = setSetting('fontSize', 16);
			const channel = finishLastIpcOnce(true);

			await expect(pending).resolves.toBe(true);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:setSetting',
				'fontSize',
				16,
				channel
			);
			expect((server as any).broadcastSettingsChanged).toHaveBeenCalledWith(
				expect.objectContaining({
					theme: 'dracula',
					fontSize: 14,
				})
			);
		});

		it('bridges session mutation callbacks through renderer IPC', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const createSession = (server.setCreateSessionCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const createWorktree = (server.setCreateWorktreeSessionCallback as ReturnType<typeof vi.fn>)
				.mock.calls[0][0];
			const renameSession = (server.setRenameSessionCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const updateCwd = (server.setUpdateSessionCwdCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const updateSsh = (server.setUpdateSessionSshCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const deleteSession = (server.setDeleteSessionCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			let pending = createSession('New Agent', 'codex', '/repo', 'group-1', { priority: 'high' });
			let channel = finishLastIpcOnce('session-new');
			await expect(pending).resolves.toBe('session-new');
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:createSession',
				'New Agent',
				'codex',
				'/repo',
				'group-1',
				{ priority: 'high' },
				channel
			);

			pending = createWorktree('session-1', { branch: 'feature/test' });
			channel = finishLastIpcOnce({ success: true, sessionId: 'worktree-1' });
			await expect(pending).resolves.toEqual({ success: true, sessionId: 'worktree-1' });
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:createWorktreeSession',
				'session-1',
				{ branch: 'feature/test' },
				channel
			);

			pending = renameSession('session-1', 'Renamed');
			channel = finishLastIpcOnce(false);
			await expect(pending).resolves.toBe(false);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:renameSession',
				'session-1',
				'Renamed',
				channel
			);

			pending = updateCwd('session-1', '/new/repo');
			channel = finishLastIpcOnce({ success: true });
			await expect(pending).resolves.toEqual({ success: true, error: undefined });
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:updateSessionCwd',
				'session-1',
				'/new/repo',
				channel
			);

			pending = updateSsh('session-1', { enabled: true, remoteId: 'remote-1' });
			channel = finishLastIpcOnce({ success: false, error: 'busy' });
			await expect(pending).resolves.toEqual({ success: false, error: 'busy' });
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:updateSessionSsh',
				'session-1',
				{ enabled: true, remoteId: 'remote-1' },
				channel
			);

			await expect(deleteSession('session-1')).resolves.toBe(true);
			expect(mockWebContents.send).toHaveBeenLastCalledWith('remote:deleteSession', 'session-1');
		});

		it('maps groups with member session ids directly from stores', () => {
			vi.mocked(mockSessionsStore.get).mockReturnValue([
				{ id: 'session-1', groupId: 'group-1' },
				{ id: 'session-2', groupId: 'group-1' },
				{ id: 'session-3', groupId: 'group-2' },
			] as any);
			vi.mocked(mockGroupsStore.get).mockReturnValue([
				{ id: 'group-1', name: 'Alpha', emoji: 'A' },
				{ id: 'group-2', name: 'Beta' },
			] as any);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = (server.setGetGroupsCallback as ReturnType<typeof vi.fn>).mock.calls[0][0];

			expect(callback()).toEqual([
				{ id: 'group-1', name: 'Alpha', emoji: 'A', sessionIds: ['session-1', 'session-2'] },
				{ id: 'group-2', name: 'Beta', emoji: null, sessionIds: ['session-3'] },
			]);
		});

		it('bridges group mutation callbacks through renderer IPC', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const createGroup = (server.setCreateGroupCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const renameGroup = (server.setRenameGroupCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const deleteGroup = (server.setDeleteGroupCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const moveSession = (server.setMoveSessionToGroupCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			let pending = createGroup('New Group', 'N');
			let channel = finishLastIpcOnce({ id: 'group-new' });
			await expect(pending).resolves.toEqual({ id: 'group-new' });
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:createGroup',
				'New Group',
				'N',
				channel
			);

			pending = renameGroup('group-1', 'Renamed');
			channel = finishLastIpcOnce(true);
			await expect(pending).resolves.toBe(true);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:renameGroup',
				'group-1',
				'Renamed',
				channel
			);

			pending = moveSession('session-1', null);
			channel = finishLastIpcOnce(false);
			await expect(pending).resolves.toBe(false);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:moveSessionToGroup',
				'session-1',
				null,
				channel
			);

			await expect(deleteGroup('group-1')).resolves.toBe(true);
			expect(mockWebContents.send).toHaveBeenLastCalledWith('remote:deleteGroup', 'group-1');
		});

		it('bridges git status and diff callbacks through renderer IPC', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const getGitStatus = (server.setGetGitStatusCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const getGitDiff = (server.setGetGitDiffCallback as ReturnType<typeof vi.fn>).mock
				.calls[0][0];

			let pending = getGitStatus('session-1');
			let channel = finishLastIpcOnce({ branch: 'main', files: [{ path: 'a.ts' }] });
			await expect(pending).resolves.toEqual({ branch: 'main', files: [{ path: 'a.ts' }] });
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:getGitStatus',
				'session-1',
				channel
			);

			pending = getGitDiff('session-1', 'a.ts');
			channel = finishLastIpcOnce(undefined);
			await expect(pending).resolves.toEqual({ diff: '', files: [] });
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:getGitDiff',
				'session-1',
				'a.ts',
				channel
			);
		});

		it('bridges Auto Run recovery and playbook callbacks through renderer IPC', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const playbook = { id: 'pb-1', name: 'Run checks' };

			let pending = getRegisteredCallback(server, 'setResetAutoRunDocTasksCallback')(
				'session-1',
				'plan.md'
			);
			let channel = finishLastIpcOnce(true);
			await expect(pending).resolves.toBe(true);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:resetAutoRunDocTasks',
				'session-1',
				'plan.md',
				channel
			);

			pending = getRegisteredCallback(server, 'setResumeAutoRunErrorCallback')('session-1');
			channel = finishLastIpcOnce(undefined);
			await expect(pending).resolves.toBe(false);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:resumeAutoRunError',
				'session-1',
				channel
			);

			pending = getRegisteredCallback(server, 'setSkipAutoRunDocumentCallback')('session-1');
			channel = finishLastIpcOnce(false);
			await expect(pending).resolves.toBe(false);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:skipAutoRunDocument',
				'session-1',
				channel
			);

			pending = getRegisteredCallback(server, 'setAbortAutoRunErrorCallback')('session-1');
			channel = finishLastIpcOnce(true);
			await expect(pending).resolves.toBe(true);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:abortAutoRunError',
				'session-1',
				channel
			);

			pending = getRegisteredCallback(server, 'setListPlaybooksCallback')('session-1');
			channel = finishLastIpcOnce([playbook]);
			await expect(pending).resolves.toEqual([playbook]);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:listPlaybooks',
				'session-1',
				channel
			);

			pending = getRegisteredCallback(server, 'setCreatePlaybookCallback')('session-1', playbook);
			channel = finishLastIpcOnce(playbook);
			await expect(pending).resolves.toEqual(playbook);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:createPlaybook',
				'session-1',
				playbook,
				channel
			);

			pending = getRegisteredCallback(server, 'setUpdatePlaybookCallback')('session-1', 'pb-1', {
				name: 'Updated',
			});
			channel = finishLastIpcOnce(null);
			await expect(pending).resolves.toBeNull();
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:updatePlaybook',
				'session-1',
				'pb-1',
				{ name: 'Updated' },
				channel
			);

			pending = getRegisteredCallback(server, 'setDeletePlaybookCallback')('session-1', 'pb-1');
			channel = finishLastIpcOnce(true);
			await expect(pending).resolves.toBe(true);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:deletePlaybook',
				'session-1',
				'pb-1',
				channel
			);
		});

		it('bridges group chat, context, gist, usage, and achievement callbacks', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			let pending = getRegisteredCallback(server, 'setGetGroupChatsCallback')();
			let channel = finishLastIpcOnce([{ id: 'chat-1' }]);
			await expect(pending).resolves.toEqual([{ id: 'chat-1' }]);
			expect(mockWebContents.send).toHaveBeenLastCalledWith('remote:getGroupChats', channel);

			pending = getRegisteredCallback(server, 'setStartGroupChatCallback')('topic', ['session-1']);
			channel = finishLastIpcOnce({ id: 'chat-1' });
			await expect(pending).resolves.toEqual({ id: 'chat-1' });
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:startGroupChat',
				'topic',
				['session-1'],
				channel
			);

			pending = getRegisteredCallback(server, 'setGetGroupChatStateCallback')('chat-1');
			channel = finishLastIpcOnce({ id: 'chat-1', status: 'running' });
			await expect(pending).resolves.toEqual({ id: 'chat-1', status: 'running' });
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:getGroupChatState',
				'chat-1',
				channel
			);

			pending = getRegisteredCallback(server, 'setStopGroupChatCallback')('chat-1');
			channel = finishLastIpcOnce(true);
			await expect(pending).resolves.toBe(true);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:stopGroupChat',
				'chat-1',
				channel
			);

			pending = getRegisteredCallback(server, 'setSendGroupChatMessageCallback')('chat-1', 'hello');
			channel = finishLastIpcOnce(false);
			await expect(pending).resolves.toBe(false);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:sendGroupChatMessage',
				'chat-1',
				'hello',
				channel
			);

			pending = getRegisteredCallback(server, 'setMergeContextCallback')('source', 'target');
			channel = finishLastIpcOnce(true);
			await expect(pending).resolves.toBe(true);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:mergeContext',
				'source',
				'target',
				channel
			);

			pending = getRegisteredCallback(server, 'setTransferContextCallback')('source', 'target');
			channel = finishLastIpcOnce(true);
			await expect(pending).resolves.toBe(true);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:transferContext',
				'source',
				'target',
				channel
			);

			pending = getRegisteredCallback(server, 'setSummarizeContextCallback')('session-1');
			channel = finishLastIpcOnce(false);
			await expect(pending).resolves.toBe(false);
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:summarizeContext',
				'session-1',
				channel
			);

			pending = getRegisteredCallback(server, 'setCreateGistCallback')(
				'session-1',
				'summary',
				false
			);
			channel = finishLastIpcOnce({ success: true, gistUrl: 'https://gist.example/1' });
			await expect(pending).resolves.toEqual({
				success: true,
				gistUrl: 'https://gist.example/1',
			});
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:createGist',
				'session-1',
				'summary',
				false,
				channel
			);

			pending = getRegisteredCallback(server, 'setGetUsageDashboardCallback')('week');
			channel = finishLastIpcOnce({ totalTokensIn: 10, sessionBreakdown: [] });
			await expect(pending).resolves.toEqual({ totalTokensIn: 10, sessionBreakdown: [] });
			expect(mockWebContents.send).toHaveBeenLastCalledWith(
				'remote:getUsageDashboard',
				'week',
				channel
			);

			pending = getRegisteredCallback(server, 'setGetAchievementsCallback')();
			channel = finishLastIpcOnce([{ id: 'first-run' }]);
			await expect(pending).resolves.toEqual([{ id: 'first-run' }]);
			expect(mockWebContents.send).toHaveBeenLastCalledWith('remote:getAchievements', channel);
		});

		it('returns renderer-unavailable fallbacks for Auto Run and session mutation callbacks', async () => {
			vi.mocked(mockWebContents.isDestroyed!).mockReturnValue(true);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			await expect(
				(server.setConfigureAutoRunCallback as ReturnType<typeof vi.fn>).mock.calls[0][0](
					'session-1',
					{}
				)
			).resolves.toEqual({ success: false, error: 'Web contents not available' });
			await expect(
				(server.setSessionAutoRunFolderCallback as ReturnType<typeof vi.fn>).mock.calls[0][0](
					'session-1',
					'/repo'
				)
			).resolves.toEqual({ success: false, error: 'Web contents not available' });
			await expect(
				(server.setGetAutoRunDocsCallback as ReturnType<typeof vi.fn>).mock.calls[0][0]('session-1')
			).resolves.toEqual([]);
			await expect(
				(server.setSaveAutoRunDocCallback as ReturnType<typeof vi.fn>).mock.calls[0][0](
					'session-1',
					'plan.md',
					'body'
				)
			).resolves.toBe(false);
			await expect(
				(server.setSetSettingCallback as ReturnType<typeof vi.fn>).mock.calls[0][0]('fontSize', 16)
			).resolves.toBe(false);
			await expect(
				(server.setCreateSessionCallback as ReturnType<typeof vi.fn>).mock.calls[0][0](
					'New Agent',
					'codex',
					'/repo'
				)
			).resolves.toBeNull();
			await expect(
				(server.setCreateWorktreeSessionCallback as ReturnType<typeof vi.fn>).mock.calls[0][0](
					'session-1',
					{}
				)
			).resolves.toEqual({ success: false, error: 'Web contents not available' });
			await expect(
				(server.setUpdateSessionCwdCallback as ReturnType<typeof vi.fn>).mock.calls[0][0](
					'session-1',
					'/new'
				)
			).resolves.toEqual({ success: false, error: 'Desktop renderer unavailable' });
			await expect(
				(server.setUpdateSessionSshCallback as ReturnType<typeof vi.fn>).mock.calls[0][0](
					'session-1',
					{}
				)
			).resolves.toEqual({ success: false, error: 'Desktop renderer unavailable' });
			await expect(
				(server.setDeleteSessionCallback as ReturnType<typeof vi.fn>).mock.calls[0][0]('session-1')
			).resolves.toBe(false);
		});

		it('returns renderer-unavailable fallbacks for remaining callback groups', async () => {
			vi.mocked(mockWebContents.isDestroyed!).mockReturnValue(true);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			await expect(
				getRegisteredCallback(server, 'setStarTabCallback')('session-1', 'tab-1', true)
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setReorderTabCallback')('session-1', 0, 1)
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setToggleBookmarkCallback')('session-1')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setOpenFileTabCallback')('session-1', 'README.md', true)
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setRefreshFileTreeCallback')('session-1')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(
					server,
					'setNotifyToastCallback'
				)({
					title: 'Saved',
					message: 'Done',
				})
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(
					server,
					'setNotifyCenterFlashCallback'
				)({
					sessionId: 'session-1',
				})
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setOpenTerminalTabCallback')('session-1', { cwd: '/repo' })
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setNewAITabWithPromptCallback')('session-1', 'prompt')
			).resolves.toEqual({ success: false });
			await expect(
				getRegisteredCallback(server, 'setRefreshAutoRunDocsCallback')('session-1')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setGetAutoRunDocContentCallback')('session-1', 'plan.md')
			).resolves.toBe('');
			await expect(
				getRegisteredCallback(server, 'setRenameSessionCallback')('session-1', 'New')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setCreateGroupCallback')('Group', 'G')
			).resolves.toBeNull();
			await expect(
				getRegisteredCallback(server, 'setRenameGroupCallback')('group-1', 'Renamed')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setDeleteGroupCallback')('group-1')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setMoveSessionToGroupCallback')('session-1', 'group-1')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setGetGitStatusCallback')('session-1')
			).resolves.toEqual({ branch: '', files: [], ahead: 0, behind: 0 });
			await expect(
				getRegisteredCallback(server, 'setGetGitDiffCallback')('session-1', 'a.ts')
			).resolves.toEqual({ diff: '', files: [] });
			await expect(
				getRegisteredCallback(server, 'setStopAutoRunCallback')('session-1')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setResetAutoRunDocTasksCallback')('session-1', 'plan.md')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setCreatePlaybookCallback')('session-1', {})
			).resolves.toBeNull();
			await expect(getRegisteredCallback(server, 'setGetGroupChatsCallback')()).resolves.toEqual(
				[]
			);
			await expect(
				getRegisteredCallback(server, 'setStartGroupChatCallback')('topic', [])
			).resolves.toBeNull();
			await expect(
				getRegisteredCallback(server, 'setGetGroupChatStateCallback')('chat-1')
			).resolves.toBeNull();
			await expect(
				getRegisteredCallback(server, 'setStopGroupChatCallback')('chat-1')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setSendGroupChatMessageCallback')('chat-1', 'hello')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setMergeContextCallback')('source', 'target')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setTransferContextCallback')('source', 'target')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setSummarizeContextCallback')('session-1')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setCreateGistCallback')('session-1', 'desc', true)
			).resolves.toEqual({
				success: false,
				error: 'Desktop webContents not available',
			});
			await expect(
				getRegisteredCallback(server, 'setGetUsageDashboardCallback')('month')
			).resolves.toEqual({
				totalTokensIn: 0,
				totalTokensOut: 0,
				totalCost: 0,
				sessionBreakdown: [],
				dailyUsage: [],
			});
			await expect(getRegisteredCallback(server, 'setGetAchievementsCallback')()).resolves.toEqual(
				[]
			);
		});

		it('returns main-window-unavailable fallbacks for tab and Auto Run bridges', async () => {
			deps.getMainWindow = vi.fn().mockReturnValue(null);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			await expect(
				getRegisteredCallback(server, 'setOpenFileTabCallback')('session-1', 'README.md', true)
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setRefreshFileTreeCallback')('session-1')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setNotifyToastCallback')({ title: 'Saved' })
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setNotifyCenterFlashCallback')({ sessionId: 'session-1' })
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setOpenBrowserTabCallback')(
					'session-1',
					'https://example.com'
				)
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setOpenTerminalTabCallback')('session-1', {})
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setNewAITabWithPromptCallback')('session-1', 'prompt')
			).resolves.toEqual({ success: false });
			await expect(
				getRegisteredCallback(server, 'setRefreshAutoRunDocsCallback')('session-1')
			).resolves.toBe(false);
			await expect(
				getRegisteredCallback(server, 'setConfigureAutoRunCallback')('session-1', {})
			).resolves.toEqual({ success: false, error: 'Main window not available' });
			await expect(
				getRegisteredCallback(server, 'setSessionAutoRunFolderCallback')('session-1', '/repo')
			).resolves.toEqual({ success: false, error: 'Main window not available' });
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
			// NOT be treated as remote — `enabled` is the source of truth.
			// We assert the resolver returned `undefined` for sshConfig (i.e.
			// no remote was looked up); whether the downstream import call
			// succeeds is irrelevant — we only care that the SSH gate let it
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

	describe('Run-in-worktree git callbacks', () => {
		const setupGitCallbacks = (sessions: Array<Record<string, unknown>>) => {
			mockSessionsStore.get = vi.fn((key: string, defaultValue?: any) => {
				if (key === 'sessions') return sessions;
				return defaultValue;
			}) as any;
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			return {
				getBranches: (server.setGetGitBranchesForSessionCallback as ReturnType<typeof vi.fn>).mock
					.calls[0][0],
				listWorktrees: (server.setListWorktreesForSessionCallback as ReturnType<typeof vi.fn>).mock
					.calls[0][0],
			};
		};

		it('lists branches and worktrees for a local session cwd', async () => {
			vi.mocked(execGit)
				.mockResolvedValueOnce({
					exitCode: 0,
					stdout: 'main\nfeature/one\nremotes/origin/main\n',
					stderr: '',
				} as any)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'feature/one\n', stderr: '' } as any)
				.mockResolvedValueOnce({
					exitCode: 0,
					stdout: 'worktree /repo\nbranch refs/heads/main\n\nworktree /repo-feature\ndetached\n\n',
					stderr: '',
				} as any);
			const callbacks = setupGitCallbacks([{ id: 'session-1', cwd: '/repo' }]);

			await expect(callbacks.getBranches('session-1')).resolves.toEqual({
				branches: expect.arrayContaining(['main', 'feature/one']),
				currentBranch: 'feature/one',
			});
			await expect(callbacks.listWorktrees('session-1')).resolves.toEqual({
				worktrees: [
					{ path: '/repo', branch: 'main', isBare: false },
					{ path: '/repo-feature', branch: null, isBare: false },
				],
			});
			expect(execGit).toHaveBeenNthCalledWith(
				1,
				['branch', '-a', '--format=%(refname:short)'],
				'/repo',
				undefined,
				undefined
			);
		});

		it('returns empty branch/worktree lists for numeric git failures', async () => {
			vi.mocked(execGit)
				.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'not a repo' } as any)
				.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'not a repo' } as any)
				.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'not a repo' } as any);
			const callbacks = setupGitCallbacks([{ id: 'session-1', cwd: '/repo' }]);

			await expect(callbacks.getBranches('session-1')).resolves.toEqual({
				branches: [],
				currentBranch: undefined,
			});
			await expect(callbacks.listWorktrees('session-1')).resolves.toEqual({ worktrees: [] });
		});

		it('uses resolved SSH remote config and fails loudly for missing sessions/remotes', async () => {
			const sshRemote = { id: 'remote-1', enabled: true, host: 'example.com' };
			vi.mocked(getSshRemoteById).mockReturnValue(sshRemote as any);
			vi.mocked(execGit)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'main\n', stderr: '' } as any)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'main\n', stderr: '' } as any)
				.mockResolvedValueOnce({ exitCode: 'ENOENT', stdout: '', stderr: 'git missing' } as any);
			const callbacks = setupGitCallbacks([
				{
					id: 'session-1',
					cwd: '/remote/repo',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				},
				{
					id: 'session-2',
					cwd: '/remote/repo',
					sessionSshRemoteConfig: { enabled: true },
				},
			]);

			await expect(callbacks.getBranches('session-1')).resolves.toEqual({
				branches: ['main'],
				currentBranch: 'main',
			});
			expect(execGit).toHaveBeenNthCalledWith(
				1,
				['branch', '-a', '--format=%(refname:short)'],
				'/remote/repo',
				sshRemote,
				'/remote/repo'
			);
			await expect(callbacks.listWorktrees('session-1')).rejects.toThrow('git missing');
			await expect(callbacks.getBranches('missing')).rejects.toThrow('Session not found: missing');
			await expect(callbacks.getBranches('session-2')).rejects.toThrow(
				'SSH remote is enabled but remoteId is missing for session session-2'
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
				// `sessionId::pipeline::name` — the pipeline discriminator
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
