import type { Theme } from '../theme-types';
import type {
	AITabData,
	AutoRunDocument,
	AutoRunState,
	CustomAICommand,
	GroupChatMessage,
	GroupChatState,
	GroupData,
	NotificationEvent,
	SessionData,
	WebSettings,
} from './session';
import type { CueActivityEntry, CueSubscriptionInfo } from './cue';

export interface ServerMessagePayloads {
	connected: {
		clientId: string;
		message: string;
		authenticated: boolean;
		subscribedSessionId?: string;
	};
	auth_required: { clientId: string; message: string };
	auth_success: { clientId: string; message: string };
	auth_failed: { message: string };
	sessions_list: { sessions: SessionData[] };
	session_state_change: {
		sessionId: string;
		state: string;
		name?: string;
		toolType?: string;
		inputMode?: string;
		cwd?: string;
		cliActivity?: { playbookId: string; playbookName: string; startedAt: number };
	};
	session_added: { session: SessionData };
	session_removed: { sessionId: string };
	active_session_changed: { sessionId: string };
	session_output: {
		sessionId: string;
		tabId?: string;
		data: string;
		source: 'ai' | 'terminal';
		msgId?: string;
	};
	session_exit: { sessionId: string; exitCode: number };
	session_live: { sessionId: string; agentSessionId?: string };
	session_offline: { sessionId: string };
	user_input: { sessionId: string; command: string; inputMode: 'ai' | 'terminal' };
	theme: { theme: Theme };
	bionify_reading_mode: { enabled: boolean };
	custom_commands: { commands: CustomAICommand[] };
	autorun_state: { sessionId: string; state: AutoRunState | null };
	autorun_docs_changed: { sessionId: string; documents: AutoRunDocument[] };
	notification_event: NotificationEvent;
	settings_changed: { settings: WebSettings };
	groups_changed: { groups: GroupData[] };
	tabs_changed: { sessionId: string; aiTabs: AITabData[]; activeTabId: string };
	group_chat_message: { chatId: string; message: GroupChatMessage };
	group_chat_state_change: { chatId: string } & Partial<GroupChatState>;
	context_operation_progress: { sessionId: string; operation: string; progress: number };
	context_operation_complete: { sessionId: string; operation: string; success: boolean };
	cue_activity_event: { entry: CueActivityEntry };
	cue_subscriptions_changed: { subscriptions: CueSubscriptionInfo[] };
	tool_event: {
		sessionId: string;
		tabId: string;
		toolLog: {
			id: string;
			timestamp: number;
			source: 'tool';
			text: string;
			metadata?: {
				toolState?: {
					name: string;
					status: 'running' | 'completed' | 'error';
					input?: Record<string, unknown>;
				};
			};
		};
	};
	terminal_data: { sessionId: string; data: string };
	terminal_ready: { sessionId: string };
	pong: Record<never, never>;
	subscribed: { sessionId?: string; requestId?: string };
	echo: Record<never, never>;
	error: { message: string; requestId?: string };
}

export type ServerMessageType = keyof ServerMessagePayloads;

export type ServerMessage = {
	[T in ServerMessageType]: { type: T; timestamp?: number } & ServerMessagePayloads[T];
}[ServerMessageType];
export type ServerMessageFor<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;
export type ConnectedMessage = ServerMessageFor<'connected'>;
export type AuthRequiredMessage = ServerMessageFor<'auth_required'>;
export type AuthSuccessMessage = ServerMessageFor<'auth_success'>;
export type AuthFailedMessage = ServerMessageFor<'auth_failed'>;
export type SessionsListMessage = ServerMessageFor<'sessions_list'>;
export type SessionStateChangeMessage = ServerMessageFor<'session_state_change'>;
export type SessionAddedMessage = ServerMessageFor<'session_added'>;
export type SessionRemovedMessage = ServerMessageFor<'session_removed'>;
export type ActiveSessionChangedMessage = ServerMessageFor<'active_session_changed'>;
export type SessionOutputMessage = ServerMessageFor<'session_output'>;
export type SessionExitMessage = ServerMessageFor<'session_exit'>;
export type UserInputMessage = ServerMessageFor<'user_input'>;
export type ThemeMessage = ServerMessageFor<'theme'>;
export type BionifyReadingModeMessage = ServerMessageFor<'bionify_reading_mode'>;
export type CustomCommandsMessage = ServerMessageFor<'custom_commands'>;
export type AutoRunStateMessage = ServerMessageFor<'autorun_state'>;
export type TabsChangedMessage = ServerMessageFor<'tabs_changed'>;
export type GroupsChangedMessage = ServerMessageFor<'groups_changed'>;
export type ErrorMessage = ServerMessageFor<'error'>;

/** Runtime source of truth for server-to-web message discriminants. */
export const WEB_SERVER_MESSAGE_TYPES = [
	'connected',
	'auth_required',
	'auth_success',
	'auth_failed',
	'sessions_list',
	'session_state_change',
	'session_added',
	'session_removed',
	'active_session_changed',
	'session_output',
	'session_exit',
	'session_live',
	'session_offline',
	'user_input',
	'theme',
	'bionify_reading_mode',
	'custom_commands',
	'autorun_state',
	'autorun_docs_changed',
	'notification_event',
	'settings_changed',
	'groups_changed',
	'tabs_changed',
	'group_chat_message',
	'group_chat_state_change',
	'context_operation_progress',
	'context_operation_complete',
	'cue_activity_event',
	'cue_subscriptions_changed',
	'tool_event',
	'terminal_data',
	'terminal_ready',
	'pong',
	'subscribed',
	'echo',
	'error',
] as const satisfies readonly ServerMessageType[];

type UnknownRecord = Record<string, unknown>;
type MessageValidator = (message: UnknownRecord) => boolean;

const isRecord = (value: unknown): value is UnknownRecord =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const hasString = (message: UnknownRecord, key: string): boolean =>
	typeof message[key] === 'string';
const hasNumber = (message: UnknownRecord, key: string): boolean =>
	typeof message[key] === 'number';
const hasBoolean = (message: UnknownRecord, key: string): boolean =>
	typeof message[key] === 'boolean';
const hasArray = (message: UnknownRecord, key: string): boolean => Array.isArray(message[key]);
const hasRecord = (message: UnknownRecord, key: string): boolean => isRecord(message[key]);

const SERVER_MESSAGE_VALIDATORS: Record<ServerMessageType, MessageValidator> = {
	connected: (message) =>
		hasString(message, 'clientId') &&
		hasString(message, 'message') &&
		hasBoolean(message, 'authenticated'),
	auth_required: (message) => hasString(message, 'clientId') && hasString(message, 'message'),
	auth_success: (message) => hasString(message, 'clientId') && hasString(message, 'message'),
	auth_failed: (message) => hasString(message, 'message'),
	sessions_list: (message) => hasArray(message, 'sessions'),
	session_state_change: (message) => hasString(message, 'sessionId') && hasString(message, 'state'),
	session_added: (message) => hasRecord(message, 'session'),
	session_removed: (message) => hasString(message, 'sessionId'),
	active_session_changed: (message) => hasString(message, 'sessionId'),
	session_output: (message) =>
		hasString(message, 'sessionId') &&
		hasString(message, 'data') &&
		(message.source === 'ai' || message.source === 'terminal'),
	session_exit: (message) => hasString(message, 'sessionId') && hasNumber(message, 'exitCode'),
	session_live: (message) => hasString(message, 'sessionId'),
	session_offline: (message) => hasString(message, 'sessionId'),
	user_input: (message) =>
		hasString(message, 'sessionId') &&
		hasString(message, 'command') &&
		(message.inputMode === 'ai' || message.inputMode === 'terminal'),
	theme: (message) => hasRecord(message, 'theme'),
	bionify_reading_mode: (message) => hasBoolean(message, 'enabled'),
	custom_commands: (message) => hasArray(message, 'commands'),
	autorun_state: (message) =>
		hasString(message, 'sessionId') && (message.state === null || hasRecord(message, 'state')),
	autorun_docs_changed: (message) =>
		hasString(message, 'sessionId') && hasArray(message, 'documents'),
	notification_event: (message) =>
		hasString(message, 'eventType') &&
		hasString(message, 'sessionId') &&
		hasString(message, 'sessionName') &&
		hasString(message, 'message') &&
		hasString(message, 'severity'),
	settings_changed: (message) => hasRecord(message, 'settings'),
	groups_changed: (message) => hasArray(message, 'groups'),
	tabs_changed: (message) =>
		hasString(message, 'sessionId') &&
		hasArray(message, 'aiTabs') &&
		hasString(message, 'activeTabId'),
	group_chat_message: (message) => hasString(message, 'chatId') && hasRecord(message, 'message'),
	group_chat_state_change: (message) => hasString(message, 'chatId'),
	context_operation_progress: (message) =>
		hasString(message, 'sessionId') &&
		hasString(message, 'operation') &&
		hasNumber(message, 'progress'),
	context_operation_complete: (message) =>
		hasString(message, 'sessionId') &&
		hasString(message, 'operation') &&
		hasBoolean(message, 'success'),
	cue_activity_event: (message) => hasRecord(message, 'entry'),
	cue_subscriptions_changed: (message) => hasArray(message, 'subscriptions'),
	tool_event: (message) =>
		hasString(message, 'sessionId') && hasString(message, 'tabId') && hasRecord(message, 'toolLog'),
	terminal_data: (message) => hasString(message, 'sessionId') && hasString(message, 'data'),
	terminal_ready: (message) => hasString(message, 'sessionId'),
	pong: () => true,
	subscribed: () => true,
	echo: () => true,
	error: (message) => hasString(message, 'message'),
};

/** Rejects unknown discriminants and malformed server payloads before web hooks consume them. */
export function isWebServerMessage(value: unknown): value is ServerMessage {
	if (!isRecord(value) || typeof value.type !== 'string') return false;
	const validator = SERVER_MESSAGE_VALIDATORS[value.type as ServerMessageType];
	return validator?.(value) ?? false;
}
