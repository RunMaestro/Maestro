import { describe, expect, it } from 'vitest';
import type { AgentRecord, GroupRecord } from '../../../shared/maestro-lib';
import { applyClientEvent, hostLabelFor, liveAgentData, type LiveState } from '../agentSource';

const agent = (id: string, name: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({
	id,
	name,
	toolType: 'claude-code',
	...extra,
});
const group = (id: string, name: string): GroupRecord => ({ id, name });

const state: LiveState = {
	agents: [agent('a', 'Alpha', { groupId: 'g1' }), agent('b', 'Beta')],
	groups: [group('g1', 'Core')],
};
const host = { kind: 'desktop' as const, pid: 4121, label: 'desktop pid 4121' };

describe('applyClientEvent', () => {
	it('replaces everything on a snapshot', () => {
		const next = applyClientEvent(state, {
			type: 'snapshot',
			agents: [agent('z', 'Zeta')],
			groups: [],
		});
		expect(next).toEqual({ agents: [agent('z', 'Zeta')], groups: [] });
	});

	it('appends an added agent and replaces an updated one in place', () => {
		const added = applyClientEvent(state, { type: 'agent.added', agent: agent('c', 'Gamma') });
		expect(added.agents.map((a) => a.id)).toEqual(['a', 'b', 'c']);

		const updated = applyClientEvent(added, {
			type: 'agent.updated',
			agent: agent('a', 'Alpha 2', { groupId: 'g1' }),
		});
		expect(updated.agents.map((a) => a.name)).toEqual(['Alpha 2', 'Beta', 'Gamma']);
		// The groups are untouched by an agent event.
		expect(updated.groups).toBe(state.groups);
	});

	it('treats an update for an unknown agent as an add', () => {
		const next = applyClientEvent(state, { type: 'agent.updated', agent: agent('n', 'New') });
		expect(next.agents.map((a) => a.id)).toEqual(['a', 'b', 'n']);
	});

	it('removes an agent, and leaves the state alone when it is not there', () => {
		const removed = applyClientEvent(state, { type: 'agent.removed', agentId: 'a' });
		expect(removed.agents.map((a) => a.id)).toEqual(['b']);
		expect(applyClientEvent(state, { type: 'agent.removed', agentId: 'nope' })).toBe(state);
	});

	it('replaces the groups wholesale', () => {
		const next = applyClientEvent(state, { type: 'groups.changed', groups: [group('g2', 'Web')] });
		expect(next.groups).toEqual([group('g2', 'Web')]);
		expect(next.agents).toBe(state.agents);
	});

	it('returns the same object for events that do not change the tree', () => {
		for (const event of [
			{ type: 'tab.added', agentId: 'a', tab: { id: 't' } },
			{ type: 'settings.changed', keys: 'unknown' },
			{ type: 'host.reconnecting', attempt: 1, delayMs: 500 },
		] as const) {
			expect(applyClientEvent(state, event)).toBe(state);
		}
	});
});

describe('liveAgentData', () => {
	it('builds the same tree the file readers do, with no problems', () => {
		const data = liveAgentData(state);
		expect(data.problems).toEqual([]);
		expect(data.agents).toBe(state.agents);
		expect(data.sections.map((section) => section.key)).toEqual(['group:g1', 'ungrouped']);
	});
});

describe('hostLabelFor', () => {
	it('prints the host label while attached, and says so when it is lost', () => {
		expect(hostLabelFor({ mode: 'desktop', host })).toBe('desktop pid 4121');
		expect(hostLabelFor({ mode: 'lost', host })).toBe('desktop pid 4121 (reconnecting)');
	});

	it('says read-only when no desktop is attached, with the reason when it is one a person can act on', () => {
		expect(hostLabelFor({ mode: 'connecting' })).toBe('connecting');
		expect(hostLabelFor({ mode: 'files' })).toBe('read-only');
		expect(hostLabelFor({ mode: 'files', reason: 'host-unavailable' })).toBe('read-only');
		expect(hostLabelFor({ mode: 'files', reason: 'unsupported' })).toBe(
			'read-only (desktop too old)'
		);
		expect(hostLabelFor({ mode: 'files', reason: 'unauthorized' })).toBe(
			'read-only (desktop refused)'
		);
	});
});
