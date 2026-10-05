/**
 * notificationStore - Zustand store for toast notification state management
 *
 * Consolidates state from ToastContext:
 * - Toast queue (visible toasts array)
 * - Notification history (every toast, kept after it leaves the screen, with
 *   read state - what the header's notification center lists)
 * - Notification config (audio feedback, OS notifications, default duration)
 *
 * Side effects (logging, audio TTS, OS notifications, auto-dismiss timers)
 * live in the notifyToast() wrapper function, not in the store itself.
 *
 * Can be used outside React via useNotificationStore.getState().
 * notifyToast() is callable from anywhere (React components, services, orchestrators).
 */

import { create } from 'zustand';
import { logger } from '../utils/logger';
import { parseToastClickAction, type ToastClickAction } from '../../shared/toastClickAction';

// ============================================================================
// Types
// ============================================================================

/**
 * Five canonical Toast colors - same design language as Center Flash.
 * `theme` adapts to the active Maestro theme.
 *
 *   green  - succeeded
 *   yellow - heads-up / soft warning
 *   orange - more emphatic warning
 *   red    - failed / blocked
 *   theme  - default; matches the active theme's accent color (no semantic)
 */
export type ToastColor = 'green' | 'yellow' | 'orange' | 'red' | 'theme';

/**
 * @deprecated Legacy semantic alias. Prefer `ToastColor` via `color`.
 *   success → green, info → theme, warning → yellow, error → red
 */
export type ToastType = 'success' | 'info' | 'warning' | 'error';

const TOAST_TYPE_TO_COLOR: Record<ToastType, ToastColor> = {
	success: 'green',
	info: 'theme',
	warning: 'yellow',
	error: 'red',
};

/**
 * What happens when the toast body is clicked, as data rather than a callback,
 * so externally-fired toasts (`maestro-cli notify toast`, Cue, the web bridge)
 * can carry one across the IPC boundary. The canonical shape and its validator
 * live in `shared/toastClickAction.ts`; the renderer dispatches it through
 * `services/toastClickActions.ts`.
 */
export type { ToastClickAction };

export interface Toast {
	id: string;
	/** Resolved color used for icon, accent, and progress bar. */
	color: ToastColor;
	/**
	 * @deprecated kept on the rendered Toast for back-compat with consumers
	 * (e.g. ToastContainer renders both fields). New code should read `color`.
	 */
	type: ToastType;
	title: string;
	message: string;
	group?: string; // Maestro group name
	project?: string; // Maestro session name (the agent name in Left Bar)
	/**
	 * Auto-dismiss in ms. 0 = no auto-dismiss (sticky). Ignored when
	 * `dismissible: true`, which forces no auto-dismiss.
	 */
	duration?: number;
	/**
	 * Sticky toast - no auto-dismiss timer, requires the user to click the
	 * close button (or the toast itself, if it has session navigation) to
	 * dismiss. Use for critical messages the user must see.
	 */
	dismissible?: boolean;
	taskDuration?: number; // How long the task took in ms
	agentSessionId?: string; // Claude Code session UUID for traceability
	tabName?: string; // Tab name or short UUID for display
	timestamp: number;
	// Session navigation - allows clicking toast to jump to session
	sessionId?: string; // Maestro session ID for navigation
	tabId?: string; // Tab ID within the session for navigation
	// Action link - clickable URL shown below message (e.g., PR URL)
	actionUrl?: string; // URL to open when clicked
	actionLabel?: string; // Label for the action link (defaults to URL)
	// Skip custom notification command for this toast (used for synopsis messages)
	skipCustomNotification?: boolean;
	// Skip the OS desktop notification for this toast. Use for in-app-only
	// feedback (e.g. the Settings preview of the toast width) that would be
	// noise in Notification Center.
	skipOsNotification?: boolean;
	// Keep this toast out of the notification center's history. Use for UI
	// previews that report nothing the user could want to come back to.
	skipHistory?: boolean;
	/** Record in the inbox without a popup, OS notification, custom command, or timer. */
	historyOnly?: boolean;
	// Generic click handler - if set, clicking the toast invokes this callback.
	// Renderer-only - not serializable across the CLI/web bridge.
	onClick?: () => void;
	// Data-driven click intent - preferred for externally-fired toasts since it
	// crosses the IPC boundary. If both `onClick` and `clickAction` are set,
	// `onClick` wins (it can do anything; `clickAction` is the limited subset
	// that survives serialization).
	clickAction?: ToastClickAction;
}

/**
 * A toast as the notification center remembers it. Same shape, plus whether
 * the user has dealt with it. `onClick` survives only until the next reload
 * (a callback cannot be serialized); `clickAction` and `sessionId` are what a
 * restored entry can still act on.
 */
export interface NotificationRecord extends Toast {
	read: boolean;
}

/** Newest entries kept. Older ones fall off the end, read or not. */
export const NOTIFICATION_HISTORY_LIMIT = 200;

export const NOTIFICATION_HISTORY_STORAGE_KEY = 'maestro.notificationHistory';

/** `localStorage`, or null where there isn't one (storage-blocked renderer, tests). */
function historyStorage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** Validate persisted display fields and every optional action before replay. */
function isNotificationRecord(value: unknown): value is NotificationRecord {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === 'string' &&
		typeof v.title === 'string' &&
		typeof v.message === 'string' &&
		typeof v.timestamp === 'number' &&
		Number.isFinite(v.timestamp) &&
		['green', 'yellow', 'orange', 'red', 'theme'].includes(v.color as string) &&
		['success', 'info', 'warning', 'error'].includes(v.type as string) &&
		['sessionId', 'tabId', 'actionUrl', 'actionLabel', 'group', 'project', 'tabName'].every(
			(key) => v[key] === undefined || typeof v[key] === 'string'
		) &&
		v.onClick === undefined &&
		!parseToastClickAction(v.clickAction).error &&
		typeof v.read === 'boolean'
	);
}

/** Read the persisted history. Anything unreadable is dropped, never thrown. */
export function loadNotificationHistory(): NotificationRecord[] {
	try {
		const raw = historyStorage()?.getItem(NOTIFICATION_HISTORY_STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(isNotificationRecord)
			.slice(0, NOTIFICATION_HISTORY_LIMIT)
			.map((record) => ({
				...record,
				clickAction: parseToastClickAction(record.clickAction).action,
			}));
	} catch {
		return [];
	}
}

/** Persist history without allowing storage failures to break notification delivery. */
function saveNotificationHistory(history: NotificationRecord[]): boolean {
	try {
		// JSON.stringify drops `onClick` on its own: functions are not serialized.
		const storage = historyStorage();
		if (!storage) return false;
		storage.setItem(NOTIFICATION_HISTORY_STORAGE_KEY, JSON.stringify(history));
		return true;
	} catch {
		// Keep the inbox available, but report that its changes are not durable.
		return false;
	}
}

/** Prefer a canonical color, falling back to legacy semantic aliases. */
export function resolveToastColor(opts: { color?: ToastColor; type?: ToastType }): ToastColor {
	if (opts.color) return opts.color;
	if (opts.type) return TOAST_TYPE_TO_COLOR[opts.type];
	return 'theme';
}

export interface NotificationConfig {
	/** Default toast duration in seconds. 0 = never dismiss, -1 = toasts disabled entirely */
	defaultDuration: number;
	audioFeedbackEnabled: boolean;
	audioFeedbackCommand: string;
	osNotificationsEnabled: boolean;
	idleNotificationEnabled: boolean;
	idleNotificationCommand: string;
}

// ============================================================================
// Store interface
// ============================================================================

export interface NotificationStoreState {
	toasts: Toast[];
	/** Every recorded notification, newest first, capped at NOTIFICATION_HISTORY_LIMIT. */
	history: NotificationRecord[];
	/** Whether the header's notification center popover is open. */
	notificationCenterOpen: boolean;
	notificationCenterExpandedId: string | null;
	/** True when the latest history change could not be persisted. */
	historyPersistenceFailed: boolean;
	config: NotificationConfig;
}

export interface NotificationStoreActions {
	/** Push a fully-formed toast to the visible queue. Internal - callers should use notifyToast(). */
	addToast: (toast: Toast) => void;
	/** Remove a toast by ID. */
	removeToast: (id: string) => void;
	/** Clear all visible toasts. */
	clearToasts: () => void;
	/** Add a toast to the history as unread. Internal - notifyToast() calls this. */
	recordNotification: (toast: Toast) => void;
	/** Mark one history entry read. */
	markNotificationRead: (id: string) => void;
	/** Mark every history entry read. */
	markAllNotificationsRead: () => void;
	/** Empty the history. Toasts still on screen are left alone. */
	clearNotificationHistory: () => void;
	setNotificationCenterOpen: (open: boolean) => void;
	setNotificationCenterExpandedId: (id: string | null) => void;
	/** Update default duration (seconds). */
	setDefaultDuration: (duration: number) => void;
	/** Configure audio feedback (TTS). */
	setAudioFeedback: (enabled: boolean, command: string) => void;
	/** Configure OS desktop notifications. */
	setOsNotifications: (enabled: boolean) => void;
	/** Configure idle notification (fires when all agents/batches stop). */
	setIdleNotification: (enabled: boolean, command: string) => void;
}

export type NotificationStore = NotificationStoreState & NotificationStoreActions;

// ============================================================================
// Selectors
// ============================================================================

export function selectConfig(s: NotificationStoreState): NotificationConfig {
	return s.config;
}

/** Count unread entries without allocating a filtered history array. */
export function selectUnreadNotificationCount(s: NotificationStoreState): number {
	let count = 0;
	for (const record of s.history) {
		if (!record.read) count++;
	}
	return count;
}

// ============================================================================
// Store
// ============================================================================

export const useNotificationStore = create<NotificationStore>()((set) => ({
	// --- State ---
	toasts: [],
	history: loadNotificationHistory(),
	notificationCenterOpen: false,
	notificationCenterExpandedId: null,
	historyPersistenceFailed: false,
	config: {
		defaultDuration: 20,
		audioFeedbackEnabled: false,
		audioFeedbackCommand: '',
		osNotificationsEnabled: true,
		idleNotificationEnabled: false,
		idleNotificationCommand: '',
	},

	// --- Toast CRUD ---
	addToast: (toast) => set((s) => ({ toasts: [...s.toasts, toast] })),

	removeToast: (id) => {
		const timerId = autoDismissTimers.get(id);
		if (timerId) {
			clearTimeout(timerId);
			autoDismissTimers.delete(id);
		}
		set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
	},

	clearToasts: () => {
		for (const timerId of autoDismissTimers.values()) {
			clearTimeout(timerId);
		}
		autoDismissTimers.clear();
		set((s) => {
			const dismissed = new Set(s.toasts.map((t) => t.id));
			return {
				toasts: [],
				history: s.history.map((n) => (dismissed.has(n.id) && !n.read ? { ...n, read: true } : n)),
			};
		});
	},

	// --- Notification history ---
	recordNotification: (toast) =>
		set((s) => ({
			history: [{ ...toast, read: false }, ...s.history].slice(0, NOTIFICATION_HISTORY_LIMIT),
		})),

	markNotificationRead: (id) =>
		set((s) => {
			// Same array back when nothing changes, so subscribers and the
			// persistence write below are skipped.
			if (!s.history.some((n) => n.id === id && !n.read)) return s;
			return { history: s.history.map((n) => (n.id === id ? { ...n, read: true } : n)) };
		}),

	markAllNotificationsRead: () =>
		set((s) => {
			if (!s.history.some((n) => !n.read)) return s;
			return { history: s.history.map((n) => (n.read ? n : { ...n, read: true })) };
		}),

	// A fresh array retries persistence even after a failed clear already emptied the inbox.
	clearNotificationHistory: () => set({ history: [], notificationCenterExpandedId: null }),

	setNotificationCenterOpen: (open) =>
		set({ notificationCenterOpen: open, ...(!open ? { notificationCenterExpandedId: null } : {}) }),
	setNotificationCenterExpandedId: (id) => set({ notificationCenterExpandedId: id }),

	// --- Configuration ---
	setDefaultDuration: (duration) =>
		set((s) => ({ config: { ...s.config, defaultDuration: duration } })),

	setAudioFeedback: (enabled, command) =>
		set((s) => ({
			config: { ...s.config, audioFeedbackEnabled: enabled, audioFeedbackCommand: command },
		})),

	setOsNotifications: (enabled) =>
		set((s) => ({ config: { ...s.config, osNotificationsEnabled: enabled } })),

	setIdleNotification: (enabled, command) =>
		set((s) => ({
			config: { ...s.config, idleNotificationEnabled: enabled, idleNotificationCommand: command },
		})),
}));

useNotificationStore.subscribe((state, prev) => {
	if (state.history !== prev.history) {
		const historyPersistenceFailed = !saveNotificationHistory(state.history);
		if (historyPersistenceFailed !== state.historyPersistenceFailed) {
			useNotificationStore.setState({ historyPersistenceFailed });
		}
	}
});

// ============================================================================
// notifyToast - public API for firing toasts (handles side effects)
// ============================================================================

let toastIdCounter = 0;

/** Active auto-dismiss timers keyed by toast ID. Cleared on manual removal. */
const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Public input shape for `notifyToast()`. `color` is preferred over the
 * legacy `type` (kept for back-compat). `dismissible: true` overrides any
 * `duration` and forces the toast to stay until clicked.
 */
export type NotifyToastInput = Omit<Toast, 'id' | 'timestamp' | 'color' | 'type'> & {
	color?: ToastColor;
	/** @deprecated Use `color`. */
	type?: ToastType;
};

/**
 * Fire a toast notification. Handles:
 * 1. ID generation
 * 2. Color resolution (color > legacy type > 'theme')
 * 3. Duration calculation (seconds → ms; sticky when dismissible)
 * 4. Adding to visible queue (unless toasts disabled) and to the notification
 *    history (always, unless `skipHistory` - with toasts disabled the history is
 *    the only place the notification shows up)
 * 5. Logging via window.maestro.logger.toast
 * 6. Audio feedback via window.maestro.notification.speak
 * 7. OS notifications via window.maestro.notification.show
 * 8. Auto-dismiss timer (skipped when dismissible or duration=0)
 *
 * `historyOnly` records without delivering a popup, audio command, OS notification,
 * or auto-dismiss timer. Callers preserve any existing audio policy separately.
 *
 * Callable from React components and non-React code alike.
 *
 * @returns The generated toast ID
 */
export function notifyToast(toast: NotifyToastInput): string {
	const store = useNotificationStore.getState();
	const { config } = store;

	const id = `toast-${Date.now()}-${toastIdCounter++}`;
	const toastsDisabled = config.defaultDuration === -1;

	const color = resolveToastColor(toast);
	// Legacy `type` field - derive from color for callers that still read it.
	const legacyType: ToastType =
		toast.type ??
		(color === 'green'
			? 'success'
			: color === 'yellow'
				? 'warning'
				: color === 'red'
					? 'error'
					: 'info');

	// Dismissible toasts have no auto-dismiss - duration is forced to 0.
	// Otherwise: explicit duration wins, then config default, then 0.
	const durationMs = toast.dismissible
		? 0
		: toast.duration !== undefined
			? toast.duration
			: config.defaultDuration > 0
				? config.defaultDuration * 1000
				: 0;

	const newToast: Toast = {
		...toast,
		id,
		color,
		type: legacyType,
		timestamp: Date.now(),
		duration: durationMs,
	};

	// Only add to visible toast queue if not disabled
	if (!toastsDisabled && !toast.historyOnly) {
		store.addToast(newToast);
	}

	if (!toast.skipHistory) {
		store.recordNotification(newToast);
	}

	if (toast.historyOnly) return id;

	// --- Side effects ---

	const hasContent = toast.message && toast.message.trim().length > 0;
	const willTriggerCustomNotification =
		config.audioFeedbackEnabled &&
		config.audioFeedbackCommand &&
		!toast.skipCustomNotification &&
		hasContent;

	// Log to system logs
	if (typeof window !== 'undefined' && window.maestro?.logger?.toast) {
		window.maestro.logger.toast(toast.title, {
			type: toast.type,
			message: toast.message,
			group: toast.group,
			project: toast.project,
			taskDuration: toast.taskDuration,
			agentSessionId: toast.agentSessionId,
			tabName: toast.tabName,
			sessionId: toast.sessionId,
			tabId: toast.tabId,
			audioNotification: willTriggerCustomNotification
				? {
						enabled: true,
						command: config.audioFeedbackCommand,
					}
				: {
						enabled: false,
						reason: !config.audioFeedbackEnabled
							? 'disabled'
							: !config.audioFeedbackCommand
								? 'no-command'
								: toast.skipCustomNotification
									? 'opted-out'
									: !hasContent
										? 'no-content'
										: 'unknown',
					},
		});
	}

	// Custom notification command (audio/TTS). The actual enabled/command/content
	// gate lives in triggerCustomNotification so it can be reused by callers that
	// fire audio without a visual toast (e.g. completion while viewing the tab).
	// Forward the agent/tab/group/task context so commands can reference it via
	// MAESTRO_NOTIFY_* env vars (e.g. to name which agent finished). `project` is
	// the Left Bar agent name.
	if (!toast.skipCustomNotification) {
		triggerCustomNotification(toast.message, {
			agent: toast.project,
			tab: toast.tabName,
			group: toast.group,
			task: toast.title,
		});
	}

	// OS desktop notification
	if (config.osNotificationsEnabled && !toast.skipOsNotification) {
		if (typeof window !== 'undefined' && window.maestro?.notification?.show) {
			const notifTitle = toast.project || toast.title;

			const tabLabel =
				toast.tabName || (toast.agentSessionId ? toast.agentSessionId.slice(0, 8) : null);

			// Extract first sentence from message
			const firstSentenceMatch = toast.message.match(/^[^.!?]*[.!?]?/);
			const firstSentence = firstSentenceMatch
				? firstSentenceMatch[0].trim()
				: toast.message.slice(0, 80);

			const bodyParts: string[] = [];
			if (toast.group) {
				bodyParts.push(toast.group);
			}
			if (tabLabel) {
				bodyParts.push(tabLabel);
			}

			const prefix = bodyParts.length > 0 ? `${bodyParts.join(' > ')}: ` : '';
			const notifBody = prefix + firstSentence;

			window.maestro.notification
				.show(notifTitle, notifBody, toast.sessionId, toast.tabId)
				.catch((err) => {
					logger.error('[notificationStore] Failed to show OS notification:', undefined, err);
				});
		}
	}

	// Auto-dismiss timer (tracked so manual removal can cancel it)
	if (!toastsDisabled && durationMs > 0) {
		const timerId = setTimeout(() => {
			autoDismissTimers.delete(id);
			useNotificationStore.getState().removeToast(id);
		}, durationMs);
		autoDismissTimers.set(id, timerId);
	}

	return id;
}

/**
 * Fire the user's custom notification command (audio/TTS) for a message,
 * honoring the audioFeedbackEnabled / audioFeedbackCommand settings and skipping
 * empty content. Single source of truth for the audio gate so it can be invoked
 * both from notifyToast (visual + audio together) and from completion handlers
 * that need the audio cue even when no visual toast is shown.
 *
 * `vars` (optional) carries Maestro context (agent/tab/group/task) that the
 * command receives as MAESTRO_NOTIFY_* env vars.
 *
 * @returns true if a command was dispatched, false if gated out.
 */
export function triggerCustomNotification(
	message: string | undefined,
	vars?: { agent?: string; tab?: string; group?: string; task?: string }
): boolean {
	const { config } = useNotificationStore.getState();
	const hasContent = !!message && message.trim().length > 0;
	const shouldFire = config.audioFeedbackEnabled && !!config.audioFeedbackCommand && hasContent;
	if (!shouldFire) return false;

	if (typeof window !== 'undefined' && window.maestro?.notification?.speak) {
		// Stay 2-arg when no context is provided so callers (and their tests) that
		// don't pass vars are unaffected.
		const dispatched =
			vars === undefined
				? window.maestro.notification.speak(message!, config.audioFeedbackCommand)
				: window.maestro.notification.speak(message!, config.audioFeedbackCommand, vars);
		dispatched.catch((err) => {
			logger.error('[notificationStore] Custom notification failed:', undefined, err);
		});
		return true;
	}
	return false;
}
