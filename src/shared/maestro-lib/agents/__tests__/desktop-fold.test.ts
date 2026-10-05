import { describe, expect, it } from 'vitest';
import type { AgentRecord, GroupRecord, SessionsDocument } from '../../store/records';
import { applyDesktopFold, type FoldPlan, type FoldState } from '../desktop-fold';
import type { DesktopFold, DesktopFoldAgent } from '../desktop-fold-types';
import { DEFAULT_TAB_DEFAULTS, type RuleContext } from '../rules';

const ctx: RuleContext = { newId: () => 'fresh-tab', now: () => 5_000, random: () => 0 };
const deps = { ctx, defaults: DEFAULT_TAB_DEFAULTS };

const tab = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	agentSessionId: null,
	name: null,
	starred: false,
	logs: [{ id: `${id}-l1`, timestamp: 1, source: 'user', text: `hi ${id}` }],
	...extra,
});

const agent = (id: string, extra: Record<string, unknown> = {}): AgentRecord => ({
	id,
	name: `Agent ${id}`,
	toolType: 'claude-code',
	cwd: `/work/${id}`,
	aiTabs: [tab(`${id}-t1`), tab(`${id}-t2`)],
	activeTabId: `${id}-t1`,
	unifiedTabOrder: [
		{ type: 'ai', id: `${id}-t1` },
		{ type: 'ai', id: `${id}-t2` },
	],
	inputMode: 'ai',
	...extra,
});

const group = (id: string, extra: Record<string, unknown> = {}): GroupRecord => ({
	id,
	name: id.toUpperCase(),
	emoji: 'F',
	kind: 'user',
	collapsed: false,
	...extra,
});

interface StateOptions {
	agents?: AgentRecord[];
	extraEntries?: unknown[];
	groups?: GroupRecord[];
	revs?: Record<string, number>;
	groupsRev?: number;
	removedAgents?: string[];
	removedGroups?: string[];
	closedTabs?: Record<string, string[]>;
	active?: string;
}

function makeState(options: StateOptions = {}): FoldState {
	const sessions: SessionsDocument = {
		sessions: [...(options.agents ?? [agent('a1'), agent('a2')]), ...(options.extraEntries ?? [])],
		activeSessionId: options.active ?? 'a1',
	};
	return {
		sessions,
		groups: { groups: options.groups ?? [] },
		revisionOf: (id) => options.revs?.[id] ?? 0,
		groupsRev: options.groupsRev ?? 0,
		removedAgentIds: new Set(options.removedAgents ?? []),
		removedGroupIds: new Set(options.removedGroups ?? []),
		closedTabIds: (id) => new Set(options.closedTabs?.[id] ?? []),
	};
}

const entry = (id: string, extra: Partial<DesktopFoldAgent> = {}): DesktopFoldAgent => ({
	id,
	provider: 'claude-code',
	fields: {},
	tabs: {},
	...extra,
});

const fold = (agents: DesktopFoldAgent[], extra: Partial<DesktopFold> = {}): DesktopFold => ({
	agents,
	...extra,
});

const agentsOfPlan = (plan: FoldPlan): AgentRecord[] =>
	((plan.sessions?.sessions ?? []) as AgentRecord[]).filter((a) => typeof a?.id === 'string');
const planAgent = (plan: FoldPlan, id: string) => agentsOfPlan(plan).find((a) => a.id === id)!;
const kinds = (plan: FoldPlan) => plan.drift.map((d) => d.kind);

describe('applyDesktopFold: rule 2, desktop-owned keys', () => {
	it('lands agent and tab keys on a new record without echoing an event', () => {
		const state = makeState();
		const plan = applyDesktopFold(
			state,
			fold([
				entry('a1', {
					fields: { inputMode: 'terminal', state: 'busy', shellCwd: '/x' },
					tabs: { 'a1-t1': { scrollTop: 40, hasUnread: true, state: 'busy' } },
				}),
			]),
			deps
		);
		const next = planAgent(plan, 'a1');
		expect(next).toMatchObject({ inputMode: 'terminal', state: 'busy', shellCwd: '/x' });
		expect(next.aiTabs?.[0]).toMatchObject({ scrollTop: 40, hasUnread: true, state: 'busy' });
		// The untouched tab and the untouched agent keep their identity.
		expect(next.aiTabs?.[1]).toBe(((state.sessions.sessions as AgentRecord[])[0].aiTabs ?? [])[1]);
		expect(planAgent(plan, 'a2')).toBe((state.sessions.sessions as AgentRecord[])[1]);
		expect(plan.events).toEqual([]);
		expect(plan.drift).toEqual([]);
		expect(plan.tombstoneAgents).toEqual([]);
	});

	it('drops a domain key found among the desktop-owned ones, and does not call it drift', () => {
		const plan = applyDesktopFold(
			makeState(),
			fold([
				entry('a1', {
					fields: { name: 'Hijack', cwd: '/elsewhere', id: 'other', inputMode: 'terminal' },
					tabs: { 'a1-t1': { name: 'Hijack', starred: true, id: 'other', scrollTop: 2 } },
				}),
			]),
			deps
		);
		const next = planAgent(plan, 'a1');
		expect(next.name).toBe('Agent a1');
		expect(next.cwd).toBe('/work/a1');
		expect(next.id).toBe('a1');
		expect(next.inputMode).toBe('terminal');
		expect(next.aiTabs?.[0]).toMatchObject({
			id: 'a1-t1',
			name: null,
			starred: false,
			scrollTop: 2,
		});
		expect(plan.drift).toEqual([]);
		expect(plan.events).toEqual([]);
	});

	it('never lets desktop-owned fields replace the tab set or the order', () => {
		const plan = applyDesktopFold(
			makeState(),
			fold([entry('a1', { fields: { aiTabs: [], unifiedTabOrder: [], inputMode: 'x' } })]),
			deps
		);
		const next = planAgent(plan, 'a1');
		expect(next.aiTabs).toHaveLength(2);
		expect(next.unifiedTabOrder).toHaveLength(2);
	});

	it('deletes a key whose value is undefined', () => {
		const plan = applyDesktopFold(
			makeState({ agents: [agent('a1', { shellCwd: '/old' }), agent('a2')] }),
			fold([entry('a1', { fields: { shellCwd: undefined, neverThere: undefined } })]),
			deps
		);
		expect('shellCwd' in planAgent(plan, 'a1')).toBe(false);
	});

	it('writes nothing for a fold that changes nothing, and keeps every object', () => {
		const state = makeState({
			agents: [agent('a1', { inputMode: 'ai', deep: { list: [1, 2] } }), agent('a2')],
		});
		const original = state.sessions.sessions as AgentRecord[];
		const plan = applyDesktopFold(
			state,
			fold(
				[
					entry('a1', {
						// Equal by value, fresh by identity: what an IPC round trip hands over.
						fields: { inputMode: 'ai', deep: { list: [1, 2] } },
						tabs: { 'a1-t1': { logs: JSON.parse(JSON.stringify(original[0].aiTabs?.[0].logs)) } },
					}),
				],
				{ activeSessionId: 'a1' }
			),
			deps
		);
		expect(plan.sessions).toBeUndefined();
		expect(plan.groups).toBeUndefined();
		expect(plan.events).toEqual([]);
		expect(plan.archive).toEqual([]);
	});

	it('keeps entries this build does not recognize, in place', () => {
		const stray = { weird: 'entry' };
		const plan = applyDesktopFold(
			makeState({ agents: [agent('a1')], extraEntries: [stray, agent('a2')] }),
			fold([entry('a1', { fields: { inputMode: 'x' } })]),
			deps
		);
		const entries = plan.sessions?.sessions as unknown[];
		expect(entries[1]).toBe(stray);
		expect((entries[0] as AgentRecord).inputMode).toBe('x');
	});

	it('reports unknown-agent for an entry the runtime does not have, and lands nothing', () => {
		const plan = applyDesktopFold(
			makeState(),
			fold([entry('ghost', { fields: { inputMode: 'x' } })]),
			deps
		);
		expect(kinds(plan)).toEqual(['unknown-agent']);
		expect(plan.drift[0].agentId).toBe('ghost');
		expect(plan.sessions).toBeUndefined();
	});

	it('ignores desktop keys for a tab the runtime does not have', () => {
		const plan = applyDesktopFold(
			makeState(),
			fold([entry('a1', { tabs: { nope: { scrollTop: 1 } } })]),
			deps
		);
		expect(plan.sessions).toBeUndefined();
		expect(plan.drift).toEqual([]);
	});
});

describe('applyDesktopFold: rule 3, the provider epoch', () => {
	const scoped = {
		agentSessionId: 'sess-new',
		usageStats: { inputTokens: 5 },
		awaitingSessionId: true,
	};

	it('lands provider-scoped tab fields directly when the fold was computed under the current provider', () => {
		const plan = applyDesktopFold(
			makeState(),
			fold([entry('a1', { provider: 'claude-code', tabs: { 'a1-t1': scoped } })]),
			deps
		);
		expect(planAgent(plan, 'a1').aiTabs?.[0]).toMatchObject(scoped);
		expect(planAgent(plan, 'a1').aiTabs?.[0].providerSessions).toBeUndefined();
	});

	it('lands them in the parked slot of the provider the fold was computed under after a swap', () => {
		// The agent swapped to codex after the fold's snapshot was computed under claude-code.
		const swapped = agent('a1', { toolType: 'codex' });
		swapped.aiTabs = [
			tab('a1-t1', {
				agentSessionId: 'codex-sess',
				providerSessions: { 'claude-code': { agentSessionId: 'old' } },
			}),
			tab('a1-t2'),
		];
		const plan = applyDesktopFold(
			makeState({ agents: [swapped] }),
			fold([entry('a1', { provider: 'claude-code', tabs: { 'a1-t1': scoped } })]),
			deps
		);
		const next = planAgent(plan, 'a1').aiTabs?.[0];
		// The new provider's live fields are untouched.
		expect(next?.agentSessionId).toBe('codex-sess');
		expect(next?.usageStats).toBeUndefined();
		expect(next?.providerSessions).toMatchObject({
			'claude-code': { agentSessionId: 'sess-new', usageStats: { inputTokens: 5 } },
		});
	});

	it('creates the parked slot when the tab never ran under that provider', () => {
		const plan = applyDesktopFold(
			makeState({ agents: [agent('a1', { toolType: 'codex' })] }),
			fold([
				entry('a1', { provider: 'claude-code', tabs: { 'a1-t1': { agentSessionId: 'sess' } } }),
			]),
			deps
		);
		expect(planAgent(plan, 'a1').aiTabs?.[0].providerSessions).toEqual({
			'claude-code': { agentSessionId: 'sess' },
		});
	});

	it('does not rewrite a parked slot that already holds the values', () => {
		const parked = agent('a1', { toolType: 'codex' });
		parked.aiTabs = [
			tab('a1-t1', { providerSessions: { 'claude-code': { agentSessionId: 'sess' } } }),
		];
		const plan = applyDesktopFold(
			makeState({ agents: [parked] }),
			fold([
				entry('a1', { provider: 'claude-code', tabs: { 'a1-t1': { agentSessionId: 'sess' } } }),
			]),
			deps
		);
		expect(plan.sessions).toBeUndefined();
	});

	it('uses the record as it is after a landed domain swap, so a fold sent after the swap lands live', () => {
		const plan = applyDesktopFold(
			makeState(),
			fold([
				entry('a1', {
					baseRev: 0,
					provider: 'codex',
					domain: { toolType: 'codex' },
					tabs: { 'a1-t1': { agentSessionId: 'codex-sess' } },
				}),
			]),
			deps
		);
		const next = planAgent(plan, 'a1');
		expect(next.toolType).toBe('codex');
		expect(next.aiTabs?.[0].agentSessionId).toBe('codex-sess');
	});
});

describe('applyDesktopFold: rule 4, domain at the current revision', () => {
	const domainEntry = (baseRev: number | undefined) =>
		entry('a1', {
			...(baseRev === undefined ? {} : { baseRev }),
			domain: { name: 'Renamed', bookmarked: true, notDomain: 'x', id: 'hijack' },
			tabDomain: { 'a1-t1': { name: 'Tab', starred: true, id: 'hijack', hasUnread: true } },
		});

	it('lands domain keys and tab domain keys at the current revision, and says so to peers', () => {
		const plan = applyDesktopFold(makeState({ revs: { a1: 3 } }), fold([domainEntry(3)]), deps);
		const next = planAgent(plan, 'a1');
		expect(next).toMatchObject({ id: 'a1', name: 'Renamed', bookmarked: true });
		expect('notDomain' in next).toBe(false);
		expect(next.aiTabs?.[0]).toMatchObject({ id: 'a1-t1', name: 'Tab', starred: true });
		expect('hasUnread' in (next.aiTabs?.[0] ?? {})).toBe(false);
		expect(plan.drift).toEqual([]);
		expect(plan.events.map((e) => e.type)).toEqual(['tab.updated', 'agent.updated']);
	});

	it('drops them at a stale revision and reports drift', () => {
		const plan = applyDesktopFold(makeState({ revs: { a1: 4 } }), fold([domainEntry(3)]), deps);
		expect(plan.sessions).toBeUndefined();
		expect(kinds(plan)).toEqual(['domain-dropped', 'tab-domain-dropped']);
		expect(plan.drift[0]).toMatchObject({
			agentId: 'a1',
			keys: ['name', 'bookmarked', 'notDomain', 'id'],
		});
		expect(plan.drift[1]).toMatchObject({ agentId: 'a1', tabId: 'a1-t1' });
		expect(plan.events).toEqual([]);
	});

	it('drops them when baseRev is absent', () => {
		const plan = applyDesktopFold(
			makeState({ revs: { a1: 0 } }),
			fold([domainEntry(undefined)]),
			deps
		);
		expect(kinds(plan)).toEqual(['domain-dropped', 'tab-domain-dropped']);
	});

	it('treats an agent the runtime never changed as revision 0', () => {
		const plan = applyDesktopFold(makeState(), fold([domainEntry(0)]), deps);
		expect(planAgent(plan, 'a1').name).toBe('Renamed');
	});

	it('still lands the desktop-owned keys of a stale fold', () => {
		const plan = applyDesktopFold(
			makeState({ revs: { a1: 4 } }),
			fold([{ ...domainEntry(3), fields: { inputMode: 'terminal' } }]),
			deps
		);
		expect(planAgent(plan, 'a1')).toMatchObject({ inputMode: 'terminal', name: 'Agent a1' });
		expect(plan.events).toEqual([]);
	});

	describe('closeTabs', () => {
		it('archives first, then removes the tab and moves the active tab to the left neighbor', () => {
			const state = makeState({
				agents: [agent('a1', { activeTabId: 'a1-t2' }), agent('a2')],
				revs: { a1: 2 },
			});
			const plan = applyDesktopFold(
				state,
				fold([entry('a1', { baseRev: 2, closeTabs: ['a1-t2'] })]),
				deps
			);
			const next = planAgent(plan, 'a1');
			expect(next.aiTabs?.map((t) => t.id)).toEqual(['a1-t1']);
			expect(next.unifiedTabOrder).toEqual([{ type: 'ai', id: 'a1-t1' }]);
			expect(next.activeTabId).toBe('a1-t1');
			expect(plan.archive).toHaveLength(1);
			expect(plan.archive[0]).toMatchObject({
				agentId: 'a1',
				closed: { tab: { id: 'a1-t2' }, index: 1, closedAt: 5_000 },
			});
			expect(plan.events.map((e) => e.type)).toEqual(['tab.removed', 'agent.updated']);
		});

		it('creates a replacement only when nothing at all would survive', () => {
			const state = makeState({
				agents: [
					agent('a1', { aiTabs: [tab('a1-t1')], unifiedTabOrder: [{ type: 'ai', id: 'a1-t1' }] }),
				],
			});
			const plan = applyDesktopFold(
				state,
				fold([entry('a1', { baseRev: 0, closeTabs: ['a1-t1'] })]),
				deps
			);
			const next = planAgent(plan, 'a1');
			expect(next.aiTabs?.map((t) => t.id)).toEqual(['fresh-tab']);
			expect(next.activeTabId).toBe('fresh-tab');
			expect(plan.events.map((e) => e.type)).toEqual(['tab.removed', 'tab.added', 'agent.updated']);
		});

		it('makes no replacement when the fold adopted one in the same breath', () => {
			const state = makeState({
				agents: [
					agent('a1', { aiTabs: [tab('a1-t1')], unifiedTabOrder: [{ type: 'ai', id: 'a1-t1' }] }),
				],
			});
			const plan = applyDesktopFold(
				state,
				fold([entry('a1', { baseRev: 0, closeTabs: ['a1-t1'], adoptTabs: [tab('mine')] })]),
				deps
			);
			const next = planAgent(plan, 'a1');
			expect(next.aiTabs?.map((t) => t.id)).toEqual(['mine']);
			expect(plan.events.map((e) => e.type)).toEqual(['tab.added', 'tab.removed', 'agent.updated']);
		});

		it('skips a tab the runtime does not have, and a hidden consult tab', () => {
			const state = makeState({
				agents: [
					agent('a1', {
						aiTabs: [tab('a1-t1'), tab('a1-hidden', { hidden: true })],
						unifiedTabOrder: [
							{ type: 'ai', id: 'a1-t1' },
							{ type: 'ai', id: 'a1-hidden' },
						],
					}),
				],
			});
			const plan = applyDesktopFold(
				state,
				fold([entry('a1', { baseRev: 0, closeTabs: ['nope', 'a1-hidden'] })]),
				deps
			);
			expect(plan.sessions).toBeUndefined();
			expect(plan.archive).toEqual([]);
		});

		it('drops the closes at a stale revision and keeps the tab', () => {
			const plan = applyDesktopFold(
				makeState({ revs: { a1: 1 } }),
				fold([entry('a1', { baseRev: 0, closeTabs: ['a1-t2'] })]),
				deps
			);
			expect(kinds(plan)).toEqual(['close-tabs-dropped']);
			expect(plan.archive).toEqual([]);
			expect(plan.sessions).toBeUndefined();
		});

		it('leaves an active tab the fold already moved off the closed tab alone', () => {
			const plan = applyDesktopFold(
				makeState({ agents: [agent('a1', { activeTabId: 'a1-t2' })] }),
				fold([entry('a1', { baseRev: 0, fields: { activeTabId: 'a1-t1' }, closeTabs: ['a1-t2'] })]),
				deps
			);
			expect(planAgent(plan, 'a1').activeTabId).toBe('a1-t1');
		});
	});

	describe('order', () => {
		const order = [
			{ type: 'ai', id: 'a1-t2' },
			{ type: 'file', id: 'f1' },
			{ type: 'ai', id: 'a1-t1' },
		];

		it('lands the reconciled order at the current revision, keeping the authority for AI refs', () => {
			const plan = applyDesktopFold(makeState(), fold([entry('a1', { baseRev: 0, order })]), deps);
			// Stored order is t1, t2: the authority wins, so the local reorder of AI refs does not land,
			// and the file ref goes after its local predecessor (t2).
			expect(planAgent(plan, 'a1').unifiedTabOrder).toEqual([
				{ type: 'ai', id: 'a1-t1' },
				{ type: 'ai', id: 'a1-t2' },
				{ type: 'file', id: 'f1' },
			]);
			expect(plan.events).toEqual([]);
		});

		it('says nothing when only non-AI refs changed (the renderer owns them)', () => {
			const plan = applyDesktopFold(
				makeState(),
				fold([
					entry('a1', {
						baseRev: 0,
						order: [
							{ type: 'ai', id: 'a1-t1' },
							{ type: 'ai', id: 'a1-t2' },
							{ type: 'terminal', id: 'term' },
						],
					}),
				]),
				deps
			);
			expect(planAgent(plan, 'a1').unifiedTabOrder).toHaveLength(3);
			expect(plan.events).toEqual([]);
		});

		it('drops AI refs the stored order lacks', () => {
			const plan = applyDesktopFold(
				makeState(),
				fold([
					entry('a1', {
						baseRev: 0,
						order: [
							{ type: 'ai', id: 'a1-t1' },
							{ type: 'ai', id: 'ghost' },
							{ type: 'ai', id: 'a1-t2' },
							{ type: 'file', id: 'f1' },
						],
					}),
				]),
				deps
			);
			expect(planAgent(plan, 'a1').unifiedTabOrder).toEqual([
				{ type: 'ai', id: 'a1-t1' },
				{ type: 'ai', id: 'a1-t2' },
				{ type: 'file', id: 'f1' },
			]);
		});

		it('keeps the stored order when stale, and reports order-dropped only when it would have changed', () => {
			const stale = applyDesktopFold(
				makeState({ revs: { a1: 5 } }),
				fold([entry('a1', { baseRev: 4, order })]),
				deps
			);
			expect(kinds(stale)).toEqual(['order-dropped']);
			expect(stale.sessions).toBeUndefined();

			const same = applyDesktopFold(
				makeState({ revs: { a1: 5 } }),
				fold([
					entry('a1', {
						baseRev: 4,
						order: [
							{ type: 'ai', id: 'a1-t1' },
							{ type: 'ai', id: 'a1-t2' },
						],
					}),
				]),
				deps
			);
			expect(same.drift).toEqual([]);
		});

		it('adopts a local order when the record has none', () => {
			const bare = agent('a1');
			delete bare.unifiedTabOrder;
			const plan = applyDesktopFold(
				makeState({ agents: [bare] }),
				fold([entry('a1', { baseRev: 0, order: [{ type: 'ai', id: 'a1-t1' }] })]),
				deps
			);
			expect(planAgent(plan, 'a1').unifiedTabOrder).toEqual([{ type: 'ai', id: 'a1-t1' }]);
		});
	});
});

describe('applyDesktopFold: rule 5, adoption', () => {
	it('adopts a tab the runtime lacks, with an ai ref, regardless of the revision', () => {
		const plan = applyDesktopFold(
			makeState({ revs: { a1: 9 } }),
			fold([entry('a1', { baseRev: 1, adoptTabs: [tab('new-tab', { name: 'Mine' })] })]),
			deps
		);
		const next = planAgent(plan, 'a1');
		expect(next.aiTabs?.map((t) => t.id)).toEqual(['a1-t1', 'a1-t2', 'new-tab']);
		expect(next.unifiedTabOrder?.at(-1)).toEqual({ type: 'ai', id: 'new-tab' });
		expect(kinds(plan)).toEqual(['adopted-tab']);
		expect(plan.events.map((e) => e.type)).toEqual(['tab.added', 'agent.updated']);
	});

	it('does not duplicate an ai ref the order already holds, and skips a tab it already has', () => {
		const withRef = agent('a1');
		withRef.unifiedTabOrder = [...(withRef.unifiedTabOrder ?? []), { type: 'ai', id: 'new-tab' }];
		const plan = applyDesktopFold(
			makeState({ agents: [withRef] }),
			fold([entry('a1', { adoptTabs: [tab('new-tab'), tab('a1-t1')] })]),
			deps
		);
		expect(planAgent(plan, 'a1').unifiedTabOrder?.filter((r) => r.id === 'new-tab')).toHaveLength(
			1
		);
		expect(kinds(plan)).toEqual(['adopted-tab']);
	});

	it('refuses a tab whose id has a closed-tab archive entry', () => {
		const plan = applyDesktopFold(
			makeState({ closedTabs: { a1: ['old-tab'] } }),
			fold([entry('a1', { adoptTabs: [tab('old-tab')] })]),
			deps
		);
		expect(kinds(plan)).toEqual(['tombstoned-tab']);
		expect(plan.drift[0]).toMatchObject({ agentId: 'a1', tabId: 'old-tab' });
		expect(plan.sessions).toBeUndefined();
	});

	it('adopts a hidden tab without a tab event', () => {
		const plan = applyDesktopFold(
			makeState(),
			fold([entry('a1', { adoptTabs: [tab('hid', { hidden: true })] })]),
			deps
		);
		expect(plan.events.map((e) => e.type)).toEqual(['agent.updated']);
	});

	it('lands the desktop keys of an adopted tab from the same fold', () => {
		const plan = applyDesktopFold(
			makeState(),
			fold([entry('a1', { adoptTabs: [tab('new-tab')], tabs: { 'new-tab': { scrollTop: 7 } } })]),
			deps
		);
		expect(planAgent(plan, 'a1').aiTabs?.at(-1)).toMatchObject({ id: 'new-tab', scrollTop: 7 });
	});

	it('adopts an agent the runtime lacks, appended after the stored ones', () => {
		const plan = applyDesktopFold(makeState(), fold([], { adoptAgents: [agent('a3')] }), deps);
		expect(agentsOfPlan(plan).map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
		expect(kinds(plan)).toEqual(['adopted-agent']);
		expect(plan.events).toMatchObject([{ type: 'agent.added', agent: { id: 'a3' } }]);
	});

	it('refuses a tombstoned agent and skips one it already has', () => {
		const plan = applyDesktopFold(
			makeState({ removedAgents: ['gone'] }),
			fold([], { adoptAgents: [agent('gone'), agent('a1'), { not: 'an agent' }] }),
			deps
		);
		expect(kinds(plan)).toEqual(['tombstoned-agent']);
		expect(plan.sessions).toBeUndefined();
	});

	it('lets a fold entry for an agent adopted in the same fold land its desktop keys', () => {
		const plan = applyDesktopFold(
			makeState(),
			fold([entry('a3', { fields: { inputMode: 'terminal' } })], { adoptAgents: [agent('a3')] }),
			deps
		);
		expect(planAgent(plan, 'a3').inputMode).toBe('terminal');
		expect(plan.drift.map((d) => d.kind)).toEqual(['adopted-agent']);
	});

	it('emits agent.added with the final, projected record (no transcripts)', () => {
		const plan = applyDesktopFold(makeState(), fold([], { adoptAgents: [agent('a3')] }), deps);
		const event = plan.events[0] as { agent: AgentRecord };
		expect(event.agent.aiTabs?.every((t) => !('logs' in t))).toBe(true);
	});
});

describe('applyDesktopFold: rule 6, removal', () => {
	it('removes the agent, tombstones it, and moves the active agent to the first survivor', () => {
		const plan = applyDesktopFold(makeState(), fold([], { removeAgents: ['a1'] }), deps);
		expect(agentsOfPlan(plan).map((a) => a.id)).toEqual(['a2']);
		expect(plan.sessions?.activeSessionId).toBe('a2');
		expect(plan.tombstoneAgents).toEqual(['a1']);
		expect(plan.events).toEqual([{ type: 'agent.removed', agentId: 'a1' }]);
	});

	it('leaves an active pointer at some other agent alone', () => {
		const plan = applyDesktopFold(
			makeState({ active: 'a2' }),
			fold([], { removeAgents: ['a1'] }),
			deps
		);
		expect(plan.sessions?.activeSessionId).toBe('a2');
	});

	it('empties the active pointer when the last agent goes', () => {
		const plan = applyDesktopFold(
			makeState({ agents: [agent('a1')] }),
			fold([], { removeAgents: ['a1'] }),
			deps
		);
		expect(plan.sessions?.activeSessionId).toBe('');
	});

	it('tombstones an id the runtime never held, with no event and no write', () => {
		const plan = applyDesktopFold(makeState(), fold([], { removeAgents: ['never-had'] }), deps);
		expect(plan.tombstoneAgents).toEqual(['never-had']);
		expect(plan.events).toEqual([]);
		expect(plan.sessions).toBeUndefined();
	});

	it('wins over a fold entry for the same agent, silently', () => {
		const plan = applyDesktopFold(
			makeState(),
			fold([entry('a1', { fields: { inputMode: 'x' } })], { removeAgents: ['a1'] }),
			deps
		);
		expect(plan.drift).toEqual([]);
		expect(agentsOfPlan(plan).map((a) => a.id)).toEqual(['a2']);
	});

	it('does not remove an agent a fold merely leaves out', () => {
		const plan = applyDesktopFold(
			makeState(),
			fold([entry('a1', { fields: { inputMode: 'x' } })]),
			deps
		);
		expect(agentsOfPlan(plan).map((a) => a.id)).toEqual(['a1', 'a2']);
	});
});

describe('applyDesktopFold: rule 8, groups', () => {
	const groups = [group('g1'), group('g2', { parentGroupId: 'g1' }), group('g3')];

	it('lands collapsed without an event, and moves no revision', () => {
		const plan = applyDesktopFold(
			makeState({ groups }),
			fold([], { groups: { collapsed: { g1: true, g3: false, unknown: true } } }),
			deps
		);
		expect((plan.groups?.groups as GroupRecord[]).map((g) => [g.id, g.collapsed])).toEqual([
			['g1', true],
			['g2', false],
			['g3', false],
		]);
		expect(plan.events).toEqual([]);
		expect(plan.sessions).toBeUndefined();
	});

	it('writes nothing when collapsed already says so', () => {
		const plan = applyDesktopFold(
			makeState({ groups: [group('g1', { collapsed: undefined })] }),
			fold([], { groups: { collapsed: { g1: false } } }),
			deps
		);
		expect(plan.groups).toBeUndefined();
	});

	it('replaces name, emoji, icon, color, kind, and parent of known groups at the current revision', () => {
		const plan = applyDesktopFold(
			makeState({ groups, groupsRev: 2 }),
			fold([], {
				groups: {
					baseRev: 2,
					collapsed: {},
					domain: [
						group('g1', { name: 'RENAMED', emoji: 'R', collapsed: true }),
						group('g2', { parentGroupId: undefined }),
						group('g3', { icon: 'star', color: '#112233', collapsed: true, plugin: 'x' }),
					],
				},
			}),
			deps
		);
		const next = plan.groups?.groups as GroupRecord[];
		expect(next[0]).toMatchObject({ id: 'g1', name: 'RENAMED', emoji: 'R', collapsed: false });
		expect('parentGroupId' in next[1]).toBe(false);
		// The appearance is domain (icon and color); keys outside the domain list are not carried.
		expect(next[2]).toMatchObject({ icon: 'star', color: '#112233', collapsed: false });
		expect('plugin' in next[2]).toBe(false);
		expect(plan.events).toMatchObject([{ type: 'groups.changed' }]);
	});

	it('adopts an unknown group unless it is tombstoned', () => {
		const plan = applyDesktopFold(
			makeState({ groups, groupsRev: 0, removedGroups: ['dead'] }),
			fold([], {
				groups: {
					baseRev: 0,
					collapsed: { fresh: true },
					domain: [...groups, group('fresh'), group('dead'), { id: 5 } as unknown as GroupRecord],
				},
			}),
			deps
		);
		const next = plan.groups?.groups as GroupRecord[];
		expect(next.map((g) => g.id)).toEqual(['g1', 'g2', 'g3', 'fresh']);
		expect(next[3].collapsed).toBe(true);
		expect(kinds(plan)).toEqual(['adopted-group']);
		expect(plan.drift[0].groupId).toBe('fresh');
	});

	it('drops the domain list at a stale revision and reports it, but still lands collapsed', () => {
		const plan = applyDesktopFold(
			makeState({ groups, groupsRev: 3 }),
			fold([], {
				groups: { baseRev: 2, collapsed: { g3: true }, domain: [group('g1', { name: 'NOPE' })] },
			}),
			deps
		);
		expect(kinds(plan)).toEqual(['groups-domain-dropped']);
		const next = plan.groups?.groups as GroupRecord[];
		expect(next[0].name).toBe('G1');
		expect(next[2].collapsed).toBe(true);
		expect(plan.events).toEqual([]);
	});

	it('reports nothing for a stale domain list that matches what is stored', () => {
		const plan = applyDesktopFold(
			makeState({ groups, groupsRev: 3 }),
			fold([], { groups: { baseRev: 0, collapsed: {}, domain: groups } }),
			deps
		);
		expect(plan.drift).toEqual([]);
		expect(plan.groups).toBeUndefined();
	});

	it('removes groups always, promotes children, ungroups members, and tombstones the id', () => {
		const state = makeState({
			groups,
			agents: [agent('a1', { groupId: 'g1' }), agent('a2', { groupId: 'g3' })],
		});
		const plan = applyDesktopFold(
			state,
			fold([], { groups: { collapsed: {}, removeGroups: ['g1', 'ghost'] } }),
			deps
		);
		const next = plan.groups?.groups as GroupRecord[];
		expect(next.map((g) => g.id)).toEqual(['g2', 'g3']);
		expect('parentGroupId' in next[0]).toBe(false);
		expect('groupId' in planAgent(plan, 'a1')).toBe(false);
		expect(planAgent(plan, 'a2').groupId).toBe('g3');
		expect(plan.tombstoneGroups).toEqual(['g1', 'ghost']);
		expect(plan.events.map((e) => e.type)).toEqual(['agent.updated', 'groups.changed']);
	});

	it('lets a member the fold moved elsewhere keep its move when its group is removed', () => {
		const plan = applyDesktopFold(
			makeState({ groups, agents: [agent('a1', { groupId: 'g1' })] }),
			fold([entry('a1', { baseRev: 0, domain: { groupId: 'g3' } })], {
				groups: { collapsed: {}, removeGroups: ['g1'] },
			}),
			deps
		);
		expect(planAgent(plan, 'a1').groupId).toBe('g3');
	});

	it('does not re-adopt a group it removes in the same fold', () => {
		const plan = applyDesktopFold(
			makeState({ groups, groupsRev: 0 }),
			fold([], { groups: { baseRev: 0, collapsed: {}, removeGroups: ['g3'], domain: groups } }),
			deps
		);
		expect((plan.groups?.groups as GroupRecord[]).map((g) => g.id)).toEqual(['g1', 'g2']);
	});
});

describe('applyDesktopFold: rule 9, the active agent', () => {
	it('lands an agent that exists', () => {
		const plan = applyDesktopFold(makeState(), fold([], { activeSessionId: 'a2' }), deps);
		expect(plan.sessions?.activeSessionId).toBe('a2');
		expect(plan.events).toEqual([]);
	});

	it('lands an empty pointer, and ignores an agent that does not exist', () => {
		expect(
			applyDesktopFold(makeState(), fold([], { activeSessionId: '' }), deps).sessions
				?.activeSessionId
		).toBe('');
		expect(
			applyDesktopFold(makeState(), fold([], { activeSessionId: 'ghost' }), deps).sessions
		).toBeUndefined();
	});

	it('accepts an agent adopted in the same fold', () => {
		const plan = applyDesktopFold(
			makeState(),
			fold([], { adoptAgents: [agent('a3')], activeSessionId: 'a3' }),
			deps
		);
		expect(plan.sessions?.activeSessionId).toBe('a3');
	});

	it('keeps the other document keys when it rewrites', () => {
		const state = makeState();
		state.sessions.zebraKey = { keep: true };
		const plan = applyDesktopFold(state, fold([], { activeSessionId: 'a2' }), deps);
		expect(plan.sessions?.zebraKey).toEqual({ keep: true });
	});
});

describe('applyDesktopFold: the events', () => {
	it('orders removals, then each touched agent (tab events, then the agent), then groups.changed', () => {
		const state = makeState({
			agents: [agent('a1'), agent('a2'), agent('a3')],
			groups: [group('g1')],
			revs: { a2: 1 },
		});
		const plan = applyDesktopFold(
			state,
			fold(
				[
					entry('a2', { baseRev: 1, adoptTabs: [tab('t-new')], domain: { name: 'Two' } }),
					entry('a1', { baseRev: 0, closeTabs: ['a1-t2'] }),
				],
				{
					removeAgents: ['a3'],
					adoptAgents: [agent('a4')],
					groups: { baseRev: 0, collapsed: {}, domain: [group('g1', { name: 'ONE' })] },
				}
			),
			deps
		);
		expect(
			plan.events.map((e) => (e.type === 'agent.removed' ? `${e.type}:${e.agentId}` : e.type))
		).toEqual([
			'agent.removed:a3',
			'agent.added',
			'tab.added',
			'agent.updated',
			'tab.removed',
			'agent.updated',
			'groups.changed',
		]);
		const agentEvents = plan.events.filter(
			(e) => e.type === 'agent.added' || e.type === 'agent.updated'
		);
		expect(agentEvents.map((e) => (e as { agent: AgentRecord }).agent.id)).toEqual([
			'a4',
			'a2',
			'a1',
		]);
		// Every agent event is projected: no transcripts.
		for (const e of agentEvents) {
			for (const t of (e as { agent: AgentRecord }).agent.aiTabs ?? [])
				expect('logs' in t).toBe(false);
		}
	});

	it('emits one agent.updated per agent however many parts landed', () => {
		const plan = applyDesktopFold(
			makeState({ groups: [group('g1')] }),
			fold(
				[
					entry('a1', {
						baseRev: 0,
						domain: { name: 'X' },
						adoptTabs: [tab('n')],
						closeTabs: ['a1-t2'],
					}),
				],
				{}
			),
			deps
		);
		expect(plan.events.filter((e) => e.type === 'agent.updated')).toHaveLength(1);
	});
});
