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

function getLastResponse(client: WebClient): Record<string, any> {
	const calls = (client.socket.send as any).mock.calls;
	return JSON.parse(calls[calls.length - 1][0]);
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
		setSessionAutoRunFolder: vi.fn().mockResolvedValue({ success: true }),
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
		createWorktreeSession: vi
			.fn()
			.mockResolvedValue({ success: true, sessionId: 'new-worktree-1' }),
		deleteSession: vi.fn().mockResolvedValue(true),
		renameSession: vi.fn().mockResolvedValue(true),
		updateSessionCwd: vi.fn().mockResolvedValue({ success: true }),
		updateSessionSsh: vi.fn().mockResolvedValue({ success: true }),
		getGitStatus: vi.fn().mockResolvedValue({ files: [], branch: 'main' }),
		getGitDiff: vi.fn().mockResolvedValue({ diff: '' }),
		getGitBranchesForSession: vi
			.fn()
			.mockResolvedValue({ branches: ['main', 'feature/x'], currentBranch: 'main' }),
		listWorktreesForSession: vi.fn().mockResolvedValue({ worktrees: [] }),
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
		listCuePipelines: vi.fn().mockResolvedValue({ pipelines: [] }),
		getCuePipeline: vi.fn().mockResolvedValue(null),
		setCuePipeline: vi.fn().mockResolvedValue({ ok: true }),
		removeCuePipeline: vi.fn().mockResolvedValue({ ok: true }),
		getUsageDashboard: vi.fn().mockResolvedValue({}),
		getAchievements: vi.fn().mockResolvedValue([]),
		generateDirectorNotesSynopsis: vi.fn().mockResolvedValue({
			success: true,
			synopsis: '# Director Notes',
			generatedAt: 123,
			stats: { agentCount: 1, entryCount: 2, durationMs: 3 },
		}),
		writeToTerminal: vi.fn().mockReturnValue(true),
		resizeTerminal: vi.fn().mockReturnValue(true),
		spawnTerminalForWeb: vi.fn().mockResolvedValue({ success: true, pid: 123 }),
		killTerminalForWeb: vi.fn().mockReturnValue(true),
		// Auto Run parity additions (playbook CRUD + task reset + error recovery)
		resetAutoRunDocTasks: vi.fn().mockResolvedValue(true),
		resumeAutoRunError: vi.fn().mockResolvedValue(true),
		skipAutoRunDocument: vi.fn().mockResolvedValue(true),
		abortAutoRunError: vi.fn().mockResolvedValue(true),
		listPlaybooks: vi.fn().mockResolvedValue([]),
		createPlaybook: vi.fn().mockResolvedValue({
			id: 'pb-1',
			name: 'My Playbook',
			createdAt: 0,
			updatedAt: 0,
			documents: [],
			loopEnabled: false,
			prompt: '',
		}),
		updatePlaybook: vi.fn().mockResolvedValue({
			id: 'pb-1',
			name: 'My Playbook',
			createdAt: 0,
			updatedAt: 0,
			documents: [],
			loopEnabled: false,
			prompt: '',
		}),
		deletePlaybook: vi.fn().mockResolvedValue(true),
		notifyToast: vi.fn().mockResolvedValue(true),
		notifyCenterFlash: vi.fn().mockResolvedValue(true),
		getMarketplaceManifest: vi.fn().mockResolvedValue({
			manifest: { lastUpdated: '2026-01-01', playbooks: [] },
			fromCache: false,
		}),
		getMarketplaceDocument: vi.fn().mockResolvedValue({ content: '# doc' }),
		getMarketplaceReadme: vi.fn().mockResolvedValue({ content: '# readme' }),
		importMarketplacePlaybook: vi.fn().mockResolvedValue({
			success: true,
			playbook: {
				id: 'p1',
				name: 'Sample',
				createdAt: 0,
				updatedAt: 0,
				documents: [],
				loopEnabled: false,
				prompt: '',
			},
			importedDocs: [],
			importedAssets: [],
		}),
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
					false,
					undefined
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
					false,
					undefined
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
					false,
					undefined
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('command_result');
			expect(response.tabId).toBe('tab-explicit');
		});

		it('accepts image-only sends in AI mode (no command, images present)', async () => {
			// The web composer allows submitting in AI mode when only images
			// are staged (no typed text). The server must not reject those
			// requests as "missing command" — instead it forwards an empty
			// command alongside the images so the renderer can attach them
			// to a default image-only prompt.
			const images = ['data:image/png;base64,abc'];
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				inputMode: 'ai',
				images,
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'',
					'ai',
					undefined,
					false,
					images
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('command_result');
			expect(response.success).toBe(true);
		});

		it('rejects send with neither command nor images', () => {
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				inputMode: 'ai',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.executeCommand).not.toHaveBeenCalled();
		});

		it('forwards pasted images so the renderer can attach them to the prompt', async () => {
			const images = ['data:image/png;base64,abc', 'data:image/png;base64,def'];
			handler.handleMessage(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'look at this',
				inputMode: 'ai',
				images,
			});

			await vi.waitFor(() => {
				expect(callbacks.executeCommand).toHaveBeenCalledWith(
					'session-1',
					'look at this',
					'ai',
					undefined,
					false,
					images
				);
			});
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
					true,
					undefined
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

		it('should report terminal mode failure when PTY spawn returns false', async () => {
			(callbacks.spawnTerminalForWeb as any).mockResolvedValue({ success: false, pid: 0 });

			handler.handleMessage(client, {
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'terminal',
				requestId: 'switch-1',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse).toEqual(
					expect.objectContaining({
						type: 'mode_switch_result',
						success: false,
						sessionId: 'session-1',
						mode: 'terminal',
						error: 'Failed to spawn terminal PTY',
						requestId: 'switch-1',
					})
				);
			});
		});

		it('should report terminal mode failure when PTY spawn throws', async () => {
			(callbacks.spawnTerminalForWeb as any).mockRejectedValue(new Error('spawn denied'));

			handler.handleMessage(client, {
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'terminal',
				requestId: 'switch-2',
			});

			await vi.waitFor(() => {
				const calls = (client.socket.send as any).mock.calls;
				const lastResponse = JSON.parse(calls[calls.length - 1][0]);
				expect(lastResponse).toEqual(
					expect.objectContaining({
						type: 'mode_switch_result',
						success: false,
						error: 'Failed to spawn terminal: spawn denied',
						requestId: 'switch-2',
					})
				);
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
					'/home/user/project/src/index.ts',
					true
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_file_tab_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
			expect(response.filePath).toBe('/home/user/project/src/index.ts');
		});

		it('should forward switchToAgent=false when --no-switch is used', async () => {
			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
				filePath: '/home/user/project/src/index.ts',
				switchToAgent: false,
			});

			await vi.waitFor(() => {
				expect(callbacks.openFileTab).toHaveBeenCalledWith(
					'session-1',
					'/home/user/project/src/index.ts',
					false
				);
			});
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

		it('should forward paths that resolve outside the worktree', async () => {
			// Opening files outside the worktree is intentionally allowed — a paired
			// client already has shell-level access (execute_command), so confining
			// preview tabs to the worktree gated nothing the connection token didn't.
			handler.handleMessage(client, {
				type: 'open_file_tab',
				sessionId: 'session-1',
				filePath: '/home/user/project/../../etc/passwd',
			});

			await vi.waitFor(() => {
				expect(callbacks.openFileTab).toHaveBeenCalledWith('session-1', '/home/etc/passwd', true);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_file_tab_result');
			expect(response.success).toBe(true);
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

		it('should reject bare userinfo-looking host inputs', () => {
			handler.handleMessage(client, {
				type: 'open_browser_tab',
				sessionId: 'session-1',
				url: 'user:pass@example.com',
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

		it('should reject cwd when the session has no working directory', () => {
			(callbacks.getSessions as any).mockReturnValue([
				{
					id: 'session-1',
					name: 'Session 1',
					toolType: 'claude-code',
					state: 'idle',
					inputMode: 'ai',
				},
			]);

			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				cwd: 'subdir',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('open_terminal_tab_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('no working directory');
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});

		it('should reject cwd when realpath resolution fails', async () => {
			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				cwd: 'missing-subdir',
			});

			await vi.waitFor(() => {
				const response = getLastResponse(client);
				expect(response.type).toBe('open_terminal_tab_result');
				expect(response.success).toBe(false);
				expect(response.error).toContain('Invalid cwd');
			});
			expect(callbacks.openTerminalTab).not.toHaveBeenCalled();
		});

		it('should handle open terminal tab callback failure', async () => {
			(callbacks.openTerminalTab as any).mockRejectedValue(new Error('terminal boom'));

			handler.handleMessage(client, {
				type: 'open_terminal_tab',
				sessionId: 'session-1',
			});

			await vi.waitFor(() => {
				const response = getLastResponse(client);
				expect(response.type).toBe('open_terminal_tab_result');
				expect(response.success).toBe(false);
				expect(response.error).toContain('terminal boom');
			});
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

		it.each([
			['non-object document', { documents: [null] }, 'Each document must be an object'],
			[
				'blank filename',
				{ documents: [{ filename: '   ' }] },
				'Each document must have a non-empty string filename',
			],
			[
				'invalid resetOnCompletion',
				{ documents: [{ filename: 'doc1.md', resetOnCompletion: 'yes' }] },
				'resetOnCompletion must be a boolean',
			],
			['invalid loopEnabled', { loopEnabled: 'yes' }, 'loopEnabled must be a boolean'],
			['invalid maxLoops', { maxLoops: -1 }, 'maxLoops must be a finite non-negative number'],
			['invalid launch', { launch: 'yes' }, 'launch must be a boolean'],
			[
				'blank saveAsPlaybook',
				{ saveAsPlaybook: '   ' },
				'saveAsPlaybook must be a non-empty string',
			],
			[
				'invalid worktree.enabled',
				{ worktree: { enabled: 'yes', path: '/tmp/wt', branchName: 'feature/wt' } },
				'worktree.enabled must be a boolean',
			],
			[
				'invalid worktree.path',
				{ worktree: { enabled: true, path: '', branchName: 'feature/wt' } },
				'worktree.path must be a non-empty string',
			],
			[
				'invalid worktree.baseBranch',
				{ worktree: { enabled: true, path: '/tmp/wt', branchName: 'feature/wt', baseBranch: 123 } },
				'worktree.baseBranch must be a string',
			],
			[
				'invalid worktree.createPROnCompletion',
				{
					worktree: {
						enabled: true,
						path: '/tmp/wt',
						branchName: 'feature/wt',
						createPROnCompletion: 'yes',
					},
				},
				'worktree.createPROnCompletion must be a boolean',
			],
			[
				'invalid worktree.prTargetBranch',
				{
					worktree: {
						enabled: true,
						path: '/tmp/wt',
						branchName: 'feature/wt',
						prTargetBranch: 42,
					},
				},
				'worktree.prTargetBranch must be a string',
			],
		])('should reject configure auto run with %s', (_label, overrides, expectedMessage) => {
			handler.handleMessage(client, {
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'doc1.md' }],
				...(overrides as Record<string, unknown>),
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain(expectedMessage);
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
						baseBranch: '',
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

	describe('Set Auto Run Folder (Web → Desktop)', () => {
		it('should forward valid folder updates to desktop', async () => {
			handler.handleMessage(client, {
				type: 'set_auto_run_folder',
				sessionId: 'session-1',
				folderPath: '/repo/.maestro',
				requestId: 'folder-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.setSessionAutoRunFolder).toHaveBeenCalledWith(
					'session-1',
					'/repo/.maestro'
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response).toEqual(
				expect.objectContaining({
					type: 'set_auto_run_folder_result',
					success: true,
					sessionId: 'session-1',
					requestId: 'folder-1',
				})
			);
		});

		it('should reject missing sessionId before updating the folder', () => {
			handler.handleMessage(client, {
				type: 'set_auto_run_folder',
				folderPath: '/repo/.maestro',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId');
			expect(callbacks.setSessionAutoRunFolder).not.toHaveBeenCalled();
		});

		it('should reject blank folderPath before updating the folder', () => {
			handler.handleMessage(client, {
				type: 'set_auto_run_folder',
				sessionId: 'session-1',
				folderPath: '   ',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('folderPath');
			expect(callbacks.setSessionAutoRunFolder).not.toHaveBeenCalled();
		});

		it('should reject folder updates when callback is not configured', () => {
			const handlerNoCallbacks = new WebSocketMessageHandler();
			handlerNoCallbacks.setCallbacks({});

			handlerNoCallbacks.handleMessage(client, {
				type: 'set_auto_run_folder',
				sessionId: 'session-1',
				folderPath: '/repo/.maestro',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});

		it('should report folder update callback failures', async () => {
			(callbacks.setSessionAutoRunFolder as any).mockRejectedValue(new Error('folder boom'));

			handler.handleMessage(client, {
				type: 'set_auto_run_folder',
				sessionId: 'session-1',
				folderPath: '/repo/.maestro',
			});

			await vi.waitFor(() => {
				const response = getLastResponse(client);
				expect(response.type).toBe('error');
				expect(response.message).toContain('folder boom');
			});
		});
	});

	describe('Run-in-Worktree git APIs (Web → Desktop)', () => {
		it('should reject get_git_branches without sessionId', () => {
			handler.handleMessage(client, { type: 'get_git_branches' });
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId');
		});

		it('should forward get_git_branches and emit branches list', async () => {
			handler.handleMessage(client, {
				type: 'get_git_branches',
				sessionId: 'session-1',
				requestId: 'req-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.getGitBranchesForSession).toHaveBeenCalledWith('session-1');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('git_branches');
			expect(response.branches).toEqual(['main', 'feature/x']);
			expect(response.currentBranch).toBe('main');
			expect(response.requestId).toBe('req-1');
		});

		it('should reject list_worktrees without sessionId', () => {
			handler.handleMessage(client, { type: 'list_worktrees' });
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing sessionId');
		});

		it('should forward list_worktrees and emit worktrees list', async () => {
			(callbacks.listWorktreesForSession as any).mockResolvedValueOnce({
				worktrees: [{ path: '/repo/wt-1', branch: 'feat/x', isBare: false }],
			});

			handler.handleMessage(client, {
				type: 'list_worktrees',
				sessionId: 'session-1',
				requestId: 'req-2',
			});

			await vi.waitFor(() => {
				expect(callbacks.listWorktreesForSession).toHaveBeenCalledWith('session-1');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('worktrees_list');
			expect(response.worktrees).toEqual([{ path: '/repo/wt-1', branch: 'feat/x', isBare: false }]);
			expect(response.requestId).toBe('req-2');
		});

		it('should error when get_git_branches callback is not configured', () => {
			const handlerNoCb = new WebSocketMessageHandler();
			handlerNoCb.setCallbacks({});
			handlerNoCb.handleMessage(client, {
				type: 'get_git_branches',
				sessionId: 'session-1',
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('not configured');
		});

		it('should error when list_worktrees callback is not configured', () => {
			const handlerNoCb = new WebSocketMessageHandler();
			handlerNoCb.setCallbacks({});
			handlerNoCb.handleMessage(client, {
				type: 'list_worktrees',
				sessionId: 'session-1',
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

	describe('Cue Pipeline Mutations (Web/CLI → Desktop)', () => {
		it('cue_pipeline_list returns the daemon-supplied list verbatim', async () => {
			const pipelines = [
				{ id: 'pipeline-Foo', name: 'Foo', color: '#06b6d4', nodes: [], edges: [] },
			];
			(callbacks.listCuePipelines as ReturnType<typeof vi.fn>).mockResolvedValue({ pipelines });

			handler.handleMessage(client, { type: 'cue_pipeline_list', requestId: 'req-1' });

			await vi.waitFor(() => {
				expect(callbacks.listCuePipelines).toHaveBeenCalledTimes(1);
			});
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response.type).toBe('cue_pipeline_list_result');
			expect(response.pipelines).toEqual(pipelines);
			expect(response.requestId).toBe('req-1');
		});

		it('cue_pipeline_get rejects empty identifier', () => {
			handler.handleMessage(client, { type: 'cue_pipeline_get' });

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing identifier');
		});

		it('cue_pipeline_get returns the daemon-supplied pipeline (or null)', async () => {
			const pipeline = { id: 'pipeline-Foo', name: 'Foo', color: '#06b6d4', nodes: [], edges: [] };
			(callbacks.getCuePipeline as ReturnType<typeof vi.fn>).mockResolvedValue(pipeline);

			handler.handleMessage(client, { type: 'cue_pipeline_get', identifier: 'Foo' });

			await vi.waitFor(() => {
				expect(callbacks.getCuePipeline).toHaveBeenCalledWith('Foo');
			});
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response.type).toBe('cue_pipeline_get_result');
			expect(response.pipeline).toEqual(pipeline);
		});

		it('cue_pipeline_set forwards identifier, payload, and policy', async () => {
			const payload = { id: 'pipeline-Foo', name: 'Foo', color: '#06b6d4', nodes: [], edges: [] };
			handler.handleMessage(client, {
				type: 'cue_pipeline_set',
				identifier: 'Foo',
				pipeline: payload,
				policy: 'add',
			});

			await vi.waitFor(() => {
				expect(callbacks.setCuePipeline).toHaveBeenCalledWith('Foo', payload, 'add');
			});
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response.type).toBe('cue_pipeline_set_result');
			expect(response.result).toEqual({ ok: true });
		});

		it('cue_pipeline_set rejects invalid policy', () => {
			handler.handleMessage(client, {
				type: 'cue_pipeline_set',
				identifier: 'Foo',
				pipeline: {},
				policy: 'destroy',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Invalid policy');
		});

		it('cue_pipeline_set rejects missing payload', () => {
			handler.handleMessage(client, {
				type: 'cue_pipeline_set',
				identifier: 'Foo',
				policy: 'add',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing pipeline payload');
		});

		it('cue_pipeline_set surfaces structured failure results unchanged', async () => {
			(callbacks.setCuePipeline as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: false,
				code: 'already_exists',
				message: 'pipeline "Foo" already exists',
			});
			handler.handleMessage(client, {
				type: 'cue_pipeline_set',
				identifier: 'Foo',
				pipeline: { id: 'pipeline-Foo', name: 'Foo', color: '#06b6d4', nodes: [], edges: [] },
				policy: 'add',
			});

			await vi.waitFor(() => {
				expect(callbacks.setCuePipeline).toHaveBeenCalled();
			});
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response.type).toBe('cue_pipeline_set_result');
			expect(response.result.ok).toBe(false);
			expect(response.result.code).toBe('already_exists');
		});

		it('cue_pipeline_remove forwards identifier and surfaces result', async () => {
			handler.handleMessage(client, {
				type: 'cue_pipeline_remove',
				identifier: 'Foo',
			});

			await vi.waitFor(() => {
				expect(callbacks.removeCuePipeline).toHaveBeenCalledWith('Foo');
			});
			const response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response.type).toBe('cue_pipeline_remove_result');
			expect(response.result).toEqual({ ok: true });
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

		it('reports unconfigured callbacks across the newer web and CLI surfaces', () => {
			const cases: Array<{
				callbackName: keyof MessageHandlerCallbacks;
				message: WebClientMessage;
				messageFragment: string;
				expectedType?: string;
				responseTextField?: 'message' | 'error';
			}> = [
				{
					callbackName: 'toggleBookmark',
					message: { type: 'toggle_bookmark', sessionId: 'session-1' },
					messageFragment: 'Bookmark',
				},
				{
					callbackName: 'refreshFileTree',
					message: { type: 'refresh_file_tree', sessionId: 'session-1' },
					messageFragment: 'File tree',
				},
				{
					callbackName: 'openFileTab',
					message: { type: 'open_file_tab', sessionId: 'session-1', filePath: 'README.md' },
					messageFragment: 'File tab',
					expectedType: 'open_file_tab_result',
					responseTextField: 'error',
				},
				{
					callbackName: 'openBrowserTab',
					message: { type: 'open_browser_tab', sessionId: 'session-1', url: 'https://example.com' },
					messageFragment: 'Browser tab',
					expectedType: 'open_browser_tab_result',
					responseTextField: 'error',
				},
				{
					callbackName: 'openTerminalTab',
					message: { type: 'open_terminal_tab', sessionId: 'session-1' },
					messageFragment: 'Terminal tab',
					expectedType: 'open_terminal_tab_result',
					responseTextField: 'error',
				},
				{
					callbackName: 'newAITabWithPrompt',
					message: { type: 'new_ai_tab_with_prompt', sessionId: 'session-1', prompt: 'go' },
					messageFragment: 'New AI tab',
					expectedType: 'new_ai_tab_with_prompt_result',
					responseTextField: 'error',
				},
				{
					callbackName: 'refreshAutoRunDocs',
					message: { type: 'refresh_auto_run_docs', sessionId: 'session-1' },
					messageFragment: 'Auto-run docs refresh',
				},
				{
					callbackName: 'getAutoRunDocs',
					message: { type: 'get_auto_run_docs', sessionId: 'session-1' },
					messageFragment: 'Auto-run docs listing',
				},
				{
					callbackName: 'getSessionDetail',
					message: { type: 'get_auto_run_state', sessionId: 'session-1' },
					messageFragment: 'Session detail',
				},
				{
					callbackName: 'getAutoRunDocContent',
					message: { type: 'get_auto_run_document', sessionId: 'session-1', filename: 'a' },
					messageFragment: 'Auto-run document reading',
				},
				{
					callbackName: 'saveAutoRunDoc',
					message: {
						type: 'save_auto_run_document',
						sessionId: 'session-1',
						filename: 'a',
						content: 'body',
					},
					messageFragment: 'Auto-run document saving',
				},
				{
					callbackName: 'stopAutoRun',
					message: { type: 'stop_auto_run', sessionId: 'session-1' },
					messageFragment: 'Auto-run stopping',
				},
				{
					callbackName: 'resetAutoRunDocTasks',
					message: { type: 'reset_auto_run_doc_tasks', sessionId: 'session-1', filename: 'a' },
					messageFragment: 'Auto-run task reset',
				},
				{
					callbackName: 'resumeAutoRunError',
					message: { type: 'resume_auto_run_error', sessionId: 'session-1' },
					messageFragment: 'Auto-run resume',
				},
				{
					callbackName: 'skipAutoRunDocument',
					message: { type: 'skip_auto_run_document', sessionId: 'session-1' },
					messageFragment: 'Auto-run skip',
				},
				{
					callbackName: 'abortAutoRunError',
					message: { type: 'abort_auto_run_error', sessionId: 'session-1' },
					messageFragment: 'Auto-run abort',
				},
				{
					callbackName: 'listPlaybooks',
					message: { type: 'list_playbooks', sessionId: 'session-1' },
					messageFragment: 'Playbook listing',
				},
				{
					callbackName: 'createPlaybook',
					message: {
						type: 'create_playbook',
						sessionId: 'session-1',
						playbook: { name: 'p', documents: [{ filename: 'a' }] },
					},
					messageFragment: 'Playbook creation',
				},
				{
					callbackName: 'updatePlaybook',
					message: {
						type: 'update_playbook',
						sessionId: 'session-1',
						playbookId: 'pb-1',
						updates: { name: 'p2' },
					},
					messageFragment: 'Playbook updates',
				},
				{
					callbackName: 'deletePlaybook',
					message: { type: 'delete_playbook', sessionId: 'session-1', playbookId: 'pb-1' },
					messageFragment: 'Playbook deletion',
				},
				{
					callbackName: 'getSettings',
					message: { type: 'get_settings' },
					messageFragment: 'Settings',
				},
				{
					callbackName: 'setSetting',
					message: { type: 'set_setting', key: 'fontSize', value: 16 },
					messageFragment: 'Setting modification',
				},
				{
					callbackName: 'createSession',
					message: { type: 'create_session', name: 'A', toolType: 'codex', cwd: '/repo' },
					messageFragment: 'Session creation',
				},
				{
					callbackName: 'createWorktreeSession',
					message: {
						type: 'create_worktree_session',
						parentSessionId: 'session-1',
						branchName: 'feature/x',
					},
					messageFragment: 'Worktree session creation',
				},
				{
					callbackName: 'deleteSession',
					message: { type: 'delete_session', sessionId: 'session-1' },
					messageFragment: 'Session deletion',
				},
				{
					callbackName: 'renameSession',
					message: { type: 'rename_session', sessionId: 'session-1', newName: 'Renamed' },
					messageFragment: 'Session renaming',
				},
				{
					callbackName: 'updateSessionCwd',
					message: { type: 'update_session_cwd', sessionId: 'session-1', newCwd: '/repo2' },
					messageFragment: 'Session cwd updates',
				},
				{
					callbackName: 'updateSessionSsh',
					message: { type: 'update_session_ssh', sessionId: 'session-1', sshPatch: {} },
					messageFragment: 'Session SSH updates',
				},
				{
					callbackName: 'getGroups',
					message: { type: 'get_groups' },
					messageFragment: 'Groups',
				},
				{
					callbackName: 'createGroup',
					message: { type: 'create_group', name: 'Group' },
					messageFragment: 'Group creation',
				},
				{
					callbackName: 'renameGroup',
					message: { type: 'rename_group', groupId: 'group-1', name: 'Group' },
					messageFragment: 'Group renaming',
				},
				{
					callbackName: 'deleteGroup',
					message: { type: 'delete_group', groupId: 'group-1' },
					messageFragment: 'Group deletion',
				},
				{
					callbackName: 'moveSessionToGroup',
					message: { type: 'move_session_to_group', sessionId: 'session-1', groupId: null },
					messageFragment: 'Move to group',
				},
				{
					callbackName: 'getGitStatus',
					message: { type: 'get_git_status', sessionId: 'session-1' },
					messageFragment: 'Git status',
				},
				{
					callbackName: 'getGitDiff',
					message: { type: 'get_git_diff', sessionId: 'session-1' },
					messageFragment: 'Git diff',
				},
				{
					callbackName: 'getGitBranchesForSession',
					message: { type: 'get_git_branches', sessionId: 'session-1' },
					messageFragment: 'Git branches',
				},
				{
					callbackName: 'listWorktreesForSession',
					message: { type: 'list_worktrees', sessionId: 'session-1' },
					messageFragment: 'List worktrees',
				},
				{
					callbackName: 'getGroupChats',
					message: { type: 'get_group_chats' },
					messageFragment: 'Group chats',
				},
				{
					callbackName: 'startGroupChat',
					message: {
						type: 'start_group_chat',
						topic: 'Topic',
						participantIds: ['session-1', 'session-2'],
					},
					messageFragment: 'Group chat',
				},
				{
					callbackName: 'getGroupChatState',
					message: { type: 'get_group_chat_state', chatId: 'chat-1' },
					messageFragment: 'Group chat',
				},
				{
					callbackName: 'sendGroupChatMessage',
					message: { type: 'send_group_chat_message', chatId: 'chat-1', message: 'hi' },
					messageFragment: 'Group chat',
				},
				{
					callbackName: 'stopGroupChat',
					message: { type: 'stop_group_chat', chatId: 'chat-1' },
					messageFragment: 'Group chat',
				},
				{
					callbackName: 'mergeContext',
					message: {
						type: 'merge_context',
						sourceSessionId: 'session-1',
						targetSessionId: 'session-2',
					},
					messageFragment: 'Context merge',
				},
				{
					callbackName: 'transferContext',
					message: {
						type: 'transfer_context',
						sourceSessionId: 'session-1',
						targetSessionId: 'session-2',
					},
					messageFragment: 'Context transfer',
				},
				{
					callbackName: 'summarizeContext',
					message: { type: 'summarize_context', sessionId: 'session-1' },
					messageFragment: 'Context summarize',
				},
				{
					callbackName: 'getCueSubscriptions',
					message: { type: 'get_cue_subscriptions' },
					messageFragment: 'Cue subscriptions',
				},
				{
					callbackName: 'toggleCueSubscription',
					message: {
						type: 'toggle_cue_subscription',
						subscriptionId: 'sub-1',
						enabled: true,
					},
					messageFragment: 'Cue toggle',
				},
				{
					callbackName: 'getCueActivity',
					message: { type: 'get_cue_activity' },
					messageFragment: 'Cue activity',
				},
				{
					callbackName: 'triggerCueSubscription',
					message: { type: 'trigger_cue_subscription', subscriptionName: 'Daily' },
					messageFragment: 'Cue trigger',
				},
				{
					callbackName: 'listCuePipelines',
					message: { type: 'cue_pipeline_list' },
					messageFragment: 'Cue pipeline list',
				},
				{
					callbackName: 'getCuePipeline',
					message: { type: 'cue_pipeline_get', identifier: 'daily' },
					messageFragment: 'Cue pipeline get',
				},
				{
					callbackName: 'setCuePipeline',
					message: {
						type: 'cue_pipeline_set',
						identifier: 'daily',
						policy: 'add',
						pipeline: {},
					},
					messageFragment: 'Cue pipeline set',
				},
				{
					callbackName: 'removeCuePipeline',
					message: { type: 'cue_pipeline_remove', identifier: 'daily' },
					messageFragment: 'Cue pipeline remove',
				},
				{
					callbackName: 'getUsageDashboard',
					message: { type: 'get_usage_dashboard' },
					messageFragment: 'Usage dashboard',
				},
				{
					callbackName: 'getAchievements',
					message: { type: 'get_achievements' },
					messageFragment: 'Achievements',
				},
			];

			for (const {
				callbackName,
				message,
				messageFragment,
				expectedType = 'error',
				responseTextField = 'message',
			} of cases) {
				const localHandler = new WebSocketMessageHandler();
				const localClient = createMockClient(`client-${String(callbackName)}`);
				const localCallbacks = createMockCallbacks();
				(localCallbacks as any)[callbackName] = undefined;
				localHandler.setCallbacks(localCallbacks);

				localHandler.handleMessage(localClient, message);

				const response = JSON.parse((localClient.socket.send as any).mock.calls[0][0]);
				expect(response.type, `${String(callbackName)} should reply with ${expectedType}`).toBe(
					expectedType
				);
				expect(response[responseTextField]).toContain(messageFragment);
			}
		});
	});

	describe('Tab and session callback failures', () => {
		it('covers star, reorder, and bookmark success payloads', async () => {
			handler.handleMessage(client, {
				type: 'star_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
				starred: true,
				requestId: 'star-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.starTab).toHaveBeenCalledWith('session-1', 'tab-1', true);
			});
			expect(getLastResponse(client)).toMatchObject({
				type: 'star_tab_result',
				success: true,
				sessionId: 'session-1',
				tabId: 'tab-1',
				starred: true,
				requestId: 'star-req',
			});

			vi.mocked(client.socket.send).mockClear();
			handler.handleMessage(client, {
				type: 'reorder_tab',
				sessionId: 'session-1',
				fromIndex: 0,
				toIndex: 2,
				requestId: 'reorder-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.reorderTab).toHaveBeenCalledWith('session-1', 0, 2);
			});
			expect(getLastResponse(client)).toMatchObject({
				type: 'reorder_tab_result',
				success: true,
				sessionId: 'session-1',
				fromIndex: 0,
				toIndex: 2,
				requestId: 'reorder-req',
			});

			vi.mocked(client.socket.send).mockClear();
			handler.handleMessage(client, {
				type: 'toggle_bookmark',
				sessionId: 'session-1',
				requestId: 'bookmark-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.toggleBookmark).toHaveBeenCalledWith('session-1');
			});
			expect(getLastResponse(client)).toMatchObject({
				type: 'toggle_bookmark_result',
				success: true,
				sessionId: 'session-1',
				requestId: 'bookmark-req',
			});
		});

		it('reports rejected tab and session callbacks', async () => {
			(callbacks.selectSession as any).mockResolvedValueOnce(false);
			handler.handleMessage(client, {
				type: 'select_session',
				sessionId: 'session-1',
				requestId: 'select-false-req',
			});
			await vi.waitFor(() => {
				expect(getLastResponse(client)).toMatchObject({
					type: 'select_session_result',
					success: false,
					sessionId: 'session-1',
					requestId: 'select-false-req',
				});
			});

			for (const [callbackName, message, expected] of [
				[
					'switchMode',
					{ type: 'switch_mode', sessionId: 'session-1', mode: 'ai' },
					'Failed to switch mode',
				],
				[
					'selectSession',
					{ type: 'select_session', sessionId: 'session-1' },
					'Failed to select session',
				],
				[
					'selectTab',
					{ type: 'select_tab', sessionId: 'session-1', tabId: 'tab-1' },
					'Failed to select tab',
				],
				['newTab', { type: 'new_tab', sessionId: 'session-1' }, 'Failed to create tab'],
				[
					'closeTab',
					{ type: 'close_tab', sessionId: 'session-1', tabId: 'tab-1' },
					'Failed to close tab',
				],
				[
					'renameTab',
					{ type: 'rename_tab', sessionId: 'session-1', tabId: 'tab-1', newName: 'Name' },
					'Failed to rename tab',
				],
				[
					'starTab',
					{ type: 'star_tab', sessionId: 'session-1', tabId: 'tab-1', starred: false },
					'Failed to star tab',
				],
				[
					'reorderTab',
					{ type: 'reorder_tab', sessionId: 'session-1', fromIndex: 0, toIndex: 1 },
					'Failed to reorder tab',
				],
				[
					'toggleBookmark',
					{ type: 'toggle_bookmark', sessionId: 'session-1' },
					'Failed to toggle bookmark',
				],
			] as Array<[keyof MessageHandlerCallbacks, WebClientMessage, string]>) {
				vi.mocked(client.socket.send).mockClear();
				(callbacks[callbackName] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
					new Error(`${String(callbackName)} boom`)
				);

				handler.handleMessage(client, message);

				await vi.waitFor(() => {
					expect(getLastResponse(client).message).toContain(expected);
				});
			}
		});
	});

	describe('Auto Run document API validation and failures', () => {
		it('returns Auto Run document/state/save/stop success payloads', async () => {
			(callbacks.getAutoRunDocs as any).mockResolvedValueOnce([{ filename: 'plan.md' }]);
			handler.handleMessage(client, {
				type: 'get_auto_run_docs',
				sessionId: 'session-1',
				requestId: 'docs-req',
			});
			await vi.waitFor(() => {
				expect(getLastResponse(client)).toMatchObject({
					type: 'auto_run_docs',
					sessionId: 'session-1',
					documents: [{ filename: 'plan.md' }],
					requestId: 'docs-req',
				});
			});

			vi.mocked(client.socket.send).mockClear();
			(callbacks.getSessionDetail as any).mockReturnValueOnce({
				autoRunState: { enabled: true, folderPath: '/repo/.maestro' },
			});
			handler.handleMessage(client, {
				type: 'get_auto_run_state',
				sessionId: 'session-1',
				requestId: 'state-req',
			});
			expect(getLastResponse(client)).toMatchObject({
				type: 'auto_run_state',
				sessionId: 'session-1',
				state: { enabled: true, folderPath: '/repo/.maestro' },
				requestId: 'state-req',
			});

			vi.mocked(client.socket.send).mockClear();
			(callbacks.getAutoRunDocContent as any).mockResolvedValueOnce('# Plan');
			handler.handleMessage(client, {
				type: 'get_auto_run_document',
				sessionId: 'session-1',
				filename: 'plan.md',
				requestId: 'read-req',
			});
			await vi.waitFor(() => {
				expect(getLastResponse(client)).toMatchObject({
					type: 'auto_run_document_content',
					sessionId: 'session-1',
					filename: 'plan.md',
					content: '# Plan',
					requestId: 'read-req',
				});
			});

			vi.mocked(client.socket.send).mockClear();
			handler.handleMessage(client, {
				type: 'save_auto_run_document',
				sessionId: 'session-1',
				filename: 'plan.md',
				content: '# Updated',
				requestId: 'save-req',
			});
			await vi.waitFor(() => {
				expect(getLastResponse(client)).toMatchObject({
					type: 'save_auto_run_document_result',
					success: true,
					sessionId: 'session-1',
					filename: 'plan.md',
					requestId: 'save-req',
				});
			});

			vi.mocked(client.socket.send).mockClear();
			handler.handleMessage(client, {
				type: 'stop_auto_run',
				sessionId: 'session-1',
				requestId: 'stop-req',
			});
			await vi.waitFor(() => {
				expect(getLastResponse(client)).toMatchObject({
					type: 'stop_auto_run_result',
					success: true,
					sessionId: 'session-1',
					requestId: 'stop-req',
				});
			});
		});

		it('rejects missing session ids for document/state/stop APIs', () => {
			for (const message of [
				{ type: 'get_auto_run_docs' },
				{ type: 'get_auto_run_state' },
				{ type: 'get_auto_run_document', filename: 'a.md' },
				{ type: 'save_auto_run_document', filename: 'a.md', content: 'body' },
				{ type: 'stop_auto_run' },
			] as WebClientMessage[]) {
				vi.mocked(client.socket.send).mockClear();

				handler.handleMessage(client, message);

				const response = getLastResponse(client);
				expect(response.type).toBe('error');
				expect(response.message).toContain('Missing sessionId');
			}
		});

		it('rejects invalid Auto Run document filenames and content payloads', () => {
			for (const message of [
				{ type: 'get_auto_run_document', sessionId: 'session-1', filename: '../secret.md' },
				{
					type: 'save_auto_run_document',
					sessionId: 'session-1',
					filename: '/tmp/a.md',
					content: 'body',
				},
				{ type: 'save_auto_run_document', sessionId: 'session-1', filename: 'a.md', content: 42 },
			] as WebClientMessage[]) {
				vi.mocked(client.socket.send).mockClear();

				handler.handleMessage(client, message);

				const response = getLastResponse(client);
				expect(response.type).toBe('error');
			}
			expect(callbacks.getAutoRunDocContent).not.toHaveBeenCalled();
			expect(callbacks.saveAutoRunDoc).not.toHaveBeenCalled();
		});

		it('reports rejected Auto Run document callbacks', async () => {
			(callbacks.getAutoRunDocs as any).mockRejectedValueOnce(new Error('docs boom'));
			handler.handleMessage(client, { type: 'get_auto_run_docs', sessionId: 'session-1' });
			await vi.waitFor(() => expect(getLastResponse(client).message).toContain('docs boom'));

			vi.mocked(client.socket.send).mockClear();
			(callbacks.getAutoRunDocContent as any).mockRejectedValueOnce(new Error('read boom'));
			handler.handleMessage(client, {
				type: 'get_auto_run_document',
				sessionId: 'session-1',
				filename: 'a.md',
			});
			await vi.waitFor(() => expect(getLastResponse(client).message).toContain('read boom'));

			vi.mocked(client.socket.send).mockClear();
			(callbacks.saveAutoRunDoc as any).mockRejectedValueOnce(new Error('save boom'));
			handler.handleMessage(client, {
				type: 'save_auto_run_document',
				sessionId: 'session-1',
				filename: 'a.md',
				content: 'body',
			});
			await vi.waitFor(() => expect(getLastResponse(client).message).toContain('save boom'));

			vi.mocked(client.socket.send).mockClear();
			(callbacks.stopAutoRun as any).mockRejectedValueOnce(new Error('stop boom'));
			handler.handleMessage(client, { type: 'stop_auto_run', sessionId: 'session-1' });
			await vi.waitFor(() => expect(getLastResponse(client).message).toContain('stop boom'));
		});

		it('reports reset_auto_run_doc_tasks callback failure through the shared handler reporter', async () => {
			(callbacks.resetAutoRunDocTasks as any).mockRejectedValueOnce(new Error('reset boom'));

			handler.handleMessage(client, {
				type: 'reset_auto_run_doc_tasks',
				sessionId: 'session-1',
				filename: 'plan.md',
			});

			await vi.waitFor(() => {
				expect(getLastResponse(client).message).toContain(
					'Failed to reset auto-run doc tasks: reset boom'
				);
			});
		});
	});

	describe('File Tree Path Traversal Protection', () => {
		it('should reject get_file_tree when path is missing', () => {
			handler.handleMessage(client, {
				type: 'get_file_tree',
				sessionId: 'session-1',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Missing path');
		});

		it('should return sorted file tree data for a path inside the session cwd', async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-file-tree-'));
			const nested = path.join(root, 'nested');
			fs.mkdirSync(nested);
			fs.writeFileSync(path.join(root, 'b.txt'), 'b');
			fs.writeFileSync(path.join(root, 'a.txt'), 'a');
			fs.writeFileSync(path.join(root, '.hidden'), 'hidden');
			fs.mkdirSync(path.join(root, 'node_modules'));
			callbacks.getSessionDetail = vi.fn().mockReturnValue({
				state: 'idle',
				inputMode: 'ai',
				cwd: root,
			});
			handler.setCallbacks(callbacks);

			try {
				handler.handleMessage(client, {
					type: 'get_file_tree',
					sessionId: 'session-1',
					path: root,
					maxDepth: 1,
					requestId: 'tree-1',
				});

				await vi.waitFor(() => {
					const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
					expect(response).toEqual(
						expect.objectContaining({
							type: 'file_tree_data',
							sessionId: 'session-1',
							path: root,
							requestId: 'tree-1',
						})
					);
					expect(response.tree.map((entry: { name: string }) => entry.name)).toEqual([
						'nested',
						'a.txt',
						'b.txt',
					]);
				});
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});

		it('should return file_tree_data with an error when tree building rejects', async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-file-tree-reject-'));
			callbacks.getSessionDetail = vi.fn().mockReturnValue({
				state: 'idle',
				inputMode: 'ai',
				cwd: root,
			});
			handler.setCallbacks(callbacks);
			vi.spyOn(handler as any, 'buildFileTree').mockRejectedValueOnce(new Error('tree boom'));

			try {
				handler.handleMessage(client, {
					type: 'get_file_tree',
					sessionId: 'session-1',
					path: root,
					requestId: 'tree-fail',
				});

				await vi.waitFor(() => {
					const response = getLastResponse(client);
					expect(response).toMatchObject({
						type: 'file_tree_data',
						sessionId: 'session-1',
						tree: [],
						error: 'tree boom',
						requestId: 'tree-fail',
					});
				});
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});

		it('should return an empty tree for an unreadable or missing directory inside cwd', async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-file-tree-empty-'));
			const missing = path.join(root, 'missing');
			callbacks.getSessionDetail = vi.fn().mockReturnValue({
				state: 'idle',
				inputMode: 'ai',
				cwd: root,
			});
			handler.setCallbacks(callbacks);

			try {
				handler.handleMessage(client, {
					type: 'get_file_tree',
					sessionId: 'session-1',
					path: missing,
				});

				await vi.waitFor(() => {
					const response = getLastResponse(client);
					expect(response.type).toBe('file_tree_data');
					expect(response.tree).toEqual([]);
					expect(response.error).toBeUndefined();
				});
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});

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

	describe('External Notifications', () => {
		const lastResponse = () => {
			const calls = (client.socket.send as any).mock.calls;
			return JSON.parse(calls[calls.length - 1][0]);
		};

		it('forwards a validated notify_toast payload to the desktop callback', async () => {
			handler.handleMessage(client, {
				type: 'notify_toast',
				requestId: 'req-toast',
				title: 'Build complete',
				message: 'All checks passed',
				color: 'green',
				duration: 12,
				dismissible: true,
				sessionId: 'session-1',
				sourceAgent: 'codex',
				tabId: 'tab-1',
				actionUrl: 'https://example.com',
				actionLabel: 'Open',
				clickAction: { kind: 'jump-session', sessionId: 'session-1', tabId: 'tab-1' },
			});

			await vi.waitFor(() => {
				expect(callbacks.notifyToast).toHaveBeenCalledWith({
					title: 'Build complete',
					message: 'All checks passed',
					color: 'green',
					dismissible: true,
					duration: 12,
					sessionId: 'session-1',
					sourceAgent: 'codex',
					tabId: 'tab-1',
					actionUrl: 'https://example.com',
					actionLabel: 'Open',
					clickAction: { kind: 'jump-session', sessionId: 'session-1', tabId: 'tab-1' },
				});
			});

			expect(lastResponse()).toMatchObject({
				type: 'notify_toast_result',
				success: true,
				requestId: 'req-toast',
			});
		});

		it('maps legacy notify_toast toastType and validates duration', () => {
			handler.handleMessage(client, {
				type: 'notify_toast',
				title: 'Bad duration',
				message: 'Too long',
				toastType: 'warning',
				duration: 61,
			});

			expect(callbacks.notifyToast).not.toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({
				type: 'notify_toast_result',
				success: false,
				error:
					'duration cannot exceed 60 seconds for externally-triggered toasts (use dismissible:true to make it sticky)',
			});
		});

		it('rejects invalid notify_toast click actions before calling desktop', () => {
			handler.handleMessage(client, {
				type: 'notify_toast',
				title: 'Open file',
				message: 'Missing path',
				clickAction: { kind: 'open-file', sessionId: 'session-1' },
			});

			expect(callbacks.notifyToast).not.toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({
				type: 'notify_toast_result',
				success: false,
				error: "clickAction kind 'open-file' requires path",
			});
		});

		it('forwards a validated notify_center_flash payload to the desktop callback', async () => {
			handler.handleMessage(client, {
				type: 'notify_center_flash',
				requestId: 'req-flash',
				message: 'Saved',
				detail: 'notes.md',
				variant: 'success',
				duration: 2000,
			});

			await vi.waitFor(() => {
				expect(callbacks.notifyCenterFlash).toHaveBeenCalledWith({
					message: 'Saved',
					detail: 'notes.md',
					color: 'green',
					duration: 2000,
				});
			});

			expect(lastResponse()).toMatchObject({
				type: 'notify_center_flash_result',
				success: true,
				requestId: 'req-flash',
			});
		});

		it('rejects invalid notify_center_flash color and duration', () => {
			handler.handleMessage(client, {
				type: 'notify_center_flash',
				message: 'Nope',
				color: 'purple',
			});

			expect(callbacks.notifyCenterFlash).not.toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({
				type: 'notify_center_flash_result',
				success: false,
				error: 'Invalid flash color: purple. Must be one of: green, yellow, orange, red, theme',
			});

			vi.mocked(client.socket.send as any).mockClear();
			handler.handleMessage(client, {
				type: 'notify_center_flash',
				message: 'Too sticky',
				duration: 0,
			});

			expect(callbacks.notifyCenterFlash).not.toHaveBeenCalled();
			expect(lastResponse()).toMatchObject({
				type: 'notify_center_flash_result',
				success: false,
				error: 'duration must be a positive number of milliseconds',
			});
		});

		it('rejects additional toast and flash validation failures before calling desktop callbacks', () => {
			for (const [message, expectedError] of [
				[{ type: 'notify_toast' }, 'Missing title'],
				[{ type: 'notify_toast', title: 'Bad color', color: 'blue' }, 'Invalid toast color: blue'],
				[
					{ type: 'notify_toast', title: 'Bad type', toastType: 'notice' },
					'Invalid toast type: notice',
				],
				[
					{
						type: 'notify_toast',
						title: 'Bad jump',
						clickAction: { kind: 'jump-session' },
					},
					"clickAction kind 'jump-session' requires sessionId",
				],
				[
					{
						type: 'notify_toast',
						title: 'Bad file',
						clickAction: { kind: 'open-file', path: 'README.md' },
					},
					"clickAction kind 'open-file' requires sessionId",
				],
				[
					{
						type: 'notify_toast',
						title: 'Bad URL',
						clickAction: { kind: 'open-url' },
					},
					"clickAction kind 'open-url' requires url",
				],
				[
					{
						type: 'notify_toast',
						title: 'Bad action',
						clickAction: { kind: 'explode' },
					},
					'Invalid clickAction kind: explode',
				],
				[
					{ type: 'notify_toast', title: 'Bad duration', duration: 0 },
					'duration must be a positive number of seconds',
				],
				[{ type: 'notify_center_flash' }, 'Missing message'],
				[
					{ type: 'notify_center_flash', message: 'Bad variant', variant: 'notice' },
					'Invalid flash variant: notice',
				],
				[
					{ type: 'notify_center_flash', message: 'Too long', duration: 6000 },
					'duration cannot exceed 5000 ms',
				],
			] as Array<[WebClientMessage, string]>) {
				vi.mocked(client.socket.send).mockClear();

				handler.handleMessage(client, message);

				expect(getLastResponse(client).error).toContain(expectedError);
			}

			expect(callbacks.notifyToast).toHaveBeenCalledTimes(0);
			expect(callbacks.notifyCenterFlash).toHaveBeenCalledTimes(0);
		});

		it('reports notification callback failures and false results', async () => {
			(callbacks.notifyToast as any).mockResolvedValueOnce(false);
			handler.handleMessage(client, {
				type: 'notify_toast',
				title: 'No show',
			});
			await vi.waitFor(() => {
				expect(getLastResponse(client)).toMatchObject({
					type: 'notify_toast_result',
					success: false,
					error: 'Failed to show toast',
				});
			});

			vi.mocked(client.socket.send).mockClear();
			(callbacks.notifyToast as any).mockRejectedValueOnce(new Error('toast boom'));
			handler.handleMessage(client, {
				type: 'notify_toast',
				title: 'Reject',
			});
			await vi.waitFor(() => {
				expect(getLastResponse(client).error).toContain('Failed to show toast: toast boom');
			});

			vi.mocked(client.socket.send).mockClear();
			(callbacks.notifyCenterFlash as any).mockResolvedValueOnce(false);
			handler.handleMessage(client, {
				type: 'notify_center_flash',
				message: 'No flash',
			});
			await vi.waitFor(() => {
				expect(getLastResponse(client)).toMatchObject({
					type: 'notify_center_flash_result',
					success: false,
					error: 'Failed to show flash',
				});
			});

			vi.mocked(client.socket.send).mockClear();
			(callbacks.notifyCenterFlash as any).mockRejectedValueOnce(new Error('flash boom'));
			handler.handleMessage(client, {
				type: 'notify_center_flash',
				message: 'Reject flash',
			});
			await vi.waitFor(() => {
				expect(getLastResponse(client).error).toContain('Failed to show flash: flash boom');
			});
		});
	});

	describe('Trigger Cue Subscription (sourceAgentId)', () => {
		it('returns Cue subscription, toggle, and activity payloads', async () => {
			(callbacks.getCueSubscriptions as any).mockResolvedValueOnce([{ id: 'sub-1' }]);
			handler.handleMessage(client, {
				type: 'get_cue_subscriptions',
				sessionId: 'session-1',
				requestId: 'subs-req',
			});
			await vi.waitFor(() => {
				expect(getLastResponse(client)).toMatchObject({
					type: 'cue_subscriptions',
					subscriptions: [{ id: 'sub-1' }],
					requestId: 'subs-req',
				});
			});

			vi.mocked(client.socket.send).mockClear();
			handler.handleMessage(client, {
				type: 'toggle_cue_subscription',
				subscriptionId: 'sub-1',
				enabled: false,
				requestId: 'toggle-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.toggleCueSubscription).toHaveBeenCalledWith('sub-1', false);
			});
			expect(getLastResponse(client)).toMatchObject({
				type: 'toggle_cue_subscription_result',
				success: true,
				subscriptionId: 'sub-1',
				enabled: false,
				requestId: 'toggle-req',
			});

			vi.mocked(client.socket.send).mockClear();
			(callbacks.getCueActivity as any).mockResolvedValueOnce([{ id: 'entry-1' }]);
			handler.handleMessage(client, {
				type: 'get_cue_activity',
				sessionId: 'session-1',
				limit: 3,
				requestId: 'activity-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.getCueActivity).toHaveBeenCalledWith('session-1', 3);
			});
			expect(getLastResponse(client)).toMatchObject({
				type: 'cue_activity',
				entries: [{ id: 'entry-1' }],
				requestId: 'activity-req',
			});
		});

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

	// ============================================================
	// Auto Run parity — reset tasks + playbook CRUD validation
	// These tests pin the path-safety rules called out in the PR
	// review: neither the web client nor a compromised dev tool may
	// escape the Auto Run root via absolute / traversal filenames.
	// ============================================================
	describe('reset_auto_run_doc_tasks path validation', () => {
		it('forwards relative subfolder paths to the callback', async () => {
			handler.handleMessage(client, {
				type: 'reset_auto_run_doc_tasks',
				sessionId: 'session-1',
				filename: 'loop/step-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.resetAutoRunDocTasks).toHaveBeenCalledWith('session-1', 'loop/step-1');
			});
		});

		it('rejects POSIX-absolute filenames', () => {
			handler.handleMessage(client, {
				type: 'reset_auto_run_doc_tasks',
				sessionId: 'session-1',
				filename: '/etc/passwd',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toMatch(/Invalid filename/);
			expect(callbacks.resetAutoRunDocTasks).not.toHaveBeenCalled();
		});

		it('rejects Windows drive-letter absolute filenames', () => {
			handler.handleMessage(client, {
				type: 'reset_auto_run_doc_tasks',
				sessionId: 'session-1',
				filename: 'C:/tmp/doc.md',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.resetAutoRunDocTasks).not.toHaveBeenCalled();
		});

		it('rejects traversal sequences', () => {
			handler.handleMessage(client, {
				type: 'reset_auto_run_doc_tasks',
				sessionId: 'session-1',
				filename: '../secrets.md',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.resetAutoRunDocTasks).not.toHaveBeenCalled();
		});
	});

	describe('Auto Run error recovery and playbook CRUD messages', () => {
		it('forwards recovery actions and returns typed results', async () => {
			for (const [type, callbackName, responseType] of [
				['resume_auto_run_error', 'resumeAutoRunError', 'resume_auto_run_error_result'],
				['skip_auto_run_document', 'skipAutoRunDocument', 'skip_auto_run_document_result'],
				['abort_auto_run_error', 'abortAutoRunError', 'abort_auto_run_error_result'],
			] as const) {
				vi.mocked(client.socket.send).mockClear();

				handler.handleMessage(client, {
					type,
					sessionId: 'session-1',
					requestId: `${type}-req`,
				});

				await vi.waitFor(() => {
					expect(callbacks[callbackName]).toHaveBeenCalledWith('session-1');
				});

				const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
				expect(response).toMatchObject({
					type: responseType,
					success: true,
					sessionId: 'session-1',
					requestId: `${type}-req`,
				});
			}
		});

		it('reports rejected recovery callbacks', async () => {
			for (const [type, callbackName, message] of [
				['resume_auto_run_error', 'resumeAutoRunError', 'resume boom'],
				['skip_auto_run_document', 'skipAutoRunDocument', 'skip boom'],
				['abort_auto_run_error', 'abortAutoRunError', 'abort boom'],
			] as const) {
				vi.mocked(client.socket.send).mockClear();
				(callbacks[callbackName] as any).mockRejectedValueOnce(new Error(message));

				handler.handleMessage(client, {
					type,
					sessionId: 'session-1',
				});

				await vi.waitFor(() => {
					const response = getLastResponse(client);
					expect(response.type).toBe('error');
					expect(response.message).toContain(message);
				});
			}
		});

		it('lists, updates, and deletes playbooks with sanitized payloads', async () => {
			handler.handleMessage(client, {
				type: 'list_playbooks',
				sessionId: 'session-1',
				requestId: 'list-req',
			});

			await vi.waitFor(() => {
				expect(callbacks.listPlaybooks).toHaveBeenCalledWith('session-1');
			});
			let response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'playbooks_list',
				sessionId: 'session-1',
				playbooks: [],
				requestId: 'list-req',
			});

			handler.handleMessage(client, {
				type: 'update_playbook',
				sessionId: 'session-1',
				playbookId: 'pb-1',
				updates: {
					name: ' Updated ',
					documents: [{ filename: 'loop/step-1', resetOnCompletion: true }],
					loopEnabled: true,
					maxLoops: null,
					prompt: 'Run it',
				},
				requestId: 'update-req',
			});

			await vi.waitFor(() => {
				expect(callbacks.updatePlaybook).toHaveBeenCalledWith('session-1', 'pb-1', {
					name: 'Updated',
					documents: [{ filename: 'loop/step-1', resetOnCompletion: true }],
					loopEnabled: true,
					maxLoops: null,
					prompt: 'Run it',
				});
			});
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'update_playbook_result',
				success: true,
				sessionId: 'session-1',
				requestId: 'update-req',
			});

			handler.handleMessage(client, {
				type: 'delete_playbook',
				sessionId: 'session-1',
				playbookId: 'pb-1',
				requestId: 'delete-req',
			});

			await vi.waitFor(() => {
				expect(callbacks.deletePlaybook).toHaveBeenCalledWith('session-1', 'pb-1');
			});
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'delete_playbook_result',
				success: true,
				sessionId: 'session-1',
				playbookId: 'pb-1',
				requestId: 'delete-req',
			});
		});

		it('reports rejected playbook callbacks', async () => {
			for (const [type, callbackName, message, extra] of [
				['list_playbooks', 'listPlaybooks', 'list boom', {}],
				[
					'create_playbook',
					'createPlaybook',
					'create boom',
					{ playbook: { name: 'Playbook', documents: [{ filename: 'a.md' }] } },
				],
				[
					'update_playbook',
					'updatePlaybook',
					'update boom',
					{ playbookId: 'pb-1', updates: { name: 'P2' } },
				],
				['delete_playbook', 'deletePlaybook', 'delete boom', { playbookId: 'pb-1' }],
			] as const) {
				vi.mocked(client.socket.send).mockClear();
				(callbacks[callbackName] as any).mockRejectedValueOnce(new Error(message));

				handler.handleMessage(client, {
					type,
					sessionId: 'session-1',
					...extra,
				});

				await vi.waitFor(() => {
					const response = getLastResponse(client);
					expect(response.type).toBe('error');
					expect(response.message).toContain(message);
				});
			}
		});
	});

	describe('playbook document validation', () => {
		const validPayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
			type: 'create_playbook' as const,
			sessionId: 'session-1',
			playbook: {
				name: 'p',
				documents: [{ filename: 'a' }],
				loopEnabled: false,
				prompt: '',
				...overrides,
			},
		});

		it.each([
			['missing sessionId', { sessionId: undefined }, 'Missing sessionId'],
			['missing playbook object', { playbook: undefined }, 'Missing playbook payload'],
			[
				'blank name',
				{ playbook: { name: '   ', documents: [{ filename: 'a' }] } },
				'non-empty string',
			],
			[
				'invalid loopEnabled',
				{ playbook: { name: 'p', documents: [{ filename: 'a' }], loopEnabled: 'yes' } },
				'loopEnabled',
			],
			[
				'invalid maxLoops',
				{ playbook: { name: 'p', documents: [{ filename: 'a' }], maxLoops: Number.NaN } },
				'maxLoops',
			],
			[
				'invalid prompt',
				{ playbook: { name: 'p', documents: [{ filename: 'a' }], prompt: false } },
				'prompt',
			],
		])('rejects create_playbook with %s', (_label, overrides, expectedMessage) => {
			handler.handleMessage(client, {
				...validPayload(),
				...(overrides as Partial<WebClientMessage>),
			});

			const response = getLastResponse(client);
			expect(response.type).toBe('error');
			expect(response.message).toContain(expectedMessage);
			expect(callbacks.createPlaybook).not.toHaveBeenCalled();
		});

		it('accepts relative subfolder filenames', async () => {
			handler.handleMessage(client, {
				...validPayload({ documents: [{ filename: 'loop/step-1', resetOnCompletion: true }] }),
			});

			await vi.waitFor(() => {
				expect(callbacks.createPlaybook).toHaveBeenCalled();
			});
			const [, playbook] = (callbacks.createPlaybook as any).mock.calls[0];
			expect(playbook.documents).toEqual([{ filename: 'loop/step-1', resetOnCompletion: true }]);
		});

		it('rejects absolute POSIX filenames', () => {
			handler.handleMessage(client, {
				...validPayload({ documents: [{ filename: '/etc/passwd' }] }),
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(response.message).toMatch(/Invalid playbook documents/);
			expect(callbacks.createPlaybook).not.toHaveBeenCalled();
		});

		it('rejects Windows drive-letter absolute filenames', () => {
			handler.handleMessage(client, {
				...validPayload({ documents: [{ filename: 'C:\\tmp\\doc.md' }] }),
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.createPlaybook).not.toHaveBeenCalled();
		});

		it('rejects backslash separators', () => {
			handler.handleMessage(client, {
				...validPayload({ documents: [{ filename: 'loop\\step-1' }] }),
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.createPlaybook).not.toHaveBeenCalled();
		});

		it('rejects `..` traversal segments', () => {
			handler.handleMessage(client, {
				...validPayload({ documents: [{ filename: '../secrets' }] }),
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.createPlaybook).not.toHaveBeenCalled();
		});

		it('rejects non-boolean resetOnCompletion rather than coercing it', () => {
			// Review feedback — a truthy non-boolean value was being silently
			// flipped to true. The validator now refuses anything that isn't
			// strictly a boolean.
			handler.handleMessage(client, {
				...validPayload({
					documents: [{ filename: 'a', resetOnCompletion: 'yes' as unknown as boolean }],
				}),
			});
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('error');
			expect(callbacks.createPlaybook).not.toHaveBeenCalled();
		});

		it('defaults resetOnCompletion to false when omitted', async () => {
			handler.handleMessage(client, {
				...validPayload({ documents: [{ filename: 'a' }] }),
			});
			await vi.waitFor(() => {
				expect(callbacks.createPlaybook).toHaveBeenCalled();
			});
			const [, playbook] = (callbacks.createPlaybook as any).mock.calls[0];
			expect(playbook.documents[0].resetOnCompletion).toBe(false);
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

	describe('Group chat, context, dashboard, and stats messages', () => {
		it('forwards group chat and context actions to callbacks', async () => {
			(callbacks.getGroupChats as any).mockResolvedValue([{ chatId: 'chat-1' }]);
			(callbacks.getGroupChatState as any).mockResolvedValue({ chatId: 'chat-1', active: true });

			handler.handleMessage(client, { type: 'get_group_chats', requestId: 'chats-req' });
			await vi.waitFor(() => {
				expect(callbacks.getGroupChats).toHaveBeenCalled();
			});
			let response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'group_chats_list',
				chats: [{ chatId: 'chat-1' }],
				requestId: 'chats-req',
			});

			handler.handleMessage(client, {
				type: 'start_group_chat',
				topic: 'Plan',
				participantIds: ['session-1', 'session-2'],
				requestId: 'start-chat-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.startGroupChat).toHaveBeenCalledWith('Plan', ['session-1', 'session-2']);
			});
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'start_group_chat_result',
				success: true,
				chatId: 'chat-1',
				requestId: 'start-chat-req',
			});

			handler.handleMessage(client, {
				type: 'get_group_chat_state',
				chatId: 'chat-1',
				requestId: 'state-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.getGroupChatState).toHaveBeenCalledWith('chat-1');
			});

			handler.handleMessage(client, {
				type: 'send_group_chat_message',
				chatId: 'chat-1',
				message: 'hello',
				requestId: 'send-chat-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.sendGroupChatMessage).toHaveBeenCalledWith('chat-1', 'hello');
			});

			handler.handleMessage(client, {
				type: 'stop_group_chat',
				chatId: 'chat-1',
				requestId: 'stop-chat-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.stopGroupChat).toHaveBeenCalledWith('chat-1');
			});

			handler.handleMessage(client, {
				type: 'merge_context',
				sourceSessionId: 'session-1',
				targetSessionId: 'session-2',
				requestId: 'merge-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.mergeContext).toHaveBeenCalledWith('session-1', 'session-2');
			});

			handler.handleMessage(client, {
				type: 'transfer_context',
				sourceSessionId: 'session-1',
				targetSessionId: 'session-2',
				requestId: 'transfer-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.transferContext).toHaveBeenCalledWith('session-1', 'session-2');
			});

			handler.handleMessage(client, {
				type: 'summarize_context',
				sessionId: 'session-1',
				requestId: 'summarize-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.summarizeContext).toHaveBeenCalledWith('session-1');
			});
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'summarize_context_result',
				success: true,
				requestId: 'summarize-req',
			});
		});

		it('returns usage, achievements, director notes, and validation errors', async () => {
			(callbacks.getUsageDashboard as any).mockResolvedValue({ totalCost: 1 });
			(callbacks.getAchievements as any).mockResolvedValue([{ id: 'first-run' }]);

			handler.handleMessage(client, {
				type: 'get_usage_dashboard',
				timeRange: 'month',
				requestId: 'usage-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.getUsageDashboard).toHaveBeenCalledWith('month');
			});
			let response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'usage_dashboard',
				data: { totalCost: 1 },
				requestId: 'usage-req',
			});

			handler.handleMessage(client, {
				type: 'get_achievements',
				requestId: 'achievements-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.getAchievements).toHaveBeenCalled();
			});
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'achievements',
				achievements: [{ id: 'first-run' }],
				requestId: 'achievements-req',
			});

			handler.handleMessage(client, {
				type: 'generate_director_notes_synopsis',
				lookbackDays: 14,
				provider: 'codex',
				requestId: 'director-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.generateDirectorNotesSynopsis).toHaveBeenCalledWith(14, 'codex');
			});
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'generate_director_notes_synopsis_result',
				success: true,
				synopsis: '# Director Notes',
				requestId: 'director-req',
			});

			handler.handleMessage(client, { type: 'get_usage_dashboard', timeRange: 'decade' });
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Invalid timeRange');

			handler.handleMessage(client, { type: 'get_stats_aggregation', range: 'forever' });
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('Invalid range');

			handler.handleMessage(client, { type: 'stats_query' });
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response.type).toBe('error');
			expect(response.message).toContain('sql');
		});

		it('reports rejected callbacks across session, group, git, context, Cue, and dashboard surfaces', async () => {
			const cases: Array<{
				callbackName: keyof MessageHandlerCallbacks;
				message: WebClientMessage;
				expected: string;
				responseField?: 'message' | 'error';
			}> = [
				{
					callbackName: 'setSetting',
					message: { type: 'set_setting', key: 'fontSize', value: 15 },
					expected: 'Failed to set setting',
				},
				{
					callbackName: 'createSession',
					message: { type: 'create_session', name: 'Agent', toolType: 'codex', cwd: '/repo' },
					expected: 'Failed to create session',
				},
				{
					callbackName: 'createWorktreeSession',
					message: {
						type: 'create_worktree_session',
						parentSessionId: 'session-1',
						branchName: 'feature/fail',
					},
					expected: 'Failed to create worktree session',
				},
				{
					callbackName: 'deleteSession',
					message: { type: 'delete_session', sessionId: 'session-1' },
					expected: 'Failed to delete session',
				},
				{
					callbackName: 'renameSession',
					message: { type: 'rename_session', sessionId: 'session-1', newName: 'Renamed' },
					expected: 'Failed to rename session',
				},
				{
					callbackName: 'updateSessionCwd',
					message: { type: 'update_session_cwd', sessionId: 'session-1', newCwd: '/repo' },
					expected: 'Failed to update session cwd',
				},
				{
					callbackName: 'updateSessionSsh',
					message: {
						type: 'update_session_ssh',
						sessionId: 'session-1',
						sshPatch: { enabled: true },
					},
					expected: 'Failed to update session SSH config',
				},
				{
					callbackName: 'createGroup',
					message: { type: 'create_group', name: 'Group' },
					expected: 'Failed to create group',
				},
				{
					callbackName: 'renameGroup',
					message: { type: 'rename_group', groupId: 'group-1', name: 'Group' },
					expected: 'Failed to rename group',
				},
				{
					callbackName: 'deleteGroup',
					message: { type: 'delete_group', groupId: 'group-1' },
					expected: 'Failed to delete group',
				},
				{
					callbackName: 'moveSessionToGroup',
					message: { type: 'move_session_to_group', sessionId: 'session-1', groupId: null },
					expected: 'Failed to move session to group',
				},
				{
					callbackName: 'getGitStatus',
					message: { type: 'get_git_status', sessionId: 'session-1' },
					expected: 'Failed to get git status',
				},
				{
					callbackName: 'getGitDiff',
					message: { type: 'get_git_diff', sessionId: 'session-1', filePath: 'src/a.ts' },
					expected: 'Failed to get git diff',
				},
				{
					callbackName: 'getGitBranchesForSession',
					message: { type: 'get_git_branches', sessionId: 'session-1' },
					expected: 'Failed to get git branches',
				},
				{
					callbackName: 'listWorktreesForSession',
					message: { type: 'list_worktrees', sessionId: 'session-1' },
					expected: 'Failed to list worktrees',
				},
				{
					callbackName: 'getGroupChats',
					message: { type: 'get_group_chats' },
					expected: 'Failed to get group chats',
				},
				{
					callbackName: 'startGroupChat',
					message: {
						type: 'start_group_chat',
						topic: 'Plan',
						participantIds: ['session-1', 'session-2'],
					},
					expected: 'Failed to start group chat',
				},
				{
					callbackName: 'getGroupChatState',
					message: { type: 'get_group_chat_state', chatId: 'chat-1' },
					expected: 'Failed to get group chat state',
				},
				{
					callbackName: 'sendGroupChatMessage',
					message: { type: 'send_group_chat_message', chatId: 'chat-1', message: 'hello' },
					expected: 'Failed to send group chat message',
				},
				{
					callbackName: 'stopGroupChat',
					message: { type: 'stop_group_chat', chatId: 'chat-1' },
					expected: 'Failed to stop group chat',
				},
				{
					callbackName: 'mergeContext',
					message: {
						type: 'merge_context',
						sourceSessionId: 'session-1',
						targetSessionId: 'session-2',
					},
					expected: 'Failed to merge context',
				},
				{
					callbackName: 'transferContext',
					message: {
						type: 'transfer_context',
						sourceSessionId: 'session-1',
						targetSessionId: 'session-2',
					},
					expected: 'Failed to transfer context',
				},
				{
					callbackName: 'summarizeContext',
					message: { type: 'summarize_context', sessionId: 'session-1' },
					expected: 'Failed to summarize context',
				},
				{
					callbackName: 'getCueSubscriptions',
					message: { type: 'get_cue_subscriptions', sessionId: 'session-1' },
					expected: 'Failed to get Cue subscriptions',
				},
				{
					callbackName: 'toggleCueSubscription',
					message: { type: 'toggle_cue_subscription', subscriptionId: 'sub-1', enabled: true },
					expected: 'Failed to toggle Cue subscription',
				},
				{
					callbackName: 'getCueActivity',
					message: { type: 'get_cue_activity', sessionId: 'session-1', limit: 5 },
					expected: 'Failed to get Cue activity',
				},
				{
					callbackName: 'triggerCueSubscription',
					message: { type: 'trigger_cue_subscription', subscriptionName: 'Daily' },
					expected: 'Failed to trigger Cue subscription',
				},
				{
					callbackName: 'listCuePipelines',
					message: { type: 'cue_pipeline_list' },
					expected: 'Failed to list Cue pipelines',
				},
				{
					callbackName: 'getCuePipeline',
					message: { type: 'cue_pipeline_get', identifier: 'Daily' },
					expected: 'Failed to get Cue pipeline',
				},
				{
					callbackName: 'setCuePipeline',
					message: { type: 'cue_pipeline_set', identifier: 'Daily', policy: 'add', pipeline: {} },
					expected: 'Failed to set Cue pipeline',
				},
				{
					callbackName: 'removeCuePipeline',
					message: { type: 'cue_pipeline_remove', identifier: 'Daily' },
					expected: 'Failed to remove Cue pipeline',
				},
				{
					callbackName: 'getUsageDashboard',
					message: { type: 'get_usage_dashboard', timeRange: 'week' },
					expected: 'Failed to get usage dashboard',
				},
				{
					callbackName: 'getAchievements',
					message: { type: 'get_achievements' },
					expected: 'Failed to get achievements',
				},
				{
					callbackName: 'generateDirectorNotesSynopsis',
					message: { type: 'generate_director_notes_synopsis' },
					expected: 'Synopsis generation failed',
					responseField: 'error',
				},
			];

			for (const { callbackName, message, expected, responseField = 'message' } of cases) {
				vi.mocked(client.socket.send).mockClear();
				(callbacks[callbackName] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
					new Error(`${String(callbackName)} boom`)
				);

				handler.handleMessage(client, message);

				await vi.waitFor(() => {
					const response = getLastResponse(client);
					expect(response[responseField], `${String(callbackName)} rejection`).toContain(expected);
				});
			}
		});

		it('returns set_setting success payloads', async () => {
			handler.handleMessage(client, {
				type: 'set_setting',
				key: 'fontSize',
				value: 18,
				requestId: 'setting-req',
			});

			await vi.waitFor(() => {
				expect(callbacks.setSetting).toHaveBeenCalledWith('fontSize', 18);
			});
			expect(getLastResponse(client)).toMatchObject({
				type: 'set_setting_result',
				success: true,
				key: 'fontSize',
				requestId: 'setting-req',
			});
		});
	});

	describe('Marketplace (Playbook Exchange)', () => {
		it('returns the manifest payload on marketplace_get_manifest', async () => {
			handler.handleMessage(client, {
				type: 'marketplace_get_manifest',
				requestId: 'req-1',
			});

			await vi.waitFor(() => {
				expect(callbacks.getMarketplaceManifest).toHaveBeenCalledWith({ refresh: false });
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_get_manifest_result');
			expect(response.success).toBe(true);
			expect(response.manifest).toBeDefined();
			expect(response.requestId).toBe('req-1');
		});

		it('forwards refresh:true when requested', async () => {
			handler.handleMessage(client, {
				type: 'marketplace_get_manifest',
				refresh: true,
				requestId: 'req-2',
			});

			await vi.waitFor(() => {
				expect(callbacks.getMarketplaceManifest).toHaveBeenCalledWith({ refresh: true });
			});
		});

		it('rejects marketplace_get_document with traversal in filename via typed result', () => {
			handler.handleMessage(client, {
				type: 'marketplace_get_document',
				playbookPath: 'category/sample',
				filename: '../../etc/passwd',
				requestId: 'req-3',
			});

			expect(callbacks.getMarketplaceDocument).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			// Validation failures use the request-scoped result type so a CLI
			// waiting on `marketplace_get_document_result` doesn't time out
			// (coderabbit feedback).
			expect(response.type).toBe('marketplace_get_document_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Invalid filename');
			expect(response.requestId).toBe('req-3');
		});

		// Coderabbit feedback: defensive validation must reject any traversal
		// segment / backslash in playbookPath at the entry point, not just
		// absolute / tilde / Windows-drive prefixes — downstream resolvers
		// have other guards but shouldn't be relied on in isolation.
		it.each([
			['../../etc/passwd', 'parent traversal'],
			['./foo', 'leading dot segment'],
			['foo/./bar', 'embedded dot segment'],
			['foo/../bar', 'embedded parent traversal'],
			['foo\\bar', 'embedded backslash'],
		])('rejects marketplace_get_document playbookPath with %s (%s)', (playbookPath) => {
			handler.handleMessage(client, {
				type: 'marketplace_get_document',
				playbookPath,
				filename: 'README',
				requestId: 'req-traversal',
			});

			expect(callbacks.getMarketplaceDocument).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_get_document_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Local filesystem paths are not allowed');
		});

		it('rejects marketplace_get_document for absolute playbookPath via typed result', () => {
			handler.handleMessage(client, {
				type: 'marketplace_get_document',
				playbookPath: '/etc/passwd',
				filename: 'README',
				requestId: 'req-3b',
			});

			expect(callbacks.getMarketplaceDocument).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_get_document_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('Local filesystem paths are not allowed');
		});

		it('returns document content on marketplace_get_document', async () => {
			handler.handleMessage(client, {
				type: 'marketplace_get_document',
				playbookPath: 'category/sample',
				filename: 'STEP_1',
				requestId: 'req-4',
			});

			await vi.waitFor(() => {
				expect(callbacks.getMarketplaceDocument).toHaveBeenCalledWith('category/sample', 'STEP_1');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_get_document_result');
			expect(response.success).toBe(true);
			expect(response.content).toBe('# doc');
		});

		it('returns README content on marketplace_get_readme', async () => {
			handler.handleMessage(client, {
				type: 'marketplace_get_readme',
				playbookPath: 'category/sample',
				requestId: 'req-5',
			});

			await vi.waitFor(() => {
				expect(callbacks.getMarketplaceReadme).toHaveBeenCalledWith('category/sample');
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_get_readme_result');
			expect(response.success).toBe(true);
			expect(response.content).toBe('# readme');
		});

		it('imports a playbook on marketplace_import_playbook', async () => {
			handler.handleMessage(client, {
				type: 'marketplace_import_playbook',
				sessionId: 'session-1',
				playbookId: 'pb-1',
				targetFolderName: 'my-folder',
				requestId: 'req-6',
			});

			await vi.waitFor(() => {
				expect(callbacks.importMarketplacePlaybook).toHaveBeenCalledWith(
					'session-1',
					'pb-1',
					'my-folder'
				);
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_import_playbook_result');
			expect(response.success).toBe(true);
			expect(response.sessionId).toBe('session-1');
		});

		it('rejects marketplace_import_playbook missing required fields via typed result', () => {
			handler.handleMessage(client, {
				type: 'marketplace_import_playbook',
				sessionId: 'session-1',
				playbookId: 'pb-1',
				requestId: 'req-7',
			});

			expect(callbacks.importMarketplacePlaybook).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_import_playbook_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('targetFolderName');
		});

		it('rejects marketplace_import_playbook with separators in targetFolderName', () => {
			handler.handleMessage(client, {
				type: 'marketplace_import_playbook',
				sessionId: 'session-1',
				playbookId: 'pb-1',
				targetFolderName: '../escape',
				requestId: 'req-7b',
			});

			expect(callbacks.importMarketplacePlaybook).not.toHaveBeenCalled();
			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_import_playbook_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('separators');
		});

		it('replies with marketplace_get_manifest_result when callback unconfigured', () => {
			callbacks.getMarketplaceManifest = undefined;
			handler.setCallbacks(callbacks);

			handler.handleMessage(client, {
				type: 'marketplace_get_manifest',
				requestId: 'req-8',
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response.type).toBe('marketplace_get_manifest_result');
			expect(response.success).toBe(false);
			expect(response.error).toContain('not configured');
		});

		it('returns typed failures for empty marketplace results and callback rejections', async () => {
			for (const [callbackName, message, expectedType, expectedError] of [
				[
					'getMarketplaceManifest',
					{ type: 'marketplace_get_manifest' },
					'marketplace_get_manifest_result',
					'No manifest available',
				],
				[
					'getMarketplaceDocument',
					{
						type: 'marketplace_get_document',
						playbookPath: 'category/sample',
						filename: 'STEP_1',
					},
					'marketplace_get_document_result',
					'Marketplace not configured',
				],
				[
					'getMarketplaceReadme',
					{ type: 'marketplace_get_readme', playbookPath: 'category/sample' },
					'marketplace_get_readme_result',
					'Marketplace not configured',
				],
			] as const) {
				vi.mocked(client.socket.send).mockClear();
				(callbacks[callbackName] as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

				handler.handleMessage(client, message);

				await vi.waitFor(() => {
					expect(getLastResponse(client)).toMatchObject({
						type: expectedType,
						success: false,
						error: expectedError,
					});
				});
			}

			for (const [callbackName, message, expectedType, expectedError] of [
				[
					'getMarketplaceManifest',
					{ type: 'marketplace_get_manifest' },
					'marketplace_get_manifest_result',
					'Failed to load marketplace: manifest boom',
				],
				[
					'getMarketplaceDocument',
					{
						type: 'marketplace_get_document',
						playbookPath: 'category/sample',
						filename: 'STEP_1',
					},
					'marketplace_get_document_result',
					'Failed to fetch document: document boom',
				],
				[
					'getMarketplaceReadme',
					{ type: 'marketplace_get_readme', playbookPath: 'category/sample' },
					'marketplace_get_readme_result',
					'Failed to fetch README: readme boom',
				],
				[
					'importMarketplacePlaybook',
					{
						type: 'marketplace_import_playbook',
						sessionId: 'session-1',
						playbookId: 'pb-1',
						targetFolderName: 'folder',
					},
					'marketplace_import_playbook_result',
					'Import failed: import boom',
				],
			] as const) {
				vi.mocked(client.socket.send).mockClear();
				const errorName = expectedError.split(': ')[1];
				(callbacks[callbackName] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
					new Error(errorName)
				);

				handler.handleMessage(client, message);

				await vi.waitFor(() => {
					expect(getLastResponse(client)).toMatchObject({
						type: expectedType,
						success: false,
						error: expectedError,
					});
				});
			}
		});

		it('rejects additional marketplace request validation edges with typed results', () => {
			for (const [message, expectedType, expectedError] of [
				[
					{ type: 'marketplace_get_document', filename: 'STEP_1' },
					'marketplace_get_document_result',
					'Missing or invalid playbookPath',
				],
				[
					{ type: 'marketplace_get_document', playbookPath: 'category/sample' },
					'marketplace_get_document_result',
					'Missing or invalid filename',
				],
				[
					{ type: 'marketplace_get_readme' },
					'marketplace_get_readme_result',
					'Missing or invalid playbookPath',
				],
				[
					{ type: 'marketplace_get_readme', playbookPath: '~/private' },
					'marketplace_get_readme_result',
					'Local filesystem paths are not allowed',
				],
				[
					{ type: 'marketplace_import_playbook', targetFolderName: 'folder' },
					'marketplace_import_playbook_result',
					'Missing sessionId',
				],
				[
					{
						type: 'marketplace_import_playbook',
						sessionId: 'session-1',
						targetFolderName: 'folder',
					},
					'marketplace_import_playbook_result',
					'Missing playbookId',
				],
			] as Array<[WebClientMessage, string, string]>) {
				vi.mocked(client.socket.send).mockClear();

				handler.handleMessage(client, message);

				expect(getLastResponse(client)).toMatchObject({
					type: expectedType,
					success: false,
				});
				expect(getLastResponse(client).error).toContain(expectedError);
			}
		});
	});

	describe('Session, group, and git management messages', () => {
		it('creates a session with optional agent config fields', async () => {
			const sessionSshRemoteConfig = { enabled: true, remoteId: 'remote-1' };

			handler.handleMessage(client, {
				type: 'create_session',
				name: 'Agent',
				toolType: 'codex',
				cwd: '/repo',
				groupId: 'group-1',
				nudgeMessage: 'continue',
				newSessionMessage: 'start',
				customPath: '/usr/local/bin/codex',
				customArgs: '--profile default',
				customEnvVars: { A: '1' },
				customModel: 'gpt-5',
				customEffort: 'high',
				customContextWindow: 1000000,
				customProviderPath: '/provider',
				sessionSshRemoteConfig,
				autoRunFolderPath: '/shared/autorun',
				requestId: 'create-session-req',
			});

			await vi.waitFor(() => {
				expect(callbacks.createSession).toHaveBeenCalledWith('Agent', 'codex', '/repo', 'group-1', {
					nudgeMessage: 'continue',
					newSessionMessage: 'start',
					customPath: '/usr/local/bin/codex',
					customArgs: '--profile default',
					customEnvVars: { A: '1' },
					customModel: 'gpt-5',
					customEffort: 'high',
					customContextWindow: 1000000,
					customProviderPath: '/provider',
					sessionSshRemoteConfig,
					autoRunFolderPath: '/shared/autorun',
				});
			});

			const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(response).toMatchObject({
				type: 'create_session_result',
				success: true,
				sessionId: 'new-session-1',
				requestId: 'create-session-req',
			});
		});

		it('updates SSH config and manages session identity messages', async () => {
			handler.handleMessage(client, {
				type: 'update_session_ssh',
				sessionId: 'session-1',
				sshPatch: { enabled: false },
				requestId: 'ssh-req',
			});

			await vi.waitFor(() => {
				expect(callbacks.updateSessionSsh).toHaveBeenCalledWith('session-1', { enabled: false });
			});
			let response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'update_session_ssh_result',
				success: true,
				sessionId: 'session-1',
				requestId: 'ssh-req',
			});

			handler.handleMessage(client, {
				type: 'delete_session',
				sessionId: 'session-1',
				requestId: 'delete-session-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.deleteSession).toHaveBeenCalledWith('session-1');
			});
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'delete_session_result',
				success: true,
				sessionId: 'session-1',
				requestId: 'delete-session-req',
			});

			handler.handleMessage(client, {
				type: 'rename_session',
				sessionId: 'session-1',
				newName: 'Renamed',
				requestId: 'rename-session-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.renameSession).toHaveBeenCalledWith('session-1', 'Renamed');
			});
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'rename_session_result',
				success: true,
				sessionId: 'session-1',
				newName: 'Renamed',
				requestId: 'rename-session-req',
			});
		});

		it('handles group CRUD, membership moves, and git data requests', async () => {
			(callbacks.getGroups as any).mockReturnValue([{ id: 'group-1', name: 'Alpha' }]);
			(callbacks.getGitDiff as any).mockResolvedValue({ diff: 'diff --git a/a.ts b/a.ts' });

			handler.handleMessage(client, { type: 'get_groups', requestId: 'groups-req' });
			let response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'groups_list',
				groups: [{ id: 'group-1', name: 'Alpha' }],
				requestId: 'groups-req',
			});

			handler.handleMessage(client, {
				type: 'create_group',
				name: 'New',
				emoji: 'N',
				requestId: 'create-group-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.createGroup).toHaveBeenCalledWith('New', 'N');
			});
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'create_group_result',
				success: true,
				groupId: 'group-1',
				requestId: 'create-group-req',
			});

			handler.handleMessage(client, {
				type: 'rename_group',
				groupId: 'group-1',
				name: 'Beta',
				requestId: 'rename-group-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.renameGroup).toHaveBeenCalledWith('group-1', 'Beta');
			});

			handler.handleMessage(client, {
				type: 'delete_group',
				groupId: 'group-1',
				requestId: 'delete-group-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.deleteGroup).toHaveBeenCalledWith('group-1');
			});

			handler.handleMessage(client, {
				type: 'move_session_to_group',
				sessionId: 'session-1',
				groupId: null,
				requestId: 'move-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.moveSessionToGroup).toHaveBeenCalledWith('session-1', null);
			});
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'move_session_to_group_result',
				success: true,
				sessionId: 'session-1',
				groupId: null,
				requestId: 'move-req',
			});

			handler.handleMessage(client, {
				type: 'get_git_status',
				sessionId: 'session-1',
				requestId: 'git-status-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.getGitStatus).toHaveBeenCalledWith('session-1');
			});

			handler.handleMessage(client, {
				type: 'get_git_diff',
				sessionId: 'session-1',
				filePath: 'src/a.ts',
				requestId: 'git-diff-req',
			});
			await vi.waitFor(() => {
				expect(callbacks.getGitDiff).toHaveBeenCalledWith('session-1', 'src/a.ts');
			});
			response = JSON.parse((client.socket.send as any).mock.calls.at(-1)[0]);
			expect(response).toMatchObject({
				type: 'git_diff',
				sessionId: 'session-1',
				diff: { diff: 'diff --git a/a.ts b/a.ts' },
				requestId: 'git-diff-req',
			});
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

	describe('Update Session Cwd (Web → Desktop)', () => {
		it('forwards the new cwd to the callback and echoes it in the result', async () => {
			(callbacks.updateSessionCwd as any).mockResolvedValue({ success: true });

			handler.handleMessage(client, {
				type: 'update_session_cwd',
				sessionId: 'session-1',
				newCwd: '/Users/me/cases/archive/2024-Q4/case-123',
				requestId: 'req-1',
			});

			await new Promise((resolve) => setImmediate(resolve));

			expect(callbacks.updateSessionCwd).toHaveBeenCalledWith(
				'session-1',
				'/Users/me/cases/archive/2024-Q4/case-123'
			);
			expect(client.socket.send).toHaveBeenCalledWith(
				expect.stringContaining('"type":"update_session_cwd_result"')
			);
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload).toMatchObject({
				type: 'update_session_cwd_result',
				success: true,
				sessionId: 'session-1',
				newCwd: '/Users/me/cases/archive/2024-Q4/case-123',
				requestId: 'req-1',
			});
		});

		it('surfaces the renderer-supplied error when the update is refused', async () => {
			(callbacks.updateSessionCwd as any).mockResolvedValue({
				success: false,
				error: 'Agent process is running; stop it before changing cwd',
			});

			handler.handleMessage(client, {
				type: 'update_session_cwd',
				sessionId: 'session-1',
				newCwd: '/tmp/elsewhere',
			});

			await new Promise((resolve) => setImmediate(resolve));

			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload).toMatchObject({
				type: 'update_session_cwd_result',
				success: false,
				error: 'Agent process is running; stop it before changing cwd',
			});
		});

		it('rejects update with missing sessionId', () => {
			handler.handleMessage(client, {
				type: 'update_session_cwd',
				newCwd: '/tmp/foo',
			});

			expect(callbacks.updateSessionCwd).not.toHaveBeenCalled();
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload.type).toBe('error');
			expect(payload.message).toContain('sessionId');
		});

		it('rejects update with empty newCwd', () => {
			handler.handleMessage(client, {
				type: 'update_session_cwd',
				sessionId: 'session-1',
				newCwd: '   ',
			});

			expect(callbacks.updateSessionCwd).not.toHaveBeenCalled();
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload.type).toBe('error');
			expect(payload.message).toContain('newCwd');
		});
	});

	describe('Create Worktree Session (CLI → Desktop)', () => {
		it('forwards parent + trimmed config to the callback and echoes the new id', async () => {
			(callbacks.createWorktreeSession as any).mockResolvedValue({
				success: true,
				sessionId: 'wt-1',
			});

			handler.handleMessage(client, {
				type: 'create_worktree_session',
				parentSessionId: 'parent-1',
				branchName: '  feature/foo  ',
				baseBranch: '  rc  ',
				requestId: 'req-1',
			});

			await new Promise((resolve) => setImmediate(resolve));

			expect(callbacks.createWorktreeSession).toHaveBeenCalledWith('parent-1', {
				branchName: 'feature/foo',
				baseBranch: 'rc',
			});
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload).toMatchObject({
				type: 'create_worktree_session_result',
				success: true,
				sessionId: 'wt-1',
				requestId: 'req-1',
			});
		});

		it('surfaces the renderer-supplied error', async () => {
			(callbacks.createWorktreeSession as any).mockResolvedValue({
				success: false,
				error: 'Parent agent parent-9 not found',
			});

			handler.handleMessage(client, {
				type: 'create_worktree_session',
				parentSessionId: 'parent-9',
				branchName: 'feature/bar',
			});

			await new Promise((resolve) => setImmediate(resolve));

			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload).toMatchObject({
				type: 'create_worktree_session_result',
				success: false,
				error: 'Parent agent parent-9 not found',
			});
		});

		it('rejects a missing parentSessionId', () => {
			handler.handleMessage(client, {
				type: 'create_worktree_session',
				branchName: 'feature/bar',
			});

			expect(callbacks.createWorktreeSession).not.toHaveBeenCalled();
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload.type).toBe('error');
			expect(payload.message).toContain('parentSessionId');
		});

		it('rejects a missing/empty branchName', () => {
			handler.handleMessage(client, {
				type: 'create_worktree_session',
				parentSessionId: 'parent-1',
				branchName: '   ',
			});

			expect(callbacks.createWorktreeSession).not.toHaveBeenCalled();
			const payload = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(payload.type).toBe('error');
			expect(payload.message).toContain('branchName');
		});
	});
});
