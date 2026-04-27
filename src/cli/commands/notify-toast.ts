// Notify-toast command — show a toast notification in the Maestro desktop app.

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';

interface NotifyToastOptions {
	color?: string;
	type?: string;
	timeout?: string;
	duration?: string;
	dismissible?: boolean;
	agent?: string;
	json?: boolean;
}

const ALLOWED_COLORS = ['green', 'yellow', 'orange', 'red', 'theme'] as const;
type AllowedColor = (typeof ALLOWED_COLORS)[number];

const ALLOWED_TYPES = ['success', 'info', 'warning', 'error'] as const;
type AllowedType = (typeof ALLOWED_TYPES)[number];

const TYPE_TO_COLOR: Record<AllowedType, AllowedColor> = {
	success: 'green',
	info: 'theme',
	warning: 'yellow',
	error: 'red',
};

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

	// Resolve color: explicit `--color` wins; fall back to deprecated `--type`;
	// default to `theme` so the toast matches the active Maestro theme.
	let color: AllowedColor;
	if (options.color !== undefined) {
		const candidate = options.color.toLowerCase();
		if (!ALLOWED_COLORS.includes(candidate as AllowedColor)) {
			console.error(`Error: --color must be one of: ${ALLOWED_COLORS.join(', ')}`);
			process.exit(1);
		}
		color = candidate as AllowedColor;
	} else if (options.type !== undefined) {
		const candidate = options.type.toLowerCase();
		if (!ALLOWED_TYPES.includes(candidate as AllowedType)) {
			console.error(`Error: --type must be one of: ${ALLOWED_TYPES.join(', ')}`);
			process.exit(1);
		}
		color = TYPE_TO_COLOR[candidate as AllowedType];
	} else {
		color = 'theme';
	}

	// Dismissible toasts skip auto-dismiss entirely; --timeout / --duration cannot
	// be combined with --dismissible (would be contradictory).
	const dismissible = options.dismissible === true;

	let duration: number | undefined;
	if (options.timeout !== undefined || options.duration !== undefined) {
		if (dismissible) {
			console.error(
				'Error: --dismissible cannot be combined with --timeout or --duration (a sticky toast has no auto-dismiss)'
			);
			process.exit(1);
		}

		// `--timeout` (seconds) is preferred. `--duration` (also seconds, legacy) kept for back-compat.
		const rawValue = options.timeout ?? options.duration;
		const flagName = options.timeout !== undefined ? '--timeout' : '--duration';
		const seconds = Number(rawValue);
		if (!Number.isFinite(seconds) || seconds <= 0) {
			console.error(
				`Error: ${flagName} must be a positive number of seconds (use --dismissible for sticky toasts)`
			);
			process.exit(1);
		}
		if (seconds > MAX_TIMEOUT_SECONDS) {
			console.error(
				`Error: ${flagName} cannot exceed ${MAX_TIMEOUT_SECONDS} seconds (use --dismissible to make the toast sticky)`
			);
			process.exit(1);
		}
		duration = seconds;
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
				},
				'notify_toast_result'
			);
		});

		if (result.success) {
			if (options.json) {
				console.log(JSON.stringify({ success: true, color, dismissible }));
			} else {
				console.log(dismissible ? 'Toast sent (sticky — click to dismiss)' : 'Toast sent');
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
