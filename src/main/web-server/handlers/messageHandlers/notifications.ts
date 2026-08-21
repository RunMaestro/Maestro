/**
 * Notifications domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: notify_toast, notify_center_flash.
 */

import type {
	NotifyToastClickAction,
	NotifyToastKind,
	NotifyToastColor,
	NotifyCenterFlashColor,
	NotifyCenterFlashVariant,
} from '../../types';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/** Canonical Toast / Center Flash color set (shared design language). */
const NOTIFY_COLORS: readonly NotifyCenterFlashColor[] = [
	'green',
	'yellow',
	'orange',
	'red',
	'theme',
];
const NOTIFY_FLASH_COLORS = NOTIFY_COLORS;
const NOTIFY_TOAST_COLORS = NOTIFY_COLORS;

const NOTIFY_TOAST_KINDS: readonly NotifyToastKind[] = ['success', 'info', 'warning', 'error'];

/**
 * Legacy variant/type → color mapping. Lets older CLI scripts keep working
 * while we transition external integrations to `--color`.
 */
const VARIANT_TO_COLOR: Record<NotifyCenterFlashVariant, NotifyCenterFlashColor> = {
	success: 'green',
	info: 'theme',
	warning: 'yellow',
	error: 'red',
};

/**
 * Hard upper bound on flash duration for **externally-triggered** flashes
 * (CLI / web). The renderer-side `notifyCenterFlash` itself is uncapped so
 * internal in-app callers can still use longer durations if ever needed -
 * the cap lives at the IPC boundary so external scripts can't stick a
 * permanent overlay on the user.
 */
const EXTERNAL_FLASH_MAX_DURATION_MS = 5000;

/**
 * Hard upper bound on toast duration (seconds) for externally-triggered
 * toasts. Toasts are corner notifications so the cap is more generous than
 * Center Flash, but `0` (never auto-dismiss) is rejected - external scripts
 * that want a sticky toast must opt in explicitly via `dismissible: true`.
 */
const EXTERNAL_TOAST_MAX_DURATION_SECONDS = 60;

/**
 * Handle notify_toast - show a toast notification in the desktop app.
 */
export function handleNotifyToast(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const title = typeof message.title === 'string' ? message.title : '';
	const body = typeof message.message === 'string' ? message.message : '';
	const rawColor = typeof message.color === 'string' ? message.color : undefined;
	// Legacy field (kept for back-compat with older CLI scripts).
	const rawType = typeof message.toastType === 'string' ? message.toastType : undefined;
	const duration = typeof message.duration === 'number' ? message.duration : undefined;
	const dismissible = message.dismissible === true;
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
	const sourceAgent =
		typeof message.sourceAgent === 'string' && message.sourceAgent.length > 0
			? message.sourceAgent
			: undefined;
	const tabId = typeof message.tabId === 'string' ? message.tabId : undefined;
	const actionUrl = typeof message.actionUrl === 'string' ? message.actionUrl : undefined;
	const actionLabel = typeof message.actionLabel === 'string' ? message.actionLabel : undefined;
	const rawClickAction =
		typeof message.clickAction === 'object' && message.clickAction !== null
			? (message.clickAction as Record<string, unknown>)
			: undefined;

	const sendResult = (success: boolean, error?: string) => {
		ctx.send(client, {
			type: 'notify_toast_result',
			success,
			error,
			requestId: message.requestId,
		});
	};

	if (!title) {
		sendResult(false, 'Missing title');
		return;
	}

	// Resolve color: explicit `color` wins over deprecated `toastType`. Default `theme`.
	let color: NotifyToastColor;
	if (rawColor !== undefined) {
		if (!NOTIFY_TOAST_COLORS.includes(rawColor as NotifyToastColor)) {
			sendResult(
				false,
				`Invalid toast color: ${rawColor}. Must be one of: ${NOTIFY_TOAST_COLORS.join(', ')}`
			);
			return;
		}
		color = rawColor as NotifyToastColor;
	} else if (rawType !== undefined) {
		if (!NOTIFY_TOAST_KINDS.includes(rawType as NotifyToastKind)) {
			sendResult(false, `Invalid toast type: ${rawType}`);
			return;
		}
		color = VARIANT_TO_COLOR[rawType as NotifyCenterFlashVariant];
	} else {
		color = 'theme';
	}

	// Validate clickAction (data-driven click intent). Each kind has its
	// own required fields; bad shapes are rejected so the CLI surfaces a
	// clear error instead of producing a silent no-op toast.
	let clickAction: NotifyToastClickAction | undefined;
	if (rawClickAction !== undefined) {
		const kind = rawClickAction.kind;
		if (kind === 'jump-session') {
			const id = rawClickAction.sessionId;
			if (typeof id !== 'string' || id.length === 0) {
				sendResult(false, "clickAction kind 'jump-session' requires sessionId");
				return;
			}
			const tab = rawClickAction.tabId;
			clickAction = {
				kind: 'jump-session',
				sessionId: id,
				tabId: typeof tab === 'string' && tab.length > 0 ? tab : undefined,
			};
		} else if (kind === 'open-file') {
			const id = rawClickAction.sessionId;
			const path = rawClickAction.path;
			if (typeof id !== 'string' || id.length === 0) {
				sendResult(false, "clickAction kind 'open-file' requires sessionId");
				return;
			}
			if (typeof path !== 'string' || path.length === 0) {
				sendResult(false, "clickAction kind 'open-file' requires path");
				return;
			}
			clickAction = { kind: 'open-file', sessionId: id, path };
		} else if (kind === 'open-url') {
			const url = rawClickAction.url;
			if (typeof url !== 'string' || url.length === 0) {
				sendResult(false, "clickAction kind 'open-url' requires url");
				return;
			}
			clickAction = { kind: 'open-url', url };
		} else {
			sendResult(
				false,
				`Invalid clickAction kind: ${String(kind)}. Must be one of: jump-session, open-file, open-url`
			);
			return;
		}
	}

	// Duration validation: reject 0 (use --dismissible instead) and cap at 60 s.
	// Skipped entirely when `dismissible: true` (the toast is sticky).
	if (!dismissible && duration !== undefined) {
		if (!Number.isFinite(duration) || duration <= 0) {
			sendResult(
				false,
				'duration must be a positive number of seconds (use dismissible:true for sticky toasts)'
			);
			return;
		}
		if (duration > EXTERNAL_TOAST_MAX_DURATION_SECONDS) {
			sendResult(
				false,
				`duration cannot exceed ${EXTERNAL_TOAST_MAX_DURATION_SECONDS} seconds for externally-triggered toasts (use dismissible:true to make it sticky)`
			);
			return;
		}
	}

	if (!ctx.callbacks.notifyToast) {
		sendResult(false, 'Toast notifications not configured');
		return;
	}

	ctx.callbacks
		.notifyToast({
			title,
			message: body,
			color,
			dismissible,
			duration,
			sessionId,
			sourceAgent,
			tabId,
			actionUrl,
			actionLabel,
			clickAction,
		})
		.then((success) => sendResult(success, success ? undefined : 'Failed to show toast'))
		.catch((error) => sendResult(false, `Failed to show toast: ${error.message}`));
}

/**
 * Handle notify_center_flash - show a center-screen flash in the desktop app.
 */
export function handleNotifyCenterFlash(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const body = typeof message.message === 'string' ? message.message : '';
	const detail = typeof message.detail === 'string' ? message.detail : undefined;
	const rawColor = typeof message.color === 'string' ? message.color : undefined;
	const rawVariant = typeof message.variant === 'string' ? message.variant : undefined;
	const duration = typeof message.duration === 'number' ? message.duration : undefined;

	const sendResult = (success: boolean, error?: string) => {
		ctx.send(client, {
			type: 'notify_center_flash_result',
			success,
			error,
			requestId: message.requestId,
		});
	};

	if (!body) {
		sendResult(false, 'Missing message');
		return;
	}

	// Resolve color: explicit `color` wins over deprecated `variant`. Default `theme`.
	let color: NotifyCenterFlashColor;
	if (rawColor !== undefined) {
		if (!NOTIFY_FLASH_COLORS.includes(rawColor as NotifyCenterFlashColor)) {
			sendResult(
				false,
				`Invalid flash color: ${rawColor}. Must be one of: ${NOTIFY_FLASH_COLORS.join(', ')}`
			);
			return;
		}
		color = rawColor as NotifyCenterFlashColor;
	} else if (rawVariant !== undefined) {
		if (!(rawVariant in VARIANT_TO_COLOR)) {
			sendResult(false, `Invalid flash variant: ${rawVariant}`);
			return;
		}
		color = VARIANT_TO_COLOR[rawVariant as NotifyCenterFlashVariant];
	} else {
		color = 'theme';
	}

	// External flashes must be (0, 5000 ms] - `0` (never auto-dismiss) is rejected so
	// external scripts can't stick a permanent overlay on the user. In-app callers
	// using `notifyCenterFlash()` directly are not capped.
	if (duration !== undefined) {
		if (!Number.isFinite(duration) || duration <= 0) {
			sendResult(false, 'duration must be a positive number of milliseconds');
			return;
		}
		if (duration > EXTERNAL_FLASH_MAX_DURATION_MS) {
			sendResult(
				false,
				`duration cannot exceed ${EXTERNAL_FLASH_MAX_DURATION_MS} ms for externally-triggered flashes`
			);
			return;
		}
	}

	if (!ctx.callbacks.notifyCenterFlash) {
		sendResult(false, 'Center flash not configured');
		return;
	}

	ctx.callbacks
		.notifyCenterFlash({ message: body, detail, color, duration })
		.then((success) => sendResult(success, success ? undefined : 'Failed to show flash'))
		.catch((error) => sendResult(false, `Failed to show flash: ${error.message}`));
}
