import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	GROK_SUMMARY_MAX_BYTES,
	encodeGrokSessionSnapshot,
	extractGrokConversation,
	extractNativeConversation,
	parseNativeLines,
} from '../../../shared/maestro-lib/translation/native-records';
import { projectConversation } from '../../../shared/maestro-lib/translation/adapters';

const identity = {
	provider: 'claude-code' as const,
	version: '2.1.296',
	accountRoot: '/isolated/claude',
	projectRoot: '/isolated/project',
};
describe('native-preserving extraction', () => {
	it('reads the synthetic native fixtures without collapsing identical user events', () => {
		for (const provider of ['claude-code', 'codex'] as const) {
			const fixture = path.resolve(
				'src/__tests__/fixtures/provider-translation',
				provider === 'codex' ? 'codex.jsonl' : 'claude.jsonl'
			);
			const bundle = extractNativeConversation(
				{ ...identity, provider },
				't',
				provider === 'codex' ? 'synthetic-codex' : 's',
				readFileSync(fixture)
			);
			expect(
				bundle.records.filter(
					(r) => r.role === 'user' && r.blocks.some((b) => b.kind === 'text' && b.text === 'repeat')
				)
			).toHaveLength(2);
			expect(bundle.limitations.some((l) => l.code === 'opaque-runtime-state')).toBe(true);
		}
	});
	it('preserves repeated messages, tools, images, parent chains, reasoning and unknown rows', () => {
		const rows = [
			{ uuid: 'a', type: 'user', message: { role: 'user', content: 'same' } },
			{ uuid: 'b', parentUuid: 'a', type: 'user', message: { role: 'user', content: 'same' } },
			{
				uuid: 'c',
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'tool_use', id: 'call', name: 'read', input: { path: 'synthetic.md' } },
						{ type: 'thinking', thinking: 'synthetic', signature: 'synthetic-signature' },
					],
				},
			},
			{
				uuid: 'd',
				type: 'user',
				message: {
					role: 'user',
					content: [
						{ type: 'tool_result', tool_use_id: 'call', content: 'synthetic result' },
						{
							type: 'image',
							source: { type: 'base64', media_type: 'image/png', data: 'c3ludGhldGlj' },
						},
					],
				},
			},
			{ uuid: 'e', type: 'system', subtype: 'compact_boundary' },
			{ uuid: 'f', type: 'unknown', isSidechain: true },
		];
		const bytes = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
		const bundle = extractNativeConversation(identity, 'tab', 'session', bytes);
		expect(bundle.records).toHaveLength(6);
		expect(bundle.records[0].origin).not.toEqual(bundle.records[1].origin);
		expect(bundle.records[1].parentId).toBe('a');
		expect(bundle.records[3].blocks[0]).toMatchObject({ kind: 'tool-result', callId: 'call' });
		expect(bundle.artifacts).toHaveLength(2);
		expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
		expect(bundle.limitations.some((l) => l.code === 'opaque-runtime-state')).toBe(true);
	});
	it('keeps Codex UI projections opaque and carries tool linkage and phase', () => {
		const rows = [
			{
				type: 'response_item',
				payload: {
					type: 'message',
					id: 'a',
					role: 'assistant',
					phase: 'commentary',
					content: [{ type: 'output_text', text: 'same' }],
				},
			},
			{ type: 'event_msg', payload: { type: 'agent_message', message: 'same' } },
			{
				type: 'response_item',
				payload: { type: 'function_call', id: 'b', name: 'read', call_id: 'call', arguments: '{}' },
			},
			{
				type: 'response_item',
				payload: { type: 'function_call_output', id: 'c', call_id: 'call', output: 'ok' },
			},
			{
				type: 'response_item',
				payload: { type: 'reasoning', id: 'd', encrypted_content: 'synthetic' },
			},
		];
		const result = extractNativeConversation(
			{ ...identity, provider: 'codex', version: '0.162.1' },
			'tab',
			's',
			Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n'))
		);
		expect(result.records[0].phase).toBe('commentary');
		expect(result.records[1].role).toBeUndefined();
		expect(result.records[2].blocks[0]).toMatchObject({ kind: 'tool-call', callId: 'call' });
		expect(result.records[4].native).toEqual(rows[4]);
	});
	it('archives embedded system envelopes without installing them as incoming instructions', () => {
		const text = embedSystemPromptInPrompt('Old provider system rules', 'Actual user request');
		const native = { type: 'user', uuid: 'enveloped', message: { role: 'user', content: text } };
		const bundle = extractNativeConversation(
			identity,
			't',
			's',
			Buffer.from(JSON.stringify(native))
		);
		expect(bundle.records[0].blocks).toMatchObject([
			{ kind: 'opaque' },
			{ kind: 'text', text: 'Actual user request' },
		]);
		expect(bundle.records[0].native).toEqual(native);
	});

	it('blocks an interrupted native tool tail and mismatched project ownership', () => {
		const row = {
			type: 'assistant',
			uuid: 'pending',
			cwd: '/another-project',
			message: {
				role: 'assistant',
				content: [{ type: 'tool_use', id: 'pending-call', name: 'Read', input: {} }],
			},
		};
		const bundle = extractNativeConversation(identity, 't', 's', Buffer.from(JSON.stringify(row)));
		expect(bundle.limitations.map((l) => l.code)).toEqual(
			expect.arrayContaining(['unfinished-tool-call', 'native-project-root-mismatch'])
		);
	});

	it.each(['claude-code', 'codex'] as const)(
		'blocks reversed and duplicated tool linkage in %s before native staging',
		(provider) => {
			const blocks = [
				{ kind: 'result', id: 'call' },
				{ kind: 'call', id: 'call' },
				{ kind: 'call', id: 'call' },
				{ kind: 'result', id: 'call' },
			];
			const rows = blocks.map((block, index) => {
				const role = block.kind === 'call' ? 'assistant' : 'user';
				return provider === 'claude-code'
					? {
							uuid: `event-${index}`,
							type: role,
							message: {
								role,
								content: [
									block.kind === 'call'
										? { type: 'tool_use', id: block.id, name: 'Read', input: {} }
										: { type: 'tool_result', tool_use_id: block.id, content: 'synthetic' },
								],
							},
						}
					: {
							type: 'response_item',
							payload: {
								id: `event-${index}`,
								call_id: block.id,
								...(block.kind === 'call'
									? { type: 'function_call', name: 'Read', arguments: '{}' }
									: { type: 'function_call_output', output: 'synthetic' }),
							},
						};
			});
			const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'));
			const bundle = extractNativeConversation({ ...identity, provider }, 't', 's', bytes);
			expect(bundle.limitations).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: 'tool-result-order', severity: 'block' }),
					expect.objectContaining({ code: 'duplicate-tool-link', severity: 'block' }),
				])
			);
			expect(bundle.limitations.filter((l) => l.code === 'duplicate-tool-link')).toHaveLength(2);
			expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
		}
	);

	it('blocks Claude tools recorded under foreign roles and permits valid parallel calls', () => {
		const rows = [
			{
				type: 'assistant',
				uuid: 'calls',
				message: {
					role: 'assistant',
					content: ['one', 'two'].map((id) => ({ type: 'tool_use', id, name: 'Read', input: {} })),
				},
			},
			{
				type: 'user',
				uuid: 'results',
				message: {
					role: 'user',
					content: ['two', 'one'].map((id) => ({
						type: 'tool_result',
						tool_use_id: id,
						content: 'synthetic',
					})),
				},
			},
		];
		const validBytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'));
		expect(extractNativeConversation(identity, 't', 's', validBytes).limitations).toEqual([]);
		rows[0].message.role = 'user';
		rows[1].message.role = 'assistant';
		const invalidBytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'));
		const invalid = extractNativeConversation(identity, 't', 's', invalidBytes);
		expect(invalid.limitations.filter((l) => l.code === 'invalid-tool-role')).toHaveLength(4);
		expect(Buffer.from(invalid.artifacts[0].bytesBase64, 'base64')).toEqual(invalidBytes);
	});

	it('reports missing attachments, malformed records, duplicate IDs and orphan tool output', () => {
		const rows = [
			{
				uuid: 'a',
				type: 'user',
				message: {
					content: [
						{ type: 'image', source: { type: 'url', url: 'https://invalid.example/image' } },
						{ type: 'tool_result', tool_use_id: 'absent' },
					],
				},
			},
			{ uuid: 'a', type: 'unknown' },
		];
		const bundle = extractNativeConversation(
			identity,
			't',
			's',
			Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n{broken')
		);
		expect(bundle.limitations.map((l) => l.code)).toEqual(
			expect.arrayContaining([
				'missing-attachment',
				'malformed-native-record',
				'duplicate-native-id',
				'broken-tool-link',
			])
		);
		expect(parseNativeLines(' {broken\n\n')).toMatchObject([{ malformed: true, entry: null }]);
	});
});

// Sanitized, synthetic Grok `ConversationItem` rows. No real session, account
// or credential data; the shapes follow the pinned native record table.
const grokIdentity = {
	provider: 'grok' as const,
	version: '1.0.70',
	accountRoot: '/isolated/grok-a',
	projectRoot: '/isolated/project',
};
const PNG_BASE64 = Buffer.from('synthetic-png-bytes').toString('base64');
function grokSnapshot(
	rows: unknown[],
	summary: Record<string, unknown> | null = {
		info: { id: 'sess', cwd: '/isolated/project' },
		chat_format_version: 1,
	}
): Buffer {
	return encodeGrokSessionSnapshot({
		summary: summary ? Buffer.from(JSON.stringify(summary)) : null,
		transcript: Buffer.from(
			rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
		),
	});
}
const codes = (c: { limitations: { code: string }[] }) => c.limitations.map((l) => l.code);
const blocking = (c: { limitations: { code: string; severity: string }[] }) =>
	c.limitations.filter((l) => l.severity === 'block').map((l) => l.code);

describe('Grok native extraction', () => {
	it('gives roles only to prompts, prose and client tools, and archives untrusted runtime fields', () => {
		const rows = [
			{ type: 'system', content: 'SYNTHETIC-SYSTEM-PROMPT' },
			{ type: 'user', content: '<user_info>SYNTHETIC-USER-INFO</user_info>' },
			{ type: 'user', content: '<user_query>\nfirst prompt\n</user_query>', id: 'forged-id' },
			{ type: 'user', synthetic_reason: 'system_reminder', content: 'SYNTHETIC-REMINDER' },
			{ type: 'user', synthetic_reason: 'future_reason', content: 'SYNTHETIC-FUTURE' },
			{
				type: 'assistant',
				content: 'calling tools',
				model_id: 'SYNTHETIC-MODEL',
				reasoning: { encrypted_content: 'SYNTHETIC-ENCRYPTED' },
				tool_calls: [
					{ id: 'call_v1', name: 'read_file', arguments: '{"path":"a"}' },
					{ id: 'call_legacy', function: { name: 'list_dir', arguments: '{}' } },
				],
			},
			{ type: 'tool_result', tool_call_id: 'call_v1', content: 'failed: no such file' },
			{ type: 'tool', tool_call_id: 'call_legacy', content: [{ type: 'text', text: 'a\nb' }] },
			{ type: 'user', synthetic_reason: 'interjection', content: 'second prompt' },
			{ type: 'backend_tool_call', name: 'web_search', raw: 'SYNTHETIC-BACKEND' },
			{ type: 'future_row', payload: 'SYNTHETIC-UNKNOWN' },
			{ type: 'assistant', content: [{ type: 'text', text: 'done' }] },
		];
		const conversation = extractGrokConversation(grokIdentity, 'tab', 'sess', grokSnapshot(rows));
		expect(conversation.records.map((r) => r.role)).toEqual([
			'system',
			undefined,
			'user',
			undefined,
			undefined,
			'assistant',
			'user',
			'user',
			'user',
			undefined,
			undefined,
			'assistant',
		]);
		// Position is the identity: a native `id` field cannot forge another row's identity.
		expect(conversation.records.map((r) => r.nativeId)).toEqual(rows.map((_, i) => `line:${i}`));
		expect(conversation.records[2].blocks).toEqual([{ kind: 'text', text: 'first prompt' }]);
		expect(conversation.records[5].blocks.filter((b) => b.kind === 'tool-call')).toEqual([
			{ kind: 'tool-call', callId: 'call_v1', name: 'read_file', input: '{"path":"a"}' },
			{ kind: 'tool-call', callId: 'call_legacy', name: 'list_dir', input: '{}' },
		]);
		// Grok has no tool error flag; nothing is inferred from "failed:".
		expect(conversation.records[6].blocks[0]).toEqual({
			kind: 'tool-result',
			callId: 'call_v1',
			output: 'failed: no such file',
		});
		expect(conversation.records[7].blocks[0]).toMatchObject({ output: 'a\nb' });
		expect(blocking(conversation)).toEqual([]);
		expect(codes(conversation)).toEqual(
			expect.arrayContaining([
				'grok-runtime-state-not-translated',
				'grok-backend-tool-context',
				'historical-instructions',
				'opaque-runtime-state',
			])
		);
		expect(conversation.records.every((r) => r.timestamp === undefined)).toBe(true);
		const projected = JSON.stringify(projectConversation(conversation, 'claude-code', 'dest'));
		for (const secret of [
			'SYNTHETIC-SYSTEM-PROMPT',
			'SYNTHETIC-USER-INFO',
			'SYNTHETIC-REMINDER',
			'SYNTHETIC-FUTURE',
			'SYNTHETIC-MODEL',
			'SYNTHETIC-ENCRYPTED',
			'SYNTHETIC-BACKEND',
			'SYNTHETIC-UNKNOWN',
			'<user_query>',
		])
			expect(projected).not.toContain(secret);
		for (const visible of ['first prompt', 'second prompt', 'call_v1', 'call_legacy', 'done'])
			expect(projected).toContain(visible);
	});

	it('blocks duplicate, dangling, orphan and reordered tool linkage', () => {
		const call = (id: string) => ({
			type: 'assistant',
			content: '',
			tool_calls: [{ id, name: 'run', arguments: '{}' }],
		});
		const result = (id: string) => ({ type: 'tool_result', tool_call_id: id, content: 'ok' });
		const duplicate = extractGrokConversation(
			grokIdentity,
			'tab',
			'sess',
			grokSnapshot([
				{ type: 'user', content: 'go' },
				call('dup'),
				result('dup'),
				call('dup'),
				result('dup'),
			])
		);
		expect(blocking(duplicate)).toContain('duplicate-tool-link');
		const broken = extractGrokConversation(
			grokIdentity,
			'tab',
			'sess',
			grokSnapshot([
				{ type: 'user', content: 'go' },
				result('early'),
				call('early'),
				call('dangling'),
				result('orphan'),
				{ type: 'assistant', content: '', tool_calls: [{ id: 'nameless', arguments: '{}' }] },
				result('nameless'),
			])
		);
		expect(blocking(broken)).toEqual(
			expect.arrayContaining(['tool-result-order', 'unfinished-tool-call', 'broken-tool-link'])
		);
	});

	it('marks fork, branch, subagent and compaction state instead of flattening it', () => {
		const conversation = extractGrokConversation(
			grokIdentity,
			'tab',
			'sess',
			grokSnapshot(
				[
					{ type: 'user', content: 'inherited one' },
					{ type: 'assistant', content: 'inherited two' },
					{ type: 'user', content: 'after the fork' },
					{
						type: 'user',
						synthetic_reason: 'compaction_meta',
						content: 'SUMMARY of <user_query>kept</user_query> turns',
					},
					{ type: 'assistant', content: 'continuing' },
				],
				{
					info: { id: 'sess', cwd: '/isolated/project' },
					chat_format_version: 1,
					parent_session_id: 'parent-sess',
					inherited_prefix_len: 2,
					session_kind: 'subagent_task',
				}
			)
		);
		expect(conversation.records.every((r) => r.branchId === 'parent-sess')).toBe(true);
		expect(conversation.records.map((r) => r.boundary)).toEqual([
			undefined,
			undefined,
			'fork',
			'compaction',
			undefined,
		]);
		// A compaction summary is carried verbatim; it is not a typed prompt to unwrap.
		expect(conversation.records[3]).toMatchObject({
			role: 'user',
			blocks: [{ kind: 'text', text: 'SUMMARY of <user_query>kept</user_query> turns' }],
		});
		expect(codes(conversation)).toEqual(
			expect.arrayContaining(['grok-subagent-session', 'grok-compacted-history', 'native-boundary'])
		);
		expect(blocking(conversation)).toEqual([]);
	});

	it('captures inline images, blocks external and corrupt ones, and never fetches a URL', () => {
		const conversation = extractGrokConversation(
			grokIdentity,
			'tab',
			'sess',
			grokSnapshot([
				{
					type: 'user',
					content: [
						{ type: 'text', text: 'look' },
						{ type: 'image', url: `data:image/png;base64,${PNG_BASE64}` },
						{ type: 'image_url', image_url: { url: 'https://example.invalid/remote.png' } },
						{ type: 'image', url: 'data:image/png;base64,***not-base64***' },
						{ type: 'audio', data: 'SYNTHETIC-AUDIO' },
					],
				},
				{
					type: 'assistant',
					content: '',
					tool_calls: [{ id: 'shot', name: 'screenshot', arguments: '{}' }],
				},
				{
					type: 'tool_result',
					tool_call_id: 'shot',
					content: 'captured',
					images: [{ type: 'image', url: `data:image/jpeg;base64,${PNG_BASE64}` }],
				},
			])
		);
		const attachments = conversation.artifacts.filter((a) => a.kind === 'attachment');
		expect(attachments).toHaveLength(3);
		expect(Buffer.from(attachments[0].bytesBase64, 'base64').toString()).toBe(
			'synthetic-png-bytes'
		);
		expect(conversation.records[0].blocks.map((b) => b.kind)).toEqual([
			'text',
			'attachment',
			'attachment',
			'attachment',
			'opaque',
		]);
		expect(conversation.records[2].blocks.map((b) => b.kind)).toEqual([
			'tool-result',
			'attachment',
		]);
		expect(conversation.records[2].blocks[1]).toMatchObject({ mediaType: 'image/jpeg' });
		expect(blocking(conversation)).toEqual(
			expect.arrayContaining(['missing-attachment', 'invalid-attachment'])
		);
		expect(codes(conversation)).toContain('opaque-runtime-state');
	});

	it('keeps malformed rows as evidence and blocks unknown schema and identity mismatches', () => {
		const malformed = extractGrokConversation(
			grokIdentity,
			'tab',
			'sess',
			grokSnapshot([{ type: 'user', content: 'ok' }, '{"type":"assistant",', '[1,2]'])
		);
		expect(blocking(malformed).filter((c) => c === 'malformed-native-record')).toHaveLength(2);
		expect(malformed.records[1].native).toEqual({ type: 'malformed', raw: '{"type":"assistant",' });
		const summaryCodes = (summary: Record<string, unknown> | null | string) =>
			blocking(
				extractGrokConversation(
					grokIdentity,
					'tab',
					'sess',
					typeof summary === 'string'
						? encodeGrokSessionSnapshot({
								summary: Buffer.from(summary),
								transcript: Buffer.from('{"type":"user","content":"hi"}\n'),
							})
						: grokSnapshot([{ type: 'user', content: 'hi' }], summary)
				)
			);
		expect(summaryCodes(null)).toEqual(['native-summary-missing']);
		expect(summaryCodes('not json')).toEqual(['malformed-native-summary']);
		expect(summaryCodes('x'.repeat(GROK_SUMMARY_MAX_BYTES + 1))).toEqual([
			'native-summary-too-large',
		]);
		expect(summaryCodes({ info: { id: 'other', cwd: '/isolated/project' } })).toEqual([
			'native-session-mismatch',
		]);
		expect(summaryCodes({ info: { id: 'sess', cwd: '/elsewhere' } })).toEqual([
			'native-project-root-mismatch',
		]);
		expect(summaryCodes({ info: { id: 'sess' } })).toEqual(['native-project-root-mismatch']);
		expect(
			summaryCodes({ info: { id: 'sess', cwd: '/isolated/project' }, chat_format_version: 2 })
		).toEqual(['unknown-native-schema']);
		expect(summaryCodes({ info: { id: 'sess', cwd: '/isolated/project' } })).toEqual([]);
		// /private/tmp is the macOS alias of /tmp. On Windows both resolve under
		// the current drive (D:\private\tmp is a real, distinct folder), so the
		// alias is not folded there and the roots legitimately differ.
		expect(
			blocking(
				extractGrokConversation(
					{ ...grokIdentity, projectRoot: '/tmp/project' },
					'tab',
					'sess',
					grokSnapshot([{ type: 'user', content: 'hi' }], {
						info: { id: 'sess', cwd: '/private/tmp/project/' },
						chat_format_version: 0,
					})
				)
			)
		).toEqual(process.platform === 'win32' ? ['native-project-root-mismatch'] : []);
		// A bare transcript (no envelope) has no summary, so Grok itself could not load it.
		const bare = extractGrokConversation(
			grokIdentity,
			'tab',
			'sess',
			Buffer.from('{"type":"user","content":"hi"}\n')
		);
		expect(blocking(bare)).toEqual(['native-summary-missing']);
		expect(
			blocking(extractGrokConversation(grokIdentity, 'tab', 'sess', grokSnapshot([])))
		).toEqual(['missing-model-history']);
	});

	it('attributes the same session ID under two account roots to distinct origins', () => {
		const bytes = grokSnapshot([{ type: 'user', content: 'same' }]);
		const a = extractGrokConversation(grokIdentity, 'tab', 'sess', bytes);
		const b = extractGrokConversation(
			{ ...grokIdentity, accountRoot: '/isolated/grok-b' },
			'tab',
			'sess',
			bytes
		);
		expect(a.records[0].origin.account).not.toBe(b.records[0].origin.account);
		expect(JSON.stringify(a.records.map((r) => r.origin))).not.toContain('/isolated/grok-');
	});
});
