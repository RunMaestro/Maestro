import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	WebSocketMessageHandler,
	type MessageHandlerCallbacks,
	type WebClient,
	type WebClientMessage,
} from '../../main/web-server/handlers/messageHandlers';

vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

function createClient(): WebClient & { socket: { send: ReturnType<typeof vi.fn> } } {
	return {
		id: 'web-client-1',
		connectedAt: Date.now(),
		socket: { send: vi.fn() },
	} as unknown as WebClient & { socket: { send: ReturnType<typeof vi.fn> } };
}

function sent(client: WebClient & { socket: { send: ReturnType<typeof vi.fn> } }) {
	return client.socket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
}

function lastSent(client: WebClient & { socket: { send: ReturnType<typeof vi.fn> } }) {
	const messages = sent(client);
	return messages[messages.length - 1];
}

async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
}

function makeCallbacks(): MessageHandlerCallbacks {
	return {
		getSessionDetail: vi.fn((sessionId: string) => {
			if (sessionId === 'missing') return null;
			if (sessionId === 'busy') return { state: 'busy', inputMode: 'ai' };
			return {
				state: 'idle',
				inputMode: sessionId === 'terminal-session' ? 'terminal' : 'ai',
				agentSessionId: 'agent-session-1',
			};
		}),
		executeCommand: vi.fn(async () => true),
		switchMode: vi.fn(async () => true),
		selectSession: vi.fn(async () => true),
		selectTab: vi.fn(async () => true),
		newTab: vi.fn(async () => ({ tabId: 'new-tab-1' })),
		closeTab: vi.fn(async () => true),
		renameTab: vi.fn(async () => true),
		starTab: vi.fn(async () => true),
		reorderTab: vi.fn(async () => true),
		toggleBookmark: vi.fn(async () => true),
		getSessions: vi.fn(() => [
			{
				id: 'session-1',
				name: 'Session One',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/repo',
				agentSessionId: null,
			},
			{
				id: 'session-2',
				name: 'Session Two',
				toolType: 'terminal',
				state: 'idle',
				inputMode: 'terminal',
				cwd: '/repo',
				agentSessionId: 'stored-agent-session',
			},
		]),
		getLiveSessionInfo: vi.fn((sessionId: string) =>
			sessionId === 'session-1'
				? { sessionId, agentSessionId: 'live-agent-session', enabledAt: 123 }
				: undefined
		),
		isSessionLive: vi.fn((sessionId: string) => sessionId === 'session-1'),
	};
}

describe('WebSocketMessageHandler integration', () => {
	let handler: WebSocketMessageHandler;
	let callbacks: MessageHandlerCallbacks;
	let client: ReturnType<typeof createClient>;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		callbacks = makeCallbacks();
		client = createClient();
		handler.setCallbacks(callbacks);
	});

	it('routes health, subscription, command, session, and session-list messages', async () => {
		handler.handleMessage(client, { type: 'ping' });
		expect(lastSent(client)).toMatchObject({ type: 'pong' });

		handler.handleMessage(client, { type: 'subscribe', sessionId: 'session-1' });
		expect(client.subscribedSessionId).toBe('session-1');
		expect(lastSent(client)).toMatchObject({ type: 'subscribed', sessionId: 'session-1' });

		handler.handleMessage(client, { type: 'subscribe' });
		expect(lastSent(client)).toMatchObject({ type: 'subscribed' });

		handler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'session-1',
			command: 'explain status',
			inputMode: 'ai',
		});
		await flushPromises();
		expect(callbacks.executeCommand).toHaveBeenCalledWith('session-1', 'explain status', 'ai');
		expect(lastSent(client)).toMatchObject({
			type: 'command_result',
			success: true,
			sessionId: 'session-1',
		});

		handler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'terminal-session',
			command: 'pwd',
		});
		await flushPromises();
		expect(callbacks.executeCommand).toHaveBeenLastCalledWith('terminal-session', 'pwd', undefined);

		handler.handleMessage(client, {
			type: 'switch_mode',
			sessionId: 'session-1',
			mode: 'terminal',
		});
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'mode_switch_result',
			success: true,
			mode: 'terminal',
		});

		handler.handleMessage(client, {
			type: 'select_session',
			sessionId: 'session-1',
			tabId: 'tab-1',
		});
		await flushPromises();
		expect(client.subscribedSessionId).toBe('session-1');
		expect(callbacks.selectSession).toHaveBeenCalledWith('session-1', 'tab-1');
		expect(lastSent(client)).toMatchObject({ type: 'select_session_result', success: true });

		handler.handleMessage(client, { type: 'get_sessions' });
		expect(lastSent(client)).toMatchObject({
			type: 'sessions_list',
			sessions: [
				expect.objectContaining({
					id: 'session-1',
					agentSessionId: 'live-agent-session',
					liveEnabledAt: 123,
					isLive: true,
				}),
				expect.objectContaining({
					id: 'session-2',
					agentSessionId: 'stored-agent-session',
					isLive: false,
				}),
			],
		});

		handler.handleMessage(client, { type: 'unknown_type', payload: 1 });
		expect(lastSent(client)).toMatchObject({
			type: 'echo',
			originalType: 'unknown_type',
			data: { type: 'unknown_type', payload: 1 },
		});
	});

	it('reports command validation, busy, missing callback, rejection, and false-result paths', async () => {
		handler.handleMessage(client, { type: 'send_command', sessionId: 'session-1' });
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Missing sessionId or command',
		});

		handler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'missing',
			command: 'hello',
		});
		expect(lastSent(client)).toMatchObject({ type: 'error', message: 'Session not found' });

		handler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'busy',
			command: 'hello',
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Session is busy - please wait for the current operation to complete',
			sessionId: 'busy',
		});

		callbacks.executeCommand = vi.fn(async () => false);
		handler.setCallbacks({ executeCommand: callbacks.executeCommand });
		handler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'session-1',
			command: 'reject me',
		});
		await flushPromises();
		expect(lastSent(client)).toMatchObject({ type: 'command_result', success: false });

		callbacks.executeCommand = vi.fn(async () => {
			throw new Error('runner failed');
		});
		handler.setCallbacks({ executeCommand: callbacks.executeCommand });
		handler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'session-1',
			command: 'throw',
		});
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Failed to execute command: runner failed',
		});

		const noCommandHandler = new WebSocketMessageHandler();
		noCommandHandler.setCallbacks({ getSessionDetail: callbacks.getSessionDetail });
		noCommandHandler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'session-1',
			command: 'no callback',
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Command execution not configured',
		});
	});

	it('routes tab lifecycle messages through success, missing-input, missing-callback, and rejection paths', async () => {
		const cases: Array<{
			message: WebClientMessage;
			callback: keyof MessageHandlerCallbacks;
			resultType: string;
			successPayload: Record<string, unknown>;
			errorMessage: string;
			missingMessage: WebClientMessage;
			noCallbackMessage: string;
		}> = [
			{
				message: { type: 'select_tab', sessionId: 'session-1', tabId: 'tab-1' },
				callback: 'selectTab',
				resultType: 'select_tab_result',
				successPayload: { tabId: 'tab-1' },
				errorMessage: 'Failed to select tab: select failed',
				missingMessage: { type: 'select_tab', sessionId: 'session-1' },
				noCallbackMessage: 'Tab selection not configured',
			},
			{
				message: { type: 'close_tab', sessionId: 'session-1', tabId: 'tab-1' },
				callback: 'closeTab',
				resultType: 'close_tab_result',
				successPayload: { tabId: 'tab-1' },
				errorMessage: 'Failed to close tab: close failed',
				missingMessage: { type: 'close_tab', sessionId: 'session-1' },
				noCallbackMessage: 'Tab closing not configured',
			},
			{
				message: {
					type: 'rename_tab',
					sessionId: 'session-1',
					tabId: 'tab-1',
					newName: '',
				},
				callback: 'renameTab',
				resultType: 'rename_tab_result',
				successPayload: { tabId: 'tab-1', newName: '' },
				errorMessage: 'Failed to rename tab: rename failed',
				missingMessage: { type: 'rename_tab', sessionId: 'session-1' },
				noCallbackMessage: 'Tab renaming not configured',
			},
			{
				message: { type: 'star_tab', sessionId: 'session-1', tabId: 'tab-1', starred: true },
				callback: 'starTab',
				resultType: 'star_tab_result',
				successPayload: { tabId: 'tab-1', starred: true },
				errorMessage: 'Failed to star tab: star failed',
				missingMessage: { type: 'star_tab', sessionId: 'session-1' },
				noCallbackMessage: 'Tab starring not configured',
			},
		];

		for (const item of cases) {
			handler.handleMessage(client, item.message);
			await flushPromises();
			expect(lastSent(client)).toMatchObject({
				type: item.resultType,
				success: true,
				sessionId: 'session-1',
				...item.successPayload,
			});

			handler.handleMessage(client, item.missingMessage);
			expect(lastSent(client)).toMatchObject({
				type: 'error',
				message: expect.stringContaining('Missing sessionId'),
			});

			const noCallbackHandler = new WebSocketMessageHandler();
			noCallbackHandler.handleMessage(client, item.message);
			expect(lastSent(client)).toMatchObject({
				type: 'error',
				message: item.noCallbackMessage,
			});

			handler.setCallbacks({
				[item.callback]: vi.fn(async () => {
					throw new Error(item.callback.replace(/Tab$/, '').toLowerCase() + ' failed');
				}),
			});
			handler.handleMessage(client, item.message);
			await flushPromises();
			expect(lastSent(client)).toMatchObject({
				type: 'error',
				message: item.errorMessage,
			});
			handler.setCallbacks({ [item.callback]: callbacks[item.callback] as any });
		}
	});

	it('routes new-tab, reorder, bookmark, mode, and session error edges', async () => {
		handler.handleMessage(client, { type: 'new_tab', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'new_tab_result',
			success: true,
			tabId: 'new-tab-1',
		});

		callbacks.newTab = vi.fn(async () => null);
		handler.setCallbacks({ newTab: callbacks.newTab });
		handler.handleMessage(client, { type: 'new_tab', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({ type: 'new_tab_result', success: false });

		callbacks.newTab = vi.fn(async () => {
			throw new Error('new failed');
		});
		handler.setCallbacks({ newTab: callbacks.newTab });
		handler.handleMessage(client, { type: 'new_tab', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Failed to create tab: new failed',
		});

		handler.handleMessage(client, { type: 'new_tab' });
		expect(lastSent(client)).toMatchObject({ type: 'error', message: 'Missing sessionId' });
		new WebSocketMessageHandler().handleMessage(client, {
			type: 'new_tab',
			sessionId: 'session-1',
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Tab creation not configured',
		});

		handler.setCallbacks({ reorderTab: callbacks.reorderTab });
		handler.handleMessage(client, {
			type: 'reorder_tab',
			sessionId: 'session-1',
			fromIndex: 0,
			toIndex: 2,
		});
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'reorder_tab_result',
			success: true,
			fromIndex: 0,
			toIndex: 2,
		});
		handler.handleMessage(client, { type: 'reorder_tab', sessionId: 'session-1', fromIndex: 0 });
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Missing sessionId, fromIndex, or toIndex',
		});
		new WebSocketMessageHandler().handleMessage(client, {
			type: 'reorder_tab',
			sessionId: 'session-1',
			fromIndex: 0,
			toIndex: 1,
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Tab reordering not configured',
		});
		handler.setCallbacks({
			reorderTab: vi.fn(async () => {
				throw new Error('reorder failed');
			}),
		});
		handler.handleMessage(client, {
			type: 'reorder_tab',
			sessionId: 'session-1',
			fromIndex: 0,
			toIndex: 1,
		});
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Failed to reorder tab: reorder failed',
		});

		handler.setCallbacks({ toggleBookmark: callbacks.toggleBookmark });
		handler.handleMessage(client, { type: 'toggle_bookmark', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({ type: 'toggle_bookmark_result', success: true });
		handler.handleMessage(client, { type: 'toggle_bookmark' });
		expect(lastSent(client)).toMatchObject({ type: 'error', message: 'Missing sessionId' });
		new WebSocketMessageHandler().handleMessage(client, {
			type: 'toggle_bookmark',
			sessionId: 'session-1',
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Bookmark toggling not configured',
		});
		handler.setCallbacks({
			toggleBookmark: vi.fn(async () => {
				throw new Error('bookmark failed');
			}),
		});
		handler.handleMessage(client, { type: 'toggle_bookmark', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Failed to toggle bookmark: bookmark failed',
		});

		handler.handleMessage(client, { type: 'switch_mode', sessionId: 'session-1' });
		expect(lastSent(client)).toMatchObject({ type: 'error', message: 'Missing sessionId or mode' });
		new WebSocketMessageHandler().handleMessage(client, {
			type: 'switch_mode',
			sessionId: 'session-1',
			mode: 'ai',
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Mode switching not configured',
		});
		handler.setCallbacks({
			switchMode: vi.fn(async () => {
				throw new Error('mode failed');
			}),
		});
		handler.handleMessage(client, { type: 'switch_mode', sessionId: 'session-1', mode: 'ai' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Failed to switch mode: mode failed',
		});

		handler.handleMessage(client, { type: 'select_session' });
		expect(lastSent(client)).toMatchObject({ type: 'error', message: 'Missing sessionId' });
		new WebSocketMessageHandler().handleMessage(client, {
			type: 'select_session',
			sessionId: 'session-1',
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Session selection not configured',
		});
		handler.setCallbacks({ selectSession: vi.fn(async () => false) });
		handler.handleMessage(client, { type: 'select_session', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'select_session_result',
			success: false,
		});
		handler.setCallbacks({
			selectSession: vi.fn(async () => {
				throw new Error('select failed');
			}),
		});
		handler.handleMessage(client, { type: 'select_session', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Failed to select session: select failed',
		});
	});
});
