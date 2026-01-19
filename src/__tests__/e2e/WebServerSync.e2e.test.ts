/**
 * E2E Tests for WebServer ↔ Desktop Sync
 *
 * These tests use the REAL WebServer class with actual WebSocket connections.
 * They test the production wiring, not mocks.
 *
 * If these tests fail, the sync feature is broken in production.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { WebServer } from '../../main/web-server';
import type { Theme } from '../../shared/theme-types';

// Mock the logger to prevent noise in test output
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock network utils to return localhost
vi.mock('../../main/utils/networkUtils', () => ({
	getLocalIpAddressSync: () => 'localhost',
}));

// Test theme
const TEST_THEME: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#0d0d0d',
		bgActivity: '#2a2a2a',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#007acc',
		accentDim: 'rgba(0, 122, 204, 0.2)',
		accentText: '#007acc',
		success: '#4caf50',
		warning: '#ff9800',
		error: '#f44336',
	},
};

describe('WebServer E2E Sync Tests', () => {
	let server: WebServer;
	let serverUrl: string;
	let wsUrl: string;

	beforeEach(async () => {
		server = new WebServer(0); // Random port

		// Set up minimal callbacks required for operation
		server.setGetSessionsCallback(() => [
			{
				id: 'session-1',
				name: 'Test Session',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai' as const,
				cwd: '/test',
				groupId: null,
				groupName: null,
				groupEmoji: null,
			},
		]);
		server.setGetSessionDetailCallback((sessionId) => ({
			id: sessionId,
			name: 'Test Session',
			toolType: 'claude-code',
			state: 'idle',
			inputMode: 'ai',
			cwd: '/test',
		}));
		server.setGetThemeCallback(() => TEST_THEME);
		server.setGetCustomCommandsCallback(() => []);

		const { port, token } = await server.start();
		serverUrl = `http://localhost:${port}/${token}`;
		wsUrl = `ws://localhost:${port}/${token}/ws`;
	});

	afterEach(async () => {
		await server.stop();
	});

	/**
	 * Helper to create a connected WebSocket client
	 */
	async function createConnectedClient(): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			ws.on('open', () => resolve(ws));
			ws.on('error', reject);
		});
	}

	/**
	 * Helper to wait for a specific message type from WebSocket
	 */
	function waitForMessage(ws: WebSocket, type: string, timeout = 2000): Promise<any> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Timeout waiting for message type: ${type}`));
			}, timeout);

			const handler = (data: WebSocket.Data) => {
				const msg = JSON.parse(data.toString());
				if (msg.type === type) {
					clearTimeout(timer);
					ws.off('message', handler);
					resolve(msg);
				}
			};

			ws.on('message', handler);
		});
	}

	/**
	 * Helper to collect all messages for a duration
	 */
	function collectMessages(ws: WebSocket, duration: number): Promise<any[]> {
		return new Promise((resolve) => {
			const messages: any[] = [];
			const handler = (data: WebSocket.Data) => {
				messages.push(JSON.parse(data.toString()));
			};
			ws.on('message', handler);
			setTimeout(() => {
				ws.off('message', handler);
				resolve(messages);
			}, duration);
		});
	}

	describe('Desktop → Web Sync (Production Wiring)', () => {
		describe('Theme Sync', () => {
			it('should broadcast theme changes to connected WebSocket clients', async () => {
				const client = await createConnectedClient();

				// Drain initial messages (sessions, theme, commands on connect)
				await new Promise((r) => setTimeout(r, 100));

				// Start listening for theme message
				const themePromise = waitForMessage(client, 'theme');

				// Broadcast theme change through the real WebServer
				server.broadcastThemeChange({
					...TEST_THEME,
					id: 'new-theme',
					name: 'New Theme',
				});

				const msg = await themePromise;
				expect(msg.type).toBe('theme');
				expect(msg.theme.id).toBe('new-theme');
				expect(msg.theme.name).toBe('New Theme');

				client.close();
			});

			it('should broadcast theme to multiple clients simultaneously', async () => {
				const client1 = await createConnectedClient();
				const client2 = await createConnectedClient();
				const client3 = await createConnectedClient();

				// Wait for connections to stabilize
				await new Promise((r) => setTimeout(r, 100));

				// Set up listeners
				const promises = [
					waitForMessage(client1, 'theme'),
					waitForMessage(client2, 'theme'),
					waitForMessage(client3, 'theme'),
				];

				// Broadcast theme
				server.broadcastThemeChange({
					...TEST_THEME,
					id: 'broadcast-test',
					name: 'Broadcast Test',
				});

				const results = await Promise.all(promises);

				// All clients should receive the same theme
				for (const msg of results) {
					expect(msg.type).toBe('theme');
					expect(msg.theme.id).toBe('broadcast-test');
				}

				client1.close();
				client2.close();
				client3.close();
			});

			it('should NOT send theme to disconnected clients', async () => {
				const client = await createConnectedClient();
				await new Promise((r) => setTimeout(r, 50));

				// Verify client is connected
				expect(server.getWebClientCount()).toBe(1);

				// Disconnect client
				client.close();
				await new Promise((r) => setTimeout(r, 100));

				// Client should be removed
				expect(server.getWebClientCount()).toBe(0);

				// This should not throw
				server.broadcastThemeChange(TEST_THEME);
			});
		});

		describe('Session State Sync', () => {
			it('should broadcast session state changes', async () => {
				const client = await createConnectedClient();
				await new Promise((r) => setTimeout(r, 100));

				const statePromise = waitForMessage(client, 'session_state_change');

				server.broadcastSessionStateChange('session-1', 'busy', {
					name: 'Test Session',
					toolType: 'claude-code',
				});

				const msg = await statePromise;
				expect(msg.type).toBe('session_state_change');
				expect(msg.sessionId).toBe('session-1');
				expect(msg.state).toBe('busy');

				client.close();
			});
		});

		describe('Tab Sync', () => {
			it('should broadcast tab changes', async () => {
				const client = await createConnectedClient();
				await new Promise((r) => setTimeout(r, 100));

				const tabsPromise = waitForMessage(client, 'tabs_changed');

				server.broadcastTabsChange(
					'session-1',
					[
						{
							id: 'tab-1',
							agentSessionId: null,
							name: 'Tab 1',
							starred: false,
							inputValue: '',
							createdAt: Date.now(),
							state: 'idle',
						},
						{
							id: 'tab-2',
							agentSessionId: null,
							name: 'Tab 2',
							starred: false,
							inputValue: '',
							createdAt: Date.now(),
							state: 'idle',
						},
					],
					'tab-2'
				);

				const msg = await tabsPromise;
				expect(msg.type).toBe('tabs_changed');
				expect(msg.sessionId).toBe('session-1');
				expect(msg.activeTabId).toBe('tab-2');
				expect(msg.aiTabs).toHaveLength(2);

				client.close();
			});
		});

		describe('AutoRun State Sync', () => {
			it('should broadcast AutoRun state changes', async () => {
				const client = await createConnectedClient();
				await new Promise((r) => setTimeout(r, 100));

				const autoRunPromise = waitForMessage(client, 'autorun_state');

				server.broadcastAutoRunState('session-1', {
					isRunning: true,
					totalTasks: 10,
					completedTasks: 3,
					currentTaskIndex: 3,
				});

				const msg = await autoRunPromise;
				expect(msg.type).toBe('autorun_state');
				expect(msg.sessionId).toBe('session-1');
				expect(msg.state.isRunning).toBe(true);
				expect(msg.state.totalTasks).toBe(10);
				expect(msg.state.completedTasks).toBe(3);

				client.close();
			});
		});

		describe('Active Session Sync', () => {
			it('should broadcast active session changes', async () => {
				const client = await createConnectedClient();
				await new Promise((r) => setTimeout(r, 100));

				const activePromise = waitForMessage(client, 'active_session_changed');

				server.broadcastActiveSessionChange('session-2');

				const msg = await activePromise;
				expect(msg.type).toBe('active_session_changed');
				expect(msg.sessionId).toBe('session-2');

				client.close();
			});
		});
	});

	describe('Web → Desktop Sync (Production Wiring)', () => {
		describe('Tab Selection', () => {
			it('should invoke desktop callback when web client selects a tab', async () => {
				const desktopCallback = vi.fn().mockResolvedValue(true);
				server.setSelectTabCallback(desktopCallback);

				const client = await createConnectedClient();
				await new Promise((r) => setTimeout(r, 100));

				// Set up listener for response
				const responsePromise = waitForMessage(client, 'select_tab_result');

				// Send tab selection from web client
				client.send(
					JSON.stringify({
						type: 'select_tab',
						sessionId: 'session-1',
						tabId: 'tab-2',
					})
				);

				const response = await responsePromise;

				// Desktop callback should have been invoked
				expect(desktopCallback).toHaveBeenCalledWith('session-1', 'tab-2');
				expect(response.success).toBe(true);

				client.close();
			});

			it('should return failure when callback not set', async () => {
				// Don't set the callback - simulates broken wiring
				// Note: setSelectTabCallback is NOT called

				const client = await createConnectedClient();
				await new Promise((r) => setTimeout(r, 100));

				const responsePromise = waitForMessage(client, 'select_tab_result');

				client.send(
					JSON.stringify({
						type: 'select_tab',
						sessionId: 'session-1',
						tabId: 'tab-2',
					})
				);

				const response = await responsePromise;
				expect(response.success).toBe(false);

				client.close();
			});
		});

		describe('Session Selection', () => {
			it('should invoke desktop callback when web client selects a session', async () => {
				const desktopCallback = vi.fn().mockResolvedValue(true);
				server.setSelectSessionCallback(desktopCallback);

				const client = await createConnectedClient();
				await new Promise((r) => setTimeout(r, 100));

				const responsePromise = waitForMessage(client, 'select_session_result');

				client.send(
					JSON.stringify({
						type: 'select_session',
						sessionId: 'session-2',
					})
				);

				const response = await responsePromise;

				expect(desktopCallback).toHaveBeenCalledWith('session-2', undefined);
				expect(response.success).toBe(true);

				client.close();
			});
		});

		describe('Command Execution', () => {
			it('should invoke desktop callback when web client sends a command', async () => {
				const desktopCallback = vi.fn().mockResolvedValue(true);
				server.setExecuteCommandCallback(desktopCallback);

				const client = await createConnectedClient();
				await new Promise((r) => setTimeout(r, 100));

				const responsePromise = waitForMessage(client, 'command_result');

				client.send(
					JSON.stringify({
						type: 'send_command',
						sessionId: 'session-1',
						command: 'Hello from web!',
						inputMode: 'ai',
					})
				);

				const response = await responsePromise;

				expect(desktopCallback).toHaveBeenCalledWith('session-1', 'Hello from web!', 'ai');
				expect(response.success).toBe(true);

				client.close();
			});
		});

		describe('Mode Switching', () => {
			it('should invoke desktop callback when web client switches mode', async () => {
				const desktopCallback = vi.fn().mockResolvedValue(true);
				server.setSwitchModeCallback(desktopCallback);

				const client = await createConnectedClient();
				await new Promise((r) => setTimeout(r, 100));

				// Response type is 'mode_switch_result' (not 'switch_mode_result')
				const responsePromise = waitForMessage(client, 'mode_switch_result');

				client.send(
					JSON.stringify({
						type: 'switch_mode',
						sessionId: 'session-1',
						mode: 'terminal',
					})
				);

				const response = await responsePromise;

				expect(desktopCallback).toHaveBeenCalledWith('session-1', 'terminal');
				expect(response.success).toBe(true);

				client.close();
			});
		});
	});

	describe('Full Round-Trip Sync', () => {
		it('should complete full sync cycle: web selects tab → desktop callback → broadcast to all clients', async () => {
			// Set up desktop callback that broadcasts tab change back to all clients
			server.setSelectTabCallback(async (sessionId, tabId) => {
				// Simulate desktop processing the tab change
				server.broadcastTabsChange(
					sessionId,
					[
						{
							id: 'tab-1',
							agentSessionId: null,
							name: 'Tab 1',
							starred: false,
							inputValue: '',
							createdAt: Date.now(),
							state: 'idle',
						},
						{
							id: tabId,
							agentSessionId: null,
							name: 'Selected Tab',
							starred: false,
							inputValue: '',
							createdAt: Date.now(),
							state: 'idle',
						},
					],
					tabId
				);
				return true;
			});

			// Connect two web clients
			const client1 = await createConnectedClient();
			const client2 = await createConnectedClient();
			await new Promise((r) => setTimeout(r, 100));

			// Set up listeners for tab broadcast
			const tabPromise1 = waitForMessage(client1, 'tabs_changed');
			const tabPromise2 = waitForMessage(client2, 'tabs_changed');

			// Client 1 selects a tab
			client1.send(
				JSON.stringify({
					type: 'select_tab',
					sessionId: 'session-1',
					tabId: 'new-tab',
				})
			);

			// Both clients should receive the broadcast
			const [msg1, msg2] = await Promise.all([tabPromise1, tabPromise2]);

			expect(msg1.type).toBe('tabs_changed');
			expect(msg1.activeTabId).toBe('new-tab');

			expect(msg2.type).toBe('tabs_changed');
			expect(msg2.activeTabId).toBe('new-tab');

			client1.close();
			client2.close();
		});

		it('should complete full theme sync cycle: desktop changes theme → all web clients receive it', async () => {
			// Connect multiple clients
			const clients = await Promise.all([
				createConnectedClient(),
				createConnectedClient(),
				createConnectedClient(),
			]);

			await new Promise((r) => setTimeout(r, 100));

			// Set up listeners
			const promises = clients.map((c) => waitForMessage(c, 'theme'));

			// Desktop changes theme
			const newTheme: Theme = {
				...TEST_THEME,
				id: 'round-trip-theme',
				name: 'Round Trip Theme',
			};
			server.broadcastThemeChange(newTheme);

			// All clients should receive the theme
			const results = await Promise.all(promises);

			for (const msg of results) {
				expect(msg.type).toBe('theme');
				expect(msg.theme.id).toBe('round-trip-theme');
				expect(msg.theme.name).toBe('Round Trip Theme');
			}

			for (const c of clients) {
				c.close();
			}
		});
	});

	describe('Connection Lifecycle', () => {
		it('should track connected client count correctly', async () => {
			expect(server.getWebClientCount()).toBe(0);

			const client1 = await createConnectedClient();
			await new Promise((r) => setTimeout(r, 50));
			expect(server.getWebClientCount()).toBe(1);

			const client2 = await createConnectedClient();
			await new Promise((r) => setTimeout(r, 50));
			expect(server.getWebClientCount()).toBe(2);

			client1.close();
			await new Promise((r) => setTimeout(r, 100));
			expect(server.getWebClientCount()).toBe(1);

			client2.close();
			await new Promise((r) => setTimeout(r, 100));
			expect(server.getWebClientCount()).toBe(0);
		});

		it('should send initial state on connection', async () => {
			// Create client and immediately start collecting messages
			const messages: any[] = [];
			const client = await new Promise<WebSocket>((resolve, reject) => {
				const ws = new WebSocket(wsUrl);
				ws.on('message', (data) => {
					messages.push(JSON.parse(data.toString()));
				});
				ws.on('open', () => resolve(ws));
				ws.on('error', reject);
			});

			// Wait for initial messages to arrive
			await new Promise((r) => setTimeout(r, 300));

			// Should receive connection confirmation
			const connectedMsg = messages.find((m) => m.type === 'connected');
			expect(connectedMsg).toBeDefined();

			// Should receive sessions list (type is 'sessions_list', not 'sessions')
			const sessionsMsg = messages.find((m) => m.type === 'sessions_list');
			expect(sessionsMsg).toBeDefined();
			expect(sessionsMsg.sessions).toHaveLength(1);

			// Should receive theme
			const themeMsg = messages.find((m) => m.type === 'theme');
			expect(themeMsg).toBeDefined();
			expect(themeMsg.theme.id).toBe('test-theme');

			// Should receive custom commands
			const commandsMsg = messages.find((m) => m.type === 'custom_commands');
			expect(commandsMsg).toBeDefined();

			client.close();
		});
	});
});
