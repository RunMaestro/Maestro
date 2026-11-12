/**
 * File Tree domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: refresh_file_tree, get_file_tree.
 */

import path from 'path';
import fs from 'fs/promises';
import { logger } from '../../../utils/logger';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle refresh_file_tree message - refresh the file tree for a session
 */
export function handleRefreshFileTree(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	logger.info(`[Web] Received refresh_file_tree message: session=${sessionId}`, LOG_CONTEXT);

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.refreshFileTree) {
		ctx.sendError(client, 'File tree refresh not configured');
		return;
	}

	ctx.callbacks
		.refreshFileTree(sessionId)
		.then((success) => {
			ctx.send(client, {
				type: 'refresh_file_tree_result',
				success,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to refresh file tree: ${error.message}`);
		});
}

/**
 * Handle get_file_tree message - read directory tree for file explorer
 * Uses Node.js fs directly (no IPC to renderer needed)
 */
export function handleGetFileTree(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const dirPath = message.path as string;
	const maxDepth = Math.min((message.maxDepth as number) || 3, 5);

	if (!dirPath) {
		ctx.sendError(client, 'Missing path for get_file_tree');
		return;
	}

	// Validate dirPath is within the session's working directory
	const sessionDetail = ctx.callbacks.getSessionDetail?.(sessionId);
	if (!sessionDetail?.cwd) {
		ctx.sendError(client, 'Cannot resolve session working directory');
		return;
	}
	const resolvedDir = path.resolve(dirPath);
	const resolvedCwd = path.resolve(sessionDetail.cwd);
	if (!resolvedDir.startsWith(resolvedCwd + path.sep) && resolvedDir !== resolvedCwd) {
		ctx.sendError(client, 'Requested path is outside the session working directory');
		return;
	}

	buildFileTree(dirPath, maxDepth)
		.then((tree) => {
			ctx.send(client, {
				type: 'file_tree_data',
				sessionId,
				tree,
				path: dirPath,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.send(client, {
				type: 'file_tree_data',
				sessionId,
				tree: [],
				error: error.message,
				path: dirPath,
				requestId: message.requestId,
			});
		});
}

/**
 * Recursively build a file tree from a directory path
 */
async function buildFileTree(
	dirPath: string,
	maxDepth: number,
	currentDepth = 0
): Promise<
	Array<{
		name: string;
		type: 'file' | 'folder';
		children?: Array<{ name: string; type: 'file' | 'folder'; children?: any[]; path: string }>;
		path: string;
	}>
> {
	// Common ignore patterns
	const IGNORE = new Set([
		'node_modules',
		'.git',
		'.next',
		'.nuxt',
		'dist',
		'build',
		'.cache',
		'__pycache__',
		'.tox',
		'.mypy_cache',
		'.pytest_cache',
		'venv',
		'.venv',
		'target',
		'.idea',
		'.vscode',
		'.DS_Store',
		'Thumbs.db',
		'.turbo',
		'coverage',
		'.nyc_output',
		'.parcel-cache',
		'.svelte-kit',
	]);

	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		const result: Array<{
			name: string;
			type: 'file' | 'folder';
			children?: any[];
			path: string;
		}> = [];

		// Sort: folders first, then alphabetically
		const sorted = entries
			.filter((e) => !IGNORE.has(e.name) && !e.name.startsWith('.'))
			.sort((a, b) => {
				if (a.isDirectory() && !b.isDirectory()) return -1;
				if (!a.isDirectory() && b.isDirectory()) return 1;
				return a.name.localeCompare(b.name);
			});

		for (const entry of sorted) {
			const fullPath = path.join(dirPath, entry.name);

			if (entry.isDirectory()) {
				const children =
					currentDepth < maxDepth
						? await buildFileTree(fullPath, maxDepth, currentDepth + 1)
						: undefined;
				result.push({
					name: entry.name,
					type: 'folder',
					children,
					path: fullPath,
				});
			} else {
				result.push({
					name: entry.name,
					type: 'file',
					path: fullPath,
				});
			}
		}

		return result;
	} catch {
		// Permission denied or other errors - return empty
		return [];
	}
}
