// Notify-toast command - show a toast notification in the Maestro desktop app.

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import type { ToastClickAction } from '../../shared/toastClickAction';

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
	openTerminal?: string | boolean;
	openBrowser?: string;
	openBrowserTab?: string;
	json?: boolean;
}

const ALLOWED_COLORS = ['green', 'yellow', 'orange', 'red', 'theme'] as const;
type AllowedColor = (typeof ALLOWED_COLORS)[number];

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

	let color: AllowedColor;
	if (options.color !== undefined) {
		const candidate = options.color.toLowerCase();
		if (!ALLOWED_COLORS.includes(candidate as AllowedColor)) {
			console.error(`Error: --color must be one of: ${ALLOWED_COLORS.join(', ')}`);
			process.exit(1);
		}
		color = candidate as AllowedColor;
	} else {
		color = 'theme';
	}

	const dismissible = options.dismissible === true;

	let duration: number | undefined;
	if (options.timeout !== undefined) {
		if (dismissible) {
			console.error(
				'Error: --dismissible cannot be combined with --timeout (a sticky toast has no auto-dismiss)'
			);
			process.exit(1);
		}

		const seconds = Number(options.timeout);
		if (!Number.isFinite(seconds) || seconds <= 0) {
			console.error(
				'Error: --timeout must be a positive number of seconds (use --dismissible for sticky toasts)'
			);
			process.exit(1);
		}
		if (seconds > MAX_TIMEOUT_SECONDS) {
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
	// bridge). The --open-* flags are mutually exclusive; with none of them set
	// the toast falls back to the simpler --agent jump-session behavior.
	let clickAction: ToastClickAction | undefined;
	const openFile = options.openFile && options.openFile.length > 0 ? options.openFile : undefined;
	const openUrl = options.openUrl && options.openUrl.length > 0 ? options.openUrl : undefined;
	// `--open-terminal` takes an optional tab ref: bare means "the agent's active
	// terminal tab, or its only one", matching `send-terminal`'s --tab resolution.
	const openTerminal =
		options.openTerminal === undefined
			? undefined
			: typeof options.openTerminal === 'string' && options.openTerminal.length > 0
				? options.openTerminal
				: '';
	const openBrowser =
		options.openBrowser && options.openBrowser.length > 0 ? options.openBrowser : undefined;
	const openBrowserTab =
		options.openBrowserTab && options.openBrowserTab.length > 0
			? options.openBrowserTab
			: undefined;

	const chosen = [
		openFile !== undefined && '--open-file',
		openUrl !== undefined && '--open-url',
		openTerminal !== undefined && '--open-terminal',
		openBrowser !== undefined && '--open-browser',
		openBrowserTab !== undefined && '--open-browser-tab',
	].filter((flag): flag is string => typeof flag === 'string');
	if (chosen.length > 1) {
		console.error(`Error: ${chosen.join(', ')} are mutually exclusive`);
		process.exit(1);
	}

	if (openFile) {
		if (!sessionId) {
			console.error('Error: --open-file requires --agent (file preview is scoped to an agent)');
			process.exit(1);
		}
		clickAction = { kind: 'open-file', sessionId, path: openFile };
	} else if (openTerminal !== undefined) {
		if (!sessionId) {
			console.error(
				'Error: --open-terminal requires --agent (a terminal tab is scoped to an agent)'
			);
			process.exit(1);
		}
		clickAction = {
			kind: 'open-terminal',
			sessionId,
			tabRef: openTerminal.length > 0 ? openTerminal : undefined,
		};
	} else if (openBrowser || openBrowserTab) {
		if (!sessionId) {
			const flag = openBrowser ? '--open-browser' : '--open-browser-tab';
			console.error(`Error: ${flag} requires --agent (a browser tab is scoped to an agent)`);
			process.exit(1);
		}
		// A tab id (what `open-browser` hands back) focuses that tab; a URL opens
		// a new in-app browser tab. Kept as two flags so neither has to be guessed
		// from the value's shape.
		clickAction = { kind: 'open-browser', sessionId, url: openBrowser, tabId: openBrowserTab };
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
