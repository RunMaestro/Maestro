import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerPlaybooksHandlers } from '../../main/ipc/handlers/playbooks';

const state = vi.hoisted(() => ({
	handlers: new Map<string, Function>(),
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
	showOpenDialog: vi.fn(),
	showSaveDialog: vi.fn(),
	zipEntriesByPath: new Map<
		string,
		Array<{
			entryName: string;
			isDirectory: boolean;
			getData: ReturnType<typeof vi.fn>;
		}>
	>(),
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: Function) => {
			state.handlers.set(channel, handler);
		}),
		removeHandler: vi.fn(),
	},
	dialog: {
		showOpenDialog: state.showOpenDialog,
		showSaveDialog: state.showSaveDialog,
	},
	BrowserWindow: vi.fn(),
	App: vi.fn(),
}));

vi.mock('../../main/utils/logger', () => ({
	logger: state.logger,
}));

vi.mock('adm-zip', () => ({
	default: vi.fn(function (zipPath: string) {
		return {
			getEntries: vi.fn(() => state.zipEntriesByPath.get(zipPath) ?? []),
		};
	}),
}));

async function invoke(channel: string, ...args: unknown[]) {
	const handler = state.handlers.get(channel);
	expect(handler, `missing handler for ${channel}`).toBeDefined();
	return handler?.({}, ...args);
}

async function readSessionFile(userDataPath: string, sessionId: string) {
	const filePath = path.join(userDataPath, 'playbooks', `${sessionId}.json`);
	const content = await fs.readFile(filePath, 'utf-8');
	return JSON.parse(content);
}

async function writeSessionFile(userDataPath: string, sessionId: string, playbooks: unknown[]) {
	const filePath = path.join(userDataPath, 'playbooks', `${sessionId}.json`);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify({ playbooks }, null, 2), 'utf-8');
}

function zipEntry(entryName: string, data: string | Buffer, isDirectory = false) {
	return {
		entryName,
		isDirectory,
		getData: vi.fn(() => (typeof data === 'string' ? Buffer.from(data) : data)),
	};
}

describe('playbooks IPC integration', () => {
	let tempRoot: string;
	let userDataPath: string;
	let mainWindow: object | null;

	beforeEach(async () => {
		vi.clearAllMocks();
		state.handlers.clear();
		state.zipEntriesByPath.clear();
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-playbooks-ipc-'));
		userDataPath = path.join(tempRoot, 'user-data');
		mainWindow = { id: 1 };

		registerPlaybooksHandlers({
			mainWindow: mainWindow as never,
			getMainWindow: () => mainWindow as never,
			app: {
				getPath: vi.fn(() => userDataPath),
			} as never,
		});
	});

	afterEach(() => {
		fsSync.rmSync(tempRoot, { recursive: true, force: true });
	});

	it('registers the playbook channels', () => {
		expect([...state.handlers.keys()]).toEqual([
			'playbooks:list',
			'playbooks:create',
			'playbooks:update',
			'playbooks:delete',
			'playbooks:deleteAll',
			'playbooks:export',
			'playbooks:import',
		]);
	});

	it('persists CRUD operations through real session files', async () => {
		const sessionId = 'session-crud';

		await expect(invoke('playbooks:list', sessionId)).resolves.toEqual({
			success: true,
			playbooks: [],
		});

		const first = await invoke('playbooks:create', sessionId, {
			name: 'First Playbook',
			documents: [{ filename: 'intro', resetOnCompletion: false }],
			loopEnabled: true,
			prompt: 'Run the intro playbook.',
		});
		const second = await invoke('playbooks:create', sessionId, {
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

		expect(first).toMatchObject({
			success: true,
			playbook: {
				name: 'First Playbook',
				documents: [{ filename: 'intro', resetOnCompletion: false }],
				loopEnabled: true,
				prompt: 'Run the intro playbook.',
			},
		});
		expect(first.playbook.id).toEqual(expect.any(String));
		expect(first.playbook.createdAt).toEqual(expect.any(Number));
		expect(first.playbook.updatedAt).toEqual(expect.any(Number));
		expect(second.playbook.worktreeSettings).toEqual({
			branchNameTemplate: 'feature/{name}',
			createPROnCompletion: true,
			prTargetBranch: 'main',
		});

		const saved = await readSessionFile(userDataPath, sessionId);
		expect(saved.playbooks).toHaveLength(2);

		const updateResult = await invoke('playbooks:update', sessionId, first.playbook.id, {
			name: 'Renamed Playbook',
			documents: [{ filename: 'renamed', resetOnCompletion: true }],
			loopEnabled: false,
			prompt: 'Updated prompt.',
			worktreeSettings: {
				branchNameTemplate: 'bugfix/{name}',
				createPROnCompletion: false,
			},
		});
		expect(updateResult).toMatchObject({
			success: true,
			playbook: {
				id: first.playbook.id,
				name: 'Renamed Playbook',
				documents: [{ filename: 'renamed', resetOnCompletion: true }],
				loopEnabled: false,
				prompt: 'Updated prompt.',
				worktreeSettings: {
					branchNameTemplate: 'bugfix/{name}',
					createPROnCompletion: false,
				},
			},
		});
		expect(updateResult.playbook.updatedAt).toBeGreaterThanOrEqual(first.playbook.updatedAt);

		await expect(invoke('playbooks:update', sessionId, 'missing-id', {})).resolves.toMatchObject({
			success: false,
			error: 'Error: Playbook not found',
		});

		await expect(invoke('playbooks:delete', sessionId, second.playbook.id)).resolves.toEqual({
			success: true,
		});
		await expect(invoke('playbooks:delete', sessionId, 'missing-id')).resolves.toMatchObject({
			success: false,
			error: 'Error: Playbook not found',
		});

		await expect(invoke('playbooks:list', sessionId)).resolves.toMatchObject({
			success: true,
			playbooks: [expect.objectContaining({ id: first.playbook.id, name: 'Renamed Playbook' })],
		});

		await expect(invoke('playbooks:deleteAll', sessionId)).resolves.toEqual({ success: true });
		await expect(invoke('playbooks:deleteAll', sessionId)).resolves.toEqual({ success: true });
		await expect(invoke('playbooks:list', sessionId)).resolves.toEqual({
			success: true,
			playbooks: [],
		});
	});

	it('handles invalid saved data and deleteAll filesystem failures', async () => {
		const invalidJsonSession = 'invalid-json';
		const invalidShapeSession = 'invalid-shape';
		const invalidJsonPath = path.join(userDataPath, 'playbooks', `${invalidJsonSession}.json`);
		const invalidShapePath = path.join(userDataPath, 'playbooks', `${invalidShapeSession}.json`);

		await fs.mkdir(path.dirname(invalidJsonPath), { recursive: true });
		await fs.writeFile(invalidJsonPath, '{not json', 'utf-8');
		await fs.writeFile(invalidShapePath, JSON.stringify({ playbooks: 'not-an-array' }), 'utf-8');

		await expect(invoke('playbooks:list', invalidJsonSession)).resolves.toEqual({
			success: true,
			playbooks: [],
		});
		await expect(invoke('playbooks:list', invalidShapeSession)).resolves.toEqual({
			success: true,
			playbooks: [],
		});

		const directorySession = 'directory-session';
		await fs.mkdir(path.join(userDataPath, 'playbooks', `${directorySession}.json`), {
			recursive: true,
		});

		const result = await invoke('playbooks:deleteAll', directorySession);
		expect(result.success).toBe(false);
		expect(result.error).toEqual(expect.stringContaining('Error:'));
	});

	it('exports playbooks to ZIP files with manifests, documents, and assets', async () => {
		const sessionId = 'session-export';
		const autoRunFolderPath = path.join(tempRoot, 'autorun');
		const zipPath = path.join(tempRoot, 'exports', 'playbook.zip');
		const playbook = {
			id: 'playbook-export',
			name: 'Playbook: Export/Import',
			createdAt: 100,
			updatedAt: 200,
			documents: [
				{ filename: 'chapters/intro', resetOnCompletion: false },
				{ filename: 'missing-doc', resetOnCompletion: true },
			],
			loopEnabled: true,
			maxLoops: 3,
			prompt: 'Export this playbook.',
			worktreeSettings: {
				branchNameTemplate: 'export/{name}',
				createPROnCompletion: true,
			},
		};

		await writeSessionFile(userDataPath, sessionId, [playbook]);
		await fs.mkdir(path.join(autoRunFolderPath, 'chapters', 'assets'), { recursive: true });
		await fs.mkdir(path.dirname(zipPath), { recursive: true });
		await fs.writeFile(path.join(autoRunFolderPath, 'chapters', 'intro.md'), '# Intro\n', 'utf-8');
		await fs.writeFile(
			path.join(autoRunFolderPath, 'chapters', 'assets', 'diagram.png'),
			Buffer.of(1, 2)
		);
		state.showSaveDialog.mockResolvedValue({ canceled: false, filePath: zipPath });

		await expect(
			invoke('playbooks:export', sessionId, playbook.id, autoRunFolderPath)
		).resolves.toEqual({
			success: true,
			filePath: zipPath,
		});

		const zipContents = await fs.readFile(zipPath);
		const zipText = zipContents.toString('latin1');

		expect(state.showSaveDialog).toHaveBeenCalledWith(
			mainWindow,
			expect.objectContaining({
				title: 'Export Playbook',
				defaultPath: 'Playbook__Export_Import.maestro-playbook.zip',
			})
		);
		expect(zipContents.length).toBeGreaterThan(0);
		expect(zipText).toContain('manifest.json');
		expect(zipText).toContain('documents/chapters/intro.md');
		expect(zipText).toContain('assets/diagram.png');
		expect(state.logger.warn).toHaveBeenCalledWith(
			'Document missing-doc.md not found during export',
			'[Playbooks]'
		);

		const noAssetsSessionId = 'session-export-no-assets';
		const noAssetsFolderPath = path.join(tempRoot, 'autorun-no-assets');
		const noAssetsZipPath = path.join(tempRoot, 'exports', 'no-assets.zip');
		await writeSessionFile(userDataPath, noAssetsSessionId, [
			{
				id: 'playbook-no-assets',
				name: 'No Assets',
				createdAt: 100,
				updatedAt: 200,
				documents: [{ filename: 'plain', resetOnCompletion: false }],
				loopEnabled: false,
				prompt: '',
			},
		]);
		await fs.mkdir(noAssetsFolderPath, { recursive: true });
		await fs.writeFile(path.join(noAssetsFolderPath, 'plain.md'), '# Plain\n', 'utf-8');
		state.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: noAssetsZipPath });
		await expect(
			invoke('playbooks:export', noAssetsSessionId, 'playbook-no-assets', noAssetsFolderPath)
		).resolves.toEqual({
			success: true,
			filePath: noAssetsZipPath,
		});
		expect(state.logger.debug).toHaveBeenCalledWith(
			'No assets/ folder found during export',
			'[Playbooks]'
		);

		await expect(
			invoke('playbooks:export', sessionId, 'missing-id', autoRunFolderPath)
		).resolves.toMatchObject({
			success: false,
			error: 'Error: Playbook not found',
		});
		state.showSaveDialog.mockResolvedValueOnce({ canceled: true });
		await expect(
			invoke('playbooks:export', sessionId, playbook.id, autoRunFolderPath)
		).resolves.toMatchObject({
			success: false,
			error: 'Error: Export cancelled',
		});

		mainWindow = null;
		await expect(
			invoke('playbooks:export', sessionId, playbook.id, autoRunFolderPath)
		).resolves.toMatchObject({
			success: false,
			error: 'Error: No main window available',
		});
	});

	it('imports ZIP playbooks into folders and persists a new playbook', async () => {
		const sessionId = 'session-import';
		const autoRunFolderPath = path.join(tempRoot, 'imported-autorun');
		const zipPath = path.join(tempRoot, 'incoming.maestro-playbook.zip');
		const manifest = {
			version: 1,
			name: 'Imported Playbook',
			documents: [{ filename: 'first', resetOnCompletion: false }],
			loopEnabled: true,
			maxLoops: 2,
			prompt: 'Imported prompt.',
			worktreeSettings: {
				branchNameTemplate: 'import/{name}',
				createPROnCompletion: false,
			},
		};
		state.zipEntriesByPath.set(zipPath, [
			zipEntry('manifest.json', JSON.stringify(manifest)),
			zipEntry('documents/first.md', '# First\n'),
			zipEntry('assets/screenshot.png', Buffer.of(7, 8, 9)),
		]);
		state.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [zipPath] });

		const result = await invoke('playbooks:import', sessionId, autoRunFolderPath);

		expect(result.success, result.error).toBe(true);
		expect(result).toMatchObject({
			success: true,
			playbook: {
				name: 'Imported Playbook',
				documents: manifest.documents,
				loopEnabled: true,
				maxLoops: 2,
				prompt: 'Imported prompt.',
				worktreeSettings: manifest.worktreeSettings,
			},
			importedDocs: ['first'],
			importedAssets: ['screenshot.png'],
		});
		expect(result.playbook.id).toEqual(expect.any(String));
		await expect(fs.readFile(path.join(autoRunFolderPath, 'first.md'), 'utf-8')).resolves.toBe(
			'# First\n'
		);
		await expect(
			fs.readFile(path.join(autoRunFolderPath, 'assets', 'screenshot.png'))
		).resolves.toEqual(Buffer.of(7, 8, 9));
		await expect(readSessionFile(userDataPath, sessionId)).resolves.toMatchObject({
			playbooks: [expect.objectContaining({ id: result.playbook.id, name: 'Imported Playbook' })],
		});
		expect(state.showOpenDialog).toHaveBeenCalledWith(
			mainWindow,
			expect.objectContaining({
				title: 'Import Playbook',
				properties: ['openFile'],
			})
		);
	});

	it('reports import validation and cancellation failures', async () => {
		const sessionId = 'session-import-errors';
		const autoRunFolderPath = path.join(tempRoot, 'autorun-errors');
		const missingManifestZip = path.join(tempRoot, 'missing-manifest.zip');
		const invalidManifestZip = path.join(tempRoot, 'invalid-manifest.zip');

		state.zipEntriesByPath.set(missingManifestZip, [zipEntry('documents/only.md', '# Only\n')]);
		state.zipEntriesByPath.set(invalidManifestZip, [
			zipEntry('manifest.json', JSON.stringify({ name: '', documents: null })),
		]);

		state.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
		await expect(invoke('playbooks:import', sessionId, autoRunFolderPath)).resolves.toMatchObject({
			success: false,
			error: 'Error: Import cancelled',
		});

		state.showOpenDialog.mockResolvedValueOnce({
			canceled: false,
			filePaths: [missingManifestZip],
		});
		await expect(invoke('playbooks:import', sessionId, autoRunFolderPath)).resolves.toMatchObject({
			success: false,
			error: 'Error: Invalid playbook file: missing manifest.json',
		});

		state.showOpenDialog.mockResolvedValueOnce({
			canceled: false,
			filePaths: [invalidManifestZip],
		});
		await expect(invoke('playbooks:import', sessionId, autoRunFolderPath)).resolves.toMatchObject({
			success: false,
			error: 'Error: Invalid playbook manifest',
		});

		mainWindow = null;
		await expect(invoke('playbooks:import', sessionId, autoRunFolderPath)).resolves.toMatchObject({
			success: false,
			error: 'Error: No main window available',
		});
	});
});
