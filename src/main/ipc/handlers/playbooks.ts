import { ipcMain, BrowserWindow, App, dialog } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createWriteStream } from 'fs';
import archiver from 'archiver';
import { readZipArchive } from '../../utils/zip-archive';
import { logger } from '../../utils/logger';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	isPlaybookSourceChannel,
	readPlaybookExchangeHints,
	type Playbook,
	type PlaybookSourceProvenance,
	type PlaybookUpdate,
} from '../../../shared/types';
import { readPlaybookParamOverlay, readPlaybookParamValues } from '../../../shared/playbookParams';
import { hashPlaybookDocument } from '../../utils/playbook-document-hash';

const LOG_CONTEXT = '[Playbooks]';

/**
 * The ZIP `manifest.json` format. Version 2 adds the Exchange fields
 * (`parameterValues`, `parameterOverlay`, `interaction`, `scope`, `report`,
 * and the marketplace link of `provenance`). Version 1 has none of them and
 * still imports: every one is optional.
 */
const PLAYBOOK_ZIP_MANIFEST_VERSION = 2;

type PlaybookExchangeFields = Pick<
	Playbook,
	'parameterValues' | 'parameterOverlay' | 'interaction' | 'scope' | 'report'
>;

/**
 * Read the Exchange fields out of an untrusted ZIP manifest. A field with the
 * wrong shape is dropped rather than stored, so a hand-edited ZIP cannot put
 * a value on the record that the run engines would trip over.
 */
function readPlaybookExchangeFields(manifest: Record<string, unknown>): PlaybookExchangeFields {
	const fields: PlaybookExchangeFields = {};
	const parameterValues = readPlaybookParamValues(manifest.parameterValues);
	if (parameterValues) fields.parameterValues = parameterValues;
	const parameterOverlay = readPlaybookParamOverlay(manifest.parameterOverlay);
	if (parameterOverlay) fields.parameterOverlay = parameterOverlay;
	return { ...fields, ...readPlaybookExchangeHints(manifest) };
}

/**
 * The part of a record's provenance a ZIP carries: the link back to the
 * marketplace entry. Local paths, timestamps, and hashes describe the
 * exporting machine's copy, so they stay behind; import stamps its own.
 */
function exportedProvenance(
	provenance: PlaybookSourceProvenance | undefined
): Partial<PlaybookSourceProvenance> | undefined {
	if (!provenance) return undefined;
	const link: Partial<PlaybookSourceProvenance> = { kind: provenance.kind };
	if (provenance.marketplaceId) link.marketplaceId = provenance.marketplaceId;
	if (provenance.sourceVersion) link.sourceVersion = provenance.sourceVersion;
	if (provenance.sourceChannel) link.sourceChannel = provenance.sourceChannel;
	return link;
}

/**
 * Provenance for a playbook imported from a ZIP. It is always `kind: 'zip'`;
 * a marketplace link the ZIP carried is kept so the record still names its
 * Exchange entry.
 */
function zipImportProvenance(
	manifest: Record<string, unknown>,
	zipPath: string,
	autoRunFolderPath: string,
	documentHashes: Record<string, string>,
	importedAt: number
): PlaybookSourceProvenance {
	const provenance: PlaybookSourceProvenance = {
		kind: 'zip',
		sourcePath: zipPath,
		targetFolderName: path.basename(autoRunFolderPath),
		importedAt,
		documentHashes,
	};
	const carried = manifest.provenance;
	if (carried && typeof carried === 'object' && !Array.isArray(carried)) {
		const link = carried as Record<string, unknown>;
		if (typeof link.marketplaceId === 'string') provenance.marketplaceId = link.marketplaceId;
		if (typeof link.sourceVersion === 'string') provenance.sourceVersion = link.sourceVersion;
		if (isPlaybookSourceChannel(link.sourceChannel)) provenance.sourceChannel = link.sourceChannel;
	}
	return provenance;
}

// Helper to create handler options with consistent context
const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});

/**
 * Dependencies required for playbooks handler registration
 */
export interface PlaybooksHandlerDependencies {
	mainWindow: BrowserWindow | null;
	getMainWindow: () => BrowserWindow | null;
	app: App;
}

/**
 * Get path to playbooks file for a session
 */
function getPlaybooksFilePath(app: App, sessionId: string): string {
	const userDataPath = app.getPath('userData');
	return path.join(userDataPath, 'playbooks', `${sessionId}.json`);
}

/**
 * Read playbooks from file
 */
async function readPlaybooks(app: App, sessionId: string): Promise<any[]> {
	const filePath = getPlaybooksFilePath(app, sessionId);
	try {
		const content = await fs.readFile(filePath, 'utf-8');
		const data = JSON.parse(content);
		return Array.isArray(data.playbooks) ? data.playbooks : [];
	} catch {
		// File doesn't exist or is invalid, return empty array
		return [];
	}
}

/**
 * Write playbooks to file
 */
async function writePlaybooks(app: App, sessionId: string, playbooks: any[]): Promise<void> {
	const filePath = getPlaybooksFilePath(app, sessionId);
	const dir = path.dirname(filePath);

	// Ensure the playbooks directory exists
	await fs.mkdir(dir, { recursive: true });

	// Write the playbooks file
	await fs.writeFile(filePath, JSON.stringify({ playbooks }, null, 2), 'utf-8');
}

/**
 * Register all Playbooks-related IPC handlers.
 *
 * These handlers provide playbook CRUD operations:
 * - List all playbooks for a session
 * - Create a new playbook
 * - Update an existing playbook
 * - Delete a playbook
 * - Export a playbook to ZIP file
 * - Import a playbook from ZIP file
 */
export function registerPlaybooksHandlers(deps: PlaybooksHandlerDependencies): void {
	const { getMainWindow, app } = deps;

	// List all playbooks for a session
	ipcMain.handle(
		'playbooks:list',
		createIpcHandler(handlerOpts('list'), async (sessionId: string) => {
			const playbooks = await readPlaybooks(app, sessionId);
			logger.info(`Listed ${playbooks.length} playbooks for session ${sessionId}`, LOG_CONTEXT);
			return { playbooks };
		})
	);

	// Create a new playbook
	ipcMain.handle(
		'playbooks:create',
		createIpcHandler(
			handlerOpts('create'),
			async (
				sessionId: string,
				playbook: {
					name: string;
					documents: any[];
					loopEnabled: boolean;
					maxLoops?: number | null;
					prompt: string;
					taskSelectionMode?: 'task' | 'document';
					worktreeSettings?: {
						branchNameTemplate: string;
						createPROnCompletion: boolean;
						prTargetBranch?: string;
					};
				}
			) => {
				const playbooks = await readPlaybooks(app, sessionId);

				// Create new playbook with generated ID and timestamps
				const now = Date.now();
				const newPlaybook: {
					id: string;
					name: string;
					createdAt: number;
					updatedAt: number;
					documents: any[];
					loopEnabled: boolean;
					maxLoops?: number | null;
					prompt: string;
					taskSelectionMode?: 'task' | 'document';
					worktreeSettings?: {
						branchNameTemplate: string;
						createPROnCompletion: boolean;
						prTargetBranch?: string;
					};
				} = {
					id: crypto.randomUUID(),
					name: playbook.name,
					createdAt: now,
					updatedAt: now,
					documents: playbook.documents,
					loopEnabled: playbook.loopEnabled,
					maxLoops: playbook.maxLoops,
					prompt: playbook.prompt,
					taskSelectionMode: playbook.taskSelectionMode,
				};

				// Include worktree settings if provided
				if (playbook.worktreeSettings) {
					newPlaybook.worktreeSettings = playbook.worktreeSettings;
				}

				// Add to list and save
				playbooks.push(newPlaybook);
				await writePlaybooks(app, sessionId, playbooks);

				logger.info(`Created playbook "${playbook.name}" for session ${sessionId}`, LOG_CONTEXT);
				return { playbook: newPlaybook };
			}
		)
	);

	// Update an existing playbook
	ipcMain.handle(
		'playbooks:update',
		createIpcHandler(
			handlerOpts('update'),
			async (sessionId: string, playbookId: string, updates: PlaybookUpdate) => {
				const playbooks = await readPlaybooks(app, sessionId);

				// Find the playbook to update
				const index = playbooks.findIndex((p: any) => p.id === playbookId);
				if (index === -1) {
					throw new Error('Playbook not found');
				}

				// Update the playbook
				const updatedPlaybook = {
					...playbooks[index],
					...updates,
					updatedAt: Date.now(),
				};
				playbooks[index] = updatedPlaybook;

				await writePlaybooks(app, sessionId, playbooks);

				logger.info(
					`Updated playbook "${updatedPlaybook.name}" for session ${sessionId}`,
					LOG_CONTEXT
				);
				return { playbook: updatedPlaybook };
			}
		)
	);

	// Delete a playbook
	ipcMain.handle(
		'playbooks:delete',
		createIpcHandler(handlerOpts('delete'), async (sessionId: string, playbookId: string) => {
			const playbooks = await readPlaybooks(app, sessionId);

			// Find the playbook to delete
			const index = playbooks.findIndex((p: any) => p.id === playbookId);
			if (index === -1) {
				throw new Error('Playbook not found');
			}

			const deletedName = playbooks[index].name;

			// Remove from list and save
			playbooks.splice(index, 1);
			await writePlaybooks(app, sessionId, playbooks);

			logger.info(`Deleted playbook "${deletedName}" from session ${sessionId}`, LOG_CONTEXT);
			return {};
		})
	);

	// Delete all playbooks for a session (used when session is deleted)
	ipcMain.handle(
		'playbooks:deleteAll',
		createIpcHandler(handlerOpts('deleteAll'), async (sessionId: string) => {
			const filePath = getPlaybooksFilePath(app, sessionId);
			try {
				await fs.unlink(filePath);
				logger.info(`Deleted all playbooks for session ${sessionId}`, LOG_CONTEXT);
			} catch (error) {
				// File doesn't exist, that's fine
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw error;
				}
			}
			return {};
		})
	);

	// Export a playbook as a ZIP file
	ipcMain.handle(
		'playbooks:export',
		createIpcHandler(
			handlerOpts('export'),
			async (sessionId: string, playbookId: string, autoRunFolderPath: string) => {
				const playbooks = await readPlaybooks(app, sessionId);
				const playbook = playbooks.find((p: any) => p.id === playbookId);

				if (!playbook) {
					throw new Error('Playbook not found');
				}

				const mainWindow = getMainWindow();
				if (!mainWindow) {
					throw new Error('No main window available');
				}

				// Show save dialog
				const result = await dialog.showSaveDialog(mainWindow, {
					title: 'Export Playbook',
					defaultPath: `${playbook.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.maestro-playbook.zip`,
					filters: [
						{ name: 'Maestro Playbook', extensions: ['maestro-playbook.zip'] },
						{ name: 'All Files', extensions: ['*'] },
					],
				});

				if (result.canceled || !result.filePath) {
					throw new Error('Export cancelled');
				}

				const zipPath = result.filePath;

				// Create ZIP archive
				const output = createWriteStream(zipPath);
				const archive = archiver('zip', { zlib: { level: 9 } });

				// Wait for archive to finish
				const archivePromise = new Promise<void>((resolve, reject) => {
					output.on('close', () => resolve());
					archive.on('error', (err) => reject(err));
				});

				archive.pipe(output);

				// Create manifest JSON (playbook settings without the id - will be regenerated on import)
				const manifest = {
					version: PLAYBOOK_ZIP_MANIFEST_VERSION,
					name: playbook.name,
					documents: playbook.documents,
					loopEnabled: playbook.loopEnabled,
					maxLoops: playbook.maxLoops,
					prompt: playbook.prompt,
					taskSelectionMode: playbook.taskSelectionMode,
					worktreeSettings: playbook.worktreeSettings,
					parameterValues: playbook.parameterValues,
					parameterOverlay: playbook.parameterOverlay,
					interaction: playbook.interaction,
					scope: playbook.scope,
					report: playbook.report,
					provenance: exportedProvenance(playbook.provenance),
					exportedAt: Date.now(),
				};

				// Add manifest to archive
				archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

				// Add each document markdown file
				for (const doc of playbook.documents) {
					const docPath = path.join(autoRunFolderPath, `${doc.filename}.md`);
					try {
						const content = await fs.readFile(docPath, 'utf-8');
						archive.append(content, { name: `documents/${doc.filename}.md` });
					} catch {
						// Document file doesn't exist, skip it but log warning
						logger.warn(`Document ${doc.filename}.md not found during export`, LOG_CONTEXT);
					}
				}

				// Add assets/ folder if it exists
				// Assets are stored in a subfolder relative to the first document's directory
				if (playbook.documents.length > 0) {
					const firstDocFilename = playbook.documents[0].filename;
					const docDir = path.dirname(firstDocFilename);
					const assetsDir = path.join(autoRunFolderPath, docDir, 'assets');

					try {
						const assetFiles = await fs.readdir(assetsDir);
						for (const assetFile of assetFiles) {
							const assetPath = path.join(assetsDir, assetFile);
							const stat = await fs.stat(assetPath);
							if (stat.isFile()) {
								const content = await fs.readFile(assetPath);
								archive.append(content, { name: `assets/${assetFile}` });
								logger.debug(`Added asset to export: ${assetFile}`, LOG_CONTEXT);
							}
						}
					} catch {
						// assets/ folder doesn't exist, that's fine
						logger.debug('No assets/ folder found during export', LOG_CONTEXT);
					}
				}

				// Finalize archive
				await archive.finalize();
				await archivePromise;

				logger.info(`Exported playbook "${playbook.name}" to ${zipPath}`, LOG_CONTEXT);
				return { filePath: zipPath };
			}
		)
	);

	// Import a playbook from a ZIP file
	ipcMain.handle(
		'playbooks:import',
		createIpcHandler(
			handlerOpts('import'),
			async (sessionId: string, autoRunFolderPath: string) => {
				const mainWindow = getMainWindow();
				if (!mainWindow) {
					throw new Error('No main window available');
				}

				// Show open dialog
				const result = await dialog.showOpenDialog(mainWindow, {
					title: 'Import Playbook',
					filters: [
						{ name: 'Maestro Playbook', extensions: ['maestro-playbook.zip', 'zip'] },
						{ name: 'All Files', extensions: ['*'] },
					],
					properties: ['openFile'],
				});

				if (result.canceled || result.filePaths.length === 0) {
					throw new Error('Import cancelled');
				}

				const zipPath = result.filePaths[0];

				const zip = readZipArchive(zipPath);
				const zipEntries = zip.getEntries();

				// Find and parse manifest
				const manifestEntry = zipEntries.find((e) => e.entryName === 'manifest.json');
				if (!manifestEntry) {
					throw new Error('Invalid playbook file: missing manifest.json');
				}

				const manifest = JSON.parse(manifestEntry.getData().toString('utf-8'));

				// Validate manifest
				if (!manifest.name || !Array.isArray(manifest.documents)) {
					throw new Error('Invalid playbook manifest');
				}

				// Extract document files to autorun folder
				const importedDocs: string[] = [];
				const documentHashes: Record<string, string> = {};
				for (const entry of zipEntries) {
					if (entry.entryName.startsWith('documents/') && entry.entryName.endsWith('.md')) {
						const filename = path.basename(entry.entryName);
						const destPath = path.join(autoRunFolderPath, filename);

						// Ensure autorun folder exists
						await fs.mkdir(autoRunFolderPath, { recursive: true });

						// Write document file
						const content = entry.getData().toString('utf-8');
						await fs.writeFile(destPath, content, 'utf-8');
						const docName = filename.replace('.md', '');
						importedDocs.push(docName);
						documentHashes[docName] = hashPlaybookDocument(content);
					}
				}

				// Extract asset files to assets/ subfolder
				const importedAssets: string[] = [];
				for (const entry of zipEntries) {
					if (entry.entryName.startsWith('assets/') && !entry.isDirectory) {
						const filename = path.basename(entry.entryName);
						const assetsDir = path.join(autoRunFolderPath, 'assets');
						const destPath = path.join(assetsDir, filename);

						// Ensure assets folder exists
						await fs.mkdir(assetsDir, { recursive: true });

						// Write asset file (binary-safe)
						await fs.writeFile(destPath, entry.getData());
						importedAssets.push(filename);
						logger.debug(`Imported asset: ${filename}`, LOG_CONTEXT);
					}
				}

				// Create new playbook entry
				const playbooks = await readPlaybooks(app, sessionId);
				const now = Date.now();

				const newPlaybook: Playbook = {
					id: crypto.randomUUID(),
					name: manifest.name,
					createdAt: now,
					updatedAt: now,
					documents: manifest.documents,
					loopEnabled: manifest.loopEnabled ?? false,
					maxLoops: manifest.maxLoops,
					prompt: manifest.prompt || '',
					taskSelectionMode: manifest.taskSelectionMode,
					worktreeSettings: manifest.worktreeSettings,
					...readPlaybookExchangeFields(manifest),
					provenance: zipImportProvenance(
						manifest,
						zipPath,
						autoRunFolderPath,
						documentHashes,
						now
					),
				};

				// Add to list and save
				playbooks.push(newPlaybook);
				await writePlaybooks(app, sessionId, playbooks);

				logger.info(
					`Imported playbook "${manifest.name}" with ${importedDocs.length} documents and ${importedAssets.length} assets`,
					LOG_CONTEXT
				);
				return { playbook: newPlaybook, importedDocs, importedAssets };
			}
		)
	);

	logger.debug(`${LOG_CONTEXT} Playbooks IPC handlers registered`);
}
