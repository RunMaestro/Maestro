import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

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
}

interface ToastContextType {
	toasts: Toast[];
	addToast: (toast: Omit<Toast, 'id' | 'timestamp'>) => void;
	removeToast: (id: string) => void;
	clearToasts: () => void;
	defaultDuration: number;
	setDefaultDuration: (duration: number) => void;
	// Audio feedback configuration
	setAudioFeedback: (enabled: boolean, command: string) => void;
	// OS notifications configuration
	setOsNotifications: (enabled: boolean) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

interface ToastProviderProps {
	children: React.ReactNode;
	defaultDuration?: number; // Duration in seconds, 0 = never auto-dismiss
}

export function ToastProvider({
	children,
	defaultDuration: initialDuration = 20,
}: ToastProviderProps) {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const [defaultDuration, setDefaultDuration] = useState(initialDuration);
	const toastIdCounter = useRef(0);

	// Audio feedback state (configured from App.tsx via setAudioFeedback)
	const audioFeedbackRef = useRef({ enabled: false, command: '' });
	// OS notifications state (configured from App.tsx via setOsNotifications)
	const osNotificationsRef = useRef({ enabled: true }); // Default: on (matches useSettings default)
	// Ref for defaultDuration to avoid re-creating addToast callback when duration changes
	const defaultDurationRef = useRef(defaultDuration);
	defaultDurationRef.current = defaultDuration;

	const setAudioFeedback = useCallback((enabled: boolean, command: string) => {
		audioFeedbackRef.current = { enabled, command };
	}, []);

	const setOsNotifications = useCallback((enabled: boolean) => {
		osNotificationsRef.current = { enabled };
	}, []);

	const addToast = useCallback((toast: Omit<Toast, 'id' | 'timestamp'>) => {
		// Use ref to get current value without dependency
		const currentDefaultDuration = defaultDurationRef.current;

		// If defaultDuration is -1, toasts are disabled entirely - skip showing toast UI
		// but still log, speak, and show OS notification
		const toastsDisabled = currentDefaultDuration === -1;

		const id = `toast-${Date.now()}-${toastIdCounter.current++}`;
		// Convert seconds to ms, use 0 for "never dismiss"
		const durationMs =
			toast.duration !== undefined
				? toast.duration
				: currentDefaultDuration > 0
					? currentDefaultDuration * 1000
					: 0;

		const newToast: Toast = {
			...toast,
			id,
			timestamp: Date.now(),
			duration: durationMs,
		};

		// Only add to visible toast queue if not disabled
		if (!toastsDisabled) {
			setToasts((prev) => [...prev, newToast]);
		}

		// Capture audio feedback state for logging
		const { enabled: audioEnabled, command: audioCommand } = audioFeedbackRef.current;

		// Log toast to system logs (include audio notification info)
		window.maestro.logger.toast(toast.title, {
			type: toast.type,
			message: toast.message,
			group: toast.group,
			project: toast.project,
			taskDuration: toast.taskDuration,
			agentSessionId: toast.agentSessionId,
			tabName: toast.tabName,
			// Audio/TTS notification info
			audioNotification:
				audioEnabled && audioCommand
					? {
							enabled: true,
							command: audioCommand,
						}
					: {
							enabled: false,
						},
		});

		// Speak toast via TTS if audio feedback is enabled and command is configured
		if (audioEnabled && audioCommand) {
			console.log(
				'[ToastContext] Triggering TTS with message:',
				toast.message,
				'command:',
				audioCommand
			);
			window.maestro.notification.speak(toast.message, audioCommand).catch((err) => {
				console.error('[ToastContext] Failed to speak toast:', err);
			});
		} else {
			console.log('[ToastContext] TTS skipped - enabled:', audioEnabled, 'command:', audioCommand);
		}

		// Show OS notification if enabled
		if (osNotificationsRef.current.enabled) {
			// Title: Agent/session name (project field) or fallback to toast title
			const notifTitle = toast.project || toast.title;

			// Body: [Group > ] [TabName: ] First sentence of message
			// - group = Maestro group name
			// - tabName = tab label or short Claude session UUID
			const tabLabel =
				toast.tabName || (toast.agentSessionId ? toast.agentSessionId.slice(0, 8) : null);

			// Extract first sentence from message (up to first . ! or ? followed by space/end)
			const firstSentenceMatch = toast.message.match(/^[^.!?]*[.!?]?/);
			const firstSentence = firstSentenceMatch
				? firstSentenceMatch[0].trim()
				: toast.message.slice(0, 80);

			// Build body parts
			const bodyParts: string[] = [];
			if (toast.group) {
				bodyParts.push(toast.group);
			}
			if (tabLabel) {
				bodyParts.push(tabLabel);
			}

			// Combine: "Group > Tab: First sentence" or just "First sentence"
			const prefix = bodyParts.length > 0 ? `${bodyParts.join(' > ')}: ` : '';
			const notifBody = prefix + firstSentence;

			window.maestro.notification.show(notifTitle, notifBody).catch((err) => {
				console.error('[ToastContext] Failed to show OS notification:', err);
			});
		}

		// Auto-remove after duration (only if duration > 0 and toasts are not disabled)
		if (!toastsDisabled && durationMs > 0) {
			setTimeout(() => {
				setToasts((prev) => prev.filter((t) => t.id !== id));
			}, durationMs);
		}
	}, []); // Stable callback - uses refs for mutable values

	const removeToast = useCallback((id: string) => {
		setToasts((prev) => prev.filter((t) => t.id !== id));
	}, []);

	const clearToasts = useCallback(() => {
		setToasts([]);
	}, []);

	return (
		<ToastContext.Provider
			value={{
				toasts,
				addToast,
				removeToast,
				clearToasts,
				defaultDuration,
				setDefaultDuration,
				setAudioFeedback,
				setOsNotifications,
			}}
		>
			{children}
		</ToastContext.Provider>
	);
}

export function useToast() {
	const context = useContext(ToastContext);
	if (!context) {
		throw new Error('useToast must be used within a ToastProvider');
	}
	return context;
}
