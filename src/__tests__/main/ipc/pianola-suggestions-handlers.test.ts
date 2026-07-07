/**
 * @file pianola-suggestions-handlers.test.ts
 * @description Tests the Pianola suggestions IPC handlers: Encore gating and that
 * apply-suggestion persists a validated rule / profile. electron's ipcMain is
 * mocked to capture handlers; the main-process store is mocked so no fs runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PianolaRule } from '../../../shared/pianola/types';

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
	readSupervisorTargets: vi.fn(() => []),
	upsertSupervisorTarget: vi.fn(),
	removeSupervisorTarget: vi.fn(),
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
