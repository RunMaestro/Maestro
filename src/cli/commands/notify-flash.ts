// Notify-flash command — show a center-screen flash in the Maestro desktop app.

import { withMaestroClient } from '../services/maestro-client';

interface NotifyFlashOptions {
	variant?: string;
	detail?: string;
	duration?: string;
	json?: boolean;
}

const ALLOWED_VARIANTS = ['success', 'info', 'warning', 'error'] as const;

export async function notifyFlash(message: string, options: NotifyFlashOptions): Promise<void> {
	const variant = (options.variant || 'success').toLowerCase();
	if (!ALLOWED_VARIANTS.includes(variant as (typeof ALLOWED_VARIANTS)[number])) {
		console.error(`Error: --variant must be one of: ${ALLOWED_VARIANTS.join(', ')}`);
		process.exit(1);
	}

	let duration: number | undefined;
	if (options.duration !== undefined) {
		const parsed = Number(options.duration);
		if (!Number.isFinite(parsed) || parsed < 0) {
			console.error('Error: --duration must be a non-negative number of milliseconds (0 = never)');
			process.exit(1);
		}
		duration = parsed;
	}

	if (!message.trim()) {
		console.error('Error: message cannot be empty');
		process.exit(1);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{
					type: 'notify_center_flash',
					message,
					detail: options.detail,
					variant,
					duration,
				},
				'notify_center_flash_result'
			);
		});

		if (result.success) {
			if (options.json) {
				console.log(JSON.stringify({ success: true }));
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
