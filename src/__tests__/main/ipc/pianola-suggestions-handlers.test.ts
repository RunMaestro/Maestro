/**
 * @file pianola-suggestions-handlers.test.ts
 * @description Tests the Pianola suggestions IPC handlers: Encore gating and that
 * apply-suggestion persists a validated rule / profile. electron's ipcMain is
 * mocked to capture handlers; the main-process store is mocked so no fs runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAsActingUser } from '../../../main/web-server/auth/acting-user';
import { readPianolaOwnerIdentity } from '../../../shared/pianola/owner-identity';
import type { PianolaRule } from '../../../shared/pianola/types';
import type { PianolaAsk, PianolaProgram } from '../../../shared/pianola/pianola-programs';
import type { PianolaPlan, PianolaSupervisedTarget } from '../../../shared/pianola/storage';
import type { PianolaSuggestionsFile } from '../../../shared/pianola/storage';

describe('owner identity own-property semantics', () => {
	it.each([
		[{ desktopIsOwner: true }, { ownerWebUserId: 'owner' }],
		[{ desktopOwnerIsChris: true }, { chrisWebUserId: 'owner' }],
	])('does not inherit desktop consent %#', (prototype, own) => {
		const identity = Object.assign(Object.create(prototype), own);
		expect(readPianolaOwnerIdentity(identity)).toEqual({
			state: 'restricted',
			desktopIsOwner: false,
			ownerWebUserId: 'owner',
		});
	});
	it.each([
		[{ ownerWebUserId: 'owner' }, { desktopIsOwner: true }],
		[{ chrisWebUserId: 'owner' }, { desktopOwnerIsChris: true }],
	])('does not inherit a web binding %#', (prototype, own) => {
		const identity = Object.assign(Object.create(prototype), own);
		expect(readPianolaOwnerIdentity(identity)).toEqual({
			state: 'confirmed',
			desktopIsOwner: true,
		});
	});
});

const { handlers, native } = vi.hoisted(() => {
	const sender = { id: 100, mainFrame: {}, isDestroyed: () => false, getType: () => 'window' };
	const window = { webContents: sender, isDestroyed: () => false };
	return {
		handlers: new Map<string, (...args: unknown[]) => unknown>(),
		native: { sender, window },
	};
});

vi.mock('electron', () => ({
	BrowserWindow: {
		fromWebContents: (sender: unknown) => (sender === native.sender ? native.window : null),
	},
	webContents: { fromId: (id: number) => (id === native.sender.id ? native.sender : undefined) },
	ipcMain: {
		_invokeHandlers: handlers,
		listenerCount: () => 0,
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
	},
}));

const store = vi.hoisted(() => ({
	readRulesResult: vi.fn(() => ({ rules: [] as PianolaRule[], malformed: false })),
	writeRules: vi.fn((rules: PianolaRule[]) => rules),
	readDecisions: vi.fn(() => []),
	readSupervisorTargets: vi.fn(() => [] as PianolaSupervisedTarget[]),
	writeSupervisorTargetsAsync: vi.fn(async (targets: PianolaSupervisedTarget[]) => targets),
	updateSupervisorTargetsAsync: vi.fn(
		async (update: (targets: PianolaSupervisedTarget[]) => PianolaSupervisedTarget[]) => update([])
	),
	readPlans: vi.fn(() => [] as PianolaPlan[]),
	updatePlansAsync: vi.fn(),
	withPlanLock: vi.fn((_planId: string, operation: () => Promise<unknown>) => operation()),
	readAsks: vi.fn(() => [] as PianolaAsk[]),
	writeAsksAsync: vi.fn(async (asks: PianolaAsk[]) => asks),
	updateAsksAsync: vi.fn(async (update: (asks: PianolaAsk[]) => PianolaAsk[]) => update([])),
	upsertSupervisorTargetAsync: vi.fn(async () => [] as PianolaSupervisedTarget[]),
	removeSupervisorTargetAsync: vi.fn(async () => [] as PianolaSupervisedTarget[]),
	readPrograms: vi.fn(
		() => [] as Pick<PianolaProgram, 'id' | 'status' | 'updatedAt' | 'leadAgentId'>[]
	),
	updateProgramsAsync:
		vi.fn<
			(
				update: (
					programs: Pick<PianolaProgram, 'id' | 'status' | 'updatedAt' | 'leadAgentId'>[]
				) => Pick<PianolaProgram, 'id' | 'status' | 'updatedAt' | 'leadAgentId'>[]
			) => Promise<Pick<PianolaProgram, 'id' | 'status' | 'updatedAt' | 'leadAgentId'>[]>
		>(),
	readSuggestions: vi.fn(() => ({
		generatedAt: 0,
		pairCount: 0,
		proposals: [] as PianolaRule[],
		proposedProfile: '',
		previousProfile: '',
	})),
	writeSuggestions: vi.fn((suggestions: PianolaSuggestionsFile) => suggestions),
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
	store.updatePlansAsync.mockImplementation(async (update) => update(store.readPlans()));
	store.readAsks.mockReturnValue([]);
	store.readPrograms.mockReturnValue([]);
	store.updateProgramsAsync.mockImplementation(async (update) => update(store.readPrograms()));
	store.updateAsksAsync.mockImplementation(async (update) => update([]));
	store.writeAsksAsync.mockImplementation(async (asks) => asks);
	store.writeSupervisorTargetsAsync.mockImplementation(async (targets) => targets);
	store.updateSupervisorTargetsAsync.mockImplementation(async (update) =>
		update(store.readSupervisorTargets())
	);
	store.readSuggestions.mockReset();
	store.readSuggestions.mockReturnValue({
		generatedAt: 0,
		pairCount: 0,
		proposals: [],
		proposedProfile: '',
		previousProfile: '',
	});
	store.writeSuggestions.mockReset();
	store.writeSuggestions.mockImplementation((suggestions) => suggestions);
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
		expect(store.writeSuggestions).toHaveBeenCalledWith(
			expect.objectContaining({ generatedAt: 7, pairCount: 3 })
		);
	});

	it('apply-suggestion throws when Pianola is disabled', async () => {
		registerPianolaHandlers({ settingsStore: settingsStore(false), supervisor });
		await expect(
			handlers.get('pianola:apply-suggestion')!({}, { rule: autoAnswerRule() })
		).rejects.toThrow('PianolaDisabled');
		expect(store.writeRules).not.toHaveBeenCalled();
	});

	it('apply-suggestion rejects an unstaged caller-supplied rule', async () => {
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		const rule = autoAnswerRule();
		await expect(handlers.get('pianola:apply-suggestion')!({}, { rule })).rejects.toThrow(
			'StaleOrChangedSuggestion'
		);
		expect(store.writeRules).not.toHaveBeenCalled();
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

	it('apply-suggestion rejects a staged rule without current Chris evidence', async () => {
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
		await expect(handlers.get('pianola:apply-suggestion')!({}, { rule })).rejects.toThrow(
			'StaleOrChangedSuggestion'
		);
		expect(store.writeRules).not.toHaveBeenCalled();
		expect(store.writeSuggestions).not.toHaveBeenCalled();
	});

	it('apply-suggestion does not touch staging for a profile-only apply', async () => {
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		await handlers.get('pianola:apply-suggestion')!({}, { profile: { text: 'new profile' } });
		expect(store.writeSuggestions).not.toHaveBeenCalled();
	});
});
describe('program controls IPC', () => {
	it('pauses the latest locked program without overwriting a concurrent manifest apply', async () => {
		const original = {
			id: 'product',
			status: 'active' as const,
			updatedAt: 1,
			title: 'Old',
			root: '/old',
		};
		store.readPrograms.mockReturnValue([original]);
		let saved: (Omit<typeof original, 'status'> & { status: 'active' | 'paused' })[] = [
			{ ...original, title: 'New', root: '/new' },
		];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		store.updateProgramsAsync.mockImplementation(async (update) => {
			await gate;
			return (saved = update(saved) as typeof saved);
		});
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		const pending = handlers.get('pianola:set-program-status')!({}, 'product', 'paused');
		await Promise.resolve();
		expect(saved[0].status).toBe('active');
		release();
		await pending;
		expect(saved[0]).toMatchObject({ status: 'paused', title: 'New', root: '/new' });
	});
	it('toggles the latest locked target without overwriting a concurrent tab rebind', async () => {
		const original: PianolaSupervisedTarget = {
			id: 'watch',
			kind: 'watch',
			agentId: 'lead',
			tabId: 'old',
			enabled: true,
			createdAt: 1,
		};
		let saved = [{ ...original, tabId: 'new' }];
		store.readSupervisorTargets.mockReturnValue([original]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		store.updateSupervisorTargetsAsync.mockImplementation(async (update) => {
			await gate;
			return (saved = update(saved) as typeof saved);
		});
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		const pending = handlers.get('pianola:supervisor-set-enabled')!({}, 'watch', false);
		await Promise.resolve();
		expect(store.updateSupervisorTargetsAsync).toHaveBeenCalledOnce();
		expect(supervisor.reconcile).not.toHaveBeenCalled();
		expect(saved[0].enabled).toBe(true);
		release();
		await pending;
		expect(supervisor.reconcile).toHaveBeenCalledOnce();
		expect(saved).toEqual([{ ...original, tabId: 'new', enabled: false }]);
	});
	it('pauses and restores only the program orchestrator and lead watch', async () => {
		store.readPrograms.mockReturnValue([
			{ id: 'product', status: 'active', leadAgentId: 'lead', updatedAt: 1 },
		]);
		store.readPlans.mockReturnValue([
			{ id: 'plan', programId: 'product', title: 'Plan', createdAt: 1, tasks: [] },
		]);
		let targets: PianolaSupervisedTarget[] = [
			{ id: 'orchestrator', kind: 'orchestrate', planId: 'plan', enabled: false, createdAt: 1 },
			{ id: 'watch', kind: 'watch', agentId: 'lead', tabId: 'tab', enabled: true, createdAt: 1 },
			{ id: 'other', kind: 'orchestrate', planId: 'other', enabled: true, createdAt: 1 },
		];
		store.readSupervisorTargets.mockImplementation(() => targets);
		store.writeSupervisorTargetsAsync.mockImplementation(async (next) => (targets = next));
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		await handlers.get('pianola:set-program-status')!({}, 'product', 'paused');
		await handlers.get('pianola:set-program-status')!({}, 'product', 'paused');
		expect(targets.map((target) => target.enabled)).toEqual([false, true, true]);
		await handlers.get('pianola:set-program-status')!({}, 'product', 'active');
		expect(targets.map((target) => target.enabled)).toEqual([false, true, true]);
		expect(supervisor.reconcile).toHaveBeenCalledTimes(3);
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
			store.writeAsksAsync.mockImplementation(async (asks) => (saved = asks));
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			store.updateAsksAsync.mockImplementation(async (update) => {
				await gate;
				return (saved = update(saved));
			});
			registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
			let settled = false;
			const pending = Promise.resolve(
				handlers.get(channel)!({}, 'original', 'Proceed', 'Approved')
			);
			const outcome = pending.then(
				(value) => {
					settled = true;
					return value as PianolaAsk;
				},
				(error: unknown) => {
					settled = true;
					return error;
				}
			);
			await Promise.resolve();
			await Promise.resolve();
			expect(store.updateAsksAsync).toHaveBeenCalledOnce();
			expect(settled).toBe(false);
			expect(saved[0].status).toBe('open');
			release();
			const result = (await outcome) as PianolaAsk;
			expect(result.status).toBe(channel === 'pianola:resolve-ask' ? 'resolved' : 'dismissed');
			expect(saved).toEqual([result, concurrent]);
		}
	);
	it('supervises a known program through the locked target update path', async () => {
		store.readPrograms.mockReturnValue([{ id: 'product', status: 'active', updatedAt: 1 }]);
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		await handlers.get('pianola:supervise-program')!({}, 'product');
		expect(store.updateSupervisorTargetsAsync).toHaveBeenCalledOnce();
		expect(await store.updateSupervisorTargetsAsync.mock.results[0].value).toEqual([
			expect.objectContaining({
				kind: 'program',
				programId: 'product',
				enabled: true,
				intervalSeconds: 120,
			}),
		]);
		expect(supervisor.reconcile).toHaveBeenCalled();
		await expect(handlers.get('pianola:supervise-program')!({}, 'missing')).rejects.toThrow(
			'InvalidProgramId'
		);
	});
	it('pauses only the selected program and rejects invalid status', async () => {
		// Assertions below inspect the transaction result, not a pre-lock replacement write.
		store.readPrograms.mockReturnValue([
			{ id: 'product', status: 'active', updatedAt: 1 },
			{ id: 'other', status: 'active', updatedAt: 1 },
		]);
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		await handlers.get('pianola:set-program-status')!({}, 'product', 'paused');
		expect(await store.updateProgramsAsync.mock.results[0].value).toEqual([
			expect.objectContaining({ id: 'product', status: 'paused' }),
			{ id: 'other', status: 'active', updatedAt: 1 },
		]);
		await expect(
			handlers.get('pianola:set-program-status')!({}, 'product', 'invalid')
		).rejects.toThrow('InvalidProgramStatus');
	});
});

describe('failed task recovery IPC', () => {
	const failedPlan: PianolaPlan = {
		id: 'plan-1',
		title: 'Recovery',
		createdAt: 1,
		tasks: [
			{
				id: 'task-1',
				title: 'Broken deploy',
				prompt: 'Deploy the service',
				dependsOn: [],
				status: 'failed',
				runId: 'run-old',
				error: 'exit 1',
			},
			{
				id: 'task-2',
				title: 'Notify',
				prompt: 'Notify the team',
				dependsOn: ['task-1'],
				status: 'pending',
			},
		],
	};

	it('restarts a failed task with its original instructions', async () => {
		store.readPlans.mockReturnValue([failedPlan]);
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		const result = (await handlers.get('pianola:revise-plan-task')!(
			{},
			'plan-1',
			'task-1'
		)) as PianolaPlan;
		expect(result.tasks[0]).toMatchObject({ status: 'pending', prompt: 'Deploy the service' });
		expect(result.tasks[0].runId).toBeUndefined();
		expect(store.withPlanLock).toHaveBeenCalledWith('plan-1', expect.any(Function), {
			waitForTurn: true,
		});
		expect(supervisor.reconcile).toHaveBeenCalledOnce();
	});

	it('accepts replacement instructions for a revision', async () => {
		store.readPlans.mockReturnValue([failedPlan]);
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		const result = (await handlers.get('pianola:revise-plan-task')!(
			{},
			'plan-1',
			'task-1',
			'Deploy to staging first'
		)) as PianolaPlan;
		expect(result.tasks[0].prompt).toBe('Deploy to staging first');
	});

	it('skips failed work and leaves its dependents blocked', async () => {
		store.readPlans.mockReturnValue([failedPlan]);
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		const result = (await handlers.get('pianola:skip-plan-task')!(
			{},
			'plan-1',
			'task-1'
		)) as PianolaPlan;
		expect(result.tasks.map((task) => [task.id, task.status])).toEqual([
			['task-1', 'skipped'],
			['task-2', 'blocked'],
		]);
		expect(supervisor.reconcile).toHaveBeenCalledOnce();
	});

	it('rejects skipping active work and gates both mutations when disabled', async () => {
		store.readPlans.mockReturnValue([
			{ ...failedPlan, tasks: [{ ...failedPlan.tasks[0], status: 'running' }] },
		]);
		registerPianolaHandlers({ settingsStore: settingsStore(true), supervisor });
		await expect(handlers.get('pianola:skip-plan-task')!({}, 'plan-1', 'task-1')).rejects.toThrow(
			'Only failed tasks can be skipped.'
		);
		registerPianolaHandlers({ settingsStore: settingsStore(false), supervisor });
		await expect(handlers.get('pianola:revise-plan-task')!({}, 'plan-1', 'task-1')).rejects.toThrow(
			'PianolaDisabled'
		);
		await expect(handlers.get('pianola:skip-plan-task')!({}, 'plan-1', 'task-1')).rejects.toThrow(
			'PianolaDisabled'
		);
	});
});

import { createMockNativeDecisionPair } from '../../helpers/pianola';
import { synthesizeSuggestions } from '../../../shared/pianola/pianola-synthesis';
import { settledDecisionPairs } from '../../../shared/pianola/transcript-mining';
import { handleBridgeInvoke } from '../../../main/web-server/handlers/bridgeHandlers';
import { setBridgeGuardContextProvider } from '../../../main/web-server/handlers/bridgePathGuard';

describe('OW owner review', () => {
	const event = { sender: native.sender, senderFrame: native.sender.mainFrame };
	function fixture(
		identity: unknown,
		options: { windows?: unknown[]; disabled?: boolean; noRegistry?: boolean } = {}
	) {
		const records = [1, 2, 3].map((index) => {
			const pair = createMockNativeDecisionPair(index);
			return {
				id: `decision-${index}`,
				agentId: pair.evidence!.agentId,
				tabId: pair.evidence!.tabId,
				dryRun: false,
				classification: pair.classification,
				humanEvidence: pair.evidence,
				lifecycle: {
					phase: 'answer',
					source: { kind: 'human', actorId: 'desktop' },
					groupId: pair.evidence!.groupId,
				},
				decision: { action: 'auto_answer', answer: pair.reply },
			};
		});
		store.readDecisions.mockReturnValue(records as never);
		const generated = synthesizeSuggestions({
			pairs: settledDecisionPairs(records as never),
			existingRules: [],
			minSamples: 3,
			now: 1,
		});
		expect(generated.candidates).toHaveLength(1);
		const candidate = generated.candidates[0];
		store.readSuggestions.mockReturnValue({
			generatedAt: 1,
			pairCount: 3,
			proposals: generated.proposals,
			candidates: generated.candidates,
			proposedProfile: '',
			previousProfile: '',
		} as never);
		const settings: Record<string, unknown> = {
			encoreFeatures: { pianola: !options.disabled },
			pianolaLearningMinSamples: 3,
			pianolaLearningIdentity: identity,
		};
		const resolve = vi.fn();
		const set = vi.fn((key: string, value: unknown) => {
			settings[key] = value;
		});
		registerPianolaHandlers({
			supervisor,
			getWebServer: () => ({ resolvePianolaHumanDecision: resolve }),
			settingsStore: { get: (key: string) => settings[key], set },
			...(options.noRegistry ? {} : { getAppWindows: () => options.windows ?? [native.window] }),
		} as unknown as Parameters<typeof registerPianolaHandlers>[0]);
		return {
			settings,
			set,
			resolve,
			candidate,
			records,
			payload: {
				operation: 'accept',
				candidateId: candidate.id,
				evidenceFingerprint: candidate.evidenceFingerprint,
				actorId: 'desktop',
				principal: 'chris',
				role: 'human',
			},
		};
	}
	it.each([
		'unregistered',
		'missing registry',
		'destroyed window',
		'destroyed contents',
		'feature window',
		'webview',
	])('denies default native setup, review and attribution from %s', async (variant) => {
		const window =
			variant === 'destroyed window'
				? { ...native.window, isDestroyed: () => true }
				: native.window;
		const { payload, set, resolve } = fixture(undefined, {
			windows: variant === 'unregistered' || variant === 'feature window' ? [] : [window],
			noRegistry: variant === 'missing registry',
		});
		const destroyed = vi
			.spyOn(native.sender, 'isDestroyed')
			.mockReturnValue(variant === 'destroyed contents');
		const type = vi
			.spyOn(native.sender, 'getType')
			.mockReturnValue(variant === 'webview' ? 'webview' : 'window');
		try {
			const setup = handlers.get('pianola:confirm-desktop-owner');
			expect(setup).toBeDefined();
			await expect(setup!(event)).rejects.toThrow();
			await expect(handlers.get('pianola:review-suggestion')!(event, payload)).rejects.toThrow(
				'HumanSuggestionReviewRequired'
			);
			await handlers.get('pianola:resolve-decision')!(event, {
				decisionId: 'd',
				answer: 'Yes',
				principal: 'owner',
			});
			expect(resolve).toHaveBeenCalledWith(expect.anything(), 'desktop', undefined);
			expect(set).not.toHaveBeenCalled();
			expect(store.writeRules).not.toHaveBeenCalled();
			expect(store.writeSuggestions).not.toHaveBeenCalled();
		} finally {
			destroyed.mockRestore();
			type.mockRestore();
		}
	});
	it('fails closed when the feature is disabled even with default identity', async () => {
		const { payload, set, resolve } = fixture(undefined, { disabled: true });
		for (const [channel, input] of [
			['confirm-desktop-owner', undefined],
			['review-suggestion', payload],
			['resolve-decision', { decisionId: 'd', answer: 'Yes' }],
		] as const) {
			await expect(handlers.get(`pianola:${channel}`)!(event, input)).rejects.toThrow(
				'PianolaDisabled'
			);
		}
		expect(set).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
		expect(store.writeRules).not.toHaveBeenCalled();
		expect(store.writeSuggestions).not.toHaveBeenCalled();
	});
	it.each(['answer', 'risk', 'conditions', 'rejected'])(
		'rejects %s evidence without mutation',
		async (variant) => {
			const { payload, records, candidate } = fixture({ desktopOwnerIsChris: true });
			if (variant === 'rejected') {
				const staged = store.readSuggestions();
				store.readSuggestions.mockReturnValue({
					...staged,
					rejections: [
						{ candidateId: candidate.id, evidenceFingerprint: candidate.evidenceFingerprint },
					],
				} as never);
			} else {
				const changed = structuredClone(records);
				if (variant === 'answer')
					changed[0].decision.answer = changed[0].humanEvidence!.answer = 'No, stop.';
				if (variant === 'risk') changed[0].classification.risk = 'high';
				if (variant === 'conditions') changed[0].humanEvidence!.conditions = ['only after review'];
				store.readDecisions.mockReturnValue(changed as never);
			}
			await expect(handlers.get('pianola:review-suggestion')!(event, payload)).rejects.toThrow(
				'StaleOrChangedSuggestion'
			);
			expect(store.writeRules).not.toHaveBeenCalled();
			expect(store.writeSuggestions).not.toHaveBeenCalled();
		}
	);
	it.each([undefined, {}])(
		'attributes default native decisions without persisting identity %#',
		async (identity) => {
			const { settings, set, resolve } = fixture(identity);
			await handlers.get('pianola:resolve-decision')!(event, { decisionId: 'd', answer: 'Yes' });
			expect(resolve).toHaveBeenCalledWith(expect.anything(), 'desktop', 'owner');
			await handlers.get('pianola:confirm-desktop-owner')!(event);
			expect(settings.pianolaLearningIdentity).toEqual(identity);
			expect(set).not.toHaveBeenCalled();
		}
	);
	it.each(
		[undefined, {}].flatMap((identity) =>
			['accept', 'reject', 'edit'].map((operation) => ({ identity, operation }))
		)
	)(
		'requires an explicit default native $operation without setup ($identity)',
		async ({ identity, operation }) => {
			const { payload, settings, set, candidate } = fixture(identity);
			// Reading a staged candidate is not consent and must not activate it.
			await handlers.get('pianola:get-suggestions')!(event);
			expect(store.writeRules).not.toHaveBeenCalled();
			for (const [staged] of store.writeSuggestions.mock.calls) {
				expect(staged.approvals ?? []).toEqual([]);
				expect(staged.rejections ?? []).toEqual([]);
				expect(staged.candidates?.every((item) => !item.rule.enabled)).toBe(true);
			}
			await expect(
				handlers.get('pianola:review-suggestion')!(event, {
					...payload,
					operation,
					...(operation === 'edit'
						? { rule: { ...candidate.rule, answer: 'Wait for review.' } }
						: {}),
				})
			).resolves.toHaveProperty('suggestions');
			expect(store.writeSuggestions).toHaveBeenCalledWith(
				expect.objectContaining({
					[operation === 'reject' ? 'rejections' : 'approvals']: [
						expect.objectContaining({
							principal: 'owner',
							actorId: 'desktop',
							sourceKind: 'native-human-review',
						}),
					],
				})
			);
			expect(store.writeRules).toHaveBeenCalledTimes(operation === 'reject' ? 0 : 1);
			expect(settings.pianolaLearningIdentity).toEqual(identity);
			expect(set).not.toHaveBeenCalled();
		}
	);

	it.each([
		['legacy', { desktopOwnerIsChris: true }, true],
		['neutral', { desktopIsOwner: true }, true],
		['equal dual', { desktopOwnerIsChris: true, desktopIsOwner: true }, true],
		['false versus true', { desktopOwnerIsChris: false, desktopIsOwner: true }, false],
		[
			'partial dual',
			{ desktopOwnerIsChris: true, desktopIsOwner: true, ownerWebUserId: 'owner' },
			false,
		],
		[
			'different web IDs',
			{ desktopOwnerIsChris: true, desktopIsOwner: true, chrisWebUserId: 'a', ownerWebUserId: 'b' },
			false,
		],
		['unknown field', { desktopIsOwner: true, unknown: true }, false],
		['malformed legacy', { desktopOwnerIsChris: 'yes', desktopIsOwner: true }, false],
		['neutral false', { desktopIsOwner: false }, false],
		['neutral web only', { ownerWebUserId: 'owner' }, false],
		['legacy false', { desktopOwnerIsChris: false }, false],
		['legacy web only', { chrisWebUserId: 'owner' }, false],
		['null', null, false],
		['array', [], false],
		['string', 'owner', false],
		['wrong boolean type', { desktopIsOwner: 'true' }, false],
		['empty web ID', { desktopIsOwner: true, ownerWebUserId: '' }, false],
	])(
		'uses the same %s identity for native resolution and review',
		async (_label, identity, allowed) => {
			const { payload, resolve, set, settings } = fixture(identity);
			await handlers.get('pianola:resolve-decision')!(event, { decisionId: 'd', answer: 'Yes' });
			expect(resolve).toHaveBeenCalledWith(
				expect.anything(),
				'desktop',
				allowed ? 'owner' : undefined
			);
			if (allowed) {
				await handlers.get('pianola:review-suggestion')!(event, payload);
				expect(store.writeSuggestions).toHaveBeenCalledWith(
					expect.objectContaining({
						approvals: [
							expect.objectContaining({
								principal: 'owner',
								actorId: 'desktop',
								candidate: expect.objectContaining({
									evidence: expect.arrayContaining([
										expect.objectContaining({ principal: 'chris' }),
									]),
								}),
							}),
						],
					})
				);
			} else {
				await expect(handlers.get('pianola:review-suggestion')!(event, payload)).rejects.toThrow(
					'HumanSuggestionReviewRequired'
				);
				await expect(handlers.get('pianola:confirm-desktop-owner')!(event)).rejects.toThrow();
				expect(store.writeSuggestions).not.toHaveBeenCalled();
			}
			expect(settings.pianolaLearningIdentity).toEqual(identity);
			expect(set).not.toHaveBeenCalled();
		}
	);

	it('rejects edits that broaden the evidenced scope without writes', async () => {
		const { payload, candidate } = fixture({ desktopOwnerIsChris: true });
		await expect(
			handlers.get('pianola:review-suggestion')!(event, {
				...payload,
				operation: 'edit',
				rule: { ...candidate.rule, scope: 'global', scopeId: undefined },
			})
		).rejects.toThrow('BroadenedSuggestionEdit');
		expect(store.writeRules).not.toHaveBeenCalled();
		expect(store.writeSuggestions).not.toHaveBeenCalled();
	});
	it('rejects an edited exact question without mutation', async () => {
		const { payload, candidate } = fixture({ desktopOwnerIsChris: true });
		await expect(
			handlers.get('pianola:review-suggestion')!(event, {
				...payload,
				operation: 'edit',
				rule: {
					...candidate.rule,
					match: { ...candidate.rule.match, exactQuestion: 'A different question?' },
				},
			})
		).rejects.toThrow('BroadenedSuggestionEdit');
		expect(store.writeRules).not.toHaveBeenCalled();
		expect(store.writeSuggestions).not.toHaveBeenCalled();
		expect(store.setProfile).not.toHaveBeenCalled();
	});
	it('preserves an existing desktop and web binding on repeated setup', async () => {
		const identity = { desktopOwnerIsChris: true, chrisWebUserId: 'owner' };
		const { settings, set } = fixture(identity);
		const setup = handlers.get('pianola:confirm-desktop-owner');
		expect(setup).toBeDefined();
		await setup!(event);
		expect(settings.pianolaLearningIdentity).toEqual(identity);
		expect(set).not.toHaveBeenCalled();
	});
	it('rejects a synthetic native sender even when payload claims owner identity', async () => {
		const { payload } = fixture({ desktopOwnerIsChris: true });
		await expect(
			handlers.get('pianola:review-suggestion')!({ sender: { id: 100 } }, payload)
		).rejects.toThrow('HumanSuggestionReviewRequired');
		expect(store.writeRules).not.toHaveBeenCalled();
		expect(store.writeSuggestions).not.toHaveBeenCalled();
	});
	it.each([
		{ desktopOwnerIsChris: false },
		{ chrisWebUserId: 'owner' },
		'invalid',
		{ unknown: true },
	])('refuses setup over existing restrictions %j', async (identity) => {
		const { settings, set } = fixture(identity);
		const setup = handlers.get('pianola:confirm-desktop-owner');
		expect(setup).toBeDefined();
		await expect(setup!(event)).rejects.toThrow();
		expect(settings.pianolaLearningIdentity).toEqual(identity);
		expect(set).not.toHaveBeenCalled();
		expect(store.writeRules).not.toHaveBeenCalled();
		expect(store.writeSuggestions).not.toHaveBeenCalled();
	});
	it.each([
		{},
		{ type: 'cli', principal: 'owner', actor: { kind: 'human' } },
		{ type: 'agent', principal: 'owner', actorId: 'desktop' },
		{ sender: { id: 100 }, senderFrame: native.sender.mainFrame },
		{ sender: native.sender },
		{ sender: native.sender, senderFrame: {} },
		{ type: 'bridge', sender: native.sender, senderFrame: native.sender.mainFrame },
	])('rejects untrusted transport during setup and review %#', async (untrusted) => {
		const { payload, set, resolve } = fixture(undefined);
		const setup = handlers.get('pianola:confirm-desktop-owner');
		expect(setup).toBeDefined();
		await expect(setup!(untrusted)).rejects.toThrow();
		await expect(handlers.get('pianola:review-suggestion')!(untrusted, payload)).rejects.toThrow(
			'HumanSuggestionReviewRequired'
		);
		await handlers.get('pianola:resolve-decision')!(untrusted, {
			decisionId: 'd',
			answer: 'Yes',
			principal: 'owner',
		});
		expect(resolve).toHaveBeenCalledWith(expect.anything(), expect.any(String), undefined);
		expect(set).not.toHaveBeenCalled();
		expect(store.writeRules).not.toHaveBeenCalled();
		expect(store.writeSuggestions).not.toHaveBeenCalled();
	});
	it('does not treat an authenticated remote context with copied native event fields as native', async () => {
		const { payload, resolve, set } = fixture(undefined);
		await runAsActingUser({ id: 'remote', username: 'owner', displayName: 'Owner' }, async () => {
			await expect(handlers.get('pianola:review-suggestion')!(event, payload)).rejects.toThrow(
				'HumanSuggestionReviewRequired'
			);
			await handlers.get('pianola:resolve-decision')!(event, { decisionId: 'd', answer: 'Yes' });
		});
		expect(resolve).toHaveBeenCalledWith(expect.anything(), 'remote', undefined);
		expect(set).not.toHaveBeenCalled();
		expect(store.writeRules).not.toHaveBeenCalled();
		expect(store.writeSuggestions).not.toHaveBeenCalled();
	});
	it.each([
		{ chrisWebUserId: 'fixture-owner', ownerWebUserId: 'other' },
		{ chrisWebUserId: 'fixture-owner', ownerWebUserId: 'fixture-owner', desktopIsOwner: true },
		{ chrisWebUserId: 'fixture-owner', ownerWebUserId: 'fixture-owner', unknown: true },
		{ chrisWebUserId: 7, ownerWebUserId: 'fixture-owner' },
	])('denies a conflicting web binding through the actual bridge %j', async (identity) => {
		const { payload } = fixture(identity);
		setBridgeGuardContextProvider(() => ({
			userDataDir: null,
			encoreFeatures: { pianola: true },
			platform: 'linux',
		}));
		const replies: object[] = [];
		await handleBridgeInvoke(
			{
				id: 'fixture-bridge',
				user: { id: 'fixture-owner', username: 'owner', displayName: 'Owner' },
			},
			{
				type: 'bridge.invoke',
				channel: 'pianola:review-suggestion',
				requestId: 1,
				args: [payload],
			},
			(_client, reply) => replies.push(reply)
		);
		expect(replies).toEqual([expect.objectContaining({ ok: false })]);
		expect(store.writeRules).not.toHaveBeenCalled();
		expect(store.writeSuggestions).not.toHaveBeenCalled();
	});

	it.each(
		[undefined, {}].flatMap((identity) =>
			['web', 'anonymous', 'CLI', 'CLI claiming owner'].map((kind) => ({ identity, kind }))
		)
	)(
		'never grants default owner provenance to actual $kind bridge decisions ($identity)',
		async ({ identity, kind }) => {
			const { resolve, set } = fixture(identity);
			setBridgeGuardContextProvider(() => ({
				userDataDir: null,
				encoreFeatures: { pianola: true },
				platform: 'linux',
			}));
			const replies: object[] = [];
			const user =
				kind === 'web' || kind === 'CLI claiming owner'
					? { id: 'fixture-owner', username: 'owner', displayName: 'Owner' }
					: undefined;
			await handleBridgeInvoke(
				{ id: 'fixture-bridge', user, cli: kind.startsWith('CLI') },
				{
					type: 'bridge.invoke',
					channel: 'pianola:resolve-decision',
					requestId: 1,
					args: [
						{
							decisionId: 'd',
							answer: 'Yes',
							principal: 'owner',
							actorId: 'desktop',
							actor: { kind: 'human' },
						},
					],
				},
				(_client, reply) => replies.push(reply)
			);
			if (kind.startsWith('CLI')) {
				expect(replies).toEqual([expect.objectContaining({ ok: false })]);
				expect(resolve).not.toHaveBeenCalled();
			} else {
				expect(replies).toEqual([expect.objectContaining({ ok: true })]);
				expect(resolve).toHaveBeenCalledWith(expect.anything(), user?.id ?? 'web-owner', undefined);
			}
			expect(set).not.toHaveBeenCalled();
			expect(store.writeRules).not.toHaveBeenCalled();
			expect(store.writeSuggestions).not.toHaveBeenCalled();
		}
	);

	it('does not permit a bridge to invoke native owner setup', async () => {
		fixture({ chrisWebUserId: 'fixture-owner' });
		setBridgeGuardContextProvider(() => ({
			userDataDir: null,
			encoreFeatures: { pianola: true },
			platform: 'linux',
		}));
		const replies: object[] = [];
		await handleBridgeInvoke(
			{
				id: 'fixture-bridge',
				user: { id: 'fixture-owner', username: 'owner', displayName: 'Owner' },
			},
			{ type: 'bridge.invoke', channel: 'pianola:confirm-desktop-owner', requestId: 1, args: [] },
			(_client, reply) => replies.push(reply)
		);
		expect(replies).toEqual([expect.objectContaining({ ok: false })]);
		expect(store.writeRules).not.toHaveBeenCalled();
		expect(store.writeSuggestions).not.toHaveBeenCalled();
	});
	it('rejects stale evidence without mutation', async () => {
		const { payload } = fixture(undefined);
		await expect(
			handlers.get('pianola:review-suggestion')!(event, {
				...payload,
				evidenceFingerprint: 'stale',
			})
		).rejects.toThrow('StaleOrChangedSuggestion');
		expect(store.writeRules).not.toHaveBeenCalled();
		expect(store.writeSuggestions).not.toHaveBeenCalled();
	});
	it.each(
		['absent', 'empty', 'legacy', 'neutral', 'equal dual'].flatMap((schema) =>
			['owner', 'nonowner', 'unattributed', 'CLI', 'CLI claiming owner'].flatMap((kind) =>
				['accept', 'edit', 'reject'].map((operation) => [schema, kind, operation])
			)
		)
	)('actual bridge %s %s %s', async (schema, kind, operation) => {
		const identity =
			schema === 'absent'
				? undefined
				: schema === 'empty'
					? {}
					: schema === 'legacy'
						? { chrisWebUserId: 'fixture-owner' }
						: schema === 'neutral'
							? { ownerWebUserId: 'fixture-owner' }
							: { chrisWebUserId: 'fixture-owner', ownerWebUserId: 'fixture-owner' };
		const { payload, candidate } = fixture(identity);
		setBridgeGuardContextProvider(() => ({
			userDataDir: null,
			encoreFeatures: { pianola: true },
			platform: 'linux',
		}));
		const user =
			kind === 'owner' || kind === 'CLI claiming owner'
				? { id: 'fixture-owner', username: 'owner', displayName: 'Owner' }
				: kind === 'nonowner'
					? { id: 'other', username: 'other', displayName: 'Chris' }
					: undefined;
		const replies: object[] = [];
		await handleBridgeInvoke(
			{ id: 'fixture-bridge', user, cli: kind.startsWith('CLI') },
			{
				type: 'bridge.invoke',
				channel: 'pianola:review-suggestion',
				requestId: 1,
				args: [
					{
						...payload,
						operation,
						...(operation === 'edit'
							? { rule: { ...candidate.rule, answer: 'Wait for review.' } }
							: {}),
					},
				],
			},
			(_client, reply) => replies.push(reply)
		);
		const allowed = kind === 'owner' && schema !== 'absent' && schema !== 'empty';
		expect(replies).toEqual([expect.objectContaining({ ok: allowed })]);
		if (allowed)
			expect(store.writeSuggestions).toHaveBeenCalledWith(
				expect.objectContaining({
					[operation === 'reject' ? 'rejections' : 'approvals']: [
						expect.objectContaining({ principal: 'owner', actorId: 'fixture-owner' }),
					],
				})
			);
		expect(store.writeRules).toHaveBeenCalledTimes(allowed && operation !== 'reject' ? 1 : 0);
		expect(store.writeSuggestions).toHaveBeenCalledTimes(
			allowed ? (operation === 'reject' ? 1 : 2) : 0
		);
	});
});
