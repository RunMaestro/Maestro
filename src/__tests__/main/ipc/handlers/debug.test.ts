/**
 * Tests for the debug IPC handlers
 *
 * These tests verify the debug package generation and preview handlers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, dialog, BrowserWindow } from 'electron';
import Store from 'electron-store';
import path from 'path';
import {
	registerDebugHandlers,
	DebugHandlerDependencies,
} from '../../../../main/ipc/handlers/debug';
import * as debugPackage from '../../../../main/debug-package';
import { AgentDetector } from '../../../../main/agent-detector';
import { ProcessManager } from '../../../../main/process-manager';
import { WebServer } from '../../../../main/web-server';

// Mock electron's ipcMain and dialog
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	dialog: {
		showSaveDialog: vi.fn(),
	},
	BrowserWindow: vi.fn(),
}));

// Mock path module
vi.mock('path', () => ({
	default: {
		dirname: vi.fn(),
	},
}));

// Mock debug-package module
vi.mock('../../../../main/debug-package', () => ({
	generateDebugPackage: vi.fn(),
	previewDebugPackage: vi.fn(),
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

describe('debug IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockMainWindow: BrowserWindow;
	let mockAgentDetector: AgentDetector;
	let mockProcessManager: ProcessManager;
	let mockWebServer: WebServer;
	let mockSettingsStore: Store<any>;
	let mockSessionsStore: Store<any>;
	let mockGroupsStore: Store<any>;
	let mockBootstrapStore: Store<any>;
	let mockDeps: DebugHandlerDependencies;

	beforeEach(() => {
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Setup mock main window
		mockMainWindow = {} as BrowserWindow;

		// Setup mock agent detector
		mockAgentDetector = {} as AgentDetector;

		// Setup mock process manager
		mockProcessManager = {} as ProcessManager;

		// Setup mock web server
		mockWebServer = {} as WebServer;

		// Setup mock stores
		mockSettingsStore = { get: vi.fn(), set: vi.fn() } as unknown as Store<any>;
		mockSessionsStore = { get: vi.fn(), set: vi.fn() } as unknown as Store<any>;
		mockGroupsStore = { get: vi.fn(), set: vi.fn() } as unknown as Store<any>;
		mockBootstrapStore = { get: vi.fn(), set: vi.fn() } as unknown as Store<any>;

		// Setup dependencies
		mockDeps = {
			getMainWindow: () => mockMainWindow,
			getAgentDetector: () => mockAgentDetector,
			getProcessManager: () => mockProcessManager,
			getWebServer: () => mockWebServer,
			settingsStore: mockSettingsStore,
			sessionsStore: mockSessionsStore,
			groupsStore: mockGroupsStore,
			bootstrapStore: mockBootstrapStore,
		};

		// Register handlers
		registerDebugHandlers(mockDeps);
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all debug handlers', () => {
			const expectedChannels = ['debug:createPackage', 'debug:previewPackage'];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('debug:createPackage', () => {
		it('should create debug package with selected file path', async () => {
			const mockFilePath = '/export/path/maestro-debug-2024-01-01.zip';
			const mockOutputDir = '/export/path';

			vi.mocked(dialog.showSaveDialog).mockResolvedValue({
				canceled: false,
				filePath: mockFilePath,
			});

			vi.mocked(path.dirname).mockReturnValue(mockOutputDir);

			vi.mocked(debugPackage.generateDebugPackage).mockResolvedValue({
				success: true,
				path: mockFilePath,
				filesIncluded: ['system-info.json', 'settings.json', 'logs.json'],
				totalSizeBytes: 12345,
			});

			const handler = handlers.get('debug:createPackage');
			const result = await handler!({} as any);

			expect(dialog.showSaveDialog).toHaveBeenCalledWith(
				mockMainWindow,
				expect.objectContaining({
					title: 'Save Debug Package',
					filters: [{ name: 'Zip Files', extensions: ['zip'] }],
				})
			);
			expect(debugPackage.generateDebugPackage).toHaveBeenCalledWith(
				mockOutputDir,
				expect.objectContaining({
					getAgentDetector: expect.any(Function),
					getProcessManager: expect.any(Function),
					getWebServer: expect.any(Function),
					settingsStore: mockSettingsStore,
					sessionsStore: mockSessionsStore,
					groupsStore: mockGroupsStore,
					bootstrapStore: mockBootstrapStore,
				}),
				undefined
			);
			expect(result).toEqual({
				success: true,
				path: mockFilePath,
				filesIncluded: ['system-info.json', 'settings.json', 'logs.json'],
				totalSizeBytes: 12345,
				cancelled: false,
			});
		});

		it('should pass options to generateDebugPackage', async () => {
			const mockFilePath = '/export/path/maestro-debug.zip';
			const mockOutputDir = '/export/path';
			const options = {
				includeLogs: false,
				includeErrors: false,
				includeSessions: true,
			};

			vi.mocked(dialog.showSaveDialog).mockResolvedValue({
				canceled: false,
				filePath: mockFilePath,
			});

			vi.mocked(path.dirname).mockReturnValue(mockOutputDir);

			vi.mocked(debugPackage.generateDebugPackage).mockResolvedValue({
				success: true,
				path: mockFilePath,
				filesIncluded: ['system-info.json', 'settings.json'],
				totalSizeBytes: 5000,
			});

			const handler = handlers.get('debug:createPackage');
			await handler!({} as any, options);

			expect(debugPackage.generateDebugPackage).toHaveBeenCalledWith(
				mockOutputDir,
				expect.any(Object),
				options
			);
		});

		it('should return cancelled result when dialog is cancelled', async () => {
			vi.mocked(dialog.showSaveDialog).mockResolvedValue({
				canceled: true,
				filePath: undefined,
			});

			const handler = handlers.get('debug:createPackage');
			const result = await handler!({} as any);

			expect(result).toEqual({
				success: true,
				path: null,
				filesIncluded: [],
				totalSizeBytes: 0,
				cancelled: true,
			});
			expect(debugPackage.generateDebugPackage).not.toHaveBeenCalled();
		});

		it('should return error when main window is not available', async () => {
			const depsWithNoWindow: DebugHandlerDependencies = {
				...mockDeps,
				getMainWindow: () => null,
			};

			handlers.clear();
			registerDebugHandlers(depsWithNoWindow);

			const handler = handlers.get('debug:createPackage');
			const result = await handler!({} as any);

			expect(result.success).toBe(false);
			expect(result.error).toContain('No main window available');
		});

		it('should return error when generateDebugPackage fails', async () => {
			const mockFilePath = '/export/path/maestro-debug.zip';
			const mockOutputDir = '/export/path';

			vi.mocked(dialog.showSaveDialog).mockResolvedValue({
				canceled: false,
				filePath: mockFilePath,
			});

			vi.mocked(path.dirname).mockReturnValue(mockOutputDir);

			vi.mocked(debugPackage.generateDebugPackage).mockResolvedValue({
				success: false,
				error: 'Failed to create zip file',
				filesIncluded: [],
				totalSizeBytes: 0,
			});

			const handler = handlers.get('debug:createPackage');
			const result = await handler!({} as any);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to create zip file');
		});

		it('should return error when generateDebugPackage throws', async () => {
			const mockFilePath = '/export/path/maestro-debug.zip';
			const mockOutputDir = '/export/path';

			vi.mocked(dialog.showSaveDialog).mockResolvedValue({
				canceled: false,
				filePath: mockFilePath,
			});

			vi.mocked(path.dirname).mockReturnValue(mockOutputDir);

			vi.mocked(debugPackage.generateDebugPackage).mockRejectedValue(
				new Error('Unexpected error during package generation')
			);

			const handler = handlers.get('debug:createPackage');
			const result = await handler!({} as any);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Unexpected error during package generation');
		});
	});

	describe('debug:previewPackage', () => {
		it('should return preview categories', async () => {
			const mockPreview = {
				categories: [
					{ id: 'system', name: 'System Information', included: true, sizeEstimate: '< 1 KB' },
					{ id: 'settings', name: 'Settings', included: true, sizeEstimate: '< 5 KB' },
					{ id: 'agents', name: 'Agent Configurations', included: true, sizeEstimate: '< 2 KB' },
				],
			};

			vi.mocked(debugPackage.previewDebugPackage).mockReturnValue(mockPreview);

			const handler = handlers.get('debug:previewPackage');
			const result = await handler!({} as any);

			expect(debugPackage.previewDebugPackage).toHaveBeenCalled();
			expect(result).toEqual({
				success: true,
				categories: mockPreview.categories,
			});
		});

		it('should return all expected category types', async () => {
			const mockPreview = {
				categories: [
					{ id: 'system', name: 'System Information', included: true, sizeEstimate: '< 1 KB' },
					{ id: 'settings', name: 'Settings', included: true, sizeEstimate: '< 5 KB' },
					{ id: 'agents', name: 'Agent Configurations', included: true, sizeEstimate: '< 2 KB' },
					{ id: 'externalTools', name: 'External Tools', included: true, sizeEstimate: '< 2 KB' },
					{
						id: 'windowsDiagnostics',
						name: 'Windows Diagnostics',
						included: true,
						sizeEstimate: '< 10 KB',
					},
					{ id: 'sessions', name: 'Session Metadata', included: true, sizeEstimate: '~10-50 KB' },
					{ id: 'logs', name: 'System Logs', included: true, sizeEstimate: '~50-200 KB' },
					{ id: 'errors', name: 'Error States', included: true, sizeEstimate: '< 10 KB' },
					{ id: 'webServer', name: 'Web Server State', included: true, sizeEstimate: '< 2 KB' },
					{ id: 'storage', name: 'Storage Info', included: true, sizeEstimate: '< 2 KB' },
					{ id: 'groupChats', name: 'Group Chat Metadata', included: true, sizeEstimate: '< 5 KB' },
					{ id: 'batchState', name: 'Auto Run State', included: true, sizeEstimate: '< 5 KB' },
				],
			};

			vi.mocked(debugPackage.previewDebugPackage).mockReturnValue(mockPreview);

			const handler = handlers.get('debug:previewPackage');
			const result = await handler!({} as any);

			expect(result.success).toBe(true);
			expect(result.categories).toHaveLength(12);
			expect(
				result.categories.every((c: any) => c.id && c.name && c.sizeEstimate !== undefined)
			).toBe(true);
		});

		it('should handle errors from previewDebugPackage', async () => {
			vi.mocked(debugPackage.previewDebugPackage).mockImplementation(() => {
				throw new Error('Preview generation failed');
			});

			const handler = handlers.get('debug:previewPackage');
			const result = await handler!({} as any);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Preview generation failed');
		});
	});
});
