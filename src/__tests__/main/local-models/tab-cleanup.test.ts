/**
 * @file tab-cleanup.test.ts
 * @description The tab cleanup service: which tabs it reads from the sessions
 * store, every task router verdict, and that the model's reply is guarded
 * against the app as it is AFTER the model answered. Nothing here may fall back
 * to an agent, and nothing here may change a tab.
 *
 * Assigned to System One, the engine is asked one choice per tab FIRST and the
 * model path is never reached. Its answers go through the same guard.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `PROMPT:${id}`),
}));

vi.mock('../../../main/local-models/task-router', () => ({
	runLocalTask: vi.fn(),
	runSystemOneTask: vi.fn(),
}));

vi.mock('../../../main/local-models/sources', () => ({
	readLocalModelAssignments: vi.fn(),
}));

vi.mock('../../../main/local-models/endpoint-service', () => ({
	getConfiguredLocalModelEndpoints: vi.fn(() => [{ id: 'ep-1', name: 'Ollama' }]),
}));

import {
	collectTabCleanupTabs,
	configureTabCleanup,
	suggestTabCleanup,
	type TabCleanupStores,
} from '../../../main/local-models/tab-cleanup';
import { TAB_CLEANUP_REPLY_SCHEMA } from '../../../shared/tabCleanup';
import { runLocalTask, runSystemOneTask } from '../../../main/local-models/task-router';
import { readLocalModelAssignments } from '../../../main/local-models/sources';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ENDPOINT_SOURCE = { type: 'endpoint', endpointId: 'ep-1', model: 'qwen3:latest' } as const;
const ASSIGNED = { 'tab-cleanup': ENDPOINT_SOURCE };

type Record_ = Record<string, unknown>;

function log(source: string, text: string, timestamp: number): Record_ {
	return { id: `${source}-${timestamp}`, source, text, timestamp };
}

function aiTab(id: string, overrides: Record_ = {}): Record_ {
	return {
		id,
		name: `Tab ${id}`,
		starred: false,
		inputValue: '',
		stagedImages: [],
		createdAt: NOW - 40 * DAY,
		logs: [
			log('user', 'first question', NOW - 30 * DAY),
			log('ai', 'an answer', NOW - 30 * DAY + 1000),
		],
		...overrides,
	};
}

function agent(id: string, tabs: Record_[], overrides: Record_ = {}): Record_ {
	return { id, name: `Agent ${id}`, activeTabId: tabs[0]?.id, aiTabs: tabs, ...overrides };
}

const notBusy = { isTabBusy: () => false };

function okVerdict(json: unknown, text = '') {
	return { status: 'ok', text, json, source: ENDPOINT_SOURCE, durationMs: 900 } as never;
}

/** Stores over a mutable list, so a test can change the app mid-request. */
function storesOver(
	sessions: () => Record_[],
	busyIds: () => string[] = () => []
): TabCleanupStores {
	return {
		sessions,
		processManager: () => ({
			get: (processId: string) => (busyIds().includes(processId) ? {} : undefined),
		}),
		cliBusyAgentIds: () => new Set<string>(),
		now: () => NOW,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(readLocalModelAssignments).mockReturnValue(ASSIGNED as never);
	// Any assignment but System One: the model path is the whole story.
	vi.mocked(runSystemOneTask).mockResolvedValue({ status: 'not-assigned' });
	configureTabCleanup(null);
});

describe('collectTabCleanupTabs', () => {
	it('reads the facts for each open AI tab', () => {
		const tabs = collectTabCleanupTabs(
			[
				agent('a1', [
					aiTab('t1', {
						logs: [
							log('user', 'first question', NOW - 30 * DAY),
							log('ai', 'an answer', NOW - 29 * DAY),
							log('user', 'second question', NOW - 10 * DAY),
							log('stdout', 'tool output', NOW - 9 * DAY),
						],
					}),
				]),
			],
			notBusy
		);

		expect(tabs).toEqual([
			{
				agentId: 'a1',
				agentName: 'Agent a1',
				tabId: 't1',
				kind: 'open',
				tabType: 'ai',
				label: 'Tab t1',
				messageCount: 2,
				summary: 'second question',
				starred: false,
				hasDraft: false,
				lastActivityAt: NOW - 9 * DAY,
				busy: false,
			},
		]);
	});

	it('never lists a hidden consult tab', () => {
		const tabs = collectTabCleanupTabs(
			[agent('a1', [aiTab('t1'), aiTab('consult', { hidden: true })])],
			notBusy
		);
		expect(tabs.map((tab) => tab.tabId)).toEqual(['t1']);
	});

	it('labels an unnamed tab by its opening message and does not repeat it as the summary', () => {
		const [tab] = collectTabCleanupTabs([agent('a1', [aiTab('t1', { name: null })])], notBusy);
		expect(tab.label).toBe('first question');
		expect(tab.summary).toBeUndefined();
	});

	it('falls back to the creation time for a tab with no transcript', () => {
		const [tab] = collectTabCleanupTabs(
			[agent('a1', [aiTab('t1', { logs: [], createdAt: NOW - 3 * DAY })])],
			notBusy
		);
		expect(tab.lastActivityAt).toBe(NOW - 3 * DAY);
		expect(tab.messageCount).toBe(0);
	});

	it('reads starred, and a draft as text or as staged images', () => {
		const tabs = collectTabCleanupTabs(
			[
				agent('a1', [
					aiTab('starred', { starred: true }),
					aiTab('typing', { inputValue: '  half a thought' }),
					aiTab('images', { stagedImages: ['maestro-image://store/abc.png'] }),
					aiTab('blank', { inputValue: '   ' }),
				]),
			],
			notBusy
		);
		expect(tabs.map((tab) => [tab.tabId, tab.starred, tab.hasDraft])).toEqual([
			['starred', true, false],
			['typing', false, true],
			['images', false, true],
			['blank', false, false],
		]);
	});

	it('asks the process manager per tab, telling it which tab is the active one', () => {
		const isTabBusy = vi.fn((_agent: string, tabId: string) => tabId === 't2');
		const tabs = collectTabCleanupTabs([agent('a1', [aiTab('t1'), aiTab('t2')])], { isTabBusy });

		expect(tabs.map((tab) => tab.busy)).toEqual([false, true]);
		expect(isTabBusy).toHaveBeenCalledWith('a1', 't1', true);
		expect(isTabBusy).toHaveBeenCalledWith('a1', 't2', false);
	});

	it('counts every tab of an agent the CLI is running a playbook on as busy', () => {
		const tabs = collectTabCleanupTabs(
			[agent('a1', [aiTab('t1'), aiTab('t2')]), agent('a2', [aiTab('t3')])],
			{ isTabBusy: () => false, cliBusyAgentIds: new Set(['a1']) }
		);
		expect(tabs.map((tab) => [tab.tabId, tab.busy])).toEqual([
			['t1', true],
			['t2', true],
			['t3', false],
		]);
	});

	it('lists snoozed tabs of every kind, with what a wake needs', () => {
		const tabs = collectTabCleanupTabs(
			[
				agent('a1', [], {
					snoozedTabs: [
						{
							id: 's-ai',
							type: 'ai',
							snoozedAt: NOW - 12 * DAY,
							wakeAt: NOW + DAY,
							note: ' after the release ',
							tab: aiTab('parked', { starred: true }),
						},
						{
							id: 's-file',
							type: 'file',
							snoozedAt: NOW - 2 * DAY,
							wakeAt: NOW - DAY,
							tab: { id: 'file-1', name: 'notes', extension: '.md' },
						},
						{
							id: 's-group',
							type: 'group',
							snoozedAt: NOW - 5 * DAY,
							wakeAt: NOW + 2 * DAY,
							group: { id: 'group-1', name: 'Release work' },
							members: [],
						},
					],
				}),
			],
			notBusy
		);

		expect(tabs).toEqual([
			{
				agentId: 'a1',
				agentName: 'Agent a1',
				tabId: 'parked',
				kind: 'snoozed',
				tabType: 'ai',
				snoozeId: 's-ai',
				label: 'Tab parked',
				lastActivityAt: NOW - 12 * DAY,
				messageCount: 1,
				wakeAt: NOW + DAY,
				note: 'after the release',
				busy: false,
				starred: true,
				hasDraft: false,
			},
			{
				agentId: 'a1',
				agentName: 'Agent a1',
				tabId: 'file-1',
				kind: 'snoozed',
				tabType: 'file',
				snoozeId: 's-file',
				label: 'notes.md',
				lastActivityAt: NOW - 2 * DAY,
				messageCount: 0,
				wakeAt: NOW - DAY,
				busy: false,
				starred: false,
				hasDraft: false,
			},
			{
				agentId: 'a1',
				agentName: 'Agent a1',
				tabId: 'group-1',
				kind: 'snoozed',
				tabType: 'group',
				snoozeId: 's-group',
				label: 'Release work',
				lastActivityAt: NOW - 5 * DAY,
				messageCount: 0,
				wakeAt: NOW + 2 * DAY,
				busy: false,
				starred: false,
				hasDraft: false,
			},
		]);
	});

	it('skips records it cannot read instead of throwing', () => {
		const tabs = collectTabCleanupTabs(
			[
				{ name: 'no id' },
				agent('a1', [null as never, { name: 'no id' }, aiTab('t1')], {
					name: '  ',
					snoozedTabs: [
						null,
						{ id: 's1', type: 'mystery', tab: { id: 'x' } },
						{ id: 's2', type: 'ai' },
						{ type: 'ai', tab: aiTab('y') },
					],
				}),
			],
			notBusy
		);
		expect(tabs.map((tab) => [tab.agentName, tab.tabId])).toEqual([['a1', 't1']]);
	});
});

describe('suggestTabCleanup', () => {
	it('is off by default, without reading a tab or asking a model', async () => {
		vi.mocked(readLocalModelAssignments).mockReturnValue({});
		const sessions = vi.fn(() => [agent('a1', [aiTab('t1')])]);

		const result = await suggestTabCleanup(storesOver(sessions));

		expect(result).toMatchObject({ success: false, status: 'off' });
		expect(result.success === false && result.error).toMatch(
			/Tab cleanup suggestions is off.*Settings > Models > System One/
		);
		expect(sessions).not.toHaveBeenCalled();
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it('says so when asked before startup wired the stores', async () => {
		const result = await suggestTabCleanup();
		expect(result).toMatchObject({ success: false, status: 'unavailable' });
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it('uses the stores configured at startup', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(okVerdict({ suggestions: [] }));
		configureTabCleanup(storesOver(() => [agent('a1', [aiTab('t1')])]));

		await expect(suggestTabCleanup()).resolves.toMatchObject({ success: true, considered: 1 });
	});

	it('does not ask the model when no tab is eligible', async () => {
		const result = await suggestTabCleanup(
			storesOver(() => [agent('a1', [aiTab('t1', { starred: true })])])
		);

		expect(result).toEqual({
			success: true,
			suggestions: [],
			considered: 0,
			protectedCount: 1,
			droppedCount: 0,
			truncated: false,
		});
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it('asks the assigned model with the short prompt and the fixed schema, and no real ids', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(okVerdict({ suggestions: [] }));

		await suggestTabCleanup(storesOver(() => [agent('a1', [aiTab('t1')])]));

		expect(runLocalTask).toHaveBeenCalledTimes(1);
		const [taskId, input] = vi.mocked(runLocalTask).mock.calls[0];
		expect(taskId).toBe('tab-cleanup');
		expect(input.system).toBe('PROMPT:tab-cleanup-local');
		expect(input.jsonSchema).toBe(TAB_CLEANUP_REPLY_SCHEMA);
		expect(input.signal).toBeInstanceOf(AbortSignal);
		expect(input.prompt).toContain('T1 | open | agent "Agent a1" | "Tab t1"');
		expect(input.prompt).not.toContain('t1 |');
		expect(input.prompt).not.toMatch(/\ba1\b(?!")/);
	});

	it('returns the guarded suggestions with the real ids and who wrote them', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(
			okVerdict({
				suggestions: [
					{ tab: 'T1', action: 'close', reason: 'Untouched for a month.' },
					{ tab: 'T2', action: 'wake', reason: 'Its wake time has passed.' },
				],
			})
		);
		const sessions = () => [
			agent('a1', [aiTab('t1')], {
				snoozedTabs: [
					{
						id: 's1',
						type: 'ai',
						snoozedAt: NOW - 3 * DAY,
						wakeAt: NOW - DAY,
						tab: aiTab('parked'),
					},
				],
			}),
		];

		const result = await suggestTabCleanup(storesOver(sessions));

		expect(result).toMatchObject({
			success: true,
			considered: 2,
			protectedCount: 0,
			droppedCount: 0,
			truncated: false,
			producedBy: 'qwen3:latest on Ollama',
		});
		expect(result.success && result.suggestions).toEqual([
			expect.objectContaining({
				tabId: 't1',
				agentId: 'a1',
				action: 'close',
				reason: 'Untouched for a month.',
				kind: 'open',
			}),
			expect.objectContaining({
				tabId: 'parked',
				agentId: 'a1',
				action: 'wake',
				kind: 'snoozed',
				snoozeId: 's1',
			}),
		]);
	});

	it('leaves protected tabs out of the prompt', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(okVerdict({ suggestions: [] }));
		const sessions = () => [
			agent('a1', [
				aiTab('idle'),
				aiTab('working'),
				aiTab('kept', { starred: true }),
				aiTab('typing', { inputValue: 'draft' }),
			]),
		];

		const result = await suggestTabCleanup(storesOver(sessions, () => ['a1-ai-working']));

		const prompt = vi.mocked(runLocalTask).mock.calls[0][1].prompt;
		expect(prompt).toContain('"Tab idle"');
		expect(prompt).not.toContain('Tab working');
		expect(prompt).not.toContain('Tab kept');
		expect(prompt).not.toContain('Tab typing');
		expect(result).toMatchObject({ success: true, considered: 1, protectedCount: 3 });
	});

	it('drops a suggestion for a tab that became busy while the model was thinking', async () => {
		let busy: string[] = [];
		vi.mocked(runLocalTask).mockImplementation(async () => {
			// The agent starts a turn in t1 while the model is still answering.
			busy = ['a1-ai-t1'];
			return okVerdict({
				suggestions: [
					{ tab: 'T1', action: 'close', reason: 'Looks finished.' },
					{ tab: 'T2', action: 'close', reason: 'Looks finished.' },
				],
			});
		});

		const result = await suggestTabCleanup(
			storesOver(
				() => [agent('a1', [aiTab('t1'), aiTab('t2', { createdAt: NOW - DAY })])],
				() => busy
			)
		);

		expect(result.success && result.suggestions.map((s) => s.tabId)).toEqual(['t2']);
		expect(result).toMatchObject({ droppedCount: 1 });
	});

	it('drops a suggestion for a tab that gained a draft or a star, or was closed, in the meantime', async () => {
		let tabs = [aiTab('t1'), aiTab('t2'), aiTab('t3'), aiTab('t4')];
		vi.mocked(runLocalTask).mockImplementation(async () => {
			tabs = [
				aiTab('t1', { inputValue: 'wait, one more thing' }),
				aiTab('t2', { starred: true }),
				// t3 was closed.
				aiTab('t4'),
			];
			return okVerdict({
				suggestions: ['T1', 'T2', 'T3', 'T4'].map((tab) => ({ tab, action: 'close', reason: '' })),
			});
		});

		const result = await suggestTabCleanup(storesOver(() => [agent('a1', tabs)]));

		expect(result.success && result.suggestions.map((s) => s.tabId)).toEqual(['t4']);
		expect(result).toMatchObject({ droppedCount: 3 });
	});

	it('drops whatever the model invents: an unknown handle, a wake on an open tab', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(
			okVerdict({
				suggestions: [
					{ tab: 'T7', action: 'close', reason: 'x' },
					{ tab: 'T1', action: 'wake', reason: 'x' },
				],
			})
		);

		const result = await suggestTabCleanup(storesOver(() => [agent('a1', [aiTab('t1')])]));

		expect(result).toMatchObject({ success: true, suggestions: [], droppedCount: 2 });
	});

	it('fails as unusable when the reply is not the object, naming the model', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(okVerdict(undefined, 'I would close T1.'));

		const result = await suggestTabCleanup(storesOver(() => [agent('a1', [aiTab('t1')])]));

		expect(result).toMatchObject({
			success: false,
			status: 'unusable',
			producedBy: 'qwen3:latest on Ollama',
		});
	});

	it.each([
		[{ status: 'off' }, 'off', /is off/],
		[{ status: 'use-utility-agent' }, 'unavailable', /cannot run on the Utility Agent/],
		[{ status: 'cancelled', source: ENDPOINT_SOURCE }, 'cancelled', /took too long/],
		[
			{
				status: 'unavailable',
				source: ENDPOINT_SOURCE,
				code: 'endpoint-unreachable',
				reason: 'Ollama is not answering.',
			},
			'unavailable',
			/Ollama is not answering/,
		],
	])('passes the %j verdict through and never falls back', async (verdict, status, message) => {
		vi.mocked(runLocalTask).mockResolvedValue(verdict as never);

		const result = await suggestTabCleanup(storesOver(() => [agent('a1', [aiTab('t1')])]));

		expect(result).toMatchObject({ success: false, status });
		expect(result.success === false && result.error).toMatch(message);
		expect(runLocalTask).toHaveBeenCalledTimes(1);
	});
});

describe('suggestTabCleanup on System One', () => {
	const JEV = 'Jev (TypeSafe cloud)';
	const ON_SYSTEM_ONE = { 'tab-cleanup': { type: 'system-one' } };

	function answered(answers: Record<string, unknown>) {
		return {
			status: 'ok',
			engine: 'jev-cloud',
			engineLabel: JEV,
			model: 'jev-1.13.0',
			answers,
			usage: { inputTokens: 300, outputTokens: 2 },
			costUsd: 0.0000126,
			latencyMs: 260,
			calibrated: true,
			redacted: false,
		} as never;
	}

	const pick = (choice: string, probability?: number) => ({
		type: 'choice',
		choice,
		...(probability !== undefined ? { probabilities: { [choice]: probability } } : {}),
	});

	const sessions = () => [
		agent('a1', [aiTab('t1'), aiTab('t2')], {
			snoozedTabs: [
				{
					id: 's1',
					type: 'ai',
					snoozedAt: NOW - 3 * DAY,
					wakeAt: NOW - DAY,
					tab: aiTab('parked'),
				},
			],
		}),
	];

	beforeEach(() => {
		vi.mocked(readLocalModelAssignments).mockReturnValue(ON_SYSTEM_ONE as never);
	});

	it('asks the engine about the tabs the model would be shown, under the model budget', async () => {
		vi.mocked(runSystemOneTask).mockResolvedValue(answered({}));

		await suggestTabCleanup(storesOver(sessions));

		expect(runSystemOneTask).toHaveBeenCalledTimes(1);
		const [taskId, input, options] = vi.mocked(runSystemOneTask).mock.calls[0];
		expect(taskId).toBe('tab-cleanup');
		expect(input).toMatchObject({ now: NOW });
		expect(
			(input as { candidates: Array<{ tabId: string }> }).candidates.map((c) => c.tabId)
		).toEqual(['t1', 't2', 'parked']);
		expect(options).toEqual({ timeoutMs: 120_000 });
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it('returns the guarded suggestions with the real ids, the engine as the reason and as who wrote them', async () => {
		vi.mocked(runSystemOneTask).mockResolvedValue(
			answered({ t1: pick('close', 0.87), t2: pick('keep', 0.6), s1: pick('wake') })
		);

		const result = await suggestTabCleanup(storesOver(sessions));

		expect(result).toMatchObject({
			success: true,
			considered: 3,
			droppedCount: 0,
			producedBy: JEV,
		});
		expect(result.success && result.suggestions).toEqual([
			expect.objectContaining({
				tabId: 't1',
				agentId: 'a1',
				action: 'close',
				reason: `${JEV} chose close, 87% likely.`,
			}),
			expect.objectContaining({
				tabId: 'parked',
				action: 'wake',
				snoozeId: 's1',
				reason: `${JEV} chose wake.`,
			}),
		]);
	});

	it('guards the answers against the app as it is after the engine answered', async () => {
		const busy: string[] = [];
		vi.mocked(runSystemOneTask).mockImplementation(async () => {
			busy.push('a1-ai-t1');
			return answered({ t1: pick('close'), t2: pick('snooze'), s1: pick('keep') });
		});

		const result = await suggestTabCleanup(storesOver(sessions, () => busy));

		expect(result).toMatchObject({ success: true, droppedCount: 1 });
		expect(result.success && result.suggestions.map((s) => s.tabId)).toEqual(['t2']);
	});

	it('does not ask the engine when no tab is eligible', async () => {
		const result = await suggestTabCleanup(
			storesOver(() => [agent('a1', [aiTab('t1', { starred: true })])])
		);
		expect(result).toMatchObject({ success: true, considered: 0, protectedCount: 1 });
		expect(runSystemOneTask).not.toHaveBeenCalled();
	});

	it('fails with the reason when the engine gives no answer, and asks no model', async () => {
		vi.mocked(runSystemOneTask).mockResolvedValue({
			status: 'unavailable',
			engine: 'jev-cloud',
			engineLabel: JEV,
			code: 'auth',
			reason: `${JEV} has no key.`,
		});
		await expect(suggestTabCleanup(storesOver(sessions))).resolves.toEqual({
			success: false,
			status: 'unavailable',
			error: `${JEV} has no key.`,
		});

		vi.mocked(runSystemOneTask).mockResolvedValue({
			status: 'unavailable',
			engine: 'jev-cloud',
			engineLabel: JEV,
			code: 'timeout',
			reason: `${JEV}: no answer within 120000 ms.`,
		});
		await expect(suggestTabCleanup(storesOver(sessions))).resolves.toMatchObject({
			success: false,
			status: 'cancelled',
		});
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it('fails as unusable, naming the engine, when no tab got a choice', async () => {
		vi.mocked(runSystemOneTask).mockResolvedValue(answered({}));
		await expect(suggestTabCleanup(storesOver(sessions))).resolves.toEqual({
			success: false,
			status: 'unusable',
			error: `${JEV} did not answer for any tab. Try again.`,
			producedBy: JEV,
		});
	});
});
