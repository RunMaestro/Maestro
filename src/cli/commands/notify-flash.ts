// Notify-flash command - show a center-screen flash in the Maestro desktop app.

import { withMaestroClient } from '../services/maestro-client';
import {
	isNotificationTimeoutWithinLimit,
	NOTIFICATION_COLORS,
	parseNotificationTimeout,
	resolveNotificationColor,
} from '../../shared/notification';

interface NotifyFlashOptions {
	color?: string;
	detail?: string;
	timeout?: string;
	json?: boolean;
}

/** Hard cap for CLI-triggered flashes - keep external notifications brief. */
const MAX_TIMEOUT_SECONDS = 5;

export async function notifyFlash(message: string, options: NotifyFlashOptions): Promise<void> {
	if (!message.trim()) {
		console.error('Error: message cannot be empty');
		process.exit(1);
	}

	const colorResolution = resolveNotificationColor(options.color?.toLowerCase(), undefined);
	if (!colorResolution.ok) {
		console.error(`Error: --color must be one of: ${NOTIFICATION_COLORS.join(', ')}`);
		process.exit(1);
		return;
	}
	const color = colorResolution.color;

	// `duration` is sent to the desktop in ms. CLI-triggered flashes are capped at
	// 5 s so external scripts can't stick a permanent overlay on the user.
	let duration: number | undefined;
	if (options.timeout !== undefined) {
		const seconds = parseNotificationTimeout(options.timeout);
		if (seconds === null || seconds === undefined) {
			console.error('Error: --timeout must be a positive number of seconds');
			process.exit(1);
		}
		if (!isNotificationTimeoutWithinLimit(seconds, MAX_TIMEOUT_SECONDS)) {
			console.error(`Error: --timeout cannot exceed ${MAX_TIMEOUT_SECONDS} seconds`);
			process.exit(1);
		}
		duration = Math.round(seconds * 1000);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{
					type: 'notify_center_flash',
					message,
					detail: options.detail,
					color,
					duration,
				},
				'notify_center_flash_result'
			);
		});

		if (result.success) {
			if (options.json) {
				console.log(JSON.stringify({ success: true, color }));
			} else {
				console.log('Flash sent');
			}
		} else {
			const errMsg = result.error || 'Failed to send flash';
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: errMsg }));
			} else {
				console.error(`Error: ${errMsg}`);
			}
			process.exit(1);
		}
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: errMsg }));
		} else {
			console.error(`Error: ${errMsg}`);
		}
		process.exit(1);
	}
}
