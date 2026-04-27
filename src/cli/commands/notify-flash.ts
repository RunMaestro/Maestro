// Notify-flash command — show a center-screen flash in the Maestro desktop app.

import { withMaestroClient } from '../services/maestro-client';

interface NotifyFlashOptions {
	color?: string;
	variant?: string;
	detail?: string;
	timeout?: string;
	duration?: string;
	json?: boolean;
}

const ALLOWED_COLORS = ['green', 'yellow', 'orange', 'red', 'theme'] as const;
type AllowedColor = (typeof ALLOWED_COLORS)[number];

const ALLOWED_VARIANTS = ['success', 'info', 'warning', 'error'] as const;
type AllowedVariant = (typeof ALLOWED_VARIANTS)[number];

const VARIANT_TO_COLOR: Record<AllowedVariant, AllowedColor> = {
	success: 'green',
	info: 'theme',
	warning: 'yellow',
	error: 'red',
};

/** Hard cap for CLI-triggered flashes — keep external notifications brief. */
const MAX_TIMEOUT_SECONDS = 5;
const MAX_DURATION_MS = MAX_TIMEOUT_SECONDS * 1000;

export async function notifyFlash(message: string, options: NotifyFlashOptions): Promise<void> {
	if (!message.trim()) {
		console.error('Error: message cannot be empty');
		process.exit(1);
	}

	// Resolve color: explicit `--color` wins; fall back to deprecated `--variant`;
	// default to `theme` so the flash matches the active Maestro theme.
	let color: AllowedColor;
	if (options.color !== undefined) {
		const candidate = options.color.toLowerCase();
		if (!ALLOWED_COLORS.includes(candidate as AllowedColor)) {
			console.error(`Error: --color must be one of: ${ALLOWED_COLORS.join(', ')}`);
			process.exit(1);
		}
		color = candidate as AllowedColor;
	} else if (options.variant !== undefined) {
		const candidate = options.variant.toLowerCase();
		if (!ALLOWED_VARIANTS.includes(candidate as AllowedVariant)) {
			console.error(`Error: --variant must be one of: ${ALLOWED_VARIANTS.join(', ')}`);
			process.exit(1);
		}
		color = VARIANT_TO_COLOR[candidate as AllowedVariant];
	} else {
		color = 'theme';
	}

	// Resolve duration in ms. `--timeout` (seconds, max 5) wins over `--duration` (ms).
	// Both must be in (0, 5000 ms] — CLI-triggered flashes are meant to be brief.
	// "Never auto-dismiss" (duration = 0) is rejected so external scripts can't stick
	// a permanent overlay on the user.
	let duration: number | undefined;
	if (options.timeout !== undefined) {
		const seconds = Number(options.timeout);
		if (!Number.isFinite(seconds) || seconds <= 0) {
			console.error('Error: --timeout must be a positive number of seconds');
			process.exit(1);
		}
		if (seconds > MAX_TIMEOUT_SECONDS) {
			console.error(`Error: --timeout cannot exceed ${MAX_TIMEOUT_SECONDS} seconds`);
			process.exit(1);
		}
		duration = Math.round(seconds * 1000);
	} else if (options.duration !== undefined) {
		const parsed = Number(options.duration);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			console.error('Error: --duration must be a positive number of milliseconds');
			process.exit(1);
		}
		if (parsed > MAX_DURATION_MS) {
			console.error(
				`Error: --duration cannot exceed ${MAX_DURATION_MS} ms (${MAX_TIMEOUT_SECONDS} s); use --timeout for seconds`
			);
			process.exit(1);
		}
		duration = parsed;
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
