import fs from 'fs/promises';
import type { Dirent } from 'fs';
import os from 'os';
import path from 'path';
import type { ToolType, SshRemoteConfig } from '../../shared/types';
import type {
	AgentSessionInfo,
	SessionMessage,
	SessionMessagesResult,
	SessionReadOptions,
} from '../agents/session-storage';
import { BaseSessionStorage, type SearchableMessage } from './base-session-storage';

const SESSION_FILE_EXTENSION = '.jsonl';

interface OmpTranscript {
	title: string | null;
	sessionId: string;
	createdAt: string;
	messages: SessionMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';

	return content
		.flatMap((item) => {
			if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') return [];
			return [item.text];
		})
		.join('\n')
		.trim();
}

function parseTranscript(content: string): OmpTranscript | null {
	let title: string | null = null;
	let sessionId: string | null = null;
	let createdAt: string | null = null;
	const messages: SessionMessage[] = [];

	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return null;
		}
		if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;

		if (parsed.type === 'title') {
			if (typeof parsed.title !== 'string') return null;
			title = parsed.title;
			continue;
		}

		if (parsed.type === 'session') {
			if (typeof parsed.id !== 'string' || typeof parsed.timestamp !== 'string') return null;
			sessionId = parsed.id;
			createdAt = parsed.timestamp;
			continue;
		}

		if (parsed.type !== 'message') continue;
		if (
			typeof parsed.id !== 'string' ||
			typeof parsed.timestamp !== 'string' ||
			!isRecord(parsed.message)
		) {
			return null;
		}
		const role = parsed.message.role;
		if (role !== 'user' && role !== 'assistant') continue;
		const text = extractText(parsed.message.content);
		if (!text) continue;
		messages.push({
			type: role,
			role,
			content: text,
			timestamp: parsed.timestamp,
			uuid: parsed.id,
		});
	}

	if (!sessionId || !createdAt) return null;
	return { title, sessionId, createdAt, messages };
}

/**
 * OMP groups transcripts beneath a per-run directory:
 * ~/.omp/agent/sessions/<home-relative-project-path>/<run>/<agent>.jsonl.
 * The project-root JSONL files are run indexes, not individual transcripts.
 *
 * The project directory omits the home-directory prefix and replaces path
 * separators with dashes, e.g. ~/Software/Maestro -> -Software-Maestro.
 */
export class OmpSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'omp';

	private getProjectSessionDir(projectPath: string): string {
		const relativePath = path.relative(os.homedir(), path.resolve(projectPath));
		if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return '';
		return path.join(
			os.homedir(),
			'.omp',
			'agent',
			'sessions',
			`-${relativePath.replace(/[\\/]+/g, '-')}`
		);
	}
	private async collectTranscriptPaths(projectDir: string): Promise<string[]> {
		const transcriptPaths: string[] = [];

		const walk = async (directory: string, includeFiles: boolean): Promise<void> => {
			let entries: Dirent[];
			try {
				entries = await fs.readdir(directory, { withFileTypes: true });
			} catch {
				return;
			}

			for (const entry of entries) {
				const entryPath = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					await walk(entryPath, true);
					continue;
				}
				if (includeFiles && entry.isFile() && entry.name.endsWith(SESSION_FILE_EXTENSION)) {
					transcriptPaths.push(entryPath);
				}
			}
		};

		await walk(projectDir, false);
		return transcriptPaths;
	}

	private async findTranscript(
		projectPath: string,
		sessionId: string
	): Promise<{ path: string; transcript: OmpTranscript } | null> {
		const projectDir = this.getProjectSessionDir(projectPath);
		if (!projectDir) return null;

		const transcriptPaths = await this.collectTranscriptPaths(projectDir);
		for (const sessionPath of transcriptPaths) {
			try {
				const transcript = parseTranscript(await fs.readFile(sessionPath, 'utf-8'));
				if (transcript?.sessionId === sessionId) return { path: sessionPath, transcript };
			} catch {
				// A concurrently-written or inaccessible transcript cannot be trusted.
			}
		}
		return null;
	}

	async listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		if (sshConfig) return [];
		const projectDir = this.getProjectSessionDir(projectPath);
		if (!projectDir) return [];

		const transcriptPaths = await this.collectTranscriptPaths(projectDir);

		const sessions: AgentSessionInfo[] = [];
		for (const sessionPath of transcriptPaths) {
			try {
				const [content, stat] = await Promise.all([
					fs.readFile(sessionPath, 'utf-8'),
					fs.stat(sessionPath),
				]);
				const transcript = parseTranscript(content);
				if (!transcript) continue;
				const firstMessage = (
					transcript.messages.find((message) => message.role === 'user')?.content ?? 'OMP session'
				).slice(0, 200);
				const lastTimestamp = transcript.messages.at(-1)?.timestamp ?? transcript.createdAt;
				const durationMilliseconds =
					new Date(lastTimestamp).getTime() - new Date(transcript.createdAt).getTime();
				sessions.push({
					sessionId: transcript.sessionId,
					projectPath,
					timestamp: transcript.createdAt,
					modifiedAt: stat.mtime.toISOString(),
					firstMessage,
					messageCount: transcript.messages.length,
					sizeBytes: stat.size,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					durationSeconds: Number.isFinite(durationMilliseconds)
						? Math.max(0, Math.floor(durationMilliseconds / 1000))
						: 0,
					sessionName:
						transcript.title?.trim() || path.basename(sessionPath, SESSION_FILE_EXTENSION),
				});
			} catch {
				// A malformed session is excluded rather than exposed with invented metadata.
			}
		}
		return sessions.sort(
			(left, right) => new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime()
		);
	}

	async readSessionMessages(
		projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		if (sshConfig) return { messages: [], total: 0, hasMore: false };
		const found = await this.findTranscript(projectPath, sessionId);
		return BaseSessionStorage.applyMessagePagination(found?.transcript.messages ?? [], options);
	}

	protected async getSearchableMessages(
		sessionId: string,
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		if (sshConfig) return [];
		const found = await this.findTranscript(projectPath, sessionId);
		return (found?.transcript.messages ?? []).flatMap((message) =>
			message.role === 'user' || message.role === 'assistant'
				? [{ role: message.role, textContent: message.content }]
				: []
		);
	}

	getSessionPath(
		_projectPath: string,
		_sessionId: string,
		_sshConfig?: SshRemoteConfig
	): string | null {
		// OMP filenames contain a timestamp prefix, so returning an unchecked path would be unsafe.
		return null;
	}

	async deleteMessagePair(
		_projectPath: string,
		_sessionId: string,
		_userMessageUuid: string,
		_fallbackContent?: string,
		_sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		return { success: false, error: 'OMP session transcripts are read-only' };
	}
}
