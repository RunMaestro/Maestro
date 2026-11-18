import { describe, it, expect } from 'vitest';
import { resolvePeerRoster } from '../../shared/peerAgents';
import { prepareQueueRouting, assertQueueRouting } from '../../main/pianola/pianola-queue-routing';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { PianolaQueueItem } from '../../shared/pianola/pianola-dispatch';

const agents: AgentRecord[] = [
	{
		id: 'source',
		name: 'Source',
		createdAt: 1,
		toolType: 'codex',
		groupId: 'team',
		groupPeerAccess: { read: true, write: false },
		parentSessionId: 'parent',
		worktreePeerAccess: { read: false, write: true },
	},
	{
		id: 'a',
		name: 'PeerA',
		createdAt: 1,
		toolType: 'codex',
		groupId: 'team',
		parentSessionId: 'parent',
	},
	{ id: 'b', name: 'PeerB', createdAt: 1, toolType: 'codex', groupId: 'nested-team' },
];
const item: PianolaQueueItem = {
	id: 'item',
	timestamp: 1,
	type: 'message',
	text: 'Check @PeerA',
	tabId: 'tab',
	pendingAdmissionId: 'dispatch',
	crossAgentMention: true,
};

describe('ported native peer roster and managed routing', () => {
	it('unions group and worktree access, with explicit rows replacing both bits', () => {
		expect(resolvePeerRoster(agents[0], agents)).toMatchObject([
			{ sessionId: 'a', read: true, write: true, source: 'group' },
		]);
		expect(
			resolvePeerRoster(
				{ ...agents[0], peerAgents: [{ sessionId: 'a', read: false, write: false }] },
				agents
			)
		).toEqual([]);
		expect(
			resolvePeerRoster(
				{ ...agents[0], peerAgents: [{ sessionId: 'a', read: true, write: false }] },
				agents
			)
		).toMatchObject([{ sessionId: 'a', read: true, write: false, source: 'explicit' }]);
	});

	it('does not infer grants from same names, nested groups, missing agents or self rows', () => {
		expect(
			resolvePeerRoster(
				{
					id: 'source',
					peerAgents: [
						{ sessionId: 'source', read: true, write: true },
						{ sessionId: 'missing', read: true, write: true },
					],
				},
				agents
			)
		).toEqual([]);
		expect(resolvePeerRoster(agents[0], agents).some((p) => p.sessionId === 'b')).toBe(false);
	});

	it('pins consult and handoff to separate read/write rights and stable step IDs', () => {
		const native = { agents, groups: [] };
		const consult = prepareQueueRouting(item, 'source', native)!;
		expect(consult.steps.map((s) => s.kind)).toEqual(['consult', 'local']);
		expect(() => assertQueueRouting(consult, item, 'source', native)).not.toThrow();
		const readOnly = {
			agents: [{ ...agents[0], worktreePeerAccess: undefined }, ...agents.slice(1)],
			groups: [],
		};
		expect(() =>
			prepareQueueRouting({ ...item, mentionRouting: 'handoff' }, 'source', readOnly)
		).toThrow('PeerDenied');
		const handoff = prepareQueueRouting({ ...item, mentionRouting: 'handoff' }, 'source', native)!;
		expect(handoff.steps.map((s) => s.kind)).toEqual(['handoff', 'local']);
	});

	it('blocks renamed, deleted, replaced, ambiguously named and newly retargeted recipients', () => {
		const pinned = prepareQueueRouting(item, 'source', { agents, groups: [] })!;
		for (const roster of [
			agents.filter((a) => a.id !== 'a'),
			[agents[0], { ...agents[1], name: 'Renamed' }],
			[agents[0], { ...agents[1], createdAt: 2 }],
			[agents[0], { ...agents[1], id: 'replacement' }],
		]) {
			expect(() =>
				assertQueueRouting(pinned, item, 'source', { agents: roster, groups: [] })
			).toThrow();
		}
		expect(() =>
			prepareQueueRouting(item, 'source', {
				agents: [...agents, { ...agents[1], id: 'duplicate' }],
				groups: [],
			})
		).toThrow('Ambiguous');
	});
});
