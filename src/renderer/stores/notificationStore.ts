/**
 * notificationStore - Zustand store for toast notification state management
 *
 * Consolidates state from ToastContext:
 * - Toast queue (visible toasts array)
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

// ============================================================================
// Types
// ============================================================================

/**
 * Five canonical Toast colors — same design language as Center Flash.
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
	 * Sticky toast — no auto-dismiss timer, requires the user to click the
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
	// Generic click handler — if set, clicking the toast invokes this callback
	onClick?: () => void;
}

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
	config: NotificationConfig;
}

export interface NotificationStoreActions {
	/** Push a fully-formed toast to the visible queue. Internal — callers should use notifyToast(). */
	addToast: (toast: Toast) => void;
	/** Remove a toast by ID. */
	removeToast: (id: string) => void;
	/** Clear all visible toasts. */
	clearToasts: () => void;
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

// ============================================================================
// Store
// ============================================================================

export const useNotificationStore = create<NotificationStore>()((set) => ({
	// --- State ---
	toasts: [],
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
		set({ toasts: [] });
	},

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

// ============================================================================
// notifyToast — public API for firing toasts (handles side effects)
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
 * 4. Adding to visible queue (unless toasts disabled)
 * 5. Logging via window.maestro.logger.toast
 * 6. Audio feedback via window.maestro.notification.speak
 * 7. OS notifications via window.maestro.notification.show
 * 8. Auto-dismiss timer (skipped when dismissible or duration=0)
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
	// Legacy `type` field — derive from color for callers that still read it.
	const legacyType: ToastType =
		toast.type ??
		(color === 'green'
			? 'success'
			: color === 'yellow'
				? 'warning'
				: color === 'red'
					? 'error'
					: 'info');

	// Dismissible toasts have no auto-dismiss — duration is forced to 0.
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
	if (!toastsDisabled) {
		store.addToast(newToast);
	}

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

	// Custom notification command (audio/TTS)
	if (willTriggerCustomNotification) {
		if (typeof window !== 'undefined' && window.maestro?.notification?.speak) {
			window.maestro.notification.speak(toast.message, config.audioFeedbackCommand).catch((err) => {
				logger.error('[notificationStore] Custom notification failed:', undefined, err);
			});
		}
	}

	// OS desktop notification
	if (config.osNotificationsEnabled) {
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
