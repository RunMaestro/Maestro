import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { readFileRemote, readDirRemote, directorySizeRemote } from '../utils/remote-fs';
import type {
	AgentSessionInfo,
	SessionMessagesResult,
	SessionReadOptions,
	SessionMessage,
} from '../agents';
import type { ToolType, SshRemoteConfig } from '../../shared/types';
import { BaseSessionStorage } from './base-session-storage';
import type { SearchableMessage } from './base-session-storage';

const LOG_CONTEXT = '[CopilotSessionStorage]';

/** Resolve the local Copilot session state directory, respecting COPILOT_CONFIG_DIR. */
function getLocalCopilotSessionStateDir(): string {
	const configDir = process.env.COPILOT_CONFIG_DIR || path.join(os.homedir(), '.copilot');
	return path.join(configDir, 'session-state');
}

interface CopilotWorkspaceMetadata {
	id: string;
	cwd?: string;
	git_root?: string;
	repository?: string;
	branch?: string;
	summary?: string;
	created_at?: string;
	updated_at?: string;
}

interface CopilotToolRequest {
	toolCallId?: string;
	name?: string;
	arguments?: unknown;
}

interface CopilotSessionStats {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	durationSeconds: number;
}

interface ParsedCopilotSessionData {
	messages: SessionMessage[];
	firstAssistantMessage: string;
	firstUserMessage: string;
	stats: CopilotSessionStats;
	parsedEventCount: number;
	malformedEventCount: number;
	hasMeaningfulContent: boolean;
}

interface CopilotEvent {
	type?: string;
	id?: string;
	timestamp?: string;
	usage?: {
		sessionDurationMs?: number;
	};
	data?: {
		content?: string;
		toolRequests?: CopilotToolRequest[];
		sessionDurationMs?: number;
		modelMetrics?: Record<
			string,
			{
				usage?: {
					inputTokens?: number;
					outputTokens?: number;
					cacheReadTokens?: number;
					cacheWriteTokens?: number;
				};
			}
		>;
	};
}

/** Strip surrounding quotes and unescape common YAML sequences in scalar values. */
function normalizeYamlScalar(value: string): string {
	let trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		const inner = trimmed.slice(1, -1);
		// Unescape common sequences within double-quoted scalars
		return trimmed.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
	}

	const inlineCommentIndex = trimmed.search(/\s+#/);
	if (inlineCommentIndex >= 0) {
		trimmed = trimmed.slice(0, inlineCommentIndex).trim();
	}

	return trimmed;
}

const WORKSPACE_METADATA_KEYS = new Set<keyof CopilotWorkspaceMetadata>([
	'id',
	'cwd',
	'git_root',
	'repository',
	'branch',
	'summary',
	'created_at',
	'updated_at',
]);

/** Normalize a workspace metadata key from camelCase/kebab-case to the canonical snake_case form. */
function normalizeWorkspaceMetadataKey(key: string): keyof CopilotWorkspaceMetadata | null {
	const normalized = key
		.trim()
		.replace(/-/g, '_')
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.toLowerCase();

	return WORKSPACE_METADATA_KEYS.has(normalized as keyof CopilotWorkspaceMetadata)
		? (normalized as keyof CopilotWorkspaceMetadata)
		: null;
}

/** Parse workspace.yaml content into typed metadata, tolerating format variations. */
function parseWorkspaceMetadata(content: string, sessionId: string): CopilotWorkspaceMetadata {
	const metadata: CopilotWorkspaceMetadata = { id: sessionId };

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#') || line === '---' || line === '...') continue;

		const match = rawLine.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (!match) continue;

		const key = normalizeWorkspaceMetadataKey(match[1]);
		if (!key) continue;

		const value = normalizeYamlScalar(match[2]);
		if (!value) continue;

		metadata[key] = value;
	}

	return metadata;
}

/** Normalize a filesystem path for cross-platform comparison. Case-folds Windows-style paths (drive letter prefix). */
function normalizePath(value?: string): string | null {
	if (!value) return null;
	let normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
	// Preserve POSIX root "/" — stripping its trailing slash would produce ""
	if (!normalized && value === '/') normalized = '/';
	// Case-fold Windows-style paths (e.g., C:/Users) for case-insensitive comparison
	if (/^[A-Za-z]:/.test(normalized)) {
		normalized = normalized.toLowerCase();
	}
	return normalized;
}

/** Check whether session metadata matches the given project path. */
function matchesProject(metadata: CopilotWorkspaceMetadata, projectPath: string): boolean {
	const normalizedProject = normalizePath(projectPath);
	const gitRoot = normalizePath(metadata.git_root);
	const cwd = normalizePath(metadata.cwd);

	if (!normalizedProject) return true;
	return (
		gitRoot === normalizedProject ||
		cwd === normalizedProject ||
		cwd?.startsWith(`${normalizedProject}/`) === true
	);
}

/** Convert Copilot tool requests into a normalized tool-use structure. */
function buildToolUse(toolRequests?: CopilotToolRequest[]): unknown {
	if (!toolRequests?.length) return undefined;
	const toolUse = toolRequests
		.filter((tool) => tool.name)
		.map((tool) => ({
			name: tool.name,
			id: tool.toolCallId,
			input: tool.arguments,
		}));
	return toolUse.length > 0 ? toolUse : undefined;
}

/** Parse events.jsonl content into messages, statistics, and content indicators. */
function parseEvents(content: string): ParsedCopilotSessionData {
	const messages: SessionMessage[] = [];
	let firstAssistantMessage = '';
	let firstUserMessage = '';
	let parsedEventCount = 0;
	let malformedEventCount = 0;
	const stats: CopilotSessionStats = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 0,
	};

	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;

		try {
			const entry = JSON.parse(line) as CopilotEvent;
			parsedEventCount += 1;

			if (entry.type === 'user.message') {
				const contentText = entry.data?.content || '';
				if (contentText.trim()) {
					firstUserMessage ||= contentText;
					messages.push({
						type: 'user',
						role: 'user',
						content: contentText,
						timestamp: entry.timestamp || '',
						uuid: entry.id || `copilot-user-${messages.length}`,
					});
				}
				continue;
			}

			if (entry.type === 'assistant.message') {
				const contentText = entry.data?.content || '';
				const toolUse = buildToolUse(entry.data?.toolRequests);
				if (contentText.trim() || toolUse) {
					firstAssistantMessage ||= contentText;
					messages.push({
						type: 'assistant',
						role: 'assistant',
						content: contentText,
						timestamp: entry.timestamp || '',
						uuid: entry.id || `copilot-assistant-${messages.length}`,
						toolUse,
					});
				}
				continue;
			}

			if (entry.type === 'session.shutdown') {
				const modelMetrics = entry.data?.modelMetrics || {};
				for (const metric of Object.values(modelMetrics)) {
					stats.inputTokens += metric.usage?.inputTokens || 0;
					stats.outputTokens += metric.usage?.outputTokens || 0;
					stats.cacheReadTokens += metric.usage?.cacheReadTokens || 0;
					stats.cacheCreationTokens += metric.usage?.cacheWriteTokens || 0;
				}
				if (entry.data?.sessionDurationMs) {
					stats.durationSeconds = Math.max(0, Math.floor(entry.data.sessionDurationMs / 1000));
				}
				continue;
			}

			if (entry.type === 'result' && entry.usage?.sessionDurationMs) {
				stats.durationSeconds = Math.max(0, Math.floor(entry.usage.sessionDurationMs / 1000));
			}
		} catch {
			malformedEventCount += 1;
			// Ignore malformed lines so a single bad event does not hide the whole session.
		}
	}

	const hasMeaningfulContent =
		messages.length > 0 ||
		stats.inputTokens > 0 ||
		stats.outputTokens > 0 ||
		stats.cacheReadTokens > 0 ||
		stats.cacheCreationTokens > 0 ||
		stats.durationSeconds > 0;

	return {
		messages,
		firstAssistantMessage,
		firstUserMessage,
		stats,
		parsedEventCount,
		malformedEventCount,
		hasMeaningfulContent,
	};
}

/** Recursively calculate the total size of a local directory in bytes. */
async function getLocalDirectorySize(sessionDir: string): Promise<number> {
	try {
		const entries = await fs.readdir(sessionDir, { withFileTypes: true });
		let total = 0;
		for (const entry of entries) {
			const entryPath = path.join(sessionDir, entry.name);
			if (entry.isDirectory()) {
				total += await getLocalDirectorySize(entryPath);
			} else {
				const stat = await fs.stat(entryPath);
				total += stat.size;
			}
		}
		return total;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
			return 0;
		}
		captureException(error, { operation: 'copilotStorage:getLocalDirectorySize', sessionDir });
		return 0;
	}
}

/**
 * Session storage implementation for GitHub Copilot CLI.
 *
 * Reads session metadata from `~/.copilot/session-state/<sessionId>/workspace.yaml`
 * and conversation history from `events.jsonl`. Supports both local and SSH remote access.
 */
export class CopilotSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'copilot';

	/** Remote session state directory path using POSIX tilde expansion. */
	private getRemoteSessionStateDir(): string {
		return '~/.copilot/session-state';
	}

	/** Resolve the session state base directory (local or remote). */
	private getSessionStateDir(sshConfig?: SshRemoteConfig): string {
		return sshConfig ? this.getRemoteSessionStateDir() : getLocalCopilotSessionStateDir();
	}

	/** Resolve the directory path for a specific session. */
	private getSessionDir(sessionId: string, sshConfig?: SshRemoteConfig): string {
		return sshConfig
			? path.posix.join(this.getRemoteSessionStateDir(), sessionId)
			: path.join(getLocalCopilotSessionStateDir(), sessionId);
	}

	/** Resolve the workspace.yaml path for a specific session. */
	private getWorkspacePath(sessionId: string, sshConfig?: SshRemoteConfig): string {
		return sshConfig
			? path.posix.join(this.getSessionDir(sessionId, sshConfig), 'workspace.yaml')
			: path.join(this.getSessionDir(sessionId), 'workspace.yaml');
	}

	/** Resolve the events.jsonl path for a specific session. */
	private getEventsPath(sessionId: string, sshConfig?: SshRemoteConfig): string {
		return sshConfig
			? path.posix.join(this.getSessionDir(sessionId, sshConfig), 'events.jsonl')
			: path.join(this.getSessionDir(sessionId), 'events.jsonl');
	}

	/** List all Copilot sessions matching the given project path. */
	async listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		const sessionIds = await this.listSessionIds(sshConfig);
		const sessions = await Promise.all(
			sessionIds.map((sessionId) => this.loadSessionInfo(projectPath, sessionId, sshConfig))
		);

		return sessions
			.filter((session): session is AgentSessionInfo => session !== null)
			.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
	}

	/** Read messages from a Copilot session's events.jsonl file. */
	async readSessionMessages(
		_projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		// Guard: verify session belongs to the requested project before returning content
		if (!(await this.sessionMatchesProject(sessionId, _projectPath, sshConfig))) {
			return { messages: [], total: 0, hasMore: false };
		}

		const eventsContent = await this.readEventsFile(sessionId, sshConfig);
		if (!eventsContent) {
			return { messages: [], total: 0, hasMore: false };
		}

		const { messages } = parseEvents(eventsContent);
		return BaseSessionStorage.applyMessagePagination(messages, options);
	}

	/** Get searchable user/assistant messages for session search. */
	protected async getSearchableMessages(
		sessionId: string,
		_projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		// Guard: verify session belongs to the requested project before returning content
		if (!(await this.sessionMatchesProject(sessionId, _projectPath, sshConfig))) {
			return [];
		}

		const eventsContent = await this.readEventsFile(sessionId, sshConfig);
		if (!eventsContent) {
			return [];
		}

		return parseEvents(eventsContent)
			.messages.filter((message) => message.role === 'user' || message.role === 'assistant')
			.map((message) => ({
				role: message.role as 'user' | 'assistant',
				textContent: message.content,
			}))
			.filter((message) => message.textContent.trim().length > 0);
	}

	/** Get the filesystem path to a session's events.jsonl file. */
	getSessionPath(
		_projectPath: string,
		sessionId: string,
		sshConfig?: SshRemoteConfig
	): string | null {
		return this.getEventsPath(sessionId, sshConfig);
	}

	/** Delete a message pair. Not supported for Copilot sessions. */
	async deleteMessagePair(
		_projectPath: string,
		_sessionId: string,
		_userMessageUuid: string,
		_fallbackContent?: string,
		_sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		return {
			success: false,
			error: 'Deleting Copilot session history is not supported.',
		};
	}

	/** Check whether a session belongs to the given project. Returns true if ownership cannot be determined (fail-open for missing metadata). */
	private async sessionMatchesProject(
		sessionId: string,
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<boolean> {
		try {
			const workspacePath = this.getWorkspacePath(sessionId, sshConfig);
			const workspaceContent = sshConfig
				? await this.readRemoteFile(workspacePath, sshConfig)
				: await fs.readFile(workspacePath, 'utf8');
			if (!workspaceContent) return false; // No metadata → can't verify ownership, fail-closed
			const metadata = parseWorkspaceMetadata(workspaceContent, sessionId);
			return matchesProject(metadata, projectPath);
		} catch {
			return false; // Missing/unreadable metadata → fail-closed
		}
	}

	/** Check if a remote-fs error indicates a benign not-found/permission case vs an unexpected SSH failure. */
	private isExpectedRemoteError(error?: string): boolean {
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

	/** List all session directory names from the session state directory. */
	private async listSessionIds(sshConfig?: SshRemoteConfig): Promise<string[]> {
		const sessionStateDir = this.getSessionStateDir(sshConfig);
		if (sshConfig) {
			const result = await readDirRemote(sessionStateDir, sshConfig);
			if (!result.success || !result.data) {
				if (!this.isExpectedRemoteError(result.error)) {
					logger.warn(
						`Unexpected SSH failure listing Copilot sessions: ${result.error}`,
						LOG_CONTEXT
					);
					captureException(new Error(result.error || 'readDirRemote failed'), {
						operation: 'copilotStorage:listSessionIds:remote',
						sessionStateDir,
					});
				}
				return [];
			}
			return result.data.filter((entry) => entry.isDirectory).map((entry) => entry.name);
		}

		try {
			const entries = await fs.readdir(sessionStateDir, { withFileTypes: true });
			return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
				return [];
			}
			captureException(error, { operation: 'copilotStorage:listSessionIds' });
			return [];
		}
	}

	/** Load session metadata and event statistics for a single session. Returns null if the session doesn't match the project or lacks meaningful content. */
	private async loadSessionInfo(
		projectPath: string,
		sessionId: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo | null> {
		const sessionDir = this.getSessionDir(sessionId, sshConfig);
		const workspacePath = this.getWorkspacePath(sessionId, sshConfig);
		try {
			const workspaceContent = sshConfig
				? await this.readRemoteFile(workspacePath, sshConfig)
				: await fs.readFile(workspacePath, 'utf8');
			if (!workspaceContent) {
				return null;
			}

			const metadata = parseWorkspaceMetadata(workspaceContent, sessionId);

			if (!matchesProject(metadata, projectPath)) {
				return null;
			}

			const eventsContent = await this.readEventsFile(sessionId, sshConfig);
			if (!eventsContent?.trim()) {
				logger.debug(`Skipping Copilot session ${sessionId} with empty events log`, LOG_CONTEXT);
				return null;
			}

			const parsedEvents = parseEvents(eventsContent);
			if (!parsedEvents.hasMeaningfulContent) {
				logger.debug(
					`Skipping Copilot session ${sessionId} without meaningful event content`,
					LOG_CONTEXT,
					{
						parsedEventCount: parsedEvents.parsedEventCount,
						malformedEventCount: parsedEvents.malformedEventCount,
					}
				);
				return null;
			}

			const sizeBytes = sshConfig
				? await this.getRemoteDirectorySize(sessionDir, sshConfig)
				: await getLocalDirectorySize(sessionDir);
			const projectRoot = metadata.git_root || metadata.cwd || projectPath;

			// Prefer metadata timestamps; fall back to workspace file mtime (local only)
			// before using current time as a last resort.
			let fallbackTimestamp: string | undefined;
			if (!metadata.created_at && !metadata.updated_at && !sshConfig) {
				try {
					const workspaceStat = await fs.stat(workspacePath);
					fallbackTimestamp = new Date(workspaceStat.mtimeMs).toISOString();
				} catch {
					// stat failure is non-critical
				}
			}
			const timestamp =
				metadata.created_at || metadata.updated_at || fallbackTimestamp || new Date().toISOString();
			const modifiedAt = metadata.updated_at || timestamp;
			const preview =
				parsedEvents.firstAssistantMessage ||
				parsedEvents.firstUserMessage ||
				metadata.summary ||
				'Copilot session';

			return {
				sessionId: metadata.id,
				projectPath: projectRoot,
				timestamp,
				modifiedAt,
				firstMessage: preview.slice(0, 200),
				messageCount: parsedEvents.messages.length,
				sizeBytes,
				inputTokens: parsedEvents.stats.inputTokens,
				outputTokens: parsedEvents.stats.outputTokens,
				cacheReadTokens: parsedEvents.stats.cacheReadTokens,
				cacheCreationTokens: parsedEvents.stats.cacheCreationTokens,
				durationSeconds: parsedEvents.stats.durationSeconds,
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
				logger.debug(`Expected failure loading Copilot session ${sessionId}: ${code}`, LOG_CONTEXT);
			} else {
				logger.warn(`Unexpected failure loading Copilot session ${sessionId}`, LOG_CONTEXT, {
					error,
				});
				captureException(error, { operation: 'copilotStorage:loadSessionInfo', sessionId });
			}
			return null;
		}
	}

	/** Read the events.jsonl file content for a session. Returns null on missing/unreadable files. */
	private async readEventsFile(
		sessionId: string,
		sshConfig?: SshRemoteConfig
	): Promise<string | null> {
		const eventsPath = this.getEventsPath(sessionId, sshConfig);

		try {
			return sshConfig
				? await this.readRemoteFile(eventsPath, sshConfig)
				: await fs.readFile(eventsPath, 'utf8');
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
				return null;
			}
			captureException(error, { operation: 'copilotStorage:readEventsFile', sessionId });
			return null;
		}
	}

	/** Read a file from a remote host via SSH. Returns null on not-found; reports unexpected failures to Sentry. */
	private async readRemoteFile(
		filePath: string,
		sshConfig: SshRemoteConfig
	): Promise<string | null> {
		const result = await readFileRemote(filePath, sshConfig);
		if (result.success && result.data != null) return result.data;
		if (!this.isExpectedRemoteError(result.error)) {
			logger.warn(`Unexpected SSH failure reading ${filePath}: ${result.error}`, LOG_CONTEXT);
			captureException(new Error(result.error || 'readFileRemote failed'), {
				operation: 'copilotStorage:readRemoteFile',
				filePath,
			});
		}
		return null;
	}

	/** Calculate the total size of a session directory on a remote host. Returns 0 on not-found; reports unexpected failures. */
	private async getRemoteDirectorySize(
		sessionDir: string,
		sshConfig: SshRemoteConfig
	): Promise<number> {
		const result = await directorySizeRemote(sessionDir, sshConfig);
		if (result.success && result.data != null) return result.data;
		if (!this.isExpectedRemoteError(result.error)) {
			logger.warn(`Unexpected SSH failure sizing ${sessionDir}: ${result.error}`, LOG_CONTEXT);
			captureException(new Error(result.error || 'directorySizeRemote failed'), {
				operation: 'copilotStorage:getRemoteDirectorySize',
				sessionDir,
			});
		}
		return 0;
	}
}
