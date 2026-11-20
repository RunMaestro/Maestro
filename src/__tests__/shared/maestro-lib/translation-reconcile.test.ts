import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	reconcileConversation,
	reconcileResource,
} from '../../../shared/maestro-lib/translation/reconcile';
import { extractNativeConversation } from '../../../shared/maestro-lib/translation/native-records';
import { nativeRecordKey, recordKey } from '../../../shared/maestro-lib/translation/identity';
import { projectConversation } from '../../../shared/maestro-lib/translation/adapters';
import { activeContextRecords } from '../../../shared/maestro-lib/translation/context-window';
import {
	planTranslation,
	TranslationRegistry,
} from '../../../shared/maestro-lib/translation/registry';
import type { TranslationCheckpoint } from '../../../shared/maestro-lib/translation/types';

const identity = {
	provider: 'claude-code' as const,
	version: '2.1.296',
	accountRoot: '/isolated/claude',
	projectRoot: '/project',
};
const read = (id: string, text = 'same') =>
	extractNativeConversation(
		identity,
		't',
		's',
		Buffer.from(
			JSON.stringify({ uuid: id, type: 'user', message: { role: 'user', content: text } })
		)
	);
const empty = (): TranslationCheckpoint => ({
	observed: {},
	lineage: {},
	conversations: [],
	resources: [],
	resourceBases: {},
	providerRoots: {},
});
describe('reversible translation planning', () => {
	it.each([
		['claude-compactions', 'claude-code'],
		['codex-compacted-replacement', 'codex'],
		['codex-compacted-message', 'codex'],
	] as const)(
		'preserves %s evidence and new work across repeated A to B to A hops',
		(fixture, provider) => {
			const source = {
				...identity,
				provider,
				version: provider === 'codex' ? '0.162.1' : identity.version,
				accountRoot: `/isolated/${provider}`,
				projectRoot: '/isolated/project',
			};
			const bytes = readFileSync(
				path.resolve('src/__tests__/fixtures/provider-translation', `${fixture}.jsonl`)
			);
			const original = extractNativeConversation(source, 't', 'synthetic-compacted', bytes);
			const originalSnapshot = structuredClone(original);
			const checkpoint = empty();
			checkpoint.conversations = [original];
			for (const record of original.records)
				checkpoint.observed[nativeRecordKey(source, 'synthetic-compacted', record.nativeId)] =
					record.semanticHash;
			const otherProvider = provider === 'codex' ? 'claude-code' : 'codex';
			for (const [hop, destination] of (
				[otherProvider, provider, otherProvider, provider] as const
			).entries()) {
				const target = {
					...source,
					provider: destination,
					version: destination === 'codex' ? '0.162.1' : identity.version,
					accountRoot: `/isolated/${destination}`,
				};
				const sessionId = `hop-${hop}`;
				const projected = projectConversation(checkpoint.conversations[0], destination, sessionId);
				for (const row of projected)
					checkpoint.lineage[nativeRecordKey(target, sessionId, row.id)] = row.origin;
				const rows: unknown[] = projected.map((row) =>
					destination === 'codex' ? { type: 'response_item', payload: row.item } : row.item
				);
				if (hop === 0)
					rows.push(
						destination === 'codex'
							? {
									type: 'response_item',
									payload: {
										type: 'message',
										id: 'new-on-b',
										role: 'user',
										content: 'New work after the switch.',
									},
								}
							: {
									type: 'user',
									uuid: 'new-on-b',
									parentUuid: projected.at(-1)!.id,
									message: { role: 'user', content: 'New work after the switch.' },
								}
					);
				const incoming = extractNativeConversation(
					target,
					't',
					sessionId,
					Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'))
				);
				const result = reconcileConversation(incoming, checkpoint);
				expect(result.limitations.filter((limit) => limit.severity === 'block')).toEqual([]);
				expect(result.newRecords).toBe(hop === 0 ? 1 : 0);
				expect(result.conversation.records).toHaveLength(original.records.length + 1);
				expect(
					new Set(result.conversation.records.map((record) => recordKey(record.origin))).size
				).toBe(original.records.length + 1);
				expect(result.conversation.records.slice(0, original.records.length)).toEqual(
					originalSnapshot.records
				);
				expect(result.conversation.records.at(-1)?.blocks).toEqual([
					{ kind: 'text', text: 'New work after the switch.' },
				]);
				expect(activeContextRecords(result.conversation.records)).toHaveLength(
					activeContextRecords(original.records).length + 1
				);
				expect(result.conversation.artifacts).toEqual(
					expect.arrayContaining(originalSnapshot.artifacts)
				);
				expect(
					Buffer.from(
						result.conversation.artifacts.find(
							(artifact) => artifact.id === original.artifacts[0].id
						)!.bytesBase64,
						'base64'
					)
				).toEqual(bytes);
				checkpoint.conversations = [result.conversation];
				for (const record of incoming.records)
					checkpoint.observed[nativeRecordKey(target, sessionId, record.nativeId)] =
						record.semanticHash;
				expect(reconcileConversation(incoming, checkpoint).newRecords).toBe(0);
			}
			expect(original).toEqual(originalSnapshot);
		}
	);
	it('refreshes known window membership after compaction without changing checkpoint evidence', () => {
		const previous = read('one');
		previous.records.push(...read('checkpoint-only').records);
		const checkpoint = empty();
		checkpoint.conversations = [previous];
		checkpoint.observed[nativeRecordKey(identity, 's', 'one')] = previous.records[0].semanticHash;
		const bytes = Buffer.from(
			[
				JSON.stringify(previous.records[0].native),
				JSON.stringify({ type: 'system', uuid: 'boundary', subtype: 'compact_boundary' }),
				JSON.stringify({
					type: 'user',
					uuid: 'summary',
					isCompactSummary: true,
					message: { role: 'user', content: 'Provider summary' },
				}),
			].join('\n')
		);
		const result = reconcileConversation(
			extractNativeConversation(identity, 't', 's', bytes),
			checkpoint
		);
		expect(result.newRecords).toBe(2);
		expect(result.limitations.some((limit) => limit.severity === 'block')).toBe(false);
		expect(result.conversation.records[0]).toEqual({ ...previous.records[0], window: 'archived' });
		expect(result.conversation.records[1]).toEqual({ ...previous.records[1], window: 'archived' });
		expect(previous.records[0].window).toBe('active');
		expect(previous.records[1].window).toBe('active');
		expect(
			activeContextRecords(result.conversation.records).map((record) => record.nativeId)
		).toEqual(['summary']);
		expect(
			reconcileConversation(result.conversation, {
				...checkpoint,
				conversations: [result.conversation],
			}).newRecords
		).toBe(0);
	});
	it('retains archived origins across A to B to A, including a later compaction on B', () => {
		const original = read('archived', 'Old context');
		original.records[0].window = 'archived';
		original.records.push(...read('summary', 'Provider summary').records);
		const originalSnapshot = structuredClone(original);
		const checkpoint = empty();
		checkpoint.conversations = [original];
		const codex = { ...identity, provider: 'codex' as const, version: '0.162.1' };
		const projected = projectConversation(original, 'codex', 'b');
		for (const row of projected)
			checkpoint.lineage[nativeRecordKey(codex, 'b', row.id)] = row.origin;
		const rows: unknown[] = projected.map((row) => ({ type: 'response_item', payload: row.item }));
		rows.push({
			type: 'response_item',
			payload: { type: 'message', id: 'new', role: 'assistant', content: 'New on B' },
		});
		const incoming = extractNativeConversation(
			codex,
			't',
			'b',
			Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'))
		);
		const first = reconcileConversation(incoming, checkpoint);
		expect(first.newRecords).toBe(1);
		expect(first.conversation.records).toHaveLength(3);
		expect(first.conversation.records[0]).toEqual(originalSnapshot.records[0]);
		checkpoint.conversations = [first.conversation];
		for (const record of incoming.records)
			checkpoint.observed[nativeRecordKey(codex, 'b', record.nativeId)] = record.semanticHash;
		rows.push({ type: 'compacted', payload: { message: 'Later B summary' } });
		const compacted = reconcileConversation(
			extractNativeConversation(
				codex,
				't',
				'b',
				Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'))
			),
			checkpoint
		);
		expect(compacted.newRecords).toBe(2);
		expect(compacted.limitations.some((limit) => limit.severity === 'block')).toBe(false);
		expect(activeContextRecords(compacted.conversation.records)).toHaveLength(1);
		checkpoint.conversations = [compacted.conversation];
		const back = projectConversation(compacted.conversation, 'claude-code', 'a-return');
		for (const row of back)
			checkpoint.lineage[nativeRecordKey(identity, 'a-return', row.id)] = row.origin;
		const returned = reconcileConversation(
			extractNativeConversation(
				identity,
				't',
				'a-return',
				Buffer.from(back.map((row) => JSON.stringify(row.item)).join('\n'))
			),
			checkpoint
		);
		expect(returned.newRecords).toBe(0);
		expect(returned.conversation.records).toHaveLength(5);
		expect(
			new Set(returned.conversation.records.map((record) => recordKey(record.origin))).size
		).toBe(5);
		expect(returned.conversation.records[0]).toEqual(originalSnapshot.records[0]);
		expect(returned.conversation.artifacts).toEqual(
			expect.arrayContaining(originalSnapshot.artifacts)
		);
		expect(activeContextRecords(returned.conversation.records)).toHaveLength(1);
		expect(projectConversation(returned.conversation, 'codex', 'b-again')).toHaveLength(1);
	});
	it('uses origin identity across A -> B -> A -> B, preserving repeated text', () => {
		let checkpoint = empty();
		checkpoint.conversations = [read('one')];
		for (const provider of ['codex', 'claude-code', 'codex'] as const) {
			const incoming = read('native-' + provider);
			incoming.identity = { ...identity, provider };
			incoming.nativeSessionId = provider;
			checkpoint.lineage[
				nativeRecordKey(incoming.identity, provider, incoming.records[0].nativeId)
			] = checkpoint.conversations[0].records[0].origin;
			const result = reconcileConversation(incoming, checkpoint);
			expect(result.newRecords).toBe(0);
			expect(result.conversation.records).toHaveLength(1);
			checkpoint.conversations = [result.conversation];
		}
		const second = reconcileConversation(read('two'), checkpoint);
		expect(second.conversation.records).toHaveLength(2);
	});
	it('blocks edits and truncation rather than text-deduplicating', () => {
		const checkpoint = empty();
		const initial = read('one');
		checkpoint.conversations = [initial];
		checkpoint.observed[nativeRecordKey(identity, 's', 'one')] = initial.records[0].semanticHash;
		expect(reconcileConversation(read('one', 'edited'), checkpoint).limitations).toMatchObject([
			{ code: 'edited-native-record' },
		]);
		expect(reconcileConversation(read('two'), checkpoint).limitations).toMatchObject([
			{ code: 'truncated-native-history' },
		]);
	});
	it('retains conflicting variants and deletion tombstones', () => {
		expect(reconcileResource('base', 'source', 'destination')).toEqual({
			state: 'conflict',
			value: 'base',
			variants: ['source', 'destination'],
		});
		expect(reconcileResource('base', null, 'base')).toEqual({ state: 'source', value: null });
		expect(reconcileResource('base', 'base', 'changed')).toEqual({
			state: 'destination',
			value: 'changed',
		});
	});
	it('requires directional native evidence instead of resume capability flags', () => {
		const registry = new TranslationRegistry();
		expect(() =>
			registry.declareDirection({
				source: 'claude-code',
				destination: 'codex',
				sourceMinVersion: '2.1.296',
				destinationMinVersion: '0.162.1',
				sourceTestedVersions: ['2.1.296'],
				destinationTestedVersions: ['0.162.1'],
				verification: 'verified',
			})
		).toThrow('certification requires');
	});

	it('keeps same-provider requests no-op and unknown providers blocked', () => {
		const options = {
			agentId: 'a',
			source: identity,
			destination: identity,
			scope: { projectKnowledge: true as const, selectedUserResources: [] },
			conversations: [read('one')],
			registry: new TranslationRegistry(),
		};
		expect(planTranslation(options).status).toBe('noop');
		const plan = planTranslation({ ...options, destination: { ...identity, provider: 'codex' } });
		expect(plan.status).toBe('blocked');
		expect(plan.verification).toBe('unverified');
	});
});
