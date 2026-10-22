import { localTranslationFs } from './local-fs';
import * as path from 'node:path';
import { generateUUID } from '../../uuid';
import { encodeClaudeProjectPath } from '../../pathUtils';
import { canonicalJson } from '../../canonicalJson';
import { extractNativeConversation } from './native-records';
import { activeContextRecords } from './context-window';
import { nativeRecordKey, recordKey, translationHash } from './identity';
import { TranslationRegistry } from './registry';
import { TRANSLATION_DIRECTIONS, TRANSLATION_PROVIDER_VERSIONS } from './support';
import { assertTranslationTarget } from './resource-projections';
import type {
	PortableConversation,
	PortableRecord,
	TranslationAdapter,
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
export function createTranslationRegistry(): TranslationRegistry {
	const registry = new TranslationRegistry();
	registry.register(claudeTranslationAdapter);
	registry.register(codexTranslationAdapter);
	for (const direction of TRANSLATION_DIRECTIONS) registry.declareDirection(direction);
	return registry;
}

/** Inspection key for payload evidence, not a native resume certification. */
export function projectedOriginKeys(rows: ProjectedNativeRecord[]): string[] {
	return rows.map((r) => recordKey(r.origin));
}
