/**
 * Attachments IPC Handlers
 *
 * This module handles IPC calls for session attachment operations:
 * - save: Save an image attachment for a session
 * - load: Load an attachment as base64 data URL
 * - delete: Delete an attachment
 * - list: List all attachments for a session
 * - getPath: Get the attachments directory path for a session
 *
 * Attachments are stored in userData/attachments/{sessionId}/{filename}
 *
 * Extracted from main/index.ts to improve code organization.
 */

import { ipcMain, App } from 'electron';
import path from 'path';
import fs from 'fs/promises';

import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

/**
 * Dependencies required for attachments handlers
 */
export interface AttachmentsHandlerDependencies {
	app: App;
}

/**
 * Sanitize a sessionId to prevent path traversal attacks.
 * Strips directory separators and '..' components, then verifies the
 * resolved path stays within the expected attachments base directory.
 */
function sanitizeSessionId(sessionId: string, baseDir: string): string {
	if (
		!sessionId ||
		sessionId.includes('/') ||
		sessionId.includes('\\') ||
		sessionId.includes('..')
	) {
		throw new Error(`Invalid session ID: ${sessionId}`);
	}
	const safe = path.basename(sessionId);
	if (!safe || safe === '.' || safe === '..') {
		throw new Error(`Invalid session ID: ${sessionId}`);
	}
	// Belt-and-suspenders: verify resolved path is inside the base directory
	const resolved = path.resolve(baseDir, safe);
	if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
		throw new Error(`Invalid session ID: path escapes attachments directory`);
	}
	return safe;
}

/**
 * Register all attachments-related IPC handlers.
 */
export function registerAttachmentsHandlers(deps: AttachmentsHandlerDependencies): void {
	const { app } = deps;

	// Save an image attachment for a session
	ipcMain.handle(
		'attachments:save',
		async (_event, sessionId: string, base64Data: string, filename: string) => {
			try {
				const userDataPath = app.getPath('userData');
				const attachmentsBase = path.join(userDataPath, 'attachments');
				const safeSessionId = sanitizeSessionId(sessionId, attachmentsBase);
				const attachmentsDir = path.join(attachmentsBase, safeSessionId);

				// Ensure the attachments directory exists
				await fs.mkdir(attachmentsDir, { recursive: true });

				// Extract the base64 content (remove data:image/...;base64, prefix if present)
				const base64Match = base64Data.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
				let buffer: Buffer;
				let finalFilename = filename;

				if (base64Match) {
					const extension = base64Match[1];
					buffer = Buffer.from(base64Match[2], 'base64');
					// Update filename with correct extension if not already present
					if (!filename.includes('.')) {
						finalFilename = `${filename}.${extension}`;
					}
				} else {
					// Assume raw base64
					buffer = Buffer.from(base64Data, 'base64');
				}

				// Sanitize filename to prevent path traversal attacks
				finalFilename = path.basename(finalFilename);

				const filePath = path.join(attachmentsDir, finalFilename);
				await fs.writeFile(filePath, buffer);

				logger.info(`Saved attachment: ${filePath}`, 'Attachments', {
					sessionId,
					filename: finalFilename,
					size: buffer.length,
				});
				return { success: true, path: filePath, filename: finalFilename };
			} catch (error) {
				void captureException(error);
				logger.error('Error saving attachment', 'Attachments', error);
				return { success: false, error: String(error) };
			}
		}
	);

	// Load an attachment as base64 data URL
	ipcMain.handle('attachments:load', async (_event, sessionId: string, filename: string) => {
		try {
			const userDataPath = app.getPath('userData');
			const attachmentsBase = path.join(userDataPath, 'attachments');
			const safeSessionId = sanitizeSessionId(sessionId, attachmentsBase);
			// Sanitize filename to prevent path traversal attacks
			const safeFilename = path.basename(filename);
			const filePath = path.join(attachmentsBase, safeSessionId, safeFilename);

			const buffer = await fs.readFile(filePath);
			const base64 = buffer.toString('base64');

			// Determine MIME type from extension
			const ext = path.extname(filename).toLowerCase().slice(1);
			const mimeTypes: Record<string, string> = {
				png: 'image/png',
				jpg: 'image/jpeg',
				jpeg: 'image/jpeg',
				gif: 'image/gif',
				webp: 'image/webp',
				svg: 'image/svg+xml',
			};
			const mimeType = mimeTypes[ext] || 'image/png';

			logger.debug(`Loaded attachment: ${filePath}`, 'Attachments', {
				sessionId,
				filename,
				size: buffer.length,
			});
			return { success: true, dataUrl: `data:${mimeType};base64,${base64}` };
		} catch (error) {
			void captureException(error);
			logger.error('Error loading attachment', 'Attachments', error);
			return { success: false, error: String(error) };
		}
	});

	// Delete an attachment
	ipcMain.handle('attachments:delete', async (_event, sessionId: string, filename: string) => {
		try {
			const userDataPath = app.getPath('userData');
			const attachmentsBase = path.join(userDataPath, 'attachments');
			const safeSessionId = sanitizeSessionId(sessionId, attachmentsBase);
			// Sanitize filename to prevent path traversal attacks
			const safeFilename = path.basename(filename);
			const filePath = path.join(attachmentsBase, safeSessionId, safeFilename);

			await fs.unlink(filePath);
			logger.info(`Deleted attachment: ${filePath}`, 'Attachments', { sessionId, filename });
			return { success: true };
		} catch (error) {
			void captureException(error);
			logger.error('Error deleting attachment', 'Attachments', error);
			return { success: false, error: String(error) };
		}
	});

	// List all attachments for a session
	ipcMain.handle('attachments:list', async (_event, sessionId: string) => {
		try {
			const userDataPath = app.getPath('userData');
			const attachmentsBase = path.join(userDataPath, 'attachments');
			const safeSessionId = sanitizeSessionId(sessionId, attachmentsBase);
			const attachmentsDir = path.join(attachmentsBase, safeSessionId);

			try {
				const files = await fs.readdir(attachmentsDir);
				const imageFiles = files.filter((f) => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f));
				logger.debug(`Listed attachments for session: ${sessionId}`, 'Attachments', {
					count: imageFiles.length,
				});
				return { success: true, files: imageFiles };
			} catch (err: any) {
				if (err.code === 'ENOENT') {
					// Directory doesn't exist yet - no attachments
					return { success: true, files: [] };
				}
				throw err;
			}
		} catch (error) {
			void captureException(error);
			logger.error('Error listing attachments', 'Attachments', error);
			return { success: false, error: String(error), files: [] };
		}
	});

	// Get the attachments directory path for a session
	ipcMain.handle('attachments:getPath', async (_event, sessionId: string) => {
		const userDataPath = app.getPath('userData');
		const attachmentsBase = path.join(userDataPath, 'attachments');
		const safeSessionId = sanitizeSessionId(sessionId, attachmentsBase);
		const attachmentsDir = path.join(attachmentsBase, safeSessionId);
		return { success: true, path: attachmentsDir };
	});
}
