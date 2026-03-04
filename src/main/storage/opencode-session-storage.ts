/**
 * OpenCode Session Storage Implementation
 *
 * This module implements the AgentSessionStorage interface for OpenCode.
 *
 * OpenCode v1.2+ stores sessions in SQLite at ~/.local/share/opencode/opencode.db
 * Older versions used JSON files at ~/.local/share/opencode/storage/
 *
 * This implementation reads from SQLite first, falls back to JSON for pre-v1.2
 * installs, and deduplicates sessions when both sources exist (migration period).
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
import fsSync from 'fs';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
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
} from '../agents';
import type { ToolType, SshRemoteConfig } from '../../shared/types';

const LOG_CONTEXT = '[OpenCodeSessionStorage]';

/**
 * Get OpenCode data base directory (platform-specific)
 * - Linux/macOS: ~/.local/share/opencode
 * - Windows: %APPDATA%\opencode
 */
function getOpenCodeDataDir(): string {
	if (process.platform === 'win32') {
		const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
		return path.join(appData, 'opencode');
	}
	return path.join(os.homedir(), '.local', 'share', 'opencode');
}

/**
 * Get OpenCode JSON storage directory (pre-v1.2)
 */
function getOpenCodeStorageDir(): string {
	return path.join(getOpenCodeDataDir(), 'storage');
}

/**
 * Get OpenCode SQLite database path (v1.2+)
 */
function getOpenCodeDbPath(): string {
	return path.join(getOpenCodeDataDir(), 'opencode.db');
}

const OPENCODE_STORAGE_DIR = getOpenCodeStorageDir();
const OPENCODE_DB_PATH = getOpenCodeDbPath();

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

// ─── SQLite row types (v1.2+) ────────────────────────────────────────────────

/**
 * Raw row from the SQLite `session` table
 */
interface SqliteSessionRow {
	id: string;
	project_id: string;
	directory: string;
	title: string;
	version: string;
	time_created: number; // Unix ms
	time_updated: number; // Unix ms
	summary_additions: number | null;
	summary_deletions: number | null;
	summary_files: number | null;
}

/**
 * Raw row from the SQLite `message` table
 * The `data` column is a JSON blob containing role, model, tokens, cost, etc.
 */
interface SqliteMessageRow {
	id: string;
	session_id: string;
	time_created: number;
	time_updated: number;
	data: string; // JSON blob
}

/**
 * Parsed message data from the SQLite `data` JSON blob
 */
interface SqliteMessageData {
	role?: 'user' | 'assistant';
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
}

/**
 * Parsed part data from the SQLite `data` JSON blob
 */
interface SqlitePartData {
	type?: 'text' | 'reasoning' | 'tool' | 'step-start' | 'step-finish';
	text?: string;
	tool?: string;
	state?: {
		status?: string;
		input?: unknown;
		output?: unknown;
	};
}

// ─── SQLite helpers ──────────────────────────────────────────────────────────

/**
 * Open the OpenCode SQLite database in read-only mode.
 * Returns null if the database file doesn't exist.
 */
function openOpenCodeDb(dbPath: string = OPENCODE_DB_PATH): Database.Database | null {
	try {
		if (!fsSync.existsSync(dbPath)) {
			return null;
		}
		const db = new Database(dbPath, { readonly: true, fileMustExist: true });
		db.pragma('journal_mode = WAL');
		return db;
	} catch (error) {
		logger.warn(`Failed to open OpenCode SQLite database: ${error}`, LOG_CONTEXT);
		return null;
	}
}

/**
 * Safely parse a JSON string, returning null on failure
 */
function safeJsonParse<T>(json: string): T | null {
	try {
		return JSON.parse(json) as T;
	} catch {
		return null;
	}
}

/**
 * Check if a table exists in a SQLite database
 */
function tableExists(db: Database.Database, tableName: string): boolean {
	const row = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
		.get(tableName) as { name: string } | undefined;
	return !!row;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

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
 * Read a JSON file from a remote host via SSH
 */
async function readJsonFileRemote<T>(
	filePath: string,
	sshConfig: SshRemoteConfig
): Promise<T | null> {
	try {
		const result = await readFileRemote(filePath, sshConfig);
		if (!result.success || !result.data) {
			return null;
		}
		return JSON.parse(result.data) as T;
	} catch {
		return null;
	}
}

/**
 * List all JSON files in a remote directory via SSH
 */
async function listJsonFilesRemote(dirPath: string, sshConfig: SshRemoteConfig): Promise<string[]> {
	try {
		const result = await readDirRemote(dirPath, sshConfig);
		if (!result.success || !result.data) {
			return [];
		}
		return result.data
			.filter((entry) => !entry.isDirectory && entry.name.endsWith('.json'))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/**
 * OpenCode Session Storage Implementation
 *
 * Reads from SQLite (v1.2+) with JSON file fallback (pre-v1.2).
 * During migration periods, both sources are merged with dedup by session ID.
 */
export class OpenCodeSessionStorage implements AgentSessionStorage {
	readonly agentId: ToolType = 'opencode';

	/**
	 * Get the session directory for a project (local)
	 */
	private getSessionDir(projectId: string): string {
		return path.join(OPENCODE_STORAGE_DIR, 'session', projectId);
	}

	/**
	 * Get the message directory for a session (local)
	 */
	private getMessageDir(sessionId: string): string {
		return path.join(OPENCODE_STORAGE_DIR, 'message', sessionId);
	}

	/**
	 * Get the part directory for a message (local)
	 */
	private getPartDir(messageId: string): string {
		return path.join(OPENCODE_STORAGE_DIR, 'part', messageId);
	}

	/**
	 * Get the OpenCode storage base directory (remote)
	 * On remote Linux hosts, ~ expands to the user's home directory
	 */
	private getRemoteStorageDir(): string {
		return '~/.local/share/opencode/storage';
	}

	/**
	 * Get the session directory for a project (remote)
	 */
	private getRemoteSessionDir(projectId: string): string {
		return `${this.getRemoteStorageDir()}/session/${projectId}`;
	}

	/**
	 * Get the message directory for a session (remote)
	 */
	private getRemoteMessageDir(sessionId: string): string {
		return `${this.getRemoteStorageDir()}/message/${sessionId}`;
	}

	/**
	 * Get the part directory for a message (remote)
	 */
	private getRemotePartDir(messageId: string): string {
		return `${this.getRemoteStorageDir()}/part/${messageId}`;
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
	 * Find the project ID for a given path by checking existing projects (remote via SSH)
	 */
	private async findProjectIdRemote(
		projectPath: string,
		sshConfig: SshRemoteConfig
	): Promise<string | null> {
		const projectDir = `${this.getRemoteStorageDir()}/project`;

		const projectFiles = await listJsonFilesRemote(projectDir, sshConfig);
		if (projectFiles.length === 0) {
			logger.info(`OpenCode project directory not found on remote: ${projectDir}`, LOG_CONTEXT);
			return null;
		}

		// Normalize project path for comparison (remove trailing slashes)
		// Note: On remote, we don't resolve paths since the remote may have different filesystem
		const normalizedPath = projectPath.replace(/\/+$/, '');
		logger.info(`Looking for OpenCode project for path on remote: ${normalizedPath}`, LOG_CONTEXT);

		for (const file of projectFiles) {
			// Skip global.json - we'll use it as fallback
			if (file === 'global.json') continue;

			const projectData = await readJsonFileRemote<OpenCodeProject>(
				`${projectDir}/${file}`,
				sshConfig
			);
			if (!projectData?.worktree) continue;

			// Normalize stored path (remove trailing slashes)
			const storedPath = projectData.worktree.replace(/\/+$/, '');

			// Exact match
			if (storedPath === normalizedPath) {
				logger.info(
					`Found OpenCode project on remote: ${projectData.id} for path: ${normalizedPath}`,
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
					`Found OpenCode project (subdirectory match) on remote: ${projectData.id} for path: ${normalizedPath}`,
					LOG_CONTEXT
				);
				return projectData.id;
			}
		}

		// Also check using hash-based ID (OpenCode may use SHA1 of path)
		const hashedId = hashProjectPath(projectPath);
		const hashedFile = `${projectDir}/${hashedId}.json`;
		const hashedResult = await statRemote(hashedFile, sshConfig);
		if (hashedResult.success) {
			logger.info(`Found OpenCode project by hash on remote: ${hashedId}`, LOG_CONTEXT);
			return hashedId;
		}

		// Fall back to 'global' project
		logger.info(
			`No dedicated OpenCode project found for path on remote: ${normalizedPath}, will check global project`,
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
	 * Check if a session's directory matches the requested project path (remote version)
	 * Used for filtering global project sessions by their working directory
	 * Note: On remote, we don't use path.resolve since we're operating on remote paths
	 */
	private sessionMatchesPathRemote(
		sessionDirectory: string | undefined,
		projectPath: string
	): boolean {
		if (!sessionDirectory) return false;

		const normalizedSessionDir = sessionDirectory.replace(/\/+$/, '');
		const normalizedProjectPath = projectPath.replace(/\/+$/, '');

		// Exact match
		if (normalizedSessionDir === normalizedProjectPath) return true;

		// Session is in a subdirectory of the project
		if (normalizedSessionDir.startsWith(normalizedProjectPath + '/')) return true;

		return false;
	}

	// ─── SQLite-based methods (OpenCode v1.2+) ──────────────────────────────

	/**
	 * List sessions from SQLite database for a given project path.
	 * Returns null if the database doesn't exist or lacks the expected schema.
	 */
	private listSessionsSqlite(projectPath: string): AgentSessionInfo[] | null {
		const db = openOpenCodeDb();
		if (!db) return null;

		try {
			if (!tableExists(db, 'session') || !tableExists(db, 'project')) {
				return null;
			}

			const normalizedPath = path.resolve(projectPath).replace(/\/+$/, '');

			// Find matching project(s) — exact match or subdirectory match
			const projects = db
				.prepare('SELECT id, worktree FROM project')
				.all() as Array<{ id: string; worktree: string }>;

			const matchingProjectIds: string[] = [];
			for (const proj of projects) {
				const storedPath = path.resolve(proj.worktree).replace(/\/+$/, '');
				if (
					storedPath === normalizedPath ||
					normalizedPath.startsWith(storedPath + '/') ||
					storedPath.startsWith(normalizedPath + '/')
				) {
					matchingProjectIds.push(proj.id);
				}
			}

			if (matchingProjectIds.length === 0) {
				// Fall back to sessions with matching directory field
				const directorySessions = db
					.prepare(
						'SELECT id, project_id, directory, title, version, time_created, time_updated, summary_additions, summary_deletions, summary_files FROM session WHERE directory = ? OR directory LIKE ? ORDER BY time_updated DESC'
					)
					.all(normalizedPath, normalizedPath + '/%') as SqliteSessionRow[];

				if (directorySessions.length === 0) {
					logger.info(
						`No OpenCode project or sessions found in SQLite for: ${normalizedPath}`,
						LOG_CONTEXT
					);
					return [];
				}

				return this.convertSqliteSessionRows(directorySessions, projectPath, db);
			}

			// Query sessions for all matching projects
			const placeholders = matchingProjectIds.map(() => '?').join(',');
			const sessions = db
				.prepare(
					`SELECT id, project_id, directory, title, version, time_created, time_updated, summary_additions, summary_deletions, summary_files FROM session WHERE project_id IN (${placeholders}) ORDER BY time_updated DESC`
				)
				.all(...matchingProjectIds) as SqliteSessionRow[];

			logger.info(
				`Found ${sessions.length} OpenCode sessions in SQLite for: ${normalizedPath}`,
				LOG_CONTEXT
			);

			return this.convertSqliteSessionRows(sessions, projectPath, db);
		} catch (error) {
			logger.warn(`Error reading OpenCode SQLite database: ${error}`, LOG_CONTEXT);
			return null;
		} finally {
			db.close();
		}
	}

	/**
	 * Convert SQLite session rows to AgentSessionInfo array, loading message stats
	 */
	private convertSqliteSessionRows(
		rows: SqliteSessionRow[],
		projectPath: string,
		db: Database.Database
	): AgentSessionInfo[] {
		const hasMessageTable = tableExists(db, 'message');
		const hasPartTable = tableExists(db, 'part');
		const sessions: AgentSessionInfo[] = [];

		for (const row of rows) {
			let messageCount = 0;
			let totalInputTokens = 0;
			let totalOutputTokens = 0;
			let totalCacheReadTokens = 0;
			let totalCacheWriteTokens = 0;
			let totalCost = 0;
			let firstMessage = row.title || '';
			let durationSeconds = 0;

			if (hasMessageTable) {
				const messages = db
					.prepare(
						'SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC'
					)
					.all(row.id) as Array<{ id: string; data: string; time_created: number }>;

				messageCount = messages.length;

				if (messages.length >= 2) {
					const first = messages[0].time_created;
					const last = messages[messages.length - 1].time_created;
					if (first && last) {
						durationSeconds = Math.max(0, Math.floor((last - first) / 1000));
					}
				}

				// Aggregate stats and find preview message
				let foundPreview = false;
				for (const msg of messages) {
					const data = safeJsonParse<SqliteMessageData>(msg.data);
					if (!data) continue;

					if (data.tokens) {
						totalInputTokens += data.tokens.input || 0;
						totalOutputTokens += data.tokens.output || 0;
						totalCacheReadTokens += data.tokens.cache?.read || 0;
						totalCacheWriteTokens += data.tokens.cache?.write || 0;
					}
					if (data.cost) {
						totalCost += data.cost;
					}

					// Get preview from first assistant message with text
					if (!foundPreview && data.role === 'assistant' && hasPartTable) {
						const parts = db
							.prepare(
								'SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC'
							)
							.all(msg.id) as Array<{ data: string }>;
						for (const part of parts) {
							const partData = safeJsonParse<SqlitePartData>(part.data);
							if (partData?.type === 'text' && partData.text?.trim()) {
								firstMessage = partData.text;
								foundPreview = true;
								break;
							}
						}
					}

					// Fall back to first user message if no assistant text found
					if (!foundPreview && data.role === 'user' && hasPartTable) {
						const parts = db
							.prepare(
								'SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC'
							)
							.all(msg.id) as Array<{ data: string }>;
						for (const part of parts) {
							const partData = safeJsonParse<SqlitePartData>(part.data);
							if (partData?.type === 'text' && partData.text?.trim()) {
								firstMessage = partData.text;
								break;
							}
						}
					}
				}
			}

			const createdAt = row.time_created
				? new Date(row.time_created).toISOString()
				: new Date().toISOString();
			const updatedAt = row.time_updated
				? new Date(row.time_updated).toISOString()
				: createdAt;

			sessions.push({
				sessionId: row.id,
				projectPath,
				timestamp: createdAt,
				modifiedAt: updatedAt,
				firstMessage: firstMessage.slice(0, 200),
				messageCount,
				sizeBytes: 0,
				costUsd: totalCost,
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
				cacheReadTokens: totalCacheReadTokens,
				cacheCreationTokens: totalCacheWriteTokens,
				durationSeconds,
			});
		}

		return sessions;
	}

	/**
	 * Load messages for a session from SQLite.
	 * Returns null if the database doesn't exist or lacks the expected schema.
	 */
	private loadSessionMessagesSqlite(sessionId: string): {
		messages: OpenCodeMessage[];
		parts: Map<string, OpenCodePart[]>;
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCacheReadTokens: number;
		totalCacheWriteTokens: number;
		totalCost: number;
	} | null {
		const db = openOpenCodeDb();
		if (!db) return null;

		try {
			if (!tableExists(db, 'message')) return null;

			const messageRows = db
				.prepare(
					'SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created ASC'
				)
				.all(sessionId) as SqliteMessageRow[];

			if (messageRows.length === 0) return null;

			const hasPartTable = tableExists(db, 'part');
			const messages: OpenCodeMessage[] = [];
			const parts = new Map<string, OpenCodePart[]>();
			let totalInputTokens = 0;
			let totalOutputTokens = 0;
			let totalCacheReadTokens = 0;
			let totalCacheWriteTokens = 0;
			let totalCost = 0;

			for (const row of messageRows) {
				const data = safeJsonParse<SqliteMessageData>(row.data);
				if (!data) continue;

				const msg: OpenCodeMessage = {
					id: row.id,
					sessionID: sessionId,
					role: data.role || 'user',
					time: { created: row.time_created },
					model: data.model,
					agent: data.agent,
					tokens: data.tokens,
					cost: data.cost,
				};
				messages.push(msg);

				if (data.tokens) {
					totalInputTokens += data.tokens.input || 0;
					totalOutputTokens += data.tokens.output || 0;
					totalCacheReadTokens += data.tokens.cache?.read || 0;
					totalCacheWriteTokens += data.tokens.cache?.write || 0;
				}
				if (data.cost) {
					totalCost += data.cost;
				}

				// Load parts from SQLite
				if (hasPartTable) {
					const partRows = db
						.prepare(
							'SELECT id, data FROM part WHERE message_id = ? ORDER BY time_created ASC'
						)
						.all(row.id) as Array<{ id: string; data: string }>;

					const messageParts: OpenCodePart[] = [];
					for (const partRow of partRows) {
						const partData = safeJsonParse<SqlitePartData>(partRow.data);
						if (partData) {
							messageParts.push({
								id: partRow.id,
								messageID: row.id,
								type: partData.type || 'text',
								text: partData.text,
								tool: partData.tool,
								state: partData.state,
							});
						}
					}
					parts.set(row.id, messageParts);
				}
			}

			return {
				messages,
				parts,
				totalInputTokens,
				totalOutputTokens,
				totalCacheReadTokens,
				totalCacheWriteTokens,
				totalCost,
			};
		} catch (error) {
			logger.warn(`Error loading messages from OpenCode SQLite: ${error}`, LOG_CONTEXT);
			return null;
		} finally {
			db.close();
		}
	}

	// ─── JSON-based methods (pre-v1.2 fallback) ─────────────────────────────

	/**
	 * Load all messages for a session (JSON files)
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
	 * Load all messages for a session (remote via SSH)
	 */
	private async loadSessionMessagesRemote(
		sessionId: string,
		sshConfig: SshRemoteConfig
	): Promise<{
		messages: OpenCodeMessage[];
		parts: Map<string, OpenCodePart[]>;
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCacheReadTokens: number;
		totalCacheWriteTokens: number;
		totalCost: number;
	}> {
		const messageDir = this.getRemoteMessageDir(sessionId);
		const messages: OpenCodeMessage[] = [];
		const parts = new Map<string, OpenCodePart[]>();
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCacheReadTokens = 0;
		let totalCacheWriteTokens = 0;
		let totalCost = 0;

		try {
			const messageFiles = await listJsonFilesRemote(messageDir, sshConfig);

			for (const file of messageFiles) {
				const msg = await readJsonFileRemote<OpenCodeMessage>(`${messageDir}/${file}`, sshConfig);
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
					const partDir = this.getRemotePartDir(msg.id);
					const partFiles = await listJsonFilesRemote(partDir, sshConfig);
					const messageParts: OpenCodePart[] = [];

					for (const partFile of partFiles) {
						const part = await readJsonFileRemote<OpenCodePart>(
							`${partDir}/${partFile}`,
							sshConfig
						);
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

	async listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		// Use SSH remote access if config provided (JSON only for SSH — no remote SQLite)
		if (sshConfig) {
			return this.listSessionsRemote(projectPath, sshConfig);
		}

		// Try SQLite first (v1.2+), then fall back to JSON, merge and dedup
		const sqliteSessions = this.listSessionsSqlite(projectPath);
		const jsonSessions = await this.listSessionsJson(projectPath);

		if (sqliteSessions && sqliteSessions.length > 0) {
			if (jsonSessions.length > 0) {
				// Merge: SQLite is authoritative, add JSON-only sessions
				const sqliteIds = new Set(sqliteSessions.map((s) => s.sessionId));
				const merged = [...sqliteSessions];
				for (const jsonSession of jsonSessions) {
					if (!sqliteIds.has(jsonSession.sessionId)) {
						merged.push(jsonSession);
					}
				}
				merged.sort(
					(a, b) =>
						new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
				);
				logger.info(
					`Merged ${sqliteSessions.length} SQLite + ${merged.length - sqliteSessions.length} JSON-only sessions for: ${projectPath}`,
					LOG_CONTEXT
				);
				return merged;
			}
			return sqliteSessions;
		}

		// SQLite unavailable or empty — use JSON results
		return jsonSessions;
	}

	/**
	 * List sessions from JSON files (pre-v1.2 format)
	 */
	private async listSessionsJson(projectPath: string): Promise<AgentSessionInfo[]> {
		const projectId = await this.findProjectId(projectPath);

		if (!projectId) {
			return [];
		}

		// When using the 'global' project, we need to filter sessions by their directory field
		const isGlobalProject = projectId === 'global';

		const sessionDir = this.getSessionDir(projectId);

		try {
			await fs.access(sessionDir);
		} catch {
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

		if (sessions.length > 0) {
			logger.info(
				`Found ${sessions.length} OpenCode sessions (JSON) for: ${projectPath}`,
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
		const projectId = await this.findProjectIdRemote(projectPath, sshConfig);

		if (!projectId) {
			logger.info(`No OpenCode project found for path on remote: ${projectPath}`, LOG_CONTEXT);
			return [];
		}

		// When using the 'global' project, we need to filter sessions by their directory field
		const isGlobalProject = projectId === 'global';

		const sessionDir = this.getRemoteSessionDir(projectId);

		const sessionFiles = await listJsonFilesRemote(sessionDir, sshConfig);
		if (sessionFiles.length === 0) {
			logger.info(
				`No OpenCode sessions directory for project on remote: ${projectPath}`,
				LOG_CONTEXT
			);
			return [];
		}

		const sessions: AgentSessionInfo[] = [];

		for (const file of sessionFiles) {
			const sessionData = await readJsonFileRemote<OpenCodeSession>(
				`${sessionDir}/${file}`,
				sshConfig
			);

			if (!sessionData) continue;

			// For global project, filter by the session's directory field
			if (isGlobalProject && !this.sessionMatchesPathRemote(sessionData.directory, projectPath)) {
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
			} = await this.loadSessionMessagesRemote(sessionData.id, sshConfig);

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

			// Get file stats for size via SSH
			let sizeBytes = 0;
			const statResult = await statRemote(`${sessionDir}/${file}`, sshConfig);
			if (statResult.success && statResult.data) {
				sizeBytes = statResult.data.size;
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
			`Found ${sessions.length} OpenCode sessions for project: ${projectPath} (remote via SSH)`,
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
		// Try SQLite first for local sessions, fall back to JSON
		let loaded: {
			messages: OpenCodeMessage[];
			parts: Map<string, OpenCodePart[]>;
		} | null = null;

		if (sshConfig) {
			loaded = await this.loadSessionMessagesRemote(sessionId, sshConfig);
		} else {
			loaded = this.loadSessionMessagesSqlite(sessionId);
			if (!loaded) {
				loaded = await this.loadSessionMessages(sessionId);
			}
		}

		const { messages, parts } = loaded;

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
			let loaded: {
				messages: OpenCodeMessage[];
				parts: Map<string, OpenCodePart[]>;
			} | null = null;

			if (sshConfig) {
				loaded = await this.loadSessionMessagesRemote(session.sessionId, sshConfig);
			} else {
				loaded = this.loadSessionMessagesSqlite(session.sessionId);
				if (!loaded) {
					loaded = await this.loadSessionMessages(session.sessionId);
				}
			}

			const { messages, parts } = loaded;

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

	getSessionPath(
		_projectPath: string,
		sessionId: string,
		sshConfig?: SshRemoteConfig
	): string | null {
		if (sshConfig) {
			return this.getRemoteMessageDir(sessionId);
		}
		// For SQLite-backed sessions, return the database path
		if (fsSync.existsSync(OPENCODE_DB_PATH)) {
			return OPENCODE_DB_PATH;
		}
		// Fallback to JSON message directory
		return this.getMessageDir(sessionId);
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

		try {
			// Check if this session exists in SQLite — deletion not supported for SQLite sessions
			// (we open the DB read-only and shouldn't modify OpenCode's database)
			const sqliteResult = this.loadSessionMessagesSqlite(sessionId);
			if (sqliteResult && sqliteResult.messages.length > 0) {
				logger.warn(
					'Delete message pair not supported for SQLite-backed OpenCode sessions',
					LOG_CONTEXT
				);
				return {
					success: false,
					error: 'Delete not supported for OpenCode v1.2+ SQLite sessions',
				};
			}

			// Load all messages for the session (JSON files)
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
			captureException(error, { operation: 'opencodeStorage:deleteMessagePair', sessionId });
			return { success: false, error: String(error) };
		}
	}
}
