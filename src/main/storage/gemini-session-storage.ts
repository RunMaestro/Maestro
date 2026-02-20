/**
 * Gemini CLI Session Storage Implementation
 *
 * This module implements the AgentSessionStorage interface for Google Gemini CLI.
 * Gemini stores sessions as JSON files in ~/.gemini/history/{project_name}/
 *
 * File structure:
 * - Each project has a directory named by the project's directory basename
 * - A .project_root file in each directory contains the absolute project path
 * - Session files are named session-{timestamp}-{sessionId}.json
 * - Each session file is a full JSON object (not JSONL)
 *
 * Session format:
 * ```json
 * {
 *   "sessionId": "uuid",
 *   "messages": [
 *     {
 *       "type": "user" | "gemini" | "info" | "error" | "warning",
 *       "content": "string or array of content parts",
 *       "displayContent": "optional override display",
 *       "toolCalls": [{ "id": "...", "name": "...", "status": "success|error", ... }]
 *     }
 *   ],
 *   "startTime": "ISO8601",
 *   "lastUpdated": "ISO8601",
 *   "summary": "optional AI-generated summary"
 * }
 * ```
 */

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
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
} from '../agents';
import type { ToolType, SshRemoteConfig } from '../../shared/types';

const LOG_CONTEXT = 'gemini-session-storage';

/**
 * Gemini session file JSON structure
 */
interface GeminiSessionFile {
	sessionId: string;
	messages: GeminiMessage[];
	startTime?: string;
	lastUpdated?: string;
	summary?: string;
}

/**
 * Gemini message content part (when content is an array)
 */
interface GeminiContentPart {
	type?: string;
	text?: string;
	mimeType?: string;
}

/**
 * Gemini message structure
 */
interface GeminiMessage {
	type: 'user' | 'gemini' | 'info' | 'error' | 'warning';
	content: string | GeminiContentPart[];
	displayContent?: string;
	toolCalls?: GeminiToolCall[];
}

/**
 * Gemini tool call structure
 */
interface GeminiToolCall {
	id?: string;
	name?: string;
	status?: string;
	args?: unknown;
	result?: unknown;
}

/**
 * Extract text content from Gemini message content field.
 * Content can be a string or an array of content parts.
 */
function extractGeminiContent(content: string | GeminiContentPart[] | undefined): string {
	if (!content) return '';
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => part.text || '')
			.filter((text) => text.trim())
			.join(' ');
	}
	return '';
}

function getDisplayText(msg: GeminiMessage): string {
	const display = msg.displayContent?.trim();
	if (display) {
		return display;
	}
	return extractGeminiContent(msg.content).trim();
}

function getFirstUserMessageText(messages?: GeminiMessage[]): string {
	if (!messages) {
		return '';
	}
	for (const msg of messages) {
		if (msg.type !== 'user') continue;
		const text = getDisplayText(msg);
		if (text) {
			return text;
		}
	}
	return '';
}

/**
 * Check if a Gemini message is a conversation message (not a system message)
 */
function isConversationMessage(msg: GeminiMessage): boolean {
	return msg.type === 'user' || msg.type === 'gemini';
}

/**
 * Extract session ID from a Gemini session filename.
 * Format: session-{timestamp}-{sessionId}.json
 */
function extractSessionIdFromFilename(filename: string): string | null {
	// Match pattern: session-TIMESTAMP-UUID.json
	const match = filename.match(/^session-[^-]+-(.+)\.json$/);
	if (match) {
		return match[1];
	}
	return null;
}

/**
 * Format tool call summaries for display in message content
 */
function formatToolCallSummaries(toolCalls: GeminiToolCall[]): string {
	return toolCalls
		.map((tc) => {
			const name = tc.name || 'unknown_tool';
			const status = tc.status ? ` (${tc.status})` : '';
			return `[Tool: ${name}${status}]`;
		})
		.join('\n');
}

/**
 * Gemini CLI Session Storage Implementation
 *
 * Provides access to Gemini CLI's local session storage at ~/.gemini/history/
 */
	export class GeminiSessionStorage implements AgentSessionStorage {
	readonly agentId: ToolType = 'gemini-cli' as ToolType;

	get displayName(): string {
		return '~/.gemini/history';
	}

	/**
	 * Get the base Gemini history directory
	 */
	private getBaseHistoryDir(): string {
		return path.join(os.homedir(), '.gemini', 'history');
	}

	/**
	 * Get the history directory for a specific project.
	 * First checks basename match, then falls back to scanning .project_root files.
	 */
	private async getHistoryDir(projectPath: string): Promise<string | null> {
		const baseDir = this.getBaseHistoryDir();
		const basename = path.basename(projectPath);
		const directPath = path.join(baseDir, basename);

		// First, try the direct basename match
		try {
			await fs.access(directPath);
			// Verify via .project_root if available
			try {
				const projectRoot = await fs.readFile(path.join(directPath, '.project_root'), 'utf-8');
				if (path.resolve(projectRoot.trim()) === path.resolve(projectPath)) {
					return directPath;
				}
			} catch {
				// No .project_root file — basename match is the best we have
				return directPath;
			}
		} catch {
			// Direct path doesn't exist, continue to scan
		}

		// Fallback: scan all subdirectories for matching .project_root
		try {
			const subdirs = await fs.readdir(baseDir);
			for (const subdir of subdirs) {
				const subdirPath = path.join(baseDir, subdir);
				try {
					const stat = await fs.stat(subdirPath);
					if (!stat.isDirectory()) continue;

					const projectRootFile = path.join(subdirPath, '.project_root');
					try {
						const projectRoot = await fs.readFile(projectRootFile, 'utf-8');
						if (path.resolve(projectRoot.trim()) === path.resolve(projectPath)) {
							return subdirPath;
						}
					} catch {
						// No .project_root file in this subdir
					}
				} catch {
					continue;
				}
			}
		} catch {
			// Base history dir doesn't exist
		}

		return null;
	}

	/**
	 * Find all session files in a history directory
	 */
	private async findSessionFiles(
		historyDir: string
	): Promise<Array<{ filePath: string; filename: string }>> {
		const sessionFiles: Array<{ filePath: string; filename: string }> = [];

		try {
			const files = await fs.readdir(historyDir);
			for (const file of files) {
				if (file.startsWith('session-') && file.endsWith('.json')) {
					sessionFiles.push({
						filePath: path.join(historyDir, file),
						filename: file,
					});
				}
			}
		} catch {
			// Directory may not exist
		}

		return sessionFiles;
	}

	/**
	 * Parse a Gemini session JSON file and extract session info
	 */
	private async parseSessionFile(
		filePath: string,
		fallbackSessionId: string,
		stats: { size: number; mtimeMs: number }
	): Promise<AgentSessionInfo | null> {
		try {
			const content = await fs.readFile(filePath, 'utf-8');
			const session = JSON.parse(content) as GeminiSessionFile;

			const sessionId = session.sessionId || fallbackSessionId;

			// Count only conversation messages (skip info/error/warning)
			const conversationMessages = (session.messages || []).filter(isConversationMessage);
			const messageCount = conversationMessages.length;

			const summary = session.summary?.trim() || '';
			const firstUserText = getFirstUserMessageText(conversationMessages);
			const displayName =
				summary || firstUserText.slice(0, 50) || `Gemini session ${sessionId.slice(0, 8)}`;
			const firstMessagePreview =
				firstUserText ? firstUserText.slice(0, 200) : displayName.slice(0, 200);

			const startedAt = session.startTime || new Date(stats.mtimeMs).toISOString();
			const lastActiveAt = session.lastUpdated || new Date(stats.mtimeMs).toISOString();

			const startTime = new Date(startedAt).getTime();
			const endTime = new Date(lastActiveAt).getTime();
			const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

			return {
				sessionId,
				projectPath: '',
				timestamp: startedAt,
				modifiedAt: lastActiveAt,
				firstMessage: firstMessagePreview,
				messageCount,
				sizeBytes: stats.size,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				durationSeconds,
				sessionName: displayName,
			};
		} catch (error) {
			logger.error(`Error reading Gemini session file: ${filePath}`, LOG_CONTEXT, error);
			captureException(error, { operation: 'geminiStorage:readSessionFile', filePath });
			return null;
		}
	}

	async listSessions(
		projectPath: string,
		_sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		const historyDir = await this.getHistoryDir(projectPath);
		if (!historyDir) {
			logger.info(`No Gemini history directory found for project: ${projectPath}`, LOG_CONTEXT);
			return [];
		}

		const sessionFiles = await this.findSessionFiles(historyDir);

		if (sessionFiles.length === 0) {
			logger.info(`No Gemini sessions found in ${historyDir}`, LOG_CONTEXT);
			return [];
		}

		const sessions: AgentSessionInfo[] = [];

		for (const { filePath, filename } of sessionFiles) {
			try {
				const fileStat = await fs.stat(filePath);
				if (fileStat.size === 0) continue;

				const sessionId = extractSessionIdFromFilename(filename) || filename.replace('.json', '');
				const session = await this.parseSessionFile(filePath, sessionId, {
					size: fileStat.size,
					mtimeMs: fileStat.mtimeMs,
				});

				if (session) {
					session.projectPath = path.resolve(projectPath);
					sessions.push(session);
				}
			} catch (error) {
				logger.error(`Error stating Gemini session file: ${filename}`, LOG_CONTEXT, error);
				captureException(error, { operation: 'geminiStorage:statSessionFile', filename });
			}
		}

		// Sort newest first
		sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

		logger.info(
			`Found ${sessions.length} Gemini sessions for project: ${projectPath}`,
			LOG_CONTEXT
		);

		return sessions;
	}

	async listSessionsPaginated(
		projectPath: string,
		options?: SessionListOptions,
		sshConfig?: SshRemoteConfig
	): Promise<PaginatedSessionsResult> {
		const allSessions = await this.listSessions(projectPath, sshConfig);
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
		projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		_sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		const sessionFilePath = await this.findSessionFile(projectPath, sessionId);
		if (!sessionFilePath) {
			logger.warn(`Gemini session file not found: ${sessionId}`, LOG_CONTEXT);
			return { messages: [], total: 0, hasMore: false };
		}

		try {
			const content = await fs.readFile(sessionFilePath, 'utf-8');
			const session = JSON.parse(content) as GeminiSessionFile;

			const messages: SessionMessage[] = [];
			let messageIndex = 0;

			for (const msg of session.messages || []) {
				// Skip system messages (info, error, warning)
				if (!isConversationMessage(msg)) continue;

				// Map Gemini types to standard roles
				const role = msg.type === 'user' ? 'human' : 'assistant';
				let textContent = getDisplayText(msg);

				// Append tool call summaries if present
				if (msg.toolCalls && msg.toolCalls.length > 0) {
					const toolSummaries = formatToolCallSummaries(msg.toolCalls);
					textContent = textContent ? `${textContent}\n\n${toolSummaries}` : toolSummaries;
				}

				if (textContent) {
					messages.push({
						type: role,
						role,
						content: textContent,
						timestamp: '',
						uuid: `gemini-msg-${messageIndex}`,
						toolUse: msg.toolCalls,
					});
					messageIndex++;
				}
			}

			// Apply offset and limit for lazy loading
			const offset = options?.offset ?? 0;
			const limit = options?.limit ?? 20;

			const startIndex = Math.max(0, messages.length - offset - limit);
			const endIndex = messages.length - offset;
			const slice = messages.slice(startIndex, endIndex);

			return {
				messages: slice,
				total: messages.length,
				hasMore: startIndex > 0,
			};
		} catch (error) {
			logger.error(`Error reading Gemini session: ${sessionId}`, LOG_CONTEXT, error);
			captureException(error, { operation: 'geminiStorage:readSessionMessages', sessionId });
			return { messages: [], total: 0, hasMore: false };
		}
	}

	async searchSessions(
		projectPath: string,
		query: string,
		searchMode: SessionSearchMode,
		sshConfig?: SshRemoteConfig
	): Promise<SessionSearchResult[]> {
		const trimmedQuery = query.trim();
		if (!trimmedQuery) {
			return [];
		}

		const sessions = await this.listSessions(projectPath, sshConfig);
		const searchLower = trimmedQuery.toLowerCase();
		const results: SessionSearchResult[] = [];

		for (const session of sessions) {
			const sessionFilePath = await this.findSessionFile(projectPath, session.sessionId);
			if (!sessionFilePath) continue;

			try {
				const content = await fs.readFile(sessionFilePath, 'utf-8');
				const sessionData = JSON.parse(content) as GeminiSessionFile;

				const sessionTitleSource =
					sessionData.summary?.trim() || getFirstUserMessageText(sessionData.messages) || '';
				const titleMatch = sessionTitleSource
					? sessionTitleSource.toLowerCase().includes(searchLower)
					: false;
				const titlePreview = titleMatch ? sessionTitleSource.slice(0, 200) : '';
				let userMatches = 0;
				let assistantMatches = 0;
				let messagePreview = '';

				for (const msg of sessionData.messages || []) {
					if (!isConversationMessage(msg)) continue;
					const textContent = getDisplayText(msg);
					if (!textContent) continue;

					const textLower = textContent.toLowerCase();
					if (!textLower.includes(searchLower)) continue;

					if (!messagePreview) {
						messagePreview = textContent.slice(0, 200);
					}

					if (msg.type === 'user') {
						userMatches++;
					} else {
						assistantMatches++;
					}
				}

				let matchType: 'title' | 'user' | 'assistant' = 'title';
				let matchCount = 0;
				let matchPreview = '';

				switch (searchMode) {
					case 'title':
						if (!titleMatch) continue;
						matchType = 'title';
						matchCount = 1;
						matchPreview = titlePreview || messagePreview;
						break;
					case 'user':
						if (userMatches === 0) continue;
						matchType = 'user';
						matchCount = userMatches;
						matchPreview = messagePreview || titlePreview;
						break;
					case 'assistant':
						if (assistantMatches === 0) continue;
						matchType = 'assistant';
						matchCount = assistantMatches;
						matchPreview = messagePreview || titlePreview;
						break;
					case 'all':
					default:
						if (titleMatch) {
							matchType = 'title';
							matchCount = 1;
							matchPreview = titlePreview || messagePreview;
						} else if (userMatches > 0) {
							matchType = 'user';
							matchCount = userMatches;
							matchPreview = messagePreview || titlePreview;
						} else if (assistantMatches > 0) {
							matchType = 'assistant';
							matchCount = assistantMatches;
							matchPreview = messagePreview || titlePreview;
						} else {
							continue;
						}
				}

				if (!matchPreview) {
					matchPreview = titlePreview || messagePreview || sessionTitleSource.slice(0, 200);
				}

				if (!matchPreview) {
					matchPreview = trimmedQuery.slice(0, 200);
				}

				results.push({
					sessionId: session.sessionId,
					matchType,
					matchPreview,
					matchCount,
				});
			} catch {
				// Skip files that can't be read during search
			}
		}

		return results;
	}

	getSessionPath(
		_projectPath: string,
		_sessionId: string,
		_sshConfig?: SshRemoteConfig
	): string | null {
		// Synchronous version - returns null since we need async file search
		return null;
	}

	async deleteMessagePair(
		_projectPath: string,
		_sessionId: string,
		_userMessageUuid: string,
		_fallbackContent?: string,
		_sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		return { success: false, error: 'Gemini CLI sessions are read-only in Maestro' };
	}

	/**
	 * Find the file path for a session by ID
	 */
	private async findSessionFile(projectPath: string, sessionId: string): Promise<string | null> {
		const historyDir = await this.getHistoryDir(projectPath);
		if (!historyDir) return null;

		const sessionFiles = await this.findSessionFiles(historyDir);

		// Try matching by extracted session ID from filename
		for (const { filePath, filename } of sessionFiles) {
			const fileSessionId = extractSessionIdFromFilename(filename);
			if (fileSessionId === sessionId) {
				return filePath;
			}
		}

		// Fallback: try reading each file and checking sessionId field
		for (const { filePath } of sessionFiles) {
			try {
				const content = await fs.readFile(filePath, 'utf-8');
				const session = JSON.parse(content) as GeminiSessionFile;
				if (session.sessionId === sessionId) {
					return filePath;
				}
			} catch {
				// Skip files that can't be read
			}
		}

		return null;
	}
}
