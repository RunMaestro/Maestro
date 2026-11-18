/**
 * Grok CLI Session Storage Implementation
 *
 * Grok stores each session as a directory:
 *   ~/.grok/sessions/<percent-encoded-cwd>/<session-uuid>/
 *     summary.json       - session metadata (id, cwd, title, timestamps, counts)
 *     chat_history.jsonl - the transcript (system/user/assistant/tool_result/reasoning records)
 *     usage.json         - token and cost ledger (grok 1.x)
 *     prompt_context.json - inputs the system prompt was rendered from; only the
 *                          memory and AGENTS.md facts are read (parseGrokPromptContext)
 *
 * The first-level folder name is the session's working directory with `/`
 * percent-encoded as `%2F`, so project filtering happens on directory names
 * before any file is opened. Structurally this mirrors Copilot's
 * directory-per-session layout (metadata file beside a JSONL transcript),
 * so this implementation follows `copilot-session-storage.ts`, borrowing
 * only the tool_call/tool_result merge pattern from Codex.
 *
 * Grok's transcript records carry no per-message timestamps (left empty). Token
 * and cost totals come from the session's `usage.json` (grok 1.x).
 */

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { isUtf8 } from 'node:buffer';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import {
	readFileRemote,
	readDirRemote,
	statRemote,
	observePathRemote,
	type RemotePathIdentity,
} from '../utils/remote-fs';
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
	SessionListOptions,
	PaginatedSessionsResult,
	SessionSearchMode,
	SessionSearchResult,
} from '../agents';
import type {
	ToolType,
	SshRemoteConfig,
	UsageAccounting,
	UsageBreakdown,
	UsageCost,
} from '../../shared/types';
import { nativeAccountRef, resolveAgentAccountDir } from '../../shared/agentAccountDir';
import type { NativeSessionBinding } from '../../shared/maestro-lib/agents/providerSwap';
import { isMacOS } from '../../shared/platformDetection';
import { BaseSessionStorage } from './base-session-storage';
import type { SearchableMessage } from './base-session-storage';
import { isExpectedRemoteError } from './remote-error-utils';
import { isExpectedSessionReadError } from '../utils/session-read-errors';
import type { ModelTokenUsage } from '../../shared/tokenUsage';
import { normalizeModelId } from '../../shared/modelPricing';
import { parseNativeLines } from '../../shared/maestro-lib/translation/native-records';
import { compactToolOutput } from '../../shared/toolOutput';
import { isInlineImageDataUrl } from './session-image-store';
import { parseJsonWithBom, preserveJsonNumberTokens } from '../../shared/jsonUtils';
import { usageCostUsd } from '../../shared/maestro-lib/streaming/usage-totals';

const LOG_CONTEXT = '[GrokSessionStorage]';
// Below the SSH exec buffer ceiling, including its one-byte overflow probe.
const MAX_SESSION_FILE_SIZE = 64 * 1024 * 1024;
const MAX_SESSION_METADATA_SIZE = 1024 * 1024;
const MAX_SESSION_SOURCE_LINES = 100_000;
const FIRST_MESSAGE_PREVIEW_LENGTH = 200;

/**
 * Native IDs are opaque directory names, not necessarily UUIDs. Validate each
 * untrusted path component before joining it; never decode or sanitize an ID
 * into a different session's name. Encoded cwd folders use this check too.
 */
function isSafeGrokPathSegment(name: string): boolean {
	return (
		typeof name === 'string' &&
		name.length > 0 &&
		name !== '.' &&
		name !== '..' &&
		!name.includes('/') &&
		!name.includes('\\') &&
		!name.includes('\0')
	);
}

/**
 * Normalize one native lifetime ledger row, never a sum of its turn/model detail.
 * Native input includes both cache buckets; reasoning is a subset of output.
 * Missing or unsafe counts remain absent in the accounting view.
 */
function toSessionTokens(value: unknown, parent?: UsageBreakdown): UsageBreakdown {
	const row =
		value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const count = (value: unknown): number | undefined =>
		typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	const input = count(row.inputTokens);
	const outputTokens = count(row.outputTokens);
	const cacheReadInputTokens = count(row.cachedReadTokens);
	const cacheCreationInputTokens = count(row.cacheCreationTokens);
	const reasoningTokens = count(row.reasoningTokens);
	const inputTokens =
		input !== undefined &&
		cacheReadInputTokens !== undefined &&
		cacheCreationInputTokens !== undefined &&
		input >= cacheReadInputTokens + cacheCreationInputTokens
			? input - cacheReadInputTokens - cacheCreationInputTokens
			: undefined;
	const counts = [inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens];
	const complete =
		counts.every((value) => value !== undefined) &&
		(row.reasoningTokens === undefined ||
			(reasoningTokens !== undefined &&
				outputTokens !== undefined &&
				reasoningTokens <= outputTokens)) &&
		(row.totalTokens === undefined ||
			(count(row.totalTokens) !== undefined &&
				input !== undefined &&
				outputTokens !== undefined &&
				Number.isSafeInteger(input + outputTokens) &&
				row.totalTokens === input + outputTokens)) &&
		(row.usageIsIncomplete === undefined || row.usageIsIncomplete === false) &&
		(parent === undefined || parent.completeness === 'complete');
	const completeness = complete
		? 'complete'
		: counts.some((value) => value !== undefined)
			? 'partial'
			: 'unknown';
	// Preserve canonical i64 ticks BEFORE JSON.parse rounds them. Explicit stored
	// zero is evidence; an absent cost is never inferred to be free or estimated.
	const ticks =
		typeof row.costUsdTicks === 'string' &&
		/^(0|[1-9][0-9]{0,18})$/.test(row.costUsdTicks) &&
		BigInt(row.costUsdTicks) <= 9223372036854775807n
			? row.costUsdTicks
			: undefined;
	const costPartial =
		(row.costIsPartial !== undefined && row.costIsPartial !== false) ||
		parent?.cost.status === 'partial';
	const cost: UsageCost =
		ticks !== undefined
			? complete && !costPartial
				? { status: 'exact', costUsdTicks: ticks }
				: { status: 'partial', costUsdTicks: ticks }
			: costPartial || row.usageIsIncomplete === true
				? { status: 'partial' }
				: { status: 'unknown' };
	return {
		inputTokens,
		outputTokens,
		cacheReadInputTokens,
		cacheCreationInputTokens,
		reasoningTokens,
		callCount: count(row.modelCalls),
		completeness,
		cost,
	};
}

/** Session totals plus a per-model split from usage.json, or null if unreadable. */
export function parseGrokUsageFile(content: string | null) {
	if (!content) return null;
	let parsed: unknown;
	try {
		parsed = parseJsonWithBom(preserveJsonNumberTokens(content, 'costUsdTicks'));
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const session = (parsed as Record<string, unknown>).session;
	if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
	const row = session as Record<string, unknown>;
	const totals = toSessionTokens(row);
	const models =
		row.modelUsage && typeof row.modelUsage === 'object' && !Array.isArray(row.modelUsage)
			? Object.entries(row.modelUsage).map(([model, value]) => ({
					model,
					...toSessionTokens(value, totals),
				}))
			: undefined;
	const accounting: UsageAccounting = {
		// This is the CLI runtime's persisted ledger, not provider billing authority.
		source: 'runtime-stream',
		route: 'native-history',
		scope: 'native-session',
		reporting: 'snapshot',
		cacheReadCounting: 'beside-input',
		cacheCreationCounting: 'beside-input',
		completeness: totals.completeness,
		cost: totals.cost,
		// Only finished children fold into this ledger. Persisted usage has no
		// running-child inventory, so even stable files cannot prove all are done.
		childInclusion: 'completed',
		childCompleteness: 'unknown',
		callCount: totals.callCount,
		models,
	};
	// The legacy dashboard type cannot express an unknown/partial model cost. Do
	// not publish an incomplete subset as a full split; all detail survives above.
	const byModel: ModelTokenUsage[] = [];
	if (
		models?.every((model) => model.completeness === 'complete' && model.cost.status === 'exact')
	) {
		for (const model of models) {
			byModel.push({
				model: normalizeModelId(model.model),
				inputTokens: model.inputTokens!,
				outputTokens: model.outputTokens!,
				cacheReadTokens: model.cacheReadInputTokens!,
				cacheCreationTokens: model.cacheCreationInputTokens!,
				costUsd: usageCostUsd(model.cost)!,
				costEstimated: false,
			});
		}
	}
	return {
		inputTokens: totals.inputTokens ?? 0,
		outputTokens: totals.outputTokens ?? 0,
		reasoningTokens: totals.reasoningTokens,
		cacheReadTokens: totals.cacheReadInputTokens ?? 0,
		cacheCreationTokens: totals.cacheCreationInputTokens ?? 0,
		costUsd: usageCostUsd(totals.cost),
		byModel,
		accounting,
	};
}

type GrokNativeMemory = NonNullable<
	NonNullable<AgentSessionInfo['nativeMetadata']>['nativeMemory']
>;

const MAX_PROMPT_CONTEXT_AGENTS_FILES = 256;
const MAX_PROMPT_CONTEXT_PATH_LENGTH = 4096;
const MAX_PROMPT_CONTEXT_LABEL_LENGTH = 64;

/**
 * Confine one reported path to the given roots. Returns undefined when the
 * value is not a path, null when it is one that must be dropped. A root that
 * is not absolute (a remote `~` account) confines nothing, so every path under
 * it is dropped rather than guessed at. Relative paths resolve against the
 * first root only when `relativeBase` is given.
 */
function confineGrokReportedPath(
	value: unknown,
	roots: readonly string[],
	isRemote: boolean,
	relativeBase?: string
): string | null | undefined {
	if (typeof value !== 'string' || !value.trim()) return undefined;
	if (value.length > MAX_PROMPT_CONTEXT_PATH_LENGTH || value.includes('\0')) return null;
	const api = isRemote ? path.posix : path;
	let candidate = value;
	if (!api.isAbsolute(candidate)) {
		if (!relativeBase || !api.isAbsolute(relativeBase)) return null;
		candidate = api.join(relativeBase, candidate);
	}
	const resolved = api.resolve(candidate);
	for (const root of roots) {
		if (!root || !api.isAbsolute(root)) continue;
		const relative = api.relative(api.resolve(root), resolved);
		if (
			relative === '' ||
			(relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))
		) {
			return resolved;
		}
	}
	return null;
}

function boundedLabel(value: unknown): string | undefined {
	return typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_PROMPT_CONTEXT_LABEL_LENGTH
		? value
		: undefined;
}

/**
 * Observed native-memory facts from a session's prompt_context.json (grok
 * 1.0.70: memory_v2_enabled, memory_global_path, memory_workspace_path,
 * agents_md_files, prompt_mode, is_non_interactive). Memory paths must lie
 * under the account root, AGENTS.md paths under the account or project root;
 * anything else is dropped and counted. Never reads the files it names.
 * Returns null for absent, malformed or non-object content.
 */
export function parseGrokPromptContext(
	content: string | null,
	roots: { accountRoot: string; projectRoot: string; isRemote: boolean }
): GrokNativeMemory | null {
	if (!content?.trim()) return null;
	let parsed: unknown;
	try {
		parsed = parseJsonWithBom(content);
	} catch (error) {
		if (error instanceof SyntaxError || error instanceof RangeError) return null;
		throw error;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	const { accountRoot, projectRoot, isRemote } = roots;
	const facts: GrokNativeMemory = { droppedPaths: 0 };
	const keep = (value: string | null | undefined): string | undefined => {
		if (value === null) facts.droppedPaths += 1;
		return value ?? undefined;
	};
	if (typeof record.memory_v2_enabled === 'boolean') {
		facts.memoryEnabled = record.memory_v2_enabled;
	}
	const globalMemoryPath = keep(
		confineGrokReportedPath(record.memory_global_path, [accountRoot], isRemote)
	);
	if (globalMemoryPath) facts.globalMemoryPath = globalMemoryPath;
	const workspaceMemoryPath = keep(
		confineGrokReportedPath(record.memory_workspace_path, [accountRoot], isRemote)
	);
	if (workspaceMemoryPath) facts.workspaceMemoryPath = workspaceMemoryPath;
	if (Array.isArray(record.agents_md_files)) {
		// 1.0.70 sessions observed so far record an empty list; accept a bare
		// path or an object carrying `path`, the two shapes the field could take.
		const files: string[] = [];
		for (const entry of record.agents_md_files.slice(0, MAX_PROMPT_CONTEXT_AGENTS_FILES)) {
			const raw =
				entry && typeof entry === 'object' && !Array.isArray(entry)
					? (entry as Record<string, unknown>).path
					: entry;
			const file = keep(
				confineGrokReportedPath(raw, [projectRoot, accountRoot], isRemote, projectRoot)
			);
			if (file && !files.includes(file)) files.push(file);
		}
		facts.agentsMdFiles = files;
	}
	const promptMode = boundedLabel(record.prompt_mode);
	if (promptMode) facts.promptMode = promptMode;
	if (typeof record.is_non_interactive === 'boolean') {
		facts.nonInteractive = record.is_non_interactive;
	}
	return facts;
}

/** A tool call entry on an assistant transcript record. */
interface GrokToolCall {
	id?: string;
	name?: string;
	/** JSON-encoded argument string. */
	arguments?: string;
	/** Legacy Chat Completions layout. */
	function?: { name?: string; arguments?: string };
}

/** One line of chat_history.jsonl. */
interface GrokChatRecord {
	type?: string;
	role?: string;
	/** String for system/assistant/tool_result records; `{type:'text',text}` block array for user records. */
	content?: unknown;
	/** Present on injected-context user records (e.g. project_instructions, system_reminder). */
	synthetic_reason?: string;
	tool_calls?: GrokToolCall[];
	tool_call_id?: string;
	images?: unknown;
	summary?: unknown;
	reasoning?: { text?: string };
	reasoning_content?: string;
	raw_output?: unknown[];
}

/** Tool use entry shape used when building SessionMessage.toolUse arrays. */
interface GrokToolUseEntry {
	id?: string;
	resultSource?: SessionMessage['native'];
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
	hasMalformedRecords: boolean;
}

/** Extract plain text from a user record's content block array. */
function extractUserText(content: unknown, separator = ' '): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((block) =>
			block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
				? (block as { text: string }).text
				: ''
		)
		.filter((text) => text.trim())
		.join(separator);
}

/**
 * Check whether a user record is injected context rather than a real prompt.
 * Grok flags most context injections with `synthetic_reason`; the environment
 * block at the start of every session is a plain user record wrapped in
 * `<user_info>` tags instead.
 */
function isSyntheticUserRecord(record: GrokChatRecord, text: string): boolean {
	if (
		['human', 'interjection', 'parent_human_message', 'direct_bash'].includes(
			record.synthetic_reason ?? ''
		)
	)
		return false;
	if (record.synthetic_reason) return true;
	return text.trim().startsWith('<user_info>');
}

/** Strip `<user_query>` wrappers Grok adds around real prompt text.
 *  Joins all blocks if a turn embeds multiple wrappers (non-greedy match). */
function stripUserQueryWrapper(text: string): string {
	const matches = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)];
	if (matches.length === 0) return text.trim();
	return matches
		.map((m) => m[1])
		.filter((part) => part.trim().length > 0)
		.join('\n\n');
}

/**
 * Normalize a path for comparison: strip trailing slashes and fold the local macOS
 * `/private` symlink prefix (`/private/var` == `/var`, `/private/tmp` ==
 * `/tmp`) since Grok records the realpath'd cwd while Maestro may pass the
 * symlinked form.
 */
function normalizePathForComparison(value: string, isRemote: boolean): string {
	let normalized = value.replace(/\/+$/, '');
	if (!normalized) normalized = '/';
	// The remote may have distinct /var and /private/var directories. Do not
	// infer its aliases from the desktop's filesystem or operating system.
	return isRemote ? normalized : normalized.replace(/^\/private(\/(?:var|tmp|etc))(\/|$)/, '$1$2');
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
function matchesProject(cwd: string, projectPath: string, isRemote: boolean): boolean {
	const normalizedCwd = normalizePathForComparison(cwd, isRemote);
	const normalizedProject = normalizePathForComparison(projectPath, isRemote);
	return (
		normalizedCwd === normalizedProject ||
		normalizedCwd.startsWith(normalizedProject === '/' ? '/' : `${normalizedProject}/`)
	);
}

/**
 * Convert an assistant record's tool calls into a normalized tool-use array.
 *
 * `args` stays the raw JSON string from the transcript (Codex-compatible shape).
 * Consumers must use `state.input` for the parsed object, not assume `args` is
 * already an object (History UI / tool cards).
 */
function buildToolUse(toolCalls?: GrokToolCall[]): GrokToolUseEntry[] | undefined {
	if (!toolCalls?.length) return undefined;
	const entries = toolCalls
		.filter((call) => call && typeof call === 'object')
		.map((call) => {
			const fields = call.function ?? call;
			const args = typeof fields.arguments === 'string' ? fields.arguments : undefined;
			let input: unknown;
			try {
				input = JSON.parse(args || '{}');
			} catch {
				input = args;
			}
			return {
				id: typeof call.id === 'string' && call.id ? call.id : undefined,
				tool: typeof fields.name === 'string' ? fields.name : undefined,
				// Raw JSON string on purpose - see JSDoc above.
				args,
				state: { status: 'unknown', input },
			};
		});
	return entries.length > 0 ? entries : undefined;
}

/** Extract native image references without opening paths or fetching URLs. */
function extractImageReferences(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => {
		if (!block || typeof block !== 'object') return [];
		const url =
			block.type === 'image'
				? block.url
				: block.type === 'image_url'
					? block.image_url?.url
					: undefined;
		return typeof url === 'string' ? [url] : [];
	});
}

/**
 * Parse both native ConversationItem and legacy Chat Completions rows. Physical
 * line identities survive pagination and appended records; they are not resume IDs.
 * The export view retains every nonblank source row, including malformed JSON.
 * The display view folds results into badges and hides context/reasoning rows.
 */
function parseChatHistory(content: string, includeNativeRecords = false): ParsedGrokChatHistory {
	const messages: SessionMessage[] = [];
	const hidden = new Set<SessionMessage>();
	let firstUserMessage = '';
	let firstAssistantMessage = '';
	const calls = new Map<string, Array<{ call: GrokToolUseEntry; message: SessionMessage }>>();
	const results = new Map<string, SessionMessage[]>();

	const lines = parseNativeLines(content);
	// One row can contain a huge legacy/tool array. Bound normalization's
	// additional objects as well as the physical source rows.
	let projectedItems = lines.length;
	for (const { entry } of lines) {
		for (const value of [entry?.tool_calls, entry?.raw_output]) {
			if (Array.isArray(value)) projectedItems += value.length;
		}
		if (projectedItems > MAX_SESSION_SOURCE_LINES) throw new RangeError('Grok projection limit');
	}
	const backendIds = new Set<string>(
		lines.flatMap(({ entry }) =>
			entry?.type === 'backend_tool_call' && typeof entry.kind?.id === 'string'
				? [entry.kind.id]
				: []
		)
	);
	for (const { line, index, entry, malformed } of lines) {
		const record = (entry ?? {}) as GrokChatRecord;
		const kind = record.type ?? record.role;
		const native: NonNullable<SessionMessage['native']> = {
			provider: 'grok',
			line: index + 1,
			...(includeNativeRecords ? { raw: line } : {}),
		};
		const message: SessionMessage = {
			type: kind ?? 'unknown',
			role: kind ?? 'unknown',
			content: extractUserText(record.content),
			timestamp: '',
			uuid: `grok-line-${index + 1}`,
			native,
		};
		// Native rows have no timestamps. Keep unknown metadata in raw evidence,
		// rather than manufacturing a clock or attempting to decrypt reasoning.
		if (malformed) {
			message.type = message.role = 'unknown';
			message.content = '[Unreadable Grok transcript record retained for export]';
			native.issues = ['malformed-record'];
		} else if (kind === 'user') {
			const synthetic = isSyntheticUserRecord(record, message.content);
			message.imageReferences = extractImageReferences(record.content);
			message.images = message.imageReferences.filter(isInlineImageDataUrl);
			if (synthetic) hidden.add(message);
			else {
				message.content = stripUserQueryWrapper(message.content);
				firstUserMessage ||= message.content;
			}
		} else if (kind === 'assistant') {
			const toolUse = buildToolUse(
				Array.isArray(record.tool_calls) ? record.tool_calls : undefined
			);
			message.toolUse = toolUse;
			for (const call of toolUse ?? []) {
				if (call.id) {
					const siblings = calls.get(call.id) ?? [];
					siblings.push({ call, message });
					calls.set(call.id, siblings);
				} else native.issues = [...(native.issues ?? []), 'missing-tool-call-id'];
			}
			firstAssistantMessage ||= message.content;
			// Native upgrades place legacy reasoning/backend items before their
			// assistant. Preserve that order, with deterministic source-line suffixes.
			const legacy = Array.isArray(record.raw_output)
				? record.raw_output.filter((item): item is Record<string, unknown> =>
						Boolean(
							item &&
							typeof item === 'object' &&
							[
								'reasoning',
								'web_search_call',
								'custom_tool_call',
								'code_interpreter_call',
							].includes((item as { type: string }).type)
						)
					)
				: [];
			if (
				!Array.isArray(record.raw_output) &&
				(record.reasoning || typeof record.reasoning_content === 'string')
			) {
				legacy.push({
					type: 'reasoning',
					content: record.reasoning?.text ?? record.reasoning_content ?? '',
				});
			}
			for (const [part, item] of legacy.entries()) {
				if (item.type !== 'reasoning' && typeof item.id === 'string') {
					if (backendIds.has(item.id)) continue;
					backendIds.add(item.id);
				}
				const sibling: SessionMessage = {
					type: item.type === 'reasoning' ? 'reasoning' : 'backend_tool_call',
					role: 'assistant',
					content: [extractUserText(item.summary, '\n'), extractUserText(item.content, '\n')]
						.filter(Boolean)
						.join('\n'),
					timestamp: '',
					uuid: `${message.uuid}-legacy-${part}`,
					// The original assistant owns raw bytes; this is a projection of that row.
					native: { provider: native.provider, line: native.line },
				};
				messages.push(sibling);
				hidden.add(sibling);
			}
		} else if (kind === 'tool_result' || kind === 'tool') {
			message.type = 'tool_result';
			message.role = 'tool';
			message.imageReferences = [
				...extractImageReferences(record.content),
				...extractImageReferences(record.images),
			];
			message.images = message.imageReferences.filter(isInlineImageDataUrl);
			message.toolCallId =
				typeof record.tool_call_id === 'string' ? record.tool_call_id : undefined;
			if (message.toolCallId) {
				const siblings = results.get(message.toolCallId) ?? [];
				siblings.push(message);
				results.set(message.toolCallId, siblings);
			} else native.issues = ['missing-tool-call-id'];
		} else if (kind === 'reasoning') {
			message.role = 'assistant';
			message.content = [
				extractUserText(record.summary, '\n'),
				extractUserText(record.content, '\n'),
			]
				.filter(Boolean)
				.join('\n');
			hidden.add(message);
		} else if (kind === 'system' || kind === 'backend_tool_call') {
			message.role = kind === 'system' ? 'system' : 'assistant';
			hidden.add(message);
		} else {
			message.type = message.role = 'unknown';
			message.content = '[Unknown Grok transcript record retained for export]';
			native.issues = ['unknown-record'];
		}
		if (
			(kind === 'user' || kind === 'assistant') &&
			!message.content.trim() &&
			!(message.toolUse as GrokToolUseEntry[] | undefined)?.length &&
			!message.imageReferences?.length
		) {
			hidden.add(message);
		}
		messages.push(message);
	}

	// Pair only unambiguous IDs, never by arrival adjacency or tool name. Keep
	// every result in the native view even when the display badge folds it in.
	for (const entries of calls.values()) {
		if (entries.length > 1) {
			for (const { message } of entries) {
				message.native!.issues = [...(message.native!.issues ?? []), 'duplicate-tool-call-id'];
			}
		}
	}
	for (const [id, rows] of results) {
		const entries = calls.get(id);
		const row = rows[0];
		const target = entries?.[0];
		const callMessage = target?.message;
		if (
			entries?.length === 1 &&
			target &&
			rows.length === 1 &&
			callMessage?.native &&
			row.native &&
			callMessage.native.line < row.native.line
		) {
			target.call.state = {
				...target.call.state,
				status: 'completed',
				...(includeNativeRecords
					? {}
					: { output: compactToolOutput(row.content).output as string }),
			};
			target.call.resultSource = { provider: row.native.provider, line: row.native.line };
			if (!includeNativeRecords) {
				callMessage.imageReferences = [
					...(callMessage.imageReferences ?? []),
					...(row.imageReferences ?? []),
				];
				callMessage.images = [...(callMessage.images ?? []), ...(row.images ?? [])];
			}
			hidden.add(row);
		} else {
			for (const result of rows) result.native!.issues = ['ambiguous-or-missing-tool-call'];
		}
	}
	return {
		messages: includeNativeRecords ? messages : messages.filter((message) => !hidden.has(message)),
		firstUserMessage,
		firstAssistantMessage,
		hasMalformedRecords: lines.some((line) => line.malformed),
	};
}

/**
 * Session storage implementation for Grok CLI.
 *
 * Reads session metadata from `~/.grok/sessions/<encoded-cwd>/<sessionId>/summary.json`
 * and conversation history from `chat_history.jsonl`. Supports both local and
 * SSH remote access. The derived `session_search.sqlite` index is intentionally
 * ignored - the transcript files are authoritative.
 */
export class GrokSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'grok';

	/** Immutable account scope lets inherited search reuse the same root for every read. */
	constructor(private readonly accountDir?: string) {
		super();
	}

	private getAccountDir(sshConfig?: SshRemoteConfig, accountDir = this.accountDir): string {
		return (
			resolveAgentAccountDir(
				{
					toolType: this.agentId,
					sshRemote: Boolean(sshConfig),
					customEnvVars: accountDir !== undefined ? { GROK_HOME: accountDir } : undefined,
				},
				{
					homeDir: sshConfig ? '' : os.homedir(),
					// Explicit blanks select the provider default, never the host's account.
					env: !sshConfig && accountDir === undefined ? process.env : undefined,
				}
			) ?? '~/.grok'
		);
	}

	/** Resolve the sessions base directory (local or remote POSIX tilde form). */
	private getSessionsDir(sshConfig?: SshRemoteConfig, accountDir = this.accountDir): string {
		return this.joinPath(sshConfig, this.getAccountDir(sshConfig, accountDir), 'sessions');
	}

	/** Join path segments with the separator style matching local vs remote access. */
	private joinPath(sshConfig: SshRemoteConfig | undefined, ...segments: string[]): string {
		return sshConfig ? path.posix.join(...segments) : path.join(...segments);
	}

	/** Decode a percent-encoded cwd folder name. Returns null for malformed encodings. */
	private decodeCwdFolder(name: string): string | null {
		if (!isSafeGrokPathSegment(name)) return null;
		try {
			const decoded = decodeURIComponent(name);
			// Native cwd folders encode realpaths. Dot components would let
			// /project/../other pass the project-prefix filter as a descendant.
			if (decoded.includes('\0') || /(?:^|[/\\])\.{1,2}(?:[/\\]|$)/.test(decoded)) {
				return null;
			}
			return decoded;
		} catch (error) {
			if (error instanceof URIError) return null;
			throw error;
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
			if (!isExpectedSessionReadError(error)) {
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
		sessionsDir: string,
		sshConfig?: SshRemoteConfig
	): Promise<string[]> {
		const folders = await this.listSubdirectories(
			sessionsDir,
			sshConfig,
			'grokStorage:listCwdFolders'
		);
		return folders.filter((name) => {
			const decoded = this.decodeCwdFolder(name);
			return decoded !== null && matchesProject(decoded, projectPath, Boolean(sshConfig));
		});
	}

	/** List safe native session directories (skips prompt_history.jsonl, a file). */
	private async listSessionIds(
		cwdFolder: string,
		sessionsDir: string,
		sshConfig?: SshRemoteConfig
	): Promise<string[]> {
		if (this.decodeCwdFolder(cwdFolder) === null) return [];
		const sessionIds = await this.listSubdirectories(
			this.joinPath(sshConfig, sessionsDir, cwdFolder),
			sshConfig,
			'grokStorage:listSessionIds'
		);
		return sessionIds.filter(isSafeGrokPathSegment);
	}

	/** List all Grok sessions matching the given project path, newest first. */
	async listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig,
		accountDir?: string
	): Promise<AgentSessionInfo[]> {
		const sessionsDir = this.getSessionsDir(sshConfig, accountDir);
		const cwdFolders = await this.listMatchingCwdFolders(projectPath, sessionsDir, sshConfig);

		const sessionRefs: Array<{ cwdFolder: string; sessionId: string }> = [];
		for (const cwdFolder of cwdFolders) {
			const sessionIds = await this.listSessionIds(cwdFolder, sessionsDir, sshConfig);
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
			(ref) => this.loadSessionInfo(ref.cwdFolder, ref.sessionId, sessionsDir, sshConfig)
		);

		return sessions
			.filter((session): session is AgentSessionInfo => session !== null)
			.sort((a, b) => {
				const left = Date.parse(a.modifiedAt);
				const right = Date.parse(b.modifiedAt);
				if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : 0;
				return Number.isFinite(right) ? right - left : -1;
			});
	}

	async listSessionsPaginated(
		projectPath: string,
		options?: SessionListOptions,
		sshConfig?: SshRemoteConfig
	): Promise<PaginatedSessionsResult> {
		const sessions = await this.listSessions(projectPath, sshConfig, options?.configDir);
		return BaseSessionStorage.paginateSessions(sessions, {
			...options,
			limit: Number.isFinite(options?.limit)
				? Math.min(1000, Math.max(1, Math.trunc(options!.limit!)))
				: 100,
		});
	}

	async searchSessions(
		projectPath: string,
		query: string,
		searchMode: SessionSearchMode,
		sshConfig?: SshRemoteConfig,
		accountDir?: string
	): Promise<SessionSearchResult[]> {
		if (accountDir !== undefined) {
			// Base search has no account argument. Bind one immutable reader so
			// metadata and messages agree without mutating the registered storage.
			const scoped = new GrokSessionStorage(this.getAccountDir(sshConfig, accountDir));
			return scoped.searchSessions(projectPath, query, searchMode, sshConfig);
		}
		return super.searchSessions(projectPath, query, searchMode, sshConfig);
	}

	/** Load metadata and transcript-derived info for a single session. */
	private async loadSessionInfo(
		cwdFolder: string,
		sessionId: string,
		sessionsDir: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo | null> {
		const cwd = this.decodeCwdFolder(cwdFolder);
		if (cwd === null || !isSafeGrokPathSegment(sessionId)) return null;
		const sessionDir = this.joinPath(sshConfig, sessionsDir, cwdFolder, sessionId);
		try {
			const snapshot = await this.readSessionSnapshot(sessionDir, sshConfig);
			const { summaryRead, transcriptRead, usageRead } = snapshot;
			const summaryContent = summaryRead.content;
			const nativeMetadata: NonNullable<AgentSessionInfo['nativeMetadata']> = {
				provider: 'grok',
				summaryStatus: 'unavailable',
				sources: { 'summary.json': summaryRead.source },
			};
			if (summaryContent?.trim()) {
				nativeMetadata.summaryStatus = 'invalid';
				try {
					const value: unknown = parseJsonWithBom(summaryContent);
					if (value && typeof value === 'object' && !Array.isArray(value)) {
						nativeMetadata.summary = value as Record<string, unknown>;
						nativeMetadata.summaryStatus = 'available';
					}
				} catch (error) {
					if (!(error instanceof SyntaxError) && !(error instanceof RangeError)) throw error;
					if (error instanceof RangeError) {
						summaryRead.source.status = 'unavailable';
						summaryRead.source.reason = 'too-large';
						logger.warn('Grok summary exceeds parser limits', LOG_CONTEXT);
					}
					logger.debug(`Grok session ${sessionId} has malformed summary.json`, LOG_CONTEXT);
				}
			}
			if (
				summaryRead.source.status !== 'unavailable' &&
				nativeMetadata.summaryStatus !== 'available'
			) {
				summaryRead.source.status = 'partial';
				summaryRead.source.reason ??= 'invalid-summary';
			}
			const summary = nativeMetadata.summary ?? {};

			const transcript = await this.readTranscript(sessionDir, sshConfig, false, transcriptRead);
			nativeMetadata.sources!['chat_history.jsonl'] = transcript.source;
			const parsed = transcript.parsed;
			if (!parsed) return null;
			if (parsed.messages.length === 0) {
				// Never-prompted sessions exist on disk with only system/synthetic records.
				logger.debug(
					`Skipping Grok session ${sessionId} with no conversation messages`,
					LOG_CONTEXT
				);
				return null;
			}

			const title = (
				[summary.generated_title, summary.session_summary].find(
					(value): value is string => typeof value === 'string' && value.trim().length > 0
				) ?? ''
			).trim();
			// File mtime can be a copy/restore time. It cannot establish native dates.
			const [timestamp, modifiedAt] = [summary.created_at, summary.updated_at].map((value) =>
				typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : ''
			);
			const createdMs = Date.parse(timestamp);
			const modifiedMs = Date.parse(modifiedAt);
			const durationSeconds =
				Number.isFinite(createdMs) && Number.isFinite(modifiedMs)
					? Math.max(0, Math.floor((modifiedMs - createdMs) / 1000))
					: 0;
			const preview = parsed.firstUserMessage || parsed.firstAssistantMessage || title;
			let usage: ReturnType<typeof parseGrokUsageFile> = null;
			try {
				// A changing ledger cannot supply authoritative totals, even if its
				// sampled text happens to parse. Cross-file uncertainty is applied below.
				if (usageRead.source.status === 'available') usage = parseGrokUsageFile(usageRead.content);
			} catch (error) {
				if (!(error instanceof RangeError)) throw error;
				usageRead.source.status = 'unavailable';
				usageRead.source.reason = 'too-large';
				logger.warn('Grok usage exceeds parser limits', LOG_CONTEXT);
			}
			if (usageRead.source.status !== 'unavailable' && !usage) {
				usageRead.source.status = 'partial';
				usageRead.source.reason ??= 'invalid-usage';
			}
			nativeMetadata.sources!['usage.json'] = usageRead.source;
			// Read only for a session that lists, after the three-file comparison:
			// the prompt inputs are written once per process build and are optional
			// (older sessions predate them), so an absent file never marks the
			// snapshot as changing. The cross-file reason below still applies to it.
			const promptContextRead = await this.readSessionFile(
				this.joinPath(sshConfig, sessionDir, 'prompt_context.json'),
				sshConfig
			);
			if (promptContextRead.source.status === 'available') {
				const nativeMemory = parseGrokPromptContext(promptContextRead.content, {
					accountRoot: sshConfig ? path.posix.dirname(sessionsDir) : path.dirname(sessionsDir),
					projectRoot: cwd,
					isRemote: Boolean(sshConfig),
				});
				if (nativeMemory) {
					nativeMetadata.nativeMemory = nativeMemory;
				} else {
					promptContextRead.source.status = 'partial';
					promptContextRead.source.reason = 'invalid-prompt-context';
					logger.debug(`Grok session ${sessionId} has malformed prompt_context.json`, LOG_CONTEXT);
				}
			}
			// A missing file (read as unreadable) adds no source: the session lists
			// exactly as it did before the file existed. Any other outcome is shown.
			if (
				promptContextRead.source.status !== 'unavailable' ||
				promptContextRead.source.reason !== 'unreadable'
			) {
				nativeMetadata.sources!['prompt_context.json'] = promptContextRead.source;
			}
			// Grok commits each file separately, with no shared commit marker. Even
			// two identical samples cannot bind usage or summary to this transcript.
			// Preserve stronger per-file failure reasons while disclosing that limit
			// on every otherwise available member of this combined observation.
			for (const source of Object.values(nativeMetadata.sources!)) {
				if (source.status === 'available') {
					source.status = 'partial';
					source.reason = snapshot.reason;
				}
			}
			if (usage) {
				for (const detail of [usage.accounting, ...(usage.accounting.models ?? [])]) {
					if (detail.completeness === 'complete') detail.completeness = 'partial';
					if (detail.cost.status === 'exact') {
						detail.cost = { ...detail.cost, status: 'partial', reason: snapshot.reason };
					}
				}
				// This legacy split cannot represent uncertain model accounting. Raw
				// model identities, buckets and tick strings remain in accounting.models.
				usage.byModel = [];
			}

			return {
				// Search/read must address the directory we validated, even when a
				// stale or malformed summary names another session or project.
				sessionId,
				projectPath: cwd,
				timestamp,
				modifiedAt,
				firstMessage: preview.slice(0, FIRST_MESSAGE_PREVIEW_LENGTH),
				messageCount: parsed.messages.length,
				sizeBytes: transcript.source.sizeBytes ?? 0,
				nativeMetadata,
				// Required numeric fields retain compatibility; accounting explicitly
				// marks absent legacy ledgers unknown, never a measured zero.
				inputTokens: usage?.inputTokens ?? 0,
				outputTokens: usage?.outputTokens ?? 0,
				...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
				cacheReadTokens: usage?.cacheReadTokens ?? 0,
				cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
				...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
				...(usage?.byModel.length ? { byModel: usage.byModel } : {}),
				accounting: {
					...(usage?.accounting ?? {
						source: 'none',
						route: 'native-history',
						scope: 'native-session',
						reporting: 'snapshot',
						cacheReadCounting: 'beside-input',
						cacheCreationCounting: 'beside-input',
						completeness: 'unknown',
						cost: { status: 'unknown', reason: 'Native usage unavailable' },
						childInclusion: 'unknown',
						childCompleteness: 'unknown',
					}),
					// Forks can inherit an older usage.sessionId; only the directory
					// identifies the session whose lifetime snapshot was read.
					providerSessionId: sessionId,
				},
				durationSeconds,
				sessionName: title || undefined,
			};
		} catch (error) {
			if (isExpectedSessionReadError(error)) {
				logger.debug(`Expected failure loading Grok session ${sessionId}`, LOG_CONTEXT, { error });
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
	 * Legacy browsing includes descendant cwd folders. Scoped reads use exact
	 * physical-source observation below instead of treating discovery as proof.
	 */
	private async findSessionDir(
		projectPath: string,
		sessionId: string,
		sessionsDir: string,
		sshConfig?: SshRemoteConfig
	): Promise<string | null> {
		if (!isSafeGrokPathSegment(sessionId)) return null;
		const cwdFolders = await this.listMatchingCwdFolders(projectPath, sessionsDir, sshConfig);
		for (const cwdFolder of cwdFolders) {
			const sessionIds = await this.listSessionIds(cwdFolder, sessionsDir, sshConfig);
			if (sessionIds.includes(sessionId)) {
				return this.joinPath(sshConfig, sessionsDir, cwdFolder, sessionId);
			}
		}
		return null;
	}

	/** Observe a physical object without opening its contents. Identity is separate
	 * from size/mtime: appending to a transcript changes completeness, not ownership.
	 */
	private async observeNativePath(
		requested: string,
		directory: boolean,
		sshConfig?: SshRemoteConfig
	) {
		if (sshConfig) {
			const observed = await observePathRemote(requested, sshConfig);
			if (!observed.success || !observed.data) {
				if (!observed.errorCode && !isExpectedRemoteError(observed.error)) {
					captureException(new Error(observed.error || 'observePathRemote failed'), {
						operation: 'grokStorage:observeNativeSource',
					});
				}
				return null;
			}
			if (observed.data.kind !== (directory ? 'directory' : 'file')) return null;
			return {
				requested,
				physical: observed.data.canonicalPath,
				directory,
				dev: observed.data.device,
				ino: observed.data.inode,
			};
		}
		const physical = await fs.realpath(requested);
		const stat = await fs.stat(physical);
		if (
			!(directory ? stat.isDirectory() : stat.isFile()) ||
			!Number.isSafeInteger(stat.dev) ||
			!Number.isSafeInteger(stat.ino) ||
			stat.dev < 0 ||
			stat.ino <= 0
		) {
			return null;
		}
		return { requested, physical, directory, dev: String(stat.dev), ino: String(stat.ino) };
	}

	/** Exact physical cwd only. Descendant folders are useful for browsing, but
	 * cannot establish ownership of a retained native session. Directory aliases
	 * participate in ambiguity checks even when they point at the same object.
	 */
	private async findBoundSessionCandidates(
		sessionsDir: string,
		cwd: string,
		sessionId: string,
		sshConfig?: SshRemoteConfig
	) {
		const candidates: string[] = [];
		const paths = sshConfig ? path.posix : path;
		const remoteEntries = sshConfig ? await readDirRemote(sessionsDir, sshConfig) : undefined;
		if (
			sshConfig &&
			(!remoteEntries?.success || !remoteEntries.data || remoteEntries.data.length > 1000)
		) {
			if (remoteEntries && !remoteEntries.success && !isExpectedRemoteError(remoteEntries.error)) {
				captureException(new Error(remoteEntries.error || 'readDirRemote failed'), {
					operation: 'grokStorage:observeNativeCandidates',
				});
			}
			return null; // An incomplete enumeration cannot prove uniqueness.
		}
		const entries = sshConfig
			? remoteEntries!.data!
			: await fs.readdir(sessionsDir, { withFileTypes: true });
		for (const entry of entries) {
			const directory =
				typeof entry.isDirectory === 'function' ? entry.isDirectory() : entry.isDirectory;
			const symlink = 'isSymlink' in entry ? entry.isSymlink : entry.isSymbolicLink();
			if (!directory && !symlink) continue;
			const decoded = this.decodeCwdFolder(entry.name);
			if (decoded === null || !paths.isAbsolute(decoded)) continue;
			try {
				const project = await this.observeNativePath(decoded, true, sshConfig);
				if (sshConfig && !project) return null;
				if (project?.physical !== cwd) continue;
				const folder = paths.join(sessionsDir, entry.name);
				const candidate = paths.join(folder, sessionId);
				// Count dangling/non-directory candidates too; a bad duplicate never
				// authorizes opening another candidate with the same native ID.
				if (sshConfig) {
					const children = await readDirRemote(folder, sshConfig);
					if (!children.success || !children.data) {
						if (!isExpectedRemoteError(children.error))
							captureException(new Error(children.error || 'readDirRemote failed'), {
								operation: 'grokStorage:observeNativeCandidates',
							});
						return null;
					}
					if (!children.data.some((child) => child.name === sessionId)) continue;
				} else {
					await fs.lstat(candidate);
				}
				candidates.push(candidate);
				if (candidates.length > 1) return candidates;
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
				throw error;
			}
		}
		return candidates;
	}

	/** A host-observed binding is a constraint, never evidence by itself. Pin the
	 * actual source before reading and compare the opened descriptor too.
	 * The caller owns executing-host observation and its post-read endpoint fence.
	 */
	private async readBoundTranscript(
		projectPath: string,
		sessionId: string,
		options: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<
		Awaited<ReturnType<GrokSessionStorage['readTranscript']>> & {
			nativeSessionBinding?: NativeSessionBinding;
		}
	> {
		const unavailable = (reason: string) => ({
			parsed: null,
			source: { provider: 'grok' as const, status: 'unavailable' as const, reason },
		});
		const supplied = options.nativeSessionBinding;
		const accountDir = options.configDir !== undefined ? options.configDir : this.accountDir;
		const text = (value: unknown): value is string =>
			typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
		if (
			!supplied ||
			supplied.version !== 1 ||
			supplied.state !== 'bound' ||
			supplied.provider !== 'grok' ||
			supplied.nativeSessionId !== sessionId ||
			!isSafeGrokPathSegment(sessionId) ||
			!text(supplied.accountRef) ||
			!text(supplied.cwd) ||
			!text(projectPath) ||
			!text(supplied.host?.identity) ||
			supplied.host.kind !== (sshConfig ? 'ssh' : 'local') ||
			typeof accountDir !== 'string' ||
			accountDir.includes('\0')
		) {
			return unavailable('native-source-binding-invalid');
		}
		const paths = sshConfig ? path.posix : path;
		if (!paths.isAbsolute(projectPath) || !paths.isAbsolute(supplied.cwd)) {
			return unavailable('native-source-binding-invalid');
		}
		const binding: Extract<NativeSessionBinding, { state: 'bound' }> = {
			version: 1,
			state: 'bound',
			provider: 'grok',
			nativeSessionId: sessionId,
			accountRef: supplied.accountRef,
			cwd: supplied.cwd,
			host: { kind: supplied.host.kind, identity: supplied.host.identity },
		};
		const includeNativeRecords = options.includeNativeRecords;
		try {
			const account = await this.observeNativePath(
				this.getAccountDir(sshConfig, accountDir),
				true,
				sshConfig
			);
			const project = await this.observeNativePath(projectPath, true, sshConfig);
			if (
				!account ||
				!project ||
				project.physical !== binding.cwd ||
				nativeAccountRef('grok', account.physical) !== binding.accountRef
			) {
				return unavailable('native-source-scope-mismatch');
			}
			// Accounts can intentionally share a symlinked sessions pool. Pin that
			// selected subtree independently; never replace the selected accountRef.
			const sessions = await this.observeNativePath(
				paths.join(account.physical, 'sessions'),
				true,
				sshConfig
			);
			if (!sessions) return unavailable('native-source-unobserved');
			const candidates = await this.findBoundSessionCandidates(
				sessions.physical,
				project.physical,
				sessionId,
				sshConfig
			);
			if (!candidates) return unavailable('native-source-unobserved');
			if (candidates.length !== 1) {
				return unavailable(candidates.length ? 'native-source-ambiguous' : 'session-not-found');
			}
			const candidate = candidates[0];
			const folder = await this.observeNativePath(paths.dirname(candidate), true, sshConfig);
			const session = await this.observeNativePath(candidate, true, sshConfig);
			if (
				!folder ||
				!session ||
				paths.dirname(folder.physical) !== sessions.physical ||
				paths.dirname(session.physical) !== folder.physical ||
				paths.basename(session.physical) !== sessionId
			) {
				return unavailable('native-source-scope-mismatch');
			}
			// Both logical and physical encoded cwd names must belong to this cwd.
			const sourceProjects = [];
			for (const directory of [paths.dirname(candidate), folder.physical]) {
				const decoded = this.decodeCwdFolder(paths.basename(directory));
				if (decoded === null || !paths.isAbsolute(decoded)) {
					return unavailable('native-source-scope-mismatch');
				}
				const observed = await this.observeNativePath(decoded, true, sshConfig);
				if (observed?.physical !== project.physical) {
					return unavailable('native-source-scope-mismatch');
				}
				sourceProjects.push(observed);
			}
			const file = await this.observeNativePath(
				paths.join(session.physical, 'chat_history.jsonl'),
				false,
				sshConfig
			);
			if (!file || paths.dirname(file.physical) !== session.physical) {
				return unavailable('native-source-scope-mismatch');
			}
			const observations = [account, project, sessions, folder, session, ...sourceProjects, file];
			const recheck = async () => {
				const currentCandidates = await this.findBoundSessionCandidates(
					sessions.physical,
					project.physical,
					sessionId,
					sshConfig
				);
				if (
					!currentCandidates ||
					currentCandidates.length !== 1 ||
					currentCandidates[0] !== candidate
				)
					return false;
				for (const original of observations) {
					const current = await this.observeNativePath(
						original.requested,
						original.directory,
						sshConfig
					);
					if (
						!current ||
						current.physical !== original.physical ||
						current.dev !== original.dev ||
						current.ino !== original.ino
					)
						return false;
				}
				return true;
			};
			if (!(await recheck())) return unavailable('native-source-changed');
			const read = await this.readSessionFile(file.physical, sshConfig, MAX_SESSION_FILE_SIZE, {
				dev: file.dev,
				ino: file.ino,
				recheck,
				remotePaths: sshConfig
					? observations.map((observed) => ({
							path: observed.requested,
							identity: {
								canonicalPath: observed.physical,
								device: observed.dev,
								inode: observed.ino,
								kind: observed.directory ? ('directory' as const) : ('file' as const),
							},
						}))
					: undefined,
			});
			if (read.source.reason === 'native-source-changed' || !(await recheck())) {
				return unavailable('native-source-changed');
			}
			return {
				...(await this.readTranscript(session.physical, sshConfig, includeNativeRecords, read)),
				...(!sshConfig || read.identityVerified ? { nativeSessionBinding: binding } : {}),
			};
		} catch (error) {
			// A dangling/cyclic alias is unavailable, not a reason to try another account.
			if (
				!isExpectedSessionReadError(error) &&
				(error as NodeJS.ErrnoException)?.code !== 'ELOOP'
			) {
				captureException(error, { operation: 'grokStorage:observeNativeSource' });
			}
			return unavailable('native-source-unobserved');
		}
	}

	/** Read messages from a Grok session's chat_history.jsonl file. */
	async readSessionMessages(
		projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		if (options?.content !== undefined) {
			return BaseSessionStorage.applyMessagePagination(
				parseChatHistory(options.content).messages,
				options
			);
		}
		const scoped = options?.nativeSessionBinding !== undefined;
		const sessionDir = scoped
			? null
			: options?.filePath
				? path.dirname(options.filePath)
				: await this.findSessionDir(
						projectPath,
						sessionId,
						this.getSessionsDir(sshConfig, options?.configDir),
						sshConfig
					);
		if (!scoped && !sessionDir) {
			logger.warn(`Grok session not found for project: ${sessionId}`, LOG_CONTEXT);
			return {
				messages: [],
				total: 0,
				hasMore: false,
				source: { provider: 'grok', status: 'unavailable', reason: 'session-not-found' },
			};
		}

		const transcript: Awaited<ReturnType<GrokSessionStorage['readBoundTranscript']>> = scoped
			? await this.readBoundTranscript(projectPath, sessionId, options!, sshConfig)
			: await this.readTranscript(sessionDir!, sshConfig, options?.includeNativeRecords);
		const receipt = transcript.nativeSessionBinding
			? { nativeSessionBinding: transcript.nativeSessionBinding }
			: {};
		if (!transcript.parsed) {
			return { messages: [], total: 0, hasMore: false, source: transcript.source, ...receipt };
		}

		const { messages } = transcript.parsed;
		return {
			...BaseSessionStorage.applyMessagePagination(messages, {
				...options,
				offset: Number.isFinite(options?.offset)
					? Math.min(messages.length, Math.max(0, Math.trunc(options!.offset!)))
					: 0,
				limit: Number.isFinite(options?.limit)
					? Math.min(1000, Math.max(1, Math.trunc(options!.limit!)))
					: 20,
			}),
			source: transcript.source,
			...receipt,
		};
	}

	/** Get searchable user/assistant messages for session search. */
	protected async getSearchableMessages(
		sessionId: string,
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		const sessionDir = await this.findSessionDir(
			projectPath,
			sessionId,
			this.getSessionsDir(sshConfig),
			sshConfig
		);
		if (!sessionDir) return [];

		const transcript = await this.readTranscript(sessionDir, sshConfig);
		if (!transcript.parsed) return [];

		return transcript.parsed.messages
			.filter((message) => message.role === 'user' || message.role === 'assistant')
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
		sshConfig?: SshRemoteConfig,
		accountDir?: string
	): string | null {
		if (!isSafeGrokPathSegment(sessionId)) {
			return null;
		}
		let encoded: string;
		try {
			encoded = encodeURIComponent(toGrokRecordedCwd(projectPath, Boolean(sshConfig)));
		} catch (error) {
			if (error instanceof URIError) return null;
			throw error;
		}
		if (this.decodeCwdFolder(encoded) === null) return null;
		return this.joinPath(
			sshConfig,
			this.getSessionsDir(sshConfig, accountDir),
			encoded,
			sessionId,
			'chat_history.jsonl'
		);
	}

	/**
	 * Delete a message pair. Not supported for Grok sessions: editing
	 * chat_history.jsonl would desync summary.json counts, events.jsonl, and
	 * the sqlite FTS index the live Grok leader process maintains.
	 * Native whole-session deletion and prompt-index rewind are not pair edits;
	 * neither has a qualified, account/host-bound Maestro mutation transport.
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
			error:
				'Deleting or editing Grok session history is not supported in Maestro. A verified native transaction is required to keep its transcript and indexes consistent. History is unchanged.',
		};
	}

	/**
	 * Sample the three native files, then compare exactly one bounded reread of
	 * each. No idle polling, writer locks or cache: observations are confined to
	 * this account directory and SSH target. Comparing content also detects
	 * equal-size remote rewrites inside statRemote's one-second timestamp window.
	 */
	private async readSessionSnapshot(sessionDir: string, sshConfig?: SshRemoteConfig) {
		const summaryRead = await this.readSessionFile(
			this.joinPath(sshConfig, sessionDir, 'summary.json'),
			sshConfig
		);
		const transcriptRead = await this.readSessionFile(
			this.joinPath(sshConfig, sessionDir, 'chat_history.jsonl'),
			sshConfig,
			MAX_SESSION_FILE_SIZE
		);
		const usageRead = await this.readSessionFile(
			this.joinPath(sshConfig, sessionDir, 'usage.json'),
			sshConfig
		);
		let reason = 'cross-file-generation-unverified';
		for (const [name, original] of [
			['summary.json', summaryRead],
			['chat_history.jsonl', transcriptRead],
			['usage.json', usageRead],
		] as const) {
			if (
				!(await this.isSessionFileSampleStable(
					this.joinPath(sshConfig, sessionDir, name),
					original,
					sshConfig
				))
			) {
				reason = 'changed-or-unavailable-during-snapshot';
			}
		}
		return { summaryRead, transcriptRead, usageRead, reason };
	}

	/** Compare bounded samples without treating matching stats as matching bytes. */
	private async isSessionFileSampleStable(
		filePath: string,
		original: Awaited<ReturnType<GrokSessionStorage['readSessionFile']>>,
		sshConfig?: SshRemoteConfig
	): Promise<boolean> {
		const recheck = await this.readSessionFile(filePath, sshConfig, original.source.maxBytes);
		return (
			original.source.status === 'available' &&
			recheck.source.status === 'available' &&
			original.content === recheck.content &&
			original.generation === recheck.generation
		);
	}

	/** Read and normalize one bounded transcript; rejection is never an empty success. */
	private async readTranscript(
		sessionDir: string,
		sshConfig?: SshRemoteConfig,
		includeNativeRecords = false,
		read?: Awaited<ReturnType<GrokSessionStorage['readSessionFile']>>
	): Promise<{
		parsed: ParsedGrokChatHistory | null;
		source: NonNullable<SessionMessagesResult['source']>;
	}> {
		if (!read) {
			const filePath = this.joinPath(sshConfig, sessionDir, 'chat_history.jsonl');
			read = await this.readSessionFile(filePath, sshConfig, MAX_SESSION_FILE_SIZE);
			if (
				sshConfig &&
				read.source.status === 'available' &&
				!(await this.isSessionFileSampleStable(filePath, read, sshConfig))
			) {
				read.source.status = 'partial';
				read.source.reason = 'changed-or-unavailable-during-read';
			}
		}
		if (read.content === null) return { parsed: null, source: read.source };
		// Byte limits alone still permit millions of tiny rows. Count physical
		// lines without allocating split arrays, before the shared parser does so.
		let lineCount = 1;
		for (
			let index = read.content.indexOf('\n');
			index >= 0;
			index = read.content.indexOf('\n', index + 1)
		) {
			if (++lineCount > MAX_SESSION_SOURCE_LINES) {
				logger.warn('Grok transcript exceeds source line limit', LOG_CONTEXT);
				return {
					parsed: null,
					source: { ...read.source, status: 'unavailable', reason: 'too-many-lines' },
				};
			}
		}
		try {
			const parsed = parseChatHistory(read.content, includeNativeRecords);
			if (parsed.hasMalformedRecords) {
				read.source.status = 'partial';
				read.source.reason ??= 'malformed-records';
			}
			return { parsed, source: read.source };
		} catch (error) {
			if (!(error instanceof RangeError)) throw error;
			logger.warn('Grok transcript exceeds parser limits', LOG_CONTEXT);
			return {
				parsed: null,
				source: { ...read.source, status: 'unavailable', reason: 'too-large' },
			};
		}
	}

	/** A stat guards allocation; the bounded read also guards growth after that stat. */
	private async readSessionFile(
		filePath: string,
		sshConfig?: SshRemoteConfig,
		maxBytes = MAX_SESSION_METADATA_SIZE,
		ownership?: {
			dev: string;
			ino: string;
			recheck: () => Promise<boolean>;
			remotePaths?: Array<{ path: string; identity: RemotePathIdentity }>;
		}
	): Promise<{
		content: string | null;
		source: NonNullable<SessionMessagesResult['source']>;
		generation?: string;
		identityVerified?: boolean;
	}> {
		const source: NonNullable<SessionMessagesResult['source']> = {
			provider: 'grok',
			status: 'unavailable',
			maxBytes,
		};
		let identityVerified = false;
		const unavailable = (reason: string) => {
			source.status = 'unavailable';
			source.reason = reason;
			if (reason === 'too-large')
				logger.warn('Grok session file exceeds read limit', LOG_CONTEXT, { filePath, maxBytes });
			return { content: null, source, identityVerified };
		};
		try {
			let content: string;
			let generation: string;
			if (sshConfig) {
				const before = await statRemote(filePath, sshConfig);
				if (!before.success || !before.data) {
					if (!isExpectedRemoteError(before.error)) {
						captureException(new Error(before.error || 'statRemote failed'), {
							operation: 'grokStorage:statSessionFile',
							filePath,
						});
					}
					return unavailable('unreadable');
				}
				source.sizeBytes = before.data.size;
				generation = `${before.data.size}:${before.data.mtime}`;
				if (before.data.isDirectory) return unavailable('not-a-file');
				if (!Number.isSafeInteger(before.data.size) || before.data.size < 0)
					return unavailable('invalid-size');
				if (before.data.size > maxBytes && !ownership) return unavailable('too-large');
				if (ownership && !(await ownership.recheck())) return unavailable('native-source-changed');
				const read = await readFileRemote(filePath, sshConfig, undefined, {
					maxBytes,
					...(ownership
						? {
								expectedIdentity: {
									canonicalPath: filePath,
									device: ownership.dev,
									inode: ownership.ino,
									kind: 'file' as const,
								},
								expectedPaths: ownership.remotePaths,
							}
						: {}),
				});
				identityVerified = Boolean(
					ownership &&
					read.observedIdentity &&
					read.observedIdentity.canonicalPath === filePath &&
					read.observedIdentity.device === ownership.dev &&
					read.observedIdentity.inode === ownership.ino &&
					read.observedIdentity.kind === 'file'
				);
				if (ownership && !identityVerified) {
					if (!read.errorCode && !isExpectedRemoteError(read.error)) {
						captureException(new Error(read.error || 'readFileRemote failed'), {
							operation: 'grokStorage:readSessionFile',
							filePath,
						});
					}
					return unavailable(
						read.errorCode === 'identity-mismatch'
							? 'native-source-changed'
							: 'native-source-unobserved'
					);
				}
				if (read.contentChanged) {
					source.status = 'partial';
					source.reason = 'changed-during-read';
				}
				if (!read.success || read.data === undefined) {
					if (read.errorCode === 'too-large') return unavailable('too-large');
					if (read.errorCode === 'invalid-encoding') return unavailable('invalid-encoding');
					if (!isExpectedRemoteError(read.error)) {
						captureException(new Error(read.error || 'readFileRemote failed'), {
							operation: 'grokStorage:readSessionFile',
							filePath,
						});
					}
					return unavailable('unreadable');
				}
				content = read.data;
				// Check actual output as well as stat, including injected remote transports.
				if (Buffer.byteLength(content, 'utf8') > maxBytes) return unavailable('too-large');
				const after = await statRemote(filePath, sshConfig);
				if (!after.success || !after.data) {
					if (!isExpectedRemoteError(after.error)) {
						captureException(new Error(after.error || 'statRemote failed'), {
							operation: 'grokStorage:statSessionFile',
							filePath,
						});
					}
					source.status = 'partial';
					source.reason = 'post-read-stat-unavailable';
				} else {
					if (!Number.isSafeInteger(after.data.size) || after.data.size < 0)
						return unavailable('invalid-size');
					if (after.data.size > maxBytes) return unavailable('too-large');
					if (
						after.data.isDirectory ||
						after.data.size !== before.data.size ||
						after.data.mtime !== before.data.mtime ||
						Buffer.byteLength(content, 'utf8') !== before.data.size
					) {
						source.status = 'partial';
						source.reason = 'changed-during-read';
					}
				}
			} else {
				// Reject special files before open; O_NONBLOCK also avoids hanging if a
				// regular file is replaced with a FIFO between stat and open.
				const before = await fs.stat(filePath);
				if (
					ownership &&
					(String(before.dev) !== ownership.dev || String(before.ino) !== ownership.ino)
				) {
					return unavailable('native-source-changed');
				}
				source.sizeBytes = before.size;
				generation = [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(
					':'
				);
				if (!before.isFile()) return unavailable('not-a-file');
				if (before.size > maxBytes) return unavailable('too-large');
				const handle = await fs.open(
					filePath,
					fs.constants.O_RDONLY |
						fs.constants.O_NONBLOCK |
						(ownership ? fs.constants.O_NOFOLLOW : 0)
				);
				try {
					const opened = await handle.stat();
					if (!opened.isFile()) return unavailable('not-a-file');
					if (
						ownership &&
						(String(opened.dev) !== ownership.dev ||
							String(opened.ino) !== ownership.ino ||
							!(await ownership.recheck()))
					) {
						return unavailable('native-source-changed');
					}
					if (opened.size > maxBytes) return unavailable('too-large');
					const chunks: Buffer[] = [];
					let total = 0;
					while (total <= maxBytes) {
						const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
						const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
						if (bytesRead === 0) break;
						total += bytesRead;
						if (total > maxBytes) return unavailable('too-large');
						chunks.push(chunk.subarray(0, bytesRead));
					}
					const after = await handle.stat();
					if (after.size > maxBytes) return unavailable('too-large');
					const bytes = Buffer.concat(chunks, total);
					// Validate the original bytes together so split multibyte characters
					// remain valid. Lossy decoding can preserve byte length (F0 90 80).
					const validUtf8 = isUtf8(bytes);
					content = bytes.toString('utf8');
					source.sizeBytes = total;
					if (
						opened.size !== after.size ||
						opened.mtimeMs !== after.mtimeMs ||
						opened.ctimeMs !== after.ctimeMs ||
						opened.size !== total ||
						!validUtf8 ||
						before.ino !== opened.ino ||
						before.dev !== opened.dev ||
						before.size !== opened.size ||
						before.mtimeMs !== opened.mtimeMs ||
						before.ctimeMs !== opened.ctimeMs
					) {
						source.status = 'partial';
						source.reason = 'changed-during-read';
					}
					// Atomic rename leaves the old open descriptor unchanged. Recheck
					// the pathname too, without touching the provider's writer lock.
					try {
						const current = await fs.stat(filePath);
						if (current.size > maxBytes) return unavailable('too-large');
						if (
							!current.isFile() ||
							current.dev !== after.dev ||
							current.ino !== after.ino ||
							current.size !== after.size ||
							current.mtimeMs !== after.mtimeMs ||
							current.ctimeMs !== after.ctimeMs
						) {
							source.status = 'partial';
							source.reason ??= 'changed-during-read';
						}
					} catch (error) {
						if (error instanceof RangeError) throw error;
						if (!isExpectedSessionReadError(error)) {
							captureException(error, { operation: 'grokStorage:statSessionFile', filePath });
						}
						source.status = 'partial';
						source.reason ??= 'post-read-stat-unavailable';
					}
				} finally {
					await handle.close();
				}
			}
			if (!source.reason) source.status = 'available';
			return { content, source, generation, identityVerified };
		} catch (error) {
			if (error instanceof RangeError) return unavailable('too-large');
			if (
				!isExpectedSessionReadError(error) &&
				!(ownership && (error as NodeJS.ErrnoException)?.code === 'ELOOP')
			) {
				captureException(error, { operation: 'grokStorage:readSessionFile', filePath });
			} else {
				logger.debug('Grok session file not readable', LOG_CONTEXT, { filePath, error });
			}
			return unavailable('unreadable');
		}
	}
}
