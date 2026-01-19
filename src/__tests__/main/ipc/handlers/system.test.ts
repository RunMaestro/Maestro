/**
 * Tests for the system IPC handlers
 *
 * These tests verify system-level operations:
 * - Dialog: folder selection
 * - Fonts: system font detection
 * - Shells: available shell detection, open external URLs
 * - Tunnel: Cloudflare tunnel management
 * - DevTools: developer tools control
 * - Updates: update checking
 * - Logger: logging operations
 * - Sync: custom storage path management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, dialog, shell, BrowserWindow, App } from 'electron';
import Store from 'electron-store';
import {
	registerSystemHandlers,
	SystemHandlerDependencies,
} from '../../../../main/ipc/handlers/system';

// Mock electron modules
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	dialog: {
		showOpenDialog: vi.fn(),
		showSaveDialog: vi.fn(),
	},
	shell: {
		openExternal: vi.fn(),
	},
	BrowserWindow: {
		getFocusedWindow: vi.fn(),
	},
	app: {
		getVersion: vi.fn(),
		getPath: vi.fn(),
	},
}));

// Mock logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		toast: vi.fn(),
		autorun: vi.fn(),
		getLogs: vi.fn(),
		clearLogs: vi.fn(),
		setLogLevel: vi.fn(),
		getLogLevel: vi.fn(),
		setMaxLogBuffer: vi.fn(),
		getMaxLogBuffer: vi.fn(),
		getLogFilePath: vi.fn(),
		isFileLoggingEnabled: vi.fn(),
		enableFileLogging: vi.fn(),
		on: vi.fn(),
	},
}));

// Mock shell detector
vi.mock('../../../../main/utils/shellDetector', () => ({
	detectShells: vi.fn(),
}));

// Mock CLI detection
vi.mock('../../../../main/utils/cliDetection', () => ({
	isCloudflaredInstalled: vi.fn(),
}));

// Mock execFile utility
vi.mock('../../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

// Mock update checker
vi.mock('../../../../main/update-checker', () => ({
	checkForUpdates: vi.fn(),
}));

// Mock auto-updater
vi.mock('../../../../main/auto-updater', () => ({
	setAllowPrerelease: vi.fn(),
}));

// Mock tunnel manager
vi.mock('../../../../main/tunnel-manager', () => ({
	tunnelManager: {
		start: vi.fn(),
		stop: vi.fn(),
		getStatus: vi.fn(),
	},
}));

// Mock fs
vi.mock('fs', () => ({
	default: {
		existsSync: vi.fn(),
		mkdirSync: vi.fn(),
		readFileSync: vi.fn(),
		copyFileSync: vi.fn(),
	},
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
	copyFileSync: vi.fn(),
}));

// Import mocked modules for test control
import { logger } from '../../../../main/utils/logger';
import { detectShells } from '../../../../main/utils/shellDetector';
import { isCloudflaredInstalled } from '../../../../main/utils/cliDetection';
import { execFileNoThrow } from '../../../../main/utils/execFile';
import { checkForUpdates } from '../../../../main/update-checker';
import { setAllowPrerelease } from '../../../../main/auto-updater';
import { tunnelManager } from '../../../../main/tunnel-manager';
import * as fsSync from 'fs';

describe('system IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockMainWindow: any;
	let mockApp: any;
	let mockSettingsStore: any;
	let mockBootstrapStore: any;
	let mockWebServer: any;
	let mockTunnelManager: any;
	let deps: SystemHandlerDependencies;

	beforeEach(() => {
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Setup mock main window
		mockMainWindow = {
			isDestroyed: vi.fn().mockReturnValue(false),
			webContents: {
				openDevTools: vi.fn(),
				closeDevTools: vi.fn(),
				isDevToolsOpened: vi.fn(),
				send: vi.fn(),
			},
		};

		// Setup mock app
		mockApp = {
			getVersion: vi.fn().mockReturnValue('1.0.0'),
			getPath: vi.fn().mockReturnValue('/default/user/data'),
		};

		// Setup mock settings store
		mockSettingsStore = {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
		};

		// Setup mock bootstrap store
		mockBootstrapStore = {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
		};

		// Setup mock web server
		mockWebServer = {
			getSecureUrl: vi.fn().mockReturnValue('http://localhost:3000/token-path'),
		};

		// Setup mock tunnel manager (use the imported mock)
		mockTunnelManager = tunnelManager;

		// Create dependencies
		deps = {
			getMainWindow: () => mockMainWindow,
			app: mockApp as unknown as App,
			settingsStore: mockSettingsStore as unknown as Store<any>,
			tunnelManager: mockTunnelManager,
			getWebServer: () => mockWebServer,
			bootstrapStore: mockBootstrapStore as unknown as Store<any>,
		};

		// Register handlers
		registerSystemHandlers(deps);
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all system handlers', () => {
			const expectedChannels = [
				// Dialog handlers
				'dialog:selectFolder',
				'dialog:saveFile',
				// Font handlers
				'fonts:detect',
				// Shell handlers
				'shells:detect',
				'shell:openExternal',
				'shell:trashItem',
				// Tunnel handlers
				'tunnel:isCloudflaredInstalled',
				'tunnel:start',
				'tunnel:stop',
				'tunnel:getStatus',
				// DevTools handlers
				'devtools:open',
				'devtools:close',
				'devtools:toggle',
				// Update handlers
				'updates:check',
				'updates:setAllowPrerelease',
				// Logger handlers
				'logger:log',
				'logger:getLogs',
				'logger:clearLogs',
				'logger:setLogLevel',
				'logger:getLogLevel',
				'logger:setMaxLogBuffer',
				'logger:getMaxLogBuffer',
				'logger:getLogFilePath',
				'logger:isFileLoggingEnabled',
				'logger:enableFileLogging',
				// Sync handlers
				'sync:getDefaultPath',
				'sync:getSettings',
				'sync:getCurrentStoragePath',
				'sync:selectSyncFolder',
				'sync:setCustomPath',
				// Power management handlers
				'power:setEnabled',
				'power:isEnabled',
				'power:getStatus',
				'power:addReason',
				'power:removeReason',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel), `Missing handler for ${channel}`).toBe(true);
			}

			// Verify exact count
			expect(handlers.size).toBe(expectedChannels.length);
		});
	});

	describe('dialog:selectFolder', () => {
		it('should open dialog and return selected path', async () => {
			vi.mocked(dialog.showOpenDialog).mockResolvedValue({
				canceled: false,
				filePaths: ['/selected/path'],
			});

			const handler = handlers.get('dialog:selectFolder');
			const result = await handler!({} as any);

			expect(dialog.showOpenDialog).toHaveBeenCalledWith(mockMainWindow, {
				properties: ['openDirectory', 'createDirectory'],
				title: 'Select Working Directory',
			});
			expect(result).toBe('/selected/path');
		});

		it('should return null when dialog is cancelled', async () => {
			vi.mocked(dialog.showOpenDialog).mockResolvedValue({
				canceled: true,
				filePaths: [],
			});

			const handler = handlers.get('dialog:selectFolder');
			const result = await handler!({} as any);

			expect(result).toBeNull();
		});

		it('should return null when no files selected', async () => {
			vi.mocked(dialog.showOpenDialog).mockResolvedValue({
				canceled: false,
				filePaths: [],
			});

			const handler = handlers.get('dialog:selectFolder');
			const result = await handler!({} as any);

			expect(result).toBeNull();
		});

		it('should return null when no main window available', async () => {
			deps.getMainWindow = () => null;
			handlers.clear();
			registerSystemHandlers(deps);

			const handler = handlers.get('dialog:selectFolder');
			const result = await handler!({} as any);

			expect(result).toBeNull();
			expect(dialog.showOpenDialog).not.toHaveBeenCalled();
		});
	});

	describe('dialog:saveFile', () => {
		it('should open save dialog and return selected path', async () => {
			vi.mocked(dialog.showSaveDialog).mockResolvedValue({
				canceled: false,
				filePath: '/path/to/save/file.csv',
			});

			const handler = handlers.get('dialog:saveFile');
			const options = {
				defaultPath: 'export.csv',
				filters: [{ name: 'CSV Files', extensions: ['csv'] }],
				title: 'Export Data',
			};
			const result = await handler!({} as any, options);

			expect(dialog.showSaveDialog).toHaveBeenCalledWith(mockMainWindow, {
				defaultPath: 'export.csv',
				filters: [{ name: 'CSV Files', extensions: ['csv'] }],
				title: 'Export Data',
			});
			expect(result).toBe('/path/to/save/file.csv');
		});

		it('should return null when dialog is cancelled', async () => {
			vi.mocked(dialog.showSaveDialog).mockResolvedValue({
				canceled: true,
				filePath: undefined,
			});

			const handler = handlers.get('dialog:saveFile');
			const result = await handler!({} as any, { defaultPath: 'test.csv' });

			expect(result).toBeNull();
		});

		it('should use default title when not provided', async () => {
			vi.mocked(dialog.showSaveDialog).mockResolvedValue({
				canceled: false,
				filePath: '/path/to/file.csv',
			});

			const handler = handlers.get('dialog:saveFile');
			await handler!({} as any, { defaultPath: 'test.csv' });

			expect(dialog.showSaveDialog).toHaveBeenCalledWith(mockMainWindow, {
				defaultPath: 'test.csv',
				filters: undefined,
				title: 'Save File',
			});
		});

		it('should return null when no main window available', async () => {
			deps.getMainWindow = () => null;
			handlers.clear();
			registerSystemHandlers(deps);

			const handler = handlers.get('dialog:saveFile');
			const result = await handler!({} as any, { defaultPath: 'test.csv' });

			expect(result).toBeNull();
			expect(dialog.showSaveDialog).not.toHaveBeenCalled();
		});
	});

	describe('fonts:detect', () => {
		it('should return array of system fonts using fc-list', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: 'Arial\nHelvetica\nMonaco\nCourier New',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('fonts:detect');
			const result = await handler!({} as any);

			expect(execFileNoThrow).toHaveBeenCalledWith('fc-list', [':', 'family']);
			expect(result).toEqual(['Arial', 'Helvetica', 'Monaco', 'Courier New']);
		});

		it('should deduplicate fonts', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: 'Arial\nArial\nHelvetica\nArial',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('fonts:detect');
			const result = await handler!({} as any);

			expect(result).toEqual(['Arial', 'Helvetica']);
		});

		it('should filter empty lines', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: 'Arial\n\nHelvetica\n  \nMonaco',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('fonts:detect');
			const result = await handler!({} as any);

			expect(result).toEqual(['Arial', 'Helvetica', 'Monaco']);
		});

		it('should return fallback fonts when fc-list fails', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'command not found',
				exitCode: 1,
			});

			const handler = handlers.get('fonts:detect');
			const result = await handler!({} as any);

			expect(result).toEqual([
				'Monaco',
				'Menlo',
				'Courier New',
				'Consolas',
				'Roboto Mono',
				'Fira Code',
				'JetBrains Mono',
			]);
		});

		it('should return fallback fonts on error', async () => {
			vi.mocked(execFileNoThrow).mockRejectedValue(new Error('Command failed'));

			const handler = handlers.get('fonts:detect');
			const result = await handler!({} as any);

			expect(result).toEqual([
				'Monaco',
				'Menlo',
				'Courier New',
				'Consolas',
				'Roboto Mono',
				'Fira Code',
				'JetBrains Mono',
			]);
		});
	});

	describe('shells:detect', () => {
		it('should return array of available shells', async () => {
			const mockShells = [
				{ id: 'zsh', name: 'Zsh', available: true, path: '/bin/zsh' },
				{ id: 'bash', name: 'Bash', available: true, path: '/bin/bash' },
				{ id: 'fish', name: 'Fish', available: false },
			];

			vi.mocked(detectShells).mockResolvedValue(mockShells);

			const handler = handlers.get('shells:detect');
			const result = await handler!({} as any);

			expect(detectShells).toHaveBeenCalled();
			expect(result).toEqual(mockShells);
			expect(logger.info).toHaveBeenCalledWith('Detecting available shells', 'ShellDetector');
		});

		it('should return default unavailable shells on error', async () => {
			vi.mocked(detectShells).mockRejectedValue(new Error('Detection failed'));

			const handler = handlers.get('shells:detect');
			const result = await handler!({} as any);

			expect(result).toEqual([
				{ id: 'zsh', name: 'Zsh', available: false },
				{ id: 'bash', name: 'Bash', available: false },
				{ id: 'sh', name: 'Bourne Shell (sh)', available: false },
				{ id: 'fish', name: 'Fish', available: false },
				{ id: 'tcsh', name: 'Tcsh', available: false },
			]);
			expect(logger.error).toHaveBeenCalledWith(
				'Shell detection error',
				'ShellDetector',
				expect.any(Error)
			);
		});
	});

	describe('shell:openExternal', () => {
		it('should open URL in default browser', async () => {
			vi.mocked(shell.openExternal).mockResolvedValue(undefined);

			const handler = handlers.get('shell:openExternal');
			await handler!({} as any, 'https://example.com');

			expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
		});

		it('should handle different URL types', async () => {
			vi.mocked(shell.openExternal).mockResolvedValue(undefined);

			const handler = handlers.get('shell:openExternal');
			await handler!({} as any, 'mailto:test@example.com');

			expect(shell.openExternal).toHaveBeenCalledWith('mailto:test@example.com');
		});
	});

	describe('tunnel:isCloudflaredInstalled', () => {
		it('should return true when cloudflared is installed', async () => {
			vi.mocked(isCloudflaredInstalled).mockResolvedValue(true);

			const handler = handlers.get('tunnel:isCloudflaredInstalled');
			const result = await handler!({} as any);

			expect(result).toBe(true);
		});

		it('should return false when cloudflared is not installed', async () => {
			vi.mocked(isCloudflaredInstalled).mockResolvedValue(false);

			const handler = handlers.get('tunnel:isCloudflaredInstalled');
			const result = await handler!({} as any);

			expect(result).toBe(false);
		});
	});

	describe('tunnel:start', () => {
		it('should start tunnel and return full URL with token', async () => {
			mockWebServer.getSecureUrl.mockReturnValue('http://localhost:3000/secret-token');
			vi.mocked(mockTunnelManager.start).mockResolvedValue({
				success: true,
				url: 'https://abc.trycloudflare.com',
			});

			const handler = handlers.get('tunnel:start');
			const result = await handler!({} as any);

			expect(mockTunnelManager.start).toHaveBeenCalledWith(3000);
			expect(result).toEqual({
				success: true,
				url: 'https://abc.trycloudflare.com/secret-token',
			});
		});

		it('should return error when web server not running', async () => {
			deps.getWebServer = () => null;
			handlers.clear();
			registerSystemHandlers(deps);

			const handler = handlers.get('tunnel:start');
			const result = await handler!({} as any);

			expect(result).toEqual({
				success: false,
				error: 'Web server not running',
			});
		});

		it('should return error when web server URL not available', async () => {
			mockWebServer.getSecureUrl.mockReturnValue(null);

			const handler = handlers.get('tunnel:start');
			const result = await handler!({} as any);

			expect(result).toEqual({
				success: false,
				error: 'Web server not running',
			});
		});

		it('should return tunnel manager error result', async () => {
			mockWebServer.getSecureUrl.mockReturnValue('http://localhost:3000/token');
			vi.mocked(mockTunnelManager.start).mockResolvedValue({
				success: false,
				error: 'Tunnel failed to start',
			});

			const handler = handlers.get('tunnel:start');
			const result = await handler!({} as any);

			expect(result).toEqual({
				success: false,
				error: 'Tunnel failed to start',
			});
		});
	});

	describe('tunnel:stop', () => {
		it('should stop tunnel and return success', async () => {
			vi.mocked(mockTunnelManager.stop).mockResolvedValue(undefined);

			const handler = handlers.get('tunnel:stop');
			const result = await handler!({} as any);

			expect(mockTunnelManager.stop).toHaveBeenCalled();
			expect(result).toEqual({ success: true });
		});
	});

	describe('tunnel:getStatus', () => {
		it('should return tunnel status', async () => {
			const mockStatus = {
				running: true,
				url: 'https://abc.trycloudflare.com',
			};
			vi.mocked(mockTunnelManager.getStatus).mockReturnValue(mockStatus);

			const handler = handlers.get('tunnel:getStatus');
			const result = await handler!({} as any);

			expect(result).toEqual(mockStatus);
		});

		it('should return stopped status', async () => {
			const mockStatus = {
				running: false,
				url: null,
			};
			vi.mocked(mockTunnelManager.getStatus).mockReturnValue(mockStatus);

			const handler = handlers.get('tunnel:getStatus');
			const result = await handler!({} as any);

			expect(result).toEqual(mockStatus);
		});
	});

	describe('devtools:open', () => {
		it('should open devtools on main window', async () => {
			const handler = handlers.get('devtools:open');
			await handler!({} as any);

			expect(mockMainWindow.webContents.openDevTools).toHaveBeenCalled();
		});

		it('should not throw when no main window', async () => {
			deps.getMainWindow = () => null;
			handlers.clear();
			registerSystemHandlers(deps);

			const handler = handlers.get('devtools:open');
			await expect(handler!({} as any)).resolves.not.toThrow();
		});

		it('should not open devtools when window is destroyed', async () => {
			mockMainWindow.isDestroyed.mockReturnValue(true);

			const handler = handlers.get('devtools:open');
			await handler!({} as any);

			expect(mockMainWindow.webContents.openDevTools).not.toHaveBeenCalled();
		});
	});

	describe('devtools:close', () => {
		it('should close devtools on main window', async () => {
			const handler = handlers.get('devtools:close');
			await handler!({} as any);

			expect(mockMainWindow.webContents.closeDevTools).toHaveBeenCalled();
		});

		it('should not throw when no main window', async () => {
			deps.getMainWindow = () => null;
			handlers.clear();
			registerSystemHandlers(deps);

			const handler = handlers.get('devtools:close');
			await expect(handler!({} as any)).resolves.not.toThrow();
		});

		it('should not close devtools when window is destroyed', async () => {
			mockMainWindow.isDestroyed.mockReturnValue(true);

			const handler = handlers.get('devtools:close');
			await handler!({} as any);

			expect(mockMainWindow.webContents.closeDevTools).not.toHaveBeenCalled();
		});
	});

	describe('devtools:toggle', () => {
		it('should close devtools when currently open', async () => {
			mockMainWindow.webContents.isDevToolsOpened.mockReturnValue(true);

			const handler = handlers.get('devtools:toggle');
			await handler!({} as any);

			expect(mockMainWindow.webContents.closeDevTools).toHaveBeenCalled();
			expect(mockMainWindow.webContents.openDevTools).not.toHaveBeenCalled();
		});

		it('should open devtools when currently closed', async () => {
			mockMainWindow.webContents.isDevToolsOpened.mockReturnValue(false);

			const handler = handlers.get('devtools:toggle');
			await handler!({} as any);

			expect(mockMainWindow.webContents.openDevTools).toHaveBeenCalled();
			expect(mockMainWindow.webContents.closeDevTools).not.toHaveBeenCalled();
		});

		it('should not throw when no main window', async () => {
			deps.getMainWindow = () => null;
			handlers.clear();
			registerSystemHandlers(deps);

			const handler = handlers.get('devtools:toggle');
			await expect(handler!({} as any)).resolves.not.toThrow();
		});

		it('should not toggle when window is destroyed', async () => {
			mockMainWindow.isDestroyed.mockReturnValue(true);

			const handler = handlers.get('devtools:toggle');
			await handler!({} as any);

			expect(mockMainWindow.webContents.isDevToolsOpened).not.toHaveBeenCalled();
		});
	});

	describe('updates:check', () => {
		it('should check for updates with current version (stable only by default)', async () => {
			const mockUpdateInfo = {
				hasUpdate: true,
				latestVersion: '2.0.0',
				currentVersion: '1.0.0',
				downloadUrl: 'https://example.com/download',
			};
			vi.mocked(checkForUpdates).mockResolvedValue(mockUpdateInfo);

			const handler = handlers.get('updates:check');
			const result = await handler!({} as any);

			expect(mockApp.getVersion).toHaveBeenCalled();
			expect(checkForUpdates).toHaveBeenCalledWith('1.0.0', false);
			expect(result).toEqual(mockUpdateInfo);
		});

		it('should pass includePrerelease flag to checkForUpdates', async () => {
			const mockUpdateInfo = {
				hasUpdate: true,
				latestVersion: '2.0.0-beta',
				currentVersion: '1.0.0',
			};
			vi.mocked(checkForUpdates).mockResolvedValue(mockUpdateInfo);

			const handler = handlers.get('updates:check');
			const result = await handler!({} as any, true);

			expect(checkForUpdates).toHaveBeenCalledWith('1.0.0', true);
			expect(result).toEqual(mockUpdateInfo);
		});

		it('should return no update available', async () => {
			const mockUpdateInfo = {
				hasUpdate: false,
				latestVersion: '1.0.0',
				currentVersion: '1.0.0',
			};
			vi.mocked(checkForUpdates).mockResolvedValue(mockUpdateInfo);

			const handler = handlers.get('updates:check');
			const result = await handler!({} as any);

			expect(result).toEqual(mockUpdateInfo);
		});
	});

	describe('updates:setAllowPrerelease', () => {
		it('should enable prerelease updates', async () => {
			const handler = handlers.get('updates:setAllowPrerelease');
			await handler!({} as any, true);

			expect(setAllowPrerelease).toHaveBeenCalledWith(true);
		});

		it('should disable prerelease updates', async () => {
			const handler = handlers.get('updates:setAllowPrerelease');
			await handler!({} as any, false);

			expect(setAllowPrerelease).toHaveBeenCalledWith(false);
		});
	});

	describe('logger:log', () => {
		it('should log debug message', async () => {
			const handler = handlers.get('logger:log');
			await handler!({} as any, 'debug', 'Debug message', 'TestContext', { key: 'value' });

			expect(logger.debug).toHaveBeenCalledWith('Debug message', 'TestContext', { key: 'value' });
		});

		it('should log info message', async () => {
			const handler = handlers.get('logger:log');
			await handler!({} as any, 'info', 'Info message', 'TestContext');

			expect(logger.info).toHaveBeenCalledWith('Info message', 'TestContext', undefined);
		});

		it('should log warn message', async () => {
			const handler = handlers.get('logger:log');
			await handler!({} as any, 'warn', 'Warning message', 'TestContext');

			expect(logger.warn).toHaveBeenCalledWith('Warning message', 'TestContext', undefined);
		});

		it('should log error message', async () => {
			const handler = handlers.get('logger:log');
			await handler!({} as any, 'error', 'Error message', 'TestContext', { error: 'details' });

			expect(logger.error).toHaveBeenCalledWith('Error message', 'TestContext', {
				error: 'details',
			});
		});

		it('should log toast message', async () => {
			const handler = handlers.get('logger:log');
			await handler!({} as any, 'toast', 'Toast message', 'TestContext');

			expect(logger.toast).toHaveBeenCalledWith('Toast message', 'TestContext', undefined);
		});

		it('should log autorun message', async () => {
			const handler = handlers.get('logger:log');
			await handler!({} as any, 'autorun', 'Autorun message', 'TestContext');

			expect(logger.autorun).toHaveBeenCalledWith('Autorun message', 'TestContext', undefined);
		});

		it('should log autorun message with full Auto Run workflow data', async () => {
			const autorunData = {
				documents: ['phase-1.md', 'phase-2.md'],
				totalTasks: 10,
				loopEnabled: true,
				maxLoops: 3,
			};

			const handler = handlers.get('logger:log');
			await handler!({} as any, 'autorun', 'Auto Run started', 'MySession', autorunData);

			expect(logger.autorun).toHaveBeenCalledWith('Auto Run started', 'MySession', autorunData);
		});

		it('should handle unknown log level gracefully via default case', async () => {
			const handler = handlers.get('logger:log');
			await handler!({} as any, 'unknown-level', 'Unknown level message', 'TestContext');

			// Unknown levels fall through to default case which logs as info
			expect(logger.info).toHaveBeenCalledWith(
				'[unknown-level] Unknown level message',
				'TestContext',
				undefined
			);
		});
	});

	describe('logger:getLogs', () => {
		it('should return logs without filter', async () => {
			const mockLogs = [
				{ level: 'info', message: 'Test 1' },
				{ level: 'error', message: 'Test 2' },
			];
			vi.mocked(logger.getLogs).mockReturnValue(mockLogs);

			const handler = handlers.get('logger:getLogs');
			const result = await handler!({} as any);

			expect(logger.getLogs).toHaveBeenCalledWith(undefined);
			expect(result).toEqual(mockLogs);
		});

		it('should return logs with filter', async () => {
			const mockLogs = [{ level: 'error', message: 'Error only' }];
			vi.mocked(logger.getLogs).mockReturnValue(mockLogs);

			const handler = handlers.get('logger:getLogs');
			const result = await handler!({} as any, { level: 'error', limit: 10 });

			expect(logger.getLogs).toHaveBeenCalledWith({
				level: 'error',
				context: undefined,
				limit: 10,
			});
			expect(result).toEqual(mockLogs);
		});

		it('should pass context filter', async () => {
			vi.mocked(logger.getLogs).mockReturnValue([]);

			const handler = handlers.get('logger:getLogs');
			await handler!({} as any, { context: 'MyContext' });

			expect(logger.getLogs).toHaveBeenCalledWith({
				level: undefined,
				context: 'MyContext',
				limit: undefined,
			});
		});
	});

	describe('logger:clearLogs', () => {
		it('should clear all logs', async () => {
			const handler = handlers.get('logger:clearLogs');
			await handler!({} as any);

			expect(logger.clearLogs).toHaveBeenCalled();
		});
	});

	describe('logger:setLogLevel', () => {
		it('should set log level and persist to settings', async () => {
			const handler = handlers.get('logger:setLogLevel');
			await handler!({} as any, 'debug');

			expect(logger.setLogLevel).toHaveBeenCalledWith('debug');
			expect(mockSettingsStore.set).toHaveBeenCalledWith('logLevel', 'debug');
		});

		it('should set error log level', async () => {
			const handler = handlers.get('logger:setLogLevel');
			await handler!({} as any, 'error');

			expect(logger.setLogLevel).toHaveBeenCalledWith('error');
			expect(mockSettingsStore.set).toHaveBeenCalledWith('logLevel', 'error');
		});
	});

	describe('logger:getLogLevel', () => {
		it('should return current log level', async () => {
			vi.mocked(logger.getLogLevel).mockReturnValue('info');

			const handler = handlers.get('logger:getLogLevel');
			const result = await handler!({} as any);

			expect(result).toBe('info');
		});
	});

	describe('logger:setMaxLogBuffer', () => {
		it('should set max log buffer and persist to settings', async () => {
			const handler = handlers.get('logger:setMaxLogBuffer');
			await handler!({} as any, 5000);

			expect(logger.setMaxLogBuffer).toHaveBeenCalledWith(5000);
			expect(mockSettingsStore.set).toHaveBeenCalledWith('maxLogBuffer', 5000);
		});
	});

	describe('logger:getMaxLogBuffer', () => {
		it('should return current max log buffer', async () => {
			vi.mocked(logger.getMaxLogBuffer).mockReturnValue(1000);

			const handler = handlers.get('logger:getMaxLogBuffer');
			const result = await handler!({} as any);

			expect(result).toBe(1000);
		});
	});

	describe('logger:getLogFilePath', () => {
		it('should return log file path', async () => {
			vi.mocked(logger.getLogFilePath).mockReturnValue('/tmp/maestro-debug.log');

			const handler = handlers.get('logger:getLogFilePath');
			const result = await handler!({} as any);

			expect(result).toBe('/tmp/maestro-debug.log');
		});
	});

	describe('logger:isFileLoggingEnabled', () => {
		it('should return file logging status', async () => {
			vi.mocked(logger.isFileLoggingEnabled).mockReturnValue(true);

			const handler = handlers.get('logger:isFileLoggingEnabled');
			const result = await handler!({} as any);

			expect(result).toBe(true);
		});
	});

	describe('logger:enableFileLogging', () => {
		it('should enable file logging', async () => {
			const handler = handlers.get('logger:enableFileLogging');
			await handler!({} as any);

			expect(logger.enableFileLogging).toHaveBeenCalled();
		});
	});

	describe('sync:getDefaultPath', () => {
		it('should return default user data path', async () => {
			mockApp.getPath.mockReturnValue('/Users/test/Library/Application Support/Maestro');

			const handler = handlers.get('sync:getDefaultPath');
			const result = await handler!({} as any);

			expect(mockApp.getPath).toHaveBeenCalledWith('userData');
			expect(result).toBe('/Users/test/Library/Application Support/Maestro');
		});
	});

	describe('sync:getSettings', () => {
		it('should return custom sync path from bootstrap store', async () => {
			mockBootstrapStore.get.mockReturnValue('/custom/sync/path');

			const handler = handlers.get('sync:getSettings');
			const result = await handler!({} as any);

			expect(result).toEqual({ customSyncPath: '/custom/sync/path' });
		});

		it('should return undefined when no custom path set', async () => {
			mockBootstrapStore.get.mockReturnValue(null);

			const handler = handlers.get('sync:getSettings');
			const result = await handler!({} as any);

			expect(result).toEqual({ customSyncPath: undefined });
		});

		it('should return undefined when bootstrap store not available', async () => {
			deps.bootstrapStore = undefined;
			handlers.clear();
			registerSystemHandlers(deps);

			const handler = handlers.get('sync:getSettings');
			const result = await handler!({} as any);

			expect(result).toEqual({ customSyncPath: undefined });
		});
	});

	describe('sync:getCurrentStoragePath', () => {
		it('should return custom path when set', async () => {
			mockBootstrapStore.get.mockReturnValue('/custom/path');

			const handler = handlers.get('sync:getCurrentStoragePath');
			const result = await handler!({} as any);

			expect(result).toBe('/custom/path');
		});

		it('should return default path when no custom path set', async () => {
			mockBootstrapStore.get.mockReturnValue(null);
			mockApp.getPath.mockReturnValue('/default/path');

			const handler = handlers.get('sync:getCurrentStoragePath');
			const result = await handler!({} as any);

			expect(result).toBe('/default/path');
		});

		it('should return default path when bootstrap store not available', async () => {
			deps.bootstrapStore = undefined;
			mockApp.getPath.mockReturnValue('/default/path');
			handlers.clear();
			registerSystemHandlers(deps);

			const handler = handlers.get('sync:getCurrentStoragePath');
			const result = await handler!({} as any);

			expect(result).toBe('/default/path');
		});
	});

	describe('sync:selectSyncFolder', () => {
		it('should open dialog and return selected folder', async () => {
			vi.mocked(dialog.showOpenDialog).mockResolvedValue({
				canceled: false,
				filePaths: ['/iCloud/Maestro'],
			});

			const handler = handlers.get('sync:selectSyncFolder');
			const result = await handler!({} as any);

			expect(dialog.showOpenDialog).toHaveBeenCalledWith(mockMainWindow, {
				properties: ['openDirectory', 'createDirectory'],
				title: 'Select Settings Folder',
				message:
					'Choose a folder for Maestro settings. Use a synced folder (iCloud Drive, Dropbox, OneDrive) to share settings across devices.',
			});
			expect(result).toBe('/iCloud/Maestro');
		});

		it('should return null when dialog cancelled', async () => {
			vi.mocked(dialog.showOpenDialog).mockResolvedValue({
				canceled: true,
				filePaths: [],
			});

			const handler = handlers.get('sync:selectSyncFolder');
			const result = await handler!({} as any);

			expect(result).toBeNull();
		});

		it('should return null when no main window', async () => {
			deps.getMainWindow = () => null;
			handlers.clear();
			registerSystemHandlers(deps);

			const handler = handlers.get('sync:selectSyncFolder');
			const result = await handler!({} as any);

			expect(result).toBeNull();
		});
	});

	describe('sync:setCustomPath', () => {
		it('should return error when bootstrap store not available', async () => {
			deps.bootstrapStore = undefined;
			handlers.clear();
			registerSystemHandlers(deps);

			const handler = handlers.get('sync:setCustomPath');
			const result = await handler!({} as any, '/new/path');

			expect(result).toEqual({
				success: false,
				error: 'Bootstrap store not available',
			});
		});

		it('should return success when paths are the same', async () => {
			mockBootstrapStore.get.mockReturnValue('/same/path');
			mockApp.getPath.mockReturnValue('/default/path');

			const handler = handlers.get('sync:setCustomPath');
			const result = await handler!({} as any, '/same/path');

			expect(result).toEqual({ success: true, migrated: 0 });
		});

		it('should return success when resetting to default path that is current', async () => {
			mockBootstrapStore.get.mockReturnValue(null);
			mockApp.getPath.mockReturnValue('/default/path');

			const handler = handlers.get('sync:setCustomPath');
			const result = await handler!({} as any, null);

			expect(result).toEqual({ success: true, migrated: 0 });
		});

		it('should create target directory if it does not exist', async () => {
			mockBootstrapStore.get.mockReturnValue(null);
			mockApp.getPath.mockReturnValue('/default/path');
			vi.mocked(fsSync.existsSync).mockReturnValue(false);
			vi.mocked(fsSync.mkdirSync).mockImplementation(() => undefined);

			const handler = handlers.get('sync:setCustomPath');
			await handler!({} as any, '/new/path');

			expect(fsSync.mkdirSync).toHaveBeenCalledWith('/new/path', { recursive: true });
		});

		it('should return error when cannot create directory', async () => {
			mockBootstrapStore.get.mockReturnValue(null);
			mockApp.getPath.mockReturnValue('/default/path');
			vi.mocked(fsSync.existsSync).mockReturnValue(false);
			vi.mocked(fsSync.mkdirSync).mockImplementation(() => {
				throw new Error('Permission denied');
			});

			const handler = handlers.get('sync:setCustomPath');
			const result = await handler!({} as any, '/protected/path');

			expect(result).toEqual({
				success: false,
				error: 'Cannot create directory: /protected/path',
			});
		});

		it('should migrate settings files to new location', async () => {
			mockBootstrapStore.get.mockReturnValue(null);
			mockApp.getPath.mockReturnValue('/default/path');

			// Target directory exists
			vi.mocked(fsSync.existsSync).mockImplementation((path: any) => {
				if (path === '/new/path') return true;
				// Source files exist
				if (path.startsWith('/default/path/')) return true;
				return false;
			});

			const handler = handlers.get('sync:setCustomPath');
			const result = await handler!({} as any, '/new/path');

			expect(result.success).toBe(true);
			expect(result.migrated).toBeGreaterThan(0);
			expect(result.requiresRestart).toBe(true);
			expect(mockBootstrapStore.set).toHaveBeenCalledWith('customSyncPath', '/new/path');
		});

		it('should backup existing destination files', async () => {
			mockBootstrapStore.get.mockReturnValue(null);
			mockApp.getPath.mockReturnValue('/default/path');

			// All files exist in both locations with different content
			vi.mocked(fsSync.existsSync).mockReturnValue(true);
			vi.mocked(fsSync.readFileSync).mockImplementation((path: any) => {
				if (path.startsWith('/default/path')) return 'source content';
				return 'different content';
			});

			const handler = handlers.get('sync:setCustomPath');
			await handler!({} as any, '/new/path');

			// Should have created backups
			expect(fsSync.copyFileSync).toHaveBeenCalled();
		});

		it('should delete customSyncPath when setting to null', async () => {
			mockBootstrapStore.get.mockReturnValue('/custom/path');
			mockApp.getPath.mockReturnValue('/default/path');
			vi.mocked(fsSync.existsSync).mockReturnValue(true);

			const handler = handlers.get('sync:setCustomPath');
			await handler!({} as any, null);

			expect(mockBootstrapStore.delete).toHaveBeenCalledWith('customSyncPath');
		});

		it('should clean up legacy iCloudSyncEnabled flag', async () => {
			mockBootstrapStore.get.mockImplementation((key: string) => {
				if (key === 'customSyncPath') return null;
				if (key === 'iCloudSyncEnabled') return true;
				return null;
			});
			mockApp.getPath.mockReturnValue('/default/path');
			vi.mocked(fsSync.existsSync).mockReturnValue(true);

			const handler = handlers.get('sync:setCustomPath');
			await handler!({} as any, '/new/path');

			expect(mockBootstrapStore.delete).toHaveBeenCalledWith('iCloudSyncEnabled');
		});

		it('should handle file migration errors gracefully', async () => {
			mockBootstrapStore.get.mockReturnValue(null);
			mockApp.getPath.mockReturnValue('/default/path');
			vi.mocked(fsSync.existsSync).mockReturnValue(true);
			vi.mocked(fsSync.readFileSync).mockReturnValue('content');
			vi.mocked(fsSync.copyFileSync).mockImplementation(() => {
				throw new Error('Copy failed');
			});

			const handler = handlers.get('sync:setCustomPath');
			const result = await handler!({} as any, '/new/path');

			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors!.length).toBeGreaterThan(0);
		});
	});
});
