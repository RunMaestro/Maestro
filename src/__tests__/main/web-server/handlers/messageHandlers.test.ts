/**
 * Tests for WebSocketMessageHandler
 *
 * The MessageHandler is the core of web → desktop synchronization.
 * When ANYTHING happens on the web interface (remote control), it must
 * be forwarded to the desktop and executed. This is the "remote control" contract.
 *
 * Actions that MUST work (web → desktop):
 * - Send command (AI or terminal)
 * - Switch mode (AI ↔ terminal)
 * - Select session
 * - Select tab
 * - Create new tab
 * - Close tab
 * - Rename tab
 * - Subscribe to session updates
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import {
	WebSocketMessageHandler,
	type WebClient,
	type WebClientMessage,
	type MessageHandlerCallbacks,
} from '../../../../main/web-server/handlers/messageHandlers';

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

/**
 * Create a mock WebSocket client
 */
function createMockClient(id: string = 'test-client'): WebClient {
	return {
		id,
		connectedAt: Date.now(),
		socket: {
			readyState: WebSocket.OPEN,
			send: vi.fn(),
		} as unknown as WebSocket,
	};
}

/**
 * Create mock callbacks with all methods as vi.fn()
 */
function createMockCallbacks(): MessageHandlerCallbacks {
	return {
		getSessionDetail: vi.fn().mockReturnValue({
			state: 'idle',
			inputMode: 'ai',
			agentSessionId: 'claude-123',
		}),
		executeCommand: vi.fn().mockResolvedValue(true),
		switchMode: vi.fn().mockResolvedValue(true),
		selectSession: vi.fn().mockResolvedValue(true),
		selectTab: vi.fn().mockResolvedValue(true),
		newTab: vi.fn().mockResolvedValue({ tabId: 'new-tab-123' }),
		closeTab: vi.fn().mockResolvedValue(true),
		renameTab: vi.fn().mockResolvedValue(true),
		getSessions: vi.fn().mockReturnValue([
			{
				id: 'session-1',
				name: 'Session 1',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/test',
			},
		]),
		getLiveSessionInfo: vi.fn().mockReturnValue(undefined),
		isSessionLive: vi.fn().mockReturnValue(false),
	};
}

describe('WebSocketMessageHandler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let callbacks: MessageHandlerCallbacks;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		callbacks = createMockCallbacks();
		handler.setCallbacks(callbacks);
	});

	describe('Ping/Pong Health Check', () => {
		it('should respond to ping with pong', () => {
			handler.handleMessage(client, { type: 'ping' });

			expect(client.socket.send).toHaveBeenCalledTimes(1);
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('pong');
			expect(response.timestamp).toBeDefined();
		});
	});

	describe('Session Subscription', () => {
		it('should subscribe client to session updates', () => {
			handler.handleMessage(client, { type: 'subscribe', sessionId: 'session-1' });

			expect(client.subscribedSessionId).toBe('session-1');
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('subscribed');
			expect(response.sessionId).toBe('session-1');
		});

		it('should handle subscribe without sessionId', () => {
			handler.handleMessage(client, { type: 'subscribe' });

			expect(client.subscribedSessionId).toBeUndefined();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('subscribed');
		});
	});

	describe('Send Command (Web → Desktop)', () => {
		it('should forward AI command to desktop', async () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Hello Claude!',
				inputMode: 'ai',
			});

			// Wait for async callback
			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith('session-1', 'Hello Claude!', 'ai');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('command_result');
			expect(response.success).toBe(true);
		});

		it('should forward terminal command to desktop', async () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'ls -la',
				inputMode: 'terminal',
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith('session-1', 'ls -la', 'terminal');
			});
		});

		it('should reject command when session is busy', () => {
			(callbacks.getSessionDetail as any).mockReturnValue({ state: 'busy', inputMode: 'ai' });

			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'test',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('busy');
			expect(callbacks.executeCommand).not.toHaveBeenCalled();
		});

		it('should reject command when session not found', () => {
			(callbacks.getSessionDetail as any).mockReturnValue(null);

			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'nonexistent',
				command: 'test',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not found');
		});

		it('should reject command with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'send_command',
				command: 'test',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing');
		});

		it('should reject command with missing command', () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
		});

		it('should handle command execution failure', async () => {
			(callbacks.executeCommand as any).mockRejectedValue(new Error('Execution failed'));

			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'test',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('error');
				expect(lastResponse.message).toContain('Execution failed');
			});
		});
	});

	describe('Switch Mode (Web → Desktop)', () => {
		it('should forward mode switch to AI', async () => {
			handler.handleMessage(client, {
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'ai',
			});

			await vi.waitFor(() => {
				expect(callbacks.switchMode).toHaveBeenCalledWith('session-1', 'ai');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('mode_switch_result');
			expect(response.success).toBe(true);
			expect(response.mode).toBe('ai');
		});

		it('should forward mode switch to terminal', async () => {
			handler.handleMessage(client, {
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'terminal',
			});

			await vi.waitFor(() => {
				expect(callbacks.switchMode).toHaveBeenCalledWith('session-1', 'terminal');
			});
		});

		it('should reject mode switch with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'switch_mode',
				mode: 'ai',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.switchMode).not.toHaveBeenCalled();
		});

		it('should reject mode switch with missing mode', () => {
			handler.handleMessage(client, {
				type: 'switch_mode',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
		});
	});

	describe('Select Session (Web → Desktop)', () => {
		it('should forward session selection to desktop', async () => {
			handler.handleMessage(client, {
				type: 'select_session',
				sessionId: 'session-2',
			});

			await vi.waitFor(() => {
				expect(callbacks.selectSession).toHaveBeenCalledWith('session-2', undefined);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('select_session_result');
			expect(response.success).toBe(true);
		});

		it('should forward session selection with tabId', async () => {
			handler.handleMessage(client, {
				type: 'select_session',
				sessionId: 'session-2',
				tabId: 'tab-5',
			});

			await vi.waitFor(() => {
				expect(callbacks.selectSession).toHaveBeenCalledWith('session-2', 'tab-5');
			});
		});

		it('should reject session selection with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'select_session',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.selectSession).not.toHaveBeenCalled();
		});
	});

	describe('Select Tab (Web → Desktop)', () => {
		it('should forward tab selection to desktop', async () => {
			handler.handleMessage(client, {
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'tab-2',
			});

			await vi.waitFor(() => {
				expect(callbacks.selectTab).toHaveBeenCalledWith('session-1', 'tab-2');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('select_tab_result');
			expect(response.success).toBe(true);
			expect(response.tabId).toBe('tab-2');
		});

		it('should reject tab selection with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'select_tab',
				tabId: 'tab-2',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.selectTab).not.toHaveBeenCalled();
		});

		it('should reject tab selection with missing tabId', () => {
			handler.handleMessage(client, {
				type: 'select_tab',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
		});

		it('should handle tab selection failure', async () => {
			(callbacks.selectTab as any).mockRejectedValue(new Error('Tab not found'));

			handler.handleMessage(client, {
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'nonexistent',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('error');
				expect(lastResponse.message).toContain('Tab not found');
			});
		});
	});

	describe('New Tab (Web → Desktop)', () => {
		it('should create new tab and return tabId', async () => {
			handler.handleMessage(client, {
				type: 'new_tab',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.newTab).toHaveBeenCalledWith('session-1');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('new_tab_result');
			expect(response.success).toBe(true);
			expect(response.tabId).toBe('new-tab-123');
		});

		it('should reject new tab with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'new_tab',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.newTab).not.toHaveBeenCalled();
		});

		it('should handle new tab creation failure', async () => {
			(callbacks.newTab as any).mockResolvedValue(null);

			handler.handleMessage(client, {
				type: 'new_tab',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
				expect(response.type).toBe('new_tab_result');
				expect(response.success).toBe(false);
			});
		});
	});

	describe('Close Tab (Web → Desktop)', () => {
		it('should close tab on desktop', async () => {
			handler.handleMessage(client, {
				type: 'close_tab',
				sessionId: 'session-1',
				tabId: 'tab-to-close',
			});

			await vi.waitFor(() => {
				expect(callbacks.closeTab).toHaveBeenCalledWith('session-1', 'tab-to-close');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('close_tab_result');
			expect(response.success).toBe(true);
		});

		it('should reject close tab with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'close_tab',
				tabId: 'tab-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
		});

		it('should reject close tab with missing tabId', () => {
			handler.handleMessage(client, {
				type: 'close_tab',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
		});
	});

	describe('Rename Tab (Web → Desktop)', () => {
		it('should rename tab on desktop', async () => {
			handler.handleMessage(client, {
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-to-rename',
				newName: 'New Tab Name',
			});

			await vi.waitFor(() => {
				expect(callbacks.renameTab).toHaveBeenCalledWith(
					'session-1',
					'tab-to-rename',
					'New Tab Name'
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('rename_tab_result');
			expect(response.success).toBe(true);
			expect(response.newName).toBe('New Tab Name');
		});

		it('should allow renaming to empty string (clear name)', async () => {
			handler.handleMessage(client, {
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
				newName: '',
			});

			await vi.waitFor(() => {
				expect(callbacks.renameTab).toHaveBeenCalledWith('session-1', 'tab-1', '');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('rename_tab_result');
			expect(response.success).toBe(true);
		});

		it('should reject rename tab with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'rename_tab',
				tabId: 'tab-1',
				newName: 'New Name',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId or tabId');
		});

		it('should reject rename tab with missing tabId', () => {
			handler.handleMessage(client, {
				type: 'rename_tab',
				sessionId: 'session-1',
				newName: 'New Name',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId or tabId');
		});
	});

	describe('Get Sessions', () => {
		it('should return sessions list with live info', () => {
			(callbacks.getLiveSessionInfo as any).mockReturnValue({
				sessionId: 'session-1',
				agentSessionId: 'live-claude-456',
				enabledAt: 123456789,
			});
			(callbacks.isSessionLive as any).mockReturnValue(true);

			handler.handleMessage(client, { type: 'get_sessions' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('sessions_list');
			expect(response.sessions).toHaveLength(1);
			expect(response.sessions[0].agentSessionId).toBe('live-claude-456');
			expect(response.sessions[0].isLive).toBe(true);
		});
	});

	describe('Unknown Message Types', () => {
		it('should echo unknown message types for debugging', () => {
			handler.handleMessage(client, {
				type: 'unknown_type',
				someData: 'test',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('echo');
			expect(response.originalType).toBe('unknown_type');
		});
	});

	describe('Callback Not Configured', () => {
		it('should handle missing executeCommand callback', () => {
			const handlerNoCallbacks = new WebSocketMessageHandler();
			handlerNoCallbacks.setCallbacks({
				getSessionDetail: vi.fn().mockReturnValue({ state: 'idle', inputMode: 'ai' }),
			});

			handlerNoCallbacks.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'test',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});

		it('should handle missing switchMode callback', () => {
			const handlerNoCallbacks = new WebSocketMessageHandler();

			handlerNoCallbacks.handleMessage(client, {
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'terminal',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});

		it('should handle missing selectSession callback', () => {
			const handlerNoCallbacks = new WebSocketMessageHandler();

			handlerNoCallbacks.handleMessage(client, {
				type: 'select_session',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});

		it('should handle missing selectTab callback', () => {
			const handlerNoCallbacks = new WebSocketMessageHandler();

			handlerNoCallbacks.handleMessage(client, {
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});
	});
});
