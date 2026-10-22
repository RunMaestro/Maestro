/**
 * Group chat steering, renderer side: ask main to steer a queued message into
 * the round that is running, and tell the user what happened.
 *
 * Main does the work (src/main/group-chat/group-chat-queue.ts steerQueuedItem):
 * the queue lives there, so the steer has to claim the same send latch the
 * drainer uses. This module only turns the answer into a toast. The transcript
 * marks the message itself when a turn takes it, and the queue updates from
 * main's broadcast.
 */

import type { GroupChatSteerResult } from '../../shared/groupChatSteering';
import { notifyToast } from '../stores/notificationStore';

/** Toast one steer result. Exported for tests. */
export function notifyGroupChatSteerResult(result: GroupChatSteerResult): void {
	switch (result.outcome) {
		case 'delivered':
		case 'settled':
			notifyToast({
				color: 'green',
				title: 'Sent to the running round',
				message: `Steered to ${(result.targets ?? []).join(', ')}.`,
			});
			return;
		case 'unconfirmed':
			notifyToast({
				color: 'orange',
				title: 'Steering result unconfirmed',
				message:
					'The round may or may not have received the message, so the queue is paused rather than sending it twice. Resume it if nobody answered it.',
				dismissible: true,
			});
			return;
		case 'refused':
			notifyToast({
				color: 'yellow',
				title: 'Could not steer this round',
				message: `${result.detail ?? 'The running turn could not take the message right now.'} It stays queued.`,
			});
			return;
		default:
			notifyToast({
				color: 'yellow',
				title: 'Could not steer this round',
				message: result.detail ?? 'The message stays queued and sends when the round ends.',
			});
	}
}

/** Steer one queued message into the running round of `groupChatId`. */
export async function steerGroupChatQueuedItem(
	groupChatId: string,
	itemId: string
): Promise<GroupChatSteerResult> {
	const result = await window.maestro.groupChat.queueSteer(groupChatId, itemId);
	notifyGroupChatSteerResult(result);
	return result;
}
