/**
 * Storage Collector
 *
 * Collects storage locations and sizes.
 * - Paths are replaced with opaque descriptors (shape only, no names)
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import Store from 'electron-store';
import { redactPath } from './sanitize';

export interface StorageInfo {
	paths: {
		userData: string; // Redacted path descriptor
		sessions: string; // Redacted path descriptor
		history: string; // Redacted path descriptor
		logs: string; // Redacted path descriptor
		groupChats: string; // Redacted path descriptor
		customSyncPath?: string; // Just "[SET]" or not present
	};
	sizes: {
		sessionsBytes: number;
		historyBytes: number;
		logsBytes: number;
		groupChatsBytes: number;
		totalBytes: number;
	};
}

/**
 * Get the size of a directory recursively.
 */
function getDirectorySize(dirPath: string): number {
	try {
		if (!fs.existsSync(dirPath)) {
			return 0;
		}

		const stats = fs.statSync(dirPath);
		if (!stats.isDirectory()) {
			return stats.size;
		}

		let totalSize = 0;
		const files = fs.readdirSync(dirPath);

		for (const file of files) {
			const filePath = path.join(dirPath, file);
			try {
				const fileStats = fs.statSync(filePath);
				if (fileStats.isDirectory()) {
					totalSize += getDirectorySize(filePath);
				} else {
					totalSize += fileStats.size;
				}
			} catch {
				// Skip files we can't access
			}
		}

		return totalSize;
	} catch {
		return 0;
	}
}

/**
 * Get the size of a file.
 */
function getFileSize(filePath: string): number {
	try {
		if (!fs.existsSync(filePath)) {
			return 0;
		}
		const stats = fs.statSync(filePath);
		return stats.size;
	} catch {
		return 0;
	}
}

/**
 * Collect storage information.
 */
export async function collectStorage(bootstrapStore?: Store<any>): Promise<StorageInfo> {
	const userDataPath = app.getPath('userData');
	const historyPath = path.join(userDataPath, 'history');
	const groupChatsPath = path.join(userDataPath, 'group-chats');

	// Check for custom sync path
	const customSyncPath = bootstrapStore?.get('customSyncPath');
	const dataPath = customSyncPath || userDataPath;

	// Storage file paths
	const sessionsFile = path.join(dataPath, 'maestro-sessions.json');

	const result: StorageInfo = {
		paths: {
			userData: redactPath(userDataPath),
			sessions: redactPath(dataPath),
			history: redactPath(historyPath),
			logs: redactPath(userDataPath),
			groupChats: redactPath(groupChatsPath),
			customSyncPath: customSyncPath ? '[SET]' : undefined,
		},
		sizes: {
			sessionsBytes: getFileSize(sessionsFile),
			historyBytes: getDirectorySize(historyPath),
			logsBytes: 0, // We don't store logs to disk by default
			groupChatsBytes: getDirectorySize(groupChatsPath),
			totalBytes: 0,
		},
	};

	// Calculate total
	result.sizes.totalBytes =
		result.sizes.sessionsBytes +
		result.sizes.historyBytes +
		result.sizes.logsBytes +
		result.sizes.groupChatsBytes;

	return result;
}
