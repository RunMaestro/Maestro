import { describe, it, expect, beforeEach } from 'vitest';
import { ClientMirror, valuesEqual } from '../mirror';
import type { AgentRecord } from '../../store/records';
import type { MaestroEvent } from '../types';

function agent(id: string, extra: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id,
		name: `Agent ${id}`,
		toolType: 'claude-code',
		state: 'idle',
		aiTabs: [{ id: `${id}-t1`, state: 'idle', name: 'one' }],
		activeTabId: `${id}-t1`,
		...extra,
	};
}

const types = (events: MaestroEvent[]) => events.map((event) => event.type);

describe('valuesEqual', () => {
	it('compares JSON shapes by content, ignoring key order', () => {
		expect(valuesEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
		expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
		expect(valuesEqual([1, 2], [1, 2, 3])).toBe(false);
		expect(valuesEqual({ a: undefined }, {})).toBe(true);
		expect(valuesEqual([], {})).toBe(false);
	});
});

describe('ClientMirror', () => {
	let clock = 1000;
	let mirror: ClientMirror;

	beforeEach(() => {
		clock = 1000;
		mirror = new ClientMirror(() => clock);
		mirror.replace([agent('a'), agent('b')], [{ id: 'g1', name: 'Group' }]);
	});

	it('replaces its state without raising events and lists in host order', () => {
		expect(mirror.listAgents().map((a) => a.id)).toEqual(['a', 'b']);
		expect(mirror.listGroups()).toEqual([{ id: 'g1', name: 'Group' }]);
		expect(mirror.visibleTabs('a')?.map((t) => t.id)).toEqual(['a-t1']);
		expect(mirror.visibleTabs('missing')).toBeUndefined();
	});

	describe('upsert and remove', () => {
		it('raises agent.added for a new agent and nothing for an identical record', () => {
			expect(types(mirror.upsert(agent('c')))).toEqual(['agent.added']);
			expect(mirror.upsert(agent('c'))).toEqual([]);
		});

		it('raises tab events before one agent.updated, with whole records', () => {
			const next = agent('a', {
				aiTabs: [
					{ id: 'a-t1', state: 'idle', name: 'renamed' },
					{ id: 'a-t2', state: 'idle' },
				],
			});
			const events = mirror.upsert(next);
			expect(types(events)).toEqual(['tab.updated', 'tab.added', 'agent.updated']);
			expect(events[2]).toMatchObject({ agent: next });
		});

		it('raises tab.removed when a visible tab disappears', () => {
			const events = mirror.upsert(agent('a', { aiTabs: [] }));
			expect(events).toEqual([
				{ type: 'tab.removed', agentId: 'a', tabId: 'a-t1' },
				expect.objectContaining({ type: 'agent.updated' }),
			]);
		});

		it('raises tab.added when a hidden consult tab is revealed and tab.removed when hidden', () => {
			mirror.upsert(agent('a', { aiTabs: [{ id: 'a-t1' }, { id: 'c1', hidden: true }] }));
			const reveal = mirror.upsert(
				agent('a', { aiTabs: [{ id: 'a-t1' }, { id: 'c1', hidden: false }] })
			);
			expect(types(reveal)).toEqual(['tab.added', 'agent.updated']);
			const hide = mirror.upsert(
				agent('a', { aiTabs: [{ id: 'a-t1' }, { id: 'c1', hidden: true }] })
			);
			expect(types(hide)).toEqual(['tab.removed', 'agent.updated']);
		});

		it('raises no tab event for a hidden tab appearing', () => {
			const events = mirror.upsert(
				agent('a', {
					aiTabs: [
						{ id: 'a-t1', state: 'idle', name: 'one' },
						{ id: 'c1', hidden: true },
					],
				})
			);
			expect(types(events)).toEqual(['agent.updated']);
		});

		it('removes an agent once', () => {
			expect(mirror.remove('a')).toEqual([{ type: 'agent.removed', agentId: 'a' }]);
			expect(mirror.remove('a')).toEqual([]);
			expect(mirror.getAgent('a')).toBeUndefined();
		});
	});

	describe('groups', () => {
		it('raises groups.changed with the whole list, only on a change', () => {
			expect(mirror.setGroups([{ id: 'g1', name: 'Group' }])).toEqual([]);
			const next = [
				{ id: 'g1', name: 'Renamed' },
				{ id: 'g2', name: 'Two' },
			];
			expect(mirror.setGroups(next)).toEqual([{ type: 'groups.changed', groups: next }]);
		});
	});

	describe('mergeStateChange', () => {
		it('folds the fields the frame carries into one agent.updated', () => {
			const events = mirror.mergeStateChange({
				sessionId: 'a',
				state: 'busy',
				name: 'New name',
				cwd: '/x',
			});
			expect(types(events)).toEqual(['agent.updated']);
			expect(mirror.getAgent('a')).toMatchObject({ state: 'busy', name: 'New name', cwd: '/x' });
		});

		it('ignores an unknown agent and an unchanged frame', () => {
			expect(mirror.mergeStateChange({ sessionId: 'zzz', state: 'busy' })).toEqual([]);
			expect(mirror.mergeStateChange({ sessionId: 'a', state: 'idle' })).toEqual([]);
		});
	});

	describe('mergeTabs', () => {
		it('merges projected fields onto known tabs', () => {
			const { events, unknownTab } = mirror.mergeTabs(
				'a',
				[{ id: 'a-t1', name: 'two', hasUnread: true }],
				'a-t1'
			);
			expect(unknownTab).toBe(false);
			expect(types(events)).toEqual(['tab.updated', 'agent.updated']);
			expect(mirror.visibleTabs('a')?.[0]).toMatchObject({
				name: 'two',
				hasUnread: true,
				state: 'idle',
			});
		});

		it('reports an unknown tab instead of inventing a record', () => {
			const { unknownTab } = mirror.mergeTabs('a', [{ id: 'a-t1' }, { id: 'new-tab' }]);
			expect(unknownTab).toBe(true);
			expect(mirror.visibleTabs('a')?.map((t) => t.id)).toEqual(['a-t1']);
		});

		it('drops a visible tab the list lacks but keeps a hidden one', () => {
			mirror.upsert(
				agent('a', { aiTabs: [{ id: 'a-t1' }, { id: 'gone' }, { id: 'c1', hidden: true }] })
			);
			const { events } = mirror.mergeTabs('a', [{ id: 'a-t1' }]);
			expect(events).toContainEqual({ type: 'tab.removed', agentId: 'a', tabId: 'gone' });
			expect(mirror.getAgent('a')?.aiTabs?.map((t) => t.id)).toEqual(['a-t1', 'c1']);
		});
	});

	describe('patchTab, patchAgent, dropTab', () => {
		it('patches one tab and raises tab.updated then agent.updated', () => {
			expect(types(mirror.patchTab('a', 'a-t1', { starred: true }))).toEqual([
				'tab.updated',
				'agent.updated',
			]);
			expect(mirror.patchTab('a', 'a-t1', { starred: true })).toEqual([]);
			expect(mirror.patchTab('a', 'nope', { starred: true })).toEqual([]);
		});

		it('patches an agent', () => {
			expect(types(mirror.patchAgent('a', { name: 'X' }))).toEqual(['agent.updated']);
		});

		it('drops a tab from the record and the tab order', () => {
			mirror.upsert(agent('a', { unifiedTabOrder: [{ type: 'ai', id: 'a-t1' }] }));
			const events = mirror.dropTab('a', 'a-t1');
			expect(types(events)).toEqual(['tab.removed', 'agent.updated']);
			expect(mirror.getAgent('a')?.unifiedTabOrder).toEqual([]);
		});
	});

	describe('resolveActiveTabId and busyTabs', () => {
		it('prefers the active tab and falls back to the first visible one', () => {
			mirror.upsert(
				agent('a', { aiTabs: [{ id: 'x', hidden: true }, { id: 'y' }], activeTabId: 'x' })
			);
			expect(mirror.resolveActiveTabId('a')).toBe('y');
			expect(mirror.resolveActiveTabId('b')).toBe('b-t1');
			expect(mirror.resolveActiveTabId('nope')).toBeUndefined();
		});

		it('lists the tabs stored as busy', () => {
			mirror.patchTab('b', 'b-t1', { state: 'busy' });
			expect(mirror.busyTabs()).toEqual([{ agentId: 'b', tabId: 'b-t1' }]);
		});
	});

	describe('reconcile', () => {
		it('merges changed projection fields and clears a group', () => {
			mirror.upsert(agent('a', { groupId: 'g1' }));
			const { events, needsRead } = mirror.reconcile(
				[
					{ id: 'a', name: 'Renamed', state: 'busy', groupId: null, bookmarked: true },
					{ id: 'b', name: 'Agent b', state: 'idle' },
				],
				clock
			);
			expect(needsRead).toBe(false);
			expect(types(events)).toEqual(['agent.updated']);
			const merged = mirror.getAgent('a');
			expect(merged).toMatchObject({ name: 'Renamed', state: 'busy', bookmarked: true });
			expect(merged && 'groupId' in merged).toBe(false);
		});

		it('asks for a read when the projection names an agent or tab the mirror lacks', () => {
			expect(mirror.reconcile([{ id: 'a' }, { id: 'b' }, { id: 'new' }], clock).needsRead).toBe(
				true
			);
			expect(
				mirror.reconcile(
					[{ id: 'a', aiTabs: [{ id: 'a-t1' }, { id: 'extra' }] }, { id: 'b' }],
					clock
				).needsRead
			).toBe(true);
		});

		it('removes an agent the projection lacks, unless it was touched after the request', () => {
			clock = 2000;
			mirror.upsert(agent('fresh'));
			clock = 3000;
			// Requested at 1500, before the agent was added at 2000: the projection predates it.
			const { events } = mirror.reconcile([{ id: 'a' }, { id: 'b' }], 1500);
			expect(events).toEqual([]);
			expect(mirror.getAgent('fresh')).toBeDefined();
			const later = mirror.reconcile([{ id: 'a' }, { id: 'b' }], 3500);
			expect(later.events).toEqual([{ type: 'agent.removed', agentId: 'fresh' }]);
		});
	});

	describe('syncAgents', () => {
		it('emits adds, updates, and removals for a full read', () => {
			const events = mirror.syncAgents([agent('a', { name: 'Changed' }), agent('c')]);
			expect(types(events)).toEqual(['agent.updated', 'agent.added', 'agent.removed']);
		});
	});
});
