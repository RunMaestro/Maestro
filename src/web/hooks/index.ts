/**
 * Web interface hooks for Maestro
 *
 * Custom React hooks for the web interface, including WebSocket
 * connection management and real-time state synchronization.
 */

export { useWebSocket, default as useWebSocketDefault } from './useWebSocket';

export type {
	WebSocketState,
	SessionData,
	ServerMessageType,
	ServerMessage,
	ConnectedMessage,
	AuthRequiredMessage,
	AuthSuccessMessage,
	AuthFailedMessage,
	SessionsListMessage,
	SessionStateChangeMessage,
	SessionAddedMessage,
	SessionRemovedMessage,
	ThemeMessage,
	ErrorMessage,
	TypedServerMessage,
	WebSocketEventHandlers,
	UseWebSocketOptions,
	UseWebSocketReturn,
} from './useWebSocket';

export { useSessions, default as useSessionsDefault } from './useSessions';

export type {
	Session,
	SessionState,
	InputMode,
	UseSessionsOptions,
	UseSessionsReturn,
} from './useSessions';

export { usePullToRefresh, default as usePullToRefreshDefault } from './usePullToRefresh';

export type { UsePullToRefreshOptions, UsePullToRefreshReturn } from './usePullToRefresh';

export { useCommandHistory, default as useCommandHistoryDefault } from './useCommandHistory';

export type {
	CommandHistoryEntry,
	UseCommandHistoryOptions,
	UseCommandHistoryReturn,
} from './useCommandHistory';

export { useSwipeUp, default as useSwipeUpDefault } from './useSwipeUp';

export type { UseSwipeUpOptions, UseSwipeUpReturn } from './useSwipeUp';

export {
	useNotifications,
	default as useNotificationsDefault,
	isNotificationSupported,
	getNotificationPermission,
} from './useNotifications';

export type {
	NotificationPermission,
	UseNotificationsOptions,
	UseNotificationsReturn,
} from './useNotifications';

export {
	useUnreadBadge,
	default as useUnreadBadgeDefault,
	isBadgeApiSupported,
} from './useUnreadBadge';

export type { UseUnreadBadgeOptions, UseUnreadBadgeReturn } from './useUnreadBadge';

export { useSwipeGestures, default as useSwipeGesturesDefault } from './useSwipeGestures';

export type {
	SwipeDirection,
	UseSwipeGesturesOptions,
	UseSwipeGesturesReturn,
} from './useSwipeGestures';

export { useOfflineQueue, default as useOfflineQueueDefault } from './useOfflineQueue';

export type {
	QueuedCommand,
	QueueStatus,
	UseOfflineQueueOptions,
	UseOfflineQueueReturn,
} from './useOfflineQueue';

export {
	useDeviceColorScheme,
	default as useDeviceColorSchemeDefault,
} from './useDeviceColorScheme';

export type { ColorSchemePreference, UseDeviceColorSchemeReturn } from './useDeviceColorScheme';

export {
	useVoiceInput,
	default as useVoiceInputDefault,
	isSpeechRecognitionSupported,
	getSpeechRecognition,
} from './useVoiceInput';

export type {
	SpeechRecognitionEvent,
	SpeechRecognitionResultList,
	SpeechRecognitionResult,
	SpeechRecognitionAlternative,
	SpeechRecognitionErrorEvent,
	SpeechRecognition,
	SpeechRecognitionConstructor,
	UseVoiceInputOptions,
	UseVoiceInputReturn,
} from './useVoiceInput';

export {
	useKeyboardVisibility,
	default as useKeyboardVisibilityDefault,
} from './useKeyboardVisibility';

export type { UseKeyboardVisibilityReturn } from './useKeyboardVisibility';

export {
	useSlashCommandAutocomplete,
	default as useSlashCommandAutocompleteDefault,
} from './useSlashCommandAutocomplete';

export type {
	UseSlashCommandAutocompleteOptions,
	UseSlashCommandAutocompleteReturn,
} from './useSlashCommandAutocomplete';

export { useLongPressMenu, default as useLongPressMenuDefault } from './useLongPressMenu';

export type { UseLongPressMenuOptions, UseLongPressMenuReturn } from './useLongPressMenu';

export {
	useMobileKeyboardHandler,
	default as useMobileKeyboardHandlerDefault,
} from './useMobileKeyboardHandler';

export type {
	MobileKeyboardSession,
	MobileInputMode,
	UseMobileKeyboardHandlerDeps,
} from './useMobileKeyboardHandler';

export {
	useMobileSessionManagement,
	default as useMobileSessionManagementDefault,
} from './useMobileSessionManagement';

export type {
	LogEntry,
	SessionLogsState,
	UseMobileSessionManagementDeps,
	MobileSessionHandlers,
	UseMobileSessionManagementReturn,
} from './useMobileSessionManagement';

export { useMobileViewState, default as useMobileViewStateDefault } from './useMobileViewState';

export type {
	ViewOverlayState,
	HistoryPanelState,
	SessionSelectionState,
	UseMobileViewStateReturn,
} from './useMobileViewState';

export {
	useMobileAutoReconnect,
	default as useMobileAutoReconnectDefault,
} from './useMobileAutoReconnect';

export type {
	ConnectionState,
	UseMobileAutoReconnectDeps,
	UseMobileAutoReconnectReturn,
} from './useMobileAutoReconnect';
