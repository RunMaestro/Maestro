/**
 * Tests for peerMirrorView: the one adapter from a Federation peer's library records to the view
 * types the tab strip and transcript render. It must build view objects only, and must not carry
 * fields that would point a local action at the host's data.
 */

import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import {
	createMirroredPeer,
	replacePeerAgents,
	setPeerConnection,
	type MirroredPeer,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { liveTurnKey } from '../../../shared/maestro-lib/client/live-turn';
import type { QueuedTurn } from '../../../shared/maestro-lib/client/types';
import type { LogEntryRecord } from '../../../shared/maestro-lib/store/transcript';
import {
	agentFederationStatus,
	buildMirrorThinkingItems,
	canMakeFederated,
	isPeerFederated,
	buildMirrorViewSession,
	isPeerDisconnected,
	liftedMirrorTarget,
	moveToHostPeer,
	MIRROR_COMPOSER_UNAVAILABLE,
	mirroredAgentState,
	mirrorSendBlockReason,
	mirrorLogEntry,
	mirrorQueuedItem,
	mirrorTab,
	mirrorTabEntries,
	mirrorTabs,
	peerConnectionDotState,
	resolveMirrorTabId,
} from '../../../renderer/utils/peerMirrorView';

const entry = (id: string, text: string, extra: Partial<LogEntryRecord> = {}): LogEntryRecord => ({
	id,
	timestamp: 1,
	source: 'stdout',
	text,
	...extra,
});

const agent: AgentRecord = {
	id: 'a1',
	name: 'Builder',
	toolType: 'codex',
	cwd: '/srv/app',
	activeTabId: 't2',
	aiTabs: [
		{ id: 't1', name: 'First', starred: true },
		{ id: 't2', state: 'busy' },
		{ id: 't3', hidden: true },
	],
};

describe('mirrorLogEntry', () => {
	it('copies the drawn fields and maps an unknown kind to a system line', () => {
		expect(mirrorLogEntry(entry('e1', 'hi', { source: 'future-kind' })).source).toBe('system');
		const mapped = mirrorLogEntry(
			entry('e2', 'done', {
				source: 'tool',
				turnModel: 'gpt-5',
				metadata: { toolState: { status: 'completed', input: { a: 1 } }, parentToolUseId: 'p1' },
			})
		);
		expect(mapped.metadata?.toolState?.status).toBe('completed');
		expect(mapped.metadata?.parentToolUseId).toBe('p1');
		expect(mapped.turnModel).toBe('gpt-5');
	});

	it('does not carry cross-agent jumps, recovery actions, or agent errors', () => {
		const mapped = mirrorLogEntry(
			entry('e3', 'x', {
				metadata: { crossAgent: { requestId: 'r', fromSessionId: 'host-agent' } },
				recoveryAction: { kind: 'resume' },
				agentError: { type: 'unknown', message: 'boom' },
			} as Partial<LogEntryRecord>)
		) as unknown as Record<string, unknown>;
		expect(mapped.recoveryAction).toBeUndefined();
		expect(mapped.agentError).toBeUndefined();
		expect((mapped.metadata as Record<string, unknown> | undefined)?.crossAgent).toBeUndefined();
	});
});

describe('tabs', () => {
	it('hides consult tabs and keeps name, star, and busy state without a transcript', () => {
		const tabs = mirrorTabs(agent);
		expect(tabs.map((tab) => tab.id)).toEqual(['t1', 't2']);
		expect(tabs[0]).toMatchObject({ name: 'First', starred: true, logs: [], inputValue: '' });
		expect(tabs[1].state).toBe('busy');
	});

	it('resolves the picked tab, else the host active tab, else the first visible one', () => {
		expect(resolveMirrorTabId(agent, 't1')).toBe('t1');
		expect(resolveMirrorTabId(agent, 't3')).toBe('t2');
		expect(resolveMirrorTabId({ ...agent, activeTabId: 't3' })).toBe('t1');
		expect(resolveMirrorTabId({ ...agent, aiTabs: [] })).toBeUndefined();
	});

	it('carries the host turn start only on a busy tab', () => {
		expect(mirrorTab({ id: 't1', state: 'busy', thinkingStartTime: 42 }).thinkingStartTime).toBe(
			42
		);
		expect(
			mirrorTab({ id: 't1', state: 'idle', thinkingStartTime: 42 }).thinkingStartTime
		).toBeUndefined();
		expect(mirrorTab({ id: 't1', thinkingStartTime: 42 }).thinkingStartTime).toBeUndefined();
	});
});

const queued = (itemId: string, extra: Partial<QueuedTurn> = {}): QueuedTurn => ({
	itemId,
	tabId: 't1',
	queuedAt: 100,
	kind: 'message',
	text: `text ${itemId}`,
	paused: false,
	...extra,
});

describe('mirrorQueuedItem', () => {
	it('maps a waiting host message onto a queued card item', () => {
		expect(mirrorQueuedItem(queued('q1'))).toEqual({
			id: 'q1',
			timestamp: 100,
			tabId: 't1',
			type: 'message',
			text: 'text q1',
		});
	});

	it('marks a held message paused and draws a host command as its text', () => {
		const item = mirrorQueuedItem(queued('q2', { kind: 'command', text: '/x y', paused: true }));
		expect(item.type).toBe('message');
		expect(item.text).toBe('/x y');
		expect(item.paused).toBe(true);
	});
});

describe('mirrorTabEntries', () => {
	it('shows the persisted transcript, then the live tail, once per entry id', () => {
		const persisted = [entry('u1', 'question', { source: 'user' })];
		const live = {
			startedAt: 1,
			busy: true,
			entries: [entry('u1', 'question', { source: 'user' }), entry('s1', 'answer so far')],
		};
		expect(mirrorTabEntries(persisted, live).map((e) => e.id)).toEqual(['u1', 's1']);
	});

	it('falls back to the carryover when no turn is live', () => {
		expect(mirrorTabEntries([], undefined, [entry('s1', 'kept')]).map((e) => e.text)).toEqual([
			'kept',
		]);
	});
});

describe('buildMirrorViewSession', () => {
	it('builds a view keyed by the mirror key with only the shown tab holding entries', () => {
		const view = buildMirrorViewSession({
			peerId: 'buildbox',
			agent,
			tabId: 't1',
			entries: [mirrorLogEntry(entry('e1', 'hello'))],
		});
		expect(view.id).toBe('buildbox:a1');
		expect(view.activeTabId).toBe('t1');
		expect(view.inputMode).toBe('ai');
		expect(view.executionQueue).toEqual([]);
		expect(view.sessionSshRemoteConfig).toBeUndefined();
		// No project root: transcript backfill (a LOCAL provider read) has nowhere to read from.
		expect(view.projectRoot).toBeUndefined();
		expect(view.aiTabs.find((tab) => tab.id === 't1')?.logs).toHaveLength(1);
		expect(view.aiTabs.find((tab) => tab.id === 't2')?.logs).toEqual([]);
	});

	it('fills the execution queue from the host queue, in order', () => {
		const view = buildMirrorViewSession({
			peerId: 'buildbox',
			agent,
			tabId: 't1',
			entries: [],
			queue: [queued('q1'), queued('q2', { paused: true })],
		});
		expect(view.executionQueue.map((item) => item.id)).toEqual(['q1', 'q2']);
		expect(view.executionQueue[1].paused).toBe(true);
	});
});

describe('buildMirrorThinkingItems', () => {
	const hostAgent: AgentRecord = {
		id: 'a1',
		name: 'Builder',
		toolType: 'codex',
		aiTabs: [
			{ id: 't1', name: 'Work', state: 'busy', thinkingStartTime: 50 },
			{ id: 't2', state: 'busy' },
			{ id: 't3', state: 'busy', hidden: true },
			{ id: 't4', state: 'idle' },
		],
	};
	const peerOf = (
		peerId: string,
		agents: AgentRecord[],
		connection: MirroredPeer['connection'] = 'connected'
	): MirroredPeer =>
		setPeerConnection(
			replacePeerAgents(
				createMirroredPeer({ peerId, remoteId: `r-${peerId}`, name: `Peer ${peerId}` }),
				agents,
				[],
				1
			).peer,
			connection
		).peer;

	it('lists each visible busy tab of a connected peer, keyed and named for the mirror', () => {
		const peer = peerOf('box', [hostAgent]);
		const items = buildMirrorThinkingItems({ box: peer }, ['box']);
		expect(items.map((item) => item.tab?.id)).toEqual(['t1', 't2']);
		expect(items[0].session).toEqual({ id: 'box:a1', name: 'Builder on Peer box', state: 'busy' });
		expect(items[0].mirror).toEqual({ peerId: 'box', agentId: 'a1' });
		expect(items[0].tab?.thinkingStartTime).toBe(50);
		expect(items[0].tab?.name).toBe('Work');
	});

	it('falls back to the live turn start when the host sent none', () => {
		const peer: MirroredPeer = {
			...peerOf('box', [hostAgent]),
			liveTurns: { [liveTurnKey('a1', 't2')]: { startedAt: 77, entries: [], busy: true } },
		};
		const items = buildMirrorThinkingItems({ box: peer }, ['box']);
		expect(items.find((item) => item.tab?.id === 't2')?.tab?.thinkingStartTime).toBe(77);
	});

	it('shows nothing for a peer that is not connected, or one missing from the map', () => {
		const lost = peerOf('box', [hostAgent], 'lost');
		expect(buildMirrorThinkingItems({ box: lost }, ['box'])).toEqual([]);
		expect(buildMirrorThinkingItems({}, ['gone'])).toEqual([]);
	});

	it('follows the peer order and skips an agent with no busy tab', () => {
		const idle: AgentRecord = { id: 'a2', name: 'Idle', toolType: 'codex', aiTabs: [{ id: 'x' }] };
		const peers = {
			box: peerOf('box', [hostAgent, idle]),
			gpu: peerOf('gpu', [{ ...hostAgent, id: 'g1', aiTabs: [{ id: 'gt', state: 'busy' }] }]),
		};
		const ids = buildMirrorThinkingItems(peers, ['gpu', 'box']).map((item) => item.session.id);
		expect(ids).toEqual(['gpu:g1', 'box:a1', 'box:a1']);
	});
});

describe('state dots', () => {
	it('shows an agent busy while any tab is busy', () => {
		expect(mirroredAgentState(agent)).toBe('busy');
		expect(mirroredAgentState({ ...agent, aiTabs: [], state: 'error' })).toBe('error');
	});

	it('maps a peer connection onto the agent dot colors', () => {
		expect(peerConnectionDotState('connected')).toBe('idle');
		expect(peerConnectionDotState('reconnecting')).toBe('connecting');
		expect(peerConnectionDotState('connecting')).toBe('connecting');
		expect(peerConnectionDotState('lost')).toBe('error');
		expect(peerConnectionDotState('host-down')).toBe('error');
		expect(isPeerDisconnected({ connection: 'lost' })).toBe(true);
		expect(isPeerDisconnected({ connection: 'connecting' })).toBe(false);
	});
});

describe('mirrorSendBlockReason', () => {
	it('refuses a leading slash command, which would not run on the host', () => {
		for (const text of ['/compact', '/clear now', '  /speckit:plan x', '/review-pr 12']) {
			expect(mirrorSendBlockReason(text)).toBe(MIRROR_COMPOSER_UNAVAILABLE.slashCommands);
		}
	});

	it('lets a message through that starts with a path or merely holds a slash', () => {
		for (const text of ['/Users/me/plan.md says hi', 'use a/b here', '/ alone', '!ls', 'hello']) {
			expect(mirrorSendBlockReason(text)).toBeUndefined();
		}
	});
});

describe('Move to Host (FED-SSH-06)', () => {
	const connected = (peerId: string, remoteId: string): MirroredPeer =>
		setPeerConnection(
			replacePeerAgents(
				createMirroredPeer({ peerId, remoteId, name: peerId }),
				[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [] }],
				[],
				1
			).peer,
			'connected'
		).peer;
	const ssh = { sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } };

	it('moveToHostPeer finds the connected peer of the agent remote', () => {
		const peer = connected('box', 'r1');
		expect(moveToHostPeer(ssh, [connected('other', 'r2'), peer])).toBe(peer);
	});

	it('moveToHostPeer offers nothing for a local, lifted, or unreachable agent', () => {
		const peer = connected('box', 'r1');
		expect(moveToHostPeer({}, [peer])).toBeUndefined();
		expect(
			moveToHostPeer({ sessionSshRemoteConfig: { enabled: false, remoteId: 'r1' } }, [peer])
		).toBeUndefined();
		expect(
			moveToHostPeer({ ...ssh, liftedTo: { peer: 'box', agentId: 'h1', at: 1 } }, [peer])
		).toBeUndefined();
		const lost = setPeerConnection(peer, 'lost', 'gone').peer;
		expect(moveToHostPeer(ssh, [lost])).toBeUndefined();
		expect(moveToHostPeer(ssh, [])).toBeUndefined();
	});

	it('liftedMirrorTarget reads the pointer and whether the mirror holds the agent', () => {
		const peers = { box: connected('box', 'r1') };
		expect(liftedMirrorTarget({ liftedTo: { peer: 'box', agentId: 'h1', at: 1 } }, peers)).toEqual({
			peerId: 'box',
			agentId: 'h1',
			ref: 'box:h1',
			mirrored: true,
		});
		expect(
			liftedMirrorTarget({ liftedTo: { peer: 'box', agentId: 'gone', at: 1 } }, peers)?.mirrored
		).toBe(false);
		expect(liftedMirrorTarget({ liftedTo: { peer: 'nope', agentId: 'h1', at: 1 } }, {})).toEqual({
			peerId: 'nope',
			agentId: 'h1',
			ref: 'nope:h1',
			mirrored: false,
		});
		expect(liftedMirrorTarget({}, peers)).toBeUndefined();
		expect(liftedMirrorTarget({ liftedTo: { peer: 1 } }, peers)).toBeUndefined();
	});
});

describe('Federation status of a local agent', () => {
	const peer = (connection: MirroredPeer['connection'], synced = false): MirroredPeer => {
		const base = createMirroredPeer({ peerId: 'build', remoteId: 'r1', name: 'build' });
		const withAgents = synced ? replacePeerAgents(base, [], [], 1).peer : base;
		return { ...withAgents, connection };
	};
	const ssh = { sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } };

	it('shows a peer in the Left Bar only once it has a host', () => {
		expect(isPeerFederated(peer('connected'))).toBe(true);
		expect(isPeerFederated(peer('reconnecting'))).toBe(true);
		// Probed, no host: a plain SSH remote.
		expect(isPeerFederated(peer('connecting'))).toBe(false);
		expect(isPeerFederated(peer('not-installed'))).toBe(false);
		expect(isPeerFederated(peer('host-down'))).toBe(false);
		// Seen once, now away: shown dimmed.
		expect(isPeerFederated(peer('host-down', true))).toBe(true);
		expect(isPeerFederated(peer('lost', true))).toBe(true);
	});

	it('tells a local agent, an SSH agent, and one that moved apart', () => {
		expect(agentFederationStatus({}, [peer('connected')])).toEqual({ kind: 'local' });
		expect(
			agentFederationStatus({ sessionSshRemoteConfig: { enabled: false, remoteId: 'r1' } }, [
				peer('connected'),
			])
		).toEqual({ kind: 'local' });
		expect(
			agentFederationStatus({ liftedTo: { peer: 'build', agentId: 'a1', at: 1 } }, [])
		).toEqual({ kind: 'moved' });
		expect(agentFederationStatus(ssh, [peer('connected')])).toMatchObject({
			kind: 'ssh',
			remoteId: 'r1',
			hostReady: true,
		});
	});

	it('offers Make Federated only for an SSH agent whose remote takes part and runs no host', () => {
		expect(canMakeFederated(agentFederationStatus(ssh, [peer('not-installed')]))).toBe(true);
		expect(canMakeFederated(agentFederationStatus(ssh, [peer('host-down')]))).toBe(true);
		// The host is up: Move to Host instead.
		expect(canMakeFederated(agentFederationStatus(ssh, [peer('connected')]))).toBe(false);
		// The remote opted out (no mirror entry): it stays an SSH agent.
		expect(canMakeFederated(agentFederationStatus(ssh, []))).toBe(false);
		expect(canMakeFederated({ kind: 'local' })).toBe(false);
	});
});
