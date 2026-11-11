/**
 * Tests for services/peerMirror: opening a mirrored agent by its mirror key (the Thinking pill's
 * click), and the queued-card actions on a host queue, whose "no longer waits" answer is a yellow
 * notice rather than a red failure toast.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type * as NotificationStoreModule from '../../../renderer/stores/notificationStore';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => {
	const actual = await importOriginal<typeof NotificationStoreModule>();
	return { ...actual, notifyToast: vi.fn(() => 'toast-1') };
});

import {
	openMirroredAgentByKey,
	removeMirrorQueuedItem,
	setMirrorQueuedItemPaused,
} from '../../../renderer/services/peerMirror';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import {
	selectActiveMirrorKey,
	usePeerMirrorStore,
} from '../../../renderer/stores/peerMirrorStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { resetStores } from '../../helpers';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();

function hydrate() {
	const peerOf = (peerId: string, agentId: string) =>
		replacePeerAgents(
			createMirroredPeer({ peerId, remoteId: `r-${peerId}`, name: peerId }),
			[
				{
					id: agentId,
					name: `agent ${agentId}`,
					toolType: 'claude-code',
					aiTabs: [{ id: 't1' }, { id: 't2' }],
				},
			],
			[],
			1
		).peer;
	usePeerMirrorStore.getState().hydrate([peerOf('box', 'a1'), peerOf('gpu', 'b1')]);
}

describe('services/peerMirror', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore);
		act$.mockReset();
		maestro.federation = { act: act$ };
		vi.mocked(notifyToast).mockClear();
	});

	afterEach(() => {
		delete maestro.federation;
	});

	describe('openMirroredAgentByKey', () => {
		it('shows the mirrored agent the key names, on the given tab', () => {
			hydrate();
			expect(openMirroredAgentByKey('gpu:b1', 't2')).toBe(true);
			const state = usePeerMirrorStore.getState();
			expect(selectActiveMirrorKey(state)).toBe('gpu:b1');
			expect(state.activeTabIds).toEqual({ gpu: { b1: 't2' } });
		});

		it('shows the agent without picking a tab when none is given', () => {
			hydrate();
			expect(openMirroredAgentByKey('box:a1')).toBe(true);
			expect(selectActiveMirrorKey(usePeerMirrorStore.getState())).toBe('box:a1');
			expect(usePeerMirrorStore.getState().activeTabIds).toEqual({});
		});

		it('answers false for a key no mirrored agent has, such as a local agent id', () => {
			hydrate();
			expect(openMirroredAgentByKey('local-session-1', 't1')).toBe(false);
			expect(openMirroredAgentByKey('box:nope')).toBe(false);
			expect(usePeerMirrorStore.getState().activeMirror).toBeNull();
		});
	});

	describe('queued-card actions', () => {
		it('removes a waiting message on the host, with no toast when it went', async () => {
			act$.mockResolvedValue({
				ok: true,
				result: { kind: 'remove-queued', itemId: 'q1', removed: true },
			});
			await removeMirrorQueuedItem('box', 'a1', 'q1');
			expect(act$).toHaveBeenCalledWith('box', 'a1', { kind: 'remove-queued', itemId: 'q1' });
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('says so in a yellow notice when the message no longer waits to be removed', async () => {
			act$.mockResolvedValue({
				ok: true,
				result: { kind: 'remove-queued', itemId: 'q1', removed: false },
			});
			await removeMirrorQueuedItem('box', 'a1', 'q1');
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ color: 'yellow', title: 'Message not removed' })
			);
		});

		it('holds and resumes on the host, with a yellow notice when the message no longer waits', async () => {
			act$.mockResolvedValue({
				ok: true,
				result: { kind: 'pause-queued', itemId: 'q1', found: true, paused: true },
			});
			await setMirrorQueuedItemPaused('box', 'a1', 'q1', true);
			expect(act$).toHaveBeenCalledWith('box', 'a1', {
				kind: 'pause-queued',
				itemId: 'q1',
				paused: true,
			});
			expect(notifyToast).not.toHaveBeenCalled();

			act$.mockResolvedValue({
				ok: true,
				result: { kind: 'pause-queued', itemId: 'q1', found: false, paused: true },
			});
			await setMirrorQueuedItemPaused('box', 'a1', 'q1', true);
			expect(notifyToast).toHaveBeenLastCalledWith(
				expect.objectContaining({ color: 'yellow', title: 'Message not held' })
			);

			act$.mockResolvedValue({
				ok: true,
				result: { kind: 'pause-queued', itemId: 'q1', found: false, paused: false },
			});
			await setMirrorQueuedItemPaused('box', 'a1', 'q1', false);
			expect(notifyToast).toHaveBeenLastCalledWith(
				expect.objectContaining({ color: 'yellow', title: 'Message not resumed' })
			);
		});

		it('raises a red toast when the host refuses', async () => {
			act$.mockResolvedValue({ ok: false, error: 'Not connected to peer "box".' });
			await removeMirrorQueuedItem('box', 'a1', 'q1');
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ color: 'red', title: 'Could not remove the queued message' })
			);
		});
	});
});
