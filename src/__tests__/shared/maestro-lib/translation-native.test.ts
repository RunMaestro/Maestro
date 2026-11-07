import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	extractNativeConversation,
	parseNativeLines,
} from '../../../shared/maestro-lib/translation/native-records';

const identity = {
	provider: 'claude-code' as const,
	version: '2.1.296',
	accountRoot: '/isolated/claude',
	projectRoot: '/isolated/project',
};
describe('native-preserving extraction', () => {
	it.each([
		['claude-compactions', 'claude-code', 7, 2],
		['codex-compacted-replacement', 'codex', 4, 4],
		['codex-compacted-message', 'codex', 4, 2],
	] as const)(
		'extracts the latest window from %s without losing source bytes',
		(fixture, provider, archived, active) => {
			const bytes = readFileSync(
				path.resolve('src/__tests__/fixtures/provider-translation', `${fixture}.jsonl`)
			);
			const bundle = extractNativeConversation(
				{ ...identity, provider, version: provider === 'codex' ? '0.162.1' : identity.version },
				't',
				'synthetic-compacted',
				bytes
			);
			const window = bundle.records.filter((record) => record.window === 'active');
			expect(window).toHaveLength(active);
			expect(window[0]).toMatchObject({
				role: 'user',
				blocks: [
					{ kind: 'text', text: 'Latest provider summary: archived lookup resolved to alpha.' },
				],
			});
			expect(window.at(-1)?.blocks).toEqual([
				{ kind: 'text', text: 'Continue from the compacted context.' },
			]);
			expect(bundle.records.filter((record) => record.window === 'archived')).toHaveLength(
				archived
			);
			expect(bundle.records.find((record) => record.nativeId === 'old-call')).toMatchObject({
				window: 'archived',
				blocks: [{ kind: 'tool-call', callId: 'archived-call' }],
			});
			// The unanswered call was resolved inside the provider summary, not by an invented result.
			expect(bundle.limitations.filter((limit) => limit.severity !== 'info')).toEqual([]);
			expect(bundle.limitations).toContainEqual({
				code: 'compaction-window',
				severity: 'info',
				tabId: 't',
				message: `Source compaction window: ${active} active records, ${archived} archived records before the latest compaction summary.`,
			});
			for (const { entry } of parseNativeLines(bytes.toString('utf8')))
				expect(bundle.records.map((record) => record.native)).toContainEqual(entry);
			expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
			if (fixture === 'codex-compacted-replacement') {
				expect(window[1].blocks).toMatchObject([{ kind: 'tool-call', callId: 'active-call' }]);
				expect(window[2].blocks).toMatchObject([{ kind: 'tool-result', callId: 'active-call' }]);
				expect(window[0].nativeId).not.toBe('old-user');
			}
		}
	);
	it('classifies recurring native evidence as info while keeping behavior loss as a warning', () => {
		const rows = [
			{
				type: 'user',
				uuid: 'user',
				cwd: identity.projectRoot,
				message: {
					role: 'user',
					content: embedSystemPromptInPrompt('Historical system rules', 'User request'),
				},
			},
			{
				type: 'assistant',
				uuid: 'assistant',
				cwd: '/later-directory',
				message: {
					role: 'assistant',
					content: [{ type: 'thinking', thinking: 'Opaque reasoning', signature: 'native-only' }],
				},
			},
			{ type: 'attachment', uuid: 'attachment' },
			{ type: 'system', uuid: 'boundary', subtype: 'compact_boundary' },
			{
				type: 'user',
				uuid: 'summary',
				isCompactSummary: true,
				message: { role: 'user', content: 'Source summary' },
			},
			{ type: 'fork', uuid: 'fork' },
		];
		const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'));
		const bundle = extractNativeConversation(identity, 'tab', 'session', bytes);
		for (const code of [
			'opaque-runtime-state',
			'native-attachment-state',
			'historical-instructions',
			'native-cwd-drift',
			'compaction-window',
		]) {
			expect(bundle.limitations).toContainEqual(
				expect.objectContaining({ code, severity: 'info' })
			);
		}
		expect(bundle.limitations).toContainEqual(
			expect.objectContaining({ code: 'native-boundary', severity: 'warning' })
		);
		expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
	});
	it('starts Claude context at the first user summary after the last boundary', () => {
		const rows = [
			{
				type: 'assistant',
				uuid: 'old-call',
				message: {
					role: 'assistant',
					content: [{ type: 'tool_use', id: 'old-call', name: 'Read', input: {} }],
				},
			},
			{ type: 'system', uuid: 'first-boundary', subtype: 'compact_boundary' },
			{
				type: 'user',
				uuid: 'first-summary',
				isCompactSummary: true,
				message: { role: 'user', content: 'Earlier summary' },
			},
			{
				type: 'system',
				uuid: 'last-boundary',
				subtype: 'compact_boundary',
				parentUuid: null,
				logicalParentUuid: 'first-summary',
			},
			{ type: 'attachment', uuid: 'attachment', isCompactSummary: true },
			{
				type: 'user',
				uuid: 'before-summary',
				message: {
					role: 'user',
					content: [{ type: 'tool_result', tool_use_id: 'absent', content: 'Archived result' }],
				},
			},
			{
				type: 'user',
				uuid: 'last-summary',
				parentUuid: 'last-boundary',
				isCompactSummary: true,
				message: { role: 'user', content: 'Source summary includes the old tool result' },
			},
			{
				type: 'assistant',
				uuid: 'later',
				parentUuid: 'last-summary',
				message: { role: 'assistant', content: 'Continue' },
			},
		];
		const bytes = Buffer.from(rows.map((row) => ` ${JSON.stringify(row)} `).join('\r\n') + '\r\n');
		const bundle = extractNativeConversation(identity, 't', 's', bytes);
		expect(
			bundle.records.filter((record) => record.window === 'active').map((r) => r.nativeId)
		).toEqual(['last-summary', 'later']);
		expect(bundle.records.filter((record) => record.window === 'archived')).toHaveLength(6);
		expect(bundle.records.map((record) => record.native)).toEqual(rows);
		expect(bundle.records[6].parentId).toBe('last-boundary');
		expect(bundle.records[0].blocks[0]).not.toHaveProperty('interrupted');
		expect(bundle.limitations.filter((limit) => limit.severity !== 'info')).toEqual([]);
		expect(bundle.limitations).toContainEqual({
			code: 'compaction-window',
			severity: 'info',
			tabId: 't',
			message:
				'Source compaction window: 2 active records, 6 archived records before the latest compaction summary.',
		});
		expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
	});
	it.each([false, true])(
		'maps Codex replacement items like ordinary items (custom tools: %s)',
		(custom) => {
			const items = [
				{
					type: 'message',
					id: 'reused',
					role: 'user',
					content: [{ type: 'input_text', text: 'Source summary' }],
				},
				{
					type: custom ? 'custom_tool_call' : 'function_call',
					id: 'call-row',
					call_id: 'retained-call',
					name: 'Read',
					...(custom ? { input: 'synthetic' } : { arguments: '{"path":"synthetic"}' }),
				},
				{
					type: 'message',
					role: 'assistant',
					phase: 'commentary',
					content: [{ type: 'output_text', text: 'Reading' }],
				},
			];
			const later = [
				{
					type: custom ? 'custom_tool_call_output' : 'function_call_output',
					call_id: 'retained-call',
					output: 'Source result',
				},
				{
					type: 'message',
					role: 'assistant',
					phase: 'final_answer',
					content: [{ type: 'output_text', text: 'Continue' }],
				},
			];
			const rows = [
				{
					type: 'response_item',
					payload: { type: 'message', id: 'reused', role: 'user', content: 'Old request' },
				},
				{
					type: 'response_item',
					payload: { type: 'function_call', call_id: 'old-call', name: 'Read', arguments: '{}' },
				},
				{
					type: 'compacted',
					payload: {
						message: 'Not carried when replacement history exists',
						replacement_history: items,
					},
				},
				...later.map((payload) => ({ type: 'response_item', payload })),
			];
			const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
			const bundle = extractNativeConversation({ ...identity, provider: 'codex' }, 't', 's', bytes);
			const ordinary = extractNativeConversation(
				{ ...identity, provider: 'codex' },
				't',
				's',
				Buffer.from(
					[...items, ...later]
						.map((payload) => JSON.stringify({ type: 'response_item', payload }))
						.join('\n')
				)
			);
			const active = bundle.records.filter((record) => record.window === 'active');
			expect(active.map(({ role, blocks, phase }) => ({ role, blocks, phase }))).toEqual(
				ordinary.records.map(({ role, blocks, phase }) => ({ role, blocks, phase }))
			);
			expect(active.slice(0, items.length).map((record) => record.native)).toEqual(
				items.map((payload) => ({ type: 'response_item', payload }))
			);
			expect(new Set(bundle.records.map((record) => record.nativeId)).size).toBe(
				bundle.records.length
			);
			expect(
				bundle.records.filter((record) => record.window === 'archived').map((r) => r.native)
			).toEqual(rows.slice(0, 3));
			expect(bundle.limitations.filter((limit) => limit.severity !== 'info')).toEqual([]);
			expect(bundle.limitations.filter((limit) => limit.code === 'compaction-window')).toEqual([
				expect.objectContaining({
					severity: 'info',
					message: expect.stringContaining('5 active records, 3 archived records'),
				}),
			]);
			expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
		}
	);
	it.each([{ replacement_history: undefined }, { replacement_history: [] }])(
		'carries a legacy Codex message when replacement history is $replacement_history',
		({ replacement_history }) => {
			const summary = ' Source-authored summary\nwith original whitespace. ';
			const rows = [
				{
					type: 'response_item',
					payload: { type: 'message', role: 'user', content: 'Old request' },
				},
				{ type: 'compacted', payload: { message: summary, replacement_history } },
				{
					type: 'response_item',
					payload: { type: 'message', role: 'assistant', content: 'Continue' },
				},
			];
			const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'));
			const bundle = extractNativeConversation({ ...identity, provider: 'codex' }, 't', 's', bytes);
			expect(bundle.records.filter((record) => record.window === 'active')).toMatchObject([
				{ role: 'user', blocks: [{ kind: 'text', text: summary }] },
				{ role: 'assistant', blocks: [{ kind: 'text', text: 'Continue' }] },
			]);
			expect(bundle.records.filter((record) => record.window === 'archived')).toHaveLength(2);
			expect(bundle.limitations.filter((limit) => limit.severity !== 'info')).toEqual([]);
			expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
		}
	);
	it('retains Codex replacement identities when another compaction is appended', () => {
		const first = {
			type: 'compacted',
			payload: {
				message: '',
				replacement_history: [{ type: 'message', role: 'user', content: 'First summary' }],
			},
		};
		const last = { type: 'compacted', payload: { message: 'Latest summary' } };
		const previous = extractNativeConversation(
			{ ...identity, provider: 'codex' },
			't',
			's',
			Buffer.from(JSON.stringify(first))
		);
		const current = extractNativeConversation(
			{ ...identity, provider: 'codex' },
			't',
			's',
			Buffer.from([first, last].map((row) => JSON.stringify(row)).join('\n'))
		);
		expect(current.records.slice(0, previous.records.length)).toEqual(
			previous.records.map((record) => ({ ...record, window: 'archived' }))
		);
		expect(current.records.filter((record) => record.window === 'active')).toMatchObject([
			{ role: 'user', blocks: [{ kind: 'text', text: 'Latest summary' }] },
		]);
		expect(current.limitations.filter((limit) => limit.severity !== 'info')).toEqual([]);
		expect(current.limitations.filter((limit) => limit.code === 'compaction-window')).toHaveLength(
			1
		);
	});
	it.each(['claude-code', 'codex'] as const)(
		'still blocks invalid tool links in the active %s window',
		(provider) => {
			const blocks = [
				{ type: 'tool_result', tool_use_id: 'reversed', content: 'Too early' },
				{ type: 'tool_use', id: 'reversed', name: 'Read', input: {} },
				{ type: 'tool_use', id: 'unfinished', name: 'Read', input: {} },
				{ type: 'tool_result', tool_use_id: 'absent', content: 'Orphan' },
			];
			const rows =
				provider === 'claude-code'
					? [
							{ type: 'system', uuid: 'boundary', subtype: 'compact_boundary' },
							{
								type: 'user',
								uuid: 'summary',
								isCompactSummary: true,
								message: { role: 'user', content: 'Summary' },
							},
							...blocks.map((block, index) => {
								const role = block.type === 'tool_use' ? 'assistant' : 'user';
								return { type: role, uuid: `tool-${index}`, message: { role, content: [block] } };
							}),
							{
								type: 'assistant',
								uuid: 'later',
								message: { role: 'assistant', content: 'Later conversation' },
							},
						]
					: [
							{
								type: 'compacted',
								payload: {
									replacement_history: [
										{ type: 'message', role: 'user', content: 'Summary' },
										...blocks.map((block) =>
											block.type === 'tool_use'
												? {
														type: 'function_call',
														call_id: block.id,
														name: block.name,
														arguments: '{}',
													}
												: {
														type: 'function_call_output',
														call_id: block.tool_use_id,
														output: block.content,
													}
										),
										{ type: 'message', role: 'assistant', content: 'Later conversation' },
									],
								},
							},
						];
			const bundle = extractNativeConversation(
				{ ...identity, provider },
				't',
				's',
				Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'))
			);
			expect(bundle.limitations).toEqual(
				expect.arrayContaining(
					['unfinished-tool-call', 'broken-tool-link', 'tool-result-order'].map((code) =>
						expect.objectContaining({ code, severity: 'block' })
					)
				)
			);
		}
	);
	it.each(['claude-code', 'codex'] as const)(
		'blocks missing %s compaction history even with later conversation',
		(provider) => {
			const rows =
				provider === 'claude-code'
					? [
							{ type: 'system', uuid: 'boundary', subtype: 'compact_boundary' },
							{ type: 'user', uuid: 'later', message: { role: 'user', content: 'Continue' } },
						]
					: [
							{ type: 'compacted', payload: { message: '', replacement_history: [] } },
							{
								type: 'response_item',
								payload: { type: 'message', role: 'user', content: 'Continue' },
							},
						];
			const bundle = extractNativeConversation(
				{ ...identity, provider },
				't',
				's',
				Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'))
			);
			expect(bundle.limitations).toContainEqual(
				expect.objectContaining({ code: 'missing-compaction-history', severity: 'block' })
			);
		}
	);
	it.each([{ item: null }, { item: 'invalid' }, { item: [] }])(
		'blocks invalid Codex replacement item $item without losing source bytes',
		({ item }) => {
			const bytes = Buffer.from(
				JSON.stringify({ type: 'compacted', payload: { replacement_history: [item] } })
			);
			const bundle = extractNativeConversation({ ...identity, provider: 'codex' }, 't', 's', bytes);
			expect(bundle.limitations).toContainEqual(
				expect.objectContaining({ code: 'invalid-compaction-history', severity: 'block' })
			);
			expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
		}
	);
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
		expect(result.records.every((record) => record.window === 'active')).toBe(true);
		expect(result.limitations.some((limit) => limit.code === 'compaction-window')).toBe(false);
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

	it('still blocks mismatched project ownership when the tool tail was interrupted', () => {
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
			expect.arrayContaining(['interrupted-tool-call-dropped', 'native-project-root-mismatch'])
		);
	});

	describe.each([
		{ provider: 'claude-code', custom: false },
		{ provider: 'codex', custom: false },
		{ provider: 'codex', custom: true },
	] as const)('$provider interrupted tools (custom: $custom)', ({ provider, custom }) => {
		it.each([
			{ laterRole: undefined, opaque: false },
			{ laterRole: 'user', opaque: false },
			{ laterRole: 'assistant', opaque: false },
			{ laterRole: 'user', opaque: true },
			{ laterRole: 'assistant', opaque: true },
		] as const)(
			'classifies an orphan with later role $laterRole (opaque: $opaque) without changing source evidence',
			({ laterRole, opaque }) => {
				const rows = [
					provider === 'claude-code'
						? {
								uuid: 'pending',
								type: 'assistant',
								message: {
									role: 'assistant',
									content: [{ type: 'tool_use', id: 'pending-call', name: 'Read', input: {} }],
								},
							}
						: {
								type: 'response_item',
								payload: {
									id: 'pending',
									type: custom ? 'custom_tool_call' : 'function_call',
									call_id: 'pending-call',
									name: 'Read',
									...(custom ? { input: 'synthetic' } : { arguments: '{}' }),
								},
							},
					...(laterRole
						? [
								provider === 'claude-code'
									? {
											uuid: 'later',
											type: laterRole,
											message: {
												role: laterRole,
												content: opaque
													? [{ type: 'future-content', data: 'Later conversation' }]
													: 'Later conversation',
											},
										}
									: {
											type: 'response_item',
											payload: {
												id: 'later',
												type: 'message',
												role: laterRole,
												content: opaque
													? [{ type: 'future-content', data: 'Later conversation' }]
													: [{ type: 'input_text', text: 'Later conversation' }],
											},
										},
							]
						: []),
					{ type: 'token_usage_record', data: { input_tokens: 12 } },
				];
				const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
				const bundle = extractNativeConversation({ ...identity, provider }, 't', 's', bytes);
				expect(bundle.records.map((record) => record.native)).toEqual(rows);
				expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
				expect(bundle.records[0].blocks[0]).toMatchObject({
					kind: 'tool-call',
					callId: 'pending-call',
					...(laterRole ? {} : { interrupted: true }),
				});
				if (laterRole) {
					expect(bundle.records[0].blocks[0]).not.toHaveProperty('interrupted');
					expect(bundle.limitations).toContainEqual(
						expect.objectContaining({ code: 'unfinished-tool-call', severity: 'block' })
					);
					expect(bundle.limitations.some((l) => l.code === 'interrupted-tool-call-dropped')).toBe(
						false
					);
				} else {
					expect(bundle.limitations.some((l) => l.severity === 'block')).toBe(false);
					expect(bundle.limitations).toContainEqual(
						expect.objectContaining({
							code: 'interrupted-tool-call-dropped',
							severity: 'warning',
							message: expect.stringContaining('pending-call'),
						})
					);
				}
			}
		);
	});

	describe.each(['claude-code', 'codex'] as const)('%s cwd ownership', (provider) => {
		it.each([
			{
				name: 'warns once for drift into subdirectories',
				origin: identity.projectRoot,
				later: [`${identity.projectRoot}/src`, `${identity.projectRoot}/docs`],
				blocked: false,
				drift: true,
			},
			{
				name: 'warns once for drift outside the project after a matching origin',
				origin: identity.projectRoot,
				later: ['/another-project', '/somewhere-else', identity.projectRoot],
				blocked: false,
				drift: true,
			},
			{
				name: 'accepts an origin inside the project',
				origin: `${identity.projectRoot}/src`,
				later: [`${identity.projectRoot}/src`],
				blocked: false,
				drift: false,
			},
			{
				name: 'blocks an outside origin even after returning to the project',
				origin: '/another-project',
				later: ['/another-project', identity.projectRoot],
				blocked: true,
				drift: true,
			},
			{
				name: 'blocks a similarly named sibling origin',
				origin: `${identity.projectRoot}-other`,
				later: [`${identity.projectRoot}-other`],
				blocked: true,
				drift: false,
			},
			{
				name: 'compares resolved paths without reporting equivalent cwds as drift',
				origin: `${identity.projectRoot}/src/..`,
				later: [identity.projectRoot, `${identity.projectRoot}/`],
				blocked: false,
				drift: false,
			},
		])('$name', ({ origin, later, blocked, drift }) => {
			const rows = [
				// Missing cwd on an earlier row must not hide the first declared origin.
				provider === 'claude-code'
					? { type: 'user', uuid: 'initial', message: { role: 'user', content: 'start' } }
					: {
							type: 'response_item',
							payload: {
								type: 'message',
								role: 'user',
								content: [{ type: 'input_text', text: 'start' }],
							},
						},
				...[origin, ...later].map((cwd, index) =>
					provider === 'claude-code'
						? {
								type: 'user',
								uuid: `cwd-${index}`,
								cwd,
								message: { role: 'user', content: 'continue' },
							}
						: {
								type: index === 0 ? 'session_meta' : 'turn_context',
								payload: { cwd, ...(index === 0 ? { id: 's' } : {}) },
							}
				),
			];
			const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
			const bundle = extractNativeConversation({ ...identity, provider }, 't', 's', bytes);
			expect(bundle.limitations.filter((l) => l.code === 'native-project-root-mismatch')).toEqual(
				blocked ? [expect.objectContaining({ severity: 'block', tabId: 't' })] : []
			);
			expect(bundle.limitations.filter((l) => l.code === 'native-cwd-drift')).toEqual(
				drift ? [expect.objectContaining({ severity: 'info', tabId: 't' })] : []
			);
			expect(bundle.limitations.filter((l) => l.severity === 'block')).toHaveLength(
				blocked ? 1 : 0
			);
			expect(bundle.records.map((record) => record.native)).toEqual(rows);
			expect(Buffer.from(bundle.artifacts[0].bytesBase64, 'base64')).toEqual(bytes);
		});
	});

	it('uses Codex session metadata as the origin instead of another row cwd', () => {
		const rows = [
			{ type: 'turn_context', payload: { cwd: '/before-session-metadata' } },
			{ type: 'session_meta', payload: { id: 's', cwd: identity.projectRoot } },
			{ type: 'turn_context', payload: { cwd: identity.projectRoot } },
		];
		const bundle = extractNativeConversation(
			{ ...identity, provider: 'codex' },
			't',
			's',
			Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'))
		);
		expect(bundle.limitations.some((l) => l.code === 'native-project-root-mismatch')).toBe(false);
		expect(bundle.limitations.some((l) => l.code === 'native-cwd-drift')).toBe(false);
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
		const valid = extractNativeConversation(identity, 't', 's', validBytes);
		expect(valid.limitations).toEqual([]);
		expect(valid.records.every((record) => record.window === 'active')).toBe(true);
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
