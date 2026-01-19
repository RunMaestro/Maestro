/**
 * OpenCode Session Storage Implementation
 *
 * This module implements the AgentSessionStorage interface for OpenCode.
 * OpenCode stores sessions as JSON files in ~/.local/share/opencode/storage/
 *
 * Directory structure:
 * - project/     - Project metadata (SHA1 hash of path as ID)
 * - session/{projectID}/ - Session metadata per project
 * - message/{sessionID}/ - Messages per session
 * - part/{messageID}/    - Message parts (text, tool, reasoning)
 *
 * Session IDs: Format is `ses_{base62}` (e.g., ses_4d585107dffeO9bO3HvMdvLYyC)
 * Project IDs: SHA1 hash of the project path
 *
 * CLI commands available:
 * - `opencode session list` - Lists all sessions
 * - `opencode export <sessionID>` - Exports full session as JSON
 */

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { createHash } from 'crypto';
import { logger } from '../utils/logger';
import type {
	AgentSessionStorage,
	AgentSessionInfo,
	PaginatedSessionsResult,
	SessionMessagesResult,
	SessionSearchResult,
	SessionSearchMode,
	SessionListOptions,
	SessionReadOptions,
	SessionMessage,
} from '../agent-session-storage';
import type { ToolType } from '../../shared/types';

const LOG_CONTEXT = '[OpenCodeSessionStorage]';

/**
 * Get OpenCode storage base directory (platform-specific)
 * - Linux/macOS: ~/.local/share/opencode/storage
 * - Windows: %APPDATA%\opencode\storage
 */
function getOpenCodeStorageDir(): string {
	if (process.platform === 'win32') {
		const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
		return path.join(appData, 'opencode', 'storage');
	}
	return path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
}

const OPENCODE_STORAGE_DIR = getOpenCodeStorageDir();

/**
 * OpenCode project metadata structure
 */
interface OpenCodeProject {
	id: string;
	worktree: string; // Project path (called "worktree" in OpenCode)
	vcsDir?: string;
	vcs?: string;
	time?: {
		created?: number;
		updated?: number;
	};
}

/**
 * OpenCode session metadata structure
 */
interface OpenCodeSession {
	id: string; // Session ID (e.g., ses_...)
	version?: string; // OpenCode version
	projectID: string; // Project ID this session belongs to
	directory?: string; // Working directory
	title?: string; // Auto-generated title
	time?: {
		created?: number; // Unix timestamp in milliseconds
		updated?: number; // Unix timestamp in milliseconds
	};
	summary?: {
		additions?: number;
		deletions?: number;
		files?: number;
	};
}

/**
 * OpenCode message structure
 */
interface OpenCodeMessage {
	id: string;
	sessionID: string;
	role: 'user' | 'assistant';
	time?: {
		created?: number; // Unix timestamp in milliseconds
	};
	model?: {
		providerID?: string;
		modelID?: string;
	};
	agent?: string;
	tokens?: {
		input?: number;
		output?: number;
		reasoning?: number;
		cache?: {
			read?: number;
			write?: number;
		};
	};
	cost?: number;
	summary?: {
		title?: string;
		diffs?: unknown[];
	};
}

/**
 * OpenCode message part structure
 */
interface OpenCodePart {
	id: string;
	messageID: string;
	type: 'text' | 'reasoning' | 'tool' | 'step-start' | 'step-finish';
	text?: string;
	tool?: string;
	state?: {
		status?: string;
		input?: unknown;
		output?: unknown;
	};
}

/**
 * Generate the project ID hash from a path (SHA1)
 */
function hashProjectPath(projectPath: string): string {
	return createHash('sha1').update(projectPath).digest('hex');
}

/**
 * Read a JSON file from the storage directory
 */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
	try {
		const content = await fs.readFile(filePath, 'utf-8');
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/**
 * List all JSON files in a directory
 */
async function listJsonFiles(dirPath: string): Promise<string[]> {
	try {
		const files = await fs.readdir(dirPath);
		return files.filter((f) => f.endsWith('.json'));
	} catch {
		return [];
	}
}

/**
 * OpenCode Session Storage Implementation
 *
 * Provides access to OpenCode's local session storage at ~/.local/share/opencode/storage/
 */
export class OpenCodeSessionStorage implements AgentSessionStorage {
	readonly agentId: ToolType = 'opencode';

	/**
	 * Get the session directory for a project
	 */
	private getSessionDir(projectId: string): string {
		return path.join(OPENCODE_STORAGE_DIR, 'session', projectId);
	}

	/**
	 * Get the message directory for a session
	 */
	private getMessageDir(sessionId: string): string {
		return path.join(OPENCODE_STORAGE_DIR, 'message', sessionId);
	}

	/**
	 * Get the part directory for a message
	 */
	private getPartDir(messageId: string): string {
		return path.join(OPENCODE_STORAGE_DIR, 'part', messageId);
	}

	/**
	 * Find the project ID for a given path by checking existing projects
	 */
	private async findProjectId(projectPath: string): Promise<string | null> {
		const projectDir = path.join(OPENCODE_STORAGE_DIR, 'project');

		try {
			await fs.access(projectDir);
		} catch {
			logger.info(`OpenCode project directory not found: ${projectDir}`, LOG_CONTEXT);
			return null;
		}

		const projectFiles = await listJsonFiles(projectDir);

		// Normalize project path for comparison (resolve and remove trailing slashes)
		const normalizedPath = path.resolve(projectPath).replace(/\/+$/, '');
		logger.info(`Looking for OpenCode project for path: ${normalizedPath}`, LOG_CONTEXT);

		for (const file of projectFiles) {
			// Skip global.json - we'll use it as fallback
			if (file === 'global.json') continue;

			const projectData = await readJsonFile<OpenCodeProject>(path.join(projectDir, file));
			if (!projectData?.worktree) continue;

			// Normalize stored path the same way
			const storedPath = path.resolve(projectData.worktree).replace(/\/+$/, '');

			// Exact match
			if (storedPath === normalizedPath) {
				logger.info(
					`Found OpenCode project: ${projectData.id} for path: ${normalizedPath}`,
					LOG_CONTEXT
				);
				return projectData.id;
			}

			// Check if one is a subdirectory of the other (handles worktree subdirs)
			if (
				normalizedPath.startsWith(storedPath + '/') ||
				storedPath.startsWith(normalizedPath + '/')
			) {
				logger.info(
					`Found OpenCode project (subdirectory match): ${projectData.id} for path: ${normalizedPath}`,
					LOG_CONTEXT
				);
				return projectData.id;
			}
		}

		// Also check using hash-based ID (OpenCode may use SHA1 of path)
		const hashedId = hashProjectPath(projectPath);
		const hashedFile = path.join(projectDir, `${hashedId}.json`);
		try {
			await fs.access(hashedFile);
			logger.info(`Found OpenCode project by hash: ${hashedId}`, LOG_CONTEXT);
			return hashedId;
		} catch {
			// Not found by hash
		}

		// Fall back to 'global' project - OpenCode stores sessions for non-project directories here
		// Sessions in global have a 'directory' field that indicates the actual working directory
		logger.info(
			`No dedicated OpenCode project found for path: ${normalizedPath}, will check global project`,
			LOG_CONTEXT
		);
		return 'global';
	}

	/**
	 * Check if a session's directory matches the requested project path
	 * Used for filtering global project sessions by their working directory
	 */
	private sessionMatchesPath(sessionDirectory: string | undefined, projectPath: string): boolean {
		if (!sessionDirectory) return false;

		const normalizedSessionDir = path.resolve(sessionDirectory).replace(/\/+$/, '');
		const normalizedProjectPath = path.resolve(projectPath).replace(/\/+$/, '');

		// Exact match
		if (normalizedSessionDir === normalizedProjectPath) return true;

		// Session is in a subdirectory of the project
		if (normalizedSessionDir.startsWith(normalizedProjectPath + '/')) return true;

		return false;
	}

	/**
	 * Load all messages for a session
	 */
	private async loadSessionMessages(sessionId: string): Promise<{
		messages: OpenCodeMessage[];
		parts: Map<string, OpenCodePart[]>;
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCacheReadTokens: number;
		totalCacheWriteTokens: number;
		totalCost: number;
	}> {
		const messageDir = this.getMessageDir(sessionId);
		const messages: OpenCodeMessage[] = [];
		const parts = new Map<string, OpenCodePart[]>();
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCacheReadTokens = 0;
		let totalCacheWriteTokens = 0;
		let totalCost = 0;

		try {
			const messageFiles = await listJsonFiles(messageDir);

			for (const file of messageFiles) {
				const msg = await readJsonFile<OpenCodeMessage>(path.join(messageDir, file));
				if (msg) {
					messages.push(msg);

					// Aggregate token stats
					if (msg.tokens) {
						totalInputTokens += msg.tokens.input || 0;
						totalOutputTokens += msg.tokens.output || 0;
						totalCacheReadTokens += msg.tokens.cache?.read || 0;
						totalCacheWriteTokens += msg.tokens.cache?.write || 0;
					}
					if (msg.cost) {
						totalCost += msg.cost;
					}

					// Load parts for this message
					const partDir = this.getPartDir(msg.id);
					const partFiles = await listJsonFiles(partDir);
					const messageParts: OpenCodePart[] = [];

					for (const partFile of partFiles) {
						const part = await readJsonFile<OpenCodePart>(path.join(partDir, partFile));
						if (part) {
							messageParts.push(part);
						}
					}

					parts.set(msg.id, messageParts);
				}
			}
		} catch {
			// Directory may not exist
		}

		// Sort messages by creation time (OpenCode uses time.created as Unix timestamp in ms)
		messages.sort((a, b) => {
			const aTime = a.time?.created || 0;
			const bTime = b.time?.created || 0;
			return aTime - bTime;
		});

		return {
			messages,
			parts,
			totalInputTokens,
			totalOutputTokens,
			totalCacheReadTokens,
			totalCacheWriteTokens,
			totalCost,
		};
	}

	/**
	 * Extract text content from message parts
	 */
	private extractTextFromParts(parts: OpenCodePart[]): string {
		const textParts = parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text || '');
		return textParts.join(' ').trim();
	}

	async listSessions(projectPath: string): Promise<AgentSessionInfo[]> {
		const projectId = await this.findProjectId(projectPath);

		if (!projectId) {
			logger.info(`No OpenCode project found for path: ${projectPath}`, LOG_CONTEXT);
			return [];
		}

		// When using the 'global' project, we need to filter sessions by their directory field
		const isGlobalProject = projectId === 'global';

		const sessionDir = this.getSessionDir(projectId);

		try {
			await fs.access(sessionDir);
		} catch {
			logger.info(`No OpenCode sessions directory for project: ${projectPath}`, LOG_CONTEXT);
			return [];
		}

		const sessionFiles = await listJsonFiles(sessionDir);
		const sessions: AgentSessionInfo[] = [];

		for (const file of sessionFiles) {
			const sessionData = await readJsonFile<OpenCodeSession>(path.join(sessionDir, file));

			if (!sessionData) continue;

			// For global project, filter by the session's directory field
			if (isGlobalProject && !this.sessionMatchesPath(sessionData.directory, projectPath)) {
				continue;
			}

			// Load messages to get first message and stats
			const {
				messages,
				parts,
				totalInputTokens,
				totalOutputTokens,
				totalCacheReadTokens,
				totalCacheWriteTokens,
				totalCost,
			} = await this.loadSessionMessages(sessionData.id);

			// Get preview message - prefer first assistant response, fall back to user message or title
			let firstAssistantMessage = '';
			let firstUserMessage = '';

			for (const msg of messages) {
				const msgParts = parts.get(msg.id) || [];
				const textContent = this.extractTextFromParts(msgParts);

				if (!firstUserMessage && msg.role === 'user' && textContent.trim()) {
					firstUserMessage = textContent;
				}
				if (!firstAssistantMessage && msg.role === 'assistant' && textContent.trim()) {
					firstAssistantMessage = textContent;
					break; // Found first assistant response, stop scanning
				}
			}

			// Priority: assistant response > user message > title
			const previewMessage = firstAssistantMessage || firstUserMessage || sessionData.title || '';

			// Calculate duration using time.created (Unix timestamp in ms)
			let durationSeconds = 0;
			if (messages.length >= 2) {
				const firstMsg = messages[0];
				const lastMsg = messages[messages.length - 1];
				const startTime = firstMsg.time?.created || 0;
				const endTime = lastMsg.time?.created || 0;
				if (startTime && endTime) {
					durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));
				}
			}

			// Get file stats for size
			let sizeBytes = 0;
			try {
				const stats = await fs.stat(path.join(sessionDir, file));
				sizeBytes = stats.size;
			} catch {
				// Ignore stat errors
			}

			// Convert OpenCode timestamps (Unix ms) to ISO strings
			const createdAt = sessionData.time?.created
				? new Date(sessionData.time.created).toISOString()
				: new Date().toISOString();
			const updatedAt = sessionData.time?.updated
				? new Date(sessionData.time.updated).toISOString()
				: createdAt;

			sessions.push({
				sessionId: sessionData.id,
				projectPath,
				timestamp: createdAt,
				modifiedAt: updatedAt,
				firstMessage: previewMessage.slice(0, 200),
				messageCount: messages.filter((m) => m.role === 'user' || m.role === 'assistant').length,
				sizeBytes,
				costUsd: totalCost,
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
				cacheReadTokens: totalCacheReadTokens,
				cacheCreationTokens: totalCacheWriteTokens,
				durationSeconds,
			});
		}

		// Sort by modified date (newest first)
		sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

		logger.info(
			`Found ${sessions.length} OpenCode sessions for project: ${projectPath}`,
			LOG_CONTEXT
		);
		return sessions;
	}

	async listSessionsPaginated(
		projectPath: string,
		options?: SessionListOptions
	): Promise<PaginatedSessionsResult> {
		const allSessions = await this.listSessions(projectPath);
		const { cursor, limit = 100 } = options || {};

		let startIndex = 0;
		if (cursor) {
			const cursorIndex = allSessions.findIndex((s) => s.sessionId === cursor);
			startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
		}

		const pageSessions = allSessions.slice(startIndex, startIndex + limit);
		const hasMore = startIndex + limit < allSessions.length;
		const nextCursor = hasMore ? pageSessions[pageSessions.length - 1]?.sessionId : null;

		return {
			sessions: pageSessions,
			hasMore,
			totalCount: allSessions.length,
			nextCursor,
		};
	}

	async readSessionMessages(
		_projectPath: string,
		sessionId: string,
		options?: SessionReadOptions
	): Promise<SessionMessagesResult> {
		const { messages, parts } = await this.loadSessionMessages(sessionId);

		const sessionMessages: SessionMessage[] = [];

		for (const msg of messages) {
			if (msg.role !== 'user' && msg.role !== 'assistant') continue;

			const msgParts = parts.get(msg.id) || [];
			const textContent = this.extractTextFromParts(msgParts);

			// Extract tool use if present
			const toolParts = msgParts.filter((p) => p.type === 'tool');
			const toolUse = toolParts.length > 0 ? toolParts : undefined;

			if (textContent || toolUse) {
				// Convert Unix timestamp (ms) to ISO string
				const timestamp = msg.time?.created ? new Date(msg.time.created).toISOString() : '';

				sessionMessages.push({
					type: msg.role,
					role: msg.role,
					content: textContent,
					timestamp,
					uuid: msg.id,
					toolUse,
				});
			}
		}

		// Apply offset and limit for lazy loading
		const offset = options?.offset ?? 0;
		const limit = options?.limit ?? 20;

		const startIndex = Math.max(0, sessionMessages.length - offset - limit);
		const endIndex = sessionMessages.length - offset;
		const slice = sessionMessages.slice(startIndex, endIndex);

		return {
			messages: slice,
			total: sessionMessages.length,
			hasMore: startIndex > 0,
		};
	}

	async searchSessions(
		projectPath: string,
		query: string,
		searchMode: SessionSearchMode
	): Promise<SessionSearchResult[]> {
		if (!query.trim()) {
			return [];
		}

		const sessions = await this.listSessions(projectPath);
		const searchLower = query.toLowerCase();
		const results: SessionSearchResult[] = [];

		for (const session of sessions) {
			const { messages, parts } = await this.loadSessionMessages(session.sessionId);

			let titleMatch = false;
			let userMatches = 0;
			let assistantMatches = 0;
			let matchPreview = '';

			for (const msg of messages) {
				const msgParts = parts.get(msg.id) || [];
				const textContent = this.extractTextFromParts(msgParts);
				const textLower = textContent.toLowerCase();

				if (msg.role === 'user' && textLower.includes(searchLower)) {
					if (!titleMatch) {
						titleMatch = true;
						if (!matchPreview) {
							const idx = textLower.indexOf(searchLower);
							const start = Math.max(0, idx - 60);
							const end = Math.min(textContent.length, idx + query.length + 60);
							matchPreview =
								(start > 0 ? '...' : '') +
								textContent.slice(start, end) +
								(end < textContent.length ? '...' : '');
						}
					}
					userMatches++;
				}

				if (msg.role === 'assistant' && textLower.includes(searchLower)) {
					assistantMatches++;
					if (!matchPreview && (searchMode === 'assistant' || searchMode === 'all')) {
						const idx = textLower.indexOf(searchLower);
						const start = Math.max(0, idx - 60);
						const end = Math.min(textContent.length, idx + query.length + 60);
						matchPreview =
							(start > 0 ? '...' : '') +
							textContent.slice(start, end) +
							(end < textContent.length ? '...' : '');
					}
				}
			}

			let matches = false;
			let matchType: 'title' | 'user' | 'assistant' = 'title';
			let matchCount = 0;

			switch (searchMode) {
				case 'title':
					matches = titleMatch;
					matchType = 'title';
					matchCount = titleMatch ? 1 : 0;
					break;
				case 'user':
					matches = userMatches > 0;
					matchType = 'user';
					matchCount = userMatches;
					break;
				case 'assistant':
					matches = assistantMatches > 0;
					matchType = 'assistant';
					matchCount = assistantMatches;
					break;
				case 'all':
					matches = titleMatch || userMatches > 0 || assistantMatches > 0;
					matchType = titleMatch ? 'title' : userMatches > 0 ? 'user' : 'assistant';
					matchCount = userMatches + assistantMatches;
					break;
			}

			if (matches) {
				results.push({
					sessionId: session.sessionId,
					matchType,
					matchPreview,
					matchCount,
				});
			}
		}

		return results;
	}

	getSessionPath(_projectPath: string, sessionId: string): string | null {
		// OpenCode uses a more complex structure with multiple directories
		// Return the message directory as the "session path"
		return this.getMessageDir(sessionId);
	}

	async deleteMessagePair(
		_projectPath: string,
		sessionId: string,
		userMessageUuid: string,
		fallbackContent?: string
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		try {
			// Load all messages for the session
			const { messages, parts } = await this.loadSessionMessages(sessionId);

			if (messages.length === 0) {
				logger.warn('No messages found in OpenCode session', LOG_CONTEXT, { sessionId });
				return { success: false, error: 'No messages found in session' };
			}

			// Find the target user message
			let userMessageIndex = -1;
			let targetMessage: OpenCodeMessage | null = null;

			// First try matching by UUID (message ID)
			for (let i = 0; i < messages.length; i++) {
				if (messages[i].id === userMessageUuid && messages[i].role === 'user') {
					userMessageIndex = i;
					targetMessage = messages[i];
					break;
				}
			}

			// Fallback: try content match
			if (userMessageIndex === -1 && fallbackContent) {
				const normalizedFallback = fallbackContent.trim().toLowerCase();

				for (let i = messages.length - 1; i >= 0; i--) {
					if (messages[i].role === 'user') {
						const msgParts = parts.get(messages[i].id) || [];
						const textContent = this.extractTextFromParts(msgParts);
						if (textContent.trim().toLowerCase() === normalizedFallback) {
							userMessageIndex = i;
							targetMessage = messages[i];
							logger.info('Found OpenCode message by content match', LOG_CONTEXT, {
								sessionId,
								index: i,
							});
							break;
						}
					}
				}
			}

			if (userMessageIndex === -1 || !targetMessage) {
				logger.warn('User message not found for deletion in OpenCode session', LOG_CONTEXT, {
					sessionId,
					userMessageUuid,
					hasFallback: !!fallbackContent,
				});
				return { success: false, error: 'User message not found' };
			}

			// Find all messages to delete (user message + following assistant messages until next user)
			const messagesToDelete: OpenCodeMessage[] = [targetMessage];
			const toolPartsBeingDeleted: OpenCodePart[] = [];

			for (let i = userMessageIndex + 1; i < messages.length; i++) {
				if (messages[i].role === 'user') {
					break;
				}
				messagesToDelete.push(messages[i]);

				// Collect tool parts from messages being deleted
				const msgParts = parts.get(messages[i].id) || [];
				for (const part of msgParts) {
					if (part.type === 'tool') {
						toolPartsBeingDeleted.push(part);
					}
				}
			}

			// Delete message files and their associated parts
			let filesDeleted = 0;
			const messageDir = this.getMessageDir(sessionId);

			for (const msg of messagesToDelete) {
				// Delete message file
				const messageFile = path.join(messageDir, `${msg.id}.json`);
				try {
					await fs.unlink(messageFile);
					filesDeleted++;
				} catch {
					// File may not exist
				}

				// Delete all part files for this message
				const partDir = this.getPartDir(msg.id);
				try {
					const partFiles = await listJsonFiles(partDir);
					for (const partFile of partFiles) {
						await fs.unlink(path.join(partDir, partFile));
						filesDeleted++;
					}
					// Try to remove the part directory if empty
					try {
						await fs.rmdir(partDir);
					} catch {
						// Directory may not be empty or may not exist
					}
				} catch {
					// Part directory may not exist
				}
			}

			// If we deleted tool parts, we need to clean up any orphaned tool references
			// in remaining messages. OpenCode stores tool state in parts, so we need to
			// check if any remaining messages reference the deleted tools.
			if (toolPartsBeingDeleted.length > 0) {
				const deletedToolIds = new Set(toolPartsBeingDeleted.map((p) => p.id));

				// Scan remaining messages for tool parts that might reference deleted tools
				for (const msg of messages) {
					if (messagesToDelete.includes(msg)) continue;

					const msgParts = parts.get(msg.id) || [];
					const partDir = this.getPartDir(msg.id);

					for (const part of msgParts) {
						// Check if this is a tool part that references a deleted tool
						// OpenCode tool parts may have state.input or state.output referencing other tool IDs
						if (part.type === 'tool' && part.state) {
							const stateStr = JSON.stringify(part.state);
							for (const deletedId of deletedToolIds) {
								if (stateStr.includes(deletedId)) {
									// This part references a deleted tool, remove it
									try {
										await fs.unlink(path.join(partDir, `${part.id}.json`));
										filesDeleted++;
										logger.info('Removed orphaned tool part reference', LOG_CONTEXT, {
											sessionId,
											partId: part.id,
											referencedDeletedTool: deletedId,
										});
									} catch {
										// Part file may not exist
									}
									break;
								}
							}
						}
					}
				}

				logger.info('Cleaned up tool parts in OpenCode session', LOG_CONTEXT, {
					sessionId,
					deletedToolIds: Array.from(deletedToolIds),
				});
			}

			logger.info('Deleted message pair from OpenCode session', LOG_CONTEXT, {
				sessionId,
				userMessageUuid,
				messagesDeleted: messagesToDelete.length,
				filesDeleted,
			});

			return { success: true, linesRemoved: filesDeleted };
		} catch (error) {
			logger.error('Error deleting message pair from OpenCode session', LOG_CONTEXT, {
				sessionId,
				error,
			});
			return { success: false, error: String(error) };
		}
	}
}
