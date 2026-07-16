// Notify-toast command - show a toast notification in the Maestro desktop app.

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import {
	isNotificationTimeoutWithinLimit,
	NOTIFICATION_COLORS,
	parseNotificationTimeout,
	resolveNotificationColor,
} from '../../shared/notification';

interface NotifyToastOptions {
	color?: string;
	timeout?: string;
	dismissible?: boolean;
	agent?: string;
	sourceAgent?: string;
	tab?: string;
	actionUrl?: string;
	actionLabel?: string;
	openFile?: string;
	openUrl?: string;
	json?: boolean;
}

/** Toasts are corner notifications, so the cap is more generous than Center Flash. */
const MAX_TIMEOUT_SECONDS = 60;

export async function notifyToast(
	title: string,
	message: string,
	options: NotifyToastOptions
): Promise<void> {
	if (!title.trim()) {
		console.error('Error: title cannot be empty');
		process.exit(1);
	}

	const colorResolution = resolveNotificationColor(options.color?.toLowerCase(), undefined);
	if (!colorResolution.ok) {
		console.error(`Error: --color must be one of: ${NOTIFICATION_COLORS.join(', ')}`);
		process.exit(1);
		return;
	}
	const color = colorResolution.color;

	const dismissible = options.dismissible === true;

	let duration: number | undefined;
	if (options.timeout !== undefined) {
		if (dismissible) {
			console.error(
				'Error: --dismissible cannot be combined with --timeout (a sticky toast has no auto-dismiss)'
			);
			process.exit(1);
		}

		const seconds = parseNotificationTimeout(options.timeout);
		if (seconds === null || seconds === undefined) {
			console.error(
				'Error: --timeout must be a positive number of seconds (use --dismissible for sticky toasts)'
			);
			process.exit(1);
		}
		if (!isNotificationTimeoutWithinLimit(seconds, MAX_TIMEOUT_SECONDS)) {
			console.error(
				`Error: --timeout cannot exceed ${MAX_TIMEOUT_SECONDS} seconds (use --dismissible to make the toast sticky)`
			);
			process.exit(1);
		}
		// Renderer's notificationStore treats `toast.duration` as already-in-ms,
		// so convert from seconds before sending across the IPC bridge.
		duration = Math.round(seconds * 1000);
	}

	let sessionId: string | undefined;
	if (options.agent) {
		try {
			sessionId = resolveAgentId(options.agent);
		} catch (error) {
			console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
	}

	const sourceAgent =
		options.sourceAgent && options.sourceAgent.trim().length > 0
			? options.sourceAgent.trim()
			: undefined;

	const tabId = options.tab && options.tab.length > 0 ? options.tab : undefined;
	if (tabId && !sessionId) {
		console.error('Error: --tab requires --agent (a tab is scoped to an agent)');
		process.exit(1);
	}

	const actionUrl =
		options.actionUrl && options.actionUrl.length > 0 ? options.actionUrl : undefined;
	const actionLabel =
		options.actionLabel && options.actionLabel.length > 0 ? options.actionLabel : undefined;
	if (actionLabel && !actionUrl) {
		console.error('Error: --action-label requires --action-url');
		process.exit(1);
	}

	// Build the clickAction (data-driven click intent that survives the IPC
	// bridge). At most one of --open-file / --open-url can be set; both fall
	// back to the simpler --agent jump-session behavior when omitted.
	let clickAction:
		| { kind: 'jump-session'; sessionId: string; tabId?: string }
		| { kind: 'open-file'; sessionId: string; path: string }
		| { kind: 'open-url'; url: string }
		| undefined;
	const openFile = options.openFile && options.openFile.length > 0 ? options.openFile : undefined;
	const openUrl = options.openUrl && options.openUrl.length > 0 ? options.openUrl : undefined;
	if (openFile && openUrl) {
		console.error('Error: --open-file and --open-url are mutually exclusive');
		process.exit(1);
	}
	if (openFile) {
		if (!sessionId) {
			console.error('Error: --open-file requires --agent (file preview is scoped to an agent)');
			process.exit(1);
		}
		clickAction = { kind: 'open-file', sessionId, path: openFile };
	} else if (openUrl) {
		clickAction = { kind: 'open-url', url: openUrl };
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{
					type: 'notify_toast',
					title,
					message,
					color,
					duration,
					dismissible,
					sessionId,
					sourceAgent,
					tabId,
					actionUrl,
					actionLabel,
					clickAction,
				},
				'notify_toast_result'
			);
		});

		if (result.success) {
			if (options.json) {
				console.log(JSON.stringify({ success: true, color, dismissible }));
			} else {
				console.log(dismissible ? 'Toast sent (sticky - click to dismiss)' : 'Toast sent');
			}
		} else {
			const errMsg = result.error || 'Failed to send toast';
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
