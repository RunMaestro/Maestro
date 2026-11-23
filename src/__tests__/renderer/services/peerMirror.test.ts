/**
 * Tests for services/peerMirror: the queued-card actions on a host queue, whose "no longer waits"
 * answer is a yellow notice rather than a red failure toast.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type * as NotificationStoreModule from '../../../renderer/stores/notificationStore';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => {
	const actual = await importOriginal<typeof NotificationStoreModule>();
	return { ...actual, notifyToast: vi.fn(() => 'toast-1') };
});

import {
	callMirroredAgentAction,
	removeMirrorQueuedItem,
	setMirrorQueuedItemPaused,
} from '../../../renderer/services/peerMirror';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { resetStores } from '../../helpers';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();

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

	describe('callMirroredAgentAction', () => {
		it('hands back the answer as is, failure code included, with no toast', async () => {
			const refusal = {
				ok: false,
				error: 'Not connected to peer "box".',
				code: 'host-unavailable',
			};
			act$.mockResolvedValue(refusal);
			const action = { kind: 'update-agent' as const, patch: { model: 'opus' } };
			expect(await callMirroredAgentAction('box', 'a1', action)).toEqual(refusal);
			expect(act$).toHaveBeenCalledWith('box', 'a1', action);
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('answers a failed IPC call as a failure with no code', async () => {
			act$.mockRejectedValue(new Error('channel closed'));
			const answer = await callMirroredAgentAction('box', 'a1', {
				kind: 'update-tab',
				tabId: 't1',
				patch: { readOnly: true },
			});
			expect(answer).toMatchObject({ ok: false });
			expect(answer && !answer.ok ? answer.code : 'none').toBeUndefined();
		});

		it('answers null without the federation API', async () => {
			delete maestro.federation;
			expect(
				await callMirroredAgentAction('box', 'a1', { kind: 'update-agent', patch: { name: 'x' } })
			).toBeNull();
		});
	});
});
