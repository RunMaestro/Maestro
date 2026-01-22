/**
 * @file web-server-factory.test.ts
 * @description Unit tests for web server factory with dependency injection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';

// Mock electron
vi.mock('electron', () => ({
	ipcMain: {
		once: vi.fn(),
	},
}));

// Mock WebServer - use class syntax to make it a proper constructor
vi.mock('../../../main/web-server', () => {
	return {
		WebServer: class MockWebServer {
			port: number;
			setGetSessionsCallback = vi.fn();
			setGetSessionDetailCallback = vi.fn();
			setGetThemeCallback = vi.fn();
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

			constructor(port: number) {
				this.port = port;
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

import {
	createWebServerFactory,
	type WebServerFactoryDependencies,
} from '../../../main/web-server/web-server-factory';
import { WebServer } from '../../../main/web-server';
import { getThemeById } from '../../../main/themes';
import { getHistoryManager } from '../../../main/history-manager';
import { logger } from '../../../main/utils/logger';

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

		mockSettingsStore = {
			get: vi.fn((key: string, defaultValue?: any) => {
				const values: Record<string, any> = {
					webInterfaceUseCustomPort: false,
					webInterfaceCustomPort: 8080,
					activeThemeId: 'dracula',
					customAICommands: [],
				};
				return values[key] ?? defaultValue;
			}),
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
		};

		mockMainWindow = {
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
				'ai'
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
});
