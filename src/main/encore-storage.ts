/**
 * Plugin-Scoped Storage
 *
 * Provides file-based storage scoped to each encore.
 * Files are stored under `userData/encores/<encoreId>/data/`.
 * All filenames are validated to prevent path traversal attacks.
 */

import path from 'path';
import fs from 'fs/promises';
import { logger } from './utils/logger';

const LOG_CONTEXT = '[Encores]';

/**
 * Validates a filename to prevent path traversal.
 * Rejects filenames containing '..', '/', '\', null bytes, or absolute paths.
 */
function validateFilename(filename: string, baseDir: string): void {
	if (!filename || typeof filename !== 'string') {
		throw new Error('Filename must be a non-empty string');
	}

	if (filename.includes('\0')) {
		throw new Error('Filename contains null bytes');
	}

	if (path.isAbsolute(filename)) {
		throw new Error('Absolute paths are not allowed');
	}

	if (filename.includes('..')) {
		throw new Error('Path traversal is not allowed');
	}

	if (filename.includes('/') || filename.includes('\\')) {
		throw new Error('Path separators are not allowed in filenames');
	}

	const resolved = path.resolve(baseDir, filename);
	if (!resolved.startsWith(baseDir)) {
		throw new Error('Path traversal is not allowed');
	}
}

/**
 * Plugin-scoped file storage.
 * Each encore gets its own isolated storage directory.
 */
export class EncoreStorage {
	private encoreId: string;
	private baseDir: string;

	constructor(encoreId: string, baseDir: string) {
		this.encoreId = encoreId;
		this.baseDir = baseDir;
	}

	/**
	 * Reads a file from the encore's storage directory.
	 * Returns null if the file does not exist.
	 */
	async read(filename: string): Promise<string | null> {
		validateFilename(filename, this.baseDir);
		try {
			return await fs.readFile(path.join(this.baseDir, filename), 'utf-8');
		} catch {
			return null;
		}
	}

	/**
	 * Writes data to a file in the encore's storage directory.
	 * Creates the directory on first write (lazy creation).
	 */
	async write(filename: string, data: string): Promise<void> {
		validateFilename(filename, this.baseDir);
		await fs.mkdir(this.baseDir, { recursive: true });
		await fs.writeFile(path.join(this.baseDir, filename), data, 'utf-8');
		logger.debug(`[Plugin:${this.encoreId}] wrote file '${filename}'`, LOG_CONTEXT);
	}

	/**
	 * Lists all files in the encore's storage directory.
	 * Returns an empty array if the directory doesn't exist.
	 */
	async list(): Promise<string[]> {
		try {
			return await fs.readdir(this.baseDir);
		} catch {
			return [];
		}
	}

	/**
	 * Deletes a file from the encore's storage directory.
	 * No-op if the file doesn't exist.
	 */
	async delete(filename: string): Promise<void> {
		validateFilename(filename, this.baseDir);
		try {
			await fs.unlink(path.join(this.baseDir, filename));
		} catch {
			// Ignore if file doesn't exist
		}
	}

	/**
	 * Returns the base directory for this encore's storage.
	 */
	getBaseDir(): string {
		return this.baseDir;
	}
}
