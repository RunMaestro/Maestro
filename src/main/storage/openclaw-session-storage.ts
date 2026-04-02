/**
 * OpenClaw Session Storage Implementation
 *
 * This module implements the AgentSessionStorage interface for OpenClaw.
 * OpenClaw stores sessions as JSONL files under:
 * ~/.openclaw/.openclaw/agents/{agent-name}/sessions/
 *
 * Directory structure:
 * - ~/.openclaw/.openclaw/agents/{agent-name}/sessions/sessions.json - Session index (not required for basic parsing)
 * - ~/.openclaw/.openclaw/agents/{agent-name}/sessions/{uuid}.jsonl - Message history
 *
 * JSONL format:
 * - Session init line:
 *   {"type":"session","version":3,"id":"uuid","timestamp":"ISO","cwd":"/path"}
 * - Message line:
 *   {"type":"message","id":"...","parentId":"...","timestamp":"...","message":{"role":"user"|"assistant","content":[{"type":"text","text":"..."}]}}
 * - Other line types:
 *   model_change, thinking_level_change, custom, toolResult
 */

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { readDirRemote, readFileRemote, statRemote } from '../utils/remote-fs';
import { BaseSessionStorage, type SearchableMessage } from './base-session-storage';
import type {
	AgentSessionInfo,
	SessionMessagesResult,
	SessionReadOptions,
	SessionMessage,
} from '../agents';
import type { ToolType, SshRemoteConfig } from '../../shared/types';

const LOG_CONTEXT = '[OpenClawSessionStorage]';

/**
 * Get OpenClaw storage base directory
 * - All platforms: ~/.openclaw/.openclaw/agents
 */
function getOpenClawSessionsDir(): string {
	return path.join(os.homedir(), '.openclaw', '.openclaw', 'agents');
}

const OPENCLAW_AGENTS_DIR = getOpenClawSessionsDir();
const OPENCLAW_REMOTE_AGENTS_DIR = '~/.openclaw/.openclaw/agents';

/**
 * OpenClaw message content structure
 */
interface OpenClawContentItem {
	type?: string;
	text?: string;
	[key: string]: unknown;
}

/**
 * OpenClaw session init structure
 */
interface OpenClawSessionInit {
	type: 'session';
	version?: number;
	id?: string;
	timestamp?: string;
	cwd?: string;
}

/**
 * OpenClaw message structure from JSONL
 */
interface OpenClawMessage {
	type: 'message';
	id: string;
	parentId?: string;
	timestamp: string;
	message: {
		role: 'user' | 'assistant';
		content: OpenClawContentItem[] | string;
	};
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

function extractTextFromContent(content: OpenClawContentItem[] | string | unknown): string {
	if (typeof content === 'string') {
		return content;
	}

	if (Array.isArray(content)) {
		return content
			.filter((c) => c && typeof c === 'object' && (c as OpenClawContentItem).type === 'text')
			.map((c) => (c as OpenClawContentItem).text || '')
			.join(' ')
			.trim();
	}

	return '';
}

function buildCompositeSessionId(agentName: string, sessionId: string): string {
	return `${agentName}:${sessionId}`;
}

function parseCompositeSessionId(
	compositeSessionId: string
): { agentName: string; sessionId: string } | null {
	const idx = compositeSessionId.indexOf(':');
	if (idx <= 0 || idx >= compositeSessionId.length - 1) {
		return null;
	}
	return {
		agentName: compositeSessionId.slice(0, idx),
		sessionId: compositeSessionId.slice(idx + 1),
	};
}

/**
 * OpenClaw Session Storage Implementation
 *
 * Provides access to OpenClaw's session storage at ~/.openclaw/.openclaw/agents/
 */
export class OpenClawSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'openclaw';

	/**
	 * Get session file path for a given OpenClaw agent name and session ID
	 */
	private getLocalSessionFile(agentName: string, sessionId: string): string {
		return path.join(OPENCLAW_AGENTS_DIR, agentName, 'sessions', `${sessionId}.jsonl`);
	}

	/**
	 * Get remote session file path for a given OpenClaw agent name and session ID
	 */
	private getRemoteSessionFile(agentName: string, sessionId: string): string {
		return `${OPENCLAW_REMOTE_AGENTS_DIR}/${agentName}/sessions/${sessionId}.jsonl`;
	}

	/**
	 * Load and parse messages from a session JSONL file
	 */
	private async loadSessionMessages(sessionPath: string): Promise<OpenClawMessage[]> {
		try {
			const content = await fs.readFile(sessionPath, 'utf-8');
			const lines = content
				.trim()
				.split('\n')
				.filter((l) => l.trim());
			const messages: OpenClawMessage[] = [];

			for (const line of lines) {
				try {
					const parsed = JSON.parse(line);
					if (parsed.type === 'message' && parsed.message) {
						messages.push(parsed as OpenClawMessage);
					}
				} catch (error) {
					logger.debug('Skipping unparseable OpenClaw JSONL line', LOG_CONTEXT, { error });
				}
			}

			return messages;
		} catch (error) {
			logger.debug(`Failed to load OpenClaw session messages: ${sessionPath}`, LOG_CONTEXT, {
				error,
			});
			return [];
		}
	}

	/**
	 * Load and parse messages from a remote session JSONL file via SSH
	 */
	private async loadSessionMessagesRemote(
		sessionPath: string,
		sshConfig: SshRemoteConfig
	): Promise<OpenClawMessage[]> {
		try {
			const result = await readFileRemote(sessionPath, sshConfig);
			if (!result.success || !result.data) {
				logger.debug(
					`Failed to load remote OpenClaw session messages: ${sessionPath} - ${result.error}`,
					LOG_CONTEXT
				);
				return [];
			}

			const lines = result.data
				.trim()
				.split('\n')
				.filter((l) => l.trim());
			const messages: OpenClawMessage[] = [];

			for (const line of lines) {
				try {
					const parsed = JSON.parse(line);
					if (parsed.type === 'message' && parsed.message) {
						messages.push(parsed as OpenClawMessage);
					}
				} catch (error) {
					logger.debug('Skipping unparseable OpenClaw JSONL line (remote)', LOG_CONTEXT, { error });
				}
			}

			return messages;
		} catch (error) {
			logger.debug(`Failed to load remote OpenClaw session messages: ${sessionPath}`, LOG_CONTEXT, {
				error,
			});
			return [];
		}
	}

	/**
	 * Parse OpenClaw session file to extract metadata (session init + first message + counts)
	 */
	private async parseOpenClawSessionFile(
		agentName: string,
		sessionFilePath: string,
		projectPath: string,
		stats: { size: number; mtimeMs: number },
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo | null> {
		let content: string;

		try {
			if (sshConfig) {
				const result = await readFileRemote(sessionFilePath, sshConfig);
				if (!result.success || !result.data) {
					return null;
				}
				content = result.data;
			} else {
				content = await fs.readFile(sessionFilePath, 'utf-8');
			}
		} catch {
			return null;
		}

		const lines = content.split('\n').filter((l) => l.trim());
		if (lines.length === 0) {
			return null;
		}

		let init: OpenClawSessionInit | null = null;
		let sessionProjectPath: string | null = null;
		let firstTimestamp = new Date(stats.mtimeMs).toISOString();
		let lastTimestamp = firstTimestamp;

		// Parse the first few lines to find the session init entry
		for (let i = 0; i < Math.min(lines.length, 10); i++) {
			try {
				const entry = JSON.parse(lines[i]);
				if (entry.type === 'session') {
					init = entry as OpenClawSessionInit;
					if (init.timestamp) {
						firstTimestamp = init.timestamp;
						lastTimestamp = init.timestamp;
					}
					if (init.cwd) {
						sessionProjectPath = init.cwd;
					}
					break;
				}
			} catch {
				// Ignore malformed lines
			}
		}

		if (!sessionProjectPath) {
			return null;
		}

		if (projectPath && !isSessionForProject(sessionProjectPath, projectPath)) {
			return null;
		}

		// Count messages and find first user message for preview
		let firstUserMessage = '';
		let userMessageCount = 0;
		let assistantMessageCount = 0;

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);

				if (entry.type === 'message' && entry.message?.role) {
					const role = entry.message.role as 'user' | 'assistant';
					const text = extractTextFromContent(entry.message.content);

					if (role === 'user') {
						userMessageCount++;
						if (!firstUserMessage && text.trim()) {
							firstUserMessage = text;
						}
					} else if (role === 'assistant') {
						assistantMessageCount++;
					}

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
				}
			} catch {
				// Skip malformed lines
			}
		}

		const messageCount = userMessageCount + assistantMessageCount;

		const startTime = new Date(firstTimestamp).getTime();
		const endTime = new Date(lastTimestamp).getTime();
		const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

		const rawSessionId =
			init?.id || path.basename(sessionFilePath).replace(/\.jsonl$/i, '') || 'openclaw-session';

		return {
			sessionId: buildCompositeSessionId(agentName, rawSessionId),
			projectPath: normalizeProjectPath(sessionProjectPath),
			timestamp: firstTimestamp,
			modifiedAt: lastTimestamp || new Date(stats.mtimeMs).toISOString(),
			firstMessage: (firstUserMessage || 'OpenClaw session').slice(0, 200),
			messageCount,
			sizeBytes: stats.size,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			durationSeconds,
		};
	}

	/**
	 * List sessions from remote host via SSH
	 */
	private async listSessionsRemote(
		projectPath: string,
		sshConfig: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		const dirResult = await readDirRemote(OPENCLAW_REMOTE_AGENTS_DIR, sshConfig);
		if (!dirResult.success || !dirResult.data) {
			logger.info('No OpenClaw agents directory found on remote', LOG_CONTEXT);
			return [];
		}

		const agentDirs = dirResult.data.filter((entry) => entry.isDirectory);
		const sessions: AgentSessionInfo[] = [];

		for (const agentEntry of agentDirs) {
			const agentName = agentEntry.name;
			const sessionsDir = `${OPENCLAW_REMOTE_AGENTS_DIR}/${agentName}/sessions`;
			const sessionsDirResult = await readDirRemote(sessionsDir, sshConfig);
			if (!sessionsDirResult.success || !sessionsDirResult.data) continue;

			const sessionFiles = sessionsDirResult.data.filter(
				(entry) => !entry.isDirectory && entry.name.endsWith('.jsonl')
			);

			for (const file of sessionFiles) {
				const sessionPath = `${sessionsDir}/${file.name}`;

				try {
					const statResult = await statRemote(sessionPath, sshConfig);
					if (!statResult.success || !statResult.data) {
						continue;
					}

					const session = await this.parseOpenClawSessionFile(
						agentName,
						sessionPath,
						projectPath,
						{ size: statResult.data.size, mtimeMs: statResult.data.mtime },
						sshConfig
					);
					if (session) {
						sessions.push(session);
					}
				} catch (e) {
					logger.warn('Error reading remote OpenClaw session', LOG_CONTEXT, {
						agentName,
						sessionUuid: file.name,
						error: e,
					});
				}
			}
		}

		sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
		logger.info(
			`Found ${sessions.length} OpenClaw sessions for project: ${projectPath} (remote via SSH)`,
			LOG_CONTEXT
		);
		return sessions;
	}

	async listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		if (sshConfig) {
			return this.listSessionsRemote(projectPath, sshConfig);
		}

		try {
			await fs.access(OPENCLAW_AGENTS_DIR);
		} catch {
			logger.info(`No OpenClaw agents directory found: ${OPENCLAW_AGENTS_DIR}`, LOG_CONTEXT);
			return [];
		}

		const agentEntries = await fs.readdir(OPENCLAW_AGENTS_DIR, { withFileTypes: true });
		const agentDirs = agentEntries.filter((entry) => entry.isDirectory());
		const sessions: AgentSessionInfo[] = [];

		for (const agentEntry of agentDirs) {
			const agentName = agentEntry.name;
			const sessionsDir = path.join(OPENCLAW_AGENTS_DIR, agentName, 'sessions');

			try {
				await fs.access(sessionsDir);
			} catch {
				continue;
			}

			const files = await fs.readdir(sessionsDir);
			for (const file of files) {
				if (!file.endsWith('.jsonl')) continue;

				const sessionUuid = path.basename(file, '.jsonl');
				const sessionPath = path.join(sessionsDir, file);

				try {
					const stat = await fs.stat(sessionPath);
					const session = await this.parseOpenClawSessionFile(agentName, sessionPath, projectPath, {
						size: stat.size,
						mtimeMs: stat.mtimeMs,
					});
					if (session) {
						sessions.push(session);
					}
				} catch (e) {
					logger.warn('Error reading OpenClaw session', LOG_CONTEXT, {
						agentName,
						sessionUuid,
						error: e,
					});
				}
			}
		}

		sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
		logger.info(
			`Found ${sessions.length} OpenClaw sessions for project: ${projectPath}`,
			LOG_CONTEXT
		);
		return sessions;
	}

	async readSessionMessages(
		_projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		const parsed = parseCompositeSessionId(sessionId);
		if (!parsed) {
			logger.warn(`Invalid OpenClaw sessionId format: ${sessionId}`, LOG_CONTEXT);
			return { messages: [], total: 0, hasMore: false };
		}

		let openclawMessages: OpenClawMessage[];

		if (sshConfig) {
			const sessionPath = this.getRemoteSessionFile(parsed.agentName, parsed.sessionId);
			openclawMessages = await this.loadSessionMessagesRemote(sessionPath, sshConfig);
		} else {
			const sessionPath = this.getLocalSessionFile(parsed.agentName, parsed.sessionId);
			openclawMessages = await this.loadSessionMessages(sessionPath);
		}

		const sessionMessages: SessionMessage[] = [];

		for (const msg of openclawMessages) {
			const role = msg.message.role;
			if (role !== 'user' && role !== 'assistant') continue;

			const textContent = extractTextFromContent(msg.message.content);
			if (!textContent) continue;

			sessionMessages.push({
				type: role,
				role,
				content: textContent,
				timestamp: msg.timestamp,
				uuid: msg.id,
			});
		}

		return BaseSessionStorage.applyMessagePagination(sessionMessages, options);
	}

	protected async getSearchableMessages(
		sessionId: string,
		_projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		const parsed = parseCompositeSessionId(sessionId);
		if (!parsed) {
			return [];
		}

		let openclawMessages: OpenClawMessage[];

		if (sshConfig) {
			const sessionPath = this.getRemoteSessionFile(parsed.agentName, parsed.sessionId);
			openclawMessages = await this.loadSessionMessagesRemote(sessionPath, sshConfig);
		} else {
			const sessionPath = this.getLocalSessionFile(parsed.agentName, parsed.sessionId);
			openclawMessages = await this.loadSessionMessages(sessionPath);
		}

		return openclawMessages
			.filter((msg) => msg.message.role === 'user' || msg.message.role === 'assistant')
			.map((msg) => ({
				role: msg.message.role as 'user' | 'assistant',
				textContent: extractTextFromContent(msg.message.content),
			}))
			.filter((msg) => msg.textContent.length > 0);
	}

	getSessionPath(
		_projectPath: string,
		sessionId: string,
		sshConfig?: SshRemoteConfig
	): string | null {
		const parsed = parseCompositeSessionId(sessionId);
		if (!parsed) {
			return null;
		}
		if (sshConfig) {
			return this.getRemoteSessionFile(parsed.agentName, parsed.sessionId);
		}
		return this.getLocalSessionFile(parsed.agentName, parsed.sessionId);
	}

	async deleteMessagePair(
		_projectPath: string,
		sessionId: string,
		userMessageUuid: string,
		fallbackContent?: string,
		sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		// Note: Delete operations on remote sessions are not supported yet
		// This would require implementing writeFileRemote
		if (sshConfig) {
			logger.warn(
				'Delete message pair not supported for SSH remote OpenClaw sessions',
				LOG_CONTEXT
			);
			return { success: false, error: 'Delete not supported for remote sessions' };
		}

		const parsed = parseCompositeSessionId(sessionId);
		if (!parsed) {
			return { success: false, error: 'Invalid sessionId format' };
		}

		try {
			const sessionPath = this.getLocalSessionFile(parsed.agentName, parsed.sessionId);
			const content = await fs.readFile(sessionPath, 'utf-8');
			const lines = content.trim().split('\n');
			const newLines: string[] = [];
			let linesRemoved = 0;
			let foundUserMessage = false;
			let skipUntilNextUser = false;

			for (const line of lines) {
				if (!line.trim()) {
					newLines.push(line);
					continue;
				}

				try {
					const entry = JSON.parse(line);

					if (!foundUserMessage && entry.type === 'message' && entry.message?.role === 'user') {
						const isTargetByUuid = entry.id === userMessageUuid;
						const isTargetByContent =
							fallbackContent &&
							extractTextFromContent(entry.message.content).trim().toLowerCase() ===
								fallbackContent.trim().toLowerCase();

						if (isTargetByUuid || isTargetByContent) {
							foundUserMessage = true;
							skipUntilNextUser = true;
							linesRemoved++;
							continue;
						}
					}

					if (skipUntilNextUser) {
						if (entry.type === 'message' && entry.message?.role === 'user') {
							skipUntilNextUser = false;
							newLines.push(line);
						} else {
							linesRemoved++;
							continue;
						}
					} else {
						newLines.push(line);
					}
				} catch (error) {
					logger.debug('Skipping unparseable line during OpenClaw deletion', LOG_CONTEXT, {
						error,
					});
					newLines.push(line);
				}
			}

			if (!foundUserMessage) {
				return { success: false, error: 'User message not found' };
			}

			await fs.writeFile(sessionPath, newLines.join('\n') + '\n', 'utf-8');

			logger.info('Deleted message pair from OpenClaw session', LOG_CONTEXT, {
				sessionId,
				userMessageUuid,
				linesRemoved,
			});

			return { success: true, linesRemoved };
		} catch (error) {
			logger.error('Error deleting message pair from OpenClaw session', LOG_CONTEXT, {
				sessionId,
				error,
			});
			captureException(error, { operation: 'openclawStorage:deleteMessagePair', sessionId });
			return { success: false, error: String(error) };
		}
	}
}
