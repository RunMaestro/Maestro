import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessions, type Session } from '../../web/hooks/useSessions';
import type { ServerMessage, SessionData } from '../../web/hooks/useWebSocket';
import type { Theme } from '../../shared/theme-types';

vi.mock('../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

class FakeWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly sent: string[] = [];
	readyState = FakeWebSocket.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close(code = 1000, reason = '') {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code, reason, wasClean: code === 1000 } as CloseEvent);
	}

	open() {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.(new Event('open'));
	}

	message(message: ServerMessage) {
		this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
	}

	rawMessage(data: string) {
		this.onmessage?.({ data } as MessageEvent);
	}

	fail() {
		this.onerror?.(new Event('error'));
	}
}

const theme: Theme = {
	id: 'github-light',
	name: 'GitHub Light',
	mode: 'light',
	colors: {
		bgMain: '#ffffff',
		bgSidebar: '#f6f8fa',
		bgActivity: '#eff2f5',
		border: '#d0d7de',
		textMain: '#24292f',
		textDim: '#57606a',
		accent: '#0969da',
		accentDim: 'rgba(9, 105, 218, 0.1)',
		accentText: '#0969da',
		accentForeground: '#ffffff',
		success: '#1a7f37',
		warning: '#9a6700',
		error: '#cf222e',
	},
};

function session(overrides: Partial<SessionData> = {}): SessionData {
	return {
		id: 'session-1',
		name: 'Claude',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/Users/test/project',
		groupId: null,
		groupName: null,
		groupEmoji: null,
		activeTabId: 'tab-1',
		aiTabs: [],
		...overrides,
	};
}

function connectHook(options: Parameters<typeof useSessions>[0] = {}) {
	const hook = renderHook(() =>
		useSessions({
			autoConnect: true,
			url: 'ws://maestro.test/token/ws',
			autoReconnect: false,
			pingInterval: 0,
			...options,
		})
	);
	const socket = FakeWebSocket.instances.at(-1);
	if (!socket) throw new Error('Expected useSessions to create a WebSocket');
	return { ...hook, socket };
}

function jsonSent(socket: FakeWebSocket) {
	return socket.sent.map((message) => JSON.parse(message));
}

function jsonResponse(body: unknown, ok = true): Response {
	return {
		ok,
		json: vi.fn().mockResolvedValue(body),
	} as unknown as Response;
}

describe('useSessions integration', () => {
	let originalWebSocket: typeof WebSocket;
	let originalGlobalWebSocket: typeof WebSocket;
	let originalFetch: typeof fetch;
	let consoleSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		FakeWebSocket.instances = [];
		originalWebSocket = window.WebSocket;
		originalGlobalWebSocket = globalThis.WebSocket;
		originalFetch = globalThis.fetch;
		window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		globalThis.fetch = vi.fn();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		window.WebSocket = originalWebSocket;
		globalThis.WebSocket = originalGlobalWebSocket;
		globalThis.fetch = originalFetch;
		consoleSpy.mockRestore();
		vi.useRealTimers();
	});

	it('connects through the real WebSocket hook and folds server session messages into grouped state', async () => {
		const onThemeUpdate = vi.fn();
		const onSessionsChange = vi.fn();
		const onActiveSessionChange = vi.fn();
		const { result, socket, unmount } = connectHook({
			onThemeUpdate,
			onSessionsChange,
			onActiveSessionChange,
		});

		expect(socket.url).toBe('ws://maestro.test/token/ws');
		expect(result.current.connectionState).toBe('connecting');

		act(() => socket.open());
		expect(result.current.connectionState).toBe('authenticating');

		act(() =>
			socket.message({
				type: 'connected',
				clientId: 'client-1',
				message: 'connected',
				authenticated: true,
			})
		);
		await waitFor(() => expect(result.current.connectionState).toBe('authenticated'));
		expect(result.current.isConnected).toBe(true);
		expect(result.current.clientId).toBe('client-1');

		act(() =>
			socket.message({
				type: 'sessions_list',
				sessions: [
					session({
						id: 'alpha',
						name: 'Alpha',
						groupId: 'team',
						groupName: 'Team',
						groupEmoji: 'T',
					}),
					session({ id: 'solo', name: 'Solo' }),
				],
			})
		);
		expect(result.current.sessions.map((item) => item.id)).toEqual(['alpha', 'solo']);
		expect(onSessionsChange).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'alpha', name: 'Alpha' }),
			expect.objectContaining({ id: 'solo', name: 'Solo' }),
		]);
		expect(result.current.sessionsByGroup.team).toMatchObject({
			id: 'team',
			name: 'Team',
			emoji: 'T',
		});
		expect(result.current.sessionsByGroup.ungrouped.sessions).toHaveLength(1);

		act(() => result.current.setActiveSessionId('alpha'));
		await waitFor(() => expect(result.current.activeSession?.id).toBe('alpha'));
		expect(onActiveSessionChange).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: 'alpha' })
		);
		expect(result.current.getSession('solo')?.name).toBe('Solo');

		act(() =>
			socket.message({
				type: 'session_state_change',
				sessionId: 'alpha',
				state: 'busy',
				name: 'Alpha Renamed',
				toolType: 'codex',
				inputMode: 'terminal',
				cwd: '/tmp/project',
			})
		);
		expect(result.current.getSession('alpha')).toMatchObject({
			name: 'Alpha Renamed',
			state: 'busy',
			toolType: 'codex',
			inputMode: 'terminal',
			cwd: '/tmp/project',
		});

		act(() =>
			socket.message({
				type: 'tabs_changed',
				sessionId: 'alpha',
				activeTabId: 'tab-2',
				aiTabs: [
					{
						id: 'tab-2',
						agentSessionId: 'agent-1',
						name: 'Plan',
						starred: true,
						inputValue: 'draft',
						createdAt: 1,
						state: 'idle',
					},
				],
			})
		);
		expect(result.current.getSession('alpha')?.activeTabId).toBe('tab-2');
		expect(result.current.getSession('alpha')?.aiTabs?.[0].name).toBe('Plan');

		act(() =>
			socket.message({
				type: 'session_state_change',
				sessionId: 'missing',
				state: 'busy',
			})
		);
		act(() =>
			socket.message({
				type: 'tabs_changed',
				sessionId: 'missing',
				activeTabId: 'ghost',
				aiTabs: [],
			})
		);
		expect(result.current.sessions).toHaveLength(2);

		act(() => socket.message({ type: 'theme', theme }));
		expect(onThemeUpdate).toHaveBeenCalledWith(theme);

		act(() => socket.message({ type: 'session_added', session: session({ id: 'new' }) }));
		act(() => socket.message({ type: 'session_added', session: session({ id: 'new' }) }));
		expect(result.current.sessions.filter((item) => item.id === 'new')).toHaveLength(1);

		act(() => socket.message({ type: 'session_removed', sessionId: 'alpha' }));
		expect(result.current.getSession('alpha')).toBeUndefined();
		await waitFor(() => expect(result.current.activeSession).toBeNull());

		unmount();
		expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
	});

	it('sends commands and interrupts through fetch while preserving per-session client state', async () => {
		const onError = vi.fn();
		const { result, socket } = connectHook({ onError });
		act(() => socket.open());
		act(() =>
			socket.message({
				type: 'sessions_list',
				sessions: [session({ id: 'alpha' })],
			})
		);
		act(() => result.current.setActiveSessionId('alpha'));

		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));
		let commandResult = false;
		await act(async () => {
			commandResult = await result.current.sendCommand('alpha', 'npm test');
		});
		expect(commandResult).toBe(true);
		expect(fetch).toHaveBeenLastCalledWith(
			expect.stringMatching(/\/api\/session\/alpha\/send$/),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ command: 'npm test' }),
			})
		);
		await waitFor(() => expect(result.current.getSession('alpha')?.isSending).toBe(false));
		expect(result.current.getSession('alpha')?.lastError).toBeUndefined();

		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: false, error: 'send failed' }));
		await act(async () => {
			commandResult = await result.current.sendCommand('alpha', 'bad');
		});
		expect(commandResult).toBe(false);
		expect(result.current.getSession('alpha')).toMatchObject({
			isSending: false,
			lastError: 'send failed',
		});
		expect(onError).toHaveBeenLastCalledWith('send failed');

		act(() =>
			socket.message({
				type: 'sessions_list',
				sessions: [session({ id: 'alpha', name: 'Alpha refreshed' })],
			})
		);
		expect(result.current.getSession('alpha')).toMatchObject({
			name: 'Alpha refreshed',
			lastError: 'send failed',
		});

		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));
		await act(async () => {
			commandResult = await result.current.sendCommand('missing', 'noop');
		});
		expect(commandResult).toBe(true);

		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: false }, false));
		await act(async () => {
			commandResult = await result.current.sendCommand('missing', 'bad missing');
		});
		expect(commandResult).toBe(false);
		expect(onError).toHaveBeenLastCalledWith('Failed to send command');

		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));
		await act(async () => {
			commandResult = await result.current.sendToActive('queued');
		});
		expect(commandResult).toBe(true);
		expect(fetch).toHaveBeenLastCalledWith(
			expect.stringMatching(/\/api\/session\/alpha\/send$/),
			expect.objectContaining({ body: JSON.stringify({ command: 'queued' }) })
		);

		act(() => result.current.setActiveSessionId(null));
		await act(async () => {
			commandResult = await result.current.sendToActive('missing');
		});
		expect(commandResult).toBe(false);
		expect(onError).toHaveBeenLastCalledWith('No active session');

		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));
		let interruptResult = false;
		await act(async () => {
			interruptResult = await result.current.interrupt('alpha');
		});
		expect(interruptResult).toBe(true);
		expect(fetch).toHaveBeenLastCalledWith(
			expect.stringMatching(/\/api\/session\/alpha\/interrupt$/),
			expect.objectContaining({ method: 'POST' })
		);

		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({ success: false, error: 'interrupt failed' }, false)
		);
		await act(async () => {
			interruptResult = await result.current.interrupt('alpha');
		});
		expect(interruptResult).toBe(false);
		expect(onError).toHaveBeenLastCalledWith('interrupt failed');

		act(() => result.current.setActiveSessionId('alpha'));
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));
		await act(async () => {
			interruptResult = await result.current.interruptActive();
		});
		expect(interruptResult).toBe(true);

		act(() => result.current.setActiveSessionId(null));
		await act(async () => {
			interruptResult = await result.current.interruptActive();
		});
		expect(interruptResult).toBe(false);
		expect(onError).toHaveBeenLastCalledWith('No active session');
	});

	it('routes hook actions through the real WebSocket send path and handles auth/error states', async () => {
		const onError = vi.fn();
		const { result, socket } = connectHook({ onError });

		act(() => socket.open());
		act(() =>
			socket.message({
				type: 'auth_required',
				clientId: 'client-auth',
				message: 'token required',
			})
		);
		expect(result.current.connectionState).toBe('connected');
		expect(result.current.clientId).toBe('client-auth');

		act(() => result.current.authenticate('secret-token'));
		expect(jsonSent(socket).at(-1)).toEqual({ type: 'auth', token: 'secret-token' });
		expect(result.current.connectionState).toBe('authenticating');

		act(() =>
			socket.message({
				type: 'auth_success',
				clientId: 'client-auth',
				message: 'ok',
			})
		);
		expect(result.current.connectionState).toBe('authenticated');

		await expect(result.current.switchMode('alpha', 'terminal')).resolves.toBe(true);
		await expect(result.current.selectTab('alpha', 'tab-1')).resolves.toBe(true);
		await expect(result.current.newTab('alpha')).resolves.toBe(true);
		await expect(result.current.closeTab('alpha', 'tab-1')).resolves.toBe(true);
		result.current.refreshSessions();
		expect(jsonSent(socket).slice(-5)).toEqual([
			{ type: 'switch_mode', sessionId: 'alpha', mode: 'terminal' },
			{ type: 'select_tab', sessionId: 'alpha', tabId: 'tab-1' },
			{ type: 'new_tab', sessionId: 'alpha' },
			{ type: 'close_tab', sessionId: 'alpha', tabId: 'tab-1' },
			{ type: 'get_sessions' },
		]);

		act(() => socket.message({ type: 'auth_failed', message: 'bad token' }));
		expect(result.current.connectionError).toBe('bad token');
		expect(onError).toHaveBeenLastCalledWith('bad token');

		act(() => socket.message({ type: 'error', message: 'server error' }));
		expect(result.current.connectionError).toBe('server error');
		expect(onError).toHaveBeenLastCalledWith('server error');

		act(() => socket.rawMessage('{bad json'));
		expect(result.current.connectionState).toBe('authenticated');

		socket.readyState = FakeWebSocket.CLOSED;
		await expect(result.current.switchMode('alpha', 'ai')).resolves.toBe(false);
	});

	it('surfaces connection creation and socket errors without entering reconnect loops', () => {
		const onError = vi.fn();
		const { result, socket } = connectHook({ onError });

		act(() => socket.fail());
		expect(result.current.connectionError).toBe('WebSocket connection error');
		expect(onError).toHaveBeenLastCalledWith('WebSocket connection error');

		class ThrowingWebSocket extends FakeWebSocket {
			constructor(url: string) {
				super(url);
				throw new Error('constructor failed');
			}
		}
		window.WebSocket = ThrowingWebSocket as unknown as typeof WebSocket;
		globalThis.WebSocket = ThrowingWebSocket as unknown as typeof WebSocket;

		const failing = renderHook(() =>
			useSessions({
				autoConnect: false,
				url: 'ws://broken.test/ws',
				autoReconnect: false,
				onError,
			})
		);

		act(() => failing.result.current.connect());
		expect(failing.result.current.connectionState).toBe('disconnected');
		expect(failing.result.current.connectionError).toBe('Failed to create WebSocket connection');
		expect(onError).toHaveBeenLastCalledWith('Failed to create WebSocket connection');
	});
});
