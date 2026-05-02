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
 * - Open file tab
 * - Refresh file tree
 * - Refresh auto-run documents
 * - Select session with focus (window foregrounding)
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
		starTab: vi.fn().mockResolvedValue(true),
		reorderTab: vi.fn().mockResolvedValue(true),
		toggleBookmark: vi.fn().mockResolvedValue(true),
		openFileTab: vi.fn().mockResolvedValue(true),
		refreshFileTree: vi.fn().mockResolvedValue(true),
		openBrowserTab: vi.fn().mockResolvedValue(true),
		openTerminalTab: vi.fn().mockResolvedValue(true),
		newAITabWithPrompt: vi.fn().mockResolvedValue({ success: true, tabId: 'tab-mock-123' }),
		refreshAutoRunDocs: vi.fn().mockResolvedValue(true),
		configureAutoRun: vi.fn().mockResolvedValue({ success: true }),
		getSessions: vi.fn().mockReturnValue([
			{
				id: 'session-1',
				name: 'Session 1',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/home/user/project',
			},
		]),
		getLiveSessionInfo: vi.fn().mockReturnValue(undefined),
		isSessionLive: vi.fn().mockReturnValue(false),
		getAutoRunDocs: vi.fn().mockResolvedValue([]),
		getAutoRunDocContent: vi.fn().mockResolvedValue(''),
		saveAutoRunDoc: vi.fn().mockResolvedValue(true),
		stopAutoRun: vi.fn().mockResolvedValue(true),
		getSettings: vi.fn().mockReturnValue({}),
		setSetting: vi.fn().mockResolvedValue(true),
		getGroups: vi.fn().mockReturnValue([]),
		createGroup: vi.fn().mockResolvedValue({ id: 'group-1' }),
		renameGroup: vi.fn().mockResolvedValue(true),
		deleteGroup: vi.fn().mockResolvedValue(true),
		moveSessionToGroup: vi.fn().mockResolvedValue(true),
		createSession: vi.fn().mockResolvedValue({ sessionId: 'new-session-1' }),
		deleteSession: vi.fn().mockResolvedValue(true),
		renameSession: vi.fn().mockResolvedValue(true),
		getGitStatus: vi.fn().mockResolvedValue({ files: [], branch: 'main' }),
		getGitDiff: vi.fn().mockResolvedValue({ diff: '' }),
		getGroupChats: vi.fn().mockResolvedValue([]),
		startGroupChat: vi.fn().mockResolvedValue({ chatId: 'chat-1' }),
		getGroupChatState: vi.fn().mockResolvedValue(null),
		stopGroupChat: vi.fn().mockResolvedValue(true),
		sendGroupChatMessage: vi.fn().mockResolvedValue(true),
		mergeContext: vi.fn().mockResolvedValue(true),
		transferContext: vi.fn().mockResolvedValue(true),
		summarizeContext: vi.fn().mockResolvedValue(true),
		createGist: vi.fn().mockResolvedValue({ success: true, gistUrl: 'https://gist.example' }),
		getCueSubscriptions: vi.fn().mockResolvedValue([]),
		toggleCueSubscription: vi.fn().mockResolvedValue(true),
		getCueActivity: vi.fn().mockResolvedValue([]),
		triggerCueSubscription: vi.fn().mockResolvedValue(true),
		getUsageDashboard: vi.fn().mockResolvedValue({}),
		getAchievements: vi.fn().mockResolvedValue([]),
		writeToTerminal: vi.fn().mockReturnValue(true),
		resizeTerminal: vi.fn().mockReturnValue(true),
		spawnTerminalForWeb: vi.fn().mockResolvedValue({ success: true, pid: 123 }),
		killTerminalForWeb: vi.fn().mockReturnValue(true),
		notifyToast: vi.fn().mockResolvedValue(true),
		notifyCenterFlash: vi.fn().mockResolvedValue(true),
		listDesktopSessions: vi.fn().mockReturnValue([]),
		getSessionHistory: vi.fn().mockReturnValue(null),
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
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'Hello Claude!',
					'ai',
					undefined,
					false
				);
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
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'ls -la',
					'terminal',
					undefined,
					false
				);
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

		it('omits tabId from command_result on the no-tabId path so callers do not chain to a stale snapshot', async () => {
			// The server's `activeTabId` snapshot can diverge from the renderer's
			// actual write target if the user switches tabs between IPC send and
			// receive. Echoing it would mislead `dispatch --session <returnedTabId>`
			// callers chaining a follow-up. We only echo when the caller passed an
			// explicit, authoritative tabId.
			(callbacks.getSessionDetail as any).mockReturnValue({
				state: 'idle',
				inputMode: 'ai',
				activeTabId: 'tab-active-77',
			});

			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Hello',
				inputMode: 'ai',
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalled();
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('command_result');
			expect(response.success).toBe(true);
			expect(response.tabId).toBeUndefined();
		});

		it('forwards an explicit tabId to the executeCommand callback and echoes it in command_result', async () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Hello',
				inputMode: 'ai',
				tabId: 'tab-explicit',
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'Hello',
					'ai',
					'tab-explicit',
					false
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('command_result');
			expect(response.tabId).toBe('tab-explicit');
		});

		it('should bypass busy guard and forward command when force=true', async () => {
			(callbacks.getSessionDetail as any).mockReturnValue({ state: 'busy', inputMode: 'ai' });

			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'concurrent write',
				inputMode: 'ai',
				force: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'concurrent write',
					'ai',
					undefined,
					true
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('command_result');
			expect(response.success).toBe(true);
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
				expect(callbacks.selectSession).toHaveBeenCalledWith('session-2', undefined, undefined);
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
				expect(callbacks.selectSession).toHaveBeenCalledWith('session-2', 'tab-5', undefined);
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

	describe('Open File Tab (Web → Desktop)', () => {
		it('should forward open file tab to desktop with sessionId and filePath', async () => {
			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
				filePath: '/home/user/project/src/index.ts',
			});

			await vi.waitFor(() => {
				expect(callbacks.openFileTab).toHaveBeenCalledWith(
					'session-1',
					'/home/user/project/src/index.ts'
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_file_tab_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
			expect(response.filePath).toBe('/home/user/project/src/index.ts');
		});

		it('should reject open file tab with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'open_file_tab',
				filePath: '/home/user/project/src/index.ts',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_file_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or filePath');
			expect(callbacks.openFileTab).not.toHaveBeenCalled();
		});

		it('should reject open file tab with missing filePath', () => {
			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_file_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or filePath');
			expect(callbacks.openFileTab).not.toHaveBeenCalled();
		});

		it('should handle open file tab callback failure', async () => {
			(callbacks.openFileTab as any).mockRejectedValue(new Error('File not found'));

			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
				filePath: '/home/user/project/nonexistent/file.ts',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('open_file_tab_result');
				expect(lastResponse.success).toBe(false);
				expect(lastResponse.error).toContain('File not found');
			});
		});

		it('should reject path traversal attempts', () => {
			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
				filePath: '/home/user/project/../../etc/passwd',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_file_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid file path');
			expect(callbacks.openFileTab).not.toHaveBeenCalled();
		});
	});

	describe('Open Browser Tab (Web → Desktop)', () => {
		it('should forward open browser tab with sessionId and url', async () => {
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'session-1',
				url: 'https://example.com/',
			});

			await vi.waitFor(() => {
				expect(callbacks.openBrowserTab).toHaveBeenCalledWith('session-1', 'https://example.com/');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_browser_tab_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
			expect(response.url).toBe('https://example.com/');
		});

		it('should reject missing sessionId or url', () => {
			handler.handleMessage(client, { type: 'open_browser_tab', sessionId: 'session-1' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_browser_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or url');
			expect(callbacks.openBrowserTab).not.toHaveBeenCalled();
		});

		it('should reject invalid URL', () => {
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'session-1',
				url: 'not a url',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_browser_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid URL');
			expect(callbacks.openBrowserTab).not.toHaveBeenCalled();
		});

		it('should reject non-http(s) protocols', () => {
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'session-1',
				url: 'file:///etc/passwd',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_browser_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Unsupported URL protocol');
			expect(callbacks.openBrowserTab).not.toHaveBeenCalled();
		});

		it('should normalize bare host:port as http://', async () => {
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'session-1',
				url: 'localhost:3000',
			});

			await vi.waitFor(() => {
				expect(callbacks.openBrowserTab).toHaveBeenCalledWith(
					'session-1',
					'http://localhost:3000/'
				);
			});
		});

		it('should reject when session does not exist', () => {
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'ghost-session',
				url: 'https://example.com/',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_browser_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toBe('Session not found');
			expect(callbacks.openBrowserTab).not.toHaveBeenCalled();
		});

		it('should handle callback failure', async () => {
			(callbacks.openBrowserTab as any).mockRejectedValue(new Error('boom'));
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'session-1',
				url: 'https://example.com/',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('open_browser_tab_result');
				expect(lastResponse.success).toBe(false);
				expect(lastResponse.error).toContain('boom');
			});
		});
	});

	describe('Open Terminal Tab (Web → Desktop)', () => {
		it('should forward open terminal tab with sessionId', async () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.openTerminalTab).toHaveBeenCalledWith('session-1', {
					cwd: undefined,
					shell: undefined,
					name: undefined,
				});
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
		});

		it('should forward optional shell and name', async () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				shell: 'bash',
				name: 'build logs',
			});

			await vi.waitFor(() => {
				expect(callbacks.openTerminalTab).toHaveBeenCalledWith('session-1', {
					cwd: undefined,
					shell: 'bash',
					name: 'build logs',
				});
			});
		});

		it('should reject cwd outside the agent working directory', async () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				cwd: '/home/user/project/../../etc',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('open_terminal_tab_result');
				expect(lastResponse.success).toBe(false);
				expect(lastResponse.error).toContain('Invalid cwd');
			});
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});

		describe('symlink-safe cwd confinement', () => {
			let sessionRoot: string;
			let outside: string;
			const createdPaths: string[] = [];

			beforeEach(() => {
				const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-openterm-'));
				sessionRoot = fs.mkdtempSync(path.join(tmpBase, 'root-'));
				outside = fs.mkdtempSync(path.join(tmpBase, 'outside-'));
				fs.mkdirSync(path.join(sessionRoot, 'sub'));
				fs.symlinkSync(outside, path.join(sessionRoot, 'link-to-outside'));
				createdPaths.push(tmpBase);

				(callbacks.getSessions as any).mockReturnValue([
					{
						id: 'session-real',
						name: 'Real Session',
						toolType: 'claude-code',
						state: 'idle',
						inputMode: 'ai',
						cwd: sessionRoot,
					},
				]);
			});

			afterAll(() => {
				for (const p of createdPaths) {
					try {
						fs.rmSync(p, { recursive: true, force: true });
					} catch {
						// best-effort cleanup
					}
				}
			});

			it('should allow a real subdirectory of the session root', async () => {
				handler.handleMessage(client, {
					type: 'open_terminal_tab',
					sessionId: 'session-real',
					cwd: 'sub',
				});

				await vi.waitFor(() => {
					expect(callbacks.openTerminalTab).toHaveBeenCalledWith(
						'session-real',
						expect.objectContaining({
							cwd: fs.realpathSync(path.join(sessionRoot, 'sub')),
						})
					);
				});
			});

			it('should reject a symlink pointing outside the session root', async () => {
				handler.handleMessage(client, {
					type: 'open_terminal_tab',
					sessionId: 'session-real',
					cwd: 'link-to-outside',
				});

				await vi.waitFor(() => {
					const calls = (client.socket.send as any).mock.calls;
					const lastResponse = JSON.parse(calls[calls.length - 1][0]);
					expect(lastResponse.type).toBe('open_terminal_tab_result');
					expect(lastResponse.success).toBe(false);
					expect(lastResponse.error).toContain('outside the agent working directory');
				});
				expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
			});
		});

		it('should reject missing sessionId', () => {
			handler.handleMessage(client, { type: 'open_terminal_tab' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId');
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});

		it('should reject when session does not exist', () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'ghost-session',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toBe('Session not found');
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});

		it('should reject non-string cwd', () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				cwd: 42 as unknown as string,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid cwd');
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});

		it('should reject non-string shell', () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				shell: true as unknown as string,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid shell');
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});

		it('should reject non-string/non-null name', () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				name: 123 as unknown as string,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid name');
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});
	});

	describe('New AI Tab With Prompt (Web → Desktop)', () => {
		it('should forward sessionId and prompt to callback', async () => {
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 'Summarize the repo',
			});

			await vi.waitFor(() => {
				expect(callbacks.newAITabWithPrompt).toHaveBeenCalledWith(
					'session-1',
					'Summarize the repo'
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('new_ai_tab_with_prompt_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
			// PR1: surface the freshly-created tabId so `dispatch --new-tab`
			// can return an addressable id without owning a persistent channel.
			expect(response.tabId).toBe('tab-mock-123');
		});

		it('should reject missing sessionId', () => {
			handler.handleMessage(client, { type: 'new_ai_tab_with_prompt', prompt: 'hello' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('new_ai_tab_with_prompt_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or prompt');
			expect(callbacks.newAITabWithPrompt).not.toHaveBeenCalled();
		});

		it('should reject missing prompt', () => {
			handler.handleMessage(client, { type: 'new_ai_tab_with_prompt', sessionId: 'session-1' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('new_ai_tab_with_prompt_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or prompt');
			expect(callbacks.newAITabWithPrompt).not.toHaveBeenCalled();
		});

		it('should reject non-string prompt without throwing', () => {
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 42 as unknown as string,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('new_ai_tab_with_prompt_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Missing sessionId or prompt');
			expect(callbacks.newAITabWithPrompt).not.toHaveBeenCalled();
		});

		it('should reject when session does not exist', () => {
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'ghost-session',
				prompt: 'hello',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('new_ai_tab_with_prompt_result');
			expect(response.success).toBe(false);
			expect(response.error).toBe('Session not found');
			expect(callbacks.newAITabWithPrompt).not.toHaveBeenCalled();
		});

		it('should handle callback failure', async () => {
			(callbacks.newAITabWithPrompt as any).mockRejectedValue(new Error('boom'));
			handler.handleMessage(client, {
				type: 'new_ai_tab_with_prompt',
				sessionId: 'session-1',
				prompt: 'hello',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('new_ai_tab_with_prompt_result');
				expect(lastResponse.success).toBe(false);
				expect(lastResponse.error).toContain('boom');
			});
		});
	});

	describe('Refresh File Tree (Web → Desktop)', () => {
		it('should forward refresh file tree to desktop', async () => {
			handler.handleMessage(client, {
				type: 'refresh_file_tree',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.refreshFileTree).toHaveBeenCalledWith('session-1');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('refresh_file_tree_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
		});

		it('should reject refresh file tree with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'refresh_file_tree',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId');
			expect(callbacks.refreshFileTree).not.toHaveBeenCalled();
		});

		it('should handle refresh file tree callback failure', async () => {
			(callbacks.refreshFileTree as any).mockRejectedValue(new Error('Tree refresh failed'));

			handler.handleMessage(client, {
				type: 'refresh_file_tree',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('error');
				expect(lastResponse.message).toContain('Tree refresh failed');
			});
		});
	});

	describe('Refresh Auto Run Docs (Web → Desktop)', () => {
		it('should forward refresh auto run docs to desktop', async () => {
			handler.handleMessage(client, {
				type: 'refresh_auto_run_docs',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.refreshAutoRunDocs).toHaveBeenCalledWith('session-1');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('refresh_auto_run_docs_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
		});

		it('should reject refresh auto run docs with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'refresh_auto_run_docs',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId');
			expect(callbacks.refreshAutoRunDocs).not.toHaveBeenCalled();
		});

		it('should handle refresh auto run docs callback failure', async () => {
			(callbacks.refreshAutoRunDocs as any).mockRejectedValue(new Error('Auto-run refresh failed'));

			handler.handleMessage(client, {
				type: 'refresh_auto_run_docs',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('error');
				expect(lastResponse.message).toContain('Auto-run refresh failed');
			});
		});
	});

	describe('Configure Auto Run (Web → Desktop)', () => {
		it('should forward configure auto run with valid config', async () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }, { filename: 'doc2.md', resetOnCompletion: true }],
				prompt: 'Custom prompt',
				loopEnabled: true,
				maxLoops: 3,
				launch: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.configureAutoRun).toHaveBeenCalledWith('session-1', {
					documents: [{ filename: 'doc1.md' }, { filename: 'doc2.md', resetOnCompletion: true }],
					prompt: 'Custom prompt',
					loopEnabled: true,
					maxLoops: 3,
					saveAsPlaybook: undefined,
					launch: true,
					worktree: undefined,
				});
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('configure_auto_run_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
		});

		it('should reject configure auto run with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				documents: [{ filename: 'doc1.md' }],
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should reject configure auto run with missing documents', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('documents');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should reject configure auto run with empty documents array', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [],
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('documents');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should forward configure auto run with saveAsPlaybook', async () => {
			(callbacks.configureAutoRun as any).mockResolvedValue({
				success: true,
				playbookId: 'pb-123',
			});

			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				saveAsPlaybook: 'My Playbook',
			});

			await vi.waitFor(() => {
				expect(callbacks.configureAutoRun).toHaveBeenCalledWith('session-1', {
					documents: [{ filename: 'doc1.md' }],
					prompt: undefined,
					loopEnabled: undefined,
					maxLoops: undefined,
					saveAsPlaybook: 'My Playbook',
					launch: undefined,
					worktree: undefined,
				});
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('configure_auto_run_result');
			expect(response.success).toBe(true);
			expect(response.playbookId).toBe('pb-123');
		});

		it('should handle configure auto run callback failure', async () => {
			(callbacks.configureAutoRun as any).mockRejectedValue(
				new Error('Auto-run configuration failed')
			);

			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse.type).toBe('error');
				expect(lastResponse.message).toContain('Auto-run configuration failed');
			});
		});

		it('should forward configure auto run with worktree config', async () => {
			(callbacks.configureAutoRun as any).mockResolvedValue({ success: true });

			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				launch: true,
				worktree: {
					enabled: true,
					path: '/tmp/worktree',
					branchName: 'feature/auto-run',
					createPROnCompletion: true,
					prTargetBranch: 'main',
				},
			});

			await vi.waitFor(() => {
				expect(callbacks.configureAutoRun).toHaveBeenCalledWith('session-1', {
					documents: [{ filename: 'doc1.md' }],
					prompt: undefined,
					loopEnabled: undefined,
					maxLoops: undefined,
					saveAsPlaybook: undefined,
					launch: true,
					worktree: {
						enabled: true,
						path: '/tmp/worktree',
						branchName: 'feature/auto-run',
						createPROnCompletion: true,
						prTargetBranch: 'main',
					},
				});
			});
		});

		it('should reject worktree missing required fields', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				launch: true,
				worktree: { enabled: true, path: '/tmp/wt', branchName: '' },
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('worktree.branchName');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should reject non-object worktree', () => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				launch: true,
				worktree: 'not-an-object',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('worktree must be an object');
			expect(callbacks.configureAutoRun).not.toHaveBeenCalled();
		});

		it('should handle missing configureAutoRun callback', () => {
			const handlerNoCallbacks = new WebSocketMessageHandler();
			handlerNoCallbacks.setCallbacks({
				getSessionDetail: vi.fn(),
			});

			handlerNoCallbacks.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});
	});

	describe('Select Session with Focus (Web → Desktop)', () => {
		it('should forward session selection with focus flag', async () => {
			handler.handleMessage(client, {
				type: 'select_session',
				sessionId: 'session-2',
				focus: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.selectSession).toHaveBeenCalledWith('session-2', undefined, true);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('select_session_result');
			expect(response.success).toBe(true);
		});

		it('should forward session selection with focus and tabId', async () => {
			handler.handleMessage(client, {
				type: 'select_session',
				sessionId: 'session-2',
				tabId: 'tab-3',
				focus: true,
			});

			await vi.waitFor(() => {
				expect(callbacks.selectSession).toHaveBeenCalledWith('session-2', 'tab-3', true);
			});
		});

		it('should forward session selection without focus flag', async () => {
			handler.handleMessage(client, {
				type: 'select_session',
				sessionId: 'session-2',
			});

			await vi.waitFor(() => {
				expect(callbacks.selectSession).toHaveBeenCalledWith('session-2', undefined, undefined);
			});
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

	describe('File Tree Path Traversal Protection', () => {
		it('should reject get_file_tree when session has no cwd', () => {
			callbacks.getSessionDetail = vi.fn().mockReturnValue(null);
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, {
				type: 'get_file_tree',
				sessionId: 'session-1',
				path: '/etc/passwd',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Cannot resolve session working directory');
		});

		it('should reject get_file_tree when sessionId is empty', () => {
			callbacks.getSessionDetail = vi.fn().mockReturnValue(null);
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, {
				type: 'get_file_tree',
				sessionId: '',
				path: '/',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Cannot resolve session working directory');
		});

		it('should reject get_file_tree for path outside session cwd', () => {
			callbacks.getSessionDetail = vi.fn().mockReturnValue({
				state: 'idle',
				inputMode: 'ai',
				cwd: '/home/user/project',
			});
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, {
				type: 'get_file_tree',
				sessionId: 'session-1',
				path: '/etc',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('outside the session working directory');
		});
	});

	describe('Terminal Session Ownership', () => {
		it('should reject terminal_write when client is not subscribed to session', () => {
			client.subscribedSessionId = 'other-session';

			handler.handleMessage(client, {
				type: 'terminal_write',
				sessionId: 'session-1',
				data: 'ls\r',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('terminal_write_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Not subscribed');
		});

		it('should reject terminal_resize when client is not subscribed to session', () => {
			client.subscribedSessionId = 'other-session';

			handler.handleMessage(client, {
				type: 'terminal_resize',
				sessionId: 'session-1',
				cols: 80,
				rows: 24,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('terminal_resize_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Not subscribed');
		});

		it('should allow terminal_write when client is subscribed to the session', () => {
			client.subscribedSessionId = 'session-1';

			handler.handleMessage(client, {
				type: 'terminal_write',
				sessionId: 'session-1',
				data: 'ls\r',
			});

			expect(callbacks.writeToTerminal).toHaveBeenCalledWith('session-1', 'ls\r');
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('terminal_write_result');
			expect(response.success).toBe(true);
		});

		it('should allow terminal_resize when client is subscribed to the session', () => {
			client.subscribedSessionId = 'session-1';

			handler.handleMessage(client, {
				type: 'terminal_resize',
				sessionId: 'session-1',
				cols: 120,
				rows: 40,
			});

			expect(callbacks.resizeTerminal).toHaveBeenCalledWith('session-1', 120, 40);
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('terminal_resize_result');
			expect(response.success).toBe(true);
		});
	});

	describe('Trigger Cue Subscription (sourceAgentId)', () => {
		it('should pass sourceAgentId through to triggerCueSubscription callback', async () => {
			handler.handleMessage(client, {
				type: 'trigger_cue_subscription',
				subscriptionName: 'my-sub',
				sourceAgentId: 'agent-xyz-123',
			});

			await vi.waitFor(() => {
				expect(callbacks.triggerCueSubscription).toHaveBeenCalledWith(
					'my-sub',
					undefined,
					'agent-xyz-123'
				);
			});
		});

		it('should pass prompt and sourceAgentId together', async () => {
			handler.handleMessage(client, {
				type: 'trigger_cue_subscription',
				subscriptionName: 'my-sub',
				prompt: 'custom prompt',
				sourceAgentId: 'agent-abc',
			});

			await vi.waitFor(() => {
				expect(callbacks.triggerCueSubscription).toHaveBeenCalledWith(
					'my-sub',
					'custom prompt',
					'agent-abc'
				);
			});
		});

		it('should pass undefined sourceAgentId when not provided', async () => {
			handler.handleMessage(client, {
				type: 'trigger_cue_subscription',
				subscriptionName: 'my-sub',
			});

			await vi.waitFor(() => {
				expect(callbacks.triggerCueSubscription).toHaveBeenCalledWith(
					'my-sub',
					undefined,
					undefined
				);
			});
		});

		it('should return trigger_cue_subscription_result on success', async () => {
			handler.handleMessage(client, {
				type: 'trigger_cue_subscription',
				subscriptionName: 'my-sub',
				sourceAgentId: 'agent-xyz',
			});

			await vi.waitFor(() => {
				expect(client.socket.send).toHaveBeenCalled();
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('trigger_cue_subscription_result');
			expect(response.success).toBe(true);
			expect(response.subscriptionName).toBe('my-sub');
		});

		it('should reject missing subscriptionName', () => {
			handler.handleMessage(client, {
				type: 'trigger_cue_subscription',
				sourceAgentId: 'agent-xyz',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.triggerCueSubscription).not.toHaveBeenCalled();
		});
	});

	describe('Create Gist', () => {
		it('replies with create_gist_result on success', async () => {
			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
				description: 'My gist',
				isPublic: false,
			});

			await vi.waitFor(() => {
				expect(callbacks.createGist).toHaveBeenCalledWith('session-1', 'My gist', false);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('create_gist_result');
			expect(response.success).toBe(true);
			expect(response.gistUrl).toBe('https://gist.example');
		});

		it('defaults description to "" and isPublic to false when omitted', async () => {
			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.createGist).toHaveBeenCalledWith('session-1', '', false);
			});
		});

		it('replies with create_gist_result (not error) when sessionId is missing', () => {
			handler.handleMessage(client, { type: 'create_gist' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('create_gist_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('sessionId');
			expect(callbacks.createGist).not.toHaveBeenCalled();
		});

		it('rejects non-boolean isPublic to prevent private→public leaks', () => {
			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
				isPublic: 'false',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('create_gist_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('isPublic');
			expect(callbacks.createGist).not.toHaveBeenCalled();
		});

		it('surfaces rejected callback errors as create_gist_result', async () => {
			(callbacks.createGist as any).mockRejectedValue(new Error('boom'));

			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				expect(client.socket.send).toHaveBeenCalled();
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('create_gist_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('boom');
		});

		it('replies with create_gist_result when createGist callback is unconfigured', () => {
			callbacks.createGist = undefined;
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, {
				type: 'create_gist',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('create_gist_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('not configured');
		});
	});

	// PR2 of the CLI surface refactor: read-only session inspection used by
	// `maestro-cli session list` and `session show <tabId>`. The handlers here
	// are deliberately stateless so external pollers (Maestro-Discord, Cue
	// follow-ups) can call them at arbitrary cadence.
	describe('List Desktop Sessions (CLI → Desktop)', () => {
		it('returns the desktop_sessions_list payload from the callback', () => {
			(callbacks.listDesktopSessions as any).mockReturnValue([
				{
					tabId: 'tab-1',
					sessionId: 'tab-1',
					agentId: 'agent-a',
					agentName: 'Backend',
					toolType: 'claude-code',
					name: 'Refactor parser',
					agentSessionId: 'claude-uuid-1',
					state: 'idle',
					createdAt: 1714268000000,
					starred: false,
				},
			]);

			handler.handleMessage(client, { type: 'list_desktop_sessions', requestId: 'req-1' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('desktop_sessions_list');
			expect(response.success).toBe(true);
			expect(response.sessions).toHaveLength(1);
			expect(response.sessions[0].tabId).toBe('tab-1');
			expect(response.requestId).toBe('req-1');
		});

		it('returns an empty list when the callback is unconfigured rather than echoing', () => {
			// Unknown-type echo would confuse the CLI's request/response pairing
			// (`MaestroClient` matches by responseType). Returning the empty
			// success shape keeps the wire contract intact even when the desktop
			// hasn't wired up the callback yet — older builds on a newer CLI.
			callbacks.listDesktopSessions = undefined;
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, { type: 'list_desktop_sessions', requestId: 'req-1' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('desktop_sessions_list');
			expect(response.success).toBe(true);
			expect(response.sessions).toEqual([]);
		});
	});

	describe('Get Session History (CLI → Desktop)', () => {
		const mockHistory = {
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: 'claude-uuid-1',
			messages: [
				{
					id: 'log-1',
					role: 'user' as const,
					source: 'user',
					content: 'Hello',
					timestamp: '2026-04-28T10:00:00.000Z',
				},
			],
		};

		it('forwards tabId / sinceMs / tail to the callback and returns the result', () => {
			(callbacks.getSessionHistory as any).mockReturnValue(mockHistory);

			handler.handleMessage(client, {
				type: 'get_session_history',
				tabId: 'tab-1',
				sinceMs: 1714268000000,
				tail: 5,
				requestId: 'req-2',
			});

			expect(callbacks.getSessionHistory).toHaveBeenCalledWith('tab-1', {
				sinceMs: 1714268000000,
				tail: 5,
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('session_history_result');
			expect(response.success).toBe(true);
			expect(response.tabId).toBe('tab-1');
			expect(response.messages).toHaveLength(1);
			expect(response.requestId).toBe('req-2');
		});

		it('emits MISSING_TAB_ID when tabId is omitted', () => {
			handler.handleMessage(client, {
				type: 'get_session_history',
				requestId: 'req-2',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('session_history_result');
			expect(response.success).toBe(false);
			expect(response.code).toBe('MISSING_TAB_ID');
			expect(callbacks.getSessionHistory).not.toHaveBeenCalled();
		});

		it('emits TAB_NOT_FOUND when the desktop has no matching tab', () => {
			(callbacks.getSessionHistory as any).mockReturnValue(null);

			handler.handleMessage(client, {
				type: 'get_session_history',
				tabId: 'tab-bogus',
				requestId: 'req-3',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('session_history_result');
			expect(response.success).toBe(false);
			expect(response.code).toBe('TAB_NOT_FOUND');
		});

		it('coerces a negative tail to undefined rather than passing it through', () => {
			// Negative tail would silently invert `slice(-N)` semantics on the
			// desktop side ("everything except the last N" instead of "last N").
			// Drop it at the boundary so a buggy caller can never poison the
			// desktop's read.
			(callbacks.getSessionHistory as any).mockReturnValue(mockHistory);

			handler.handleMessage(client, {
				type: 'get_session_history',
				tabId: 'tab-1',
				tail: -3,
			});

			expect(callbacks.getSessionHistory).toHaveBeenCalledWith('tab-1', {
				sinceMs: undefined,
				tail: undefined,
			});
		});
	});
});
