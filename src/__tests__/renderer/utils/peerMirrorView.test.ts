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
import type { LogEntryRecord } from '../../../shared/maestro-lib/store/transcript';
import {
	buildMirrorViewSession,
	isPeerDisconnected,
	liftedMirrorTarget,
	moveToHostPeer,
	MIRROR_COMPOSER_UNAVAILABLE,
	mirroredAgentState,
	mirrorSendBlockReason,
	mirrorLogEntry,
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
