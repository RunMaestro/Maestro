// Grok reads and writes local files directly; its host seams are local only.
import { localTranslationFs } from './local-fs';
import type { TranslationFs } from './fs-port';
import * as path from 'node:path';
import { generateUUID } from '../../uuid';
import { encodeClaudeProjectPath } from '../../pathUtils';
import { canonicalJson } from '../../canonicalJson';
import {
	GROK_SUMMARY_MAX_BYTES,
	GROK_TRANSCRIPT_MAX_BYTES,
	GROK_TRANSCRIPT_MAX_ROWS,
	encodeGrokCwdDirname,
	encodeGrokSessionSnapshot,
	extractGrokConversation,
	extractNativeConversation,
} from './native-records';
import { activeContextRecords } from './context-window';
import { nativeRecordKey, recordKey, translationHash } from './identity';
import { TranslationRegistry } from './registry';
import { TRANSLATION_DIRECTIONS, TRANSLATION_PROVIDER_VERSIONS } from './support';
import { assertTranslationTarget } from './resource-projections';
import { TranslationSourceBusyError } from './types';
import type {
	PortableConversation,
	PortableRecord,
	TranslationAdapter,
	TranslationIdentity,
	TranslationStageContext,
	TranslationTabMapping,
} from './types';

export interface ProjectedNativeRecord {
	id: string;
	origin: PortableRecord['origin'];
	item: Record<string, unknown>;
}

/** Tool evidence is history, never an execution request. Reasoning/signatures are not forged. */
export function projectConversation(
	conversation: PortableConversation,
	provider: 'claude-code' | 'codex',
	sessionId: string,
	destinationVersion: string = TRANSLATION_PROVIDER_VERSIONS['claude-code'].testedVersions[0]
): ProjectedNativeRecord[] {
	const projected: ProjectedNativeRecord[] = [];
	let parentUuid: string | null = null;
	for (const record of activeContextRecords(conversation.records)) {
		if (
			record.native &&
			typeof record.native === 'object' &&
			(record.native as { isSidechain?: boolean }).isSidechain
		)
			continue;
		if (record.role !== 'user' && record.role !== 'assistant') continue;
		const content: Record<string, unknown>[] = [];
		const add = (item: Record<string, unknown>, blockIndex: number): void => {
			const id = `maestro_${translationHash(canonicalJson({ origin: record.origin, blockIndex })).slice(0, 32)}`;
			projected.push({ id, origin: record.origin, item: { ...item, id } });
		};
		let blockIndex = 0;
		for (const block of record.blocks) {
			switch (block.kind) {
				case 'opaque':
					break;
				case 'text':
					content.push({
						type:
							provider === 'claude-code'
								? 'text'
								: record.role === 'assistant'
									? 'output_text'
									: 'input_text',
						text: block.text,
					});
					break;
				case 'attachment': {
					if (provider === 'codex' && record.role === 'assistant') break;
					const artifact = conversation.artifacts.find((a) => a.id === block.artifactId);
					if (
						!artifact ||
						translationHash(Buffer.from(artifact.bytesBase64, 'base64')) !== artifact.sha256
					)
						throw new Error('Missing or corrupt attachment');
					content.push(
						provider === 'claude-code'
							? {
									type: 'image',
									source: {
										type: 'base64',
										media_type: block.mediaType,
										data: artifact.bytesBase64,
									},
								}
							: {
									type: 'input_image',
									image_url: `data:${block.mediaType};base64,${artifact.bytesBase64}`,
									detail: 'auto',
								}
					);
					break;
				}
				case 'tool-call':
					if (block.interrupted) break;
					if (provider === 'claude-code') {
						let input = block.input;
						if (typeof input === 'string') {
							try {
								input = JSON.parse(input);
							} catch {
								input = { input };
							}
						}
						content.push({ type: 'tool_use', id: block.callId, name: block.name, input });
					} else {
						if (content.length) {
							add(
								{
									type: 'message',
									role: record.role,
									content: content.splice(0),
									...(record.phase && { phase: record.phase }),
								},
								blockIndex++
							);
						}
						add(
							block.custom
								? {
										type: 'custom_tool_call',
										call_id: block.callId,
										name: block.name,
										input:
											typeof block.input === 'string' ? block.input : canonicalJson(block.input),
									}
								: {
										type: 'function_call',
										call_id: block.callId,
										name: block.name,
										arguments:
											typeof block.input === 'string' ? block.input : canonicalJson(block.input),
									},
							blockIndex++
						);
					}
					break;
				case 'tool-result':
					if (provider === 'claude-code')
						content.push({
							type: 'tool_result',
							tool_use_id: block.callId,
							content:
								typeof block.output === 'string' || Array.isArray(block.output)
									? block.output
									: canonicalJson(block.output),
							...(block.isError && { is_error: true }),
						});
					else {
						if (content.length)
							add({ type: 'message', role: record.role, content: content.splice(0) }, blockIndex++);
						add(
							{
								type: block.custom ? 'custom_tool_call_output' : 'function_call_output',
								call_id: block.callId,
								output:
									typeof block.output === 'string' ? block.output : canonicalJson(block.output),
							},
							blockIndex++
						);
					}
					break;
			}
		}
		if (!content.length) continue;
		if (provider === 'codex')
			add(
				{
					type: 'message',
					role: record.role,
					content,
					...(record.phase && { phase: record.phase }),
				},
				blockIndex
			);
		else {
			const uuid = generateUUID();
			const item = {
				type: record.role,
				uuid,
				parentUuid,
				sessionId,
				cwd: conversation.identity.projectRoot,
				isSidechain: false,
				userType: 'external',
				version: destinationVersion,
				timestamp: record.timestamp ?? new Date().toISOString(),
				message: {
					role: record.role,
					content,
					...(record.role === 'assistant' && {
						id: `msg_${uuid}`,
						type: 'message',
						model: 'maestro-translation',
						stop_reason: 'end_turn',
						stop_sequence: null,
						usage: { input_tokens: 0, output_tokens: 0 },
					}),
				},
			};
			projected.push({ id: uuid, origin: record.origin, item });
			parentUuid = uuid;
		}
	}
	return projected;
}

async function stageClaude(
	conversation: PortableConversation,
	context: TranslationStageContext
): Promise<TranslationTabMapping> {
	const nativeFs = context.nativeFs ?? localTranslationFs;
	const paths = nativeFs.paths ?? path;
	const sessionId = generateUUID();
	const file = paths.join(
		context.destination.nativeSessionRoot ??
			paths.join(context.destination.accountRoot, 'projects'),
		encodeClaudeProjectPath(context.destination.projectRoot),
		`${sessionId}.jsonl`
	);
	const rows = projectConversation(
		{
			...conversation,
			identity: {
				...conversation.identity,
				projectRoot: context.destination.projectRoot,
			},
		},
		'claude-code',
		sessionId,
		context.destination.version
	);
	const bytes = rows.map((r) => JSON.stringify(r.item)).join('\n') + '\n';
	const mapping: TranslationTabMapping = {
		tabId: conversation.tabId,
		sourceSessionId: conversation.nativeSessionId,
		destinationSessionId: sessionId,
		artifacts: [{ path: file, sha256: translationHash(bytes), created: false }],
		lineage: Object.fromEntries(
			rows.map((r) => [nativeRecordKey(context.destination, sessionId, r.id), r.origin])
		),
	};
	await context.recordIntent(mapping);
	await assertTranslationTarget(
		file,
		context.destination.nativeSessionRoot ?? context.destination.accountRoot,
		nativeFs
	);
	await nativeFs.mkdir(paths.dirname(file), { recursive: true, mode: 0o700 });
	await assertTranslationTarget(
		file,
		context.destination.nativeSessionRoot ?? context.destination.accountRoot,
		nativeFs
	);
	// Exclusive new file: a provider or another process can never lose an existing transcript.
	await nativeFs.createExclusive(file, bytes, {
		mode: 0o600,
		durable: true,
		onCreated: async () => {
			mapping.artifacts[0].created = true;
			await context.recordIntent(mapping);
		},
	});
	if (translationHash(await nativeFs.readFile(file)) !== mapping.artifacts[0].sha256)
		throw new Error('Claude destination readback failed');
	return mapping;
}

async function stageCodex(
	conversation: PortableConversation,
	context: TranslationStageContext
): Promise<TranslationTabMapping> {
	const nativeFs = context.nativeFs ?? localTranslationFs;
	const paths = nativeFs.paths ?? path;
	if (!context.codex) throw new Error('Codex native import channel unavailable; no exec fallback');
	const rows = projectConversation(conversation, 'codex', 'pending');
	const items = rows.map((row) => {
		const item = { ...row.item };
		// Let Codex assign native IDs. Foreign IDs are rejected when the model resumes the thread.
		delete item.id;
		return item;
	});
	// Intent precedes thread creation. A lost response is an uncertain mutation, never blindly retried.
	const intent: TranslationTabMapping = {
		tabId: conversation.tabId,
		sourceSessionId: conversation.nativeSessionId,
		destinationSessionId: null,
		artifacts: [],
		lineage: {},
	};
	await context.recordIntent(intent);
	const started = await context.codex.request<{
		thread: { id: string; path?: string };
		sandbox?: { type: string };
	}>('thread/start', {
		cwd: context.destination.projectRoot,
		approvalPolicy: 'never',
		sandbox: 'read-only',
		persistExtendedHistory: true,
		experimentalRawEvents: true,
	});
	const sessionId = started.thread?.id;
	if (!sessionId || !started.thread.path)
		throw new Error('Codex did not return a durable native thread identity');
	const relative = paths.relative(context.destination.accountRoot, started.thread.path);
	if (relative.startsWith('..') || paths.isAbsolute(relative))
		throw new Error('Codex returned a rollout outside the selected account');
	await assertTranslationTarget(started.thread.path, context.destination.accountRoot, nativeFs);
	const mapping: TranslationTabMapping = {
		...intent,
		destinationSessionId: sessionId,
		artifacts: [{ path: started.thread.path, sha256: '', created: true, cleanup: 'retain' }],
		lineage: {},
	};
	await context.recordIntent(mapping);
	await context.codex.request('thread/inject_items', {
		threadId: sessionId,
		items,
	});
	// Read persisted bytes, not a successful RPC response or a flattened UI projection.
	const bytes = await nativeFs.readFile(started.thread.path);
	const readback = extractNativeConversation(
		context.destination,
		conversation.tabId,
		sessionId,
		bytes
	);
	const imported = rows.length
		? readback.records
				.filter((record) => (record.native as { type?: string }).type === 'response_item')
				.slice(-rows.length)
		: [];
	if (imported.length !== rows.length)
		throw new Error('Injected Codex records are absent from durable readback');
	for (const [index, record] of imported.entries()) {
		const payload = { ...(record.native as { payload?: Record<string, unknown> }).payload };
		// Codex adds bookkeeping when persisting messages; the injected payload must otherwise match.
		delete payload.internal_chat_message_metadata_passthrough;
		delete payload.id;
		if (canonicalJson(payload) !== canonicalJson(items[index]))
			throw new Error('Codex changed an injected item during durable readback');
		mapping.lineage[nativeRecordKey(context.destination, sessionId, record.nativeId)] =
			rows[index].origin;
	}
	mapping.artifacts[0].sha256 = translationHash(bytes);
	await context.recordIntent(mapping);
	return mapping;
}

export const claudeTranslationAdapter: TranslationAdapter = {
	provider: 'claude-code',
	...TRANSLATION_PROVIDER_VERSIONS['claude-code'],
	extract: extractNativeConversation,
	stage: stageClaude,
};
export const codexTranslationAdapter: TranslationAdapter = {
	provider: 'codex',
	...TRANSLATION_PROVIDER_VERSIONS.codex,
	extract: extractNativeConversation,
	stage: stageCodex,
};

/** `<GROK_HOME>/sessions` of the SELECTED account; never a process-global or default home. */
export function grokSessionsRoot(identity: TranslationIdentity): string {
	return identity.nativeSessionRoot ?? path.join(identity.accountRoot, 'sessions');
}

/**
 * The root every Grok read and write is confined to: the host-approved sessions
 * root when one is set, otherwise the selected account itself. Confining to a
 * derived `<account>/sessions` alone would follow that folder if it were a
 * symlink out of the account, because a root is compared by its realpath.
 */
function grokConfinementRoot(identity: TranslationIdentity): string {
	return identity.nativeSessionRoot ?? identity.accountRoot;
}

/** Bounded read of one regular file inside the confinement root; a symlink is never followed. */
async function readGrokSessionFile(
	file: string,
	root: string,
	maxBytes: number,
	nativeFs: TranslationFs = localTranslationFs
): Promise<Buffer | null> {
	await assertTranslationTarget(file, root, nativeFs);
	let stat;
	try {
		stat = await nativeFs.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	const regular = stat.isFile ? stat.isFile() : !stat.isDirectory() && !stat.isSymbolicLink();
	if (!regular) throw new Error('Grok session file is not a regular file');
	if (stat.size > maxBytes) throw new RangeError('Grok session file exceeds the reader limit');
	const bytes = await nativeFs.readFile(file);
	if (bytes.length > maxBytes) throw new RangeError('Grok session file exceeds the reader limit');
	return bytes;
}

/**
 * Locate the selected Grok session under the selected account and project
 * (`<sessions root>/<percent-encoded realpath cwd>/<id>/`) and snapshot its two
 * model-visible files twice. Only `summary.json` and `chat_history.jsonl` are
 * read: no credential, config, usage or runtime file. A changed second sample
 * means a live writer, so the plan defers instead of reading a torn session.
 */
export async function readGrokSessionSnapshot(
	identity: TranslationIdentity,
	sessionId: string,
	nativeFs: TranslationFs = localTranslationFs
): Promise<{ bytes: Buffer; sessionDir: string; transcriptPath: string }> {
	if (identity.provider !== 'grok') throw new Error('Not a Grok translation identity');
	if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Unsafe native session ID');
	const root = grokSessionsRoot(identity);
	const confinement = grokConfinementRoot(identity);
	const cwds = new Set([path.resolve(identity.projectRoot).replace(/[/\\]+$/, '') || '/']);
	try {
		cwds.add(await nativeFs.realpath(identity.projectRoot));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const found: string[] = [];
	for (const cwd of cwds) {
		const folder = encodeGrokCwdDirname(cwd);
		if (!folder) continue;
		const dir = path.join(root, folder, sessionId);
		await assertTranslationTarget(path.join(dir, 'summary.json'), confinement, nativeFs);
		try {
			const stat = await nativeFs.lstat(dir);
			if (stat.isDirectory()) found.push(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	if (found.length !== 1)
		throw new Error(
			found.length
				? 'Selected Grok session exists under more than one project folder; ownership is ambiguous'
				: 'Selected Grok session is missing under the selected account and project'
		);
	const sessionDir = found[0];
	const summaryPath = path.join(sessionDir, 'summary.json');
	const transcriptPath = path.join(sessionDir, 'chat_history.jsonl');
	const sample = async () => ({
		summary: await readGrokSessionFile(summaryPath, confinement, GROK_SUMMARY_MAX_BYTES, nativeFs),
		transcript:
			(await readGrokSessionFile(
				transcriptPath,
				confinement,
				GROK_TRANSCRIPT_MAX_BYTES,
				nativeFs
			)) ?? Buffer.alloc(0),
	});
	const first = await sample();
	const second = await sample();
	const same = (a: Buffer | null, b: Buffer | null) =>
		a === null || b === null ? a === b : a.equals(b);
	if (!same(first.summary, second.summary) || !same(first.transcript, second.transcript))
		throw new TranslationSourceBusyError();
	return { bytes: encodeGrokSessionSnapshot(first), sessionDir, transcriptPath };
}

const GROK_DATA_IMAGE_URL = /^data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]*={0,2}$/;

/** Grok `ContentPart::Image`: an inline data URI only. A URL is never written or fetched. */
function grokImagePart(mediaType: string, base64: string): Record<string, unknown> {
	const url = `data:${mediaType};base64,${base64}`;
	if (!GROK_DATA_IMAGE_URL.test(url))
		throw new Error('Grok destination accepts only inline image attachments');
	return { type: 'image', url };
}

/**
 * A foreign tool result as Grok's `ToolResultItem` (`content` string, `images[]`):
 * Claude content arrays and Codex output items keep their text in order, joined
 * with newlines, and their inline images; any other part is kept as JSON text.
 */
function grokToolResult(output: unknown): { content: string; images: Record<string, unknown>[] } {
	if (typeof output === 'string') return { content: output, images: [] };
	if (output === undefined || output === null) return { content: '', images: [] };
	if (!Array.isArray(output)) return { content: canonicalJson(output), images: [] };
	const text: string[] = [];
	const images: Record<string, unknown>[] = [];
	for (const part of output) {
		const value = (part ?? {}) as {
			type?: unknown;
			text?: unknown;
			image_url?: unknown;
			source?: { type?: unknown; media_type?: unknown; data?: unknown };
		};
		if (
			typeof value.text === 'string' &&
			(value.type === 'text' || value.type === 'input_text' || value.type === 'output_text')
		)
			text.push(value.text);
		else if (
			value.type === 'image' &&
			value.source?.type === 'base64' &&
			typeof value.source.media_type === 'string' &&
			typeof value.source.data === 'string'
		)
			images.push(grokImagePart(value.source.media_type, value.source.data));
		else if (
			value.type === 'input_image' &&
			typeof value.image_url === 'string' &&
			GROK_DATA_IMAGE_URL.test(value.image_url)
		)
			images.push({ type: 'image', url: value.image_url });
		else text.push(canonicalJson(part ?? null));
	}
	return { content: text.join('\n'), images };
}

function grokLinkedCallId(callId: unknown): string {
	if (typeof callId !== 'string' || !callId)
		throw new Error('A tool call or result without a native call ID cannot be linked on Grok');
	return callId;
}

/**
 * Portable records as Grok `ConversationItem` rows (the pinned staging table).
 * Only user and assistant records are projected. Call IDs stay verbatim; the
 * source model, reasoning, signatures and timestamps are never written. A row's
 * `id` is its `line:<index>`, the same native ID the Grok extractor assigns.
 */
export function projectGrokConversation(
	conversation: PortableConversation
): ProjectedNativeRecord[] {
	const rows: ProjectedNativeRecord[] = [];
	for (const record of conversation.records) {
		if ((record.native as { isSidechain?: boolean } | undefined)?.isSidechain) continue;
		if (record.role !== 'user' && record.role !== 'assistant') continue;
		const push = (item: Record<string, unknown>) =>
			rows.push({ id: `line:${rows.length}`, origin: record.origin, item });
		const parts: Record<string, unknown>[] = [];
		const text: string[] = [];
		const calls: Record<string, unknown>[] = [];
		const flushUser = () => {
			if (parts.length) push({ type: 'user', content: parts.splice(0) });
		};
		const flushAssistant = () => {
			if (text.length || calls.length)
				push({
					type: 'assistant',
					content: text.splice(0).join('\n\n'),
					...(calls.length && { tool_calls: calls.splice(0) }),
				});
		};
		for (const block of record.blocks) {
			switch (block.kind) {
				case 'opaque':
					break;
				case 'text':
					if (record.role === 'user') parts.push({ type: 'text', text: block.text });
					else text.push(block.text);
					break;
				case 'attachment': {
					// `AssistantItem` has no image field (assistant-attachment-projection).
					if (record.role === 'assistant') break;
					const artifact = conversation.artifacts.find((a) => a.id === block.artifactId);
					if (
						!artifact ||
						translationHash(Buffer.from(artifact.bytesBase64, 'base64')) !== artifact.sha256
					)
						throw new Error('Missing or corrupt attachment');
					parts.push(grokImagePart(block.mediaType, artifact.bytesBase64));
					break;
				}
				case 'tool-call':
					flushUser();
					if (typeof block.name !== 'string' || !block.name)
						throw new Error('A tool call without a name cannot be written to Grok');
					calls.push({
						id: grokLinkedCallId(block.callId),
						name: block.name,
						arguments:
							typeof block.input === 'string' ? block.input : canonicalJson(block.input ?? {}),
					});
					break;
				case 'tool-result': {
					flushUser();
					flushAssistant();
					const { content, images } = grokToolResult(block.output);
					push({
						type: 'tool_result',
						tool_call_id: grokLinkedCallId(block.callId),
						content,
						...(images.length && { images }),
					});
					break;
				}
			}
		}
		flushUser();
		flushAssistant();
	}
	return rows;
}

function hasOnlyKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
	const keys = Object.keys(value);
	return (
		required.every((key) => key in value) &&
		keys.every((key) => required.includes(key) || optional.includes(key))
	);
}

function grokImagePartsProblem(value: unknown, allowText: boolean): string | null {
	if (!Array.isArray(value) || !value.length) return 'content parts must be a non-empty array';
	for (const part of value) {
		if (!part || typeof part !== 'object') return 'content part is not an object';
		const p = part as Record<string, unknown>;
		if (p.type === 'text' && allowText) {
			if (!hasOnlyKeys(p, ['type', 'text']) || typeof p.text !== 'string')
				return 'text part must be {type, text}';
		} else if (p.type === 'image') {
			if (!hasOnlyKeys(p, ['type', 'url']) || typeof p.url !== 'string')
				return 'image part must be {type, url}';
			if (!GROK_DATA_IMAGE_URL.test(p.url)) return 'image part must be an inline image data URI';
		} else return `unexpected content part type ${String(p.type)}`;
	}
	return null;
}

/**
 * Strict check of one staged Grok row against the pinned `ConversationItem`
 * variants this adapter writes (closed `type` set, required fields, no extra
 * keys). Grok's own loader SKIPS a row it cannot parse instead of failing, so a
 * byte hash alone cannot prove the model will see every written row.
 */
export function grokStagedRowProblem(value: unknown): string | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return 'row is not an object';
	const row = value as Record<string, unknown>;
	switch (row.type) {
		case 'user':
			if (!hasOnlyKeys(row, ['type', 'content'])) return 'user row has unexpected fields';
			return grokImagePartsProblem(row.content, true);
		case 'assistant': {
			if (!hasOnlyKeys(row, ['type', 'content'], ['tool_calls']))
				return 'assistant row has unexpected fields';
			if (typeof row.content !== 'string') return 'assistant content must be a string';
			if (row.tool_calls === undefined) return null;
			if (!Array.isArray(row.tool_calls) || !row.tool_calls.length)
				return 'tool_calls must be a non-empty array';
			for (const call of row.tool_calls) {
				const c = (call ?? {}) as Record<string, unknown>;
				if (
					typeof call !== 'object' ||
					!hasOnlyKeys(c, ['id', 'name', 'arguments']) ||
					typeof c.id !== 'string' ||
					!c.id ||
					typeof c.name !== 'string' ||
					!c.name ||
					typeof c.arguments !== 'string'
				)
					return 'tool call must be {id, name, arguments} strings';
			}
			return null;
		}
		case 'tool_result':
			if (!hasOnlyKeys(row, ['type', 'tool_call_id', 'content'], ['images']))
				return 'tool_result row has unexpected fields';
			if (typeof row.tool_call_id !== 'string' || !row.tool_call_id)
				return 'tool_call_id must be a non-empty string';
			if (typeof row.content !== 'string') return 'tool_result content must be a string';
			return row.images === undefined ? null : grokImagePartsProblem(row.images, false);
		default:
			return `unexpected row type ${String(row.type)}`;
	}
}

/**
 * The `Summary` Grok requires to load a session, from the pinned schema (public
 * source 2bdd1d6: `persistence.rs` `Summary`, `xai-grok-shared` `session/info.rs`
 * `Info { id, cwd }`, `PersistedAgentSelection` flattened as optional
 * `agent_name`/`agent_profile`). Only the required fields plus
 * `num_chat_messages`, `chat_format_version` and `grok_home` are written: a
 * foreign source is not a Grok parent, so no fork, kind, agent, sandbox or
 * attempt identity is invented, and Grok mints its own attempt on resume.
 */
function grokStagedSummary(
	sessionId: string,
	cwd: string,
	model: string,
	rows: number,
	grokHome: string
): Record<string, unknown> {
	const now = new Date().toISOString();
	return {
		info: { id: sessionId, cwd },
		session_summary: '',
		created_at: now,
		updated_at: now,
		num_messages: rows,
		num_chat_messages: rows,
		current_model_id: model,
		chat_format_version: 1,
		grok_home: grokHome,
	};
}

/**
 * Stage a NEW Grok session under the selected account:
 * `<sessions root>/<encoded realpath cwd>/<new UUID>/`, created exclusively and
 * owner-only. `chat_history.jsonl` is written before `summary.json`, because Grok
 * lists and loads a session only through its summary, so a crash in between
 * leaves nothing Grok can open. Both writes are journaled before they happen,
 * and both files are read back and strictly validated before the caller may
 * change any agent identity. Runtime files (updates, usage, signals, plan,
 * rewind) and the account search index are never written.
 */
async function stageGrok(
	conversation: PortableConversation,
	context: TranslationStageContext
): Promise<TranslationTabMapping> {
	const destination = context.destination;
	if (destination.provider !== 'grok') throw new Error('Not a Grok translation identity');
	const model = context.destinationModel?.trim();
	if (!model)
		throw new Error(
			"A Grok destination needs the agent's selected model; none is copied from the source or invented"
		);
	const rows = projectGrokConversation(conversation);
	if (!rows.length) throw new Error('No model-visible history to stage for Grok');
	if (rows.length > GROK_TRANSCRIPT_MAX_ROWS)
		throw new RangeError('Projected Grok history exceeds the reader row limit');
	const nativeFs = context.nativeFs ?? localTranslationFs;
	const root = grokSessionsRoot(destination);
	const confinement = grokConfinementRoot(destination);
	const cwd = await nativeFs.realpath(destination.projectRoot);
	const folder = encodeGrokCwdDirname(cwd);
	if (!folder)
		throw new Error(
			'Grok stores this project under a hashed folder name that Maestro does not reproduce'
		);
	const sessionId = generateUUID();
	const sessionDir = path.join(root, folder, sessionId);
	const transcriptPath = path.join(sessionDir, 'chat_history.jsonl');
	const summaryPath = path.join(sessionDir, 'summary.json');
	const transcript = Buffer.from(rows.map((row) => JSON.stringify(row.item)).join('\n') + '\n');
	if (transcript.length > GROK_TRANSCRIPT_MAX_BYTES)
		throw new RangeError('Projected Grok history exceeds the reader size limit');
	const summary = Buffer.from(
		JSON.stringify(
			grokStagedSummary(sessionId, cwd, model, rows.length, destination.accountRoot),
			null,
			2
		)
	);
	const mapping: TranslationTabMapping = {
		tabId: conversation.tabId,
		sourceSessionId: conversation.nativeSessionId,
		destinationSessionId: sessionId,
		artifacts: [
			{ path: transcriptPath, sha256: translationHash(transcript), created: false },
			{ path: summaryPath, sha256: translationHash(summary), created: false },
		],
		lineage: Object.fromEntries(
			rows.map((row) => [nativeRecordKey(destination, sessionId, row.id), row.origin])
		),
	};
	await context.recordIntent(mapping);
	await assertTranslationTarget(summaryPath, confinement, nativeFs);
	await nativeFs.mkdir(path.dirname(sessionDir), { recursive: true, mode: 0o700 });
	await assertTranslationTarget(summaryPath, confinement, nativeFs);
	// Exclusive: an existing session directory is a conflict, never reused.
	await nativeFs.mkdir(sessionDir, { recursive: false, mode: 0o700 });
	await assertTranslationTarget(summaryPath, confinement, nativeFs);
	for (const [index, bytes] of [transcript, summary].entries()) {
		await nativeFs.createExclusive(mapping.artifacts[index].path, bytes, {
			mode: 0o600,
			durable: true,
			onCreated: async () => {
				mapping.artifacts[index].created = true;
				await context.recordIntent(mapping);
			},
		});
	}
	const readTranscript = await readGrokSessionFile(
		transcriptPath,
		confinement,
		GROK_TRANSCRIPT_MAX_BYTES,
		nativeFs
	);
	const readSummary = await readGrokSessionFile(
		summaryPath,
		confinement,
		GROK_SUMMARY_MAX_BYTES,
		nativeFs
	);
	if (
		!readTranscript ||
		!readSummary ||
		translationHash(readTranscript) !== mapping.artifacts[0].sha256 ||
		translationHash(readSummary) !== mapping.artifacts[1].sha256
	)
		throw new Error('Grok destination readback failed');
	const lines = readTranscript.toString('utf8').split('\n');
	if (lines.pop() !== '' || lines.length !== rows.length)
		throw new Error('Grok destination readback row count differs from the projection');
	for (const [index, line] of lines.entries()) {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(`Grok destination readback line ${index} is not JSON`);
		}
		const problem = grokStagedRowProblem(value);
		if (problem) throw new Error(`Grok destination readback line ${index}: ${problem}`);
	}
	const parsed = JSON.parse(readSummary.toString('utf8')) as Record<string, any>;
	if (
		parsed.info?.id !== sessionId ||
		parsed.info?.cwd !== cwd ||
		parsed.chat_format_version !== 1 ||
		parsed.num_messages !== rows.length ||
		parsed.current_model_id !== model ||
		typeof parsed.session_summary !== 'string' ||
		Number.isNaN(Date.parse(parsed.created_at)) ||
		Number.isNaN(Date.parse(parsed.updated_at))
	)
		throw new Error('Grok destination summary readback does not match the pinned schema');
	return mapping;
}

/**
 * Grok source extraction and destination staging. No
 * direction naming Grok is declared yet: the host service still binds a
 * destination's account through `CLAUDE_CONFIG_DIR` and cannot read a Grok
 * source (design host gaps 1-4), so the declarations wait on that host work.
 */
export const grokTranslationAdapter: TranslationAdapter = {
	provider: 'grok',
	...TRANSLATION_PROVIDER_VERSIONS.grok,
	extract: extractGrokConversation,
	stage: stageGrok,
};

export function createTranslationRegistry(): TranslationRegistry {
	const registry = new TranslationRegistry();
	registry.register(claudeTranslationAdapter);
	registry.register(codexTranslationAdapter);
	registry.register(grokTranslationAdapter);
	for (const direction of TRANSLATION_DIRECTIONS) registry.declareDirection(direction);
	return registry;
}

/** Inspection key for payload evidence, not a native resume certification. */
export function projectedOriginKeys(rows: ProjectedNativeRecord[]): string[] {
	return rows.map((r) => recordKey(r.origin));
}
