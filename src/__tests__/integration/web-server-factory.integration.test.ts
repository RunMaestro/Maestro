/**
 * @file web-server-factory.test.ts
 * @description Unit tests for web server factory with dependency injection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';

// Mock electron
vi.mock('electron', () => ({
	ipcMain: {
		once: vi.fn(),
		removeListener: vi.fn(),
	},
}));

// Mock WebServer - use class syntax to make it a proper constructor
// Note: Mock the specific file path that web-server-factory.ts imports from
vi.mock('../../main/web-server/WebServer', () => {
	return {
		WebServer: class MockWebServer {
			port: number;
			securityToken: string | undefined;

			constructor(port: number, securityToken?: string) {
				this.port = port;
				this.securityToken = securityToken;
				return new Proxy(this, {
					get(target, prop, receiver) {
						if (typeof prop === 'string' && prop.startsWith('set')) {
							const targetWithSetters = target as MockWebServer &
								Record<string, ReturnType<typeof vi.fn>>;
							targetWithSetters[prop] ??= vi.fn();
							return targetWithSetters[prop];
						}
						return Reflect.get(target, prop, receiver);
					},
				});
			}
		},
	};
});

// Mock themes
vi.mock('../../main/themes', () => ({
	getThemeById: vi.fn().mockReturnValue({ id: 'dracula', name: 'Dracula' }),
}));

// Mock history manager
vi.mock('../../main/history-manager', () => ({
	getHistoryManager: vi.fn().mockReturnValue({
		getEntries: vi.fn().mockReturnValue([]),
		getEntriesByProjectPath: vi.fn().mockReturnValue([]),
		getAllEntries: vi.fn().mockReturnValue([]),
	}),
}));

// Mock logger
vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import {
	createWebServerFactory,
	type WebServerFactoryDependencies,
} from '../../main/web-server/web-server-factory';
import { WebServer } from '../../main/web-server/WebServer';
import { getThemeById } from '../../main/themes';
import { getHistoryManager } from '../../main/history-manager';
import { logger } from '../../main/utils/logger';

describe('web-server/web-server-factory', () => {
	let mockSettingsStore: WebServerFactoryDependencies['settingsStore'];
	let mockSessionsStore: WebServerFactoryDependencies['sessionsStore'];
	let mockGroupsStore: WebServerFactoryDependencies['groupsStore'];
	let mockMainWindow: Partial<BrowserWindow>;
	let mockWebContents: Partial<WebContents>;
	let mockProcessManager: { write: ReturnType<typeof vi.fn> };
	let deps: WebServerFactoryDependencies;

	const getRegisteredCallback = <T extends (...args: any[]) => any>(
		server: ReturnType<ReturnType<typeof createWebServerFactory>>,
		setterName: string
	): T => (server as any)[setterName].mock.calls[0][0] as T;

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

		it('should still create a server when a generated persistent token cannot be saved', () => {
			vi.mocked(mockSettingsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'persistentWebLink') return true;
				if (key === 'webAuthToken') return null;
				return defaultValue;
			});
			vi.mocked(mockSettingsStore.set).mockImplementation(() => {
				throw new Error('settings unavailable');
			});

			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			expect((server as any).securityToken).toEqual(expect.any(String));
			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to persist new webAuthToken, URL will not survive restart',
				'WebServerFactory'
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

		it('should include group metadata, tab summaries, bookmarks, and truncated previews', () => {
			const longText = 'a'.repeat(600);
			vi.mocked(mockSessionsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'sessions') {
					return [
						{
							id: 'session-1',
							name: 'Grouped Session',
							toolType: 'claude-code',
							state: 'running',
							inputMode: 'terminal',
							cwd: '/project',
							groupId: 'group-1',
							usageStats: { totalTokens: 10 },
							agentSessionId: 'agent-session-1',
							thinkingStartTime: 123,
							bookmarked: true,
							parentSessionId: 'parent-1',
							worktreeBranch: 'feature/web',
							aiTabs: [
								{
									id: 'tab-1',
									agentSessionId: 'agent-tab-1',
									name: 'Main',
									starred: true,
									inputValue: 'draft input',
									usageStats: { totalTokens: 3 },
									createdAt: 456,
									state: 'working',
									thinkingStartTime: 789,
									logs: [{ source: 'stdout', text: longText, timestamp: 111 }],
								},
							],
							activeTabId: 'tab-1',
						},
					];
				}
				return defaultValue;
			});

			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = getRegisteredCallback<() => any[]>(server, 'setGetSessionsCallback');

			const [session] = callback();

			expect(session).toMatchObject({
				id: 'session-1',
				groupName: 'Test Group',
				groupEmoji: '🧪',
				usageStats: { totalTokens: 10 },
				agentSessionId: 'agent-session-1',
				thinkingStartTime: 123,
				activeTabId: 'tab-1',
				bookmarked: true,
				parentSessionId: 'parent-1',
				worktreeBranch: 'feature/web',
				lastResponse: {
					text: `${'a'.repeat(497)}...`,
					timestamp: 111,
					source: 'stdout',
					fullLength: 600,
				},
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'agent-tab-1',
						name: 'Main',
						starred: true,
						inputValue: 'draft input',
						usageStats: { totalTokens: 3 },
						createdAt: 456,
						state: 'working',
						thinkingStartTime: 789,
					},
				],
			});
			expect(session.aiTabs[0]).not.toHaveProperty('logs');
		});

		it('should add an ellipsis when the preview omits lines after the first three', () => {
			vi.mocked(mockSessionsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'sessions') {
					return [
						{
							id: 'session-1',
							name: 'Multiline Session',
							toolType: 'claude-code',
							state: 'idle',
							inputMode: 'ai',
							cwd: '/project',
							aiTabs: [
								{
									id: 'tab-1',
									logs: [
										{
											source: 'stderr',
											text: 'line 1\nline 2\nline 3\nline 4',
											timestamp: 222,
										},
									],
								},
							],
							activeTabId: 'tab-1',
						},
					];
				}
				return defaultValue;
			});
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = getRegisteredCallback<() => any[]>(server, 'setGetSessionsCallback');

			const [session] = callback();

			expect(session.lastResponse).toMatchObject({
				text: 'line 1\nline 2\nline 3...',
				source: 'stderr',
				fullLength: 27,
			});
		});

		it('should fall back to the first tab and empty tab defaults when session fields are missing', () => {
			vi.mocked(mockSessionsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'sessions') {
					return [
						{
							id: 'fallback-tab-session',
							name: 'Fallback Tab Session',
							toolType: 'claude-code',
							state: 'idle',
							inputMode: 'ai',
							cwd: '/project',
							aiTabs: [{ id: 'first-tab' }],
						},
						{
							id: 'empty-tabs-session',
							name: 'Empty Tabs Session',
							toolType: 'claude-code',
							state: 'idle',
							inputMode: 'ai',
							cwd: '/project',
						},
					];
				}
				return defaultValue;
			});
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = getRegisteredCallback<() => any[]>(server, 'setGetSessionsCallback');

			const [fallbackTabSession, emptyTabsSession] = callback();

			expect(fallbackTabSession).toMatchObject({
				activeTabId: 'first-tab',
				lastResponse: null,
				aiTabs: [
					{
						id: 'first-tab',
						agentSessionId: null,
						name: null,
						starred: false,
						inputValue: '',
						usageStats: null,
						state: 'idle',
						thinkingStartTime: null,
					},
				],
			});
			expect(emptyTabsSession.aiTabs).toEqual([]);
			expect(emptyTabsSession.activeTabId).toBeUndefined();
		});

		it('should leave lastResponse empty when logs do not contain AI text', () => {
			vi.mocked(mockSessionsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'sessions') {
					return [
						{
							id: 'session-1',
							name: 'No Preview Session',
							toolType: 'claude-code',
							state: 'idle',
							inputMode: 'ai',
							cwd: '/project',
							activeTabId: 'tab-1',
							aiTabs: [
								{
									id: 'tab-1',
									logs: [
										{ source: 'thinking', text: 'hidden' },
										{ source: 'stdout', text: '' },
									],
								},
							],
						},
					];
				}
				return defaultValue;
			});
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = getRegisteredCallback<() => any[]>(server, 'setGetSessionsCallback');

			const [session] = callback();

			expect(session.lastResponse).toBeNull();
		});
	});

	describe('getSessionDetailCallback behavior', () => {
		it('should return null when a session cannot be found', () => {
			vi.mocked(mockSessionsStore.get).mockReturnValue([]);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = getRegisteredCallback<(sessionId: string) => unknown>(
				server,
				'setGetSessionDetailCallback'
			);

			expect(callback('missing-session')).toBeNull();
		});

		it('should return requested tab logs while filtering thinking and tool entries', () => {
			vi.mocked(mockSessionsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'sessions') {
					return [
						{
							id: 'session-1',
							name: 'Detail Session',
							toolType: 'claude-code',
							state: 'running',
							inputMode: 'ai',
							cwd: '/project',
							shellLogs: [{ text: 'shell output' }],
							usageStats: { totalTokens: 42 },
							agentSessionId: 'agent-session-1',
							isGitRepo: true,
							activeTabId: 'tab-1',
							aiTabs: [
								{
									id: 'tab-1',
									logs: [{ source: 'stdout', text: 'active tab output' }],
								},
								{
									id: 'tab-2',
									logs: [
										{ source: 'thinking', text: 'hidden thought' },
										{ source: 'tool', text: 'hidden tool' },
										{ source: 'stdout', text: 'visible output' },
										{ source: 'stderr', text: 'visible error' },
									],
								},
							],
						},
					];
				}
				return defaultValue;
			});
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = getRegisteredCallback<(sessionId: string, tabId?: string) => any>(
				server,
				'setGetSessionDetailCallback'
			);

			const detail = callback('session-1', 'tab-2');

			expect(detail).toMatchObject({
				id: 'session-1',
				name: 'Detail Session',
				toolType: 'claude-code',
				state: 'running',
				inputMode: 'ai',
				cwd: '/project',
				shellLogs: [{ text: 'shell output' }],
				usageStats: { totalTokens: 42 },
				agentSessionId: 'agent-session-1',
				isGitRepo: true,
				activeTabId: 'tab-2',
				aiLogs: [
					{ source: 'thinking', text: 'hidden thought' },
					{ source: 'tool', text: 'hidden tool' },
					{ source: 'stdout', text: 'visible output' },
					{ source: 'stderr', text: 'visible error' },
				],
			});
		});

		it('should fall back to the first tab logs and empty shell logs for stale active tab ids', () => {
			vi.mocked(mockSessionsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'sessions') {
					return [
						{
							id: 'session-1',
							name: 'Fallback Detail Session',
							toolType: 'claude-code',
							state: 'idle',
							inputMode: 'ai',
							cwd: '/project',
							activeTabId: 'missing-tab',
							aiTabs: [{ id: 'tab-1' }],
						},
					];
				}
				return defaultValue;
			});
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = getRegisteredCallback<(sessionId: string, tabId?: string) => any>(
				server,
				'setGetSessionDetailCallback'
			);

			const detail = callback('session-1');

			expect(detail).toMatchObject({
				activeTabId: 'missing-tab',
				aiLogs: [],
				shellLogs: [],
			});
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

		it('should write to terminal process when inputMode is terminal', () => {
			vi.mocked(mockSessionsStore.get).mockReturnValue([
				{
					id: 'session-1',
					inputMode: 'terminal',
				},
			]);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setWriteCallback = server.setWriteToSessionCallback as ReturnType<typeof vi.fn>;
			const callback = setWriteCallback.mock.calls[0][0];

			callback('session-1', 'test data');

			expect(mockProcessManager.write).toHaveBeenCalledWith('session-1-terminal', 'test data');
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

		it('should send command to renderer', async () => {
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

		it('should return false when webContents is unavailable', async () => {
			vi.mocked(mockWebContents.isDestroyed!).mockReturnValue(true);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setExecuteCallback = server.setExecuteCommandCallback as ReturnType<typeof vi.fn>;
			const callback = setExecuteCallback.mock.calls[0][0];

			const result = await callback('session-1', 'test command');

			expect(result).toBe(false);
			expect(mockWebContents.send).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledWith(
				'webContents is not available for executeCommand',
				'WebServer'
			);
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

		it('should return false when webContents is unavailable', async () => {
			vi.mocked(mockWebContents.isDestroyed!).mockReturnValue(true);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setInterruptCallback = server.setInterruptSessionCallback as ReturnType<typeof vi.fn>;
			const callback = setInterruptCallback.mock.calls[0][0];

			const result = await callback('session-1');

			expect(result).toBe(false);
			expect(mockWebContents.send).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledWith(
				'webContents is not available for interrupt',
				'WebServer'
			);
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

	describe('remote session and tab callbacks', () => {
		const remoteBooleanCallbacks = [
			{
				name: 'switchMode',
				setter: 'setSwitchModeCallback',
				args: ['session-1', 'terminal'],
				channel: 'remote:switchMode',
				sentArgs: ['session-1', 'terminal'],
			},
			{
				name: 'selectSession',
				setter: 'setSelectSessionCallback',
				args: ['session-1', 'tab-1'],
				channel: 'remote:selectSession',
				sentArgs: ['session-1', 'tab-1'],
			},
			{
				name: 'selectTab',
				setter: 'setSelectTabCallback',
				args: ['session-1', 'tab-2'],
				channel: 'remote:selectTab',
				sentArgs: ['session-1', 'tab-2'],
			},
			{
				name: 'closeTab',
				setter: 'setCloseTabCallback',
				args: ['session-1', 'tab-2'],
				channel: 'remote:closeTab',
				sentArgs: ['session-1', 'tab-2'],
			},
			{
				name: 'renameTab',
				setter: 'setRenameTabCallback',
				args: ['session-1', 'tab-2', 'Planning'],
				channel: 'remote:renameTab',
				sentArgs: ['session-1', 'tab-2', 'Planning'],
			},
			{
				name: 'starTab',
				setter: 'setStarTabCallback',
				args: ['session-1', 'tab-2', true],
				channel: 'remote:starTab',
				sentArgs: ['session-1', 'tab-2', true],
			},
			{
				name: 'reorderTab',
				setter: 'setReorderTabCallback',
				args: ['session-1', 3, 1],
				channel: 'remote:reorderTab',
				sentArgs: ['session-1', 3, 1],
			},
			{
				name: 'toggleBookmark',
				setter: 'setToggleBookmarkCallback',
				args: ['session-1'],
				channel: 'remote:toggleBookmark',
				sentArgs: ['session-1'],
			},
		];

		it.each(remoteBooleanCallbacks)(
			'should send $name to the renderer',
			async ({ setter, args, channel, sentArgs }) => {
				const createWebServer = createWebServerFactory(deps);
				const server = createWebServer();
				const callback = getRegisteredCallback<(...callbackArgs: any[]) => Promise<boolean>>(
					server,
					setter
				);

				await expect(callback(...args)).resolves.toBe(true);

				expect(mockWebContents.send).toHaveBeenCalledWith(channel, ...sentArgs);
			}
		);

		it('should send selectSession without a tab id when none is provided', async () => {
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = getRegisteredCallback<
				(sessionId: string, tabId?: string) => Promise<boolean>
			>(server, 'setSelectSessionCallback');

			await expect(callback('session-1')).resolves.toBe(true);

			expect(mockWebContents.send).toHaveBeenCalledWith(
				'remote:selectSession',
				'session-1',
				undefined
			);
		});

		it.each(remoteBooleanCallbacks)(
			'should return false for $name when the main window is missing',
			async ({ setter, args }) => {
				deps.getMainWindow = vi.fn().mockReturnValue(null);
				const createWebServer = createWebServerFactory(deps);
				const server = createWebServer();
				const callback = getRegisteredCallback<(...callbackArgs: any[]) => Promise<boolean>>(
					server,
					setter
				);

				await expect(callback(...args)).resolves.toBe(false);

				expect(mockWebContents.send).not.toHaveBeenCalled();
			}
		);

		it.each(remoteBooleanCallbacks)(
			'should return false for $name when webContents is unavailable',
			async ({ setter, args }) => {
				vi.mocked(mockWebContents.isDestroyed!).mockReturnValue(true);
				const createWebServer = createWebServerFactory(deps);
				const server = createWebServer();
				const callback = getRegisteredCallback<(...callbackArgs: any[]) => Promise<boolean>>(
					server,
					setter
				);

				await expect(callback(...args)).resolves.toBe(false);

				expect(mockWebContents.send).not.toHaveBeenCalled();
			}
		);

		it('should resolve newTab with the renderer response and ignore duplicate responses', async () => {
			let responseHandler: ((event: unknown, result: unknown) => void) | undefined;
			vi.mocked(ipcMain.once).mockImplementation((channel: string, handler: any) => {
				expect(channel).toMatch(/^remote:newTab:response:/);
				responseHandler = handler;
				return ipcMain;
			});
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = getRegisteredCallback<(sessionId: string) => Promise<unknown>>(
				server,
				'setNewTabCallback'
			);

			const resultPromise = callback('session-1');
			responseHandler!({}, { tabId: 'tab-2' });
			responseHandler!({}, { tabId: 'ignored' });

			await expect(resultPromise).resolves.toEqual({ tabId: 'tab-2' });
			expect(mockWebContents.send).toHaveBeenCalledWith(
				'remote:newTab',
				'session-1',
				expect.stringMatching(/^remote:newTab:response:/)
			);
		});

		it('should ignore a newTab timeout after the renderer response already resolved', async () => {
			let responseHandler: ((event: unknown, result: unknown) => void) | undefined;
			let timeoutHandler: (() => void) | undefined;
			const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
				handler: TimerHandler
			) => {
				timeoutHandler = handler as () => void;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout);
			const clearTimeoutSpy = vi
				.spyOn(globalThis, 'clearTimeout')
				.mockImplementation((() => undefined) as typeof clearTimeout);
			try {
				vi.mocked(ipcMain.once).mockImplementation((channel: string, handler: any) => {
					expect(channel).toMatch(/^remote:newTab:response:/);
					responseHandler = handler;
					return ipcMain;
				});
				const createWebServer = createWebServerFactory(deps);
				const server = createWebServer();
				const callback = getRegisteredCallback<(sessionId: string) => Promise<unknown>>(
					server,
					'setNewTabCallback'
				);

				const resultPromise = callback('session-1');
				responseHandler!({}, { tabId: 'tab-2' });
				timeoutHandler!();

				await expect(resultPromise).resolves.toEqual({ tabId: 'tab-2' });
				expect(clearTimeoutSpy).toHaveBeenCalled();
				expect(ipcMain.removeListener).not.toHaveBeenCalled();
			} finally {
				setTimeoutSpy.mockRestore();
				clearTimeoutSpy.mockRestore();
			}
		});

		it('should return null for newTab when the main window is missing', async () => {
			deps.getMainWindow = vi.fn().mockReturnValue(null);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = getRegisteredCallback<(sessionId: string) => Promise<unknown>>(
				server,
				'setNewTabCallback'
			);

			await expect(callback('session-1')).resolves.toBeNull();

			expect(ipcMain.once).not.toHaveBeenCalled();
		});

		it('should remove the newTab response listener when webContents is unavailable', async () => {
			vi.mocked(mockWebContents.isDestroyed!).mockReturnValue(true);
			vi.mocked(ipcMain.once).mockReturnValue(ipcMain);
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = getRegisteredCallback<(sessionId: string) => Promise<unknown>>(
				server,
				'setNewTabCallback'
			);

			await expect(callback('session-1')).resolves.toBeNull();

			expect(ipcMain.removeListener).toHaveBeenCalledWith(
				expect.stringMatching(/^remote:newTab:response:/),
				expect.any(Function)
			);
			expect(mockWebContents.send).not.toHaveBeenCalled();
		});

		it('should time out newTab when the renderer does not respond', async () => {
			vi.useFakeTimers();
			try {
				vi.mocked(ipcMain.once).mockReturnValue(ipcMain);
				const createWebServer = createWebServerFactory(deps);
				const server = createWebServer();
				const callback = getRegisteredCallback<(sessionId: string) => Promise<unknown>>(
					server,
					'setNewTabCallback'
				);

				const resultPromise = callback('session-1');
				vi.advanceTimersByTime(5000);

				await expect(resultPromise).resolves.toBeNull();
				expect(ipcMain.removeListener).toHaveBeenCalledWith(
					expect.stringMatching(/^remote:newTab:response:/),
					expect.any(Function)
				);
				expect(logger.warn).toHaveBeenCalledWith(
					'newTab callback timed out for session session-1',
					'WebServer'
				);
			} finally {
				vi.useRealTimers();
			}
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

	describe('getCustomCommandsCallback behavior', () => {
		it('should return configured custom AI commands', () => {
			const commands = [
				{
					id: 'cmd-1',
					command: '/summarize',
					description: 'Summarize the session',
					prompt: 'Summarize this session',
				},
			];
			vi.mocked(mockSettingsStore.get).mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'customAICommands') return commands;
				return defaultValue;
			});
			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();
			const callback = getRegisteredCallback<() => typeof commands>(
				server,
				'setGetCustomCommandsCallback'
			);

			expect(callback()).toBe(commands);
		});
	});

	describe('getHistoryCallback behavior', () => {
		it('should get entries for specific session', async () => {
			const entries = [
				{ id: 1, timestamp: 100 },
				{ id: 2, timestamp: 300 },
				{ id: 3, timestamp: 200 },
			];
			const mockHistoryManager = {
				getEntries: vi.fn().mockReturnValue(entries),
				getEntriesByProjectPath: vi.fn(),
				getAllEntries: vi.fn(),
			};
			vi.mocked(getHistoryManager).mockReturnValue(mockHistoryManager as any);

			const createWebServer = createWebServerFactory(deps);
			const server = createWebServer();

			const setHistoryCallback = server.setGetHistoryCallback as ReturnType<typeof vi.fn>;
			const callback = setHistoryCallback.mock.calls[0][0];

			const result = await callback(undefined, 'session-1');

			expect(mockHistoryManager.getEntries).toHaveBeenCalledWith('session-1');
			expect(result.map((entry: { id: number }) => entry.id)).toEqual([2, 3, 1]);
		});

		it('should get entries by project path', async () => {
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

			await callback('/test/project');

			expect(mockHistoryManager.getEntriesByProjectPath).toHaveBeenCalledWith('/test/project');
		});

		it('should get all entries when no filter', async () => {
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

			await callback();

			expect(mockHistoryManager.getAllEntries).toHaveBeenCalled();
		});
	});
});
