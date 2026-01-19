/**
 * Tests for the playbooks IPC handlers
 *
 * These tests verify the playbook CRUD operations including
 * list, create, update, delete, deleteAll, export, and import.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, dialog, BrowserWindow, App } from 'electron';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import crypto from 'crypto';
import archiver from 'archiver';
import AdmZip from 'adm-zip';
import { PassThrough } from 'stream';
import {
	registerPlaybooksHandlers,
	PlaybooksHandlerDependencies,
} from '../../../../main/ipc/handlers/playbooks';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	dialog: {
		showSaveDialog: vi.fn(),
		showOpenDialog: vi.fn(),
	},
	app: {
		getPath: vi.fn(),
	},
	BrowserWindow: vi.fn(),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
		unlink: vi.fn(),
	},
}));

// Mock fs for createWriteStream
vi.mock('fs', () => {
	const mockFn = vi.fn();
	return {
		default: {
			createWriteStream: mockFn,
		},
		createWriteStream: mockFn,
	};
});

// Mock archiver
vi.mock('archiver', () => ({
	default: vi.fn(),
}));

// Mock adm-zip - AdmZip is used as a class constructor with `new`
// Using a class mock to properly handle constructor calls
vi.mock('adm-zip', () => {
	const MockAdmZip = vi.fn(function (this: { getEntries: () => any[] }) {
		this.getEntries = vi.fn().mockReturnValue([]);
		return this;
	});
	return {
		default: MockAdmZip,
	};
});

// Mock crypto
vi.mock('crypto', () => ({
	default: {
		randomUUID: vi.fn(),
	},
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

describe('playbooks IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockApp: App;
	let mockMainWindow: BrowserWindow;
	let mockDeps: PlaybooksHandlerDependencies;

	beforeEach(() => {
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Setup mock app
		mockApp = {
			getPath: vi.fn().mockReturnValue('/mock/userData'),
		} as unknown as App;

		// Setup mock main window
		mockMainWindow = {} as BrowserWindow;

		// Setup dependencies
		mockDeps = {
			mainWindow: mockMainWindow,
			getMainWindow: () => mockMainWindow,
			app: mockApp,
		};

		// Default mock for crypto.randomUUID
		vi.mocked(crypto.randomUUID).mockReturnValue('test-uuid-123');

		// Register handlers
		registerPlaybooksHandlers(mockDeps);
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all playbooks handlers', () => {
			const expectedChannels = [
				'playbooks:list',
				'playbooks:create',
				'playbooks:update',
				'playbooks:delete',
				'playbooks:deleteAll',
				'playbooks:export',
				'playbooks:import',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('playbooks:list', () => {
		it('should return array of playbooks for a session', async () => {
			const mockPlaybooks = [
				{ id: 'pb-1', name: 'Test Playbook 1' },
				{ id: 'pb-2', name: 'Test Playbook 2' },
			];

			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ playbooks: mockPlaybooks }));

			const handler = handlers.get('playbooks:list');
			const result = await handler!({} as any, 'session-123');

			expect(fs.readFile).toHaveBeenCalledWith(
				'/mock/userData/playbooks/session-123.json',
				'utf-8'
			);
			expect(result).toEqual({ success: true, playbooks: mockPlaybooks });
		});

		it('should return empty array when file does not exist', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

			const handler = handlers.get('playbooks:list');
			const result = await handler!({} as any, 'session-123');

			expect(result).toEqual({ success: true, playbooks: [] });
		});

		it('should return empty array for invalid JSON', async () => {
			vi.mocked(fs.readFile).mockResolvedValue('invalid json');

			const handler = handlers.get('playbooks:list');
			const result = await handler!({} as any, 'session-123');

			expect(result).toEqual({ success: true, playbooks: [] });
		});

		it('should return empty array when playbooks is not an array', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ playbooks: 'not an array' }));

			const handler = handlers.get('playbooks:list');
			const result = await handler!({} as any, 'session-123');

			expect(result).toEqual({ success: true, playbooks: [] });
		});
	});

	describe('playbooks:create', () => {
		it('should create a new playbook with generated ID', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT')); // No existing file
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('playbooks:create');
			const result = await handler!({} as any, 'session-123', {
				name: 'New Playbook',
				documents: [{ filename: 'doc1', order: 0 }],
				loopEnabled: true,
				prompt: 'Test prompt',
			});

			expect(result.success).toBe(true);
			expect(result.playbook).toMatchObject({
				id: 'test-uuid-123',
				name: 'New Playbook',
				documents: [{ filename: 'doc1', order: 0 }],
				loopEnabled: true,
				prompt: 'Test prompt',
			});
			expect(result.playbook.createdAt).toBeDefined();
			expect(result.playbook.updatedAt).toBeDefined();
		});

		it('should create a playbook with worktree settings', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('playbooks:create');
			const result = await handler!({} as any, 'session-123', {
				name: 'Worktree Playbook',
				documents: [],
				loopEnabled: false,
				prompt: '',
				worktreeSettings: {
					branchNameTemplate: 'feature/{name}',
					createPROnCompletion: true,
					prTargetBranch: 'main',
				},
			});

			expect(result.success).toBe(true);
			expect(result.playbook.worktreeSettings).toEqual({
				branchNameTemplate: 'feature/{name}',
				createPROnCompletion: true,
				prTargetBranch: 'main',
			});
		});

		it('should add to existing playbooks list', async () => {
			const existingPlaybooks = [{ id: 'existing-1', name: 'Existing' }];
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ playbooks: existingPlaybooks }));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('playbooks:create');
			await handler!({} as any, 'session-123', {
				name: 'New Playbook',
				documents: [],
				loopEnabled: false,
				prompt: '',
			});

			expect(fs.writeFile).toHaveBeenCalled();
			const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
			const written = JSON.parse(writeCall[1] as string);
			expect(written.playbooks).toHaveLength(2);
		});

		it('should ensure playbooks directory exists', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('playbooks:create');
			await handler!({} as any, 'session-123', {
				name: 'New Playbook',
				documents: [],
				loopEnabled: false,
				prompt: '',
			});

			expect(fs.mkdir).toHaveBeenCalledWith('/mock/userData/playbooks', {
				recursive: true,
			});
		});
	});

	describe('playbooks:update', () => {
		it('should update an existing playbook', async () => {
			const existingPlaybooks = [{ id: 'pb-1', name: 'Original', prompt: 'old prompt' }];
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ playbooks: existingPlaybooks }));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('playbooks:update');
			const result = await handler!({} as any, 'session-123', 'pb-1', {
				name: 'Updated',
				prompt: 'new prompt',
			});

			expect(result.success).toBe(true);
			expect(result.playbook.name).toBe('Updated');
			expect(result.playbook.prompt).toBe('new prompt');
			expect(result.playbook.updatedAt).toBeDefined();
		});

		it('should return error for non-existent playbook', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ playbooks: [] }));

			const handler = handlers.get('playbooks:update');
			const result = await handler!({} as any, 'session-123', 'non-existent', {
				name: 'Updated',
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain('Playbook not found');
		});

		it('should preserve existing fields when updating', async () => {
			const existingPlaybooks = [
				{
					id: 'pb-1',
					name: 'Original',
					prompt: 'keep this',
					loopEnabled: true,
					documents: [{ filename: 'doc1' }],
				},
			];
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ playbooks: existingPlaybooks }));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('playbooks:update');
			const result = await handler!({} as any, 'session-123', 'pb-1', {
				name: 'Updated Name',
			});

			expect(result.success).toBe(true);
			expect(result.playbook.name).toBe('Updated Name');
			expect(result.playbook.prompt).toBe('keep this');
			expect(result.playbook.loopEnabled).toBe(true);
		});
	});

	describe('playbooks:delete', () => {
		it('should delete an existing playbook', async () => {
			const existingPlaybooks = [
				{ id: 'pb-1', name: 'To Delete' },
				{ id: 'pb-2', name: 'Keep' },
			];
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ playbooks: existingPlaybooks }));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('playbooks:delete');
			const result = await handler!({} as any, 'session-123', 'pb-1');

			expect(result.success).toBe(true);

			const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
			const written = JSON.parse(writeCall[1] as string);
			expect(written.playbooks).toHaveLength(1);
			expect(written.playbooks[0].id).toBe('pb-2');
		});

		it('should return error for non-existent playbook', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ playbooks: [] }));

			const handler = handlers.get('playbooks:delete');
			const result = await handler!({} as any, 'session-123', 'non-existent');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Playbook not found');
		});
	});

	describe('playbooks:deleteAll', () => {
		it('should delete the playbooks file for a session', async () => {
			vi.mocked(fs.unlink).mockResolvedValue(undefined);

			const handler = handlers.get('playbooks:deleteAll');
			const result = await handler!({} as any, 'session-123');

			expect(fs.unlink).toHaveBeenCalledWith('/mock/userData/playbooks/session-123.json');
			expect(result).toEqual({ success: true });
		});

		it('should not throw error when file does not exist', async () => {
			const error: NodeJS.ErrnoException = new Error('File not found');
			error.code = 'ENOENT';
			vi.mocked(fs.unlink).mockRejectedValue(error);

			const handler = handlers.get('playbooks:deleteAll');
			const result = await handler!({} as any, 'session-123');

			expect(result).toEqual({ success: true });
		});

		it('should propagate other errors', async () => {
			const error: NodeJS.ErrnoException = new Error('Permission denied');
			error.code = 'EACCES';
			vi.mocked(fs.unlink).mockRejectedValue(error);

			const handler = handlers.get('playbooks:deleteAll');
			const result = await handler!({} as any, 'session-123');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Permission denied');
		});
	});

	describe('playbooks:export', () => {
		it('should export playbook as ZIP file', async () => {
			const existingPlaybooks = [
				{
					id: 'pb-1',
					name: 'Export Me',
					documents: [{ filename: 'doc1', order: 0 }],
					loopEnabled: true,
					prompt: 'Test prompt',
				},
			];
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify({ playbooks: existingPlaybooks }))
				.mockResolvedValueOnce('# Document content');

			vi.mocked(dialog.showSaveDialog).mockResolvedValue({
				canceled: false,
				filePath: '/export/path/Export_Me.maestro-playbook.zip',
			});

			// Mock archiver
			const mockArchive = {
				pipe: vi.fn(),
				append: vi.fn(),
				finalize: vi.fn().mockResolvedValue(undefined),
				on: vi.fn(),
			};
			vi.mocked(archiver).mockReturnValue(mockArchive as any);

			// Mock write stream
			const mockStream = new PassThrough();
			vi.mocked(createWriteStream).mockReturnValue(mockStream as any);

			// Simulate stream close event
			setTimeout(() => mockStream.emit('close'), 10);

			const handler = handlers.get('playbooks:export');
			const result = await handler!({} as any, 'session-123', 'pb-1', '/autorun/path');

			expect(result.success).toBe(true);
			expect(result.filePath).toBe('/export/path/Export_Me.maestro-playbook.zip');
			expect(mockArchive.append).toHaveBeenCalled();
		});

		it('should return error when playbook not found', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ playbooks: [] }));

			const handler = handlers.get('playbooks:export');
			const result = await handler!({} as any, 'session-123', 'non-existent', '/autorun/path');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Playbook not found');
		});

		it('should return error when main window not available', async () => {
			const depsWithNoWindow: PlaybooksHandlerDependencies = {
				...mockDeps,
				getMainWindow: () => null,
			};

			handlers.clear();
			registerPlaybooksHandlers(depsWithNoWindow);

			const existingPlaybooks = [{ id: 'pb-1', name: 'Export Me' }];
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ playbooks: existingPlaybooks }));

			const handler = handlers.get('playbooks:export');
			const result = await handler!({} as any, 'session-123', 'pb-1', '/autorun/path');

			expect(result.success).toBe(false);
			expect(result.error).toContain('No main window available');
		});

		it('should handle cancelled export dialog', async () => {
			const existingPlaybooks = [{ id: 'pb-1', name: 'Export Me' }];
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ playbooks: existingPlaybooks }));

			vi.mocked(dialog.showSaveDialog).mockResolvedValue({
				canceled: true,
				filePath: undefined,
			});

			const handler = handlers.get('playbooks:export');
			const result = await handler!({} as any, 'session-123', 'pb-1', '/autorun/path');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Export cancelled');
		});

		it('should handle missing document files during export', async () => {
			const existingPlaybooks = [
				{
					id: 'pb-1',
					name: 'Export Me',
					documents: [{ filename: 'missing-doc', order: 0 }],
				},
			];
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify({ playbooks: existingPlaybooks }))
				.mockRejectedValueOnce(new Error('ENOENT')); // Document file not found

			vi.mocked(dialog.showSaveDialog).mockResolvedValue({
				canceled: false,
				filePath: '/export/path/Export_Me.zip',
			});

			const mockArchive = {
				pipe: vi.fn(),
				append: vi.fn(),
				finalize: vi.fn().mockResolvedValue(undefined),
				on: vi.fn(),
			};
			vi.mocked(archiver).mockReturnValue(mockArchive as any);

			const mockStream = new PassThrough();
			vi.mocked(createWriteStream).mockReturnValue(mockStream as any);

			setTimeout(() => mockStream.emit('close'), 10);

			const handler = handlers.get('playbooks:export');
			const result = await handler!({} as any, 'session-123', 'pb-1', '/autorun/path');

			expect(result.success).toBe(true);
			// The export should still succeed, just skip the missing document
		});
	});

	describe('playbooks:import', () => {
		it('should import playbook from ZIP file', async () => {
			vi.mocked(dialog.showOpenDialog).mockResolvedValue({
				canceled: false,
				filePaths: ['/import/path/playbook.zip'],
			});

			// Mock AdmZip
			const mockManifest = {
				name: 'Imported Playbook',
				documents: [{ filename: 'doc1', order: 0 }],
				loopEnabled: true,
				prompt: 'Test prompt',
			};

			const mockEntries = [
				{
					entryName: 'manifest.json',
					getData: () => Buffer.from(JSON.stringify(mockManifest)),
				},
				{
					entryName: 'documents/doc1.md',
					getData: () => Buffer.from('# Document content'),
				},
			];

			// Mock AdmZip instance
			vi.mocked(AdmZip).mockImplementation(function (this: any) {
				this.getEntries = () => mockEntries;
				return this;
			} as any);

			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT')); // No existing playbooks
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('playbooks:import');
			const result = await handler!({} as any, 'session-123', '/autorun/path');

			expect(result.success).toBe(true);
			expect(result.playbook.name).toBe('Imported Playbook');
			expect(result.playbook.id).toBe('test-uuid-123');
			expect(result.importedDocs).toEqual(['doc1']);
		});

		it('should return error when main window not available', async () => {
			const depsWithNoWindow: PlaybooksHandlerDependencies = {
				...mockDeps,
				getMainWindow: () => null,
			};

			handlers.clear();
			registerPlaybooksHandlers(depsWithNoWindow);

			const handler = handlers.get('playbooks:import');
			const result = await handler!({} as any, 'session-123', '/autorun/path');

			expect(result.success).toBe(false);
			expect(result.error).toContain('No main window available');
		});

		it('should handle cancelled import dialog', async () => {
			vi.mocked(dialog.showOpenDialog).mockResolvedValue({
				canceled: true,
				filePaths: [],
			});

			const handler = handlers.get('playbooks:import');
			const result = await handler!({} as any, 'session-123', '/autorun/path');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Import cancelled');
		});

		it('should return error for ZIP without manifest', async () => {
			vi.mocked(dialog.showOpenDialog).mockResolvedValue({
				canceled: false,
				filePaths: ['/import/path/playbook.zip'],
			});

			vi.mocked(AdmZip).mockImplementation(function (this: any) {
				this.getEntries = () => []; // No entries
				return this;
			} as any);

			const handler = handlers.get('playbooks:import');
			const result = await handler!({} as any, 'session-123', '/autorun/path');

			expect(result.success).toBe(false);
			expect(result.error).toContain('missing manifest.json');
		});

		it('should return error for invalid manifest', async () => {
			vi.mocked(dialog.showOpenDialog).mockResolvedValue({
				canceled: false,
				filePaths: ['/import/path/playbook.zip'],
			});

			const mockEntries = [
				{
					entryName: 'manifest.json',
					getData: () => Buffer.from(JSON.stringify({ invalid: true })), // Missing name and documents
				},
			];

			vi.mocked(AdmZip).mockImplementation(function (this: any) {
				this.getEntries = () => mockEntries;
				return this;
			} as any);

			const handler = handlers.get('playbooks:import');
			const result = await handler!({} as any, 'session-123', '/autorun/path');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid playbook manifest');
		});

		it('should apply default values for optional manifest fields', async () => {
			vi.mocked(dialog.showOpenDialog).mockResolvedValue({
				canceled: false,
				filePaths: ['/import/path/playbook.zip'],
			});

			const mockManifest = {
				name: 'Minimal Playbook',
				documents: [],
				// loopEnabled, prompt, worktreeSettings not provided
			};

			const mockEntries = [
				{
					entryName: 'manifest.json',
					getData: () => Buffer.from(JSON.stringify(mockManifest)),
				},
			];

			vi.mocked(AdmZip).mockImplementation(function (this: any) {
				this.getEntries = () => mockEntries;
				return this;
			} as any);

			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('playbooks:import');
			const result = await handler!({} as any, 'session-123', '/autorun/path');

			expect(result.success).toBe(true);
			expect(result.playbook.loopEnabled).toBe(false);
			expect(result.playbook.prompt).toBe('');
		});

		it('should create autorun folder if it does not exist', async () => {
			vi.mocked(dialog.showOpenDialog).mockResolvedValue({
				canceled: false,
				filePaths: ['/import/path/playbook.zip'],
			});

			const mockManifest = {
				name: 'Import with Docs',
				documents: [{ filename: 'doc1', order: 0 }],
			};

			const mockEntries = [
				{
					entryName: 'manifest.json',
					getData: () => Buffer.from(JSON.stringify(mockManifest)),
				},
				{
					entryName: 'documents/doc1.md',
					getData: () => Buffer.from('# Content'),
				},
			];

			vi.mocked(AdmZip).mockImplementation(function (this: any) {
				this.getEntries = () => mockEntries;
				return this;
			} as any);

			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('playbooks:import');
			await handler!({} as any, 'session-123', '/autorun/path');

			expect(fs.mkdir).toHaveBeenCalledWith('/autorun/path', { recursive: true });
		});
	});
});
