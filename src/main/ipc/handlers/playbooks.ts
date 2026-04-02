import { ipcMain, BrowserWindow, App, dialog } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createWriteStream } from 'fs';
import archiver from 'archiver';
import AdmZip from 'adm-zip';
import { logger } from '../../utils/logger';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	buildImplicitTaskGraph,
	normalizePersistedPlaybook,
	normalizePlaybookDraft,
	normalizePlaybookUpdate,
} from '../../../shared/playbookDag';
import type { Playbook, PlaybookDraft, PlaybookUpdate } from '../../../shared/types';

const LOG_CONTEXT = '[Playbooks]';

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
async function readPlaybooks(app: App, sessionId: string): Promise<Playbook[]> {
	const filePath = getPlaybooksFilePath(app, sessionId);
	try {
		const content = await fs.readFile(filePath, 'utf-8');
		const data = JSON.parse(content) as { playbooks?: unknown[] };
		return Array.isArray(data.playbooks)
			? data.playbooks.map((playbook) => normalizePersistedPlaybook(playbook as Playbook))
			: [];
	} catch {
		// File doesn't exist or is invalid, return empty array
		return [];
	}
}

/**
 * Write playbooks to file
 */
async function writePlaybooks(app: App, sessionId: string, playbooks: Playbook[]): Promise<void> {
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
		createIpcHandler(handlerOpts('create'), async (sessionId: string, playbook: PlaybookDraft) => {
			const playbooks = await readPlaybooks(app, sessionId);
			const normalizedDraft = normalizePlaybookDraft(playbook);

			// Create new playbook with generated ID and timestamps
			const now = Date.now();
			const newPlaybook: Playbook = {
				id: crypto.randomUUID(),
				name: normalizedDraft.name,
				createdAt: now,
				updatedAt: now,
				documents: normalizedDraft.documents,
				loopEnabled: normalizedDraft.loopEnabled,
				maxLoops: normalizedDraft.maxLoops ?? null,
				taskTimeoutMs: normalizedDraft.taskTimeoutMs ?? null,
				prompt: normalizedDraft.prompt,
				skills: normalizedDraft.skills,
				definitionOfDone: Array.isArray(normalizedDraft.definitionOfDone)
					? normalizedDraft.definitionOfDone.filter(
							(item) => typeof item === 'string' && item.trim() !== ''
						)
					: [],
				verificationSteps: Array.isArray(normalizedDraft.verificationSteps)
					? normalizedDraft.verificationSteps.filter(
							(item) => typeof item === 'string' && item.trim() !== ''
						)
					: [],
				promptProfile: normalizedDraft.promptProfile,
				documentContextMode: normalizedDraft.documentContextMode,
				skillPromptMode: normalizedDraft.skillPromptMode,
				agentStrategy: normalizedDraft.agentStrategy ?? 'single',
				maxParallelism: normalizedDraft.maxParallelism,
				taskGraph: normalizedDraft.taskGraph,
			};

			// Include worktree settings if provided
			if (normalizedDraft.worktreeSettings) {
				newPlaybook.worktreeSettings = normalizedDraft.worktreeSettings;
			}

			// Add to list and save
			playbooks.push(newPlaybook);
			await writePlaybooks(app, sessionId, playbooks);

			logger.info(`Created playbook "${playbook.name}" for session ${sessionId}`, LOG_CONTEXT);
			return { playbook: newPlaybook };
		})
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
				const nextDocuments = Array.isArray(updates.documents)
					? updates.documents
					: playbooks[index].documents;
				const normalizedUpdates = normalizePlaybookUpdate(nextDocuments, updates);

				const updatedPlaybook: Playbook = normalizePersistedPlaybook({
					...playbooks[index],
					...normalizedUpdates,
					updatedAt: Date.now(),
				});
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
					version: 1,
					name: playbook.name,
					documents: playbook.documents,
					loopEnabled: playbook.loopEnabled,
					maxLoops: playbook.maxLoops,
					taskTimeoutMs: playbook.taskTimeoutMs ?? null,
					maxParallelism: playbook.maxParallelism ?? 1,
					taskGraph: playbook.taskGraph ?? buildImplicitTaskGraph(playbook.documents),
					prompt: playbook.prompt,
					skills: playbook.skills,
					definitionOfDone: playbook.definitionOfDone,
					verificationSteps: playbook.verificationSteps,
					promptProfile: playbook.promptProfile,
					documentContextMode: playbook.documentContextMode,
					skillPromptMode: playbook.skillPromptMode,
					agentStrategy: playbook.agentStrategy,
					worktreeSettings: playbook.worktreeSettings,
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

				// Read ZIP file
				const zip = new AdmZip(zipPath);
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
				for (const entry of zipEntries) {
					if (entry.entryName.startsWith('documents/') && entry.entryName.endsWith('.md')) {
						const filename = path.basename(entry.entryName);
						const destPath = path.join(autoRunFolderPath, filename);

						// Ensure autorun folder exists
						await fs.mkdir(autoRunFolderPath, { recursive: true });

						// Write document file
						await fs.writeFile(destPath, entry.getData().toString('utf-8'), 'utf-8');
						importedDocs.push(filename.replace('.md', ''));
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

				const newPlaybook = normalizePersistedPlaybook({
					id: crypto.randomUUID(),
					name: manifest.name,
					createdAt: now,
					updatedAt: now,
					documents: manifest.documents,
					loopEnabled: manifest.loopEnabled ?? false,
					maxLoops: manifest.maxLoops,
					taskTimeoutMs: manifest.taskTimeoutMs ?? null,
					maxParallelism: manifest.maxParallelism,
					taskGraph: manifest.taskGraph,
					prompt: manifest.prompt || '',
					skills: Array.isArray(manifest.skills) ? manifest.skills : [],
					definitionOfDone: Array.isArray(manifest.definitionOfDone)
						? manifest.definitionOfDone.filter(
								(item: unknown) => typeof item === 'string' && item.trim() !== ''
							)
						: [],
					verificationSteps: Array.isArray(manifest.verificationSteps)
						? manifest.verificationSteps.filter(
								(item: unknown) => typeof item === 'string' && item.trim() !== ''
							)
						: [],
					promptProfile: manifest.promptProfile,
					documentContextMode: manifest.documentContextMode,
					skillPromptMode: manifest.skillPromptMode,
					agentStrategy: manifest.agentStrategy ?? 'single',
					worktreeSettings: manifest.worktreeSettings,
				});

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
