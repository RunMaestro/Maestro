/**
 * Tests for the peer mirror reducer: what each host event does to a mirrored peer and what it
 * pushes to the windows.
 */

import { describe, expect, it } from 'vitest';
import { liveTurnKey } from '../../../../shared/maestro-lib/client/live-turn';
import {
	applyPeerEvent,
	clearTabStale,
	createMirroredPeer,
	findMirrorPeer,
	markAllTabsStale,
	mirrorKey,
	replacePeerAgents,
	setPeerConnection,
	summarizePeer,
	type MirrorPeerSummary,
	type MirroredPeer,
} from '../../../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../../../shared/maestro-lib/store/records';

const ctx = () => {
	let n = 0;
	return { now: () => 1000, newId: () => `id-${++n}` };
};

const agent = (id: string, tabs: string[] = ['t1']): AgentRecord => ({
	id,
	name: `agent ${id}`,
	toolType: 'claude-code',
	aiTabs: tabs.map((tabId) => ({ id: tabId })),
});

function peerWith(agents: AgentRecord[]): MirroredPeer {
	return replacePeerAgents(
		createMirroredPeer({ peerId: 'buildbox', remoteId: 'r1', name: 'buildbox' }),
		agents,
		[],
		500
	).peer;
}

describe('mirrorKey', () => {
	it('is peerId:agentId, the CLI address', () => {
		expect(mirrorKey('buildbox', 'a1')).toBe('buildbox:a1');
	});
});

describe('applyPeerEvent', () => {
	it('connected without resume marks every tab stale; with resume it only sets the state', () => {
		const peer = peerWith([agent('a1', ['t1', 't2'])]);
		const fresh = applyPeerEvent(
			peer,
			{ type: 'host.connected', host: { kind: 'headless', label: 'h' }, resumed: false },
			ctx()
		);
		expect(fresh.peer.connection).toBe('connected');
		expect(Object.keys(fresh.peer.staleTabs).sort()).toEqual(
			[liveTurnKey('a1', 't1'), liveTurnKey('a1', 't2')].sort()
		);
		expect(fresh.push.map((e) => e.type)).toEqual(['peer.state', 'peer.stale']);

		const resumed = applyPeerEvent(
			peer,
			{ type: 'host.connected', host: { kind: 'headless', label: 'h' }, resumed: true },
			ctx()
		);
		expect(resumed.peer.staleTabs).toEqual({});
		expect(resumed.push.map((e) => e.type)).toEqual(['peer.state']);
	});

	it('a snapshot replaces the agents and drops live turns of tabs that are gone', () => {
		let peer = peerWith([agent('a1', ['t1', 't2'])]);
		peer = applyPeerEvent(
			peer,
			{ type: 'turn', agentId: 'a1', tabId: 't2', event: { kind: 'started', at: 1 } },
			ctx()
		).peer;
		const step = applyPeerEvent(
			peer,
			{ type: 'snapshot', agents: [agent('a1', ['t1'])], groups: [] },
			ctx()
		);
		expect(step.peer.liveTurns).toEqual({});
		expect(step.peer.lastSyncAt).toBe(1000);
		expect(step.push[0]).toMatchObject({ type: 'peer.agents', lastSyncAt: 1000 });
	});

	it('agent.added appends and reports the new count; agent.updated replaces in place', () => {
		const peer = peerWith([agent('a1')]);
		const added = applyPeerEvent(peer, { type: 'agent.added', agent: agent('a2') }, ctx());
		expect(added.peer.agents.map((a) => a.id)).toEqual(['a1', 'a2']);
		expect(added.push.map((e) => e.type)).toEqual(['agent.updated', 'peer.state']);

		const renamed = { ...agent('a1'), name: 'renamed' };
		const updated = applyPeerEvent(added.peer, { type: 'agent.updated', agent: renamed }, ctx());
		expect(updated.peer.agents.map((a) => a.name)).toEqual(['renamed', 'agent a2']);
		expect(updated.push.map((e) => e.type)).toEqual(['agent.updated']);
	});

	it('agent.removed drops the agent and its live turns; an unknown id pushes nothing', () => {
		let peer = peerWith([agent('a1'), agent('a2')]);
		peer = applyPeerEvent(
			peer,
			{ type: 'turn', agentId: 'a1', tabId: 't1', event: { kind: 'started', at: 1 } },
			ctx()
		).peer;
		const removed = applyPeerEvent(peer, { type: 'agent.removed', agentId: 'a1' }, ctx());
		expect(removed.peer.agents.map((a) => a.id)).toEqual(['a2']);
		expect(removed.peer.liveTurns).toEqual({});
		expect(
			applyPeerEvent(removed.peer, { type: 'agent.removed', agentId: 'nope' }, ctx()).push
		).toEqual([]);
	});

	it('a turn folds into liveTurns; its outcome clears it and marks the tab stale', () => {
		const c = ctx();
		let peer = peerWith([agent('a1')]);
		peer = applyPeerEvent(
			peer,
			{ type: 'turn', agentId: 'a1', tabId: 't1', event: { kind: 'text', at: 1, text: 'hi' } },
			c
		).peer;
		expect(peer.liveTurns[liveTurnKey('a1', 't1')].entries[0].text).toBe('hi');

		const ended = applyPeerEvent(
			peer,
			{
				type: 'turn',
				agentId: 'a1',
				tabId: 't1',
				event: { kind: 'outcome', at: 2, outcome: 'completed' as never, exitCode: 0 },
			},
			c
		);
		expect(ended.peer.liveTurns).toEqual({});
		expect(ended.peer.staleTabs[liveTurnKey('a1', 't1')]).toBe(true);
		expect(ended.push.map((e) => e.type)).toEqual(['turn', 'tab.stale']);
	});

	it('host.lost keeps the agents and records the reason; reconnecting keeps that reason', () => {
		const peer = peerWith([agent('a1')]);
		const lost = applyPeerEvent(peer, { type: 'host.lost', reason: 'socket closed' }, ctx());
		expect(lost.peer.connection).toBe('lost');
		expect(lost.peer.error).toBe('socket closed');
		expect(lost.peer.agents).toHaveLength(1);
		const retrying = applyPeerEvent(
			lost.peer,
			{ type: 'host.reconnecting', attempt: 1, delayMs: 500 },
			ctx()
		);
		expect(retrying.peer.connection).toBe('reconnecting');
		expect(retrying.peer.error).toBe('socket closed');
	});

	it('ignores tab, settings, Auto Run, and group chat events', () => {
		const peer = peerWith([agent('a1')]);
		for (const event of [
			{ type: 'tab.added', agentId: 'a1', tab: { id: 't9' } },
			{ type: 'settings.changed', keys: 'unknown' },
		] as const) {
			const step = applyPeerEvent(peer, event, ctx());
			expect(step.peer).toBe(peer);
			expect(step.push).toEqual([]);
		}
	});
});

describe('peer helpers', () => {
	it('setPeerConnection pushes nothing when nothing changed, and clears the error on success', () => {
		const peer = peerWith([]);
		const failed = setPeerConnection(peer, 'host-down', 'No host');
		expect(failed.peer.error).toBe('No host');
		expect(setPeerConnection(failed.peer, 'host-down', 'No host').push).toEqual([]);
		const ok = setPeerConnection(failed.peer, 'connected');
		expect(ok.peer.error).toBeUndefined();
		expect(summarizePeer(ok.peer)).toEqual({
			peerId: 'buildbox',
			remoteId: 'r1',
			name: 'buildbox',
			connection: 'connected',
			agentCount: 0,
			lastSyncAt: 500,
		});
	});

	it('markAllTabsStale then clearTabStale leaves only the other tabs stale', () => {
		const peer = markAllTabsStale(peerWith([agent('a1', ['t1', 't2'])])).peer;
		const read = clearTabStale(peer, 'a1', 't1');
		expect(Object.keys(read.staleTabs)).toEqual([liveTurnKey('a1', 't2')]);
		expect(clearTabStale(read, 'a1', 't1')).toBe(read);
	});
});

describe('findMirrorPeer', () => {
	const summary = (peerId: string, remoteId: string, name = peerId): MirrorPeerSummary => ({
		peerId,
		remoteId,
		name,
		connection: 'connected',
		agentCount: 0,
	});
	const peers = [
		summary('buildbox', 'remote-aaa111'),
		summary('remote-bbb222', 'remote-bbb222', 'twin'),
		summary('remote-bbc333', 'remote-bbc333', 'twin'),
	];

	it('matches the peer id exactly, then case-insensitively', () => {
		expect(findMirrorPeer(peers, 'buildbox')).toEqual({ ok: true, peer: peers[0] });
		expect(findMirrorPeer(peers, ' BuildBox ')).toEqual({ ok: true, peer: peers[0] });
	});

	it('matches a remote id and a unique id prefix', () => {
		expect(findMirrorPeer(peers, 'remote-aaa111')).toEqual({ ok: true, peer: peers[0] });
		expect(findMirrorPeer(peers, 'remote-bbc')).toEqual({ ok: true, peer: peers[2] });
	});

	it('refuses a name two remotes share, naming both peer ids', () => {
		const match = findMirrorPeer(peers, 'twin');
		expect(match).toMatchObject({ ok: false, code: 'ambiguous-peer' });
		expect(match.ok === false && match.error).toContain('remote-bbb222, remote-bbc333');
	});

	it('refuses an ambiguous id prefix and an unknown ref', () => {
		expect(findMirrorPeer(peers, 'remote-bb')).toMatchObject({ ok: false, code: 'ambiguous-peer' });
		expect(findMirrorPeer(peers, 'nope')).toEqual({
			ok: false,
			code: 'unknown-peer',
			error: 'Not a mirrored peer: nope',
		});
		expect(findMirrorPeer(peers, '  ')).toMatchObject({ ok: false, code: 'unknown-peer' });
		expect(findMirrorPeer([], 'buildbox')).toMatchObject({ ok: false, code: 'unknown-peer' });
	});
});
