import { canonicalJson } from '../../canonicalJson';
import { parseJsonWithBom } from '../../jsonUtils';
import * as path from 'node:path';
import { hasEmbeddedSystemPrompt, stripEmbeddedSystemPrompt } from '../../embeddedSystemPrompt';
import { translationArtifact, translationHash } from './identity';
import { parseBase64DataUrl } from '../../dataUrl';
import type {
	PortableBlock,
	PortableConversation,
	PortableRecord,
	TranslationIdentity,
} from './types';

export interface NativeLine {
	line: string;
	index: number;
	entry: Record<string, any> | null;
	malformed: boolean;
}

/** History readers may skip malformed rows; migration must report and archive them. */
export function parseNativeLines(content: string): NativeLine[] {
	return content.split('\n').flatMap((line, index) => {
		if (!line.trim()) return [];
		try {
			const entry = JSON.parse(line);
			return [
				{
					line,
					index,
					entry: entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null,
					malformed: !entry || typeof entry !== 'object' || Array.isArray(entry),
				},
			];
		} catch {
			return [{ line, index, entry: null, malformed: true }];
		}
	});
}

export function extractNativeConversation(
	identity: TranslationIdentity,
	tabId: string,
	sessionId: string,
	bytes: Buffer
): PortableConversation {
	const conversation: PortableConversation = {
		tabId,
		nativeSessionId: sessionId,
		identity,
		records: [],
		artifacts: [
			translationArtifact(
				'transcript',
				`${identity.provider}:${sessionId}`,
				`${sessionId}.jsonl`,
				bytes
			),
		],
		limitations: [],
	};
	const rows = parseNativeLines(bytes.toString('utf8'));
	const nativeIds = new Set<string>();
	for (const row of rows) {
		const entry = row.entry ?? { type: 'malformed', raw: row.line };
		if (row.malformed)
			conversation.limitations.push({
				code: 'malformed-native-record',
				severity: 'block',
				tabId,
				message: `Native record ${row.index} cannot be parsed; original bytes are preserved.`,
			});
		const payload =
			identity.provider === 'codex' && entry.type === 'response_item'
				? (entry.payload ?? {})
				: entry;
		const message = identity.provider === 'claude-code' ? (entry.message ?? {}) : payload;
		const declaredCwd = entry.type === 'session_meta' ? entry.payload?.cwd : entry.cwd;
		if (
			typeof declaredCwd === 'string' &&
			path.resolve(declaredCwd) !== path.resolve(identity.projectRoot)
		)
			conversation.limitations.push({
				code: 'native-project-root-mismatch',
				severity: 'block',
				tabId,
				message:
					'Selected native records belong to a different project root. Resolve their ownership before migration.',
			});
		const declaredSession =
			entry.type === 'session_meta' ? (entry.payload?.id ?? entry.id) : entry.sessionId;
		if (typeof declaredSession === 'string' && declaredSession !== sessionId)
			conversation.limitations.push({
				code: 'native-session-mismatch',
				severity: 'block',
				tabId,
				message: 'Native transcript identity does not match the selected conversation.',
			});
		const candidateId = identity.provider === 'claude-code' ? entry.uuid : (payload.id ?? entry.id);
		// Legacy Codex rows often have no ID. Position is stable only while the source is append-only.
		const nativeId = typeof candidateId === 'string' ? candidateId : `line:${row.index}`;
		if (nativeIds.has(nativeId))
			conversation.limitations.push({
				code: 'duplicate-native-id',
				severity: 'block',
				tabId,
				message: `Native identity ${nativeId} occurs more than once.`,
			});
		nativeIds.add(nativeId);
		const origin = {
			provider: identity.provider,
			account: translationHash(identity.accountRoot),
			sessionId,
			eventId: nativeId,
		};
		const blocks: PortableBlock[] = [];
		let role: PortableRecord['role'];
		const isClaudeMessage =
			identity.provider === 'claude-code' && (entry.type === 'user' || entry.type === 'assistant');
		const isCodexMessage = identity.provider === 'codex' && payload.type === 'message';
		if (isClaudeMessage || isCodexMessage) {
			role = message.role ?? entry.type;
			if (!['user', 'assistant', 'system', 'developer'].includes(role ?? '')) role = undefined;
			const content =
				typeof message.content === 'string'
					? [{ type: 'text', text: message.content }]
					: (message.content ?? []);
			if (!Array.isArray(content))
				conversation.limitations.push({
					code: 'invalid-content',
					severity: 'block',
					tabId,
					message: `Unsupported content shape at ${nativeId}.`,
				});
			for (const block of Array.isArray(content) ? content : []) {
				if (typeof block !== 'object' || !block) {
					blocks.push({ kind: 'opaque', native: block });
					continue;
				}
				switch (block.type) {
					case 'text':
					case 'input_text':
					case 'output_text': {
						const text = typeof block.text === 'string' ? block.text : '';
						if (role === 'user' && hasEmbeddedSystemPrompt(text)) {
							blocks.push({ kind: 'opaque', native: { type: 'historical-system-envelope', text } });
							conversation.limitations.push({
								code: 'historical-instructions',
								severity: 'warning',
								tabId,
								message: `Embedded system instructions at ${nativeId} are archived separately from the user's own request.`,
							});
							blocks.push({ kind: 'text', text: stripEmbeddedSystemPrompt(text) });
						} else blocks.push({ kind: 'text', text });
						break;
					}
					case 'tool_use':
						blocks.push({
							kind: 'tool-call',
							callId: block.id,
							name: block.name,
							input: block.input,
						});
						break;
					case 'tool_result':
						blocks.push({
							kind: 'tool-result',
							callId: block.tool_use_id,
							output: block.content,
							isError: block.is_error,
						});
						break;
					case 'image':
					case 'input_image': {
						const dataUrl =
							typeof block.image_url === 'string' ? parseBase64DataUrl(block.image_url) : null;
						const data = block.source?.type === 'base64' ? block.source.data : dataUrl?.base64;
						const mediaType =
							block.source?.media_type ?? dataUrl?.mediaType ?? 'application/octet-stream';
						const id = pushImageAttachment(conversation, origin, blocks, data, mediaType, block);
						if (role === 'assistant')
							conversation.limitations.push({
								code: 'assistant-attachment',
								severity: 'warning',
								tabId,
								artifactId: id,
								message:
									'Assistant image evidence is archived; foreign Responses image-output semantics are not supported.',
							});
						break;
					}
					default:
						blocks.push({ kind: 'opaque', native: block });
				}
			}
		} else if (identity.provider === 'codex' && entry.type === 'response_item') {
			switch (payload.type) {
				case 'function_call':
				case 'custom_tool_call':
					role = 'assistant';
					blocks.push({
						kind: 'tool-call',
						callId: payload.call_id,
						name: payload.name,
						input: payload.type === 'custom_tool_call' ? payload.input : payload.arguments,
						custom: payload.type === 'custom_tool_call',
					});
					break;
				case 'function_call_output':
				case 'custom_tool_call_output':
					role = 'user';
					blocks.push({
						kind: 'tool-result',
						callId: payload.call_id,
						output: payload.output,
						custom: payload.type === 'custom_tool_call_output',
					});
					break;
				default:
					blocks.push({ kind: 'opaque', native: payload });
			}
		} else blocks.push({ kind: 'opaque', native: entry });
		// UI event projections are retained as evidence, never injected a second time.
		const boundary =
			entry.type === 'compacted' || entry.subtype === 'compact_boundary'
				? 'compaction'
				: entry.type === 'fork'
					? 'fork'
					: undefined;
		const record: PortableRecord = {
			origin,
			nativeId,
			sequence: row.index,
			role,
			blocks,
			semanticHash: translationHash(canonicalJson(entry)),
			native: entry,
			parentId: entry.parentUuid ?? entry.parent_id,
			branchId: entry.branchId ?? entry.forked_from_id,
			timestamp: entry.timestamp,
			phase: message.phase,
			boundary,
		};
		conversation.records.push(record);
		pushRecordLimitations(conversation, record, entry);
	}
	finishConversation(conversation);
	return conversation;
}

/** Per-record limitations every native extractor shares (opaque state, instructions, boundaries). */
function pushRecordLimitations(
	conversation: PortableConversation,
	record: PortableRecord,
	entry: Record<string, any>
): void {
	if (entry.type === 'attachment')
		conversation.limitations.push({
			code: 'native-attachment-state',
			severity: 'warning',
			tabId: conversation.tabId,
			message: `Native attachment record ${record.nativeId} is archived; provider-specific runtime attachment discovery is unverified.`,
		});
	if (
		record.blocks.some((b) => b.kind === 'opaque') &&
		(record.role ||
			![
				'session_meta',
				'event_msg',
				'queue-operation',
				'cost-state',
				'last-prompt',
				'mode',
				'system',
				'attachment',
			].includes(entry.type))
	)
		conversation.limitations.push({
			code: 'opaque-runtime-state',
			severity: 'warning',
			tabId: conversation.tabId,
			message: `Opaque content at ${record.nativeId} is archived but cannot be resumed as foreign reasoning.`,
		});
	if (record.role === 'system' || record.role === 'developer')
		conversation.limitations.push({
			code: 'historical-instructions',
			severity: 'warning',
			tabId: conversation.tabId,
			message: `Historical ${record.role} record ${record.nativeId} is archived, not installed as destination instructions.`,
		});
	if (record.boundary || record.branchId || entry.isSidechain)
		conversation.limitations.push({
			code: 'native-boundary',
			severity: 'warning',
			tabId: conversation.tabId,
			message: `Branch/compaction state at ${record.nativeId} is preserved; foreign runtime equivalence is unverified.`,
		});
}

/** Conversation-wide rules: mapped history must exist and tool evidence must link exactly once, in order. */
function finishConversation(conversation: PortableConversation): void {
	if (!conversation.records.some((r) => r.role === 'user' || r.role === 'assistant'))
		conversation.limitations.push({
			code: 'missing-model-history',
			severity: 'block',
			tabId: conversation.tabId,
			message:
				'Native data contains no mapped model-visible conversation. UI/event projections alone cannot supply context continuity.',
		});
	const calls = new Set(
		conversation.records.flatMap((r) =>
			r.blocks.filter((b) => b.kind === 'tool-call').map((b) => b.callId)
		)
	);
	const results = new Set(
		conversation.records.flatMap((r) =>
			r.blocks.filter((b) => b.kind === 'tool-result').map((b) => b.callId)
		)
	);
	for (const callId of calls)
		if (!results.has(callId))
			conversation.limitations.push({
				code: 'unfinished-tool-call',
				severity: 'block',
				tabId: conversation.tabId,
				message: `Tool call ${callId} has no recorded result. A pending source tool must not be replayed on the destination.`,
			});
	const seenCalls = new Set<string>();
	const seenResults = new Set<string>();
	for (const record of conversation.records)
		for (const block of record.blocks) {
			if (
				(block.kind === 'tool-call' || block.kind === 'tool-result') &&
				(!block.callId ||
					(block.kind === 'tool-call' && !block.name) ||
					(block.kind === 'tool-result' && !calls.has(block.callId)))
			) {
				conversation.limitations.push({
					code: 'broken-tool-link',
					severity: 'block',
					tabId: conversation.tabId,
					message: `Tool evidence at ${record.nativeId} has no valid call linkage.`,
				});
			}
			if (block.kind !== 'tool-call' && block.kind !== 'tool-result') continue;
			if (record.role !== (block.kind === 'tool-call' ? 'assistant' : 'user'))
				conversation.limitations.push({
					code: 'invalid-tool-role',
					severity: 'block',
					tabId: conversation.tabId,
					message: `Tool evidence at ${record.nativeId} has an invalid message role for native projection.`,
				});
			if (!block.callId) continue;
			const seen = block.kind === 'tool-call' ? seenCalls : seenResults;
			if (seen.has(block.callId))
				conversation.limitations.push({
					code: 'duplicate-tool-link',
					severity: 'block',
					tabId: conversation.tabId,
					message: `Tool ${block.kind} ${block.callId} occurs more than once; native linkage is ambiguous.`,
				});
			if (block.kind === 'tool-result' && calls.has(block.callId) && !seenCalls.has(block.callId))
				conversation.limitations.push({
					code: 'tool-result-order',
					severity: 'block',
					tabId: conversation.tabId,
					message: `Tool result ${block.callId} precedes its call. Native history cannot be reordered during migration.`,
				});
			seen.add(block.callId);
		}
}

/** Validate captured base64 image bytes into an attachment artifact, or block on a missing capture. */
function pushImageAttachment(
	conversation: PortableConversation,
	origin: PortableRecord['origin'],
	blocks: PortableBlock[],
	data: unknown,
	mediaType: string,
	native: unknown
): string {
	const id = translationHash(canonicalJson({ origin, index: blocks.length }));
	if (typeof data === 'string') {
		if (!/^[a-zA-Z0-9+/\s]*={0,2}$/.test(data) || !data.trim())
			conversation.limitations.push({
				code: 'invalid-attachment',
				severity: 'block',
				tabId: conversation.tabId,
				artifactId: id,
				message: `Attachment ${id} has invalid base64 data.`,
			});
		const artifact = translationArtifact(
			'attachment',
			id,
			`${id}.bin`,
			Buffer.from(data, 'base64')
		);
		artifact.id = id;
		conversation.artifacts.push(artifact);
	} else
		conversation.limitations.push({
			code: 'missing-attachment',
			severity: 'block',
			artifactId: id,
			tabId: conversation.tabId,
			message: `Image ${id} has no captured bytes. External image references require explicit resolution.`,
		});
	blocks.push({ kind: 'attachment', artifactId: id, mediaType, native });
	return id;
}

/**
 * A Grok session is two native files (`summary.json` and `chat_history.jsonl`),
 * while `TranslationAdapter.extract` takes one buffer. The host reads both in one
 * bounded snapshot (`readGrokSessionSnapshot`) and hands over this envelope.
 */
export const GROK_SESSION_SNAPSHOT_FORMAT = 'maestro-grok-session-snapshot/1';
/** Same ceilings as the Grok history reader. */
export const GROK_SUMMARY_MAX_BYTES = 1024 * 1024;
export const GROK_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
export const GROK_TRANSCRIPT_MAX_ROWS = 100_000;

export interface GrokSessionSnapshot {
	/** `null` when `summary.json` is absent; Grok itself cannot load such a session. */
	summary: Buffer | null;
	transcript: Buffer;
}

export function encodeGrokSessionSnapshot(snapshot: GrokSessionSnapshot): Buffer {
	return Buffer.from(
		canonicalJson({
			format: GROK_SESSION_SNAPSHOT_FORMAT,
			summaryBase64: snapshot.summary ? snapshot.summary.toString('base64') : null,
			transcriptBase64: snapshot.transcript.toString('base64'),
		})
	);
}

/** A buffer that is not the envelope is a bare `chat_history.jsonl` with no summary. */
export function decodeGrokSessionSnapshot(bytes: Buffer): GrokSessionSnapshot {
	if (bytes[0] === 0x7b) {
		try {
			const value = JSON.parse(bytes.toString('utf8'));
			if (
				value?.format === GROK_SESSION_SNAPSHOT_FORMAT &&
				typeof value.transcriptBase64 === 'string' &&
				(value.summaryBase64 === null || typeof value.summaryBase64 === 'string')
			)
				return {
					summary: value.summaryBase64 === null ? null : Buffer.from(value.summaryBase64, 'base64'),
					transcript: Buffer.from(value.transcriptBase64, 'base64'),
				};
		} catch {
			// Not an envelope: a transcript whose first row is malformed.
		}
	}
	return { summary: null, transcript: bytes };
}

/** Directory name component limit Grok encodes against (`MAX_DIRNAME_BYTES`). */
export const GROK_CWD_DIRNAME_MAX_BYTES = 255;

/**
 * Grok's `encode_cwd_dirname` (xai-grok-config `paths.rs` at the pinned source):
 * `urlencoding::encode` keeps only ASCII alphanumerics and `-_.~`, so the
 * characters `encodeURIComponent` leaves bare (`!'()*`) are escaped too. A longer
 * name switches Grok to a `{slug}-{blake3}` folder plus a `.cwd` file that this
 * adapter does not reproduce, so it returns `null` and the caller refuses.
 */
export function encodeGrokCwdDirname(cwd: string): string | null {
	const encoded = encodeURIComponent(cwd).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
	return encoded.length <= GROK_CWD_DIRNAME_MAX_BYTES ? encoded : null;
}

/** Real prompts. Every other `synthetic_reason`, including unknown ones, is runtime context. */
const GROK_HUMAN_REASONS = new Set([
	'human',
	'interjection',
	'parent_human_message',
	'direct_bash',
]);
const GROK_BACKEND_RAW_OUTPUT = new Set([
	'web_search_call',
	'custom_tool_call',
	'code_interpreter_call',
]);

/** Grok records the realpath'd cwd; fold the macOS `/private` aliases like the history reader. */
function grokComparablePath(value: string): string {
	const resolved = path.resolve(value).replace(/[/\\]+$/, '') || '/';
	return resolved.replace(/^\/private(\/(?:var|tmp|etc))(\/|$)/, '$1$2');
}

/** Strip the `<user_query>` wrappers Grok adds around a typed prompt (history reader rule). */
function stripGrokUserQuery(text: string): string {
	const matches = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)];
	if (!matches.length) return text.trim();
	return matches
		.map((m) => m[1])
		.filter((part) => part.trim())
		.join('\n\n');
}

function grokParts(content: unknown): unknown[] {
	if (typeof content === 'string') return [{ type: 'text', text: content }];
	return Array.isArray(content) ? content : [];
}

function grokPartsText(content: unknown): string {
	return grokParts(content)
		.map((part) =>
			part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
				? (part as { text: string }).text
				: ''
		)
		.join('');
}

/** v1 `{type:'image', url}` and legacy `{type:'image_url', image_url:{url}}`; never opened or fetched. */
function grokImageUrl(part: unknown): string | undefined {
	if (!part || typeof part !== 'object') return undefined;
	const value = part as { type?: unknown; url?: unknown; image_url?: { url?: unknown } };
	const url =
		value.type === 'image'
			? value.url
			: value.type === 'image_url'
				? value.image_url?.url
				: undefined;
	return typeof url === 'string' ? url : undefined;
}

function pushGrokImage(
	conversation: PortableConversation,
	origin: PortableRecord['origin'],
	blocks: PortableBlock[],
	url: string,
	native: unknown
): void {
	const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url);
	pushImageAttachment(
		conversation,
		origin,
		blocks,
		dataUrl?.[2],
		dataUrl?.[1] ?? 'application/octet-stream',
		native
	);
}

/**
 * Map one Grok session to portable records. Only
 * human prompts, assistant prose, client tool calls and their results get a role;
 * runtime-injected context, reasoning (including encrypted content), backend tool
 * calls and unknown rows are archived as opaque and never projected. Nothing is
 * executed, fetched or read beyond the two snapshot files.
 */
export function extractGrokConversation(
	identity: TranslationIdentity,
	tabId: string,
	sessionId: string,
	bytes: Buffer
): PortableConversation {
	const snapshot = decodeGrokSessionSnapshot(bytes);
	const warn = (code: string, message: string, severity: 'warning' | 'block' = 'warning') =>
		conversation.limitations.push({ code, severity, tabId, message });
	const transcript = translationArtifact(
		'transcript',
		`${identity.provider}:${sessionId}`,
		`${sessionId}/chat_history.jsonl`,
		snapshot.transcript
	);
	const conversation: PortableConversation = {
		tabId,
		nativeSessionId: sessionId,
		identity,
		records: [],
		artifacts: [transcript],
		limitations: [],
	};

	let summary: Record<string, any> | null = null;
	if (!snapshot.summary)
		warn(
			'native-summary-missing',
			'Grok summary.json is absent, so Grok itself cannot load this session and its identity cannot be checked.',
			'block'
		);
	else if (snapshot.summary.length > GROK_SUMMARY_MAX_BYTES)
		warn('native-summary-too-large', 'Grok summary.json exceeds the 1 MiB reader limit.', 'block');
	else {
		transcript.metadata = {
			grokSummary: {
				sha256: translationHash(snapshot.summary),
				bytesBase64: snapshot.summary.toString('base64'),
			},
		};
		try {
			const parsed = parseJsonWithBom<unknown>(snapshot.summary.toString('utf8'));
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) summary = parsed;
		} catch {
			// Reported below.
		}
		if (!summary || typeof summary.info !== 'object' || !summary.info)
			warn('malformed-native-summary', 'Grok summary.json has no readable session info.', 'block');
	}
	if (summary?.info) {
		if (summary.info.id !== sessionId)
			warn(
				'native-session-mismatch',
				'Native transcript identity does not match the selected conversation.',
				'block'
			);
		if (
			typeof summary.info.cwd !== 'string' ||
			grokComparablePath(summary.info.cwd) !== grokComparablePath(identity.projectRoot)
		)
			warn(
				'native-project-root-mismatch',
				'Selected native records belong to a different project root. Resolve their ownership before migration.',
				'block'
			);
	}
	const formatVersion = summary?.chat_format_version ?? 0;
	if (formatVersion !== 0 && formatVersion !== 1)
		warn(
			'unknown-native-schema',
			`Grok chat_format_version ${String(formatVersion)} has no declared mapping.`,
			'block'
		);
	if (typeof summary?.session_kind === 'string' && summary.session_kind.startsWith('subagent'))
		warn(
			'grok-subagent-session',
			'This Grok session was created for a subagent; its parent session is not carried over.'
		);
	warn(
		'grok-runtime-state-not-translated',
		'Only chat_history.jsonl and summary.json are read. Plan and todo state, rewind points, goals, workflows, signals, compaction artifacts, side questions and usage.json are not translated; destination usage starts empty.'
	);
	if (snapshot.transcript.length > GROK_TRANSCRIPT_MAX_BYTES) {
		warn(
			'native-history-too-large',
			'Grok chat_history.jsonl exceeds the 64 MiB reader limit.',
			'block'
		);
		finishConversation(conversation);
		return conversation;
	}
	const rows = parseNativeLines(snapshot.transcript.toString('utf8'));
	if (rows.length > GROK_TRANSCRIPT_MAX_ROWS) {
		warn(
			'native-history-too-large',
			'Grok chat_history.jsonl exceeds the 100,000 row reader limit.',
			'block'
		);
		finishConversation(conversation);
		return conversation;
	}

	const branchId =
		typeof summary?.parent_session_id === 'string' ? summary.parent_session_id : undefined;
	const inheritedPrefix =
		Number.isInteger(summary?.inherited_prefix_len) && summary!.inherited_prefix_len > 0
			? (summary!.inherited_prefix_len as number)
			: undefined;
	const account = translationHash(identity.accountRoot);
	for (const [position, row] of rows.entries()) {
		const entry: Record<string, any> = row.entry ?? { type: 'malformed', raw: row.line };
		if (row.malformed)
			warn(
				'malformed-native-record',
				`Native record ${row.index} cannot be parsed; original bytes are preserved.`,
				'block'
			);
		// ConversationItem rows carry no IDs. Position is the identity; checkpoints
		// compare semantic hashes to detect a compaction or rewind rewriting the prefix.
		const nativeId = `line:${row.index}`;
		const origin = { provider: identity.provider, account, sessionId, eventId: nativeId };
		const blocks: PortableBlock[] = [];
		let role: PortableRecord['role'];
		let boundary: PortableRecord['boundary'];
		const kind = row.malformed ? 'malformed' : (entry.type ?? entry.role);
		if (kind === 'system') {
			role = 'system';
			blocks.push({ kind: 'opaque', native: entry });
		} else if (kind === 'user') {
			const reason = typeof entry.synthetic_reason === 'string' ? entry.synthetic_reason : 'human';
			const text = grokPartsText(entry.content);
			const sessionPrefix =
				entry.synthetic_reason === undefined && text.trim().startsWith('<user_info>');
			if (reason === 'compaction_meta' || (GROK_HUMAN_REASONS.has(reason) && !sessionPrefix)) {
				role = 'user';
				if (reason === 'compaction_meta') {
					boundary = 'compaction';
					warn(
						'grok-compacted-history',
						'Grok replaced earlier turns with a compaction summary. Only the summary is carried; turns before it are not recovered from compaction artifacts.'
					);
				}
				for (const part of grokParts(entry.content)) {
					const url = grokImageUrl(part);
					if (url !== undefined) pushGrokImage(conversation, origin, blocks, url, part);
					else if (
						part &&
						typeof part === 'object' &&
						typeof (part as { text?: unknown }).text === 'string'
					) {
						const raw = (part as { text: string }).text;
						const value = reason === 'compaction_meta' ? raw : stripGrokUserQuery(raw);
						if (value) blocks.push({ kind: 'text', text: value });
					} else blocks.push({ kind: 'opaque', native: part });
				}
			} else blocks.push({ kind: 'opaque', native: entry });
		} else if (kind === 'assistant') {
			role = 'assistant';
			if (typeof entry.content === 'string') {
				if (entry.content) blocks.push({ kind: 'text', text: entry.content });
			} else if (entry.content !== undefined && entry.content !== null) {
				const text = grokPartsText(entry.content);
				if (text) blocks.push({ kind: 'text', text });
			}
			const legacyRaw = Array.isArray(entry.raw_output) ? entry.raw_output : [];
			if (entry.reasoning || typeof entry.reasoning_content === 'string' || legacyRaw.length)
				blocks.push({
					kind: 'opaque',
					native: {
						type: 'grok-legacy-assistant-state',
						reasoning: entry.reasoning,
						reasoning_content: entry.reasoning_content,
						raw_output: entry.raw_output,
					},
				});
			if (
				legacyRaw.some((item: { type?: string } | null) =>
					GROK_BACKEND_RAW_OUTPUT.has(item?.type ?? '')
				)
			)
				warn(
					'grok-backend-tool-context',
					'Grok server-side tool calls (web search, X search, code interpreter) are archived; their context is not available to the destination and they are never re-executed.'
				);
			for (const call of Array.isArray(entry.tool_calls) ? entry.tool_calls : []) {
				if (!call || typeof call !== 'object') {
					blocks.push({ kind: 'opaque', native: call });
					continue;
				}
				const fields = call.function && typeof call.function === 'object' ? call.function : call;
				blocks.push({
					kind: 'tool-call',
					callId: call.id,
					name: fields.name,
					input: fields.arguments,
				});
			}
		} else if (kind === 'tool_result' || kind === 'tool') {
			role = 'user';
			// Grok has no error flag; nothing is inferred from the text.
			blocks.push({
				kind: 'tool-result',
				callId: entry.tool_call_id,
				output: typeof entry.content === 'string' ? entry.content : grokPartsText(entry.content),
			});
			for (const part of [
				...(Array.isArray(entry.content) ? entry.content : []),
				...(Array.isArray(entry.images) ? entry.images : []),
			]) {
				const url = grokImageUrl(part);
				if (url !== undefined) pushGrokImage(conversation, origin, blocks, url, part);
			}
		} else {
			if (kind === 'backend_tool_call')
				warn(
					'grok-backend-tool-context',
					'Grok server-side tool calls (web search, X search, code interpreter) are archived; their context is not available to the destination and they are never re-executed.'
				);
			blocks.push({ kind: 'opaque', native: entry });
		}
		if (inheritedPrefix !== undefined && position === inheritedPrefix)
			boundary = boundary ?? 'fork';
		const record: PortableRecord = {
			origin,
			nativeId,
			sequence: row.index,
			role,
			blocks,
			semanticHash: translationHash(canonicalJson(entry)),
			native: entry,
			branchId,
			boundary,
		};
		conversation.records.push(record);
		pushRecordLimitations(conversation, record, entry);
	}
	finishConversation(conversation);
	return conversation;
}
