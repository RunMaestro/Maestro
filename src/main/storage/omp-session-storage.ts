/**
 * Oh My Pi (omp) Session Storage Implementation
 *
 * Provides access to omp's local session transcripts so omp sessions appear in
 * History and can be resumed / reconstructed on any Maestro frontend (desktop
 * AND web-desktop), matching the parity every other storage-backed agent has.
 *
 * On-disk layout (all platforms - omp uses the dotfile convention):
 *
 *   ~/.omp/agent/sessions/<cwd-slug>/<ISO-timestamp>_<sessionId>.jsonl
 *
 * The `<cwd-slug>` directory name is omp-internal (roughly the cwd with the home
 * prefix stripped and `/` replaced by `-`), so this storage never relies on
 * reproducing that derivation for correctness: it uses the slug only as a fast
 * path and always filters candidate sessions by the authoritative `cwd` carried
 * in each transcript's `session` event. A slug-rule drift therefore degrades to
 * a full scan, never to silently missing sessions.
 *
 * JSONL event vocabulary (one JSON object per line):
 *   { type: 'title' | 'title_change', title }       - human-readable session name
 *   { type: 'session', id, cwd, timestamp }         - session header (authoritative cwd)
 *   { type: 'message', id, timestamp, message: {    - a conversation turn
 *       role: 'user' | 'assistant' | 'toolResult',
 *       content: string | ContentBlock[],           - text / thinking / tool blocks
 *       usage?, model? } }                           - per-turn usage (assistant only)
 *   { type: 'model_change' | 'thinking_level_change' | 'custom' | 'custom_message' } - ignored here
 */

import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { BaseSessionStorage, type SearchableMessage } from './base-session-storage';
import { ModelUsageAccumulator } from '../../shared/modelUsage';
import type {
	AgentSessionInfo,
	SessionMessage,
	SessionMessagesResult,
	SessionReadOptions,
} from '../agents/session-storage';
import type { ToolType, SshRemoteConfig } from '../../shared/types';

const LOG_CONTEXT = '[OmpSessionStorage]';

/** Cap on how much of a single transcript we parse, guarding against a runaway file. */
const MAX_SESSION_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

interface OmpContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	[key: string]: unknown;
}

interface OmpUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number | { total?: number };
}

interface OmpRawMessage {
	role?: string;
	content?: OmpContentBlock[] | string;
	usage?: OmpUsage;
	model?: string;
	timestamp?: string;
}

interface OmpEvent {
	type?: string;
	id?: string;
	timestamp?: string;
	cwd?: string;
	title?: string;
	message?: OmpRawMessage;
}

/** Fully parsed transcript: the session header, title, and ordered events. */
interface OmpTranscript {
	sessionId: string;
	cwd: string | null;
	createdAt: string | null;
	title: string | null;
	events: OmpEvent[];
	filePath: string;
}

/** Extract the sessionId from a transcript filename: `<ISO-timestamp>_<sessionId>.jsonl`. */
function extractSessionIdFromFilename(filename: string): string | null {
	const base = filename.endsWith('.jsonl') ? filename.slice(0, -'.jsonl'.length) : filename;
	const underscore = base.indexOf('_');
	if (underscore < 0) return null;
	const id = base.slice(underscore + 1);
	return id.length > 0 ? id : null;
}

/** Join the `text` blocks of an omp message; thinking/tool blocks are excluded from content. */
function extractText(content: OmpContentBlock[] | string | undefined): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((block) => block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text || '')
		.join('');
}

/** Pull the tool_use / tool_result blocks (if any) so the History renderer can show them. */
function extractToolUse(content: OmpContentBlock[] | string | undefined): unknown {
	if (!Array.isArray(content)) return undefined;
	const toolBlocks = content.filter(
		(block) => block.type === 'tool_use' || block.type === 'tool_result'
	);
	return toolBlocks.length > 0 ? toolBlocks : undefined;
}

/** Normalize an omp cost value (number or `{ total }`) to USD. */
function normalizeCost(cost: OmpUsage['cost']): number {
	if (typeof cost === 'number') return cost;
	if (cost && typeof cost === 'object' && typeof cost.total === 'number') return cost.total;
	return 0;
}

/**
 * Oh My Pi Session Storage.
 *
 * Local transcripts only for v1: SSH-remote omp History is not yet wired and
 * degrades to empty/no-op (never throws). This is a deliberate gap vs. storages
 * that already implement remote list/read (e.g. Factory Droid) - tracked as a
 * follow-up so remote omp History/resume returns nothing rather than erroring.
 */
export class OmpSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'omp';

	private async parseTranscript(filePath: string): Promise<OmpTranscript | null> {
		let raw: string;
		try {
			const stat = await fs.stat(filePath);
			if (stat.size > MAX_SESSION_FILE_SIZE) {
				logger.warn(`Skipping oversized omp transcript: ${filePath}`, LOG_CONTEXT, {
					size: stat.size,
				});
				return null;
			}
			raw = await fs.readFile(filePath, 'utf-8');
		} catch (error) {
			logger.debug(`Failed to read omp transcript: ${filePath}`, LOG_CONTEXT, { error });
			return null;
		}

		const events: OmpEvent[] = [];
		let cwd: string | null = null;
		let createdAt: string | null = null;
		let title: string | null = null;
		let sessionId: string | null = null;

		for (const line of raw.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let event: OmpEvent;
			try {
				event = JSON.parse(trimmed) as OmpEvent;
			} catch {
				continue;
			}
			events.push(event);

			if (event.type === 'session') {
				cwd = typeof event.cwd === 'string' ? event.cwd : cwd;
				createdAt = typeof event.timestamp === 'string' ? event.timestamp : createdAt;
				sessionId = typeof event.id === 'string' ? event.id : sessionId;
			} else if (event.type === 'title' || event.type === 'title_change') {
				if (typeof event.title === 'string' && event.title.trim()) title = event.title.trim();
			}
		}

		if (!sessionId) sessionId = extractSessionIdFromFilename(path.basename(filePath));
		if (!sessionId) return null;

		return { sessionId, cwd, createdAt, title, events, filePath };
	}

	/**
	 * Every omp transcript path across all session directories. Listing and
	 * lookup then filter by the authoritative `cwd` (or sessionId) carried inside
	 * each transcript, so correctness never depends on reproducing omp's internal
	 * directory-slug scheme - a stale or unexpected slug dir can never hide a
	 * matching session. Reads all directories per call; an mtime cache is a
	 * follow-up if omp session volume grows (cf. Codex storage).
	 */
	private async collectTranscriptFiles(): Promise<string[]> {
		// omp sessions root: ~/.omp/agent/sessions (dotfile convention on every platform).
		const root = path.join(os.homedir(), '.omp', 'agent', 'sessions');

		let subdirs: string[];
		try {
			const entries = await fs.readdir(root, { withFileTypes: true });
			subdirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
		} catch {
			return [];
		}

		const perDir = await Promise.all(
			subdirs.map(async (dir) => {
				try {
					const entries = await fs.readdir(dir);
					return entries.filter((e) => e.endsWith('.jsonl')).map((e) => path.join(dir, e));
				} catch {
					return [];
				}
			})
		);
		return perDir.flat();
	}

	async listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		if (sshConfig) {
			logger.debug('omp History over SSH is not supported yet; returning no sessions', LOG_CONTEXT);
			return [];
		}

		const target = path.resolve(projectPath);
		const files = await this.collectTranscriptFiles();
		const sessions: AgentSessionInfo[] = [];

		for (const filePath of files) {
			try {
				const transcript = await this.parseTranscript(filePath);
				if (!transcript || !transcript.cwd) continue;
				// Authoritative filter: only sessions whose header cwd matches the project.
				if (path.resolve(transcript.cwd) !== target) continue;

				const stat = await fs.stat(filePath);
				const info = this.buildSessionInfo(transcript, target, stat.size, stat.mtime);
				sessions.push(info);
			} catch (error) {
				captureException(error, { operation: 'ompStorage:listSessions', filePath });
				logger.warn(`Error reading omp session: ${filePath}`, LOG_CONTEXT, { error });
			}
		}

		sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
		logger.info(`Found ${sessions.length} omp sessions for project: ${projectPath}`, LOG_CONTEXT);
		return sessions;
	}

	private buildSessionInfo(
		transcript: OmpTranscript,
		projectPath: string,
		sizeBytes: number,
		mtime: Date
	): AgentSessionInfo {
		let firstMessage = '';
		let messageCount = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let cacheCreationTokens = 0;
		let costUsd = 0;
		let lastTimestamp: string | null = null;
		const modelAcc = new ModelUsageAccumulator();

		for (const event of transcript.events) {
			if (event.type !== 'message' || !event.message) continue;
			const role = event.message.role;
			if (role !== 'user' && role !== 'assistant') continue;

			messageCount++;
			if (event.timestamp) lastTimestamp = event.timestamp;

			if (!firstMessage && role === 'user') {
				const text = extractText(event.message.content).trim();
				// Skip the injected Maestro system-context turn so the preview shows
				// the user's actual first request, not the boilerplate prompt.
				if (text && !text.startsWith('# Maestro System Context')) {
					firstMessage = text.slice(0, 200);
				}
			}

			const usage = event.message.usage;
			if (role === 'assistant' && usage) {
				const input = usage.input || 0;
				const output = usage.output || 0;
				const cacheRead = usage.cacheRead || 0;
				const cacheWrite = usage.cacheWrite || 0;
				inputTokens += input;
				outputTokens += output;
				cacheReadTokens += cacheRead;
				cacheCreationTokens += cacheWrite;
				costUsd += normalizeCost(usage.cost);
				if (input || output || cacheRead || cacheWrite) {
					modelAcc.add(event.message.model, {
						inputTokens: input,
						outputTokens: output,
						cacheReadTokens: cacheRead,
						cacheCreationTokens: cacheWrite,
					});
				}
			}
		}

		const createdAt = transcript.createdAt || mtime.toISOString();
		const modifiedAt = lastTimestamp || mtime.toISOString();
		const durationSeconds = lastTimestamp
			? Math.max(
					0,
					Math.floor((new Date(modifiedAt).getTime() - new Date(createdAt).getTime()) / 1000)
				)
			: 0;

		return {
			sessionId: transcript.sessionId,
			projectPath,
			timestamp: createdAt,
			modifiedAt,
			firstMessage: firstMessage || transcript.title || 'Oh My Pi session',
			messageCount,
			sizeBytes,
			costUsd: costUsd > 0 ? costUsd : undefined,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheCreationTokens,
			byModel: modelAcc.isEmpty ? undefined : modelAcc.finalize(),
			durationSeconds,
			sessionName: transcript.title || undefined,
		};
	}

	/** Resolve the on-disk transcript path for a sessionId (searches candidate dirs). */
	private async findTranscriptPath(projectPath: string, sessionId: string): Promise<string | null> {
		const files = await this.collectTranscriptFiles();
		for (const filePath of files) {
			if (extractSessionIdFromFilename(path.basename(filePath)) === sessionId) return filePath;
		}
		// Fall back to matching the session header id (filename scheme could differ).
		for (const filePath of files) {
			const transcript = await this.parseTranscript(filePath);
			if (transcript?.sessionId === sessionId) return filePath;
		}
		return null;
	}

	async readSessionMessages(
		projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		if (sshConfig) {
			return { messages: [], total: 0, hasMore: false };
		}

		const filePath = await this.findTranscriptPath(projectPath, sessionId);
		if (!filePath) return { messages: [], total: 0, hasMore: false };

		const transcript = await this.parseTranscript(filePath);
		if (!transcript) return { messages: [], total: 0, hasMore: false };

		const messages: SessionMessage[] = [];
		for (const event of transcript.events) {
			if (event.type !== 'message' || !event.message) continue;
			const role = event.message.role;
			if (role !== 'user' && role !== 'assistant') continue;

			const content = extractText(event.message.content);
			const toolUse = extractToolUse(event.message.content);
			if (!content && !toolUse) continue;

			messages.push({
				type: role,
				role,
				content,
				timestamp: event.timestamp || transcript.createdAt || '',
				uuid: event.id || `${transcript.sessionId}-${messages.length}`,
				toolUse,
			});
		}

		return BaseSessionStorage.applyMessagePagination(messages, options);
	}

	protected async getSearchableMessages(
		sessionId: string,
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		if (sshConfig) return [];
		const filePath = await this.findTranscriptPath(projectPath, sessionId);
		if (!filePath) return [];
		const transcript = await this.parseTranscript(filePath);
		if (!transcript) return [];

		const out: SearchableMessage[] = [];
		for (const event of transcript.events) {
			if (event.type !== 'message' || !event.message) continue;
			const role = event.message.role;
			if (role !== 'user' && role !== 'assistant') continue;
			const textContent = extractText(event.message.content);
			if (textContent.length > 0) out.push({ role, textContent });
		}
		return out;
	}

	getSessionPath(): string | null {
		// omp transcripts are addressed by a timestamped filename, not a stable
		// path derivable from sessionId alone (findTranscriptPath resolves it
		// asynchronously). The sync accessor is best-effort null; History uses the
		// async read/list paths above.
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
			return { success: false, error: 'Delete not supported for remote omp sessions' };
		}

		const filePath = await this.findTranscriptPath(projectPath, sessionId);
		if (!filePath) return { success: false, error: 'Session not found' };

		try {
			const content = await fs.readFile(filePath, 'utf-8');
			const lines = content.split('\n');
			const newLines: string[] = [];
			let linesRemoved = 0;
			let foundUserMessage = false;
			let skipUntilNextUser = false;

			for (const line of lines) {
				if (!line.trim()) {
					newLines.push(line);
					continue;
				}
				let parsed: OmpEvent;
				try {
					parsed = JSON.parse(line) as OmpEvent;
				} catch {
					newLines.push(line);
					continue;
				}

				const isMessage = parsed.type === 'message' && !!parsed.message;
				const role = parsed.message?.role;

				if (!foundUserMessage && isMessage && role === 'user') {
					const byUuid = parsed.id === userMessageUuid;
					const byContent =
						!!fallbackContent &&
						extractText(parsed.message?.content).trim().toLowerCase() ===
							fallbackContent.trim().toLowerCase();
					if (byUuid || byContent) {
						foundUserMessage = true;
						skipUntilNextUser = true;
						linesRemoved++;
						continue;
					}
				}

				if (skipUntilNextUser) {
					// Stop skipping at the next user turn; everything between (assistant
					// replies, tool results) belongs to the removed pair.
					if (isMessage && role === 'user') {
						skipUntilNextUser = false;
						newLines.push(line);
					} else {
						linesRemoved++;
					}
				} else {
					newLines.push(line);
				}
			}

			if (!foundUserMessage) return { success: false, error: 'User message not found' };

			await fs.writeFile(filePath, newLines.join('\n'), 'utf-8');
			logger.info('Deleted message pair from omp session', LOG_CONTEXT, {
				sessionId,
				linesRemoved,
			});
			return { success: true, linesRemoved };
		} catch (error) {
			captureException(error, { operation: 'ompStorage:deleteMessagePair', sessionId });
			logger.error('Error deleting message pair from omp session', LOG_CONTEXT, {
				sessionId,
				error,
			});
			return { success: false, error: String(error) };
		}
	}
}
