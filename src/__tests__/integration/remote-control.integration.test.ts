/**
 * Remote Control Integration Tests
 *
 * These tests verify the real-time bidirectional communication between
 * the web interface and desktop application via WebSocket.
 *
 * Key scenarios tested:
 * 1. Web → Desktop: Commands sent from web are received by desktop callbacks
 * 2. Desktop → Web: Responses/state changes from desktop are broadcast to web clients
 * 3. Round-trip: Full cycle of command → processing → broadcast
 *
 * Run with: RUN_INTEGRATION_TESTS=true npm run test:integration -- --testNamePattern="Remote Control"
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { WebServer } from '../../main/web-server';
import type { Theme, ThemeId } from '../../shared/theme-types';

// Skip if not running integration tests
const runTests = process.env.RUN_INTEGRATION_TESTS === 'true';

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

// Test fixtures - use actual ThemeId to pass type checks
const TEST_THEME: Theme = {
	id: 'dracula' as ThemeId,
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
		accentForeground: '#ffffff',
		success: '#4caf50',
		warning: '#ff9800',
		error: '#f44336',
	},
};

interface TestTab {
	id: string;
	agentSessionId: string | null;
	name: string;
	starred: boolean;
	inputValue: string;
	createdAt: number;
	state: string;
}

const TEST_TABS: TestTab[] = [
	{
		id: 'tab-1',
		agentSessionId: 'agent-1',
		name: 'Main Tab',
		starred: false,
		inputValue: '',
		createdAt: Date.now(),
		state: 'idle',
	},
	{
		id: 'tab-2',
		agentSessionId: 'agent-2',
		name: 'Secondary Tab',
		starred: false,
		inputValue: '',
		createdAt: Date.now(),
		state: 'idle',
	},
];

describe.skipIf(!runTests)('Remote Control Integration Tests', () => {
	let server: WebServer;
	let wsUrl: string;

	beforeEach(async () => {
		// Create fresh server with random port
		server = new WebServer(0);

		// Set up required data callbacks
		server.setGetSessionsCallback(() => [
			{
				id: 'session-1',
				name: 'Test Session',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai' as const,
				cwd: '/test/project',
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
			cwd: '/test/project',
		}));
		server.setGetThemeCallback(() => TEST_THEME);
		server.setGetCustomCommandsCallback(() => []);

		// Start server
		const { port, token } = await server.start();
		wsUrl = `ws://localhost:${port}/${token}/ws`;
	});

	afterEach(async () => {
		await server.stop();
	});

	/**
	 * Helper: Create a connected WebSocket client
	 */
	async function createWebClient(): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(wsUrl);
			const timeout = setTimeout(() => {
				reject(new Error('Connection timeout'));
			}, 5000);

			socket.on('open', () => {
				clearTimeout(timeout);
				resolve(socket);
			});
			socket.on('error', (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});
	}

	/**
	 * Helper: Wait for a specific message type from WebSocket
	 */
	function waitForMessage(socket: WebSocket, type: string, timeout = 5000): Promise<any> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Timeout waiting for message type: ${type}`));
			}, timeout);

			const handler = (data: WebSocket.RawData) => {
				try {
					const msg = JSON.parse(data.toString());
					if (msg.type === type) {
						clearTimeout(timer);
						socket.off('message', handler);
						resolve(msg);
					}
				} catch {
					// Ignore parse errors
				}
			};

			socket.on('message', handler);
		});
	}

	/**
	 * Helper: Wait for connection to be fully established
	 * Drains initial messages (connected, sessions_list, theme, custom_commands)
	 */
	async function waitForConnection(socket: WebSocket): Promise<void> {
		// Wait for initial messages to arrive - similar to e2e test pattern
		await new Promise((r) => setTimeout(r, 200));
	}

	/**
	 * Helper: Send message from web client
	 */
	function sendFromWeb(socket: WebSocket, message: object): void {
		socket.send(JSON.stringify(message));
	}

	// =====================================================
	// Web → Desktop Tests (Commands from Web Interface)
	// =====================================================

	describe('Web → Desktop: Command Execution', () => {
		it('should deliver commands from web to desktop callback', async () => {
			const desktopCallback = vi.fn().mockResolvedValue(true);
			server.setExecuteCommandCallback(desktopCallback);

			const client = await createWebClient();
			await waitForConnection(client);

			const responsePromise = waitForMessage(client, 'command_result');

			// Web sends command to desktop
			sendFromWeb(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Hello from the web interface!',
				inputMode: 'ai',
			});

			const response = await responsePromise;

			// Verify desktop received the command
			expect(desktopCallback).toHaveBeenCalledTimes(1);
			expect(desktopCallback).toHaveBeenCalledWith(
				'session-1',
				'Hello from the web interface!',
				'ai'
			);

			// Verify web received confirmation
			expect(response.success).toBe(true);

			client.close();
		});

		it('should handle command execution failure gracefully', async () => {
			const desktopCallback = vi.fn().mockRejectedValue(new Error('Desktop error'));
			server.setExecuteCommandCallback(desktopCallback);

			const client = await createWebClient();
			await waitForConnection(client);

			// When callback throws, server sends 'error' message, not 'command_result'
			const responsePromise = waitForMessage(client, 'error');

			sendFromWeb(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'This will fail',
				inputMode: 'ai',
			});

			const response = await responsePromise;
			expect(response.type).toBe('error');
			expect(response.message).toContain('Desktop error');

			client.close();
		});

		it('should handle terminal mode commands', async () => {
			const desktopCallback = vi.fn().mockResolvedValue(true);
			server.setExecuteCommandCallback(desktopCallback);

			const client = await createWebClient();
			await waitForConnection(client);

			const responsePromise = waitForMessage(client, 'command_result');

			sendFromWeb(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'ls -la',
				inputMode: 'terminal',
			});

			const response = await responsePromise;

			expect(desktopCallback).toHaveBeenCalledWith('session-1', 'ls -la', 'terminal');
			expect(response.success).toBe(true);

			client.close();
		});
	});

	describe('Web → Desktop: Session Selection', () => {
		it('should notify desktop when web selects a session', async () => {
			const desktopCallback = vi.fn().mockResolvedValue(true);
			server.setSelectSessionCallback(desktopCallback);

			const client = await createWebClient();
			await waitForConnection(client);

			const responsePromise = waitForMessage(client, 'select_session_result');

			sendFromWeb(client, {
				type: 'select_session',
				sessionId: 'session-2',
			});

			const response = await responsePromise;

			expect(desktopCallback).toHaveBeenCalledWith('session-2', undefined);
			expect(response.success).toBe(true);

			client.close();
		});

		it('should subscribe client to session output after selecting a session', async () => {
			// This test verifies the fix: selecting a session should automatically
			// subscribe the client to that session's output broadcasts
			const desktopCallback = vi.fn().mockResolvedValue(true);
			server.setSelectSessionCallback(desktopCallback);

			const client = await createWebClient();
			await waitForConnection(client);

			// Client selects session-2
			const selectPromise = waitForMessage(client, 'select_session_result');
			sendFromWeb(client, {
				type: 'select_session',
				sessionId: 'session-2',
			});
			await selectPromise;

			// Now broadcast output specifically to session-2 using broadcastToSessionClients
			// This is different from broadcastToWebClients - it only sends to subscribed clients
			const outputPromise = waitForMessage(client, 'session_output');
			server.broadcastToSessionClients('session-2', {
				type: 'session_output',
				sessionId: 'session-2',
				data: 'Hello from session-2!',
				source: 'ai',
				timestamp: Date.now(),
			});

			const output = await outputPromise;
			expect(output.data).toBe('Hello from session-2!');

			client.close();
		});

		it('should NOT receive output for other sessions after selecting a specific session', async () => {
			const desktopCallback = vi.fn().mockResolvedValue(true);
			server.setSelectSessionCallback(desktopCallback);

			const client = await createWebClient();
			await waitForConnection(client);

			// Client selects session-2
			const selectPromise = waitForMessage(client, 'select_session_result');
			sendFromWeb(client, {
				type: 'select_session',
				sessionId: 'session-2',
			});
			await selectPromise;

			// Broadcast to session-1 (not the subscribed session)
			// Client should NOT receive this because they're subscribed to session-2
			const messages: any[] = [];
			client.on('message', (data) => {
				try {
					const msg = JSON.parse(data.toString());
					if (msg.type === 'session_output') {
						messages.push(msg);
					}
				} catch {
					// Ignore parse errors
				}
			});

			server.broadcastToSessionClients('session-1', {
				type: 'session_output',
				sessionId: 'session-1',
				data: 'This should not arrive!',
				source: 'ai',
				timestamp: Date.now(),
			});

			// Wait briefly to ensure message doesn't arrive
			await new Promise((r) => setTimeout(r, 200));

			// Should not have received any session_output messages
			expect(messages.length).toBe(0);

			client.close();
		});
	});

	describe('Web → Desktop: Tab Operations', () => {
		it('should notify desktop when web selects a tab', async () => {
			const desktopCallback = vi.fn().mockResolvedValue(true);
			server.setSelectTabCallback(desktopCallback);

			const client = await createWebClient();
			await waitForConnection(client);

			const responsePromise = waitForMessage(client, 'select_tab_result');

			sendFromWeb(client, {
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'tab-2',
			});

			const response = await responsePromise;

			expect(desktopCallback).toHaveBeenCalledWith('session-1', 'tab-2');
			expect(response.success).toBe(true);

			client.close();
		});

		it('should notify desktop when web creates a new tab', async () => {
			const desktopCallback = vi.fn().mockResolvedValue({ tabId: 'new-tab' });
			server.setNewTabCallback(desktopCallback);

			const client = await createWebClient();
			await waitForConnection(client);

			const responsePromise = waitForMessage(client, 'new_tab_result');

			sendFromWeb(client, {
				type: 'new_tab',
				sessionId: 'session-1',
			});

			const response = await responsePromise;

			expect(desktopCallback).toHaveBeenCalledWith('session-1');
			expect(response.success).toBe(true);

			client.close();
		});

		it('should notify desktop when web closes a tab', async () => {
			const desktopCallback = vi.fn().mockResolvedValue(true);
			server.setCloseTabCallback(desktopCallback);

			const client = await createWebClient();
			await waitForConnection(client);

			const responsePromise = waitForMessage(client, 'close_tab_result');

			sendFromWeb(client, {
				type: 'close_tab',
				sessionId: 'session-1',
				tabId: 'tab-2',
			});

			const response = await responsePromise;

			expect(desktopCallback).toHaveBeenCalledWith('session-1', 'tab-2');
			expect(response.success).toBe(true);

			client.close();
		});

		it('should notify desktop when web renames a tab', async () => {
			const desktopCallback = vi.fn().mockResolvedValue(true);
			server.setRenameTabCallback(desktopCallback);

			const client = await createWebClient();
			await waitForConnection(client);

			const responsePromise = waitForMessage(client, 'rename_tab_result');

			sendFromWeb(client, {
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
				newName: 'Renamed Tab',
			});

			const response = await responsePromise;

			expect(desktopCallback).toHaveBeenCalledWith('session-1', 'tab-1', 'Renamed Tab');
			expect(response.success).toBe(true);

			client.close();
		});
	});

	describe('Web → Desktop: Mode Switching', () => {
		it('should notify desktop when web switches to terminal mode', async () => {
			const desktopCallback = vi.fn().mockResolvedValue(true);
			server.setSwitchModeCallback(desktopCallback);

			const client = await createWebClient();
			await waitForConnection(client);

			const responsePromise = waitForMessage(client, 'mode_switch_result');

			sendFromWeb(client, {
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'terminal',
			});

			const response = await responsePromise;

			expect(desktopCallback).toHaveBeenCalledWith('session-1', 'terminal');
			expect(response.success).toBe(true);

			client.close();
		});

		it('should notify desktop when web switches to AI mode', async () => {
			const desktopCallback = vi.fn().mockResolvedValue(true);
			server.setSwitchModeCallback(desktopCallback);

			const client = await createWebClient();
			await waitForConnection(client);

			const responsePromise = waitForMessage(client, 'mode_switch_result');

			sendFromWeb(client, {
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'ai',
			});

			const response = await responsePromise;

			expect(desktopCallback).toHaveBeenCalledWith('session-1', 'ai');
			expect(response.success).toBe(true);

			client.close();
		});
	});

	// =====================================================
	// Desktop → Web Tests (Broadcasts from Desktop)
	// =====================================================

	describe('Desktop → Web: Session Output Broadcast', () => {
		it('should immediately broadcast session output to web clients', async () => {
			const client = await createWebClient();
			await waitForConnection(client);

			const outputPromise = waitForMessage(client, 'session_output');

			// Desktop broadcasts output using generic broadcast (simulates agent response)
			server.broadcastToWebClients({
				type: 'session_output',
				sessionId: 'session-1',
				data: 'Hello from the AI agent!',
				source: 'agent',
				timestamp: Date.now(),
			});

			const msg = await outputPromise;

			expect(msg.type).toBe('session_output');
			expect(msg.sessionId).toBe('session-1');
			expect(msg.data).toBe('Hello from the AI agent!');
			expect(msg.source).toBe('agent');

			client.close();
		});

		it('should broadcast output to multiple web clients simultaneously', async () => {
			const client1 = await createWebClient();
			const client2 = await createWebClient();
			const client3 = await createWebClient();

			await Promise.all([
				waitForConnection(client1),
				waitForConnection(client2),
				waitForConnection(client3),
			]);

			const outputPromises = [
				waitForMessage(client1, 'session_output'),
				waitForMessage(client2, 'session_output'),
				waitForMessage(client3, 'session_output'),
			];

			// Desktop broadcasts output
			server.broadcastToWebClients({
				type: 'session_output',
				sessionId: 'session-1',
				data: 'Broadcast to all clients!',
				source: 'agent',
				timestamp: Date.now(),
			});

			const results = await Promise.all(outputPromises);

			// All clients should receive the same output
			for (const msg of results) {
				expect(msg.type).toBe('session_output');
				expect(msg.data).toBe('Broadcast to all clients!');
			}

			client1.close();
			client2.close();
			client3.close();
		});
	});

	describe('Desktop → Web: Session State Changes', () => {
		it('should broadcast session state changes to web clients', async () => {
			const client = await createWebClient();
			await waitForConnection(client);

			const statePromise = waitForMessage(client, 'session_state_change');

			// Desktop changes session state (e.g., agent starts processing)
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

		it('should broadcast when session becomes idle after processing', async () => {
			const client = await createWebClient();
			await waitForConnection(client);

			// First, broadcast busy state
			server.broadcastSessionStateChange('session-1', 'busy', {
				name: 'Test Session',
				toolType: 'claude-code',
			});

			await waitForMessage(client, 'session_state_change');

			// Then, broadcast idle state
			const idlePromise = waitForMessage(client, 'session_state_change');
			server.broadcastSessionStateChange('session-1', 'idle', {
				name: 'Test Session',
				toolType: 'claude-code',
			});

			const msg = await idlePromise;

			expect(msg.state).toBe('idle');

			client.close();
		});
	});

	describe('Desktop → Web: Tab Changes', () => {
		it('should broadcast tab changes to web clients', async () => {
			const client = await createWebClient();
			await waitForConnection(client);

			const tabsPromise = waitForMessage(client, 'tabs_changed');

			// Desktop broadcasts tab change
			server.broadcastTabsChange('session-1', TEST_TABS, 'tab-2');

			const msg = await tabsPromise;

			expect(msg.type).toBe('tabs_changed');
			expect(msg.sessionId).toBe('session-1');
			expect(msg.activeTabId).toBe('tab-2');
			expect(msg.aiTabs).toHaveLength(2);

			client.close();
		});
	});

	describe('Desktop → Web: Theme Changes', () => {
		it('should broadcast theme changes to web clients', async () => {
			const client = await createWebClient();
			await waitForConnection(client);

			const themePromise = waitForMessage(client, 'theme');

			const newTheme: Theme = {
				...TEST_THEME,
				id: 'nord' as ThemeId,
				name: 'New Theme',
				mode: 'light',
			};

			server.broadcastThemeChange(newTheme);

			const msg = await themePromise;

			expect(msg.type).toBe('theme');
			expect(msg.theme.id).toBe('nord');
			expect(msg.theme.mode).toBe('light');

			client.close();
		});
	});

	describe('Desktop → Web: AutoRun State', () => {
		it('should broadcast AutoRun state to web clients', async () => {
			const client = await createWebClient();
			await waitForConnection(client);

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

	// =====================================================
	// Full Round-Trip Tests (Web → Desktop → Web)
	// =====================================================

	describe('Full Round-Trip: Command Execution Cycle', () => {
		it('should complete: web sends command → desktop processes → all web clients receive output', async () => {
			// Set up desktop to process command and broadcast response
			const desktopCallback = vi.fn().mockImplementation(async (sessionId: string, command: string) => {
				// Simulate desktop processing: broadcast state change and output
				server.broadcastSessionStateChange(sessionId, 'busy', {
					name: 'Test Session',
					toolType: 'claude-code',
				});

				// Simulate agent response after processing
				await new Promise((r) => setTimeout(r, 50));
				server.broadcastToWebClients({
					type: 'session_output',
					sessionId,
					data: `Response to: ${command}`,
					source: 'agent',
					timestamp: Date.now(),
				});

				server.broadcastSessionStateChange(sessionId, 'idle', {
					name: 'Test Session',
					toolType: 'claude-code',
				});

				return true;
			});
			server.setExecuteCommandCallback(desktopCallback);

			// Connect two web clients
			const client1 = await createWebClient();
			const client2 = await createWebClient();
			await Promise.all([waitForConnection(client1), waitForConnection(client2)]);

			// Set up listeners for the broadcast on both clients
			const outputPromise1 = waitForMessage(client1, 'session_output');
			const outputPromise2 = waitForMessage(client2, 'session_output');

			// Client 1 sends a command
			sendFromWeb(client1, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Hello from web!',
				inputMode: 'ai',
			});

			// Both clients should receive the output broadcast
			const [output1, output2] = await Promise.all([outputPromise1, outputPromise2]);

			expect(output1.data).toBe('Response to: Hello from web!');
			expect(output2.data).toBe('Response to: Hello from web!');

			client1.close();
			client2.close();
		});

		it('should complete: web selects tab → desktop updates → all web clients receive tab change', async () => {
			const desktopCallback = vi.fn().mockImplementation(async (sessionId: string, tabId: string) => {
				// Desktop processes tab selection and broadcasts update
				const updatedTabs = TEST_TABS.map((tab) => ({
					...tab,
					state: tab.id === tabId ? 'busy' : 'idle',
				}));
				server.broadcastTabsChange(sessionId, updatedTabs, tabId);
				return true;
			});
			server.setSelectTabCallback(desktopCallback);

			const client1 = await createWebClient();
			const client2 = await createWebClient();
			await Promise.all([waitForConnection(client1), waitForConnection(client2)]);

			// Set up listeners
			const tabPromise1 = waitForMessage(client1, 'tabs_changed');
			const tabPromise2 = waitForMessage(client2, 'tabs_changed');

			// Client 1 selects a tab
			sendFromWeb(client1, {
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'tab-2',
			});

			// Both clients should receive the tab change
			const [tabs1, tabs2] = await Promise.all([tabPromise1, tabPromise2]);

			expect(tabs1.activeTabId).toBe('tab-2');
			expect(tabs2.activeTabId).toBe('tab-2');

			client1.close();
			client2.close();
		});
	});

	// =====================================================
	// Connection and Reliability Tests
	// =====================================================

	describe('Connection Lifecycle', () => {
		it('should send initial state on connection', async () => {
			const messages: any[] = [];
			const client = await new Promise<WebSocket>((resolve, reject) => {
				const socket = new WebSocket(wsUrl);
				socket.on('message', (data) => {
					messages.push(JSON.parse(data.toString()));
				});
				socket.on('open', () => resolve(socket));
				socket.on('error', reject);
			});

			// Wait for initial messages
			await new Promise((r) => setTimeout(r, 300));

			// Should receive essential initial state
			expect(messages.find((m) => m.type === 'connected')).toBeDefined();
			expect(messages.find((m) => m.type === 'sessions_list')).toBeDefined();
			expect(messages.find((m) => m.type === 'theme')).toBeDefined();
			expect(messages.find((m) => m.type === 'custom_commands')).toBeDefined();

			client.close();
		});

		it('should handle client disconnection gracefully', async () => {
			const client = await createWebClient();
			await waitForConnection(client);

			expect(server.getWebClientCount()).toBe(1);

			client.close();
			await new Promise((r) => setTimeout(r, 100));

			expect(server.getWebClientCount()).toBe(0);

			// Broadcasting should not throw with no clients
			expect(() => {
				server.broadcastToWebClients({
					type: 'session_output',
					sessionId: 'session-1',
					data: 'Test',
					source: 'agent',
					timestamp: Date.now(),
				});
			}).not.toThrow();
		});

		it('should handle rapid connect/disconnect cycles', async () => {
			for (let i = 0; i < 5; i++) {
				const client = await createWebClient();
				await waitForConnection(client);
				expect(server.getWebClientCount()).toBeGreaterThan(0);
				client.close();
				await new Promise((r) => setTimeout(r, 50));
			}

			// All clients should be cleaned up
			await new Promise((r) => setTimeout(r, 200));
			expect(server.getWebClientCount()).toBe(0);
		});
	});

	describe('Ping/Pong Health Check', () => {
		it('should respond to ping messages', async () => {
			const client = await createWebClient();
			await waitForConnection(client);

			const pongPromise = waitForMessage(client, 'pong');

			sendFromWeb(client, { type: 'ping' });

			const msg = await pongPromise;
			expect(msg.type).toBe('pong');

			client.close();
		});
	});

	describe('Error Handling', () => {
		it('should handle malformed messages gracefully', async () => {
			const client = await createWebClient();
			await waitForConnection(client);

			// Send malformed message - should not crash server
			client.send('not valid json');
			client.send(JSON.stringify({ type: 'unknown_type' }));
			client.send(JSON.stringify({ no_type: 'field' }));

			// Server should still be operational
			await new Promise((r) => setTimeout(r, 100));
			expect(server.getWebClientCount()).toBe(1);

			// Should still respond to valid messages
			const pongPromise = waitForMessage(client, 'pong');
			sendFromWeb(client, { type: 'ping' });
			const msg = await pongPromise;
			expect(msg.type).toBe('pong');

			client.close();
		});

		it('should handle missing callbacks gracefully', async () => {
			// Don't set any callbacks - simulates broken wiring
			const client = await createWebClient();
			await waitForConnection(client);

			const responsePromise = waitForMessage(client, 'command_result');

			sendFromWeb(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Test',
				inputMode: 'ai',
			});

			const response = await responsePromise;
			expect(response.success).toBe(false);

			client.close();
		});
	});

	// =====================================================
	// Performance and Latency Tests
	// =====================================================

	describe('Latency and Performance', () => {
		it('should deliver messages with minimal latency', async () => {
			const desktopCallback = vi.fn().mockResolvedValue(true);
			server.setExecuteCommandCallback(desktopCallback);

			const client = await createWebClient();
			await waitForConnection(client);

			const start = Date.now();
			const responsePromise = waitForMessage(client, 'command_result');

			sendFromWeb(client, {
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Test',
				inputMode: 'ai',
			});

			await responsePromise;
			const latency = Date.now() - start;

			// Should complete within 100ms (generous for CI environments)
			expect(latency).toBeLessThan(100);

			client.close();
		});

		it('should handle concurrent messages from multiple clients', async () => {
			const desktopCallback = vi.fn().mockResolvedValue(true);
			server.setExecuteCommandCallback(desktopCallback);

			const clients = await Promise.all([
				createWebClient(),
				createWebClient(),
				createWebClient(),
			]);

			await Promise.all(clients.map((c) => waitForConnection(c)));

			// All clients send commands simultaneously
			const responsePromises = clients.map((client, i) => {
				const promise = waitForMessage(client, 'command_result');
				sendFromWeb(client, {
					type: 'send_command',
					sessionId: 'session-1',
					command: `Command from client ${i}`,
					inputMode: 'ai',
				});
				return promise;
			});

			const responses = await Promise.all(responsePromises);

			// All should succeed
			for (const response of responses) {
				expect(response.success).toBe(true);
			}

			// Desktop should have received all commands
			expect(desktopCallback).toHaveBeenCalledTimes(3);

			clients.forEach((c) => c.close());
		});
	});
});
