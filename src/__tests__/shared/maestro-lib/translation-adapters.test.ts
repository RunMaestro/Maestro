// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { planTranslation } from '../../../shared/maestro-lib/translation/registry';
import { extractNativeConversation } from '../../../shared/maestro-lib/translation/native-records';
import {
	projectConversation,
	createTranslationRegistry,
	codexTranslationAdapter,
	projectedOriginKeys,
	claudeTranslationAdapter,
} from '../../../shared/maestro-lib/translation/adapters';
import {
	activeContextRecords,
	formatTranslationRecordCounts,
} from '../../../shared/maestro-lib/translation/context-window';
import { recordKey } from '../../../shared/maestro-lib/translation/identity';
import { TranslationArchive } from '../../../shared/maestro-lib/translation/archive';
import {
	importSelectedCodexResources,
	readCodexThreadItems,
	extractCodexItemHistory,
} from '../../../shared/maestro-lib/translation/codex-import';
import type { TranslationRpc } from '../../../shared/maestro-lib/translation/types';
import {
	TRANSLATION_DIRECTIONS,
	getDeclaredTranslationDirection,
} from '../../../shared/maestro-lib/translation/support';

const identity = {
	provider: 'claude-code' as const,
	version: '2.1.296',
	accountRoot: '/isolated/claude',
	projectRoot: '/isolated/project',
};
describe('destination native projections', () => {
	it('counts user and assistant messages separately from native bookkeeping and tool events', () => {
		const conversation = extractNativeConversation(
			identity,
			'tab',
			'native',
			Buffer.from(
				[
					{ type: 'user', uuid: 'user', message: { role: 'user', content: 'Question' } },
					{
						type: 'assistant',
						uuid: 'tool',
						message: {
							role: 'assistant',
							content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { path: 'file' } }],
						},
					},
					{
						type: 'user',
						uuid: 'result',
						message: {
							role: 'user',
							content: [{ type: 'tool_result', tool_use_id: 'call', content: 'Result' }],
						},
					},
					{ type: 'assistant', uuid: 'answer', message: { role: 'assistant', content: 'Answer' } },
					{ type: 'progress', uuid: 'progress', message: 'Bookkeeping' },
				]
					.map((row) => JSON.stringify(row))
					.join('\n')
			)
		);
		const plan = planTranslation({
			agentId: 'agent',
			source: identity,
			destination: { ...identity, provider: 'codex', version: '0.162.1' },
			scope: { projectKnowledge: true, selectedUserResources: [] },
			conversations: [conversation],
			registry: createTranslationRegistry(),
		});
		expect(plan.counts.messages).toBe(2);
		expect(plan.counts.records).toBeGreaterThan(plan.counts.messages!);
	});

	it.each([
		['claude-compactions', 'claude-code', 7, 2],
		['codex-compacted-replacement', 'codex', 4, 4],
		['codex-compacted-message', 'codex', 4, 2],
	] as const)(
		'projects only the active %s window to both destinations and reports retained counts',
		async (fixture, source, archivedCount, activeCount) => {
			const sourceIdentity =
				source === 'claude-code'
					? identity
					: { ...identity, provider: 'codex' as const, version: '0.162.1' };
			const bytes = await fs.readFile(
				path.resolve('src/__tests__/fixtures/provider-translation', `${fixture}.jsonl`)
			);
			const conversation = extractNativeConversation(
				sourceIdentity,
				'tab',
				'synthetic-compacted',
				bytes
			);
			const active = activeContextRecords(conversation.records);
			expect(active).toHaveLength(activeCount);
			for (const destination of ['claude-code', 'codex'] as const) {
				const projected = projectConversation(conversation, destination, 'destination');
				expect(projected).toHaveLength(activeCount);
				expect(projectedOriginKeys(projected)).toEqual(active.map((r) => recordKey(r.origin)));
				expect(JSON.stringify(projected)).not.toMatch(
					/Archived request|Earlier provider summary|archived-call|Fallback summary/
				);
				expect(JSON.stringify(projected[0].item)).toContain(
					'Latest provider summary: archived lookup resolved to alpha.'
				);
				if (destination === 'claude-code')
					for (const [index, row] of projected.entries())
						expect(row.item.parentUuid).toBe(index ? projected[index - 1].id : null);
				const readback = extractNativeConversation(
					{
						...sourceIdentity,
						provider: destination,
						version: destination === 'codex' ? '0.162.1' : identity.version,
					},
					'tab',
					'destination',
					Buffer.from(
						projected
							.map((row) =>
								JSON.stringify(
									destination === 'codex' ? { type: 'response_item', payload: row.item } : row.item
								)
							)
							.join('\n')
					)
				);
				expect(readback.limitations.filter((limit) => limit.severity === 'block')).toEqual([]);
				expect(readback.records[0].blocks).toEqual(active[0].blocks);
				expect(readback.records.at(-1)?.blocks).toEqual(active.at(-1)?.blocks);
				if (fixture === 'codex-compacted-replacement') {
					expect(readback.records[1].blocks).toMatchObject([
						{
							kind: 'tool-call',
							callId: 'active-call',
							name: 'Read',
							input: destination === 'codex' ? '{"path":"next.txt"}' : { path: 'next.txt' },
						},
					]);
					expect(readback.records[2].blocks).toMatchObject([
						{ kind: 'tool-result', callId: 'active-call', output: 'Synthetic next result.' },
					]);
				}
			}
			const plan = planTranslation({
				agentId: 'agent',
				source: sourceIdentity,
				destination:
					source === 'codex' ? identity : { ...identity, provider: 'codex', version: '0.162.1' },
				scope: { projectKnowledge: true, selectedUserResources: [] },
				conversations: [conversation],
				registry: createTranslationRegistry(),
			});
			expect(plan.tabs[0]).toMatchObject({
				records: activeCount + archivedCount,
				activeRecords: activeCount,
				archivedRecords: archivedCount,
			});
			expect(plan.counts.records).toBe(activeCount + archivedCount);
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-compaction-'));
			try {
				const archive = new TranslationArchive(root);
				await archive.write({
					schemaVersion: 1,
					plan,
					state: 'planned',
					conversations: [conversation],
					resources: [],
					mappings: [],
					resourceWrites: [],
				});
				const saved = await archive.read(plan.agentId, plan.id);
				expect(saved.conversations[0].records).toEqual(conversation.records);
				const artifact = saved.conversations[0].artifacts[0];
				expect(Buffer.from(artifact.bytesBase64, 'base64')).toEqual(bytes);
				expect(
					await fs.readFile(
						path.join(
							path.dirname(archive.operationPath(plan.agentId, plan.id)),
							`${artifact.sha256}.bytes`
						)
					)
				).toEqual(bytes);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	);
	it('keeps legacy records active and renders both new and saved plan counts', () => {
		const conversation = extractNativeConversation(
			identity,
			'tab',
			'source',
			Buffer.from(JSON.stringify({ type: 'user', uuid: 'old', message: { content: 'Legacy' } }))
		);
		delete conversation.records[0].window;
		for (const destination of ['claude-code', 'codex'] as const)
			expect(projectConversation(conversation, destination, 'destination')).toHaveLength(1);
		expect(
			formatTranslationRecordCounts({ records: 4492, activeRecords: 312, archivedRecords: 4180 })
		).toBe('312 records carried, 4,180 archived before the last compaction');
		expect(formatTranslationRecordCounts({ records: 12 })).toBe('12 records carried');
	});
	it('uses the picker declarations for native direction and version registration', () => {
		const registry = createTranslationRegistry();
		for (const direction of TRANSLATION_DIRECTIONS) {
			for (const sourceVersion of [direction.sourceMinVersion, ...direction.sourceTestedVersions])
				for (const destinationVersion of [
					direction.destinationMinVersion,
					...direction.destinationTestedVersions,
				])
					expect(
						registry.direction(
							{ ...identity, provider: direction.source, version: sourceVersion },
							{ ...identity, provider: direction.destination, version: destinationVersion }
						)
					).toEqual(direction);
			expect(
				registry.direction(
					{ ...identity, provider: direction.source, version: direction.sourceTestedVersions[0] },
					{
						...identity,
						provider: direction.destination,
						version: direction.destinationTestedVersions[0],
					}
				)
			).toEqual(getDeclaredTranslationDirection(direction.source, direction.destination));
			expect(registry.get(direction.source)?.minVersion).toBe(direction.sourceMinVersion);
			expect(registry.get(direction.source)?.testedVersions).toEqual(
				direction.sourceTestedVersions
			);
			expect(direction.verification).toBe('unverified');
		}
		expect(getDeclaredTranslationDirection('opencode', 'codex')).toBeUndefined();
		expect(getDeclaredTranslationDirection('claude-code', 'opencode')).toBeUndefined();
		expect(getDeclaredTranslationDirection('codex', 'codex')).toBeUndefined();
		expect(getDeclaredTranslationDirection('unknown-provider', 'codex')).toBeUndefined();
	});
	it.each([
		['claude-code', '2.1.295', 'block'],
		['claude-code', '2.1.296', undefined],
		['claude-code', '2.1.302', undefined],
		['claude-code', '2.1.297', 'warning'],
		['claude-code', '2.1.301', 'warning'],
		['claude-code', '3.0.0', 'warning'],
		['claude-code', 'garbage', 'block'],
		['claude-code', '', 'block'],
		['codex', '0.162.0', 'block'],
		['codex', '0.162.1', undefined],
		['codex', '0.162.2', 'warning'],
		['codex', '0.163.0', undefined],
		['codex', 'garbage', 'block'],
	] as const)('checks %s %s as source and destination', (provider, version, severity) => {
		const registry = createTranslationRegistry();
		const selected = { ...identity, provider, version };
		const other = {
			...identity,
			provider: provider === 'codex' ? ('claude-code' as const) : ('codex' as const),
			version: provider === 'codex' ? '2.1.296' : '0.162.1',
		};
		for (const [source, destination] of [
			[selected, other],
			[other, selected],
		]) {
			const plan = planTranslation({
				agentId: 'a',
				source,
				destination,
				scope: { projectKnowledge: true, selectedUserResources: [] },
				conversations: [],
				registry,
			});
			const versionLimits = plan.limitations.filter((limit) => limit.code.endsWith('-version'));
			expect(plan.status).toBe(severity === 'block' ? 'blocked' : 'ready');
			expect(Boolean(registry.direction(source, destination))).toBe(severity !== 'block');
			if (severity) {
				expect(versionLimits).toHaveLength(1);
				expect(versionLimits[0]).toMatchObject({
					code: severity === 'block' ? 'unknown-version' : 'untested-version',
					severity,
				});
				expect(versionLimits[0].message).toContain(version || 'unknown');
				if (severity === 'warning') {
					expect(versionLimits[0].message).toContain(registry.get(provider)!.testedVersions[0]);
					expect(plan.limitations.some((limit) => limit.code === 'unsupported-direction')).toBe(
						false
					);
				}
			} else expect(versionLimits).toEqual([]);
		}
	});
	it.each([false, true])(
		'uses provider-assigned IDs and checks persisted content (changed=%s)',
		async (changed) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-native-ids-'));
			try {
				const file = path.join(root, 'native.jsonl');
				const conversation = extractNativeConversation(
					{ ...identity, version: '2.1.302' },
					'tab',
					'source',
					Buffer.from(
						JSON.stringify({
							type: 'user',
							uuid: 'one',
							message: { role: 'user', content: 'remember marker' },
						})
					)
				);
				const request = vi.fn(async (method, params) => {
					if (method === 'thread/start') return { thread: { id: 'native', path: file } };
					expect(params.items[0]).not.toHaveProperty('id');
					await fs.writeFile(
						file,
						params.items
							.map((item: Record<string, unknown>, i: number) =>
								JSON.stringify({
									type: 'response_item',
									payload: {
										...item,
										id: `msg_native_${i}`,
										...(changed && { content: [{ type: 'input_text', text: 'changed' }] }),
										internal_chat_message_metadata_passthrough: { turn_id: 'native-turn' },
									},
								})
							)
							.join('\n')
					);
					return {};
				});
				const staged = codexTranslationAdapter.stage(conversation, {
					operationId: 'operation',
					destination: { ...identity, provider: 'codex', version: '0.163.0', accountRoot: root },
					codex: { request: request as TranslationRpc['request'], onNotification: () => () => {} },
					recordIntent: async () => {},
				});
				if (changed) await expect(staged).rejects.toThrow('changed an injected item');
				else {
					const mapping = await staged;
					expect(Object.keys(mapping.lineage).map((key) => JSON.parse(key).eventId)).toEqual([
						'msg_native_0',
					]);
					expect(Object.values(mapping.lineage)).toEqual([conversation.records[0].origin]);
				}
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	);
	it('writes Claude history into the selected shared projects root with the destination version', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-shared-projects-'));
		try {
			const nativeSessionRoot = path.join(root, 'shared-projects');
			await fs.mkdir(nativeSessionRoot);
			const conversation = extractNativeConversation(
				identity,
				'tab',
				'source',
				Buffer.from(
					JSON.stringify({
						type: 'user',
						uuid: 'one',
						message: { role: 'user', content: 'marker' },
					})
				)
			);
			const mapping = await claudeTranslationAdapter.stage(conversation, {
				operationId: 'operation',
				destination: {
					...identity,
					version: '2.1.302',
					accountRoot: path.join(root, 'profile'),
					nativeSessionRoot,
				},
				recordIntent: async () => {},
			});
			expect(mapping.artifacts[0].path.startsWith(nativeSessionRoot + path.sep)).toBe(true);
			expect(
				JSON.parse((await fs.readFile(mapping.artifacts[0].path, 'utf8')).trim()).version
			).toBe('2.1.302');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('refuses a Codex rollout parent symlink before injecting history', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-codex-target-'));
		try {
			const accountRoot = path.join(root, 'codex');
			const external = path.join(root, 'external');
			await fs.mkdir(accountRoot);
			await fs.mkdir(external);
			await fs.symlink(external, path.join(accountRoot, 'sessions'), 'dir');
			const request = vi.fn().mockResolvedValue({
				thread: { id: 'native', path: path.join(accountRoot, 'sessions', 'native.jsonl') },
			});
			const conversation = extractNativeConversation(
				identity,
				'tab',
				'source',
				Buffer.from(
					JSON.stringify({
						type: 'user',
						uuid: 'one',
						message: { role: 'user', content: 'synthetic' },
					})
				)
			);
			await expect(
				codexTranslationAdapter.stage(conversation, {
					operationId: 'operation',
					destination: { ...identity, provider: 'codex', version: '0.162.1', accountRoot },
					codex: { request, onNotification: () => () => {} },
					recordIntent: async () => {},
				})
			).rejects.toThrow('symlink');
			expect(request).toHaveBeenCalledTimes(1);
			expect(request.mock.calls[0][0]).toBe('thread/start');
			expect(await fs.readdir(external)).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('reports archive-only assistant images before applying a Codex projection', () => {
		const conversation = extractNativeConversation(
			identity,
			'tab',
			'native',
			Buffer.from(
				JSON.stringify({
					type: 'assistant',
					uuid: 'image',
					message: {
						role: 'assistant',
						content: [
							{
								type: 'image',
								source: {
									type: 'base64',
									media_type: 'image/png',
									data: Buffer.from('synthetic image').toString('base64'),
								},
							},
						],
					},
				})
			)
		);
		const plan = planTranslation({
			agentId: 'agent',
			source: identity,
			destination: { ...identity, provider: 'codex', version: '0.162.1' },
			scope: { projectKnowledge: true, selectedUserResources: [] },
			conversations: [conversation],
			registry: createTranslationRegistry(),
		});
		expect(plan.limitations).toContainEqual(
			expect.objectContaining({ code: 'assistant-attachment-projection', severity: 'warning' })
		);
	});
	it('archives installed paginated item records and blocks conversion without raw native evidence', () => {
		const entries = [
			{
				turnId: 'turn',
				item: { id: 'item', type: 'agentMessage', phase: 'final_answer', text: 'synthetic' },
			},
		];
		const snapshot = extractCodexItemHistory(
			{ ...identity, provider: 'codex', version: '0.162.1' },
			't',
			'native',
			entries
		);
		expect(JSON.parse(Buffer.from(snapshot.artifacts[0].bytesBase64, 'base64').toString())).toEqual(
			entries
		);
		expect(snapshot.limitations[0]).toMatchObject({
			code: 'missing-native-rollout',
			severity: 'block',
		});
	});
	it('writes ordered tool history and excludes signed reasoning and historical system instructions', () => {
		const rows = [
			{
				uuid: 'a',
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'before' },
						{ type: 'tool_use', id: 'c', name: 'read', input: {} },
						{ type: 'text', text: 'after' },
						{ type: 'thinking', thinking: 'opaque', signature: 'never-forge' },
					],
				},
			},
			{
				uuid: 'b',
				type: 'user',
				message: {
					role: 'user',
					content: [{ type: 'tool_result', tool_use_id: 'c', content: 'output' }],
				},
			},
		];
		const bundle = extractNativeConversation(
			identity,
			't',
			's',
			Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n'))
		);
		const projected = projectConversation(bundle, 'codex', 'dest');
		expect(projected.map((r) => r.item.type)).toEqual([
			'message',
			'function_call',
			'message',
			'function_call_output',
		]);
		expect(JSON.stringify(projected)).not.toContain('never-forge');
		expect(projected[3].item.call_id).toBe('c');
		expect(projectConversation(bundle, 'codex', 'again')).toEqual(projected);
	});
	it.each(['claude-code', 'codex'] as const)(
		'projects a stopped parallel tool tail from %s without replay or fabricated results',
		(provider) => {
			const calls = ['completed', 'stopped-one', 'stopped-two'];
			const rows =
				provider === 'claude-code'
					? [
							{
								type: 'assistant',
								uuid: 'calls',
								message: {
									role: 'assistant',
									content: [
										{ type: 'text', text: 'Keep this text' },
										...calls.map((id) => ({ type: 'tool_use', id, name: 'Read', input: {} })),
									],
								},
							},
							{
								type: 'user',
								uuid: 'result',
								message: {
									role: 'user',
									content: [{ type: 'tool_result', tool_use_id: 'completed', content: 'ok' }],
								},
							},
						]
					: [
							{
								type: 'response_item',
								payload: {
									type: 'message',
									role: 'assistant',
									content: [{ type: 'output_text', text: 'Keep this text' }],
								},
							},
							...calls.map((call_id) => ({
								type: 'response_item',
								payload: {
									type: 'custom_tool_call',
									call_id,
									name: 'Read',
									input: 'synthetic',
								},
							})),
							{
								type: 'response_item',
								payload: { type: 'custom_tool_call_output', call_id: 'completed', output: 'ok' },
							},
						];
			const bundle = extractNativeConversation(
				{ ...identity, provider },
				't',
				's',
				Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'))
			);
			expect(bundle.limitations.some((l) => l.severity === 'block')).toBe(false);
			expect(bundle.limitations.filter((l) => l.code === 'interrupted-tool-call-dropped')).toEqual([
				expect.objectContaining({
					severity: 'warning',
					message: expect.stringContaining('stopped-one, stopped-two'),
				}),
			]);
			for (const destination of ['claude-code', 'codex'] as const) {
				const projected = projectConversation(bundle, destination, 'destination');
				const serialized = JSON.stringify(projected);
				expect(serialized).toContain('Keep this text');
				expect(serialized).not.toContain('stopped-one');
				expect(serialized).not.toContain('stopped-two');
				if (destination === 'codex') {
					expect(projected.map((r) => r.item.type)).toEqual([
						'message',
						provider === 'codex' ? 'custom_tool_call' : 'function_call',
						provider === 'codex' ? 'custom_tool_call_output' : 'function_call_output',
					]);
					expect(projected[1].item.call_id).toBe('completed');
					expect(projected[2].item.call_id).toBe('completed');
				} else {
					expect(
						projected.flatMap((r) => (r.item.message as { content: unknown[] }).content)
					).toEqual([
						{ type: 'text', text: 'Keep this text' },
						{
							type: 'tool_use',
							id: 'completed',
							name: 'Read',
							input: provider === 'codex' ? { input: 'synthetic' } : {},
						},
						{ type: 'tool_result', tool_use_id: 'completed', content: 'ok' },
					]);
				}
			}
		}
	);
	it('builds new Claude parent relationships without foreign reasoning signatures', () => {
		const bytes = Buffer.from(
			[
				{
					type: 'response_item',
					payload: {
						type: 'message',
						id: 'one',
						role: 'user',
						content: [{ type: 'input_text', text: 'same' }],
					},
				},
				{
					type: 'response_item',
					payload: {
						type: 'message',
						id: 'two',
						role: 'assistant',
						content: [{ type: 'output_text', text: 'same' }],
					},
				},
			]
				.map((r) => JSON.stringify(r))
				.join('\n')
		);
		const bundle = extractNativeConversation(
			{ ...identity, provider: 'codex', version: '0.162.1' },
			't',
			's',
			bytes
		);
		const rows = projectConversation(bundle, 'claude-code', 'new-native');
		expect(rows[0].item.parentUuid).toBeNull();
		expect(rows[1].item.parentUuid).toBe(rows[0].id);
		expect(rows.every((r) => r.item.sessionId === 'new-native')).toBe(true);
		expect(rows.every((r) => r.item.version === '2.1.296')).toBe(true);
		expect(createTranslationRegistry().get('opencode')).toBeUndefined();
	});
	it('refuses broad imports before sending RPC', async () => {
		const rpc = { request: vi.fn(), onNotification: vi.fn() } as unknown as TranslationRpc;
		await expect(
			importSelectedCodexResources(rpc, '/project', [
				{ cwd: '', itemType: 'MEMORY', description: 'unsafe', details: { memory: [] } },
			])
		).rejects.toThrow('Unsafe broad');
		expect(rpc.request).not.toHaveBeenCalled();
	});
	it('awaits asynchronous completion even when it arrives before the import response', async () => {
		let listener!: (method: string, params: unknown) => void;
		const remove = vi.fn();
		const rpc: TranslationRpc = {
			onNotification: (fn) => {
				listener = fn;
				return remove;
			},
			request: async <T>() => {
				listener('externalAgentConfig/import/completed', {
					importId: 'i',
					itemTypeResults: [{ itemType: 'MEMORY', successes: [], failures: [] }],
				});
				return { importId: 'i' } as T;
			},
		};
		const result = await importSelectedCodexResources(rpc, '/project', [
			{
				cwd: '/project',
				itemType: 'MEMORY',
				description: 'selected',
				details: { memory: ['topic.md'] },
			},
		]);
		expect(result.importId).toBe('i');
		expect(remove).toHaveBeenCalled();
	});
	it('reads all native history pages and detects a repeated cursor', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: [{ id: 'a' }], nextCursor: 'next' })
			.mockResolvedValueOnce({ data: [{ id: 'b' }] });
		expect(
			await readCodexThreadItems({ request, onNotification: () => () => {} }, 'native')
		).toEqual([{ id: 'a' }, { id: 'b' }]);
		expect(request.mock.calls[1][1].cursor).toBe('next');
	});
});
