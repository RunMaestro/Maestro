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
	hostReportIsCurrent,
	markAllTabsStale,
	MAX_MIRRORED_QUEUE_EXITS,
	queueExitOf,
	mirrorKey,
	replacePeerAgents,
	setAgentAutoRun,
	setAgentQueue,
	withReadQueueImages,
	setPeerConnection,
	summarizePeer,
	type MirrorPeerSummary,
	type MirroredPeer,
} from '../../../../shared/maestro-lib/client/peer-mirror';
import type { QueuedTurn } from '../../../../shared/maestro-lib/client/types';
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

const waiting = (itemId: string): QueuedTurn => ({
	itemId,
	tabId: 't1',
	queuedAt: 1,
	kind: 'message',
	text: itemId,
	paused: false,
});

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

describe('host queues', () => {
	it('a new peer holds no queues', () => {
		expect(
			createMirroredPeer({ peerId: 'buildbox', remoteId: 'r1', name: 'buildbox' }).queues
		).toEqual({});
	});

	it('setAgentQueue replaces the agent queue and pushes agent.queue', () => {
		const peer = peerWith([agent('a1')]);
		const step = setAgentQueue(peer, 'a1', [waiting('q1'), waiting('q2')]);
		expect(step.peer.queues).toEqual({ a1: [waiting('q1'), waiting('q2')] });
		expect(step.push).toEqual([
			{ type: 'agent.queue', agentId: 'a1', items: [waiting('q1'), waiting('q2')] },
		]);
		const next = setAgentQueue(step.peer, 'a1', [waiting('q2')]);
		expect(next.peer.queues).toEqual({ a1: [waiting('q2')] });
	});

	// Parity M26: a desktop host sends an item's images once, then says they are unchanged.
	it('an imagesKept item takes the images held for its id, and pushes them, so a card keeps its thumbnails (M26)', () => {
		const withImages = { ...waiting('q1'), images: ['data:image/png;base64,AAAA'] };
		const held = setAgentQueue(peerWith([agent('a1')]), 'a1', [withImages]).peer;
		const step = setAgentQueue(held, 'a1', [
			{ ...waiting('q1'), imagesKept: true },
			{ ...waiting('q2'), imagesKept: true },
		]);
		// q2 has none held: it keeps the flag, so a raced read can still give them.
		const unresolved = { ...waiting('q2'), imagesKept: true as const };
		expect(step.peer.queues).toEqual({ a1: [withImages, unresolved] });
		expect(step.push).toEqual([
			{ type: 'agent.queue', agentId: 'a1', items: [withImages, unresolved] },
		]);
		// The next change keeps q1's images again from what it holds.
		const again = setAgentQueue(step.peer, 'a1', [{ ...waiting('q1'), imagesKept: true }]);
		expect(again.peer.queues).toEqual({ a1: [withImages] });
	});

	it("withReadQueueImages gives an unresolved kept item the read's images, and nothing else (M26)", () => {
		const images = ['data:image/png;base64,AAAA'];
		const kept = [{ ...waiting('q1'), imagesKept: true as const }, waiting('q2')];
		expect(
			withReadQueueImages(kept, [
				{ ...waiting('q1'), images },
				{ ...waiting('q2'), images },
			])
		).toEqual([{ ...waiting('q1'), images }, waiting('q2')]);
		// Nothing to give: the same list.
		expect(withReadQueueImages(kept, [waiting('q1')])).toBe(kept);
	});

	it('an empty list drops the entry and still pushes, so a window clears its cards', () => {
		const held = setAgentQueue(peerWith([agent('a1')]), 'a1', [waiting('q1')]).peer;
		const step = setAgentQueue(held, 'a1', []);
		expect(step.peer.queues).toEqual({});
		expect(step.push).toEqual([{ type: 'agent.queue', agentId: 'a1', items: [] }]);
	});

	it('empty to empty, or an agent the peer does not have, changes nothing', () => {
		const peer = peerWith([agent('a1')]);
		const empty = setAgentQueue(peer, 'a1', []);
		expect(empty.peer).toBe(peer);
		expect(empty.push).toEqual([]);
		const unknown = setAgentQueue(peer, 'ghost', [waiting('q1')]);
		expect(unknown.peer).toBe(peer);
		expect(unknown.push).toEqual([]);
	});

	it('queue.changed from the host sets the agent queue', () => {
		const step = applyPeerEvent(
			peerWith([agent('a1')]),
			{ type: 'queue.changed', agentId: 'a1', items: [waiting('q1')] },
			ctx()
		);
		expect(step.peer.queues).toEqual({ a1: [waiting('q1')] });
		expect(step.push.map((e) => e.type)).toEqual(['agent.queue']);
	});

	it('keeps how items left the queue, bounded, and only for a host that names it (M14)', () => {
		let peer = peerWith([agent('a1'), agent('a2')]);
		// A queue read, or a host that names no exits, records none.
		peer = setAgentQueue(peer, 'a1', [waiting('q1')]).peer;
		peer = applyPeerEvent(
			peer,
			{ type: 'queue.changed', agentId: 'a2', items: [waiting('q9')] },
			ctx()
		).peer;
		expect(peer.queueExits).toBeUndefined();

		// A start that empties the queue, even of an item this mirror never held, is named.
		const started = applyPeerEvent(
			peer,
			{
				type: 'queue.changed',
				agentId: 'a1',
				items: [],
				namesExits: true,
				exit: { itemId: 'q0', exit: 'started' },
			},
			ctx()
		);
		expect(started.peer.queueExits).toEqual({ a1: [{ itemId: 'q0', exit: 'started' }] });
		expect(started.push).toEqual([
			{
				type: 'agent.queue',
				agentId: 'a1',
				items: [],
				namesExits: true,
				exit: { itemId: 'q0', exit: 'started' },
			},
		]);
		expect(queueExitOf(started.peer.queueExits?.a1, 'q0')).toBe('started');
		expect(queueExitOf(started.peer.queueExits?.a1, 'q1')).toBeUndefined();
		peer = setAgentQueue(started.peer, 'a1', [], {
			namesExits: true,
			exit: { itemId: 'q1', exit: 'removed' },
		}).peer;
		expect(queueExitOf(peer.queueExits?.a1, 'q1')).toBe('removed');
		for (let n = 1; n <= MAX_MIRRORED_QUEUE_EXITS + 5; n++) {
			peer = setAgentQueue(peer, 'a1', [], {
				namesExits: true,
				exit: { itemId: `s${n}`, exit: 'started' },
			}).peer;
		}
		expect(peer.queueExits?.a1).toHaveLength(MAX_MIRRORED_QUEUE_EXITS);
		expect(peer.queueExits?.a1?.at(-1)?.itemId).toBe(`s${MAX_MIRRORED_QUEUE_EXITS + 5}`);
		// A later queue read keeps them; the agent leaving drops them.
		expect(setAgentQueue(peer, 'a1', [waiting('q2')]).peer.queueExits?.a1).toHaveLength(
			MAX_MIRRORED_QUEUE_EXITS
		);
		const removed = applyPeerEvent(peer, { type: 'agent.removed', agentId: 'a1' }, ctx());
		expect(removed.peer.queueExits).toEqual({});
		expect(replacePeerAgents(peer, [agent('a2')], [], 2000).peer.queueExits).toEqual({});
	});

	it('counts whole reads of a queue whose host names exits, where a named exit can be missed (M18)', () => {
		let peer = peerWith([agent('a1')]);
		// Before the host is known to name exits, a read is not a gap.
		peer = setAgentQueue(peer, 'a1', [waiting('q1')]).peer;
		expect(peer.queueReads).toBeUndefined();
		peer = setAgentQueue(peer, 'a1', [waiting('q1')], { namesExits: true }).peer;
		// A named change is not a read; a read (after a reconnect) is, even of an empty queue.
		peer = setAgentQueue(peer, 'a1', [], {
			namesExits: true,
			exit: { itemId: 'q1', exit: 'removed' },
		}).peer;
		expect(peer.queueReads).toBeUndefined();
		const read = setAgentQueue(peer, 'a1', []);
		expect(read.peer.queueReads).toEqual({ a1: 1 });
		expect(read.push).toEqual([{ type: 'agent.queue', agentId: 'a1', items: [] }]);
		expect(setAgentQueue(read.peer, 'a1', []).peer.queueReads).toEqual({ a1: 2 });
		expect(
			applyPeerEvent(read.peer, { type: 'agent.removed', agentId: 'a1' }, ctx()).peer.queueReads
		).toEqual({});
	});

	it('a snapshot keeps the queues of agents still there and drops the rest', () => {
		let peer = peerWith([agent('a1'), agent('a2')]);
		peer = setAgentQueue(peer, 'a1', [waiting('q1')]).peer;
		peer = setAgentQueue(peer, 'a2', [waiting('q2')]).peer;
		const replaced = replacePeerAgents(peer, [agent('a2')], [], 2000);
		expect(replaced.peer.queues).toEqual({ a2: [waiting('q2')] });
	});

	it('agent.removed drops that agent queue only', () => {
		let peer = peerWith([agent('a1'), agent('a2')]);
		peer = setAgentQueue(peer, 'a1', [waiting('q1')]).peer;
		peer = setAgentQueue(peer, 'a2', [waiting('q2')]).peer;
		const removed = applyPeerEvent(peer, { type: 'agent.removed', agentId: 'a1' }, ctx());
		expect(removed.peer.queues).toEqual({ a2: [waiting('q2')] });
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

	it('holds the report as current only once the host listed its agents since the link was down (R35)', () => {
		const listed = setPeerConnection(peerWith([agent('a1')]), 'connected').peer;
		expect(hostReportIsCurrent(listed)).toBe(true);
		// The link drops: the agents held are the report from before, kept to draw them dimmed.
		const down = setPeerConnection(listed, 'reconnecting');
		expect(hostReportIsCurrent(down.peer)).toBe(false);
		expect(down.push).toEqual([
			{ type: 'peer.state', peer: expect.not.objectContaining({ reportedSinceLink: true }) },
		]);
		// Connected again (a restarted host attaches before its snapshot): still not current.
		const back = applyPeerEvent(
			down.peer,
			{ type: 'host.connected', host: { kind: 'headless', label: 'h' }, resumed: false },
			ctx()
		).peer;
		expect(back.connection).toBe('connected');
		expect(hostReportIsCurrent(back)).toBe(false);
		// Its snapshot lands: current, and every window is told so.
		const snapshot = applyPeerEvent(
			back,
			{ type: 'snapshot', agents: [agent('a1')], groups: [] },
			ctx()
		);
		expect(hostReportIsCurrent(snapshot.peer)).toBe(true);
		expect(snapshot.push).toContainEqual({
			type: 'peer.state',
			peer: expect.objectContaining({ reportedSinceLink: true }),
		});
		// A state that is already down forgets the report even with nothing else changed.
		const lostListed = { ...setPeerConnection(listed, 'lost').peer, reportedSinceLink: true };
		expect(hostReportIsCurrent(setPeerConnection(lostListed, 'lost').peer)).toBe(false);
	});

	it('keeps the kind of host it attached to, through a disconnect, and tells every window (R36)', () => {
		const step = applyPeerEvent(
			peerWith([]),
			{ type: 'host.connected', host: { kind: 'desktop', label: 'desktop pid 1' }, resumed: true },
			ctx()
		);
		expect(step.peer.hostKind).toBe('desktop');
		expect(step.push).toContainEqual({
			type: 'peer.state',
			peer: expect.objectContaining({ hostKind: 'desktop', connection: 'connected' }),
		});
		expect(setPeerConnection(step.peer, 'lost', 'gone').peer.hostKind).toBe('desktop');
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

describe('Auto Run the host drives', () => {
	const frame = (completedTasks: number, isRunning = true) => ({
		isRunning,
		totalTasks: 3,
		completedTasks,
		currentTaskIndex: completedTasks,
		documents: ['phase-1'],
	});
	const stateEvent = (state: ReturnType<typeof frame> | null, withFrame = true) => ({
		type: 'autorun' as const,
		agentId: 'a1',
		event: {
			kind: 'state' as const,
			at: 1,
			state: null,
			...(withFrame ? { frame: state } : {}),
		},
	});

	it('an autorun state from the host holds its frame and pushes it', () => {
		const step = applyPeerEvent(peerWith([agent('a1')]), stateEvent(frame(1)), ctx());
		expect(step.peer.autoRuns).toEqual({ a1: frame(1) });
		expect(step.push).toEqual([{ type: 'agent.autorun', agentId: 'a1', state: frame(1) }]);
	});

	it('a null or a stopped frame clears the run; clearing nothing pushes nothing', () => {
		let peer = setAgentAutoRun(peerWith([agent('a1')]), 'a1', frame(1)).peer;
		const stopped = applyPeerEvent(peer, stateEvent(frame(3, false)), ctx());
		expect(stopped.peer.autoRuns).toEqual({});
		expect(stopped.push).toEqual([{ type: 'agent.autorun', agentId: 'a1', state: null }]);
		peer = stopped.peer;
		const again = applyPeerEvent(peer, stateEvent(null), ctx());
		expect(again.peer).toBe(peer);
		expect(again.push).toEqual([]);
	});

	it("passes a run's reasoning and tool calls on to the window, holding none of it", () => {
		const peer = peerWith([agent('a1')]);
		const thinking = { kind: 'thinking' as const, at: 1, processId: 'a1-batch-1', text: 'hmm' };
		const tool = {
			kind: 'tool' as const,
			at: 2,
			processId: 'a1-batch-1',
			toolName: 'Read',
			state: { status: 'running' },
		};
		for (const activity of [thinking, tool]) {
			const step = applyPeerEvent(peer, { type: 'autorun', agentId: 'a1', event: activity }, ctx());
			expect(step.peer).toBe(peer);
			expect(step.push).toEqual([{ type: 'agent.autorunActivity', agentId: 'a1', activity }]);
		}
		const ghost = applyPeerEvent(peer, { type: 'autorun', agentId: 'ghost', event: tool }, ctx());
		expect(ghost.push).toEqual([]);
	});

	it('ignores output, usage, a frameless running state, and an agent the peer does not have', () => {
		const peer = peerWith([agent('a1')]);
		for (const event of [
			{
				type: 'autorun' as const,
				agentId: 'a1',
				event: { kind: 'output' as const, at: 1, processId: 'p', text: 'x' },
			},
			{
				type: 'autorun' as const,
				agentId: 'a1',
				event: { kind: 'state' as const, at: 1, state: { isRunning: true } as never },
			},
			{ ...stateEvent(frame(1)), agentId: 'ghost' },
		]) {
			const step = applyPeerEvent(peer, event, ctx());
			expect(step.peer).toBe(peer);
			expect(step.push).toEqual([]);
		}
	});

	it('a snapshot and agent.removed drop the run of an agent that went away', () => {
		let peer = peerWith([agent('a1'), agent('a2')]);
		peer = setAgentAutoRun(peer, 'a1', frame(1)).peer;
		peer = setAgentAutoRun(peer, 'a2', frame(2)).peer;
		expect(replacePeerAgents(peer, [agent('a2')], [], 2000).peer.autoRuns).toEqual({
			a2: frame(2),
		});
		const removed = applyPeerEvent(peer, { type: 'agent.removed', agentId: 'a2' }, ctx());
		expect(removed.peer.autoRuns).toEqual({ a1: frame(1) });
	});
});
