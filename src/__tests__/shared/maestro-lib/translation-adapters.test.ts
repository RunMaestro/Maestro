// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { planTranslation } from '../../../shared/maestro-lib/translation/registry';
import {
	encodeGrokCwdDirname,
	extractGrokConversation,
	extractNativeConversation,
} from '../../../shared/maestro-lib/translation/native-records';
import { translationArtifact } from '../../../shared/maestro-lib/translation/identity';
import {
	projectConversation,
	createTranslationRegistry,
	codexTranslationAdapter,
	claudeTranslationAdapter,
	grokStagedRowProblem,
	grokTranslationAdapter,
	projectGrokConversation,
	readGrokSessionSnapshot,
} from '../../../shared/maestro-lib/translation/adapters';
import {
	importSelectedCodexResources,
	readCodexThreadItems,
	extractCodexItemHistory,
} from '../../../shared/maestro-lib/translation/codex-import';
import type { TranslationRpc } from '../../../shared/maestro-lib/translation/types';
import {
	TRANSLATION_DIRECTIONS,
	TRANSLATION_PROVIDER_VERSIONS,
	getDeclaredTranslationDirection,
} from '../../../shared/maestro-lib/translation/support';

const identity = {
	provider: 'claude-code' as const,
	version: '2.1.296',
	accountRoot: '/isolated/claude',
	projectRoot: '/isolated/project',
};
describe('destination native projections', () => {
	it('uses the picker declarations for native direction and version registration', () => {
		const registry = createTranslationRegistry();
		for (const direction of TRANSLATION_DIRECTIONS) {
			for (const sourceVersion of direction.sourceVersions)
				for (const destinationVersion of direction.destinationVersions)
					expect(
						registry.direction(
							{ ...identity, provider: direction.source, version: sourceVersion },
							{ ...identity, provider: direction.destination, version: destinationVersion }
						)
					).toEqual(direction);
			expect(
				registry.direction(
					{ ...identity, provider: direction.source, version: direction.sourceVersions[0] },
					{
						...identity,
						provider: direction.destination,
						version: direction.destinationVersions[0],
					}
				)
			).toEqual(getDeclaredTranslationDirection(direction.source, direction.destination));
			expect(registry.get(direction.source)?.versions).toEqual(direction.sourceVersions);
			expect(direction.verification).toBe('unverified');
		}
		expect(getDeclaredTranslationDirection('opencode', 'codex')).toBeUndefined();
		expect(getDeclaredTranslationDirection('claude-code', 'opencode')).toBeUndefined();
		expect(getDeclaredTranslationDirection('codex', 'codex')).toBeUndefined();
		expect(getDeclaredTranslationDirection('unknown-provider', 'codex')).toBeUndefined();
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

// Sanitized Grok fixtures: temp accounts and projects only, synthetic text.
describe('Grok native reader, projection and staging', () => {
	const grokVersion = TRANSLATION_PROVIDER_VERSIONS.grok[0];
	async function grokFixture() {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'translation-grok-')));
		const projectRoot = path.join(root, 'project');
		await fs.mkdir(projectRoot);
		const account = (name: string) => ({
			provider: 'grok' as const,
			version: grokVersion,
			accountRoot: path.join(root, name),
			projectRoot,
		});
		const writeSession = async (
			accountRoot: string,
			sessionId: string,
			rows: unknown[],
			summary: Record<string, unknown> = {
				info: { id: sessionId, cwd: projectRoot },
				chat_format_version: 1,
			}
		) => {
			const dir = path.join(accountRoot, 'sessions', encodeGrokCwdDirname(projectRoot)!, sessionId);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary));
			await fs.writeFile(
				path.join(dir, 'chat_history.jsonl'),
				rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
			);
			return dir;
		};
		return { root, projectRoot, account, writeSession };
	}

	it('reads only the selected account and refuses missing, unsafe and escaping sessions', async () => {
		const { root, account, writeSession } = await grokFixture();
		try {
			const a = account('grok-a');
			const b = account('grok-b');
			await writeSession(a.accountRoot, 'sess', [{ type: 'user', content: 'from account A' }]);
			await writeSession(b.accountRoot, 'sess', [{ type: 'user', content: 'from account B' }]);
			await fs.writeFile(path.join(a.accountRoot, 'auth.json'), 'SYNTHETIC-CREDENTIAL');
			const readA = await readGrokSessionSnapshot(a, 'sess');
			const readB = await readGrokSessionSnapshot(b, 'sess');
			const conversationA = extractGrokConversation(a, 'tab', 'sess', readA.bytes);
			const conversationB = extractGrokConversation(b, 'tab', 'sess', readB.bytes);
			expect(conversationA.records[0].blocks).toEqual([{ kind: 'text', text: 'from account A' }]);
			expect(conversationB.records[0].blocks).toEqual([{ kind: 'text', text: 'from account B' }]);
			expect(conversationA.limitations.filter((l) => l.severity === 'block')).toEqual([]);
			expect(readA.transcriptPath.startsWith(a.accountRoot + path.sep)).toBe(true);
			expect(readA.bytes.toString()).not.toContain(
				Buffer.from('SYNTHETIC-CREDENTIAL').toString('base64')
			);
			await expect(readGrokSessionSnapshot(a, 'absent')).rejects.toThrow('missing');
			await expect(readGrokSessionSnapshot(a, '../sess')).rejects.toThrow('Unsafe');
			await expect(
				readGrokSessionSnapshot({ ...a, provider: 'claude-code' as never }, 'sess')
			).rejects.toThrow('Not a Grok');

			// A transcript linked to a file outside the account is never followed.
			const outside = path.join(root, 'outside.jsonl');
			await fs.writeFile(outside, '{"type":"user","content":"SYNTHETIC-OUTSIDE"}\n');
			const linked = await writeSession(a.accountRoot, 'linked', []);
			await fs.rm(path.join(linked, 'chat_history.jsonl'));
			await fs.symlink(outside, path.join(linked, 'chat_history.jsonl'));
			await expect(readGrokSessionSnapshot(a, 'linked')).rejects.toThrow('symlink');

			// A sessions folder linked to another account reads nothing from it.
			const c = account('grok-c');
			await fs.mkdir(c.accountRoot);
			await fs.symlink(path.join(b.accountRoot, 'sessions'), path.join(c.accountRoot, 'sessions'));
			await expect(readGrokSessionSnapshot(c, 'sess')).rejects.toThrow('symlink');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('stages a Claude conversation as a new Grok session that reads back with linkage intact', async () => {
		const { root, projectRoot, account } = await grokFixture();
		try {
			const destination = account('grok-dest');
			const claude = extractNativeConversation(
				{ ...identity, projectRoot },
				'tab',
				'source',
				Buffer.from(
					[
						{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'please read' } },
						{
							type: 'assistant',
							uuid: 'a1',
							message: {
								role: 'assistant',
								content: [
									{ type: 'thinking', thinking: 'SYNTHETIC-THINKING', signature: 'SYNTHETIC-SIG' },
									{ type: 'text', text: 'reading' },
									{ type: 'tool_use', id: 'toolu_dup_safe', name: 'Read', input: { p: 1 } },
								],
							},
						},
						{
							type: 'user',
							uuid: 'u2',
							message: {
								role: 'user',
								content: [
									{
										type: 'tool_result',
										tool_use_id: 'toolu_dup_safe',
										is_error: true,
										content: [{ type: 'text', text: 'denied' }],
									},
								],
							},
						},
					]
						.map((r) => JSON.stringify(r))
						.join('\n')
				)
			);
			const intents: number[] = [];
			const context = {
				operationId: 'operation',
				destination,
				recordIntent: async (mapping: { artifacts: { created: boolean }[] }) => {
					intents.push(mapping.artifacts.filter((a) => a.created).length);
				},
			};
			await expect(grokTranslationAdapter.stage(claude, context)).rejects.toThrow('model');
			await expect(fs.readdir(destination.accountRoot)).rejects.toThrow();
			const mapping = await grokTranslationAdapter.stage(claude, {
				...context,
				destinationModel: 'synthetic-grok-model',
			});
			expect(intents).toEqual([0, 1, 2]);
			const staged = await readGrokSessionSnapshot(destination, mapping.destinationSessionId);
			const back = extractGrokConversation(
				destination,
				'tab',
				mapping.destinationSessionId,
				staged.bytes
			);
			expect(back.records.map((r) => r.role)).toEqual(['user', 'assistant', 'user']);
			expect(back.records[1].blocks).toContainEqual(
				expect.objectContaining({ kind: 'tool-call', callId: 'toolu_dup_safe', input: '{"p":1}' })
			);
			expect(back.records[2].blocks[0]).toEqual({
				kind: 'tool-result',
				callId: 'toolu_dup_safe',
				output: 'denied',
			});
			expect(back.limitations.filter((l) => l.severity === 'block')).toEqual([]);
			const written = await fs.readFile(staged.transcriptPath, 'utf8');
			for (const forbidden of ['SYNTHETIC-THINKING', 'SYNTHETIC-SIG', 'model_id', 'is_error'])
				expect(written).not.toContain(forbidden);
			expect(Object.keys(mapping.lineage)).toHaveLength(3);
			if (process.platform !== 'win32')
				expect((await fs.stat(staged.transcriptPath)).mode & 0o777).toBe(0o600);
			// A second stage never reuses the first session directory.
			const again = await grokTranslationAdapter.stage(claude, {
				...context,
				destinationModel: 'synthetic-grok-model',
			});
			expect(again.destinationSessionId).not.toBe(mapping.destinationSessionId);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('refuses to project content Grok cannot hold and validates staged rows strictly', () => {
		const conversation = (blocks: unknown[], artifacts: unknown[] = []) =>
			({
				tabId: 'tab',
				nativeSessionId: 'source',
				identity,
				records: [
					{
						origin: { provider: 'claude-code', account: 'a', sessionId: 's', eventId: 'e' },
						nativeId: 'e',
						sequence: 0,
						role: 'user',
						blocks,
						semanticHash: 'h',
					},
				],
				artifacts,
				limitations: [],
			}) as never;
		const pdf = translationArtifact('attachment', 'doc', 'doc.bin', Buffer.from('%PDF'));
		expect(() =>
			projectGrokConversation(
				conversation(
					[{ kind: 'attachment', artifactId: pdf.id, mediaType: 'application/pdf' }],
					[pdf]
				)
			)
		).toThrow('inline image');
		expect(() =>
			projectGrokConversation(
				conversation([{ kind: 'attachment', artifactId: 'gone', mediaType: 'image/png' }])
			)
		).toThrow('Missing or corrupt attachment');
		expect(() =>
			projectGrokConversation(conversation([{ kind: 'tool-result', output: 'x' }]))
		).toThrow('call ID');
		expect(projectGrokConversation(conversation([{ kind: 'opaque', native: {} }]))).toEqual([]);
		for (const row of [
			{ type: 'user', content: [{ type: 'text', text: 'x' }], model_id: 'm' },
			{ type: 'user', content: [] },
			{ type: 'user', content: [{ type: 'image', url: 'https://example.invalid/a.png' }] },
			{ type: 'assistant', content: 'x', tool_calls: [] },
			{ type: 'assistant', content: 'x', tool_calls: [{ id: 'c', name: 'n', arguments: {} }] },
			{ type: 'tool_result', tool_call_id: '', content: 'x' },
			{
				type: 'tool_result',
				tool_call_id: 'c',
				content: 'x',
				images: [{ type: 'text', text: 'x' }],
			},
			{ type: 'reasoning', content: 'x' },
		])
			expect(grokStagedRowProblem(row)).not.toBeNull();
		expect(grokStagedRowProblem({ type: 'assistant', content: '' })).toBeNull();
	});

	it('plans Grok directions with explicit limitations and blocks unknown versions and long paths', () => {
		const registry = createTranslationRegistry();
		const claude = extractNativeConversation(
			identity,
			'tab',
			'source',
			Buffer.from(
				[
					{
						type: 'user',
						uuid: 'u1',
						timestamp: '2026-01-01T00:00:00Z',
						message: { role: 'user', content: 'hi' },
					},
					{
						type: 'assistant',
						uuid: 'a1',
						message: {
							role: 'assistant',
							content: [
								{
									type: 'image',
									source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
								},
								{ type: 'tool_use', id: 't1', name: 'Run', input: {} },
							],
						},
					},
					{
						type: 'user',
						uuid: 'u2',
						message: {
							role: 'user',
							content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'no' }],
						},
					},
				]
					.map((r) => JSON.stringify(r))
					.join('\n')
			)
		);
		const grok = {
			provider: 'grok' as const,
			version: grokVersion,
			accountRoot: '/isolated/grok',
			projectRoot: '/isolated/project',
		};
		const plan = (destination: typeof grok, conversations = [claude], source = identity) =>
			planTranslation({
				agentId: 'agent',
				source,
				destination,
				scope: { projectKnowledge: false, selectedUserResources: [] },
				conversations,
				registry,
			} as never);
		const ready = plan(grok);
		expect(ready.status).toBe('ready');
		expect(ready.verification).toBe('unverified');
		expect(ready.limitations.map((l) => l.code)).toEqual(
			expect.arrayContaining([
				'assistant-attachment-projection',
				'tool-error-flag-lost',
				'source-timestamps-dropped',
				'grok-native-replay-absent',
				'grok-search-index-unaffected',
				'grok-remote-session-sync-unverified',
				'unverified-native-resume',
			])
		);
		const longCwd = plan({ ...grok, projectRoot: '/' + 'd'.repeat(300) });
		expect(longCwd.status).toBe('blocked');
		expect(longCwd.limitations).toContainEqual(
			expect.objectContaining({ code: 'grok-long-cwd-unsupported', severity: 'block' })
		);
		const unknown = plan({ ...grok, version: '9.9.9' });
		expect(unknown.limitations).toContainEqual(
			expect.objectContaining({ code: 'unknown-version', severity: 'block' })
		);
		expect(unknown.limitations).toContainEqual(
			expect.objectContaining({ code: 'unsupported-direction', severity: 'block' })
		);
		// Grok to Grok on another account has no declared contract.
		const sameProvider = plan({ ...grok, accountRoot: '/isolated/grok-b' }, [claude], grok);
		expect(sameProvider.limitations).toContainEqual(
			expect.objectContaining({ code: 'unsupported-direction' })
		);
	});
});
