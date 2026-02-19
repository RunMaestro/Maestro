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
 * Can be used outside React via getNotificationState() / getNotificationActions().
 * notifyToast() is callable from anywhere (React components, services, orchestrators).
 */

import { create } from 'zustand';

// ============================================================================
// Types
// ============================================================================

export interface Toast {
	id: string;
	type: 'success' | 'info' | 'warning' | 'error';
	title: string;
	message: string;
	group?: string; // Maestro group name
	project?: string; // Maestro session name (the agent name in Left Bar)
	duration?: number;
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
}

export interface NotificationConfig {
	/** Default toast duration in seconds. 0 = never dismiss, -1 = toasts disabled entirely */
	defaultDuration: number;
	audioFeedbackEnabled: boolean;
	audioFeedbackCommand: string;
	osNotificationsEnabled: boolean;
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
}

export type NotificationStore = NotificationStoreState & NotificationStoreActions;

// ============================================================================
// Selectors
// ============================================================================

export function selectToasts(s: NotificationStoreState): Toast[] {
	return s.toasts;
}

export function selectToastCount(s: NotificationStoreState): number {
	return s.toasts.length;
}

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
}));

// ============================================================================
// notifyToast — public API for firing toasts (handles side effects)
// ============================================================================

let toastIdCounter = 0;

/** Active auto-dismiss timers keyed by toast ID. Cleared on manual removal. */
const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Reset the toast ID counter (for tests). */
export function resetToastIdCounter(): void {
	toastIdCounter = 0;
}

/**
 * Fire a toast notification. Handles:
 * 1. ID generation
 * 2. Duration calculation (seconds → ms)
 * 3. Adding to visible queue (unless toasts disabled)
 * 4. Logging via window.maestro.logger.toast
 * 5. Audio feedback via window.maestro.notification.speak
 * 6. OS notifications via window.maestro.notification.show
 * 7. Auto-dismiss timer
 *
 * Callable from React components and non-React code alike.
 *
 * @returns The generated toast ID
 */
export function notifyToast(toast: Omit<Toast, 'id' | 'timestamp'>): string {
	const store = useNotificationStore.getState();
	const { config } = store;

	const id = `toast-${Date.now()}-${toastIdCounter++}`;
	const toastsDisabled = config.defaultDuration === -1;

	// Convert seconds to ms; use 0 for "never dismiss"
	const durationMs =
		toast.duration !== undefined
			? toast.duration
			: config.defaultDuration > 0
				? config.defaultDuration * 1000
				: 0;

	const newToast: Toast = {
		...toast,
		id,
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
				console.error('[notificationStore] Custom notification failed:', err);
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

			window.maestro.notification.show(notifTitle, notifBody).catch((err) => {
				console.error('[notificationStore] Failed to show OS notification:', err);
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

// ============================================================================
// Non-React access
// ============================================================================

/**
 * Get current notification state snapshot.
 * Use outside React (services, orchestrators, IPC handlers).
 */
export function getNotificationState() {
	return useNotificationStore.getState();
}

/**
 * Get stable notification action references outside React.
 */
export function getNotificationActions() {
	const state = useNotificationStore.getState();
	return {
		addToast: state.addToast,
		removeToast: state.removeToast,
		clearToasts: state.clearToasts,
		setDefaultDuration: state.setDefaultDuration,
		setAudioFeedback: state.setAudioFeedback,
		setOsNotifications: state.setOsNotifications,
	};
}
