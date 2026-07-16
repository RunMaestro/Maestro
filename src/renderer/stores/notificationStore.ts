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
import { isWebDesktop } from '../utils/runtimeContext';
import {
	resolveNotificationColor,
	type NotificationColor,
	type NotificationVariant,
} from '../../shared/notification';

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
export type ToastColor = NotificationColor;

/**
 * Legacy semantic alias read during the persisted-data migration window.
 *   success → green, info → theme, warning → yellow, error → red
 */
export type ToastType = NotificationVariant;

/**
 * Discriminated union for what happens when the toast body is clicked.
 *
 * Externally-fired toasts (e.g. via `maestro-cli notify toast`) cannot pass a
 * function callback over the IPC bridge, so we describe the click intent as
 * data instead. The renderer dispatches based on `kind`:
 *   - jump-session: switch to the agent (and optionally a specific AI tab)
 *   - open-file: switch to the agent and open a file in its File Preview pane
 *   - open-url: open an external URL in the system browser
 */
export type ToastClickAction =
	| { kind: 'jump-session'; sessionId: string; tabId?: string }
	| { kind: 'open-file'; sessionId: string; path: string }
	| { kind: 'open-url'; url: string };

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
	// Skip the OS/device notification for this toast. Set when the toast is
	// itself the fallback for a failed web-desktop notification, so it does not
	// re-enter showOsNotification() and loop.
	skipOsNotification?: boolean;
	// Generic click handler - if set, clicking the toast invokes this callback.
	// Renderer-only - not serializable across the CLI/web bridge.
	onClick?: () => void;
	// Data-driven click intent - preferred for externally-fired toasts since it
	// crosses the IPC boundary. If both `onClick` and `clickAction` are set,
	// `onClick` wins (it can do anything; `clickAction` is the limited subset
	// that survives serialization).
	clickAction?: ToastClickAction;
}

export function resolveToastColor(opts: { color?: string; type?: string }): ToastColor {
	const resolution = resolveNotificationColor(opts.color, opts.type);
	return resolution.ok ? resolution.color : 'theme';
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
	/** Push a fully-formed toast to the visible queue. Internal - callers should use notifyToast(). */
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
	/** Canonical colors and persisted legacy values are normalized on receipt. */
	color?: string;
	/** Legacy alias accepted during the persisted-data migration window. */
	type?: string;
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
	// Legacy `type` field - derive from color for callers that still read it.
	const typeResolution = resolveNotificationColor(undefined, toast.type);
	const legacyType: ToastType =
		typeResolution.ok && toast.type !== undefined
			? (toast.type as ToastType)
			: color === 'green'
				? 'success'
				: color === 'yellow'
					? 'warning'
					: color === 'red'
						? 'error'
						: 'info';

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

	// OS/device notification. `skipOsNotification` guards against the fallback
	// toast (fired by showOsNotification when a web-desktop notification can't be
	// delivered) re-entering this path.
	if (config.osNotificationsEnabled && !toast.skipOsNotification) {
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

		// The visible toast is already on screen, so no fallback toast is needed
		// if a web-desktop notification can't be delivered.
		showOsNotification(notifTitle, notifBody, toast.sessionId, toast.tabId, {
			fallbackToast: false,
		});
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

/** Options for {@link showOsNotification}. */
export interface ShowOsNotificationOptions {
	/**
	 * When a web-desktop notification cannot be delivered (API unavailable or
	 * permission denied), show an in-app toast instead so the user still sees
	 * something. Defaults to true. Pass false from callers that have already
	 * shown a toast (e.g. notifyToast itself) to avoid a duplicate.
	 */
	fallbackToast?: boolean;
}

/**
 * Raise an OS/device notification.
 *
 * Desktop (Electron): forwards to the main process via
 * `window.maestro.notification.show`, which raises a native notification on the
 * host machine. Behavior is unchanged from before this helper existed.
 *
 * Web-desktop (browser build): the same bridge call would raise the
 * notification on the HOST running the web server, not on the browser user's
 * device. So we use the browser-native Web Notifications API instead,
 * requesting permission lazily on first use. If the API is unavailable or the
 * user denied permission, we fall back to an in-app toast (when
 * `fallbackToast` is true) so the user still sees something.
 */
export function showOsNotification(
	title: string,
	body: string,
	sessionId?: string,
	tabId?: string,
	options: ShowOsNotificationOptions = {}
): void {
	if (!isWebDesktop()) {
		// Desktop: unchanged host-notification bridge.
		if (typeof window !== 'undefined' && window.maestro?.notification?.show) {
			window.maestro.notification.show(title, body, sessionId, tabId).catch((err) => {
				logger.error('[notificationStore] Failed to show OS notification:', undefined, err);
			});
		}
		return;
	}

	// Web-desktop: notify the browser's device, not the web server's host.
	// Fire-and-forget; permission requests and delivery happen asynchronously.
	void deliverWebNotification(title, body, sessionId, tabId, options.fallbackToast !== false);
}

/** True when the browser exposes the Web Notifications API. */
function hasWebNotificationApi(): boolean {
	return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Deliver a notification via the browser-native Web Notifications API (used in
 * the web-desktop build). Requests permission lazily on first use. When
 * delivery isn't possible, optionally falls back to an in-app toast.
 */
async function deliverWebNotification(
	title: string,
	body: string,
	sessionId: string | undefined,
	tabId: string | undefined,
	fallbackToast: boolean
): Promise<void> {
	const fallback = () => {
		if (fallbackToast) {
			// skipOsNotification stops the fallback toast from re-entering this path.
			notifyToast({ title, message: body, sessionId, tabId, skipOsNotification: true });
		}
	};

	if (!hasWebNotificationApi()) {
		fallback();
		return;
	}

	try {
		let permission = Notification.permission;
		if (permission === 'default') {
			permission = await Notification.requestPermission();
		}
		if (permission !== 'granted') {
			fallback();
			return;
		}

		const notification = new Notification(title, { body });
		// Focus the browser tab when the notification is clicked.
		notification.onclick = () => {
			if (typeof window !== 'undefined') {
				window.focus();
			}
		};
	} catch (err) {
		logger.error('[notificationStore] Failed to show web notification:', undefined, err);
		fallback();
	}
}
