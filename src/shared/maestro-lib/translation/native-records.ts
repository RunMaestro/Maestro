import { canonicalJson } from '../../canonicalJson';
import * as path from 'node:path';
import { hasEmbeddedSystemPrompt, stripEmbeddedSystemPrompt } from '../../embeddedSystemPrompt';
import { isPathAtOrUnderRoot } from '../../worktreePaths';
import { translationArtifact, translationHash } from './identity';
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
	const lastBoundaryIndex = rows.reduce(
		(last, row) =>
			(
				identity.provider === 'claude-code'
					? row.entry?.type === 'system' && row.entry.subtype === 'compact_boundary'
					: identity.provider === 'codex' && row.entry?.type === 'compacted'
			)
				? row.index
				: last,
		-1
	);
	const claudeSummaryIndex =
		identity.provider === 'claude-code' && lastBoundaryIndex >= 0
			? rows.find(
					(row) =>
						row.index > lastBoundaryIndex &&
						row.entry?.type === 'user' &&
						row.entry.isCompactSummary === true
				)?.index
			: undefined;
	// Feed compacted Responses items through the ordinary mapper. Keep earlier
	// replacement items too, so their identities survive a later compaction.
	const extractionRows: Array<NativeLine & { compactionItemId?: string }> = [];
	for (const row of rows) {
		extractionRows.push(row);
		if (identity.provider !== 'codex' || row.entry?.type !== 'compacted') continue;
		const payload = row.entry.payload;
		const replacement = payload?.replacement_history;
		const items: unknown[] =
			Array.isArray(replacement) && replacement.length
				? replacement
				: typeof payload?.message === 'string' && payload.message.length
					? [{ type: 'message', role: 'user', content: payload.message }]
					: [];
		if (row.index === lastBoundaryIndex && !items.length)
			conversation.limitations.push({
				code: 'missing-compaction-history',
				severity: 'block',
				tabId,
				message: 'The latest Codex compaction has no replacement history or summary to carry.',
			});
		for (const [index, item] of items.entries()) {
			if (!item || typeof item !== 'object' || Array.isArray(item))
				conversation.limitations.push({
					code: 'invalid-compaction-history',
					severity: 'block',
					tabId,
					message: `Compaction item ${index} at native record ${row.index} is not a Responses item.`,
				});
			extractionRows.push({
				...row,
				entry: { type: 'response_item', timestamp: row.entry.timestamp, payload: item },
				// Retained items can reuse an earlier native ID. Scope identity to the
				// boundary and position without changing the provider's original item.
				compactionItemId: `line:${row.index}:compaction:${index}`,
			});
		}
	}
	if (
		identity.provider === 'claude-code' &&
		lastBoundaryIndex >= 0 &&
		claudeSummaryIndex === undefined
	)
		conversation.limitations.push({
			code: 'missing-compaction-history',
			severity: 'block',
			tabId,
			message: 'The latest Claude compaction has no subsequent compact summary to carry.',
		});
	const nativeIds = new Set<string>();
	let originCwd: string | undefined;
	let hasCwdDrift = false;
	for (const row of extractionRows) {
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
		const declaredCwd =
			identity.provider === 'codex' &&
			(entry.type === 'session_meta' || entry.type === 'turn_context')
				? entry.payload?.cwd
				: entry.cwd;
		if (typeof declaredCwd === 'string') {
			const resolvedCwd = path.resolve(declaredCwd);
			if (
				originCwd === undefined &&
				(identity.provider === 'claude-code' || entry.type === 'session_meta')
			) {
				originCwd = resolvedCwd;
				// The shared prefix check takes POSIX separators; these paths are local.
				if (
					!isPathAtOrUnderRoot(
						originCwd.split(path.sep).join('/'),
						path.resolve(identity.projectRoot).split(path.sep).join('/')
					)
				)
					conversation.limitations.push({
						code: 'native-project-root-mismatch',
						severity: 'block',
						tabId,
						message:
							'Selected native records originate outside the selected project root. Resolve their ownership before migration.',
					});
			} else if (originCwd !== undefined && resolvedCwd !== originCwd && !hasCwdDrift) {
				hasCwdDrift = true;
				conversation.limitations.push({
					code: 'native-cwd-drift',
					severity: 'info',
					tabId,
					message:
						'Native records change working directory after the session origin; original directories are preserved as source evidence.',
				});
			}
		}
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
		const nativeId =
			row.compactionItemId ?? (typeof candidateId === 'string' ? candidateId : `line:${row.index}`);
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
								severity: 'info',
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
							typeof block.image_url === 'string'
								? /^data:([^;]+);base64,(.+)$/.exec(block.image_url)
								: null;
						const data = block.source?.type === 'base64' ? block.source.data : dataUrl?.[2];
						const mediaType =
							block.source?.media_type ?? dataUrl?.[1] ?? 'application/octet-stream';
						const id = translationHash(canonicalJson({ origin, index: blocks.length }));
						if (typeof data === 'string') {
							if (!/^[a-zA-Z0-9+/\s]*={0,2}$/.test(data) || !data.trim())
								conversation.limitations.push({
									code: 'invalid-attachment',
									severity: 'block',
									tabId,
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
								tabId,
								message: `Image ${id} has no captured bytes. External image references require explicit resolution.`,
							});
						blocks.push({ kind: 'attachment', artifactId: id, mediaType, native: block });
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
			window:
				lastBoundaryIndex < 0 ||
				(identity.provider === 'claude-code'
					? row.index >= (claudeSummaryIndex ?? Infinity)
					: row.index > lastBoundaryIndex ||
						(row.index === lastBoundaryIndex && row.compactionItemId !== undefined))
					? 'active'
					: 'archived',
		};
		conversation.records.push(record);
		if (entry.type === 'attachment')
			conversation.limitations.push({
				code: 'native-attachment-state',
				severity: 'info',
				tabId,
				message: `Native attachment record ${nativeId} is archived; provider-specific runtime attachment discovery is unverified.`,
			});
		if (
			blocks.some((b) => b.kind === 'opaque') &&
			(role ||
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
				severity: 'info',
				tabId,
				message: `Opaque content at ${nativeId} is archived but cannot be resumed as foreign reasoning.`,
			});
		if (role === 'system' || role === 'developer')
			conversation.limitations.push({
				code: 'historical-instructions',
				severity: 'info',
				tabId,
				message: `Historical ${role} record ${nativeId} is archived, not installed as destination instructions.`,
			});
		if (boundary === 'fork' || record.branchId || entry.isSidechain)
			conversation.limitations.push({
				code: 'native-boundary',
				severity: 'warning',
				tabId,
				message: `Branch state at ${nativeId} is preserved; foreign runtime equivalence is unverified.`,
			});
	}
	const activeRecords = conversation.records.filter((record) => record.window === 'active');
	if (lastBoundaryIndex >= 0)
		conversation.limitations.push({
			code: 'compaction-window',
			severity: 'info',
			tabId,
			message: `Source compaction window: ${activeRecords.length} active records, ${conversation.records.length - activeRecords.length} archived records before the latest compaction summary.`,
		});
	if (!activeRecords.some((r) => r.role === 'user' || r.role === 'assistant'))
		conversation.limitations.push({
			code: 'missing-model-history',
			severity: 'block',
			tabId,
			message:
				'Native data contains no mapped model-visible conversation. UI/event projections alone cannot supply context continuity.',
		});
	const calls = new Set(
		activeRecords.flatMap((r) =>
			r.blocks.filter((b) => b.kind === 'tool-call').map((b) => b.callId)
		)
	);
	const results = new Set(
		activeRecords.flatMap((r) =>
			r.blocks.filter((b) => b.kind === 'tool-result').map((b) => b.callId)
		)
	);
	// Tool-only rows (including partial parallel results) and runtime metadata do not
	// advance the conversation past a stopped turn. Mixed text/tool rows still do.
	const lastConversationalIndex = activeRecords.reduce(
		(last, record, index) =>
			(record.role === 'user' || record.role === 'assistant') &&
			record.blocks.some((block) => block.kind !== 'tool-call' && block.kind !== 'tool-result')
				? index
				: last,
		-1
	);
	const interruptedCalls = new Set<string>();
	const seenCalls = new Set<string>();
	const seenResults = new Set<string>();
	for (const [index, record] of activeRecords.entries())
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
					tabId,
					message: `Tool evidence at ${record.nativeId} has no valid call linkage.`,
				});
			}
			if (block.kind !== 'tool-call' && block.kind !== 'tool-result') continue;
			if (record.role !== (block.kind === 'tool-call' ? 'assistant' : 'user'))
				conversation.limitations.push({
					code: 'invalid-tool-role',
					severity: 'block',
					tabId,
					message: `Tool evidence at ${record.nativeId} has an invalid message role for native projection.`,
				});
			if (!block.callId) continue;
			if (block.kind === 'tool-call' && !results.has(block.callId)) {
				if (index < lastConversationalIndex)
					conversation.limitations.push({
						code: 'unfinished-tool-call',
						severity: 'block',
						tabId,
						message: `Tool call ${block.callId} has no recorded result before later conversation. A pending source tool must not be replayed on the destination.`,
					});
				else {
					block.interrupted = true;
					interruptedCalls.add(block.callId);
				}
			}
			const seen = block.kind === 'tool-call' ? seenCalls : seenResults;
			if (seen.has(block.callId))
				conversation.limitations.push({
					code: 'duplicate-tool-link',
					severity: 'block',
					tabId,
					message: `Tool ${block.kind} ${block.callId} occurs more than once; native linkage is ambiguous.`,
				});
			if (block.kind === 'tool-result' && calls.has(block.callId) && !seenCalls.has(block.callId))
				conversation.limitations.push({
					code: 'tool-result-order',
					severity: 'block',
					tabId,
					message: `Tool result ${block.callId} precedes its call. Native history cannot be reordered during migration.`,
				});
			seen.add(block.callId);
		}
	if (interruptedCalls.size)
		conversation.limitations.push({
			code: 'interrupted-tool-call-dropped',
			severity: 'warning',
			tabId,
			message: `Stopped tool calls ${[...interruptedCalls].join(', ')} have no recorded results. They remain archived and are omitted from the destination session.`,
		});
	return conversation;
}
