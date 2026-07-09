/**
 * Grok CLI Session Storage Implementation
 *
 * Grok stores each session as a directory:
 *   ~/.grok/sessions/<percent-encoded-cwd>/<session-uuid>/
 *     summary.json       — session metadata (id, cwd, title, timestamps, counts)
 *     chat_history.jsonl — the transcript (system/user/assistant/tool_result/reasoning records)
 *
 * The first-level folder name is the session's working directory with `/`
 * percent-encoded as `%2F`, so project filtering happens on directory names
 * before any file is opened. Structurally this mirrors Copilot's
 * directory-per-session layout (metadata file beside a JSONL transcript),
 * so this implementation follows `copilot-session-storage.ts`, borrowing
 * only the tool_call/tool_result merge pattern from Codex.
 *
 * Grok's transcript records carry no per-message timestamps and no token
 * counts; those fields are left empty/zero rather than fabricated from the
 * auxiliary event files (see Phase 02 research notes).
 */

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { readFileRemote, readDirRemote, statRemote } from '../utils/remote-fs';
import {
	mapWithConcurrency,
	LOCAL_SESSION_READ_CONCURRENCY,
	REMOTE_SESSION_READ_CONCURRENCY,
} from '../utils/concurrency';
import type {
	AgentSessionInfo,
	SessionMessagesResult,
	SessionReadOptions,
	SessionMessage,
} from '../agents';
import type { ToolType, SshRemoteConfig } from '../../shared/types';
import { isMacOS } from '../../shared/platformDetection';
import { BaseSessionStorage } from './base-session-storage';
import type { SearchableMessage } from './base-session-storage';

const LOG_CONTEXT = '[GrokSessionStorage]';
const MAX_SESSION_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const FIRST_MESSAGE_PREVIEW_LENGTH = 200;

/** Resolve the local Grok sessions directory. */
function getLocalGrokSessionsDir(): string {
	return path.join(os.homedir(), '.grok', 'sessions');
}

/** Shape of summary.json (the fields this storage consumes). */
interface GrokSessionSummary {
	info?: {
		id?: string;
		cwd?: string;
	};
	session_summary?: string;
	generated_title?: string;
	created_at?: string;
	updated_at?: string;
	git_root_dir?: string;
}

/** A tool call entry on an assistant transcript record. */
interface GrokToolCall {
	id?: string;
	name?: string;
	/** JSON-encoded argument string. */
	arguments?: string;
}

/** One line of chat_history.jsonl. */
interface GrokChatRecord {
	type?: string;
	/** String for system/assistant/tool_result records; `{type:'text',text}` block array for user records. */
	content?: unknown;
	/** Present on injected-context user records (e.g. project_instructions, system_reminder). */
	synthetic_reason?: string;
	tool_calls?: GrokToolCall[];
	tool_call_id?: string;
}

/** Tool use entry shape used when building SessionMessage.toolUse arrays. */
interface GrokToolUseEntry {
	tool?: string;
	args?: unknown;
	state: {
		status: string;
		input?: unknown;
		output?: string;
	};
}

interface ParsedGrokChatHistory {
	messages: SessionMessage[];
	firstUserMessage: string;
	firstAssistantMessage: string;
}

/** Extract plain text from a user record's content block array. */
function extractUserText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((block) =>
			block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
				? (block as { text: string }).text
				: ''
		)
		.filter((text) => text.trim())
		.join(' ');
}

/**
 * Check whether a user record is injected context rather than a real prompt.
 * Grok flags most context injections with `synthetic_reason`; the environment
 * block at the start of every session is a plain user record wrapped in
 * `<user_info>` tags instead.
 */
function isSyntheticUserRecord(record: GrokChatRecord, text: string): boolean {
	if (record.synthetic_reason) return true;
	return text.trim().startsWith('<user_info>');
}

/** Strip the `<user_query>` wrapper Grok adds around the real prompt text. */
function stripUserQueryWrapper(text: string): string {
	const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
	return match ? match[1] : text.trim();
}

/**
 * Normalize a path for comparison: strip trailing slashes and fold the macOS
 * `/private` symlink prefix (`/private/var` == `/var`, `/private/tmp` ==
 * `/tmp`) since Grok records the realpath'd cwd while Maestro may pass the
 * symlinked form.
 */
function normalizePathForComparison(value: string): string {
	let normalized = value.replace(/\/+$/, '');
	if (!normalized) normalized = '/';
	return normalized.replace(/^\/private(\/(?:var|tmp|etc))(\/|$)/, '$1$2');
}

/**
 * Convert a project path to the cwd form Grok records on disk (the inverse of
 * normalizePathForComparison). Grok stores the realpath'd cwd, so on macOS the
 * symlinked `/var`, `/tmp`, and `/etc` prefixes must be expanded back to
 * `/private/...` before percent-encoding. The remote OS is unknown over SSH,
 * so remote paths are left untouched apart from trailing-slash cleanup.
 */
function toGrokRecordedCwd(projectPath: string, isRemote: boolean): string {
	let normalized = projectPath.replace(/\/+$/, '');
	if (!normalized) normalized = '/';
	if (!isRemote && isMacOS()) {
		normalized = normalized.replace(/^(\/(?:var|tmp|etc))(\/|$)/, '/private$1$2');
	}
	return normalized;
}

/** Check whether a session cwd belongs to the given project (exact match or subdirectory). */
function matchesProject(cwd: string, projectPath: string): boolean {
	const normalizedCwd = normalizePathForComparison(cwd);
	const normalizedProject = normalizePathForComparison(projectPath);
	return normalizedCwd === normalizedProject || normalizedCwd.startsWith(`${normalizedProject}/`);
}

/** Check if a remote-fs error indicates a benign not-found/permission case vs an unexpected SSH failure. */
function isExpectedRemoteError(error?: string): boolean {
	if (!error) return false;
	const lower = error.toLowerCase();
	return (
		lower.includes('not found') ||
		lower.includes('not accessible') ||
		lower.includes('no such file') ||
		lower.includes('permission denied') ||
		lower.includes('does not exist')
	);
}

/** Convert an assistant record's tool calls into a normalized tool-use array. */
function buildToolUse(toolCalls?: GrokToolCall[]): GrokToolUseEntry[] | undefined {
	if (!toolCalls?.length) return undefined;
	const entries = toolCalls
		.filter((call) => call.name)
		.map((call) => {
			let input: unknown;
			try {
				input = JSON.parse(call.arguments || '{}');
			} catch {
				input = call.arguments;
			}
			return {
				tool: call.name,
				args: call.arguments,
				state: { status: 'running', input },
			};
		});
	return entries.length > 0 ? entries : undefined;
}

/**
 * Parse chat_history.jsonl content into display messages.
 *
 * Transcript records carry no timestamps, so `timestamp` is left empty (the
 * sibling storages tolerate this). `tool_result` records are merged into the
 * preceding assistant record's tool entry by call id; system and reasoning
 * records are skipped.
 */
function parseChatHistory(content: string): ParsedGrokChatHistory {
	const messages: SessionMessage[] = [];
	let firstUserMessage = '';
	let firstAssistantMessage = '';
	let messageIndex = 0;
	// Maps a tool call id to the message/tool entry awaiting its tool_result.
	const pendingToolCalls = new Map<string, { messageIndex: number; entryIndex: number }>();

	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;

		let record: GrokChatRecord;
		try {
			record = JSON.parse(line) as GrokChatRecord;
		} catch {
			// Grok appends while running, so a live session can have a partial final line.
			continue;
		}

		if (record.type === 'user') {
			const rawText = extractUserText(record.content);
			if (isSyntheticUserRecord(record, rawText)) continue;
			const text = stripUserQueryWrapper(rawText);
			if (!text.trim()) continue;
			firstUserMessage ||= text;
			messages.push({
				type: 'user',
				role: 'user',
				content: text,
				timestamp: '',
				uuid: `grok-msg-${messageIndex++}`,
			});
			continue;
		}

		if (record.type === 'assistant') {
			const text = typeof record.content === 'string' ? record.content : '';
			const toolUse = buildToolUse(record.tool_calls);
			if (!text.trim() && !toolUse) continue;
			if (text.trim()) firstAssistantMessage ||= text;
			if (toolUse) {
				let entryIndex = 0;
				for (const call of record.tool_calls || []) {
					if (!call.name) continue;
					if (call.id) {
						pendingToolCalls.set(call.id, { messageIndex: messages.length, entryIndex });
					}
					entryIndex++;
				}
			}
			messages.push({
				type: 'assistant',
				role: 'assistant',
				content: text,
				timestamp: '',
				uuid: `grok-msg-${messageIndex++}`,
				toolUse,
			});
			continue;
		}

		if (record.type === 'tool_result') {
			const output = typeof record.content === 'string' ? record.content : '';
			const callId = record.tool_call_id;
			const target = callId ? pendingToolCalls.get(callId) : undefined;
			if (target && callId) {
				const entries = messages[target.messageIndex].toolUse as GrokToolUseEntry[];
				const entry = entries[target.entryIndex];
				entries[target.entryIndex] = {
					...entry,
					state: { ...entry.state, status: 'completed', output },
				};
				pendingToolCalls.delete(callId);
			} else if (output.trim()) {
				// No matching tool call — surface the result as a standalone message.
				messages.push({
					type: 'assistant',
					role: 'assistant',
					content: output,
					timestamp: '',
					uuid: `grok-msg-${messageIndex++}`,
				});
			}
			continue;
		}

		// `system` and `reasoning` records carry no user-visible conversation content.
	}

	return { messages, firstUserMessage, firstAssistantMessage };
}

/**
 * Session storage implementation for Grok CLI.
 *
 * Reads session metadata from `~/.grok/sessions/<encoded-cwd>/<sessionId>/summary.json`
 * and conversation history from `chat_history.jsonl`. Supports both local and
 * SSH remote access. The derived `session_search.sqlite` index is intentionally
 * ignored — the transcript files are authoritative.
 */
export class GrokSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'grok';

	/** Resolve the sessions base directory (local or remote POSIX tilde form). */
	private getSessionsDir(sshConfig?: SshRemoteConfig): string {
		return sshConfig ? '~/.grok/sessions' : getLocalGrokSessionsDir();
	}

	/** Join path segments with the separator style matching local vs remote access. */
	private joinPath(sshConfig: SshRemoteConfig | undefined, ...segments: string[]): string {
		return sshConfig ? path.posix.join(...segments) : path.join(...segments);
	}

	/** Decode a percent-encoded cwd folder name. Returns null for malformed encodings. */
	private decodeCwdFolder(name: string): string | null {
		try {
			return decodeURIComponent(name);
		} catch {
			return null;
		}
	}

	/** List subdirectory names of a directory, locally or over SSH. Missing directories yield []. */
	private async listSubdirectories(
		dirPath: string,
		sshConfig: SshRemoteConfig | undefined,
		operation: string
	): Promise<string[]> {
		if (sshConfig) {
			const result = await readDirRemote(dirPath, sshConfig);
			if (!result.success || !result.data) {
				if (!isExpectedRemoteError(result.error)) {
					logger.warn(`Unexpected SSH failure listing ${dirPath}: ${result.error}`, LOG_CONTEXT);
					captureException(new Error(result.error || 'readDirRemote failed'), {
						operation,
						dirPath,
					});
				}
				return [];
			}
			return result.data.filter((entry) => entry.isDirectory).map((entry) => entry.name);
		}

		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true });
			return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
				captureException(error, { operation, dirPath });
			}
			return [];
		}
	}

	/**
	 * List cwd folders under the sessions directory whose decoded name matches
	 * the project path. Filtering on folder names avoids opening any session
	 * file for non-matching projects.
	 */
	private async listMatchingCwdFolders(
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<string[]> {
		const folders = await this.listSubdirectories(
			this.getSessionsDir(sshConfig),
			sshConfig,
			'grokStorage:listCwdFolders'
		);
		return folders.filter((name) => {
			const decoded = this.decodeCwdFolder(name);
			return decoded !== null && matchesProject(decoded, projectPath);
		});
	}

	/** List session UUID directories inside a cwd folder (skips prompt_history.jsonl, a file). */
	private async listSessionIds(cwdFolder: string, sshConfig?: SshRemoteConfig): Promise<string[]> {
		return this.listSubdirectories(
			this.joinPath(sshConfig, this.getSessionsDir(sshConfig), cwdFolder),
			sshConfig,
			'grokStorage:listSessionIds'
		);
	}

	/** List all Grok sessions matching the given project path, newest first. */
	async listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		const cwdFolders = await this.listMatchingCwdFolders(projectPath, sshConfig);

		const sessionRefs: Array<{ cwdFolder: string; sessionId: string }> = [];
		for (const cwdFolder of cwdFolders) {
			const sessionIds = await this.listSessionIds(cwdFolder, sshConfig);
			for (const sessionId of sessionIds) {
				sessionRefs.push({ cwdFolder, sessionId });
			}
		}

		// Bound the per-session fan-out: over SSH so many sessions don't burst
		// past sshd's MaxStartups connection cap, and locally so a large
		// ~/.grok/sessions folder doesn't open hundreds of transcripts at once.
		const sessions = await mapWithConcurrency(
			sessionRefs,
			sshConfig ? REMOTE_SESSION_READ_CONCURRENCY : LOCAL_SESSION_READ_CONCURRENCY,
			(ref) => this.loadSessionInfo(ref.cwdFolder, ref.sessionId, sshConfig)
		);

		return sessions
			.filter((session): session is AgentSessionInfo => session !== null)
			.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
	}

	/** Load metadata and transcript-derived info for a single session. */
	private async loadSessionInfo(
		cwdFolder: string,
		sessionId: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo | null> {
		const sessionDir = this.joinPath(
			sshConfig,
			this.getSessionsDir(sshConfig),
			cwdFolder,
			sessionId
		);
		try {
			const summaryContent = await this.readSessionFile(
				this.joinPath(sshConfig, sessionDir, 'summary.json'),
				sshConfig
			);
			if (!summaryContent) return null;

			let summary: GrokSessionSummary;
			try {
				summary = JSON.parse(summaryContent) as GrokSessionSummary;
			} catch {
				logger.debug(`Skipping Grok session ${sessionId} with malformed summary.json`, LOG_CONTEXT);
				return null;
			}

			const transcript = await this.readTranscript(sessionDir, sshConfig);
			if (!transcript) return null;

			const parsed = parseChatHistory(transcript.content);
			if (parsed.messages.length === 0) {
				// Never-prompted sessions exist on disk with only system/synthetic records.
				logger.debug(
					`Skipping Grok session ${sessionId} with no conversation messages`,
					LOG_CONTEXT
				);
				return null;
			}

			const title = summary.session_summary || summary.generated_title || '';
			const fileMtime = new Date(transcript.mtimeMs).toISOString();
			const timestamp = summary.created_at || fileMtime;
			const modifiedAt = summary.updated_at || fileMtime;
			const createdMs = Date.parse(timestamp);
			const modifiedMs = Date.parse(modifiedAt);
			const durationSeconds =
				Number.isFinite(createdMs) && Number.isFinite(modifiedMs)
					? Math.max(0, Math.floor((modifiedMs - createdMs) / 1000))
					: 0;
			const preview = parsed.firstUserMessage || parsed.firstAssistantMessage || title;

			return {
				sessionId: summary.info?.id || sessionId,
				projectPath: summary.info?.cwd || this.decodeCwdFolder(cwdFolder) || '',
				timestamp,
				modifiedAt,
				firstMessage: preview.slice(0, FIRST_MESSAGE_PREVIEW_LENGTH),
				messageCount: parsed.messages.length,
				sizeBytes: transcript.size,
				// Grok transcripts carry no token counts; report zeros rather than
				// fabricating values from the auxiliary event files.
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				durationSeconds,
				sessionName: title || undefined,
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
				logger.debug(`Expected failure loading Grok session ${sessionId}: ${code}`, LOG_CONTEXT);
			} else {
				logger.warn(`Unexpected failure loading Grok session ${sessionId}`, LOG_CONTEXT, {
					error,
				});
				captureException(error, { operation: 'grokStorage:loadSessionInfo', sessionId });
			}
			return null;
		}
	}

	/**
	 * Locate a session's directory by scanning the cwd folders that match the
	 * project. Doubles as the ownership guard: sessions outside matching
	 * folders never resolve, so their content is never returned.
	 */
	private async findSessionDir(
		projectPath: string,
		sessionId: string,
		sshConfig?: SshRemoteConfig
	): Promise<string | null> {
		const cwdFolders = await this.listMatchingCwdFolders(projectPath, sshConfig);
		for (const cwdFolder of cwdFolders) {
			const sessionIds = await this.listSessionIds(cwdFolder, sshConfig);
			if (sessionIds.includes(sessionId)) {
				return this.joinPath(sshConfig, this.getSessionsDir(sshConfig), cwdFolder, sessionId);
			}
		}
		return null;
	}

	/** Read messages from a Grok session's chat_history.jsonl file. */
	async readSessionMessages(
		projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		const sessionDir = await this.findSessionDir(projectPath, sessionId, sshConfig);
		if (!sessionDir) {
			logger.warn(`Grok session not found for project: ${sessionId}`, LOG_CONTEXT);
			return { messages: [], total: 0, hasMore: false };
		}

		const transcript = await this.readTranscript(sessionDir, sshConfig);
		if (!transcript) {
			return { messages: [], total: 0, hasMore: false };
		}

		const { messages } = parseChatHistory(transcript.content);
		return BaseSessionStorage.applyMessagePagination(messages, options);
	}

	/** Get searchable user/assistant messages for session search. */
	protected async getSearchableMessages(
		sessionId: string,
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		const sessionDir = await this.findSessionDir(projectPath, sessionId, sshConfig);
		if (!sessionDir) return [];

		const transcript = await this.readTranscript(sessionDir, sshConfig);
		if (!transcript) return [];

		return parseChatHistory(transcript.content)
			.messages.filter((message) => message.role === 'user' || message.role === 'assistant')
			.map((message) => ({
				role: message.role as 'user' | 'assistant',
				textContent: message.content,
			}))
			.filter((message) => message.textContent.trim().length > 0);
	}

	/**
	 * Get the filesystem path to a session's chat_history.jsonl file.
	 *
	 * Best-effort synchronous guess (matches sibling behavior): the project
	 * path is first mapped to the realpath'd cwd form Grok records (macOS
	 * `/var|/tmp|/etc` -> `/private/...`) so the local path agrees with what
	 * listSessions() finds. Over SSH the remote OS is unknown, so the path is
	 * encoded as given and may miss symlink-resolved variants.
	 */
	getSessionPath(
		projectPath: string,
		sessionId: string,
		sshConfig?: SshRemoteConfig
	): string | null {
		const encoded = encodeURIComponent(toGrokRecordedCwd(projectPath, Boolean(sshConfig)));
		return this.joinPath(
			sshConfig,
			this.getSessionsDir(sshConfig),
			encoded,
			sessionId,
			'chat_history.jsonl'
		);
	}

	/**
	 * Delete a message pair. Not supported for Grok sessions: editing
	 * chat_history.jsonl would desync summary.json counts, events.jsonl, and
	 * the sqlite FTS index the live Grok leader process maintains.
	 */
	async deleteMessagePair(
		_projectPath: string,
		_sessionId: string,
		_userMessageUuid: string,
		_fallbackContent?: string,
		_sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		return {
			success: false,
			error: 'Deleting Grok session history is not supported.',
		};
	}

	/** Read a session's transcript with a size cap, returning content plus file stats. */
	private async readTranscript(
		sessionDir: string,
		sshConfig?: SshRemoteConfig
	): Promise<{ content: string; size: number; mtimeMs: number } | null> {
		const transcriptPath = this.joinPath(sshConfig, sessionDir, 'chat_history.jsonl');

		const stat = await this.statSessionFile(transcriptPath, sshConfig);
		if (!stat) return null;
		if (stat.size > MAX_SESSION_FILE_SIZE) {
			logger.warn('Skipping oversized Grok session transcript', LOG_CONTEXT, {
				transcriptPath,
				size: stat.size,
			});
			return null;
		}

		const content = await this.readSessionFile(transcriptPath, sshConfig);
		if (!content?.trim()) return null;
		return { content, size: stat.size, mtimeMs: stat.mtimeMs };
	}

	/** Stat a file locally or over SSH. Returns null on missing/unreadable files. */
	private async statSessionFile(
		filePath: string,
		sshConfig?: SshRemoteConfig
	): Promise<{ size: number; mtimeMs: number } | null> {
		if (sshConfig) {
			const result = await statRemote(filePath, sshConfig);
			if (!result.success || !result.data) {
				if (!isExpectedRemoteError(result.error)) {
					logger.warn(`Unexpected SSH failure stating ${filePath}: ${result.error}`, LOG_CONTEXT);
				}
				return null;
			}
			return { size: result.data.size, mtimeMs: result.data.mtime };
		}

		try {
			const stat = await fs.stat(filePath);
			return { size: stat.size, mtimeMs: stat.mtimeMs };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
				captureException(error, { operation: 'grokStorage:statSessionFile', filePath });
			}
			return null;
		}
	}

	/** Read a file locally or over SSH. Returns null on missing/unreadable files; reports unexpected failures. */
	private async readSessionFile(
		filePath: string,
		sshConfig?: SshRemoteConfig
	): Promise<string | null> {
		if (sshConfig) {
			const result = await readFileRemote(filePath, sshConfig);
			if (result.success && result.data != null) return result.data;
			if (!isExpectedRemoteError(result.error)) {
				logger.warn(`Unexpected SSH failure reading ${filePath}: ${result.error}`, LOG_CONTEXT);
				captureException(new Error(result.error || 'readFileRemote failed'), {
					operation: 'grokStorage:readSessionFile',
					filePath,
				});
			}
			return null;
		}

		try {
			return await fs.readFile(filePath, 'utf8');
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
				captureException(error, { operation: 'grokStorage:readSessionFile', filePath });
			}
			return null;
		}
	}
}
