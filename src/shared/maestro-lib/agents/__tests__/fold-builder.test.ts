import { describe, expect, it } from 'vitest';

import { applyDesktopFold, type FoldState } from '../desktop-fold';
import { baselineOf, buildFold, buildFoldAgent } from '../fold-builder';
import { DEFAULT_RULE_CONTEXT, DEFAULT_TAB_DEFAULTS } from '../rules';

const tab = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: null,
	starred: false,
	logs: [],
	state: 'idle',
	...extra,
});

const agent = (extra: Record<string, unknown> = {}) => ({
	id: 'a1',
	name: 'One',
	toolType: 'claude-code',
	cwd: '/p',
	state: 'idle',
	inputMode: 'ai',
	activeTabId: 't1',
	aiTabs: [tab('t1')],
	unifiedTabOrder: [{ type: 'ai', id: 't1' }],
	...extra,
});

describe('buildFoldAgent', () => {
	it('sends desktop keys whole and omits domain keys that did not change', () => {
		const stored = agent();
		const copy = agent({ inputMode: 'terminal', fileExplorerScrollPos: 40 });
		const entry = buildFoldAgent(copy, baselineOf(stored), { baseRev: 3 });
		expect(entry.id).toBe('a1');
		expect(entry.baseRev).toBe(3);
		expect(entry.provider).toBe('claude-code');
		expect(entry.fields).toMatchObject({
			inputMode: 'terminal',
			fileExplorerScrollPos: 40,
			state: 'idle',
		});
		expect(entry.fields).not.toHaveProperty('id');
		expect(entry.fields).not.toHaveProperty('name');
		expect(entry.fields).not.toHaveProperty('aiTabs');
		expect(entry.domain).toBeUndefined();
		expect(entry.tabs.t1).toMatchObject({ logs: [], state: 'idle' });
		expect(entry.tabDomain).toBeUndefined();
		expect(entry.order).toBeUndefined();
		expect(entry.closeTabs).toBeUndefined();
	});

	it('reports a changed domain key, a cleared one as undefined, and a changed tab domain key', () => {
		const stored = agent({ nudgeMessage: 'hi' });
		const copy = agent({ name: 'Renamed', aiTabs: [tab('t1', { starred: true })] });
		delete (copy as Record<string, unknown>).nudgeMessage;
		const entry = buildFoldAgent(copy, baselineOf(stored));
		expect(entry.domain).toEqual({ name: 'Renamed', nudgeMessage: undefined });
		expect(entry.tabDomain).toEqual({ t1: { starred: true } });
		expect(entry.baseRev).toBeUndefined();
	});

	it('adopts a tab the baseline lacks and closes one the copy dropped, and reports a changed order', () => {
		const stored = agent({
			aiTabs: [tab('t1'), tab('t2')],
			unifiedTabOrder: [
				{ type: 'ai', id: 't1' },
				{ type: 'ai', id: 't2' },
			],
		});
		const copy = agent({
			aiTabs: [tab('t1'), tab('t3')],
			unifiedTabOrder: [
				{ type: 'ai', id: 't3' },
				{ type: 'ai', id: 't1' },
			],
		});
		const entry = buildFoldAgent(copy, baselineOf(stored));
		expect(entry.adoptTabs?.map((t) => t.id)).toEqual(['t3']);
		expect(entry.closeTabs).toEqual(['t2']);
		expect(entry.order).toEqual([
			{ type: 'ai', id: 't3' },
			{ type: 'ai', id: 't1' },
		]);
		expect(entry.tabs).toHaveProperty('t1');
		expect(entry.tabs).not.toHaveProperty('t3');
	});

	it('leaves turn state out when this client does not own the stream', () => {
		const stored = agent();
		const copy = agent({
			state: 'busy',
			executionQueue: [{ id: 'q' }],
			aiTabs: [tab('t1', { logs: [{ id: 'l' }], state: 'busy', scrollTop: 9 })],
		});
		const entry = buildFoldAgent(copy, baselineOf(stored), { ownsStream: false });
		expect(entry.fields).not.toHaveProperty('state');
		expect(entry.fields).not.toHaveProperty('executionQueue');
		expect(entry.fields).toMatchObject({ inputMode: 'ai' });
		expect(entry.tabs.t1).toEqual({ scrollTop: 9 });
	});

	it('names the provider the copy was computed under', () => {
		const entry = buildFoldAgent(agent(), baselineOf(agent()), { provider: 'codex' });
		expect(entry.provider).toBe('codex');
	});
});

describe('buildFold', () => {
	const baselines = (...records: Array<Record<string, unknown>>) =>
		new Map(records.map((r) => [r.id as string, { baseline: baselineOf(r), rev: 2 }]));

	it('adopts an unknown agent and builds entries for known ones', () => {
		const fold = buildFold([agent(), agent({ id: 'a2' })], { baselines: baselines(agent()) });
		expect(fold.agents.map((a) => a.id)).toEqual(['a1']);
		expect(fold.agents[0].baseRev).toBe(2);
		expect(fold.adoptAgents?.map((a) => a.id)).toEqual(['a2']);
		expect(fold.removeAgents).toBeUndefined();
	});

	it('removes an absent agent only with removeAbsent, and carries the active id', () => {
		const known = baselines(agent(), agent({ id: 'a2' }));
		expect(buildFold([agent()], { baselines: known }).removeAgents).toBeUndefined();
		const fold = buildFold([agent()], {
			baselines: known,
			removeAbsent: true,
			activeSessionId: 'a1',
		});
		expect(fold.removeAgents).toEqual(['a2']);
		expect(fold.activeSessionId).toBe('a1');
	});

	it('asks the owner callback per agent', () => {
		const fold = buildFold([agent({ state: 'busy' })], {
			baselines: baselines(agent()),
			ownsStream: () => false,
		});
		expect(fold.agents[0].fields).not.toHaveProperty('state');
	});

	it('round-trips through the applier: a fold built from a copy lands the copy', () => {
		const stored = agent();
		const copy = agent({
			name: 'Renamed',
			inputMode: 'terminal',
			aiTabs: [tab('t1', { starred: true, logs: [{ id: 'l1' }] })],
		});
		const fold = buildFold([copy], { baselines: baselines(stored) });
		const state: FoldState = {
			sessions: { sessions: [stored] },
			groups: { groups: [] },
			revisionOf: () => 2,
			groupsRev: 0,
			removedAgentIds: new Set(),
			removedGroupIds: new Set(),
			closedTabIds: () => new Set(),
		};
		const plan = applyDesktopFold(state, fold, {
			ctx: DEFAULT_RULE_CONTEXT,
			defaults: DEFAULT_TAB_DEFAULTS,
		});
		const next = (plan.sessions?.sessions as Array<Record<string, any>>)[0];
		expect(next.name).toBe('Renamed');
		expect(next.inputMode).toBe('terminal');
		expect(next.aiTabs[0]).toMatchObject({ starred: true, logs: [{ id: 'l1' }] });
		expect(plan.drift).toEqual([]);
	});
});
