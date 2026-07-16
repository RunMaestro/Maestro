/**
 * Web interface hooks for Maestro
 *
 * Custom React hooks for the web interface, including WebSocket
 * connection management and real-time state synchronization.
 */

export { useWebSocket, default as useWebSocketDefault } from './useWebSocket';

export type {
	WebSocketState,
	WebSocketEventHandlers,
	UseWebSocketOptions,
	UseWebSocketReturn,
} from './useWebSocket';
export type {
	AITabData,
	AutoRunState,
	GroupChatMessage,
	GroupChatState,
	GroupData,
	SessionData,
} from '../../shared/web-protocol/session';
export type {
	AuthFailedMessage,
	AuthRequiredMessage,
	AuthSuccessMessage,
	ConnectedMessage,
	ErrorMessage,
	GroupsChangedMessage,
	ServerMessage,
	ServerMessageType,
	SessionAddedMessage,
	SessionRemovedMessage,
	SessionStateChangeMessage,
	SessionsListMessage,
	ThemeMessage,
} from '../../shared/web-protocol/server-messages';

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
	MobileShortcutActions,
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

export { useAgentManagement, default as useAgentManagementDefault } from './useAgentManagement';

export type { UseAgentManagementReturn } from './useAgentManagement';

export { useGitStatus, default as useGitStatusDefault } from './useGitStatus';

export type { GitDiffResult, GitStatusFile, GitStatusResult } from '../../shared/web-protocol/git';
export type { UseGitStatusReturn } from './useGitStatus';

export { useGroupChat, default as useGroupChatDefault } from './useGroupChat';

export type { UseGroupChatReturn } from './useGroupChat';
