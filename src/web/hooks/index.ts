/**
 * Web interface hooks for Maestro
 *
 * Custom React hooks for the web interface, including WebSocket
 * connection management and real-time state synchronization.
 */

export {
  useWebSocket,
  default as useWebSocketDefault,
} from './useWebSocket';

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

export {
  useSessions,
  default as useSessionsDefault,
} from './useSessions';

export type {
  Session,
  SessionState,
  InputMode,
  UseSessionsOptions,
  UseSessionsReturn,
} from './useSessions';
