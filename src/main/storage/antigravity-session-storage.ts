/**
 * Antigravity CLI (agy) Session Storage
 *
 * agy keeps no transcript file. It keeps two SQLite stores under
 * `~/.gemini/antigravity-cli/` (verified on agy 1.2.16):
 *
 *   conversation_summaries.db   one row per conversation, headless runs
 *                               included: workspace_uris (JSON array of
 *                               file:// URLs), title, step_count,
 *                               last_modified_time, parent_conversation_id
 *   conversations/<id>.db       table `steps`, one protobuf `step_payload`
 *                               per step (field map in antigravity-step-store.ts)
 *
 * Listing reads the summary index; a conversation's own store is opened only
 * when its row belongs to the project and its fingerprint changed (the
 * session-info cache). Subagent conversations (a parent id) are left out: they
 * are agy's internal workers, not something the user started.
 *
 * The index often has NO workspace (519 of 650 rows on one real machine,
 * Maestro-spawned runs among them), so a row's project is resolved in order:
 * the index's workspace_uris, agy's own folder -> last-conversation map
 * (cache/last_conversations.json), then the `Cwd` of the conversation's first
 * run_command. The last needs the store opened, so it is memoized per
 * conversation and step count.
 *
 * Local only. The stores are binary SQLite on the remote host and Maestro's
 * remote-fs helpers read text, so an SSH-remote agent shows no history rather
 * than a wrong one.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger';
import type {
	AgentSessionInfo,
	SessionMessage,
	SessionMessagesResult,
	SessionReadOptions,
} from '../agents';
import type { ToolType, SshRemoteConfig } from '../../shared/types';
import { stripEmbeddedSystemPrompt } from '../../shared/embeddedSystemPrompt';
import { BaseSessionStorage, type SearchableMessage } from './base-session-storage';
import { fileFingerprint, getSessionInfoCache, type SessionFileRef } from './session-info-cache';
import {
	ANTIGRAVITY_CONVERSATION_ID,
	antigravityConversationDbPath,
	antigravityHome,
	commandExitCode,
	fieldAt,
	fieldsAt,
	openAntigravityDb,
	storedResultSummary,
	toolResultFromStepPayload,
	utf8,
	varintAt,
} from '../parsers/antigravity-step-store';

const LOG_CONTEXT = '[AntigravitySessionStorage]';
const FIRST_MESSAGE_PREVIEW_LENGTH = 200;

const USER_STEP = 14;
const MODEL_STEP = 15;
const TOOL_STEP = 132;

interface SummaryRow {
	conversation_id: string;
	title: string;
	step_count: number;
	last_modified_time: string;
	workspace_uris: string;
}

interface ToolUseEntry {
	tool: string;
	args: string;
	state: { status: string; input?: unknown; output?: string };
}

export interface ParsedConversation {
	messages: SessionMessage[];
	firstUserMessage: string;
	firstAssistantMessage: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	createdMs: number;
	modifiedMs: number;
}

/** Fold the macOS `/private` prefix and trailing slashes so `/tmp/x` == `/private/tmp/x`. */
function normalizePath(value: string): string {
	const trimmed = value.replace(/\/+$/, '') || '/';
	return trimmed.replace(/^\/private(\/(?:var|tmp|etc))(\/|$)/, '$1$2');
}

function matchesProject(workspace: string, projectPath: string): boolean {
	const a = normalizePath(workspace);
	const b = normalizePath(projectPath);
	return a === b || a.startsWith(`${b}/`);
}

/** Local paths out of a `workspace_uris` JSON array; non-file URIs are dropped. */
function workspacePaths(json: string): string[] {
	try {
		const uris = JSON.parse(json) as unknown;
		if (!Array.isArray(uris)) return [];
		return uris
			.filter((uri): uri is string => typeof uri === 'string' && uri.startsWith('file://'))
			.map((uri) => fileURLToPath(uri));
	} catch {
		return [];
	}
}

/** A step's creation time (5 -> 1 {seconds, nanos}) in ms, or 0. */
function stepTimeMs(payload: Uint8Array): number {
	const seconds = varintAt(payload, [5, 1, 1]);
	if (seconds === undefined) return 0;
	return seconds * 1000 + Math.floor((varintAt(payload, [5, 1, 2]) ?? 0) / 1e6);
}

/** Parsed tool arguments, without agy's UI-only label keys. */
function toolInput(args: string): unknown {
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
		const { toolAction: _action, toolSummary: _summary, ...rest } = parsed;
		return rest;
	} catch {
		return args;
	}
}

/**
 * Turn a conversation's steps into display messages and token totals. User
 * steps become user messages, model steps become assistant messages carrying
 * their tool calls, and each tool step settles the call it answers (by call id)
 * with its stored result. Background notices (101) and other step types carry
 * nothing the user said or saw as a reply.
 */
export function parseConversationSteps(
	rows: Array<{ idx: number; step_type: number; step_payload: Uint8Array | null }>
): ParsedConversation {
	const messages: SessionMessage[] = [];
	const pending = new Map<string, ToolUseEntry>();
	const out: ParsedConversation = {
		messages,
		firstUserMessage: '',
		firstAssistantMessage: '',
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		createdMs: 0,
		modifiedMs: 0,
	};

	for (const row of rows) {
		if (!row.step_payload) continue;
		const payload = new Uint8Array(row.step_payload);
		const timeMs = stepTimeMs(payload);
		if (timeMs) {
			out.createdMs ||= timeMs;
			out.modifiedMs = Math.max(out.modifiedMs, timeMs);
		}
		const timestamp = timeMs ? new Date(timeMs).toISOString() : '';
		const uuid = `agy-step-${row.idx}`;

		if (row.step_type === USER_STEP) {
			const text = utf8(fieldAt(payload, [19, 2])).trim();
			if (!text) continue;
			out.firstUserMessage ||= stripEmbeddedSystemPrompt(text);
			messages.push({ type: 'user', role: 'user', content: text, timestamp, uuid });
			continue;
		}

		if (row.step_type === MODEL_STEP) {
			out.inputTokens += varintAt(payload, [5, 9, 2]) ?? 0;
			out.outputTokens += varintAt(payload, [5, 9, 3]) ?? 0;
			out.cacheReadTokens += varintAt(payload, [5, 9, 5]) ?? 0;

			const text = utf8(fieldAt(payload, [20, 1]));
			const toolUse: ToolUseEntry[] = [];
			for (const call of fieldsAt(payload, [20, 7])) {
				const name = utf8(fieldAt(call, [2]));
				if (!name) continue;
				const args = utf8(fieldAt(call, [3]));
				const entry: ToolUseEntry = {
					tool: name,
					args,
					state: { status: 'running', input: toolInput(args) },
				};
				const id = utf8(fieldAt(call, [1]));
				if (id) pending.set(id, entry);
				toolUse.push(entry);
			}
			if (!text.trim() && toolUse.length === 0) continue;
			if (text.trim()) out.firstAssistantMessage ||= text;
			messages.push({
				type: 'assistant',
				role: 'assistant',
				content: text,
				timestamp,
				uuid,
				...(toolUse.length > 0 ? { toolUse } : {}),
			});
			continue;
		}

		if (row.step_type === TOOL_STEP) {
			const entry = pending.get(utf8(fieldAt(payload, [5, 4, 1])));
			if (!entry) continue;
			const result = toolResultFromStepPayload(payload);
			const exitCode = commandExitCode(result);
			entry.state = {
				...entry.state,
				status: exitCode !== undefined && exitCode !== 0 ? 'failed' : 'completed',
				...(result ? { output: storedResultSummary(result) } : {}),
			};
		}
	}

	return out;
}

/** Read a conversation's steps, or null if its store cannot be opened. */
function readConversation(conversationId: string): ParsedConversation | null {
	const db = openAntigravityDb(antigravityConversationDbPath(conversationId));
	if (!db) return null;
	try {
		const rows = db
			.prepare(
				'SELECT idx, step_type, step_payload FROM steps WHERE step_type IN (?, ?, ?) ORDER BY idx'
			)
			.all(USER_STEP, MODEL_STEP, TOOL_STEP) as Array<{
			idx: number;
			step_type: number;
			step_payload: Uint8Array | null;
		}>;
		return parseConversationSteps(rows);
	} catch (error) {
		logger.debug(`Unreadable agy conversation ${conversationId}: ${String(error)}`, LOG_CONTEXT);
		return null;
	} finally {
		db.close();
	}
}

/** Top-level conversations from agy's summary index. */
function readSummaries(): SummaryRow[] {
	const db = openAntigravityDb(path.join(antigravityHome(), 'conversation_summaries.db'));
	if (!db) return [];
	try {
		return db
			.prepare(
				`SELECT conversation_id, title, step_count, last_modified_time, workspace_uris
				 FROM conversation_summaries WHERE parent_conversation_id = ''`
			)
			.all() as SummaryRow[];
	} catch (error) {
		logger.debug(`Unreadable agy conversation index: ${String(error)}`, LOG_CONTEXT);
		return [];
	} finally {
		db.close();
	}
}

/** conversation id -> folder, from agy's per-folder last-conversation map. */
function readLastConversationFolders(): Map<string, string> {
	const out = new Map<string, string>();
	try {
		const file = path.join(antigravityHome(), 'cache', 'last_conversations.json');
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
		for (const [folder, id] of Object.entries(parsed)) {
			if (typeof id === 'string') out.set(id, folder);
		}
	} catch {
		// Missing or unreadable: the other sources still apply.
	}
	return out;
}

/** The `Cwd` of the conversation's first run_command, or null if it ran none. */
export function firstCommandCwd(conversationId: string): string | null {
	const db = openAntigravityDb(antigravityConversationDbPath(conversationId));
	if (!db) return null;
	try {
		const rows = db
			.prepare('SELECT step_payload FROM steps WHERE step_type = ? ORDER BY idx')
			.iterate(TOOL_STEP) as IterableIterator<{ step_payload: Uint8Array | null }>;
		for (const row of rows) {
			if (!row.step_payload) continue;
			try {
				const args = JSON.parse(utf8(fieldAt(new Uint8Array(row.step_payload), [5, 4, 3])));
				if (typeof args?.Cwd === 'string' && args.Cwd) return args.Cwd;
			} catch {
				// Not a JSON-argument call; keep looking.
			}
		}
		return null;
	} catch {
		return null;
	} finally {
		db.close();
	}
}

export class AntigravitySessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'antigravity';

	/** firstCommandCwd per conversation, valid while its step count holds. */
	private readonly scannedCwd = new Map<string, { steps: number; cwd: string | null }>();

	/** Every folder a row could belong to, cheapest source first. */
	private async rowWorkspaces(
		row: SummaryRow,
		lastFolders: Map<string, string>
	): Promise<string[]> {
		const indexed = workspacePaths(row.workspace_uris);
		if (indexed.length > 0) return indexed;
		const last = lastFolders.get(row.conversation_id);
		if (last) return [last];
		const cached = this.scannedCwd.get(row.conversation_id);
		if (cached && cached.steps === row.step_count) return cached.cwd ? [cached.cwd] : [];
		// The scan is synchronous SQLite on the main process: yield between stores
		// so a first listing over hundreds of them never blocks IPC for its whole run.
		await new Promise((resolve) => setImmediate(resolve));
		const cwd = firstCommandCwd(row.conversation_id);
		this.scannedCwd.set(row.conversation_id, { steps: row.step_count, cwd });
		return cwd ? [cwd] : [];
	}

	/** The summary row for one conversation, when it belongs to the project. */
	private async summaryForProject(
		projectPath: string,
		conversationId: string
	): Promise<SummaryRow | undefined> {
		if (!ANTIGRAVITY_CONVERSATION_ID.test(conversationId)) return undefined;
		const row = readSummaries().find((candidate) => candidate.conversation_id === conversationId);
		if (!row) return undefined;
		const workspaces = await this.rowWorkspaces(row, readLastConversationFolders());
		return workspaces.some((workspace) => matchesProject(workspace, projectPath)) ? row : undefined;
	}

	async listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		if (sshConfig) return [];

		const refs: Array<SessionFileRef & { row: SummaryRow; workspace: string }> = [];
		const lastFolders = readLastConversationFolders();
		for (const row of readSummaries()) {
			if (!ANTIGRAVITY_CONVERSATION_ID.test(row.conversation_id)) continue;
			const workspace = (await this.rowWorkspaces(row, lastFolders)).find((candidate) =>
				matchesProject(candidate, projectPath)
			);
			if (!workspace) continue;
			const dbPath = antigravityConversationDbPath(row.conversation_id);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(dbPath);
			} catch {
				continue; // indexed, but the store is gone
			}
			refs.push({
				key: dbPath,
				// The store is WAL-mode, so its own mtime lags a live run; the index
				// row moves with every step.
				fingerprint: `${row.last_modified_time}|${row.step_count}|${fileFingerprint(stat.size, stat.mtimeMs)}`,
				row,
				workspace,
			});
		}

		const sessions = await getSessionInfoCache(this.agentId).resolve(
			normalizePath(projectPath),
			refs,
			async (ref) => {
				const { row, workspace } = ref as (typeof refs)[number];
				const parsed = readConversation(row.conversation_id);
				if (!parsed || parsed.messages.length === 0) return null;
				const indexedMs = Date.parse(row.last_modified_time) || 0;
				const modifiedMs = Math.max(parsed.modifiedMs, indexedMs);
				const createdMs = parsed.createdMs || modifiedMs;
				const preview = parsed.firstUserMessage || parsed.firstAssistantMessage || row.title;
				return {
					sessionId: row.conversation_id,
					projectPath: workspace,
					timestamp: new Date(createdMs).toISOString(),
					modifiedAt: new Date(modifiedMs).toISOString(),
					firstMessage: preview.slice(0, FIRST_MESSAGE_PREVIEW_LENGTH),
					messageCount: parsed.messages.length,
					sizeBytes: fs.statSync(ref.key).size,
					inputTokens: parsed.inputTokens,
					outputTokens: parsed.outputTokens,
					cacheReadTokens: parsed.cacheReadTokens,
					cacheCreationTokens: 0,
					durationSeconds: Math.max(0, Math.floor((modifiedMs - createdMs) / 1000)),
					sessionName: row.title || undefined,
				};
			},
			{ prune: true }
		);

		return [...sessions].sort(
			(a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
		);
	}

	async readSessionMessages(
		projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		const parsed =
			!sshConfig && (await this.summaryForProject(projectPath, sessionId))
				? readConversation(sessionId)
				: null;
		if (!parsed) return { messages: [], total: 0, hasMore: false };
		return BaseSessionStorage.applyMessagePagination(parsed.messages, options);
	}

	protected async getSearchableMessages(
		sessionId: string,
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		const { messages } = await this.readSessionMessages(
			projectPath,
			sessionId,
			undefined,
			sshConfig
		);
		return messages
			.filter((message) => message.content.trim())
			.map((message) => ({
				role: message.role as 'user' | 'assistant',
				textContent: message.content,
			}));
	}

	/** The conversation's store: what the starred-transcript mirror copies and restores. */
	getSessionPath(
		_projectPath: string,
		sessionId: string,
		sshConfig?: SshRemoteConfig
	): string | null {
		if (sshConfig || !ANTIGRAVITY_CONVERSATION_ID.test(sessionId)) return null;
		return antigravityConversationDbPath(sessionId);
	}

	async deleteMessagePair(): Promise<{ success: boolean; error?: string }> {
		// agy's store is a protobuf step log it also reads; editing it is not ours.
		return { success: false, error: 'Deleting messages is not supported for Antigravity sessions' };
	}
}
