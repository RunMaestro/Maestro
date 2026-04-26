// Notify-toast command — show a toast notification in the Maestro desktop app.

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';

interface NotifyToastOptions {
	type?: string;
	duration?: string;
	agent?: string;
	json?: boolean;
}

const ALLOWED_TYPES = ['success', 'info', 'warning', 'error'] as const;

export async function notifyToast(
	title: string,
	message: string,
	options: NotifyToastOptions
): Promise<void> {
	const toastType = (options.type || 'info').toLowerCase();
	if (!ALLOWED_TYPES.includes(toastType as (typeof ALLOWED_TYPES)[number])) {
		console.error(`Error: --type must be one of: ${ALLOWED_TYPES.join(', ')}`);
		process.exit(1);
	}

	let duration: number | undefined;
	if (options.duration !== undefined) {
		const parsed = Number(options.duration);
		if (!Number.isFinite(parsed) || parsed < 0) {
			console.error(
				'Error: --duration must be a non-negative number of seconds (0 = never dismiss)'
			);
			process.exit(1);
		}
		duration = parsed;
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

	if (!title.trim()) {
		console.error('Error: title cannot be empty');
		process.exit(1);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{
					type: 'notify_toast',
					title,
					message,
					toastType,
					duration,
					sessionId,
				},
				'notify_toast_result'
			);
		});

		if (result.success) {
			if (options.json) {
				console.log(JSON.stringify({ success: true }));
			} else {
				console.log('Toast sent');
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
