import { parseNativeLines } from '../../shared/maestro-lib/translation/native-records';
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

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import type Store from 'electron-store';
import type { ClaudeSessionOriginsData } from '../stores/types';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { isExpectedSessionReadError } from '../utils/session-read-errors';
import { getAppUserDataDir } from '../utils/app-user-data';
import { readFileRemote, readDirRemote, statRemote } from '../utils/remote-fs';
import type {
	AgentSessionInfo,
	SessionMessagesResult,
	SessionReadOptions,
	SessionMessage,
} from '../agents';
import type { DeleteMessagePairResult } from '../agents';
import { MESSAGE_NOT_IN_TRANSCRIPT } from '../agents/session-storage';
import type { SessionListObserver, SkippedSessionFile } from '../agents/session-storage';
import type { ToolType, SshRemoteConfig } from '../../shared/types';
import { BaseSessionStorage, MessagePageCollector } from './base-session-storage';
import type { SearchableMessage } from './base-session-storage';
import { forEachJsonlLine, readFirstJsonlLine } from '../utils/jsonl-stream';
import { CodexTokenCounts } from '../../shared/codexTokenUsage';
import { runTranscriptParse } from '../transcript-parse/transcript-parse-pool';
import {
	CODEX_FIRST_MESSAGE_PREVIEW_LENGTH,
	extractCwdFromText,
	extractTextFromContent,
	isSystemContextMessage,
	normalizeProjectPath,
	type CodexMessageContent,
	type CodexSessionMetadata,
} from '../transcript-parse/codex-session-info';

const LOG_CONTEXT = '[CodexSessionStorage]';
const MAX_SESSION_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

/**
 * Get Codex sessions base directory (platform-specific)
 * - Linux/macOS: ~/.codex/sessions
 * - Windows: %USERPROFILE%\.codex\sessions (Codex uses dotfile convention on all platforms)
 *
 * `accountDir` is the `CODEX_HOME` an agent was pointed at, not the `sessions`
 * subdir. It is a parameter rather than a module const because Maestro sets
 * `CODEX_HOME` per agent in `customEnvVars`, never in its own environment: the
 * value this process would read is never the value an agent's process received.
 */
function getCodexSessionsDir(accountDir?: string): string {
	// Codex CLI uses ~/.codex on all platforms (including Windows)
	return path.join(accountDir || path.join(os.homedir(), '.codex'), 'sessions');
}

// Bumped to 4: Codex's `total_token_usage` is a running session total and was
// being summed per event, so cached entries hold inflated token counts. Entries
// are reused whenever `fileMtimeMs` still covers the file, which a parsing fix
// does not change, so the old numbers would be served until a session is touched.
//
// Bumped to 5: pruning is now scoped to the account dir that was walked, so
// entries left behind by an account dir that no longer exists are unreachable.
// One clean slate here retires the ones that predate the scoped prune.
//
// Bumped to 6: sessions carry per-call token speed buckets (`speed`), which
// cached entries lack and the fingerprint cannot ask for.
const CODEX_SESSION_CACHE_VERSION = 6;
const CODEX_SESSION_CACHE_FILENAME = 'codex-sessions-cache.json';

/**
 * Tool use entry shape used when building SessionMessage.toolUse arrays.
 * Provides type safety for the tool call / tool output merge logic.
 */
interface CodexToolUseEntry {
	tool?: string;
	name?: string;
	args?: unknown;
	state: {
		status: string;
		input?: unknown;
		output?: string;
	};
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

/**
 * How far into a rollout its `session_meta` line is looked for. The line carries the working
 * directory and the instructions, so it is long, but a header past this is not read at all.
 */
const ROLLOUT_HEADER_MAX_BYTES = 1024 * 1024;

/** The working directory a rollout's first line (`session_meta`) names, if it can be read. */
async function readRolloutCwd(filePath: string): Promise<string | undefined> {
	try {
		const firstLine = await readFirstJsonlLine(filePath, { maxBytes: ROLLOUT_HEADER_MAX_BYTES });
		if (!firstLine) return undefined;
		const metadata = JSON.parse(firstLine) as { payload?: { cwd?: unknown }; cwd?: unknown };
		const cwd = metadata?.payload?.cwd ?? metadata?.cwd;
		return typeof cwd === 'string' && cwd ? cwd : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The oversized rollouts that belong to `projectPath`. One whose working directory could not be
 * read may belong to any project, so it counts against every one: a total is then named short
 * rather than quietly short.
 */
function skippedForProject(
	oversized: ReadonlyArray<{ file: SkippedSessionFile; cwd: string | undefined }>,
	projectPath: string
): SkippedSessionFile[] {
	return oversized
		.filter(({ cwd }) => cwd === undefined || isSessionForProject(cwd, projectPath))
		.map(({ file }) => file);
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
	return path.join(getAppUserDataDir(), 'stats-cache', CODEX_SESSION_CACHE_FILENAME);
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
		void captureException(error);
		logger.warn('Failed to save Codex session cache', LOG_CONTEXT, { error });
	}
}

/**
 * Parse a Codex session file and extract metadata (local filesystem).
 *
 * Read and parsed on the transcript parse worker pool, streamed: a rollout can
 * run to hundreds of MB, and an Auto Run grows it on every task, so reading it
 * whole here put several hundred MB of garbage on the main heap per reparse
 * (#2084). See `codex-session-info.ts`.
 */
async function parseSessionFile(
	filePath: string,
	sessionId: string,
	stats: { size: number; mtimeMs: number },
	/** Called when the file is there but could not be read (never for an oversized or empty one). */
	onUnreadable?: () => void
): Promise<AgentSessionInfo | null> {
	try {
		if (stats.size > MAX_SESSION_FILE_SIZE) {
			logger.warn('Skipping oversized Codex session file', LOG_CONTEXT, {
				filePath,
				size: stats.size,
			});
			return null;
		}

		return await runTranscriptParse({
			kind: 'codex-session-info',
			filePath,
			sessionId,
			sizeBytes: stats.size,
			mtimeMs: stats.mtimeMs,
		});
	} catch (error) {
		// Left out of every total from here on: say so, unless the file is simply gone.
		if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') onUnreadable?.();
		// RangeError: Invalid string length occurs when a single line is too large for
		// V8 string allocation. This is expected and not worth reporting to Sentry.
		if (error instanceof RangeError) {
			logger.warn('Codex session file too large to parse', LOG_CONTEXT, { filePath });
			return null;
		}
		// Unreadable or gone: the environment, not a Maestro bug.
		if (isExpectedSessionReadError(error)) {
			logger.warn(`Could not read Codex session file: ${filePath}`, LOG_CONTEXT, error);
			return null;
		}
		logger.error(`Error reading Codex session file: ${filePath}`, LOG_CONTEXT, error);
		captureException(error, { operation: 'codexStorage:readSessionFile', filePath });
		return null;
	}
}

/**
 * Codex CLI Session Storage Implementation
 *
 * Provides access to Codex CLI's local session storage at ~/.codex/sessions/
 */
export class CodexSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'codex';

	constructor(private readonly originsStore?: Store<ClaudeSessionOriginsData>) {
		super();
	}

	private attachOriginInfo(sessions: AgentSessionInfo[], projectPath: string): AgentSessionInfo[] {
		if (!this.originsStore) return sessions;
		const origins = this.originsStore.get('origins', {});
		return sessions.map((session) => {
			const record =
				origins[projectPath]?.[session.sessionId] ??
				origins[normalizeProjectPath(projectPath)]?.[session.sessionId] ??
				origins[session.projectPath]?.[session.sessionId] ??
				origins[normalizeProjectPath(session.projectPath)]?.[session.sessionId];
			if (!record) return session;
			const info = typeof record === 'string' ? { origin: record } : record;
			return {
				...session,
				...(info.origin !== undefined ? { origin: info.origin } : {}),
				...(typeof record === 'object' && record.sessionName !== undefined
					? { sessionName: record.sessionName }
					: {}),
				...(typeof record === 'object' && record.starred !== undefined
					? { starred: record.starred }
					: {}),
			};
		});
	}

	/**
	 * Get the Codex sessions directory path for an account (`CODEX_HOME`), or
	 * the default account when `accountDir` is undefined.
	 */
	private getSessionsDir(accountDir?: string): string {
		return getCodexSessionsDir(accountDir);
	}

	/**
	 * Get the Codex sessions directory path (remote via SSH)
	 * On remote Linux hosts, ~ expands to the user's home directory
	 */
	private getRemoteSessionsDir(accountDir?: string): string {
		return path.posix.join(accountDir || '~/.codex', 'sessions');
	}

	/**
	 * Find all session files, organized by date directories
	 */
	private async findAllSessionFiles(
		accountDir?: string,
		/** Counts the folders that are there but could not be listed (their rollouts are missed). */
		unreadable?: { dirs: number }
	): Promise<Array<{ filePath: string; filename: string }>> {
		const sessionsDir = this.getSessionsDir(accountDir);
		const sessionFiles: Array<{ filePath: string; filename: string }> = [];
		const missed = (error: unknown): void => {
			if (unreadable && (error as NodeJS.ErrnoException)?.code !== 'ENOENT') unreadable.dirs++;
		};

		// A missing root is an account with no rollouts; one that is there but cannot be listed
		// misses all of them, and says so.
		let years: string[];
		try {
			await fs.access(sessionsDir);
			years = await fs.readdir(sessionsDir);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== 'ENOENT' && code !== 'ENOTDIR') missed(error);
			return [];
		}

		// Scan YYYY directories
		for (const year of years) {
			if (!/^\d{4}$/.test(year)) continue;

			const yearDir = path.join(sessionsDir, year);
			try {
				const yearStat = await fs.stat(yearDir);
				if (!yearStat.isDirectory()) continue;
			} catch (error) {
				missed(error);
				continue;
			}

			// Scan MM directories; an unlisted year misses only its own rollouts.
			let months: string[];
			try {
				months = await fs.readdir(yearDir);
			} catch (error) {
				missed(error);
				continue;
			}
			for (const month of months) {
				if (!/^\d{2}$/.test(month)) continue;

				const monthDir = path.join(yearDir, month);
				try {
					const monthStat = await fs.stat(monthDir);
					if (!monthStat.isDirectory()) continue;
				} catch (error) {
					missed(error);
					continue;
				}

				// Scan DD directories; an unlisted month misses only its own rollouts.
				let days: string[];
				try {
					days = await fs.readdir(monthDir);
				} catch (error) {
					missed(error);
					continue;
				}
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
					} catch (error) {
						missed(error);
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
		sshConfig: SshRemoteConfig,
		accountDir?: string
	): Promise<Array<{ filePath: string; filename: string }>> {
		const sessionsDir = this.getRemoteSessionsDir(accountDir);
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
			if (stats.size > MAX_SESSION_FILE_SIZE) {
				logger.warn('Skipping oversized remote Codex session file', LOG_CONTEXT, {
					filePath,
					size: stats.size,
				});
				return null;
			}

			const result = await readFileRemote(filePath, sshConfig);
			if (!result.success || !result.data) {
				logger.error(
					`Failed to read remote Codex session file: ${filePath} - ${result.error}`,
					LOG_CONTEXT
				);
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
			const tokenCounts = new CodexTokenCounts();
			let firstTimestamp = timestamp;
			let lastTimestamp = timestamp;

			for (let i = 0; i < lines.length; i++) {
				try {
					const entry = JSON.parse(lines[i]);

					// Handle turn.completed for usage stats (already per-turn)
					if (entry.type === 'turn.completed' && entry.usage) {
						tokenCounts.addTurn(entry.usage);
					}

					// Handle Codex "event_msg" usage stats
					if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
						tokenCounts.addTokenCountEvent(entry.payload.info);
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
				firstMessage: previewMessage.slice(0, CODEX_FIRST_MESSAGE_PREVIEW_LENGTH),
				messageCount,
				sizeBytes: stats.size,
				inputTokens: tokenCounts.inputTokens,
				outputTokens: tokenCounts.outputTokens,
				cacheReadTokens: tokenCounts.cachedTokens,
				cacheCreationTokens: 0,
				durationSeconds,
			};
		} catch (error) {
			logger.error(`Error reading remote Codex session file: ${filePath}`, LOG_CONTEXT, error);
			captureException(error, { operation: 'codexStorage:readRemoteSessionFile', filePath });
			return null;
		}
	}

	/**
	 * Every local session of one account that has a working directory, newest
	 * first: one walk of its rollouts, served from the parse cache where a file
	 * is unchanged. Callers filter by project.
	 */
	private async scanLocalSessions(accountDir?: string): Promise<{
		sessions: AgentSessionInfo[];
		fileCount: number;
		/**
		 * Rollouts left out (past the size cap, or unreadable), with the working directory their first
		 * line names when it can be read.
		 */
		oversized: Array<{ file: SkippedSessionFile; cwd: string | undefined }>;
	}> {
		const sessionsDir = this.getSessionsDir(accountDir);
		const unreadableDirs = { dirs: 0 };
		const allSessionFiles = await this.findAllSessionFiles(accountDir, unreadableDirs);

		const cache = (await loadCodexSessionCache()) || {
			version: CODEX_SESSION_CACHE_VERSION,
			lastProcessedAt: 0,
			sessions: {},
		};

		const sessions: AgentSessionInfo[] = [];
		const oversized: Array<{ file: SkippedSessionFile; cwd: string | undefined }> = [];
		const currentFilePaths = new Set<string>();
		let cacheUpdated = false;

		for (const { filePath, filename } of allSessionFiles) {
			currentFilePaths.add(filePath);
			let stats: { size: number; mtimeMs: number };

			try {
				const fileStat = await fs.stat(filePath);
				if (fileStat.size === 0) continue;
				stats = { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
				if (stats.size > MAX_SESSION_FILE_SIZE) {
					// Never parsed (`parseSessionFile`), so its usage is missing from every
					// total. Its first line names its working directory, so the listing can
					// say which project is short.
					oversized.push({
						file: { sizeBytes: stats.size, reason: 'too-large' },
						cwd: await readRolloutCwd(filePath),
					});
					// Left out whole: an older cached reading of the same path is not served either.
					continue;
				}
			} catch (error) {
				// Listed but not stattable: its usage is missing, and its project unknown.
				if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
					oversized.push({ file: { sizeBytes: 0, reason: 'unreadable' }, cwd: undefined });
				}
				if (isExpectedSessionReadError(error)) {
					logger.warn(`Could not stat Codex session file: ${filename}`, LOG_CONTEXT, error);
					continue;
				}
				logger.error(`Error stating Codex session file: ${filename}`, LOG_CONTEXT, error);
				captureException(error, { operation: 'codexStorage:statSessionFile', filename });
				continue;
			}

			const cached = cache.sessions[filePath];
			if (cached && cached.fileMtimeMs >= stats.mtimeMs) {
				if (cached.session.projectPath) sessions.push(cached.session);
				continue;
			}

			const sessionId = extractSessionIdFromFilename(filename) || filename;
			let unreadableFile = false;
			const session = await parseSessionFile(
				filePath,
				sessionId,
				{ size: stats.size, mtimeMs: stats.mtimeMs },
				() => {
					unreadableFile = true;
				}
			);
			if (unreadableFile) {
				oversized.push({
					file: { sizeBytes: stats.size, reason: 'unreadable' },
					cwd: await readRolloutCwd(filePath),
				});
			}

			if (session) {
				cache.sessions[filePath] = { session, fileMtimeMs: stats.mtimeMs };
				cacheUpdated = true;
				if (session.projectPath) sessions.push(session);
			}
		}

		// Prune only entries under the account we just walked. Cache keys are
		// absolute rollout paths, so two accounts never collide, but a blind
		// prune would delete the OTHER account's entries on every pass: with
		// multiple accounts the two calls would take turns evicting each other
		// and every dashboard refresh would reparse every transcript.
		// Entries under an account dir the user has since deleted are no longer
		// reachable by any prefix, so they survive until the cache version is
		// bumped. They are a handful of stale records, not stale numbers: every
		// session served to a caller comes from the account it just walked.
		// A walk that could not list a folder did not see its rollouts: keep their entries.
		const accountPrefix = sessionsDir.endsWith(path.sep)
			? sessionsDir
			: `${sessionsDir}${path.sep}`;
		for (const cachedPath of unreadableDirs.dirs > 0 ? [] : Object.keys(cache.sessions)) {
			if (!cachedPath.startsWith(accountPrefix)) continue;
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
		// A date folder that could not be listed may hold rollouts of any project.
		for (let i = 0; i < unreadableDirs.dirs; i++) {
			oversized.push({ file: { sizeBytes: 0, reason: 'unreadable' }, cwd: undefined });
		}
		return { sessions, fileCount: allSessionFiles.length, oversized };
	}

	/**
	 * The local sessions of several projects of one account, from ONE walk of
	 * its rollouts (`listSessions` walks them all for every project). Each
	 * project gets what `listSessions(projectPath, undefined, accountDir)` would
	 * return for it.
	 */
	async listSessionsForProjects(
		projectPaths: readonly string[],
		accountDir?: string,
		observer?: { onSkippedFile?(projectPath: string, file: SkippedSessionFile): void }
	): Promise<Map<string, AgentSessionInfo[]>> {
		const { sessions: all, oversized } = await this.scanLocalSessions(accountDir);
		const byProject = new Map<string, AgentSessionInfo[]>();
		for (const projectPath of projectPaths) {
			for (const skipped of skippedForProject(oversized, projectPath)) {
				observer?.onSkippedFile?.(projectPath, skipped);
			}
			const sessions = all.filter(
				(session) => session.projectPath && isSessionForProject(session.projectPath, projectPath)
			);
			byProject.set(projectPath, this.attachOriginInfo(sessions, projectPath));
		}
		return byProject;
	}

	/**
	 * List sessions for a project.
	 *
	 * `accountDir` selects which `CODEX_HOME` account's rollouts to read;
	 * undefined reads the default account. See {@link AgentSessionStorage}.
	 */
	async listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig,
		accountDir?: string,
		observer?: SessionListObserver
	): Promise<AgentSessionInfo[]> {
		// Use SSH remote access if config provided
		if (sshConfig) {
			return this.listSessionsRemote(projectPath, sshConfig, accountDir);
		}
		const { sessions: all, fileCount, oversized } = await this.scanLocalSessions(accountDir);
		for (const skipped of skippedForProject(oversized, projectPath)) {
			observer?.onSkippedFile?.(skipped);
		}
		const sessions = all.filter(
			(session) => session.projectPath && isSessionForProject(session.projectPath, projectPath)
		);

		if (fileCount === 0) {
			logger.info(`No Codex sessions found`, LOG_CONTEXT);
		} else {
			logger.info(
				`Found ${sessions.length} Codex sessions for project: ${projectPath}`,
				LOG_CONTEXT
			);
		}

		return this.attachOriginInfo(sessions, projectPath);
	}

	/**
	 * List sessions from remote host via SSH
	 */
	private async listSessionsRemote(
		projectPath: string,
		sshConfig: SshRemoteConfig,
		accountDir?: string
	): Promise<AgentSessionInfo[]> {
		const allSessionFiles = await this.findAllSessionFilesRemote(sshConfig, accountDir);

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

		return this.attachOriginInfo(sessions, projectPath);
	}

	async readSessionMessages(
		_projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		// Only the requested page is held; see MessagePageCollector.
		const page = new MessagePageCollector(options);
		// A tool's output is merged into its call, the FIRST message carrying that
		// uuid and a toolUse. Positions are tracked so the merge still finds the
		// call when it is in the window, and still knows the call EXISTS (rather
		// than emitting a standalone output) when it is older than the page.
		const toolCallPositions = new Map<string, number>();
		let messageIndex = 0;
		const push = (message: SessionMessage) => {
			const position = page.push(message);
			if (message.toolUse && !toolCallPositions.has(message.uuid)) {
				toolCallPositions.set(message.uuid, position);
			}
			messageIndex++;
		};

		const collect = (line: string) => {
			try {
				const entry = JSON.parse(line);

				// Handle direct message entries
				if (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant')) {
					const textContent = extractTextFromContent(entry.content);

					if (textContent) {
						push({
							type: entry.role,
							role: entry.role,
							content: textContent,
							timestamp: entry.timestamp || '',
							uuid: `codex-msg-${messageIndex}`,
						});
					}
				}

				// Handle response_item messages (current Codex format)
				if (entry.type === 'response_item' && entry.payload?.type === 'message') {
					if (entry.payload.role === 'user' || entry.payload.role === 'assistant') {
						const textContent = extractTextFromContent(entry.payload.content);

						if (textContent) {
							push({
								type: entry.payload.role,
								role: entry.payload.role,
								content: textContent,
								timestamp: entry.timestamp || '',
								uuid: entry.payload.id || `codex-msg-${messageIndex}`,
							});
						}
					}
				}

				// Handle response_item function_call / custom_tool_call (current Codex format)
				if (
					entry.type === 'response_item' &&
					(entry.payload?.type === 'function_call' || entry.payload?.type === 'custom_tool_call')
				) {
					let parsedInput: unknown;
					try {
						parsedInput = JSON.parse(entry.payload.arguments || '{}');
					} catch {
						parsedInput = entry.payload.arguments || {};
					}
					const toolInfo: CodexToolUseEntry = {
						tool: entry.payload.name,
						args: entry.payload.arguments,
						state: {
							status: 'running',
							input: parsedInput,
						},
					};
					push({
						type: 'assistant',
						role: 'assistant',
						content: `Tool: ${entry.payload.name}`,
						timestamp: entry.timestamp || '',
						uuid: entry.payload.call_id || `codex-msg-${messageIndex}`,
						toolUse: [toolInfo],
					});
				}

				// Handle response_item function_call_output / custom_tool_call_output (current Codex format)
				// Merge output into the preceding tool call message instead of creating a new message
				if (
					entry.type === 'response_item' &&
					(entry.payload?.type === 'function_call_output' ||
						entry.payload?.type === 'custom_tool_call_output')
				) {
					const callId = entry.payload.call_id;
					const outputText = entry.payload.output || '';
					// Find the matching tool call message by call_id and merge the output
					const matchingPosition = callId ? toolCallPositions.get(callId) : undefined;
					if (matchingPosition !== undefined) {
						page.update(matchingPosition, (matchingMsg) => {
							const toolEntries = matchingMsg.toolUse as CodexToolUseEntry[] | undefined;
							const firstEntry = toolEntries?.[0];
							if (!firstEntry?.state) return matchingMsg;
							// Replace the message immutably with updated tool state
							const updatedEntry: CodexToolUseEntry = {
								...firstEntry,
								state: {
									...firstEntry.state,
									status: 'completed',
									output: outputText,
								},
							};
							return {
								...matchingMsg,
								toolUse: [updatedEntry, ...(toolEntries?.slice(1) || [])],
							};
						});
					} else {
						// No matching tool call found - create a standalone message
						push({
							type: 'assistant',
							role: 'assistant',
							content: outputText || '[Tool result]',
							timestamp: entry.timestamp || '',
							uuid: callId || `codex-msg-${messageIndex}`,
						});
					}
				}

				// Handle item.completed agent_message events (legacy format)
				if (entry.type === 'item.completed' && entry.item?.type === 'agent_message') {
					push({
						type: 'assistant',
						role: 'assistant',
						content: entry.item.text || '',
						timestamp: entry.timestamp || '',
						uuid: entry.item.id || `codex-msg-${messageIndex}`,
					});
				}

				// Handle item.completed tool_call events (legacy format)
				if (entry.type === 'item.completed' && entry.item?.type === 'tool_call') {
					const toolInfo = {
						tool: entry.item.tool,
						args: entry.item.args,
					};
					push({
						type: 'assistant',
						role: 'assistant',
						content: `Tool: ${entry.item.tool}`,
						timestamp: entry.timestamp || '',
						uuid: entry.item.id || `codex-msg-${messageIndex}`,
						toolUse: [toolInfo],
					});
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

					push({
						type: 'assistant',
						role: 'assistant',
						content: resultContent || '[Tool result]',
						timestamp: entry.timestamp || '',
						uuid: entry.item.id || `codex-msg-${messageIndex}`,
					});
				}
			} catch {
				// Skip malformed lines
			}
		};

		if (sshConfig) {
			// For SSH, find the session file remotely
			const sessionFilePath = await this.findSessionFileRemote(sessionId, sshConfig);
			if (!sessionFilePath) {
				logger.warn(`Codex session file not found on remote: ${sessionId}`, LOG_CONTEXT);
				return { messages: [], total: 0, hasMore: false };
			}
			const result = await readFileRemote(sessionFilePath, sshConfig);
			if (!result.success || !result.data) {
				logger.error(
					`Failed to read remote Codex session: ${sessionId} - ${result.error}`,
					LOG_CONTEXT
				);
				return { messages: [], total: 0, hasMore: false };
			}
			for (const line of result.data.split('\n')) {
				if (line.trim()) collect(line);
			}
			return page.result();
		}

		// Find the session file by sessionId locally
		const sessionFilePath = options?.filePath ?? (await this.findSessionFile(sessionId));

		if (!sessionFilePath) {
			logger.warn(`Codex session file not found: ${sessionId}`, LOG_CONTEXT);
			return { messages: [], total: 0, hasMore: false };
		}

		if (options?.content !== undefined) {
			for (const line of options.content.split('\n')) {
				if (line.trim()) collect(line);
			}
		} else {
			// Streamed, never read whole: a rollout can be hundreds of MB (#1862).
			await forEachJsonlLine(sessionFilePath, collect);
		}
		return page.result();
	}

	protected async getSearchableMessages(
		sessionId: string,
		_projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		let content: string;

		try {
			if (sshConfig) {
				const sessionFilePath = await this.findSessionFileRemote(sessionId, sshConfig);
				if (!sessionFilePath) return [];
				const result = await readFileRemote(sessionFilePath, sshConfig);
				if (!result.success || !result.data) return [];
				content = result.data;
			} else {
				const sessionFilePath = await this.findSessionFile(sessionId);
				if (!sessionFilePath) return [];
				content = await fs.readFile(sessionFilePath, 'utf-8');
			}
		} catch {
			return [];
		}

		const searchableMessages: SearchableMessage[] = [];

		for (const { entry } of parseNativeLines(content)) {
			try {
				if (!entry) continue;

				let textContent = '';
				let role: 'user' | 'assistant' | null = null;

				// Handle message entries (legacy format)
				if (entry.type === 'message') {
					role = entry.role;
					textContent = extractTextFromContent(entry.content);
				}

				// Handle response_item messages (current Codex format)
				if (entry.type === 'response_item' && entry.payload?.type === 'message') {
					role = entry.payload.role;
					textContent = extractTextFromContent(entry.payload.content);
				}

				// Handle item.completed agent_message
				if (entry.type === 'item.completed' && entry.item?.type === 'agent_message') {
					role = 'assistant';
					textContent = entry.item.text || '';
				}

				if (role && (role === 'user' || role === 'assistant') && textContent.trim()) {
					searchableMessages.push({ role, textContent });
				}
			} catch {
				// Skip malformed lines
			}
		}

		return searchableMessages;
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
	async findSessionFile(sessionId: string, accountDir?: string): Promise<string | null> {
		const allFiles = await this.findAllSessionFiles(accountDir);

		for (const { filePath, filename } of allFiles) {
			const fileSessionId = extractSessionIdFromFilename(filename);
			if (fileSessionId === sessionId) {
				return filePath;
			}

			// Also check by reading first line for session ID. Only that line: this
			// runs for every rollout until the match, and a rollout can be hundreds
			// of MB (#1862).
			try {
				const firstLine = await readFirstJsonlLine(filePath);
				if (firstLine) {
					const metadata = JSON.parse(firstLine) as CodexSessionMetadata;
					const metadataId = metadata?.payload?.id || metadata.id;
					if (metadataId === sessionId) {
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
						const metadataId = metadata?.payload?.id || metadata.id;
						if (metadataId === sessionId) {
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
		sshConfig?: SshRemoteConfig,
		accountDir?: string
	): Promise<DeleteMessagePairResult> {
		// Delete operations on remote sessions are not supported
		if (sshConfig) {
			logger.warn('Delete message pair not supported for SSH remote sessions', LOG_CONTEXT);
			return { success: false, error: 'Delete not supported for remote sessions' };
		}
		// The agent's own CODEX_HOME: a rollout copied between two homes keeps its
		// session ID, and the default home would edit the copy the agent never reads.
		const sessionFilePath = await this.findSessionFile(sessionId, accountDir);

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
					payload?: {
						id?: string;
						type?: string;
						role?: string;
						content?: CodexMessageContent[];
						call_id?: string;
						name?: string;
					};
					item?: {
						id?: string;
						type?: string;
						tool?: string;
						tool_call_id?: string;
					};
				} | null;
				remove?: boolean;
			}

			/**
			 * Check if an entry is a user message in either format:
			 * - Legacy: { type: 'message', role: 'user' }
			 * - v0.111.0: { type: 'response_item', payload: { type: 'message', role: 'user' } }
			 */
			function isUserMessage(entry: ParsedLine['entry']): boolean {
				if (!entry) return false;
				if (entry.type === 'message' && entry.role === 'user') return true;
				if (
					entry.type === 'response_item' &&
					entry.payload?.type === 'message' &&
					entry.payload?.role === 'user'
				) {
					return true;
				}
				return false;
			}

			/**
			 * Extract text content from a user message entry (either format)
			 */
			function getUserMessageContent(entry: ParsedLine['entry']): string {
				if (!entry) return '';
				if (entry.type === 'message' && entry.role === 'user' && entry.content) {
					return extractTextFromContent(entry.content);
				}
				if (
					entry.type === 'response_item' &&
					entry.payload?.type === 'message' &&
					entry.payload?.role === 'user' &&
					entry.payload?.content
				) {
					return extractTextFromContent(entry.payload.content);
				}
				return '';
			}

			const parsedLines: ParsedLine[] = [];
			let userMessageIndex = -1;

			// Build a message-index counter that mirrors readSessionMessages logic.
			// readSessionMessages increments messageIndex only for actual displayable messages,
			// so we must do the same here to match UUIDs like "codex-msg-N".
			let messageIndex = 0;

			// Parse all lines and find the target user message
			for (let i = 0; i < lines.length; i++) {
				try {
					const entry = JSON.parse(lines[i]);
					parsedLines.push({ line: lines[i], entry });

					// Match user messages in both legacy and v0.111.0 formats
					if (isUserMessage(entry)) {
						// Check payload.id first (v0.111.0 format uses real IDs)
						if (
							entry.type === 'response_item' &&
							entry.payload?.id &&
							userMessageUuid === entry.payload.id
						) {
							userMessageIndex = parsedLines.length - 1;
						}
						const text = getUserMessageContent(entry);
						if (text) {
							// Fallback: match by sequential message UUID (codex-msg-N)
							if (
								userMessageIndex !== parsedLines.length - 1 &&
								userMessageUuid === `codex-msg-${messageIndex}`
							) {
								userMessageIndex = parsedLines.length - 1;
							}
							messageIndex++;
						}
					}
					// Match by payload.id for non-user v0.111.0 entries (e.g. tool calls referenced by id)
					else if (
						entry.type === 'response_item' &&
						entry.payload?.id &&
						userMessageUuid === entry.payload.id
					) {
						userMessageIndex = parsedLines.length - 1;
					}

					// Count assistant messages to keep messageIndex in sync with readSessionMessages
					if (entry.type === 'message' && entry.role === 'assistant') {
						const text = extractTextFromContent(entry.content);
						if (text) messageIndex++;
					} else if (
						entry.type === 'response_item' &&
						entry.payload?.type === 'message' &&
						entry.payload?.role === 'assistant'
					) {
						const text = extractTextFromContent(entry.payload?.content);
						if (text) messageIndex++;
					} else if (entry.type === 'item.completed' && entry.item?.type === 'agent_message') {
						messageIndex++;
					} else if (entry.type === 'item.completed' && entry.item?.type === 'tool_call') {
						messageIndex++;
					} else if (entry.type === 'item.completed' && entry.item?.type === 'tool_result') {
						messageIndex++;
					} else if (
						entry.type === 'response_item' &&
						(entry.payload?.type === 'function_call' || entry.payload?.type === 'custom_tool_call')
					) {
						messageIndex++;
					}
					// function_call_output / custom_tool_call_output normally merges into a preceding tool call
					// in readSessionMessages. But when no matching call_id is found, readSessionMessages creates
					// a standalone assistant message and increments messageIndex. Mirror that here.
					if (
						entry.type === 'response_item' &&
						(entry.payload?.type === 'function_call_output' ||
							entry.payload?.type === 'custom_tool_call_output')
					) {
						const callId = entry.payload.call_id;
						// Check if any prior parsed line has a matching call_id
						const hasMatchingCall = callId
							? parsedLines.some(
									(p) =>
										p.entry &&
										p.entry.type === 'response_item' &&
										(p.entry.payload?.type === 'function_call' ||
											p.entry.payload?.type === 'custom_tool_call') &&
										p.entry.payload?.call_id === callId
								)
							: false;
						if (!hasMatchingCall) {
							messageIndex++;
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
					if (isUserMessage(entry)) {
						const textContent = getUserMessageContent(entry);
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
				return MESSAGE_NOT_IN_TRANSCRIPT;
			}

			// Find the end of the response (next user message) and collect tool_call IDs being deleted
			let endIndex = parsedLines.length;
			const deletedToolCallIds = new Set<string>();
			const deletedCallIds = new Set<string>();

			for (let i = userMessageIndex + 1; i < parsedLines.length; i++) {
				const entry = parsedLines[i].entry;

				// Stop at the next user message (either format)
				if (isUserMessage(entry)) {
					endIndex = i;
					break;
				}

				// Collect tool_call IDs from item.completed events being deleted (legacy)
				if (
					entry?.type === 'item.completed' &&
					entry?.item?.type === 'tool_call' &&
					entry?.item?.id
				) {
					deletedToolCallIds.add(entry.item.id);
				}

				// Collect call_ids from response_item function_call events being deleted (v0.111.0)
				if (
					entry?.type === 'response_item' &&
					(entry?.payload?.type === 'function_call' ||
						entry?.payload?.type === 'custom_tool_call') &&
					entry?.payload?.call_id
				) {
					deletedCallIds.add(entry.payload.call_id);
				}
			}

			// Remove the message pair
			let linesToKeep = [...parsedLines.slice(0, userMessageIndex), ...parsedLines.slice(endIndex)];

			// If we deleted any tool_call blocks, clean up orphaned tool_result/output blocks
			if (deletedToolCallIds.size > 0 || deletedCallIds.size > 0) {
				linesToKeep = linesToKeep.filter((item) => {
					const entry = item.entry;

					// Remove tool_result events that reference deleted tool_call IDs (legacy)
					if (entry?.type === 'item.completed' && entry?.item?.type === 'tool_result') {
						// tool_result items reference tool_call via tool_call_id or the item.id pattern
						const toolCallId = entry.item.tool_call_id || entry.item.id;
						if (toolCallId && deletedToolCallIds.has(toolCallId)) {
							return false;
						}
					}

					// Remove function_call_output events that reference deleted call_ids (v0.111.0)
					if (
						entry?.type === 'response_item' &&
						(entry?.payload?.type === 'function_call_output' ||
							entry?.payload?.type === 'custom_tool_call_output') &&
						entry?.payload?.call_id &&
						deletedCallIds.has(entry.payload.call_id)
					) {
						return false;
					}

					return true;
				});

				const allDeletedIds = [...Array.from(deletedToolCallIds), ...Array.from(deletedCallIds)];
				logger.info('Cleaned up orphaned tool output blocks in Codex session', LOG_CONTEXT, {
					sessionId,
					deletedToolCallIds: allDeletedIds,
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
			captureException(error, { operation: 'codexStorage:deleteMessagePair', sessionId });
			return { success: false, error: String(error) };
		}
	}
}
