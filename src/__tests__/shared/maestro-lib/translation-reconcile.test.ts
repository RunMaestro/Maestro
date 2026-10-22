import { describe, expect, it } from 'vitest';
import {
	reconcileConversation,
	reconcileResource,
} from '../../../shared/maestro-lib/translation/reconcile';
import { extractNativeConversation } from '../../../shared/maestro-lib/translation/native-records';
import { nativeRecordKey } from '../../../shared/maestro-lib/translation/identity';
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
				sourceVersions: ['2.1.296'],
				destinationVersions: ['0.162.1'],
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
