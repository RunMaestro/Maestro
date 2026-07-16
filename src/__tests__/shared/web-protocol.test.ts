import { describe, expect, it } from 'vitest';
import {
	isWebServerMessage,
	WEB_SERVER_MESSAGE_TYPES,
	type ServerMessage,
} from '../../shared/web-protocol/server-messages';

describe('web server protocol contracts', () => {
	it('derives server message discriminants from the canonical payload map', () => {
		const message: ServerMessage = {
			type: 'sessions_list',
			sessions: [],
			timestamp: 1,
		};

		expect(WEB_SERVER_MESSAGE_TYPES).toContain(message.type);
	});

	it('rejects unknown discriminants at the web runtime boundary', () => {
		expect(isWebServerMessage({ type: 'unrecognized', timestamp: 1 })).toBe(false);
	});

	it('rejects malformed payloads at the web runtime boundary', () => {
		expect(isWebServerMessage({ type: 'sessions_list', sessions: {}, timestamp: 1 })).toBe(false);
		expect(isWebServerMessage({ type: 'connected', clientId: 1, authenticated: true })).toBe(false);
	});

	it('accepts every server discriminant with a contract fixture', () => {
		const fixtures: Record<(typeof WEB_SERVER_MESSAGE_TYPES)[number], object> = {
			connected: { clientId: 'client', message: 'connected', authenticated: true },
			auth_required: { clientId: 'client', message: 'authenticate' },
			auth_success: { clientId: 'client', message: 'authenticated' },
			auth_failed: { message: 'denied' },
			sessions_list: { sessions: [] },
			session_state_change: { sessionId: 'session', state: 'idle' },
			session_added: {
				session: {
					id: 'session',
					name: 'Session',
					toolType: 'agent',
					state: 'idle',
					inputMode: 'ai',
					cwd: '/',
				},
			},
			session_removed: { sessionId: 'session' },
			active_session_changed: { sessionId: 'session' },
			session_output: { sessionId: 'session', data: 'output', source: 'ai' },
			session_exit: { sessionId: 'session', exitCode: 0 },
			session_live: { sessionId: 'session' },
			session_offline: { sessionId: 'session' },
			user_input: { sessionId: 'session', command: 'hello', inputMode: 'ai' },
			theme: { theme: {} },
			bionify_reading_mode: { enabled: true },
			custom_commands: { commands: [] },
			autorun_state: { sessionId: 'session', state: null },
			autorun_docs_changed: { sessionId: 'session', documents: [] },
			notification_event: {
				eventType: 'agent_complete',
				sessionId: 'session',
				sessionName: 'Session',
				message: 'done',
				severity: 'info',
			},
			settings_changed: { settings: {} },
			groups_changed: { groups: [] },
			tabs_changed: { sessionId: 'session', aiTabs: [], activeTabId: 'tab' },
			group_chat_message: { chatId: 'chat', message: {} },
			group_chat_state_change: { chatId: 'chat' },
			context_operation_progress: { sessionId: 'session', operation: 'merge', progress: 1 },
			context_operation_complete: { sessionId: 'session', operation: 'merge', success: true },
			cue_activity_event: { entry: {} },
			cue_subscriptions_changed: { subscriptions: [] },
			tool_event: { sessionId: 'session', tabId: 'tab', toolLog: {} },
			terminal_data: { sessionId: 'session', data: 'data' },
			terminal_ready: { sessionId: 'session' },
			pong: {},
			subscribed: { sessionId: 'session' },
			echo: {},
			error: { message: 'error' },
		};

		for (const type of WEB_SERVER_MESSAGE_TYPES) {
			expect(isWebServerMessage({ type, ...fixtures[type], timestamp: 1 })).toBe(true);
		}
	});
});
