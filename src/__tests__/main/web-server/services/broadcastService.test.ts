/**
 * Tests for BroadcastService
 *
 * The BroadcastService is the core of desktop → web synchronization.
 * When ANYTHING changes on the desktop, it must be broadcast to all
 * connected web clients instantly. This is the "remote control" contract.
 *
 * Sync events that MUST work:
 * - Theme changes
 * - Session state changes (idle, busy, error, connecting)
 * - Session added/removed
 * - Active session changed
 * - Tab changes (new tab, close tab, switch tab)
 * - AutoRun state changes
 * - User input from desktop
 * - Session output
 * - Custom commands updates
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import {
	BroadcastService,
	type WebClientInfo,
	type SessionBroadcastData,
	type AITabData,
	type AutoRunState,
} from '../../../../main/web-server/services/broadcastService';
import type { Theme } from '../../../../shared/theme-types';

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
function createMockClient(
	id: string,
	options?: {
		readyState?: number;
		subscribedSessionId?: string;
	}
): WebClientInfo {
	return {
		id,
		connectedAt: Date.now(),
		subscribedSessionId: options?.subscribedSessionId,
		socket: {
			readyState: options?.readyState ?? WebSocket.OPEN,
			send: vi.fn(),
		} as unknown as WebSocket,
	};
}

/**
 * Create a mock theme
 */
function createMockTheme(id: string = 'dracula'): Theme {
	return {
		id,
		name: id.charAt(0).toUpperCase() + id.slice(1),
		mode: 'dark',
		colors: {
			bgMain: '#0b0b0d',
			bgSidebar: '#111113',
			bgActivity: '#1c1c1f',
			border: '#27272a',
			textMain: '#e4e4e7',
			textDim: '#a1a1aa',
			accent: '#6366f1',
			accentDim: 'rgba(99, 102, 241, 0.2)',
			accentText: '#a5b4fc',
			success: '#22c55e',
			warning: '#eab308',
			error: '#ef4444',
		},
	};
}

/**
 * Create mock session data
 */
function createMockSession(id: string = 'session-1'): SessionBroadcastData {
	return {
		id,
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/test/path',
	};
}

/**
 * Create mock AI tab data
 */
function createMockTab(id: string = 'tab-1'): AITabData {
	return {
		id,
		agentSessionId: null,
		name: 'Tab 1',
		starred: false,
		inputValue: '',
		createdAt: Date.now(),
		state: 'idle',
	};
}

describe('BroadcastService', () => {
	let service: BroadcastService;
	let clients: Map<string, WebClientInfo>;

	beforeEach(() => {
		service = new BroadcastService();
		clients = new Map();
		service.setGetWebClientsCallback(() => clients);
	});

	describe('Core Broadcasting', () => {
		it('should not broadcast when no callback is set', () => {
			const freshService = new BroadcastService();
			// Should not throw, just return silently
			expect(() => freshService.broadcastThemeChange(createMockTheme())).not.toThrow();
		});

		it('should not broadcast when no clients are connected', () => {
			service.broadcastThemeChange(createMockTheme());
			// No clients, so no send calls
			expect(clients.size).toBe(0);
		});

		it('should broadcast to all connected clients with OPEN state', () => {
			const client1 = createMockClient('client-1');
			const client2 = createMockClient('client-2');
			clients.set('client-1', client1);
			clients.set('client-2', client2);

			service.broadcastThemeChange(createMockTheme());

			expect(client1.socket.send).toHaveBeenCalledTimes(1);
			expect(client2.socket.send).toHaveBeenCalledTimes(1);
		});

		it('should NOT broadcast to clients with non-OPEN state', () => {
			const openClient = createMockClient('open', { readyState: WebSocket.OPEN });
			const closingClient = createMockClient('closing', { readyState: WebSocket.CLOSING });
			const closedClient = createMockClient('closed', { readyState: WebSocket.CLOSED });
			const connectingClient = createMockClient('connecting', { readyState: WebSocket.CONNECTING });

			clients.set('open', openClient);
			clients.set('closing', closingClient);
			clients.set('closed', closedClient);
			clients.set('connecting', connectingClient);

			service.broadcastThemeChange(createMockTheme());

			expect(openClient.socket.send).toHaveBeenCalledTimes(1);
			expect(closingClient.socket.send).not.toHaveBeenCalled();
			expect(closedClient.socket.send).not.toHaveBeenCalled();
			expect(connectingClient.socket.send).not.toHaveBeenCalled();
		});

		it('should include timestamp in all broadcast messages', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			const beforeTime = Date.now();
			service.broadcastThemeChange(createMockTheme());
			const afterTime = Date.now();

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.timestamp).toBeGreaterThanOrEqual(beforeTime);
			expect(sentData.timestamp).toBeLessThanOrEqual(afterTime);
		});
	});

	describe('Theme Sync (Desktop → Web)', () => {
		it('should broadcast theme change with correct type and theme data', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			const theme = createMockTheme('monokai');
			service.broadcastThemeChange(theme);

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.type).toBe('theme');
			expect(sentData.theme).toEqual(theme);
			expect(sentData.theme.id).toBe('monokai');
			expect(sentData.theme.name).toBe('Monokai');
		});

		it('should broadcast theme to ALL clients regardless of session subscription', () => {
			const dashboardClient = createMockClient('dashboard');
			const sessionClient = createMockClient('session', { subscribedSessionId: 'session-1' });
			clients.set('dashboard', dashboardClient);
			clients.set('session', sessionClient);

			service.broadcastThemeChange(createMockTheme());

			expect(dashboardClient.socket.send).toHaveBeenCalledTimes(1);
			expect(sessionClient.socket.send).toHaveBeenCalledTimes(1);
		});
	});

	describe('Session State Sync (Desktop → Web)', () => {
		it('should broadcast session state change', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			service.broadcastSessionStateChange('session-1', 'busy', {
				name: 'My Session',
				toolType: 'claude-code',
				inputMode: 'ai',
			});

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.type).toBe('session_state_change');
			expect(sentData.sessionId).toBe('session-1');
			expect(sentData.state).toBe('busy');
			expect(sentData.name).toBe('My Session');
			expect(sentData.toolType).toBe('claude-code');
			expect(sentData.inputMode).toBe('ai');
		});

		it('should broadcast session added', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			const session = createMockSession('new-session');
			service.broadcastSessionAdded(session);

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.type).toBe('session_added');
			expect(sentData.session).toEqual(session);
		});

		it('should broadcast session removed', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			service.broadcastSessionRemoved('deleted-session');

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.type).toBe('session_removed');
			expect(sentData.sessionId).toBe('deleted-session');
		});

		it('should broadcast sessions list for bulk sync', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			const sessions = [createMockSession('session-1'), createMockSession('session-2')];
			service.broadcastSessionsList(sessions);

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.type).toBe('sessions_list');
			expect(sentData.sessions).toHaveLength(2);
		});

		it('should broadcast active session change', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			service.broadcastActiveSessionChange('session-2');

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.type).toBe('active_session_changed');
			expect(sentData.sessionId).toBe('session-2');
		});
	});

	describe('Tab Sync (Desktop → Web)', () => {
		it('should broadcast tab changes with all tab data', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			const tabs = [createMockTab('tab-1'), createMockTab('tab-2')];
			service.broadcastTabsChange('session-1', tabs, 'tab-2');

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.type).toBe('tabs_changed');
			expect(sentData.sessionId).toBe('session-1');
			expect(sentData.aiTabs).toHaveLength(2);
			expect(sentData.activeTabId).toBe('tab-2');
		});
	});

	describe('AutoRun Sync (Desktop → Web)', () => {
		it('should broadcast AutoRun state when started', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			const state: AutoRunState = {
				isRunning: true,
				totalTasks: 5,
				completedTasks: 0,
				currentTaskIndex: 0,
			};
			service.broadcastAutoRunState('session-1', state);

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.type).toBe('autorun_state');
			expect(sentData.sessionId).toBe('session-1');
			expect(sentData.state.isRunning).toBe(true);
			expect(sentData.state.totalTasks).toBe(5);
		});

		it('should broadcast AutoRun progress updates', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			const state: AutoRunState = {
				isRunning: true,
				totalTasks: 5,
				completedTasks: 3,
				currentTaskIndex: 3,
			};
			service.broadcastAutoRunState('session-1', state);

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.state.completedTasks).toBe(3);
		});

		it('should broadcast AutoRun stopped (null state)', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			service.broadcastAutoRunState('session-1', null);

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.type).toBe('autorun_state');
			expect(sentData.state).toBeNull();
		});
	});

	describe('User Input Sync (Desktop → Web)', () => {
		it('should broadcast user input from desktop to subscribed clients', () => {
			const subscribedClient = createMockClient('subscribed', { subscribedSessionId: 'session-1' });
			const otherClient = createMockClient('other', { subscribedSessionId: 'session-2' });
			const dashboardClient = createMockClient('dashboard'); // No subscription = receives all
			clients.set('subscribed', subscribedClient);
			clients.set('other', otherClient);
			clients.set('dashboard', dashboardClient);

			service.broadcastUserInput('session-1', 'hello world', 'ai');

			// Subscribed to session-1: should receive
			expect(subscribedClient.socket.send).toHaveBeenCalledTimes(1);
			// Subscribed to session-2: should NOT receive
			expect(otherClient.socket.send).not.toHaveBeenCalled();
			// Dashboard (no subscription): should receive
			expect(dashboardClient.socket.send).toHaveBeenCalledTimes(1);

			const sentData = JSON.parse((subscribedClient.socket.send as any).mock.calls[0][0]);
			expect(sentData.type).toBe('user_input');
			expect(sentData.sessionId).toBe('session-1');
			expect(sentData.command).toBe('hello world');
			expect(sentData.inputMode).toBe('ai');
		});

		it('should broadcast terminal input correctly', () => {
			const client = createMockClient('client-1', { subscribedSessionId: 'session-1' });
			clients.set('client-1', client);

			service.broadcastUserInput('session-1', 'ls -la', 'terminal');

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.inputMode).toBe('terminal');
		});
	});

	describe('Custom Commands Sync (Desktop → Web)', () => {
		it('should broadcast custom commands updates', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			const commands = [
				{ id: '1', command: '/commit', description: 'Commit changes', prompt: 'commit' },
				{ id: '2', command: '/test', description: 'Run tests', prompt: 'test' },
			];
			service.broadcastCustomCommands(commands);

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.type).toBe('custom_commands');
			expect(sentData.commands).toHaveLength(2);
		});
	});

	describe('Session Live/Offline Status', () => {
		it('should broadcast session live status', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			service.broadcastSessionLive('session-1', 'claude-session-abc');

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.type).toBe('session_live');
			expect(sentData.sessionId).toBe('session-1');
			expect(sentData.agentSessionId).toBe('claude-session-abc');
		});

		it('should broadcast session offline status', () => {
			const client = createMockClient('client-1');
			clients.set('client-1', client);

			service.broadcastSessionOffline('session-1');

			const sentData = JSON.parse((client.socket.send as any).mock.calls[0][0]);
			expect(sentData.type).toBe('session_offline');
			expect(sentData.sessionId).toBe('session-1');
		});
	});

	describe('Session-Specific Broadcasting', () => {
		it('should only send to clients subscribed to the specific session', () => {
			const session1Client = createMockClient('s1', { subscribedSessionId: 'session-1' });
			const session2Client = createMockClient('s2', { subscribedSessionId: 'session-2' });
			clients.set('s1', session1Client);
			clients.set('s2', session2Client);

			service.broadcastToSession('session-1', { type: 'test', data: 'for session 1' });

			expect(session1Client.socket.send).toHaveBeenCalledTimes(1);
			expect(session2Client.socket.send).not.toHaveBeenCalled();
		});

		it('should send to unsubscribed clients (dashboard view)', () => {
			const dashboardClient = createMockClient('dashboard'); // No subscribedSessionId
			const sessionClient = createMockClient('session', { subscribedSessionId: 'session-1' });
			clients.set('dashboard', dashboardClient);
			clients.set('session', sessionClient);

			service.broadcastToSession('session-1', { type: 'test' });

			// Dashboard gets all session messages
			expect(dashboardClient.socket.send).toHaveBeenCalledTimes(1);
			expect(sessionClient.socket.send).toHaveBeenCalledTimes(1);
		});
	});

	describe('Concurrent Client Handling', () => {
		it('should handle many concurrent clients', () => {
			// Simulate 100 connected clients
			for (let i = 0; i < 100; i++) {
				clients.set(`client-${i}`, createMockClient(`client-${i}`));
			}

			service.broadcastThemeChange(createMockTheme());

			// All 100 clients should receive the message
			let sentCount = 0;
			for (const client of clients.values()) {
				if ((client.socket.send as any).mock.calls.length > 0) {
					sentCount++;
				}
			}
			expect(sentCount).toBe(100);
		});

		it('should handle mixed client states', () => {
			// 50 open, 25 closing, 25 closed
			for (let i = 0; i < 50; i++) {
				clients.set(`open-${i}`, createMockClient(`open-${i}`, { readyState: WebSocket.OPEN }));
			}
			for (let i = 0; i < 25; i++) {
				clients.set(
					`closing-${i}`,
					createMockClient(`closing-${i}`, { readyState: WebSocket.CLOSING })
				);
			}
			for (let i = 0; i < 25; i++) {
				clients.set(
					`closed-${i}`,
					createMockClient(`closed-${i}`, { readyState: WebSocket.CLOSED })
				);
			}

			service.broadcastThemeChange(createMockTheme());

			let openSent = 0;
			let closingSent = 0;
			let closedSent = 0;

			for (const [id, client] of clients.entries()) {
				const wasSent = (client.socket.send as any).mock.calls.length > 0;
				if (id.startsWith('open-') && wasSent) openSent++;
				if (id.startsWith('closing-') && wasSent) closingSent++;
				if (id.startsWith('closed-') && wasSent) closedSent++;
			}

			expect(openSent).toBe(50);
			expect(closingSent).toBe(0);
			expect(closedSent).toBe(0);
		});
	});
});
