/** CLI access to the live desktop notification center; never reads a separate history copy. */
import { sendSimpleCommand, reportResult, failCommand } from '../services/session-command';
import type {
	NotificationInboxRequest,
	NotificationInboxResult,
} from '../../shared/notificationInbox';

/** Send an operation and print its resulting state, including stable IDs for subsequent commands. */
export async function notificationInbox(
	request: NotificationInboxRequest,
	options: { json?: boolean }
): Promise<void> {
	try {
		const result = await sendSimpleCommand<NotificationInboxResult>(
			{ type: 'notification_inbox', ...request },
			'notification_inbox_result'
		);
		reportResult(
			{ ...result },
			{
				json: options.json,
				jsonResult: { ...result },
				successMessage: `Notification center ${result.open ? 'open' : 'closed'}; ${result.unreadCount} unread.`,
			}
		);
		if (result.success && !options.json) {
			for (const entry of result.notifications ?? [])
				console.log(
					`${entry.id} [${entry.read ? 'read' : 'unread'}] ${entry.title}: ${entry.message}`
				);
		}
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}
