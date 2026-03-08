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
import type { AgentSessionOriginsData } from '../stores/types';
import Store from 'electron-store';

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
/**
 * Concurrency-limited Promise.all — runs at most `limit` tasks in parallel.
 */
async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (nextIndex < items.length) {
			const i = nextIndex++;
			results[i] = await fn(items[i]);
		}
	}

	const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

const CONCURRENCY = 8;
const HISTORY_DIR_CACHE_TTL_MS = 30_000;

export class GeminiSessionStorage implements AgentSessionStorage {
	readonly agentId: ToolType = 'gemini-cli' as ToolType;
	private originsStore?: Store<AgentSessionOriginsData>;
	private historyDirCache = new Map<string, { dir: string | null; expiresAt: number }>();
	private writeQueues = new Map<string, Promise<void>>();

	constructor(originsStore?: Store<AgentSessionOriginsData>) {
		this.originsStore = originsStore;
	}

	/**
	 * Serialize file writes by path. Concurrent callers targeting the same file
	 * are queued so reads always see the latest committed state.
	 * Automatically cleans up the queue entry once it settles.
	 */
	private enqueueFileWrite<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.writeQueues.get(filePath) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		const settled = next.then(
			() => {},
			() => {}
		);
		this.writeQueues.set(filePath, settled);
		settled.then(() => {
			if (this.writeQueues.get(filePath) === settled) {
				this.writeQueues.delete(filePath);
			}
		});
		return next;
	}

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
	 * Results are cached with a 30s TTL to avoid repeated filesystem scans.
	 */
	private async getHistoryDir(projectPath: string): Promise<string | null> {
		const cacheKey = path.resolve(projectPath);
		const cached = this.historyDirCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.dir;
		}

		const result = await this.resolveHistoryDir(projectPath);
		this.historyDirCache.set(cacheKey, {
			dir: result,
			expiresAt: Date.now() + HISTORY_DIR_CACHE_TTL_MS,
		});
		return result;
	}

	/**
	 * Resolve the history directory for a project (uncached).
	 */
	private async resolveHistoryDir(projectPath: string): Promise<string | null> {
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
				// No .project_root file — basename alone is ambiguous (e.g. two projects
				// named "myapp" in different parents). Fall through to scan.
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
			const firstMessagePreview = firstUserText
				? firstUserText.slice(0, 200)
				: displayName.slice(0, 200);

			const startedAt = session.startTime || new Date(stats.mtimeMs).toISOString();
			const lastActiveAt = session.lastUpdated || new Date(stats.mtimeMs).toISOString();

			const startTime = Date.parse(startedAt);
			const endTime = Date.parse(lastActiveAt);
			const safeStart = Number.isNaN(startTime) ? stats.mtimeMs : startTime;
			const safeEnd = Number.isNaN(endTime) ? stats.mtimeMs : endTime;
			const durationSeconds = Math.max(0, Math.floor((safeEnd - safeStart) / 1000));

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

		// Parse all session files with bounded concurrency
		const resolvedProject = path.resolve(projectPath);
		const parsed = await pMap(
			sessionFiles,
			async ({ filePath, filename }) => {
				try {
					const fileStat = await fs.stat(filePath);
					if (fileStat.size === 0) return null;

					const sessionId = extractSessionIdFromFilename(filename) || filename.replace('.json', '');
					const session = await this.parseSessionFile(filePath, sessionId, {
						size: fileStat.size,
						mtimeMs: fileStat.mtimeMs,
					});

					if (session) {
						session.projectPath = resolvedProject;
					}
					return session;
				} catch (error) {
					logger.error(`Error stating Gemini session file: ${filename}`, LOG_CONTEXT, error);
					captureException(error, { operation: 'geminiStorage:statSessionFile', filename });
					return null;
				}
			},
			CONCURRENCY
		);
		const sessions = parsed.filter((s): s is AgentSessionInfo => s !== null);

		// Enrich with origin metadata (names, stars) from the origins store
		if (this.originsStore) {
			const resolvedPath = path.resolve(projectPath);
			const allOrigins = this.originsStore.get('origins', {});
			const projectOrigins = allOrigins['gemini-cli']?.[resolvedPath] || {};
			for (const session of sessions) {
				const meta = projectOrigins[session.sessionId];
				if (meta) {
					if (meta.sessionName) session.sessionName = meta.sessionName;
					if (meta.starred) session.starred = meta.starred;
					if (meta.origin) session.origin = meta.origin;
				}
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
		_sshConfig?: SshRemoteConfig
	): Promise<PaginatedSessionsResult> {
		const { cursor, limit = 100 } = options || {};

		const historyDir = await this.getHistoryDir(projectPath);
		if (!historyDir) {
			return { sessions: [], hasMore: false, totalCount: 0, nextCursor: null };
		}

		const sessionFiles = await this.findSessionFiles(historyDir);
		if (sessionFiles.length === 0) {
			return { sessions: [], hasMore: false, totalCount: 0, nextCursor: null };
		}

		// Stat files for mtime sorting (cheap — no JSON parse)
		const filesWithStats = await pMap(
			sessionFiles,
			async ({ filePath, filename }) => {
				try {
					const stat = await fs.stat(filePath);
					return { filePath, filename, mtimeMs: stat.mtimeMs, size: stat.size };
				} catch {
					return null;
				}
			},
			CONCURRENCY
		);

		const validFiles = filesWithStats
			.filter((f): f is NonNullable<typeof f> => f !== null && f.size > 0)
			.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

		const totalCount = validFiles.length;

		// Find start index based on cursor (cursor is a session ID)
		let startIndex = 0;
		if (cursor) {
			const cursorIndex = validFiles.findIndex((f) => {
				const sid = extractSessionIdFromFilename(f.filename);
				return sid === cursor;
			});
			startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
		}

		// Only parse files in the requested page range
		const pageFiles = validFiles.slice(startIndex, startIndex + limit);

		const pageSessions = await pMap(
			pageFiles,
			async ({ filePath, filename, mtimeMs, size }) => {
				const sessionId = extractSessionIdFromFilename(filename) || filename.replace('.json', '');
				const session = await this.parseSessionFile(filePath, sessionId, { size, mtimeMs });
				if (session) {
					session.projectPath = path.resolve(projectPath);
				}
				return session;
			},
			CONCURRENCY
		);

		const sessions = pageSessions.filter((s): s is AgentSessionInfo => s !== null);

		// Enrich with origin metadata
		if (this.originsStore) {
			const resolvedPath = path.resolve(projectPath);
			const allOrigins = this.originsStore.get('origins', {});
			const projectOrigins = allOrigins['gemini-cli']?.[resolvedPath] || {};
			for (const session of sessions) {
				const meta = projectOrigins[session.sessionId];
				if (meta) {
					if (meta.sessionName) session.sessionName = meta.sessionName;
					if (meta.starred) session.starred = meta.starred;
					if (meta.origin) session.origin = meta.origin;
				}
			}
		}

		const hasMore = startIndex + limit < totalCount;
		const nextCursor = hasMore ? sessions[sessions.length - 1]?.sessionId : null;

		return {
			sessions,
			hasMore,
			totalCount,
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
			const rawMessages = session.messages || [];

			for (let i = 0; i < rawMessages.length; i++) {
				const msg = rawMessages[i];
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
						uuid: String(i),
						toolUse: msg.toolCalls,
					});
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
		_sshConfig?: SshRemoteConfig
	): Promise<SessionSearchResult[]> {
		const trimmedQuery = query.trim();
		if (!trimmedQuery) {
			return [];
		}

		// Read directory once — no listSessions()+findSessionFile() double-read
		const historyDir = await this.getHistoryDir(projectPath);
		if (!historyDir) return [];

		const sessionFiles = await this.findSessionFiles(historyDir);
		if (sessionFiles.length === 0) return [];

		const searchLower = trimmedQuery.toLowerCase();
		const results: SessionSearchResult[] = [];

		// Process files with bounded concurrency
		await pMap(
			sessionFiles,
			async ({ filePath, filename }) => {
				try {
					const fileStat = await fs.stat(filePath);
					if (fileStat.size === 0) return;

					const content = await fs.readFile(filePath, 'utf-8');
					const sessionData = JSON.parse(content) as GeminiSessionFile;

					const sessionId =
						sessionData.sessionId ||
						extractSessionIdFromFilename(filename) ||
						filename.replace('.json', '');

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
							if (!titleMatch) return;
							matchType = 'title';
							matchCount = 1;
							matchPreview = titlePreview || messagePreview;
							break;
						case 'user':
							if (userMatches === 0) return;
							matchType = 'user';
							matchCount = userMatches;
							matchPreview = messagePreview || titlePreview;
							break;
						case 'assistant':
							if (assistantMatches === 0) return;
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
								return;
							}
					}

					if (!matchPreview) {
						matchPreview = titlePreview || messagePreview || sessionTitleSource.slice(0, 200);
					}

					if (!matchPreview) {
						matchPreview = trimmedQuery.slice(0, 200);
					}

					results.push({
						sessionId,
						matchType,
						matchPreview,
						matchCount,
					});
				} catch (error) {
					const sessionId = extractSessionIdFromFilename(filename) || filename.replace('.json', '');
					captureException(error, {
						operation: 'geminiStorage:searchSessions',
						sessionId,
					});
				}
			},
			CONCURRENCY
		);

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
		projectPath: string,
		sessionId: string,
		userMessageUuid: string,
		fallbackContent?: string,
		sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		if (sshConfig) {
			logger.warn('Delete message pair not supported for SSH remote sessions', LOG_CONTEXT);
			return { success: false, error: 'Delete not supported for remote sessions' };
		}

		const sessionFilePath = await this.findSessionFile(projectPath, sessionId);
		if (!sessionFilePath) {
			logger.warn('Gemini session file not found for deletion', LOG_CONTEXT, { sessionId });
			return { success: false, error: 'Session file not found' };
		}

		return this.enqueueFileWrite(sessionFilePath, async () => {
			try {
				const content = await fs.readFile(sessionFilePath, 'utf-8');
				const session = JSON.parse(content) as GeminiSessionFile;
				const messages = session.messages || [];

				// Find the target user message by array index (UUID is the stringified index)
				let userMessageIndex = -1;
				const parsedIndex = parseInt(userMessageUuid, 10);
				if (!isNaN(parsedIndex) && parsedIndex >= 0 && parsedIndex < messages.length) {
					if (messages[parsedIndex].type === 'user') {
						userMessageIndex = parsedIndex;
					}
				}

				// Fallback: content match
				if (userMessageIndex === -1 && fallbackContent) {
					const normalizedFallback = fallbackContent.trim();
					for (let i = messages.length - 1; i >= 0; i--) {
						if (messages[i].type !== 'user') continue;
						const textContent = getDisplayText(messages[i]);
						if (textContent.trim() === normalizedFallback) {
							userMessageIndex = i;
							logger.info('Found Gemini message by content match', LOG_CONTEXT, {
								sessionId,
								index: i,
							});
							break;
						}
					}
				}

				if (userMessageIndex === -1) {
					logger.warn('User message not found for deletion in Gemini session', LOG_CONTEXT, {
						sessionId,
						userMessageUuid,
						hasFallback: !!fallbackContent,
					});
					return { success: false, error: 'Message not found' };
				}

				// Scan forward from userMessageIndex+1 to find the paired gemini response.
				// Track scanEndIndex through the scan to include intermediate messages
				// (info/error/warning) in the deletion range, preventing orphans.
				let pairedResponseIndex = -1;
				let scanEndIndex = userMessageIndex + 1;
				for (let i = userMessageIndex + 1; i < messages.length; i++) {
					if (messages[i].type === 'gemini') {
						pairedResponseIndex = i;
						scanEndIndex = i + 1;
						break;
					}
					if (messages[i].type === 'user') {
						// Hit the next user message without finding a gemini response.
						// scanEndIndex already covers intermediates up to this point.
						break;
					}
					// Intermediate message (info/error/warning) — include in deletion range
					scanEndIndex = i + 1;
				}

				// If we found a gemini response, also scan past it for trailing intermediates
				// (e.g., tool completion info) that belong to this exchange
				if (pairedResponseIndex !== -1) {
					for (let i = pairedResponseIndex + 1; i < messages.length; i++) {
						if (messages[i].type === 'user' || messages[i].type === 'gemini') {
							break;
						}
						// Trailing intermediate — include in deletion range
						scanEndIndex = i + 1;
					}
				}

				const endIndex = scanEndIndex;
				const removedCount = endIndex - userMessageIndex;

				// Create backup before modifying
				const backupPath = `${sessionFilePath}.bak`;
				await fs.writeFile(backupPath, content, 'utf-8');

				try {
					// Splice out the messages
					session.messages = [...messages.slice(0, userMessageIndex), ...messages.slice(endIndex)];
					session.lastUpdated = new Date().toISOString();

					// Atomic write: temp file + rename prevents partial/corrupt reads
					const tmpPath = `${sessionFilePath}.tmp`;
					await fs.writeFile(tmpPath, JSON.stringify(session, null, 2), 'utf-8');
					await fs.rename(tmpPath, sessionFilePath);

					// Clean up backup on success
					fs.unlink(backupPath).catch((err) => {
						logger.warn('Failed to clean up session backup file', LOG_CONTEXT, {
							backupPath,
							error: err instanceof Error ? err.message : String(err),
						});
					});

					logger.info('Deleted message pair from Gemini session', LOG_CONTEXT, {
						sessionId,
						userMessageUuid,
						linesRemoved: removedCount,
					});

					return { success: true, linesRemoved: removedCount };
				} catch (writeError) {
					// Restore from backup on write failure
					try {
						await fs.copyFile(backupPath, sessionFilePath);
					} catch {
						// Best effort restore
					}
					// Clean up orphaned temp file
					fs.unlink(`${sessionFilePath}.tmp`).catch(() => {});
					logger.error(
						'Failed to write Gemini session file after deletion',
						LOG_CONTEXT,
						writeError
					);
					captureException(writeError, {
						operation: 'geminiStorage:deleteMessagePair:write',
						sessionId,
					});
					return { success: false, error: 'Failed to write session file' };
				}
			} catch (error) {
				logger.error('Error deleting message pair from Gemini session', LOG_CONTEXT, {
					sessionId,
					error,
				});
				captureException(error, {
					operation: 'geminiStorage:deleteMessagePair',
					sessionId,
				});
				return { success: false, error: String(error) };
			}
		});
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
			} catch (error) {
				captureException(error, {
					operation: 'geminiStorage:findSessionFile',
					filePath,
				});
			}
		}

		return null;
	}

	/**
	 * Get all named sessions across all projects.
	 * Used by the aggregated named sessions view (agentSessions:getAllNamedSessions).
	 * Batches filesystem access by project path to avoid redundant getHistoryDir/findSessionFiles calls.
	 */
	async getAllNamedSessions(): Promise<
		Array<{
			agentSessionId: string;
			projectPath: string;
			sessionName: string;
			starred?: boolean;
			lastActivityAt?: number;
		}>
	> {
		if (!this.originsStore) {
			return [];
		}

		const allOrigins = this.originsStore.get('origins', {});
		const geminiOrigins = allOrigins['gemini-cli'] || {};
		const namedSessions: Array<{
			agentSessionId: string;
			projectPath: string;
			sessionName: string;
			starred?: boolean;
			lastActivityAt?: number;
		}> = [];

		for (const [projectPath, sessions] of Object.entries(geminiOrigins)) {
			// Collect named sessions for this project first
			const namedEntries: Array<{
				sessionId: string;
				info: { sessionName: string; starred?: boolean };
			}> = [];
			for (const [sessionId, info] of Object.entries(sessions)) {
				if (typeof info === 'object' && info.sessionName) {
					namedEntries.push({
						sessionId,
						info: info as { sessionName: string; starred?: boolean },
					});
				}
			}
			if (namedEntries.length === 0) continue;

			// Resolve history dir and session files once per project
			const historyDir = await this.getHistoryDir(projectPath);
			let sessionFileMap: Map<string, string> | null = null;
			if (historyDir) {
				const files = await this.findSessionFiles(historyDir);
				sessionFileMap = new Map<string, string>();
				for (const { filePath, filename } of files) {
					const fileSessionId = extractSessionIdFromFilename(filename);
					if (fileSessionId) {
						sessionFileMap.set(fileSessionId, filePath);
					}
				}
			}

			for (const { sessionId, info } of namedEntries) {
				let lastActivityAt: number | undefined;
				const filePath = sessionFileMap?.get(sessionId);
				if (filePath) {
					try {
						const stats = await fs.stat(filePath);
						lastActivityAt = stats.mtime.getTime();
					} catch {
						// File inaccessible — still include the entry
					}
				}

				namedSessions.push({
					agentSessionId: sessionId,
					projectPath,
					sessionName: info.sessionName,
					starred: info.starred,
					lastActivityAt,
				});
			}
		}

		return namedSessions;
	}
}
