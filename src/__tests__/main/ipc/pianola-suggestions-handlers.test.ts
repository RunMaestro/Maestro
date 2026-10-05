/**
 * @file pianola-suggestions-handlers.test.ts
 * @description Tests the Pianola suggestions IPC handlers: Encore gating and that
 * apply-suggestion persists a validated rule / profile. electron's ipcMain is
 * mocked to capture handlers; the main-process store is mocked so no fs runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PianolaRule } from '../../../shared/pianola/types';
import type { PianolaAsk, PianolaProgram } from '../../../shared/pianola/pianola-programs';
import type { PianolaPlan, PianolaSupervisedTarget } from '../../../shared/pianola/storage';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
	},
}));

const store = vi.hoisted(() => ({
	readRulesResult: vi.fn(() => ({ rules: [] as PianolaRule[], malformed: false })),
	writeRules: vi.fn((rules: PianolaRule[]) => rules),
	readDecisions: vi.fn(() => []),
	readSupervisorTargets: vi.fn(() => [] as PianolaSupervisedTarget[]),
	writeSupervisorTargets: vi.fn((targets: PianolaSupervisedTarget[]) => targets),
	readPlans: vi.fn(() => [] as PianolaPlan[]),
	readAsks: vi.fn(() => [] as PianolaAsk[]),
	writeAsks: vi.fn((asks: PianolaAsk[]) => asks),
	updateAsks: vi.fn((update: (asks: PianolaAsk[]) => PianolaAsk[]) => update([])),
	upsertSupervisorTarget: vi.fn(),
	removeSupervisorTarget: vi.fn(),
	readPrograms: vi.fn(
		() => [] as Pick<PianolaProgram, 'id' | 'status' | 'updatedAt' | 'leadAgentId'>[]
	),
	writePrograms: vi.fn(),
	readSuggestions: vi.fn(() => ({
		generatedAt: 0,
		pairCount: 0,
		proposals: [] as PianolaRule[],
		proposedProfile: '',
		previousProfile: '',
	})),
	writeSuggestions: vi.fn(),
	setProfile: vi.fn(),
}));
vi.mock('../../../main/pianola/pianola-store-main', () => store);

import { registerPianolaHandlers } from '../../../main/ipc/handlers/pianola';

function settingsStore(pianola: boolean): { get: (key: string) => unknown } {
	return { get: (key: string) => (key === 'encoreFeatures' ? { pianola } : undefined) };
}

const supervisor = {
	getHealth: () => [],
	reconcile: vi.fn(),
} as unknown as Parameters<typeof registerPianolaHandlers>[0]['supervisor'];

function autoAnswerRule(over: Partial<PianolaRule> = {}): PianolaRule {
	return {
		id: 'suggested-low-question',
		enabled: true,
		scope: 'global',
		match: { kinds: ['question'], maxRisk: 'low' },
		action: 'auto_answer',
		answer: 'Yes, go ahead.',
		priority: 100,
		createdAt: 1,
		updatedAt: 1,
		...over,
	};
}

beforeEach(() => {
	handlers.clear();
	vi.clearAllMocks();
	store.readRulesResult.mockReturnValue({ rules: [], malformed: false });
	store.writeRules.mockImplementation((rules: PianolaRule[]) => rules);
	store.readSupervisorTargets.mockReturnValue([]);
	store.readPlans.mockReturnValue([]);
	store.readAsks.mockReturnValue([]);
	store.updateAsks.mockImplementation((update) => update([]));
	store.writeAsks.mockImplementation((asks) => asks);
	store.writeSupervisorTargets.mockImplementation((targets) => targets);
});

describe('pianola suggestions IPC handlers', () => {
	it('get-suggestions throws when Pianola is disabled', async () => {
		registerPianolaHandlers({ settingsStore: settingsStore(false), supervisor });
		const handler = handlers.get('pianola:get-suggestions');
		expect(handler).toBeDefined();
		await expect(handler!({})).rejects.toThrow('PianolaDisabled');
	});

	it('get-suggestions returns the staged file when enabled', async () => {
		store.readSuggestions.mockReturnValue({
			generatedAt: 7,
			pairCount: 3,
			proposals: [],
			proposedProfile: 'draft',
			previousProfile: '',
		});
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		const res = (await handlers.get('pianola:get-suggestions')!({})) as { generatedAt: number };
		expect(res.generatedAt).toBe(7);
	});

	it('apply-suggestion throws when Pianola is disabled', async () => {
		registerPianolaHandlers({ settingsStore: settingsStore(false), supervisor });
		await expect(
			handlers.get('pianola:apply-suggestion')!({}, { rule: autoAnswerRule() })
		).rejects.toThrow('PianolaDisabled');
		expect(store.writeRules).not.toHaveBeenCalled();
	});

	it('apply-suggestion appends a valid approved rule', async () => {
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		const rule = autoAnswerRule();
		const res = (await handlers.get('pianola:apply-suggestion')!({}, { rule })) as {
			rules: PianolaRule[];
		};
		expect(store.writeRules).toHaveBeenCalledTimes(1);
		expect(res.rules.some((r) => r.id === rule.id)).toBe(true);
	});

	it('apply-suggestion rejects an invalid rule', async () => {
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		// auto_answer without a narrowing predicate is invalid at the boundary.
		await expect(
			handlers.get('pianola:apply-suggestion')!(
				{},
				{
					rule: autoAnswerRule({ match: {} }),
				}
			)
		).rejects.toThrow('InvalidSuggestionRule');
		expect(store.writeRules).not.toHaveBeenCalled();
	});

	it('apply-suggestion persists an approved profile draft', async () => {
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		await handlers.get('pianola:apply-suggestion')!({}, { profile: { text: 'new profile' } });
		expect(store.setProfile).toHaveBeenCalledWith(
			{ profile: 'new profile', updatedAt: expect.any(Number) },
			undefined
		);
	});

	it('apply-suggestion prunes the applied proposal from staging', async () => {
		const rule = autoAnswerRule();
		const other = autoAnswerRule({ id: 'other-suggestion' });
		store.readSuggestions.mockReturnValue({
			generatedAt: 5,
			pairCount: 2,
			proposals: [rule, other],
			proposedProfile: 'draft',
			previousProfile: 'prev',
		});
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		await handlers.get('pianola:apply-suggestion')!({}, { rule });
		// The approved rule's proposal is dropped; the rest of the file is preserved.
		expect(store.writeSuggestions).toHaveBeenCalledTimes(1);
		expect(store.writeSuggestions).toHaveBeenCalledWith({
			generatedAt: 5,
			pairCount: 2,
			proposals: [other],
			proposedProfile: 'draft',
			previousProfile: 'prev',
		});
	});

	it('apply-suggestion does not touch staging for a profile-only apply', async () => {
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		await handlers.get('pianola:apply-suggestion')!({}, { profile: { text: 'new profile' } });
		expect(store.writeSuggestions).not.toHaveBeenCalled();
	});
});
describe('program controls IPC', () => {
	it('pauses and restores only the program orchestrator and lead watch', async () => {
		store.readPrograms.mockReturnValue([
			{ id: 'product', status: 'active', leadAgentId: 'lead', updatedAt: 1 },
		]);
		store.readPlans.mockReturnValue([
			{ id: 'plan', programId: 'product', title: 'Plan', createdAt: 1, tasks: [] },
		]);
		let targets: PianolaSupervisedTarget[] = [
			{ id: 'orchestrator', kind: 'orchestrate', planId: 'plan', enabled: true, createdAt: 1 },
			{ id: 'watch', kind: 'watch', agentId: 'lead', tabId: 'tab', enabled: true, createdAt: 1 },
			{ id: 'other', kind: 'orchestrate', planId: 'other', enabled: true, createdAt: 1 },
		];
		store.readSupervisorTargets.mockImplementation(() => targets);
		store.writeSupervisorTargets.mockImplementation((next) => (targets = next));
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		await handlers.get('pianola:set-program-status')!({}, 'product', 'paused');
		expect(targets.map((target) => target.enabled)).toEqual([false, false, true]);
		await handlers.get('pianola:set-program-status')!({}, 'product', 'active');
		expect(targets.map((target) => target.enabled)).toEqual([true, true, true]);
		expect(supervisor.reconcile).toHaveBeenCalledTimes(2);
	});
	it.each(['pianola:resolve-ask', 'pianola:dismiss-ask'])(
		'preserves asks raised before the mutation lock is acquired: %s',
		async (channel) => {
			const original: PianolaAsk = {
				id: 'original',
				title: 'Approval',
				detail: 'Proceed?',
				severity: 'high',
				status: 'open',
				dedupeKey: 'lead:product',
				createdAt: '2026-10-01T00:00:00Z',
				updatedAt: '2026-10-01T00:00:00Z',
			};
			const concurrent = { ...original, id: 'concurrent', dedupeKey: 'other:product' };
			store.readAsks.mockReturnValue([original]);
			let saved = [original, concurrent];
			store.writeAsks.mockImplementation((asks) => (saved = asks));
			store.updateAsks.mockImplementation((update) => (saved = update(saved)));
			registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
			const result = (await handlers.get(channel)!(
				{},
				'original',
				'Proceed',
				'Approved'
			)) as PianolaAsk;
			expect(result.status).toBe(channel === 'pianola:resolve-ask' ? 'resolved' : 'dismissed');
			expect(saved).toEqual([result, concurrent]);
		}
	);
	it('supervises a known program through the supervisor-add path', async () => {
		store.readPrograms.mockReturnValue([{ id: 'product', status: 'active', updatedAt: 1 }]);
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		await handlers.get('pianola:supervise-program')!({}, 'product');
		expect(store.upsertSupervisorTarget).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'program',
				programId: 'product',
				enabled: true,
				intervalSeconds: 120,
			})
		);
		expect(supervisor.reconcile).toHaveBeenCalled();
		await expect(handlers.get('pianola:supervise-program')!({}, 'missing')).rejects.toThrow(
			'InvalidProgramId'
		);
	});
	it('pauses only the selected program and rejects invalid status', async () => {
		store.readPrograms.mockReturnValue([
			{ id: 'product', status: 'active', updatedAt: 1 },
			{ id: 'other', status: 'active', updatedAt: 1 },
		]);
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		await handlers.get('pianola:set-program-status')!({}, 'product', 'paused');
		expect(store.writePrograms).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'product', status: 'paused' }),
			{ id: 'other', status: 'active', updatedAt: 1 },
		]);
		await expect(
			handlers.get('pianola:set-program-status')!({}, 'product', 'invalid')
		).rejects.toThrow('InvalidProgramStatus');
	});
});
