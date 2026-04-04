/**
 * Copilot CLI Session Storage Implementation
 *
 * This module implements the AgentSessionStorage interface for GitHub Copilot CLI.
 * Copilot CLI stores sessions in ~/.copilot/session-state/ as UUID directories.
 *
 * Directory structure:
 * - ~/.copilot/session-state/<uuid>/workspace.yaml — Session metadata (id, cwd, summary, timestamps)
 * - ~/.copilot/session-state/<uuid>/events.jsonl — JSONL event history
 *
 * workspace.yaml fields:
 * - id: Session UUID
 * - cwd: Working directory
 * - summary: Auto-generated session summary
 * - created_at: ISO timestamp
 * - updated_at: ISO timestamp
 * - summary_count: Number of summaries generated
 *
 * events.jsonl types:
 * - session.start: Session initialization (sessionId, copilotVersion, cwd)
 * - user.message: User prompt (data.content)
 * - assistant.message: Agent response (data.content, data.toolRequests, data.outputTokens)
 * - tool.execution_start / tool.execution_complete: Tool use
 * - result: Session completion (sessionId, usage)
 *
 * Note: Sessions are stored globally (not per-project), but each session's
 * workspace.yaml contains a `cwd` field for filtering by project path.
 *
 * Verified against Copilot CLI session files (2026-04)
 * @see https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
 */

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import { BaseSessionStorage, type SearchableMessage } from './base-session-storage';
import type {
	AgentSessionInfo,
	SessionMessagesResult,
	SessionReadOptions,
	SessionMessage,
} from '../agents';
import type { ToolType, SshRemoteConfig } from '../../shared/types';

const LOG_CONTEXT = '[CopilotCliSessionStorage]';

// ============================================================================
// Helpers
// ============================================================================

/** Get the Copilot CLI session storage base directory */
function getCopilotSessionDir(): string {
	return path.join(os.homedir(), '.copilot', 'session-state');
}

/**
 * Parse a workspace.yaml file (simple key: value format).
 * Copilot CLI uses a minimal YAML format that can be parsed without a YAML library.
 */
function parseWorkspaceYaml(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split('\n')) {
		// Match: key: value (handle quoted values with 'single quotes')
		const match = line.match(/^(\w+):\s*(?:'((?:[^']|'')*)'|(.*))\s*$/);
		if (match) {
			const key = match[1];
			// Prefer single-quoted group (match[2]), fall back to unquoted (match[3])
			const value = match[2] !== undefined ? match[2].replace(/''/g, "'") : (match[3] || '');
			result[key] = value;
		}
	}
	return result;
}

/** JSONL event from events.jsonl */
interface CopilotEvent {
	type: string;
	id?: string;
	data?: Record<string, unknown>;
	timestamp?: string;
}

/** Validate that a session ID is a UUID to prevent path traversal */
function isValidSessionId(sessionId: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId);
}

// ============================================================================
// Session Storage Implementation
// ============================================================================

/**
 * Copilot CLI Session Storage
 *
 * Provides access to Copilot CLI's local session storage at ~/.copilot/session-state/
 */
export class CopilotCliSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'copilot-cli';

	/**
	 * Load and parse events from a session's events.jsonl file
	 */
	private async loadSessionEvents(eventsPath: string): Promise<CopilotEvent[]> {
		try {
			const content = await fs.readFile(eventsPath, 'utf-8');
			const lines = content
				.trim()
				.split('\n')
				.filter((l) => l.trim());
			const events: CopilotEvent[] = [];

			for (const line of lines) {
				try {
					events.push(JSON.parse(line) as CopilotEvent);
				} catch {
					// Skip unparseable lines
				}
			}
			return events;
		} catch {
			return [];
		}
	}

	/**
	 * List all Copilot CLI sessions, optionally filtered by project path.
	 */
	async listSessions(
		projectPath: string,
		_sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		const sessionBaseDir = getCopilotSessionDir();

		try {
			await fs.access(sessionBaseDir);
		} catch {
			logger.info('No Copilot CLI session-state directory found', LOG_CONTEXT);
			return [];
		}

		const entries = await fs.readdir(sessionBaseDir, { withFileTypes: true });
		const sessions: AgentSessionInfo[] = [];

		// Normalize the project path for comparison
		const normalizedProjectPath = path.resolve(projectPath).toLowerCase();

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			// UUID directory names
			const sessionDir = path.join(sessionBaseDir, entry.name);
			const workspacePath = path.join(sessionDir, 'workspace.yaml');

			try {
				const yamlContent = await fs.readFile(workspacePath, 'utf-8');
				const meta = parseWorkspaceYaml(yamlContent);

				// Filter by project path if the session has a cwd
				if (meta.cwd) {
					const normalizedCwd = path.resolve(meta.cwd).toLowerCase();
					if (normalizedCwd !== normalizedProjectPath) {
						continue;
					}
				}

				const sessionId = meta.id || entry.name;
				const summary = meta.summary || '';
				const createdAt = meta.created_at || '';
				const updatedAt = meta.updated_at || createdAt;

				// Try to get first user message from events.jsonl
				const eventsPath = path.join(sessionDir, 'events.jsonl');
				const events = await this.loadSessionEvents(eventsPath);

				let firstMessage = summary;
				let messageCount = 0;

				for (const event of events) {
					if (event.type === 'user.message' && event.data?.content) {
						if (!firstMessage) {
							firstMessage = String(event.data.content).slice(0, 200);
						}
						messageCount++;
					} else if (event.type === 'assistant.message') {
						messageCount++;
					}
				}

				// Get file size for info
				let sizeBytes = 0;
				try {
					const stat = await fs.stat(eventsPath);
					sizeBytes = stat.size;
				} catch {
					// events.jsonl may not exist for empty sessions
				}

				// Calculate duration from timestamps
				let durationSeconds = 0;
				if (createdAt && updatedAt) {
					const diff = new Date(updatedAt).getTime() - new Date(createdAt).getTime();
					durationSeconds = Math.max(0, Math.floor(diff / 1000));
				}

				sessions.push({
					sessionId,
					sessionName: summary || undefined,
					projectPath,
					timestamp: createdAt,
					modifiedAt: updatedAt,
					firstMessage: firstMessage || 'Copilot CLI session',
					messageCount,
					sizeBytes,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					durationSeconds,
				});
			} catch (e) {
				// Skip sessions with unreadable metadata
				logger.debug(`Skipping session ${entry.name}: ${e}`, LOG_CONTEXT);
			}
		}

		// Sort by modified date (newest first)
		sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

		logger.info(
			`Found ${sessions.length} Copilot CLI sessions for project: ${projectPath}`,
			LOG_CONTEXT
		);
		return sessions;
	}

	/**
	 * Read messages from a specific session.
	 */
	async readSessionMessages(
		_projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		_sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		if (!isValidSessionId(sessionId)) {
			return { messages: [], total: 0, hasMore: false };
		}
		const sessionDir = path.join(getCopilotSessionDir(), sessionId);
		const eventsPath = path.join(sessionDir, 'events.jsonl');

		const events = await this.loadSessionEvents(eventsPath);
		if (events.length === 0) {
			return { messages: [], total: 0, hasMore: false };
		}

		const messages: SessionMessage[] = [];

		for (const event of events) {
			if (event.type === 'user.message' && event.data?.content) {
				messages.push({
					type: 'user',
					role: 'user',
					content: String(event.data.content),
					timestamp: event.timestamp || '',
					uuid: event.id || '',
				});
			} else if (event.type === 'assistant.message' && event.data) {
				const content = String(event.data.content || '');
				if (content) {
					messages.push({
						type: 'assistant',
						role: 'assistant',
						content,
						timestamp: event.timestamp || '',
						uuid: event.id || '',
					});
				}
			}
		}

		const totalMessages = messages.length;

		// Apply pagination
		const limit = options?.limit || totalMessages;
		const offset = options?.offset || 0;
		const paginatedMessages = messages.slice(offset, offset + limit);

		return {
			messages: paginatedMessages,
			total: totalMessages,
			hasMore: offset + limit < totalMessages,
		};
	}

	/**
	 * Get the file path for a session.
	 */
	getSessionPath(
		_projectPath: string,
		sessionId: string,
		_sshConfig?: SshRemoteConfig
	): string | null {
		if (!isValidSessionId(sessionId)) {
			return null;
		}
		return path.join(getCopilotSessionDir(), sessionId, 'events.jsonl');
	}

	/**
	 * Delete a message pair from a session (not supported for Copilot CLI).
	 */
	async deleteMessagePair(
		_projectPath: string,
		_sessionId: string,
		_userMessageUuid: string,
		_fallbackContent?: string,
		_sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		return { success: false, error: 'Message deletion not supported for Copilot CLI sessions' };
	}

	/**
	 * Load messages in simplified format for search.
	 */
	protected async getSearchableMessages(
		sessionId: string,
		_projectPath: string,
		_sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		if (!isValidSessionId(sessionId)) {
			return [];
		}
		const sessionDir = path.join(getCopilotSessionDir(), sessionId);
		const eventsPath = path.join(sessionDir, 'events.jsonl');

		const events = await this.loadSessionEvents(eventsPath);
		const messages: SearchableMessage[] = [];

		for (const event of events) {
			if (event.type === 'user.message' && event.data?.content) {
				messages.push({
					role: 'user',
					textContent: String(event.data.content),
				});
			} else if (event.type === 'assistant.message' && event.data?.content) {
				messages.push({
					role: 'assistant',
					textContent: String(event.data.content),
				});
			}
		}

		return messages;
	}
}
