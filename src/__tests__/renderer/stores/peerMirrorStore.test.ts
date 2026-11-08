/**
 * Tests for peerMirrorStore: a window's in-memory copy of the Federation peers the desktop
 * mirrors. Covers push folding, selection exclusivity with local agents and group chats, and the
 * stale-version rule that keeps a racing transcript read from clearing a newer stale mark.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
	createMirroredPeer,
	replacePeerAgents,
	type MirroredPeer,
	type MirrorPush,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { liveTurnKey } from '../../../shared/maestro-lib/client/live-turn';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import {
	isMirrorShown,
	mirrorDraftKey,
	reducePeerMirrorPush,
	selectActiveMirrorKey,
	usePeerMirrorStore,
} from '../../../renderer/stores/peerMirrorStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { resetStores } from '../../helpers';

const agent = (id: string, tabs: string[] = ['t1']): AgentRecord => ({
	id,
	name: `agent ${id}`,
	toolType: 'claude-code',
	aiTabs: tabs.map((tabId) => ({ id: tabId })),
});

function peerWith(peerId: string, agents: AgentRecord[]): MirroredPeer {
	return replacePeerAgents(
		{
			...createMirroredPeer({ peerId, remoteId: `r-${peerId}`, name: peerId }),
			connection: 'connected',
		},
		agents,
		[],
		500
	).peer;
}

const push = (peerId: string, event: MirrorPush['event']): MirrorPush => ({ peerId, event });

describe('peerMirrorStore', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useGroupChatStore, useSessionStore);
	});

	describe('hydrate and reset', () => {
		it('loads a snapshot in stored order and turns the mirror on', () => {
			usePeerMirrorStore
				.getState()
				.hydrate([peerWith('buildbox', [agent('a1')]), peerWith('gpu', [agent('b1')])]);
			const state = usePeerMirrorStore.getState();
			expect(state.enabled).toBe(true);
			expect(state.order).toEqual(['buildbox', 'gpu']);
			expect(state.peers.gpu.agents.map((a) => a.id)).toEqual(['b1']);
		});

		it('keeps the selection when the agent is still there, drops it when it is not', () => {
			const store = usePeerMirrorStore.getState();
			store.hydrate([peerWith('buildbox', [agent('a1')])]);
			store.selectMirroredAgent('buildbox', 'a1');
			usePeerMirrorStore.getState().hydrate([peerWith('buildbox', [agent('a1'), agent('a2')])]);
			expect(selectActiveMirrorKey(usePeerMirrorStore.getState())).toBe('buildbox:a1');
			usePeerMirrorStore.getState().hydrate([peerWith('buildbox', [agent('a2')])]);
			expect(usePeerMirrorStore.getState().activeMirror).toBeNull();
		});

		it('reset empties everything and turns the mirror off', () => {
			const store = usePeerMirrorStore.getState();
			store.hydrate([peerWith('buildbox', [agent('a1')])]);
			store.selectMirroredAgent('buildbox', 'a1');
			usePeerMirrorStore.getState().reset();
			const state = usePeerMirrorStore.getState();
			expect(state.enabled).toBe(false);
			expect(state.order).toEqual([]);
			expect(state.activeMirror).toBeNull();
		});
	});

	describe('applyPush', () => {
		it('creates a peer from its first peer.state and follows its connection', () => {
			const store = usePeerMirrorStore.getState();
			store.hydrate([]);
			store.applyPush(
				push('buildbox', {
					type: 'peer.state',
					peer: {
						peerId: 'buildbox',
						remoteId: 'r1',
						name: 'Build Box',
						connection: 'host-down',
						error: 'No host is running.',
						agentCount: 0,
					},
				})
			);
			const peer = usePeerMirrorStore.getState().peers.buildbox;
			expect(peer.name).toBe('Build Box');
			expect(peer.connection).toBe('host-down');
			expect(peer.error).toBe('No host is running.');
			expect(usePeerMirrorStore.getState().order).toEqual(['buildbox']);
		});

		it('replaces the agent list on peer.agents and drops a selection whose agent left', () => {
			const store = usePeerMirrorStore.getState();
			store.hydrate([peerWith('buildbox', [agent('a1'), agent('a2')])]);
			store.selectMirroredAgent('buildbox', 'a2');
			usePeerMirrorStore
				.getState()
				.applyPush(push('buildbox', { type: 'peer.agents', agents: [agent('a1')], groups: [] }));
			expect(usePeerMirrorStore.getState().peers.buildbox.agents.map((a) => a.id)).toEqual(['a1']);
			expect(usePeerMirrorStore.getState().activeMirror).toBeNull();
		});

		it('upserts on agent.updated and clears the selection on agent.removed', () => {
			const store = usePeerMirrorStore.getState();
			store.hydrate([peerWith('buildbox', [agent('a1')])]);
			store.applyPush(
				push('buildbox', { type: 'agent.updated', agent: { ...agent('a1'), name: 'renamed' } })
			);
			expect(usePeerMirrorStore.getState().peers.buildbox.agents[0].name).toBe('renamed');
			usePeerMirrorStore.getState().selectMirroredAgent('buildbox', 'a1');
			usePeerMirrorStore
				.getState()
				.applyPush(push('buildbox', { type: 'agent.removed', agentId: 'a1' }));
			expect(usePeerMirrorStore.getState().peers.buildbox.agents).toEqual([]);
			expect(isMirrorShown()).toBe(false);
		});

		it('folds a live turn, then carries its entries over and marks the tab stale when it ends', () => {
			const store = usePeerMirrorStore.getState();
			store.hydrate([peerWith('buildbox', [agent('a1')])]);
			const key = liveTurnKey('a1', 't1');
			store.applyPush(
				push('buildbox', {
					type: 'turn',
					agentId: 'a1',
					tabId: 't1',
					event: { kind: 'text', at: 1, text: 'hello' },
				})
			);
			expect(usePeerMirrorStore.getState().peers.buildbox.liveTurns[key].entries[0].text).toBe(
				'hello'
			);

			usePeerMirrorStore.getState().applyPush(
				push('buildbox', {
					type: 'turn',
					agentId: 'a1',
					tabId: 't1',
					event: { kind: 'outcome', at: 2, outcome: 'completed' as never, exitCode: 0 },
				})
			);
			const state = usePeerMirrorStore.getState();
			expect(state.peers.buildbox.liveTurns[key]).toBeUndefined();
			const slot = state.transcripts.buildbox[key];
			expect(slot.stale).toBe(true);
			expect(slot.carryover?.[0].text).toBe('hello');
		});

		it('marks only slots that exist on tab.stale, and every slot on peer.stale', () => {
			const store = usePeerMirrorStore.getState();
			store.hydrate([peerWith('buildbox', [agent('a1', ['t1', 't2'])])]);
			const version = store.beginTranscriptRead('buildbox', 'a1', 't1');
			usePeerMirrorStore.getState().finishTranscriptRead('buildbox', 'a1', 't1', [], version);

			usePeerMirrorStore
				.getState()
				.applyPush(push('buildbox', { type: 'tab.stale', agentId: 'a1', tabId: 't2' }));
			expect(
				usePeerMirrorStore.getState().transcripts.buildbox[liveTurnKey('a1', 't2')]
			).toBeUndefined();

			usePeerMirrorStore.getState().applyPush(push('buildbox', { type: 'peer.stale' }));
			expect(
				usePeerMirrorStore.getState().transcripts.buildbox[liveTurnKey('a1', 't1')].stale
			).toBe(true);
		});

		it('drops a removed peer with its slots, view state, and selection', () => {
			const store = usePeerMirrorStore.getState();
			store.hydrate([peerWith('buildbox', [agent('a1')]), peerWith('gpu', [agent('b1')])]);
			store.selectMirroredAgent('buildbox', 'a1');
			store.togglePeerCollapsed('buildbox');
			usePeerMirrorStore.getState().applyPush(push('buildbox', { type: 'peer.removed' }));
			const state = usePeerMirrorStore.getState();
			expect(state.order).toEqual(['gpu']);
			expect(state.peers.buildbox).toBeUndefined();
			expect(state.collapsedPeerIds.buildbox).toBeUndefined();
			expect(state.activeMirror).toBeNull();
		});

		it('is pure: the reducer does not mutate the state it is given', () => {
			usePeerMirrorStore.getState().hydrate([peerWith('buildbox', [agent('a1')])]);
			const before = usePeerMirrorStore.getState();
			const frozen = JSON.stringify(before.peers);
			reducePeerMirrorPush(before, push('buildbox', { type: 'agent.removed', agentId: 'a1' }));
			expect(JSON.stringify(before.peers)).toBe(frozen);
		});
	});

	describe('transcript reads', () => {
		it('a read that started before a stale mark keeps the mark (and the carryover)', () => {
			const store = usePeerMirrorStore.getState();
			store.hydrate([peerWith('buildbox', [agent('a1')])]);
			const version = store.beginTranscriptRead('buildbox', 'a1', 't1');
			usePeerMirrorStore.getState().applyPush(
				push('buildbox', {
					type: 'turn',
					agentId: 'a1',
					tabId: 't1',
					event: { kind: 'gap', at: 3 },
				})
			);
			usePeerMirrorStore
				.getState()
				.finishTranscriptRead(
					'buildbox',
					'a1',
					't1',
					[{ id: 'e1', timestamp: 1, source: 'user', text: 'hi' }],
					version
				);
			const slot = usePeerMirrorStore.getState().transcripts.buildbox[liveTurnKey('a1', 't1')];
			expect(slot.loaded).toBe(true);
			expect(slot.stale).toBe(true);
		});

		it('a read with no stale mark in between clears staleness and the carryover', () => {
			const store = usePeerMirrorStore.getState();
			store.hydrate([peerWith('buildbox', [agent('a1')])]);
			usePeerMirrorStore.getState().applyPush(push('buildbox', { type: 'peer.stale' }));
			const version = usePeerMirrorStore.getState().beginTranscriptRead('buildbox', 'a1', 't1');
			usePeerMirrorStore.getState().finishTranscriptRead('buildbox', 'a1', 't1', [], version);
			const slot = usePeerMirrorStore.getState().transcripts.buildbox[liveTurnKey('a1', 't1')];
			expect(slot.stale).toBe(false);
			expect(slot.loading).toBe(false);
			expect(slot.carryover).toBeUndefined();
		});

		it('a failed read records the error and spends the stale mark, so the view does not loop', () => {
			const store = usePeerMirrorStore.getState();
			store.hydrate([peerWith('buildbox', [agent('a1')])]);
			store.beginTranscriptRead('buildbox', 'a1', 't1');
			usePeerMirrorStore
				.getState()
				.failTranscriptRead('buildbox', 'a1', 't1', 'Peer "buildbox" is not connected.');
			const slot = usePeerMirrorStore.getState().transcripts.buildbox[liveTurnKey('a1', 't1')];
			expect(slot.error).toContain('not connected');
			expect(slot.stale).toBe(false);
			expect(slot.loading).toBe(false);
		});
	});

	describe('selection', () => {
		it('selecting a mirrored agent closes the active group chat', () => {
			usePeerMirrorStore.getState().hydrate([peerWith('buildbox', [agent('a1')])]);
			useGroupChatStore.getState().setActiveGroupChatId('chat-1');
			usePeerMirrorStore.getState().selectMirroredAgent('buildbox', 'a1');
			expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
			expect(selectActiveMirrorKey(usePeerMirrorStore.getState())).toBe('buildbox:a1');
		});

		it('ignores an agent the peer does not have', () => {
			usePeerMirrorStore.getState().hydrate([peerWith('buildbox', [agent('a1')])]);
			usePeerMirrorStore.getState().selectMirroredAgent('buildbox', 'nope');
			expect(usePeerMirrorStore.getState().activeMirror).toBeNull();
		});

		it('selecting a local agent leaves the mirror, even the one already active', () => {
			usePeerMirrorStore.getState().hydrate([peerWith('buildbox', [agent('a1')])]);
			useSessionStore.setState({ activeSessionId: 'local-1' });
			usePeerMirrorStore.getState().selectMirroredAgent('buildbox', 'a1');
			useSessionStore.getState().setActiveSessionId('local-1');
			expect(isMirrorShown()).toBe(false);

			usePeerMirrorStore.getState().selectMirroredAgent('buildbox', 'a1');
			useSessionStore.getState().setActiveSessionIdInternal('local-2');
			expect(isMirrorShown()).toBe(false);
		});

		it('never puts a mirrored agent into sessionStore', () => {
			usePeerMirrorStore.getState().hydrate([peerWith('buildbox', [agent('a1')])]);
			usePeerMirrorStore.getState().selectMirroredAgent('buildbox', 'a1');
			usePeerMirrorStore
				.getState()
				.applyPush(push('buildbox', { type: 'agent.updated', agent: agent('a2') }));
			const sessions = useSessionStore.getState();
			expect(sessions.sessions).toEqual([]);
			expect(sessions.activeSessionId).not.toBe('buildbox:a1');
		});

		it('cycles the shown agent tabs, wrapping, skipping hidden tabs', () => {
			const withHidden: AgentRecord = {
				...agent('a1', ['t1', 't2', 't3']),
				aiTabs: [{ id: 't1' }, { id: 't2', hidden: true }, { id: 't3' }],
			};
			usePeerMirrorStore.getState().hydrate([peerWith('buildbox', [withHidden])]);
			usePeerMirrorStore.getState().selectMirroredAgent('buildbox', 'a1');
			usePeerMirrorStore.getState().cycleMirrorTab(1);
			expect(usePeerMirrorStore.getState().activeTabIds.buildbox.a1).toBe('t3');
			usePeerMirrorStore.getState().cycleMirrorTab(1);
			expect(usePeerMirrorStore.getState().activeTabIds.buildbox.a1).toBe('t1');
			usePeerMirrorStore.getState().cycleMirrorTab(-1);
			expect(usePeerMirrorStore.getState().activeTabIds.buildbox.a1).toBe('t3');
		});
	});

	describe('composer drafts', () => {
		it('keeps a draft per mirrored tab and drops it when emptied', () => {
			const store = usePeerMirrorStore.getState();
			store.hydrate([peerWith('buildbox', [agent('a1', ['t1', 't2'])])]);
			store.setMirrorDraft('buildbox', 'a1', 't1', 'half a thought');
			store.setMirrorDraft('buildbox', 'a1', 't2', 'other tab');
			expect(usePeerMirrorStore.getState().drafts).toEqual({
				[mirrorDraftKey('buildbox', 'a1', 't1')]: 'half a thought',
				[mirrorDraftKey('buildbox', 'a1', 't2')]: 'other tab',
			});
			usePeerMirrorStore.getState().setMirrorDraft('buildbox', 'a1', 't1', '');
			expect(Object.keys(usePeerMirrorStore.getState().drafts)).toEqual([
				mirrorDraftKey('buildbox', 'a1', 't2'),
			]);
		});

		it('survives a fresh snapshot, and goes with a removed peer', () => {
			const store = usePeerMirrorStore.getState();
			store.hydrate([peerWith('buildbox', [agent('a1')]), peerWith('gpu', [agent('b1')])]);
			store.setMirrorDraft('buildbox', 'a1', 't1', 'keep me');
			store.setMirrorDraft('gpu', 'b1', 't1', 'gpu draft');
			usePeerMirrorStore
				.getState()
				.hydrate([peerWith('buildbox', [agent('a1')]), peerWith('gpu', [agent('b1')])]);
			expect(Object.keys(usePeerMirrorStore.getState().drafts)).toHaveLength(2);
			usePeerMirrorStore.getState().applyPush(push('buildbox', { type: 'peer.removed' }));
			expect(usePeerMirrorStore.getState().drafts).toEqual({
				[mirrorDraftKey('gpu', 'b1', 't1')]: 'gpu draft',
			});
		});

		it('never writes a draft into sessionStore', () => {
			usePeerMirrorStore.getState().hydrate([peerWith('buildbox', [agent('a1')])]);
			usePeerMirrorStore.getState().setMirrorDraft('buildbox', 'a1', 't1', 'text');
			expect(useSessionStore.getState().sessions).toEqual([]);
		});
	});
});
