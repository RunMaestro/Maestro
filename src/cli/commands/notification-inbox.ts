/** CLI access to the live desktop notification center; never reads a separate history copy. */
import { withMaestroClient } from '../services/maestro-client';
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
		const result = await withMaestroClient((client) =>
			client.sendCommand<NotificationInboxResult>(
				{ type: 'notification_inbox', ...request },
				'notification_inbox_result'
			)
		);
		if (options.json) console.log(JSON.stringify(result));
		else if (!result.success) console.error(`Error: ${result.error}`);
		else {
			console.log(
				`Notification center ${result.open ? 'open' : 'closed'}; ${result.unreadCount} unread.`
			);
			for (const entry of result.notifications ?? [])
				console.log(
					`${entry.id} [${entry.read ? 'read' : 'unread'}] ${entry.title}: ${entry.message}`
				);
		}
		if (!result.success) process.exit(1);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (options.json) console.log(JSON.stringify({ success: false, error: message }));
		else console.error(`Error: ${message}`);
		process.exit(1);
	}
}
