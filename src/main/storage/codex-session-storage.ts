/**
 * Codex CLI Session Storage Implementation
 *
 * This module implements the AgentSessionStorage interface for OpenAI Codex CLI.
 * Codex stores sessions as JSONL files in ~/.codex/sessions/YYYY/MM/DD/
 *
 * File structure:
 * - Each session is a .jsonl file named rollout-<timestamp>-<uuid>.jsonl
 * - First line contains session metadata (id, timestamp, git info)
 * - Subsequent lines contain message entries
 *
 * Session format (from Codex --json output):
 * ```json
 * // First line: session metadata
 * {"id":"uuid","timestamp":"ISO8601","git":{"commit_hash":"...","branch":"main","repository_url":"..."}}
 *
 * // Subsequent lines: conversation messages
 * {"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}
 * {"type":"message","role":"assistant","content":[...]}
 * ```
 */

import { app } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import { readFileRemote, readDirRemote, statRemote } from '../utils/remote-fs';
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
import type { ToolType, SshRemoteConfig } from '../../shared/types';

const LOG_CONTEXT = '[CodexSessionStorage]';

/**
 * Get Codex sessions base directory (platform-specific)
 * - Linux/macOS: ~/.codex/sessions
 * - Windows: %USERPROFILE%\.codex\sessions (Codex uses dotfile convention on all platforms)
 */
function getCodexSessionsDir(): string {
	// Codex CLI uses ~/.codex on all platforms (including Windows)
	return path.join(os.homedir(), '.codex', 'sessions');
}

const CODEX_SESSIONS_DIR = getCodexSessionsDir();

const CODEX_SESSION_CACHE_VERSION = 3; // Bumped: skip markdown-style system context in firstMessage preview
const CODEX_SESSION_CACHE_FILENAME = 'codex-sessions-cache.json';

/**
 * Parse limits for session files
 */
const CODEX_SESSION_PARSE_LIMITS = {
	FIRST_MESSAGE_SCAN_LINES: 50,
	LAST_TIMESTAMP_SCAN_LINES: 20,
	FIRST_MESSAGE_PREVIEW_LENGTH: 200,
} as const;

/**
 * Codex session metadata structure (first line of JSONL)
 * Format: { type: 'session_meta', payload: { id, cwd, timestamp, ... } }
 */
interface CodexSessionMetadata {
	type?: string;
	timestamp?: string;
	payload?: {
		id: string;
		cwd?: string;
		timestamp?: string;
		originator?: string;
		cli_version?: string;
		model_provider?: string;
		git?: {
			commit_hash?: string;
			branch?: string;
			repository_url?: string;
		};
	};
	// Legacy format (direct fields)
	id?: string;
	git?: {
		commit_hash?: string;
		branch?: string;
		repository_url?: string;
	};
}

/**
 * Codex message content structure
 */
interface CodexMessageContent {
	type: string;
	text?: string;
	// Tool use fields
	tool?: string;
	args?: unknown;
	output?: string;
}

/**
 * Extract the session ID (UUID) from a Codex session filename
 * Format: rollout-TIMESTAMP-UUID.jsonl
 */
function extractSessionIdFromFilename(filename: string): string | null {
	// Match pattern: rollout-YYYYMMDD_HHMMSS_MMM-UUID.jsonl or similar
	const match = filename.match(/rollout-[\d_]+-([a-f0-9-]+)\.jsonl$/i);
	if (match) {
		return match[1];
	}
	// Fallback: use filename without extension
	return filename.replace('.jsonl', '');
}

/**
 * Extract text from Codex message content array
 */
function extractTextFromContent(content: CodexMessageContent[] | undefined): string {
	if (!content || !Array.isArray(content)) {
		return '';
	}

	const textParts = content
		.filter(
			(part) => part.type === 'input_text' || part.type === 'text' || part.type === 'output_text'
		)
		.map((part) => part.text || '')
		.filter((text) => text.trim());

	return textParts.join(' ');
}

/**
 * Check if text is a system/environment context message that should be skipped for preview
 */
function isSystemContextMessage(text: string): boolean {
	if (!text) return false;
	const trimmed = text.trim();
	// Skip messages that start with environment/system context XML tags
	if (
		trimmed.startsWith('<environment_context>') ||
		trimmed.startsWith('<cwd>') ||
		trimmed.startsWith('<system>') ||
		trimmed.startsWith('<approval_policy>')
	) {
		return true;
	}
	// Skip markdown-formatted system context (e.g., "# Context Your name is **Maestro Codex**...")
	if (
		trimmed.startsWith('# Context') ||
		trimmed.startsWith('# Maestro System Context') ||
		trimmed.startsWith('# System Context')
	) {
		return true;
	}
	return false;
}

function extractCwdFromText(text: string): string | null {
	const match = text.match(/<cwd>([^<]+)<\/cwd>/i);
	return match ? match[1].trim() : null;
}

function normalizeProjectPath(projectPath: string): string {
	return path.resolve(projectPath);
}

function isSessionForProject(sessionProjectPath: string, projectPath: string): boolean {
	const normalizedSession = normalizeProjectPath(sessionProjectPath);
	const normalizedProject = normalizeProjectPath(projectPath);
	if (normalizedSession === normalizedProject) {
		return true;
	}
	const prefix = normalizedProject.endsWith(path.sep)
		? normalizedProject
		: `${normalizedProject}${path.sep}`;
	return normalizedSession.startsWith(prefix);
}

interface CodexSessionCacheEntry {
	session: AgentSessionInfo;
	fileMtimeMs: number;
}

interface CodexSessionCache {
	version: number;
	lastProcessedAt: number;
	sessions: Record<string, CodexSessionCacheEntry>;
}

function getCodexSessionCachePath(): string {
	return path.join(app.getPath('userData'), 'stats-cache', CODEX_SESSION_CACHE_FILENAME);
}

async function loadCodexSessionCache(): Promise<CodexSessionCache | null> {
	try {
		const cachePath = getCodexSessionCachePath();
		const content = await fs.readFile(cachePath, 'utf-8');
		const cache = JSON.parse(content) as CodexSessionCache;
		if (cache.version !== CODEX_SESSION_CACHE_VERSION) {
			return null;
		}
		return cache;
	} catch {
		return null;
	}
}

async function saveCodexSessionCache(cache: CodexSessionCache): Promise<void> {
	try {
		const cachePath = getCodexSessionCachePath();
		const cacheDir = path.dirname(cachePath);
		await fs.mkdir(cacheDir, { recursive: true });
		await fs.writeFile(cachePath, JSON.stringify(cache), 'utf-8');
	} catch (error) {
		logger.warn('Failed to save Codex session cache', LOG_CONTEXT, { error });
	}
}

/**
 * Parse a Codex session file and extract metadata
 */
async function parseSessionFile(
	filePath: string,
	sessionId: string,
	stats: { size: number; mtimeMs: number }
): Promise<AgentSessionInfo | null> {
	try {
		const content = await fs.readFile(filePath, 'utf-8');
		const lines = content.split('\n').filter((l) => l.trim());

		if (lines.length === 0) {
			return null;
		}

		// Parse first line as metadata
		let metadata: CodexSessionMetadata | null = null;
		let timestamp = new Date(stats.mtimeMs).toISOString();
		let sessionProjectPath: string | null = null;

		try {
			const firstLine = JSON.parse(lines[0]);
			// New format: { type: 'session_meta', payload: { id, cwd, timestamp, ... } }
			if (firstLine.type === 'session_meta' && firstLine.payload) {
				metadata = firstLine as CodexSessionMetadata;
				timestamp = firstLine.payload.timestamp || firstLine.timestamp || timestamp;
				// Get project path directly from session_meta
				if (firstLine.payload.cwd) {
					sessionProjectPath = firstLine.payload.cwd;
				}
			}
			// Legacy format: { id, timestamp, ... } at top level
			else if (firstLine.id && firstLine.timestamp) {
				metadata = firstLine as CodexSessionMetadata;
				timestamp = firstLine.timestamp || timestamp;
			}
		} catch {
			// First line may not be metadata, continue parsing
		}

		// Count messages and find first assistant response (preferred) or user message (fallback)
		let firstAssistantMessage = '';
		let firstUserMessage = '';
		let userMessageCount = 0;
		let assistantMessageCount = 0;
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCachedTokens = 0;
		let firstTimestamp = timestamp;
		let lastTimestamp = timestamp;

		for (let i = 0; i < lines.length; i++) {
			try {
				const entry = JSON.parse(lines[i]);

				// Handle turn.completed for usage stats
				if (entry.type === 'turn.completed' && entry.usage) {
					totalInputTokens += entry.usage.input_tokens || 0;
					totalOutputTokens += entry.usage.output_tokens || 0;
					totalOutputTokens += entry.usage.reasoning_output_tokens || 0;
					totalCachedTokens += entry.usage.cached_input_tokens || 0;
				}

				// Handle Codex "event_msg" usage stats
				if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
					const usage = entry.payload.info?.total_token_usage;
					if (usage) {
						totalInputTokens += usage.input_tokens || 0;
						totalOutputTokens += usage.output_tokens || 0;
						totalOutputTokens += usage.reasoning_output_tokens || 0;
						totalCachedTokens += usage.cached_input_tokens || 0;
					}
				}

				// Handle message entries (legacy format)
				if (entry.type === 'message') {
					if (entry.role === 'user') {
						userMessageCount++;
						// Extract text and check for system context
						if (entry.content) {
							const text = extractTextFromContent(entry.content);
							// Capture first user message as fallback preview (skip system context)
							if (!firstUserMessage && text.trim() && !isSystemContextMessage(text)) {
								firstUserMessage = text;
							}
							// Fallback: extract cwd from message content if not in session_meta
							if (!sessionProjectPath) {
								const cwd = extractCwdFromText(text);
								if (cwd) {
									sessionProjectPath = cwd;
								}
							}
						}
					} else if (entry.role === 'assistant') {
						assistantMessageCount++;
						// Capture first assistant message as preferred preview
						if (!firstAssistantMessage && entry.content) {
							const text = extractTextFromContent(entry.content);
							if (text.trim()) {
								firstAssistantMessage = text;
							}
						}
					}
				}

				// Handle response_item entries (current Codex format)
				if (entry.type === 'response_item' && entry.payload?.type === 'message') {
					if (entry.payload.role === 'user') {
						userMessageCount++;
						// Extract text and check for system context
						if (entry.payload.content) {
							const text = extractTextFromContent(entry.payload.content);
							// Capture first user message as fallback preview (skip system context)
							if (!firstUserMessage && text.trim() && !isSystemContextMessage(text)) {
								firstUserMessage = text;
							}
							// Fallback: extract cwd from message content if not in session_meta
							if (!sessionProjectPath) {
								const cwd = extractCwdFromText(text);
								if (cwd) {
									sessionProjectPath = cwd;
								}
							}
						}
					} else if (entry.payload.role === 'assistant') {
						assistantMessageCount++;
						// Capture first assistant message as preferred preview
						if (!firstAssistantMessage && entry.payload.content) {
							const text = extractTextFromContent(entry.payload.content);
							if (text.trim()) {
								firstAssistantMessage = text;
							}
						}
					}
				}

				// Handle item.completed for agent messages
				if (entry.type === 'item.completed' && entry.item) {
					if (entry.item.type === 'agent_message') {
						assistantMessageCount++;
						// Capture first agent message as preferred preview
						if (!firstAssistantMessage && entry.item.text) {
							firstAssistantMessage = entry.item.text;
						}
					}
				}

				// Track timestamps for duration
				if (entry.timestamp) {
					const entryTime = new Date(entry.timestamp).getTime();
					const firstTime = new Date(firstTimestamp).getTime();
					const lastTime = new Date(lastTimestamp).getTime();

					if (entryTime < firstTime) {
						firstTimestamp = entry.timestamp;
					}
					if (entryTime > lastTime) {
						lastTimestamp = entry.timestamp;
					}
				}
			} catch {
				// Skip malformed lines
			}
		}

		// Use assistant response as preview if available, otherwise fall back to user message
		const previewMessage = firstAssistantMessage || firstUserMessage;

		const messageCount = userMessageCount + assistantMessageCount;

		const startTime = new Date(firstTimestamp).getTime();
		const endTime = new Date(lastTimestamp).getTime();
		const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

		// Extract session ID from metadata (new format uses payload.id, legacy uses id)
		const metadataSessionId = metadata?.payload?.id || metadata?.id || sessionId;

		return {
			sessionId: metadataSessionId,
			projectPath: sessionProjectPath ? normalizeProjectPath(sessionProjectPath) : '',
			timestamp: firstTimestamp,
			modifiedAt: new Date(stats.mtimeMs).toISOString(),
			firstMessage: previewMessage.slice(
				0,
				CODEX_SESSION_PARSE_LIMITS.FIRST_MESSAGE_PREVIEW_LENGTH
			),
			messageCount,
			sizeBytes: stats.size,
			// Note: costUsd omitted - Codex doesn't provide cost and pricing varies by model
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheReadTokens: totalCachedTokens,
			cacheCreationTokens: 0, // Codex doesn't report cache creation separately
			durationSeconds,
		};
	} catch (error) {
		logger.error(`Error reading Codex session file: ${filePath}`, LOG_CONTEXT, error);
		return null;
	}
}

/**
 * Codex CLI Session Storage Implementation
 *
 * Provides access to Codex CLI's local session storage at ~/.codex/sessions/
 */
export class CodexSessionStorage implements AgentSessionStorage {
	readonly agentId: ToolType = 'codex';

	/**
	 * Get the Codex sessions directory path
	 */
	private getSessionsDir(): string {
		return CODEX_SESSIONS_DIR;
	}

	/**
	 * Get the Codex sessions directory path (remote via SSH)
	 * On remote Linux hosts, ~ expands to the user's home directory
	 */
	private getRemoteSessionsDir(): string {
		return '~/.codex/sessions';
	}

	/**
	 * Find all session files, organized by date directories
	 */
	private async findAllSessionFiles(): Promise<Array<{ filePath: string; filename: string }>> {
		const sessionsDir = this.getSessionsDir();
		const sessionFiles: Array<{ filePath: string; filename: string }> = [];

		try {
			await fs.access(sessionsDir);
		} catch {
			return [];
		}

		// Scan YYYY directories
		const years = await fs.readdir(sessionsDir);
		for (const year of years) {
			if (!/^\d{4}$/.test(year)) continue;

			const yearDir = path.join(sessionsDir, year);
			try {
				const yearStat = await fs.stat(yearDir);
				if (!yearStat.isDirectory()) continue;
			} catch {
				continue;
			}

			// Scan MM directories
			const months = await fs.readdir(yearDir);
			for (const month of months) {
				if (!/^\d{2}$/.test(month)) continue;

				const monthDir = path.join(yearDir, month);
				try {
					const monthStat = await fs.stat(monthDir);
					if (!monthStat.isDirectory()) continue;
				} catch {
					continue;
				}

				// Scan DD directories
				const days = await fs.readdir(monthDir);
				for (const day of days) {
					if (!/^\d{2}$/.test(day)) continue;

					const dayDir = path.join(monthDir, day);
					try {
						const dayStat = await fs.stat(dayDir);
						if (!dayStat.isDirectory()) continue;

						// Find session files
						const files = await fs.readdir(dayDir);
						for (const file of files) {
							if (file.endsWith('.jsonl')) {
								sessionFiles.push({
									filePath: path.join(dayDir, file),
									filename: file,
								});
							}
						}
					} catch {
						continue;
					}
				}
			}
		}

		return sessionFiles;
	}

	/**
	 * Find all session files on a remote host via SSH, organized by date directories
	 * Recursively scans the YYYY/MM/DD directory structure
	 */
	private async findAllSessionFilesRemote(
		sshConfig: SshRemoteConfig
	): Promise<Array<{ filePath: string; filename: string }>> {
		const sessionsDir = this.getRemoteSessionsDir();
		const sessionFiles: Array<{ filePath: string; filename: string }> = [];

		// List YYYY directories
		const yearsResult = await readDirRemote(sessionsDir, sshConfig);
		if (!yearsResult.success || !yearsResult.data) {
			return [];
		}

		for (const yearEntry of yearsResult.data) {
			if (!yearEntry.isDirectory || !/^\d{4}$/.test(yearEntry.name)) continue;

			const yearDir = `${sessionsDir}/${yearEntry.name}`;

			// List MM directories
			const monthsResult = await readDirRemote(yearDir, sshConfig);
			if (!monthsResult.success || !monthsResult.data) continue;

			for (const monthEntry of monthsResult.data) {
				if (!monthEntry.isDirectory || !/^\d{2}$/.test(monthEntry.name)) continue;

				const monthDir = `${yearDir}/${monthEntry.name}`;

				// List DD directories
				const daysResult = await readDirRemote(monthDir, sshConfig);
				if (!daysResult.success || !daysResult.data) continue;

				for (const dayEntry of daysResult.data) {
					if (!dayEntry.isDirectory || !/^\d{2}$/.test(dayEntry.name)) continue;

					const dayDir = `${monthDir}/${dayEntry.name}`;

					// List session files
					const filesResult = await readDirRemote(dayDir, sshConfig);
					if (!filesResult.success || !filesResult.data) continue;

					for (const fileEntry of filesResult.data) {
						if (!fileEntry.isDirectory && fileEntry.name.endsWith('.jsonl')) {
							sessionFiles.push({
								filePath: `${dayDir}/${fileEntry.name}`,
								filename: fileEntry.name,
							});
						}
					}
				}
			}
		}

		return sessionFiles;
	}

	/**
	 * Parse a session file and extract metadata from remote via SSH
	 */
	private async parseSessionFileRemote(
		filePath: string,
		sessionId: string,
		stats: { size: number; mtimeMs: number },
		sshConfig: SshRemoteConfig
	): Promise<AgentSessionInfo | null> {
		try {
			const result = await readFileRemote(filePath, sshConfig);
			if (!result.success || !result.data) {
				logger.error(`Failed to read remote Codex session file: ${filePath} - ${result.error}`, LOG_CONTEXT);
				return null;
			}

			const content = result.data;
			const lines = content.split('\n').filter((l) => l.trim());

			if (lines.length === 0) {
				return null;
			}

			// Parse first line as metadata
			let metadata: CodexSessionMetadata | null = null;
			let timestamp = new Date(stats.mtimeMs).toISOString();
			let sessionProjectPath: string | null = null;

			try {
				const firstLine = JSON.parse(lines[0]);
				// New format: { type: 'session_meta', payload: { id, cwd, timestamp, ... } }
				if (firstLine.type === 'session_meta' && firstLine.payload) {
					metadata = firstLine as CodexSessionMetadata;
					timestamp = firstLine.payload.timestamp || firstLine.timestamp || timestamp;
					if (firstLine.payload.cwd) {
						sessionProjectPath = firstLine.payload.cwd;
					}
				}
				// Legacy format: { id, timestamp, ... } at top level
				else if (firstLine.id && firstLine.timestamp) {
					metadata = firstLine as CodexSessionMetadata;
					timestamp = firstLine.timestamp || timestamp;
				}
			} catch {
				// First line may not be metadata, continue parsing
			}

			// Count messages and find first assistant response (preferred) or user message (fallback)
			let firstAssistantMessage = '';
			let firstUserMessage = '';
			let userMessageCount = 0;
			let assistantMessageCount = 0;
			let totalInputTokens = 0;
			let totalOutputTokens = 0;
			let totalCachedTokens = 0;
			let firstTimestamp = timestamp;
			let lastTimestamp = timestamp;

			for (let i = 0; i < lines.length; i++) {
				try {
					const entry = JSON.parse(lines[i]);

					// Handle turn.completed for usage stats
					if (entry.type === 'turn.completed' && entry.usage) {
						totalInputTokens += entry.usage.input_tokens || 0;
						totalOutputTokens += entry.usage.output_tokens || 0;
						totalOutputTokens += entry.usage.reasoning_output_tokens || 0;
						totalCachedTokens += entry.usage.cached_input_tokens || 0;
					}

					// Handle Codex "event_msg" usage stats
					if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
						const usage = entry.payload.info?.total_token_usage;
						if (usage) {
							totalInputTokens += usage.input_tokens || 0;
							totalOutputTokens += usage.output_tokens || 0;
							totalOutputTokens += usage.reasoning_output_tokens || 0;
							totalCachedTokens += usage.cached_input_tokens || 0;
						}
					}

					// Handle message entries (legacy format)
					if (entry.type === 'message') {
						if (entry.role === 'user') {
							userMessageCount++;
							if (entry.content) {
								const text = extractTextFromContent(entry.content);
								if (!firstUserMessage && text.trim() && !isSystemContextMessage(text)) {
									firstUserMessage = text;
								}
								if (!sessionProjectPath) {
									const cwd = extractCwdFromText(text);
									if (cwd) {
										sessionProjectPath = cwd;
									}
								}
							}
						} else if (entry.role === 'assistant') {
							assistantMessageCount++;
							if (!firstAssistantMessage && entry.content) {
								const text = extractTextFromContent(entry.content);
								if (text.trim()) {
									firstAssistantMessage = text;
								}
							}
						}
					}

					// Handle response_item entries (current Codex format)
					if (entry.type === 'response_item' && entry.payload?.type === 'message') {
						if (entry.payload.role === 'user') {
							userMessageCount++;
							if (entry.payload.content) {
								const text = extractTextFromContent(entry.payload.content);
								if (!firstUserMessage && text.trim() && !isSystemContextMessage(text)) {
									firstUserMessage = text;
								}
								if (!sessionProjectPath) {
									const cwd = extractCwdFromText(text);
									if (cwd) {
										sessionProjectPath = cwd;
									}
								}
							}
						} else if (entry.payload.role === 'assistant') {
							assistantMessageCount++;
							if (!firstAssistantMessage && entry.payload.content) {
								const text = extractTextFromContent(entry.payload.content);
								if (text.trim()) {
									firstAssistantMessage = text;
								}
							}
						}
					}

					// Handle item.completed for agent messages
					if (entry.type === 'item.completed' && entry.item) {
						if (entry.item.type === 'agent_message') {
							assistantMessageCount++;
							if (!firstAssistantMessage && entry.item.text) {
								firstAssistantMessage = entry.item.text;
							}
						}
					}

					// Track timestamps for duration
					if (entry.timestamp) {
						const entryTime = new Date(entry.timestamp).getTime();
						const firstTime = new Date(firstTimestamp).getTime();
						const lastTime = new Date(lastTimestamp).getTime();

						if (entryTime < firstTime) {
							firstTimestamp = entry.timestamp;
						}
						if (entryTime > lastTime) {
							lastTimestamp = entry.timestamp;
						}
					}
				} catch {
					// Skip malformed lines
				}
			}

			// Use assistant response as preview if available, otherwise fall back to user message
			const previewMessage = firstAssistantMessage || firstUserMessage;

			const messageCount = userMessageCount + assistantMessageCount;

			const startTime = new Date(firstTimestamp).getTime();
			const endTime = new Date(lastTimestamp).getTime();
			const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

			// Extract session ID from metadata (new format uses payload.id, legacy uses id)
			const metadataSessionId = metadata?.payload?.id || metadata?.id || sessionId;

			return {
				sessionId: metadataSessionId,
				projectPath: sessionProjectPath ? normalizeProjectPath(sessionProjectPath) : '',
				timestamp: firstTimestamp,
				modifiedAt: new Date(stats.mtimeMs).toISOString(),
				firstMessage: previewMessage.slice(
					0,
					CODEX_SESSION_PARSE_LIMITS.FIRST_MESSAGE_PREVIEW_LENGTH
				),
				messageCount,
				sizeBytes: stats.size,
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
				cacheReadTokens: totalCachedTokens,
				cacheCreationTokens: 0,
				durationSeconds,
			};
		} catch (error) {
			logger.error(`Error reading remote Codex session file: ${filePath}`, LOG_CONTEXT, error);
			return null;
		}
	}

	async listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		// Use SSH remote access if config provided
		if (sshConfig) {
			return this.listSessionsRemote(projectPath, sshConfig);
		}
		const allSessionFiles = await this.findAllSessionFiles();

		const cache = (await loadCodexSessionCache()) || {
			version: CODEX_SESSION_CACHE_VERSION,
			lastProcessedAt: 0,
			sessions: {},
		};

		const sessions: AgentSessionInfo[] = [];
		const currentFilePaths = new Set<string>();
		let cacheUpdated = false;

		for (const { filePath, filename } of allSessionFiles) {
			currentFilePaths.add(filePath);
			let stats: { size: number; mtimeMs: number };

			try {
				const fileStat = await fs.stat(filePath);
				if (fileStat.size === 0) continue;
				stats = { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
			} catch (error) {
				logger.error(`Error stating Codex session file: ${filename}`, LOG_CONTEXT, error);
				continue;
			}

			const cached = cache.sessions[filePath];
			if (cached && cached.fileMtimeMs >= stats.mtimeMs) {
				if (
					cached.session.projectPath &&
					isSessionForProject(cached.session.projectPath, projectPath)
				) {
					sessions.push(cached.session);
				}
				continue;
			}

			const sessionId = extractSessionIdFromFilename(filename) || filename;
			const session = await parseSessionFile(filePath, sessionId, {
				size: stats.size,
				mtimeMs: stats.mtimeMs,
			});

			if (session) {
				cache.sessions[filePath] = { session, fileMtimeMs: stats.mtimeMs };
				cacheUpdated = true;
				if (session.projectPath && isSessionForProject(session.projectPath, projectPath)) {
					sessions.push(session);
				}
			}
		}

		for (const cachedPath of Object.keys(cache.sessions)) {
			if (!currentFilePaths.has(cachedPath)) {
				delete cache.sessions[cachedPath];
				cacheUpdated = true;
			}
		}

		if (cacheUpdated) {
			cache.lastProcessedAt = Date.now();
			await saveCodexSessionCache(cache);
		}

		// Sort by modified date (newest first)
		sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

		if (allSessionFiles.length === 0) {
			logger.info(`No Codex sessions found`, LOG_CONTEXT);
		} else {
			logger.info(
				`Found ${sessions.length} Codex sessions for project: ${projectPath}`,
				LOG_CONTEXT
			);
		}

		return sessions;
	}

	/**
	 * List sessions from remote host via SSH
	 */
	private async listSessionsRemote(
		projectPath: string,
		sshConfig: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		const allSessionFiles = await this.findAllSessionFilesRemote(sshConfig);

		if (allSessionFiles.length === 0) {
			logger.info(`No Codex sessions found on remote`, LOG_CONTEXT);
			return [];
		}

		const sessions: AgentSessionInfo[] = [];

		for (const { filePath, filename } of allSessionFiles) {
			// Get file stats via SSH
			const statResult = await statRemote(filePath, sshConfig);
			if (!statResult.success || !statResult.data) {
				logger.error(`Error stating remote Codex session file: ${filename}`, LOG_CONTEXT);
				continue;
			}

			const stats = { size: statResult.data.size, mtimeMs: statResult.data.mtime };
			if (stats.size === 0) continue;

			const sessionId = extractSessionIdFromFilename(filename) || filename;
			const session = await this.parseSessionFileRemote(filePath, sessionId, stats, sshConfig);

			if (session) {
				if (session.projectPath && isSessionForProject(session.projectPath, projectPath)) {
					sessions.push(session);
				}
			}
		}

		// Sort by modified date (newest first)
		sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

		logger.info(
			`Found ${sessions.length} Codex sessions for project: ${projectPath} (remote via SSH)`,
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
		_projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		// Get session file content either locally or via SSH
		let content: string;

		if (sshConfig) {
			// For SSH, find the session file remotely
			const sessionFilePath = await this.findSessionFileRemote(sessionId, sshConfig);
			if (!sessionFilePath) {
				logger.warn(`Codex session file not found on remote: ${sessionId}`, LOG_CONTEXT);
				return { messages: [], total: 0, hasMore: false };
			}
			const result = await readFileRemote(sessionFilePath, sshConfig);
			if (!result.success || !result.data) {
				logger.error(`Failed to read remote Codex session: ${sessionId} - ${result.error}`, LOG_CONTEXT);
				return { messages: [], total: 0, hasMore: false };
			}
			content = result.data;
		} else {
			// Find the session file by sessionId locally
			const sessionFilePath = await this.findSessionFile(sessionId);

			if (!sessionFilePath) {
				logger.warn(`Codex session file not found: ${sessionId}`, LOG_CONTEXT);
				return { messages: [], total: 0, hasMore: false };
			}

			content = await fs.readFile(sessionFilePath, 'utf-8');
		}

		try {
			const lines = content.split('\n').filter((l) => l.trim());

			const messages: SessionMessage[] = [];
			let messageIndex = 0;

			for (const line of lines) {
				try {
					const entry = JSON.parse(line);

					// Handle direct message entries
					if (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant')) {
						const textContent = extractTextFromContent(entry.content);

						if (textContent) {
							messages.push({
								type: entry.role,
								role: entry.role,
								content: textContent,
								timestamp: entry.timestamp || '',
								uuid: `codex-msg-${messageIndex}`,
							});
							messageIndex++;
						}
					}

					// Handle response_item messages (current Codex format)
					if (entry.type === 'response_item' && entry.payload?.type === 'message') {
						if (entry.payload.role === 'user' || entry.payload.role === 'assistant') {
							const textContent = extractTextFromContent(entry.payload.content);

							if (textContent) {
								messages.push({
									type: entry.payload.role,
									role: entry.payload.role,
									content: textContent,
									timestamp: entry.timestamp || '',
									uuid: entry.payload.id || `codex-msg-${messageIndex}`,
								});
								messageIndex++;
							}
						}
					}

					// Handle response_item function_call (current Codex format)
					if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
						let argsStr = '';
						try {
							const args = JSON.parse(entry.payload.arguments || '{}');
							argsStr = JSON.stringify(args, null, 2);
						} catch {
							argsStr = entry.payload.arguments || '';
						}
						const toolInfo = {
							tool: entry.payload.name,
							args: entry.payload.arguments,
						};
						messages.push({
							type: 'assistant',
							role: 'assistant',
							content: `Tool: ${entry.payload.name}\n${argsStr}`,
							timestamp: entry.timestamp || '',
							uuid: entry.payload.call_id || `codex-msg-${messageIndex}`,
							toolUse: [toolInfo],
						});
						messageIndex++;
					}

					// Handle response_item function_call_output (current Codex format)
					if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
						messages.push({
							type: 'assistant',
							role: 'assistant',
							content: entry.payload.output || '[Tool result]',
							timestamp: entry.timestamp || '',
							uuid: entry.payload.call_id || `codex-msg-${messageIndex}`,
						});
						messageIndex++;
					}

					// Handle item.completed agent_message events (legacy format)
					if (entry.type === 'item.completed' && entry.item?.type === 'agent_message') {
						messages.push({
							type: 'assistant',
							role: 'assistant',
							content: entry.item.text || '',
							timestamp: entry.timestamp || '',
							uuid: entry.item.id || `codex-msg-${messageIndex}`,
						});
						messageIndex++;
					}

					// Handle item.completed tool_call events (legacy format)
					if (entry.type === 'item.completed' && entry.item?.type === 'tool_call') {
						const toolInfo = {
							tool: entry.item.tool,
							args: entry.item.args,
						};
						messages.push({
							type: 'assistant',
							role: 'assistant',
							content: `Tool: ${entry.item.tool}`,
							timestamp: entry.timestamp || '',
							uuid: entry.item.id || `codex-msg-${messageIndex}`,
							toolUse: [toolInfo],
						});
						messageIndex++;
					}

					// Handle item.completed tool_result events (legacy format)
					if (entry.type === 'item.completed' && entry.item?.type === 'tool_result') {
						let resultContent = '';
						if (entry.item.output) {
							// Output may be a byte array that needs decoding
							if (Array.isArray(entry.item.output)) {
								resultContent = Buffer.from(entry.item.output).toString('utf-8');
							} else {
								resultContent = String(entry.item.output);
							}
						}

						messages.push({
							type: 'assistant',
							role: 'assistant',
							content: resultContent || '[Tool result]',
							timestamp: entry.timestamp || '',
							uuid: entry.item.id || `codex-msg-${messageIndex}`,
						});
						messageIndex++;
					}
				} catch {
					// Skip malformed lines
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
			logger.error(`Error reading Codex session: ${sessionId}`, LOG_CONTEXT, error);
			return { messages: [], total: 0, hasMore: false };
		}
	}

	async searchSessions(
		projectPath: string,
		query: string,
		searchMode: SessionSearchMode,
		sshConfig?: SshRemoteConfig
	): Promise<SessionSearchResult[]> {
		if (!query.trim()) {
			return [];
		}

		const sessions = await this.listSessions(projectPath, sshConfig);
		const searchLower = query.toLowerCase();
		const results: SessionSearchResult[] = [];

		for (const session of sessions) {
			let content: string;

			try {
				if (sshConfig) {
					const sessionFilePath = await this.findSessionFileRemote(session.sessionId, sshConfig);
					if (!sessionFilePath) continue;
					const result = await readFileRemote(sessionFilePath, sshConfig);
					if (!result.success || !result.data) continue;
					content = result.data;
				} else {
					const sessionFilePath = await this.findSessionFile(session.sessionId);
					if (!sessionFilePath) continue;
					content = await fs.readFile(sessionFilePath, 'utf-8');
				}
				const lines = content.split('\n').filter((l) => l.trim());

				let titleMatch = false;
				let userMatches = 0;
				let assistantMatches = 0;
				let matchPreview = '';

				for (const line of lines) {
					try {
						const entry = JSON.parse(line);

						let textContent = '';
						let role: 'user' | 'assistant' | null = null;

						// Handle message entries
						if (entry.type === 'message') {
							role = entry.role;
							textContent = extractTextFromContent(entry.content);
						}

						// Handle item.completed agent_message
						if (entry.type === 'item.completed' && entry.item?.type === 'agent_message') {
							role = 'assistant';
							textContent = entry.item.text || '';
						}

						const textLower = textContent.toLowerCase();

						if (role === 'user' && textLower.includes(searchLower)) {
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

						if (role === 'assistant' && textLower.includes(searchLower)) {
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
					} catch {
						// Skip malformed lines
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
			} catch {
				// Skip files that can't be read
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
		// Use findSessionFile for async access
		// Note: For SSH, would need to use findSessionFileRemote which is async
		return null;
	}

	/**
	 * Find the file path for a session by ID (async)
	 */
	private async findSessionFile(sessionId: string): Promise<string | null> {
		const allFiles = await this.findAllSessionFiles();

		for (const { filePath, filename } of allFiles) {
			const fileSessionId = extractSessionIdFromFilename(filename);
			if (fileSessionId === sessionId) {
				return filePath;
			}

			// Also check by reading first line for session ID
			try {
				const content = await fs.readFile(filePath, 'utf-8');
				const firstLine = content.split('\n')[0];
				if (firstLine) {
					const metadata = JSON.parse(firstLine) as CodexSessionMetadata;
					if (metadata.id === sessionId) {
						return filePath;
					}
				}
			} catch {
				// Skip files that can't be read
			}
		}

		return null;
	}

	/**
	 * Find the file path for a session by ID on a remote host via SSH
	 */
	private async findSessionFileRemote(
		sessionId: string,
		sshConfig: SshRemoteConfig
	): Promise<string | null> {
		const allFiles = await this.findAllSessionFilesRemote(sshConfig);

		for (const { filePath, filename } of allFiles) {
			const fileSessionId = extractSessionIdFromFilename(filename);
			if (fileSessionId === sessionId) {
				return filePath;
			}

			// Also check by reading first line for session ID
			try {
				const result = await readFileRemote(filePath, sshConfig);
				if (result.success && result.data) {
					const firstLine = result.data.split('\n')[0];
					if (firstLine) {
						const metadata = JSON.parse(firstLine) as CodexSessionMetadata;
						if (metadata.id === sessionId) {
							return filePath;
						}
					}
				}
			} catch {
				// Skip files that can't be read
			}
		}

		return null;
	}

	async deleteMessagePair(
		_projectPath: string,
		sessionId: string,
		userMessageUuid: string,
		fallbackContent?: string,
		sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		// Delete operations on remote sessions are not supported
		if (sshConfig) {
			logger.warn('Delete message pair not supported for SSH remote sessions', LOG_CONTEXT);
			return { success: false, error: 'Delete not supported for remote sessions' };
		}
		const sessionFilePath = await this.findSessionFile(sessionId);

		if (!sessionFilePath) {
			logger.warn('Codex session file not found for deletion', LOG_CONTEXT, { sessionId });
			return { success: false, error: 'Session file not found' };
		}

		try {
			const content = await fs.readFile(sessionFilePath, 'utf-8');
			const lines = content.split('\n').filter((l) => l.trim());

			interface ParsedLine {
				line: string;
				entry: {
					type?: string;
					role?: string;
					content?: CodexMessageContent[];
					item?: {
						id?: string;
						type?: string;
						tool?: string;
						tool_call_id?: string;
					};
				} | null;
				remove?: boolean;
			}

			const parsedLines: ParsedLine[] = [];
			let userMessageIndex = -1;

			// Parse all lines and find the target user message
			for (let i = 0; i < lines.length; i++) {
				try {
					const entry = JSON.parse(lines[i]);
					parsedLines.push({ line: lines[i], entry });

					// Match by UUID (format: codex-msg-N)
					if (entry.type === 'message' && entry.role === 'user') {
						const msgIndex = parsedLines.length - 1;
						if (userMessageUuid === `codex-msg-${msgIndex}`) {
							userMessageIndex = msgIndex;
						}
					}
				} catch {
					parsedLines.push({ line: lines[i], entry: null });
				}
			}

			// Fallback: try content match if UUID didn't work
			if (userMessageIndex === -1 && fallbackContent) {
				const normalizedFallback = fallbackContent.trim().toLowerCase();

				for (let i = parsedLines.length - 1; i >= 0; i--) {
					const entry = parsedLines[i].entry;
					if (entry?.type === 'message' && entry?.role === 'user' && entry.content) {
						const textContent = extractTextFromContent(entry.content);
						if (textContent.trim().toLowerCase() === normalizedFallback) {
							userMessageIndex = i;
							logger.info('Found Codex message by content match', LOG_CONTEXT, {
								sessionId,
								index: i,
							});
							break;
						}
					}
				}
			}

			if (userMessageIndex === -1) {
				logger.warn('User message not found for deletion in Codex session', LOG_CONTEXT, {
					sessionId,
					userMessageUuid,
					hasFallback: !!fallbackContent,
				});
				return { success: false, error: 'User message not found' };
			}

			// Find the end of the response (next user message) and collect tool_call IDs being deleted
			let endIndex = parsedLines.length;
			const deletedToolCallIds = new Set<string>();

			for (let i = userMessageIndex + 1; i < parsedLines.length; i++) {
				const entry = parsedLines[i].entry;

				// Stop at the next user message
				if (entry?.type === 'message' && entry?.role === 'user') {
					endIndex = i;
					break;
				}

				// Collect tool_call IDs from item.completed events being deleted
				if (
					entry?.type === 'item.completed' &&
					entry?.item?.type === 'tool_call' &&
					entry?.item?.id
				) {
					deletedToolCallIds.add(entry.item.id);
				}
			}

			// Remove the message pair
			let linesToKeep = [...parsedLines.slice(0, userMessageIndex), ...parsedLines.slice(endIndex)];

			// If we deleted any tool_call blocks, clean up orphaned tool_result blocks
			if (deletedToolCallIds.size > 0) {
				linesToKeep = linesToKeep.filter((item) => {
					const entry = item.entry;

					// Remove tool_result events that reference deleted tool_call IDs
					if (entry?.type === 'item.completed' && entry?.item?.type === 'tool_result') {
						// tool_result items reference tool_call via tool_call_id or the item.id pattern
						const toolCallId = entry.item.tool_call_id || entry.item.id;
						if (toolCallId && deletedToolCallIds.has(toolCallId)) {
							return false;
						}
					}

					return true;
				});

				logger.info('Cleaned up orphaned tool_result blocks in Codex session', LOG_CONTEXT, {
					sessionId,
					deletedToolCallIds: Array.from(deletedToolCallIds),
				});
			}

			const newContent = linesToKeep.map((p) => p.line).join('\n') + '\n';
			await fs.writeFile(sessionFilePath, newContent, 'utf-8');

			const linesRemoved = parsedLines.length - linesToKeep.length;
			logger.info('Deleted message pair from Codex session', LOG_CONTEXT, {
				sessionId,
				userMessageUuid,
				linesRemoved,
			});

			return { success: true, linesRemoved };
		} catch (error) {
			logger.error('Error deleting message pair from Codex session', LOG_CONTEXT, {
				sessionId,
				error,
			});
			return { success: false, error: String(error) };
		}
	}
}
