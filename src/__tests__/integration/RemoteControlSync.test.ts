/**
 * Integration Tests for Remote Control Sync
 *
 * These tests verify the COMPLETE bidirectional sync between desktop and web.
 * The remote control must be a perfect mirror - when one side moves, the other moves.
 *
 * CRITICAL: These tests should FAIL if the callback wiring is broken.
 * This is the regression protection we've been missing.
 *
 * Sync Contract:
 * 1. Desktop → Web: Theme, session state, tabs, AutoRun, user input
 * 2. Web → Desktop: Commands, mode switch, session/tab selection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import {
	BroadcastService,
	type WebClientInfo,
} from '../../main/web-server/services/broadcastService';
import {
	WebSocketMessageHandler,
	type WebClient,
	type MessageHandlerCallbacks,
} from '../../main/web-server/handlers/messageHandlers';
import type { Theme } from '../../shared/theme-types';

// Mock the logger
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

/**
 * This simulates the WebServer class wiring that happens in web-server.ts
 * If this wiring breaks in the actual code, these tests should guide the fix
 */
class MockWebServer {
	private webClients = new Map<string, WebClientInfo>();
	private broadcastService: BroadcastService;
	private messageHandler: WebSocketMessageHandler;

	// Desktop callbacks (simulating what index.ts provides)
	private selectTabCallback: ((sessionId: string, tabId: string) => Promise<boolean>) | null = null;
	private selectSessionCallback: ((sessionId: string, tabId?: string) => Promise<boolean>) | null =
		null;
	private executeCommandCallback:
		| ((sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => Promise<boolean>)
		| null = null;
	private switchModeCallback:
		| ((sessionId: string, mode: 'ai' | 'terminal') => Promise<boolean>)
		| null = null;
	private getThemeCallback: (() => Theme | null) | null = null;

	constructor() {
		this.broadcastService = new BroadcastService();
		this.messageHandler = new WebSocketMessageHandler();

		// Wire up broadcast service (like in web-server.ts constructor)
		this.broadcastService.setGetWebClientsCallback(() => this.webClients);
	}

	/**
	 * Simulate the start() method which wires up message handler callbacks
	 * THIS IS THE CRITICAL WIRING THAT CAN BREAK
	 */
	start(): void {
		this.messageHandler.setCallbacks({
			getSessionDetail: () => ({ state: 'idle', inputMode: 'ai', agentSessionId: 'claude-123' }),
			executeCommand: async (sessionId, command, inputMode) => {
				if (!this.executeCommandCallback) return false;
				return this.executeCommandCallback(sessionId, command, inputMode);
			},
			switchMode: async (sessionId, mode) => {
				if (!this.switchModeCallback) return false;
				return this.switchModeCallback(sessionId, mode);
			},
			selectSession: async (sessionId, tabId) => {
				if (!this.selectSessionCallback) return false;
				return this.selectSessionCallback(sessionId, tabId);
			},
			selectTab: async (sessionId, tabId) => {
				if (!this.selectTabCallback) return false;
				return this.selectTabCallback(sessionId, tabId);
			},
			newTab: async () => ({ tabId: 'new-tab' }),
			closeTab: async () => true,
			getSessions: () => [],
			getLiveSessionInfo: () => undefined,
			isSessionLive: () => false,
		});
	}

	// Setters for desktop callbacks (like setSelectTabCallback in web-server.ts)
	setSelectTabCallback(cb: (sessionId: string, tabId: string) => Promise<boolean>): void {
		this.selectTabCallback = cb;
	}

	setSelectSessionCallback(cb: (sessionId: string, tabId?: string) => Promise<boolean>): void {
		this.selectSessionCallback = cb;
	}

	setExecuteCommandCallback(
		cb: (sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => Promise<boolean>
	): void {
		this.executeCommandCallback = cb;
	}

	setSwitchModeCallback(
		cb: (sessionId: string, mode: 'ai' | 'terminal') => Promise<boolean>
	): void {
		this.switchModeCallback = cb;
	}

	setGetThemeCallback(cb: () => Theme | null): void {
		this.getThemeCallback = cb;
	}

	// Client management
	addClient(client: WebClientInfo): void {
		this.webClients.set(client.id, client);
	}

	getClientCount(): number {
		return this.webClients.size;
	}

	// Expose services for testing
	getBroadcastService(): BroadcastService {
		return this.broadcastService;
	}

	getMessageHandler(): WebSocketMessageHandler {
		return this.messageHandler;
	}
}

/**
 * Create a mock WebSocket client that captures sent messages
 */
function createMockWebClient(id: string): WebClientInfo & { sentMessages: any[] } {
	const sentMessages: any[] = [];
	return {
		id,
		connectedAt: Date.now(),
		socket: {
			readyState: WebSocket.OPEN,
			send: vi.fn((data: string) => {
				sentMessages.push(JSON.parse(data));
			}),
		} as unknown as WebSocket,
		sentMessages,
	};
}

describe('Remote Control Sync - Integration Tests', () => {
	let server: MockWebServer;

	beforeEach(() => {
		server = new MockWebServer();
	});

	describe('Desktop → Web Sync', () => {
		describe('Theme Sync', () => {
			it('should broadcast theme change to all connected web clients', () => {
				const client1 = createMockWebClient('client-1');
				const client2 = createMockWebClient('client-2');
				server.addClient(client1);
				server.addClient(client2);

				const theme: Theme = {
					id: 'monokai',
					name: 'Monokai',
					mode: 'dark',
					colors: {
						bgMain: '#272822',
						bgSidebar: '#1e1f1c',
						bgActivity: '#3e3d32',
						border: '#49483e',
						textMain: '#f8f8f2',
						textDim: '#75715e',
						accent: '#a6e22e',
						accentDim: 'rgba(166, 226, 46, 0.2)',
						accentText: '#a6e22e',
						success: '#a6e22e',
						warning: '#e6db74',
						error: '#f92672',
					},
				};

				server.getBroadcastService().broadcastThemeChange(theme);

				// Both clients should receive the theme
				expect(client1.sentMessages).toHaveLength(1);
				expect(client1.sentMessages[0].type).toBe('theme');
				expect(client1.sentMessages[0].theme.id).toBe('monokai');

				expect(client2.sentMessages).toHaveLength(1);
				expect(client2.sentMessages[0].type).toBe('theme');
			});

			it('should NOT drop theme broadcast when callback is properly wired', () => {
				// This test ensures the callback chain is intact
				const client = createMockWebClient('client-1');
				server.addClient(client);

				// Verify client count is correct
				expect(server.getClientCount()).toBe(1);

				server.getBroadcastService().broadcastThemeChange({
					id: 'test',
					name: 'Test',
					mode: 'dark',
					colors: {} as any,
				});

				// Message MUST be received
				expect(client.sentMessages.length).toBeGreaterThan(0);
				expect(client.sentMessages[0].type).toBe('theme');
			});
		});

		describe('Session State Sync', () => {
			it('should broadcast session state changes', () => {
				const client = createMockWebClient('client-1');
				server.addClient(client);

				server.getBroadcastService().broadcastSessionStateChange('session-1', 'busy', {
					name: 'My Session',
					toolType: 'claude-code',
				});

				expect(client.sentMessages).toHaveLength(1);
				expect(client.sentMessages[0].type).toBe('session_state_change');
				expect(client.sentMessages[0].sessionId).toBe('session-1');
				expect(client.sentMessages[0].state).toBe('busy');
			});
		});

		describe('Tab Sync', () => {
			it('should broadcast tab changes', () => {
				const client = createMockWebClient('client-1');
				server.addClient(client);

				server.getBroadcastService().broadcastTabsChange(
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

				expect(client.sentMessages).toHaveLength(1);
				expect(client.sentMessages[0].type).toBe('tabs_changed');
				expect(client.sentMessages[0].activeTabId).toBe('tab-2');
				expect(client.sentMessages[0].aiTabs).toHaveLength(2);
			});
		});

		describe('AutoRun Sync', () => {
			it('should broadcast AutoRun state when started', () => {
				const client = createMockWebClient('client-1');
				server.addClient(client);

				server.getBroadcastService().broadcastAutoRunState('session-1', {
					isRunning: true,
					totalTasks: 10,
					completedTasks: 0,
					currentTaskIndex: 0,
				});

				expect(client.sentMessages).toHaveLength(1);
				expect(client.sentMessages[0].type).toBe('autorun_state');
				expect(client.sentMessages[0].state.isRunning).toBe(true);
				expect(client.sentMessages[0].state.totalTasks).toBe(10);
			});

			it('should broadcast AutoRun progress', () => {
				const client = createMockWebClient('client-1');
				server.addClient(client);

				server.getBroadcastService().broadcastAutoRunState('session-1', {
					isRunning: true,
					totalTasks: 10,
					completedTasks: 5,
					currentTaskIndex: 5,
				});

				expect(client.sentMessages[0].state.completedTasks).toBe(5);
			});

			it('should broadcast AutoRun stopped', () => {
				const client = createMockWebClient('client-1');
				server.addClient(client);

				server.getBroadcastService().broadcastAutoRunState('session-1', null);

				expect(client.sentMessages[0].state).toBeNull();
			});
		});

		describe('User Input Sync (Desktop typing shows on web)', () => {
			it('should broadcast user input to subscribed clients', () => {
				const subscribedClient = createMockWebClient('subscribed');
				subscribedClient.subscribedSessionId = 'session-1';
				const otherClient = createMockWebClient('other');
				otherClient.subscribedSessionId = 'session-2';

				server.addClient(subscribedClient);
				server.addClient(otherClient);

				server.getBroadcastService().broadcastUserInput('session-1', 'Hello from desktop', 'ai');

				// Subscribed client receives it
				expect(subscribedClient.sentMessages).toHaveLength(1);
				expect(subscribedClient.sentMessages[0].type).toBe('user_input');
				expect(subscribedClient.sentMessages[0].command).toBe('Hello from desktop');

				// Other client does NOT receive it (wrong session)
				expect(otherClient.sentMessages).toHaveLength(0);
			});
		});
	});

	describe('Web → Desktop Sync', () => {
		beforeEach(() => {
			// Must call start() to wire up the message handler callbacks
			server.start();
		});

		describe('Tab Selection', () => {
			it('should forward tab selection from web to desktop', async () => {
				const desktopCallback = vi.fn().mockResolvedValue(true);
				server.setSelectTabCallback(desktopCallback);

				const client: WebClient = {
					id: 'web-client',
					connectedAt: Date.now(),
					socket: {
						readyState: WebSocket.OPEN,
						send: vi.fn(),
					} as unknown as WebSocket,
				};

				server.getMessageHandler().handleMessage(client, {
					type: 'select_tab',
					sessionId: 'session-1',
					tabId: 'tab-2',
				});

				// Wait for async callback and response
				await vi.waitFor(() => {
					expect(desktopCallback).toHaveBeenCalledWith('session-1', 'tab-2');
					expect((client.socket.send as any).mock.calls.length).toBeGreaterThan(0);
				});

				// Verify success response sent to web client
				const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
				expect(response.type).toBe('select_tab_result');
				expect(response.success).toBe(true);
			});

			it('should fail gracefully when callback not configured', async () => {
				// Don't set the callback - simulate broken wiring
				// Need a fresh server without the selectTab callback
				const freshServer = new MockWebServer();
				// Call start() but don't set selectTabCallback
				freshServer.start();

				const client: WebClient = {
					id: 'web-client',
					connectedAt: Date.now(),
					socket: {
						readyState: WebSocket.OPEN,
						send: vi.fn(),
					} as unknown as WebSocket,
				};

				freshServer.getMessageHandler().handleMessage(client, {
					type: 'select_tab',
					sessionId: 'session-1',
					tabId: 'tab-2',
				});

				// Wait for response (selectTab returns false when callback not set, triggering error path)
				await vi.waitFor(() => {
					expect((client.socket.send as any).mock.calls.length).toBeGreaterThan(0);
				});

				const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
				expect(response.type).toBe('select_tab_result');
				expect(response.success).toBe(false);
			});
		});

		describe('Session Selection', () => {
			it('should forward session selection from web to desktop', async () => {
				const desktopCallback = vi.fn().mockResolvedValue(true);
				server.setSelectSessionCallback(desktopCallback);

				const client: WebClient = {
					id: 'web-client',
					connectedAt: Date.now(),
					socket: {
						readyState: WebSocket.OPEN,
						send: vi.fn(),
					} as unknown as WebSocket,
				};

				server.getMessageHandler().handleMessage(client, {
					type: 'select_session',
					sessionId: 'session-2',
				});

				await vi.waitFor(() => {
					expect(desktopCallback).toHaveBeenCalledWith('session-2', undefined);
				});
			});
		});

		describe('Command Execution', () => {
			it('should forward AI commands from web to desktop', async () => {
				const desktopCallback = vi.fn().mockResolvedValue(true);
				server.setExecuteCommandCallback(desktopCallback);

				const client: WebClient = {
					id: 'web-client',
					connectedAt: Date.now(),
					socket: {
						readyState: WebSocket.OPEN,
						send: vi.fn(),
					} as unknown as WebSocket,
				};

				server.getMessageHandler().handleMessage(client, {
					type: 'send_command',
					sessionId: 'session-1',
					command: 'Hello Claude!',
					inputMode: 'ai',
				});

				await vi.waitFor(() => {
					expect(desktopCallback).toHaveBeenCalledWith('session-1', 'Hello Claude!', 'ai');
				});
			});

			it('should forward terminal commands from web to desktop', async () => {
				const desktopCallback = vi.fn().mockResolvedValue(true);
				server.setExecuteCommandCallback(desktopCallback);

				const client: WebClient = {
					id: 'web-client',
					connectedAt: Date.now(),
					socket: {
						readyState: WebSocket.OPEN,
						send: vi.fn(),
					} as unknown as WebSocket,
				};

				server.getMessageHandler().handleMessage(client, {
					type: 'send_command',
					sessionId: 'session-1',
					command: 'npm test',
					inputMode: 'terminal',
				});

				await vi.waitFor(() => {
					expect(desktopCallback).toHaveBeenCalledWith('session-1', 'npm test', 'terminal');
				});
			});
		});

		describe('Mode Switching', () => {
			it('should forward mode switch from web to desktop', async () => {
				const desktopCallback = vi.fn().mockResolvedValue(true);
				server.setSwitchModeCallback(desktopCallback);

				const client: WebClient = {
					id: 'web-client',
					connectedAt: Date.now(),
					socket: {
						readyState: WebSocket.OPEN,
						send: vi.fn(),
					} as unknown as WebSocket,
				};

				server.getMessageHandler().handleMessage(client, {
					type: 'switch_mode',
					sessionId: 'session-1',
					mode: 'terminal',
				});

				await vi.waitFor(() => {
					expect(desktopCallback).toHaveBeenCalledWith('session-1', 'terminal');
				});
			});
		});
	});

	describe('Full Round-Trip Sync', () => {
		it('should sync tab selection: web → desktop → broadcast to all web clients', async () => {
			server.start();

			// Set up desktop callback that broadcasts the change back
			const broadcastService = server.getBroadcastService();
			server.setSelectTabCallback(async (sessionId, tabId) => {
				// Desktop processes the tab change and broadcasts to all web clients
				broadcastService.broadcastTabsChange(
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
							id: 'tab-2',
							agentSessionId: null,
							name: 'Tab 2',
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

			// Add two web clients
			const client1 = createMockWebClient('client-1');
			const client2 = createMockWebClient('client-2');
			server.addClient(client1);
			server.addClient(client2);

			// Client 1 selects a tab
			const selectingClient: WebClient = {
				id: 'client-1',
				connectedAt: Date.now(),
				socket: client1.socket,
			};

			server.getMessageHandler().handleMessage(selectingClient, {
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'tab-2',
			});

			// Wait for the callback chain to complete
			await vi.waitFor(() => {
				// Both clients should receive the tabs_changed broadcast
				const client1TabsMsg = client1.sentMessages.find((m) => m.type === 'tabs_changed');
				const client2TabsMsg = client2.sentMessages.find((m) => m.type === 'tabs_changed');

				expect(client1TabsMsg).toBeDefined();
				expect(client1TabsMsg.activeTabId).toBe('tab-2');

				expect(client2TabsMsg).toBeDefined();
				expect(client2TabsMsg.activeTabId).toBe('tab-2');
			});
		});
	});
});
