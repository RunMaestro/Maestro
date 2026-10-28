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
import type { TtsrToastMarker } from '../../shared/ttsr-types';
import { logger } from '../utils/logger';
import { isWebDesktop } from '../utils/runtimeContext';
import type { ToastClickAction } from '../../shared/toastClickAction';
import { areToastsEnabled } from '../../shared/toastDuration';
import { safeLocalStorage, safeStorageGet } from '../utils/safeLocalStorage';
import { generateId } from '../utils/ids';
import { useSessionStore } from './sessionStore';
import { getTabDisplayName } from '../utils/tabHelpers';
import {
	NOTIFICATION_HISTORY_LIMIT,
	NOTIFICATION_HISTORY_STORAGE_KEY,
	parseNotificationHistory,
	applyNotificationHistoryChange,
	type ToastData,
	type ToastColor,
	type ToastType,
	type NotificationHistoryChange,
	type NotificationHistorySnapshot,
} from '../../shared/notificationHistory';

// ============================================================================
// Types
// ============================================================================

export type { ToastColor, ToastType } from '../../shared/notificationHistory';

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

export interface Toast extends ToastData {
	/** Renderer-only activation callback. Durable actions use clickAction. */
	onClick?: () => void;
	/** Structured TTSR interrupt outcome, resolved for this client at display time. */
	ttsr?: TtsrToastMarker;
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

export {
	NOTIFICATION_HISTORY_LIMIT,
	NOTIFICATION_HISTORY_STORAGE_KEY,
} from '../../shared/notificationHistory';

/** Read the persisted history. Anything unreadable is dropped, never thrown. */
export function loadNotificationHistory(): NotificationRecord[] {
	try {
		const raw = safeStorageGet(NOTIFICATION_HISTORY_STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		return parseNotificationHistory(parsed);
	} catch {
		return [];
	}
}

/** Persist history without allowing storage failures to break notification delivery. */
function saveNotificationHistory(history: NotificationRecord[]): boolean {
	try {
		// JSON.stringify drops `onClick` on its own: functions are not serialized.
		const storage = safeLocalStorage();
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
	/**
	 * Whether toasts are recorded into the history. Mirrors the
	 * `notificationCenterEnabled` setting: with the inbox off there is nowhere
	 * to read a record, so none is written.
	 */
	historyEnabled: boolean;
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
	/** Turn history recording on or off. Off also closes the inbox. */
	setHistoryEnabled: (enabled: boolean) => void;
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
		// Off until settings load says otherwise, matching `notificationCenterEnabled`.
		historyEnabled: false,
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
			const retainedIds = s.history.filter((n) => dismissed.has(n.id)).map((n) => n.id);
			if (retainedIds.length)
				persistNotificationHistoryChange({ action: 'read', ids: retainedIds });
			return {
				toasts: [],
				history: s.history.map((n) => (dismissed.has(n.id) && !n.read ? { ...n, read: true } : n)),
			};
		});
	},

	// --- Notification history ---
	recordNotification: (toast) => {
		const sessionId =
			toast.sessionId ??
			(toast.clickAction && 'sessionId' in toast.clickAction
				? toast.clickAction.sessionId
				: undefined);
		const { sessions, groups } = useSessionStore.getState();
		const session = sessions.find((s) => s.id === sessionId);
		const sourceTabId =
			toast.tabId ??
			(toast.clickAction && 'tabId' in toast.clickAction ? toast.clickAction.tabId : undefined);
		const tab = session?.aiTabs.find((t) => t.id === sourceTabId);
		const record = {
			...toast,
			project: toast.project ?? session?.name,
			group: toast.group ?? groups.find((g) => g.id === session?.groupId)?.name,
			tabName: toast.tabName ?? (tab ? getTabDisplayName(tab) : undefined),
			read: false,
		};
		persistNotificationHistoryChange({ action: 'append', record });
		set((s) => ({ history: [record, ...s.history].slice(0, NOTIFICATION_HISTORY_LIMIT) }));
	},

	markNotificationRead: (id) =>
		set((s) => {
			// Same array back when nothing changes, so subscribers and the
			// persistence write below are skipped.
			if (!s.history.some((n) => n.id === id && !n.read)) return s;
			persistNotificationHistoryChange({ action: 'read', ids: [id] });
			return { history: s.history.map((n) => (n.id === id ? { ...n, read: true } : n)) };
		}),

	markAllNotificationsRead: () =>
		set((s) => {
			if (!s.history.some((n) => !n.read)) return s;
			persistNotificationHistoryChange({
				action: 'read',
				ids: s.history.filter((n) => !n.read).map((n) => n.id),
			});
			return { history: s.history.map((n) => (n.read ? n : { ...n, read: true })) };
		}),

	// A fresh array retries persistence even after a failed clear already emptied the inbox.
	clearNotificationHistory: () => {
		persistNotificationHistoryChange({ action: 'clear' });
		set({ history: [], notificationCenterExpandedId: null });
	},

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

	setHistoryEnabled: (enabled) =>
		set((s) => ({
			config: { ...s.config, historyEnabled: enabled },
			...(!enabled ? { notificationCenterOpen: false, notificationCenterExpandedId: null } : {}),
		})),
}));

/** Pending deltas overlay host snapshots so an acknowledgement cannot erase newer UI work. */
const pendingHistoryChanges: NotificationHistoryChange[] = [];
let historyWrites: Promise<void> = Promise.resolve();
let historyRevision = -1;
let latestHistoryRecords: NotificationHistorySnapshot['records'] = [];

/** Accept monotonic main snapshots without losing renderer-only callbacks. */
function applyHistorySnapshot(snapshot: NotificationHistorySnapshot): void {
	if (!snapshot.success || !snapshot.records || snapshot.revision === undefined) return;
	if (snapshot.revision >= historyRevision) {
		historyRevision = snapshot.revision;
		latestHistoryRecords = snapshot.records;
	}
	// Even an older acknowledgement retires a delta; reproject the newest base.
	let records = latestHistoryRecords ?? [];
	for (const change of pendingHistoryChanges)
		records = applyNotificationHistoryChange(records, change);
	const local = new Map(useNotificationStore.getState().history.map((n) => [n.id, n]));
	useNotificationStore.setState({
		history: records.map((record) => ({ ...record, onClick: local.get(record.id)?.onClick })),
	});
}

/** Serialize this renderer's mutations; main serializes mutations across all clients. */
function persistNotificationHistoryChange(change: NotificationHistoryChange): void {
	if (isWebDesktop()) return; // Remote inboxes are client-local; host history APIs stay private.
	const api = window.maestro?.notification?.changeHistory;
	if (!api) return; // Legacy/test hosts retain the guarded localStorage fallback.
	pendingHistoryChanges.push(change);
	historyWrites = historyWrites.then(async () => {
		// Keep failed deltas visible and retry them in order on the next mutation.
		while (pendingHistoryChanges.includes(change)) {
			const next = pendingHistoryChanges[0];
			try {
				let wire = next;
				if (next.action === 'append') {
					const { onClick: _callback, ...record } = next.record as NotificationRecord;
					wire = { ...next, record };
				}
				const snapshot = await api(wire);
				if (!snapshot.success) {
					useNotificationStore.setState({ historyPersistenceFailed: true });
					break;
				}
				pendingHistoryChanges.shift();
				useNotificationStore.setState({ historyPersistenceFailed: false });
				applyHistorySnapshot(snapshot);
			} catch {
				useNotificationStore.setState({ historyPersistenceFailed: true });
				break;
			}
		}
	});
}

/** Wait for durable acknowledgement before the CLI reports a mutation result. */
export async function flushNotificationHistoryWrites(): Promise<void> {
	await historyWrites;
}

/** Subscribe before migrating so notifications from another window cannot be missed. */
export function startNotificationHistorySync(): () => void {
	if (isWebDesktop()) return () => {};
	const api = window.maestro?.notification;
	if (!api?.changeHistory || !api.onHistoryChanged) return () => {};
	const unsubscribe = api.onHistoryChanged(applyHistorySnapshot);
	const records = loadNotificationHistory();
	persistNotificationHistoryChange({ action: 'migrate', records });
	return unsubscribe;
}

useNotificationStore.subscribe((state, prev) => {
	if (
		state.history !== prev.history &&
		(isWebDesktop() || !window.maestro?.notification?.changeHistory)
	) {
		const historyPersistenceFailed = !saveNotificationHistory(state.history);
		if (historyPersistenceFailed !== state.historyPersistenceFailed) {
			useNotificationStore.setState({ historyPersistenceFailed });
		}
	}
});

// ============================================================================
// notifyToast - public API for firing toasts (handles side effects)
// ============================================================================

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
 *    history (whenever the Notification Center is on, unless `skipHistory` -
 *    with toasts disabled the history is the only place the notification shows up)
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

	const id = `toast-${generateId()}`;
	const toastsDisabled = !areToastsEnabled(config.defaultDuration);

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

	if (!toast.skipHistory && config.historyEnabled) {
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
			clickAction: toast.onClick ? undefined : toast.clickAction,
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
	if (isWebDesktop()) return false;
	const { config } = useNotificationStore.getState();
	const hasContent = !!message && message.trim().length > 0;
	const shouldFire = config.audioFeedbackEnabled && !!config.audioFeedbackCommand && hasContent;
	// The command runs on the HOST, and the desktop renderer that owns the
	// side effects fires it. A browser client firing it too would double the
	// cue, and the bridge refuses `notification:speak` anyway.
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
	clickAction?: ToastClickAction;
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
			const result = options.clickAction
				? window.maestro.notification.show(title, body, sessionId, tabId, options.clickAction)
				: window.maestro.notification.show(title, body, sessionId, tabId);
			result.catch((err) => {
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
