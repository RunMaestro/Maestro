/**
 * @file groupChatSteering.test.ts
 * @description Tests for src/renderer/services/groupChatSteering.ts - asking main
 * to steer a queued group chat message, and the toast each answer becomes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

import {
	notifyGroupChatSteerResult,
	steerGroupChatQueuedItem,
} from '../../../renderer/services/groupChatSteering';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import type { GroupChatSteerResult } from '../../../shared/groupChatSteering';

const lastToast = () => vi.mocked(notifyToast).mock.calls.at(-1)![0];

describe('notifyGroupChatSteerResult', () => {
	beforeEach(() => {
		vi.mocked(notifyToast).mockClear();
	});

	it('names the turn that took a delivered steer', () => {
		notifyGroupChatSteerResult({ outcome: 'delivered', targets: ['Alice'] });

		expect(lastToast()).toEqual({
			color: 'green',
			title: 'Sent to the running round',
			message: 'Steered to Alice.',
		});
	});

	it('names the turn for a settled steer too', () => {
		notifyGroupChatSteerResult({ outcome: 'settled', verdict: 'absorbed', targets: ['Moderator'] });

		expect(lastToast()).toMatchObject({ color: 'green', message: 'Steered to Moderator.' });
	});

	it('warns, dismissibly, that an unconfirmed steer paused the queue', () => {
		notifyGroupChatSteerResult({ outcome: 'unconfirmed', verdict: 'unknown' });

		expect(lastToast()).toMatchObject({
			color: 'orange',
			title: 'Steering result unconfirmed',
			dismissible: true,
		});
		expect(lastToast().message).toContain('paused');
	});

	it('says a refused message stays queued, with the refusal detail', () => {
		notifyGroupChatSteerResult({ outcome: 'refused', detail: 'A permission prompt is open.' });

		expect(lastToast()).toMatchObject({
			color: 'yellow',
			title: 'Could not steer this round',
			message: 'A permission prompt is open. It stays queued.',
		});
	});

	it('words a refusal with no detail', () => {
		notifyGroupChatSteerResult({ outcome: 'refused' });

		expect(lastToast().message).toBe(
			'The running turn could not take the message right now. It stays queued.'
		);
	});

	it.each<GroupChatSteerResult['outcome']>(['not-steerable', 'unavailable', 'not-found'])(
		'shows the detail for %s, or a default',
		(outcome) => {
			notifyGroupChatSteerResult({ outcome, detail: 'The message is empty.' });
			expect(lastToast()).toMatchObject({ color: 'yellow', message: 'The message is empty.' });

			notifyGroupChatSteerResult({ outcome });
			expect(lastToast().message).toBe('The message stays queued and sends when the round ends.');
		}
	);
});

describe('steerGroupChatQueuedItem', () => {
	beforeEach(() => {
		vi.mocked(notifyToast).mockClear();
	});

	it('asks main to steer the item, toasts the answer, and returns it', async () => {
		const result: GroupChatSteerResult = { outcome: 'delivered', targets: ['Moderator'] };
		const queueSteer = vi.fn().mockResolvedValue(result);
		(window.maestro as any).groupChat = { ...(window.maestro as any).groupChat, queueSteer };

		await expect(steerGroupChatQueuedItem('gc-1', 'item-1')).resolves.toBe(result);

		expect(queueSteer).toHaveBeenCalledWith('gc-1', 'item-1');
		expect(notifyToast).toHaveBeenCalledTimes(1);
		expect(lastToast().message).toBe('Steered to Moderator.');
	});
});
