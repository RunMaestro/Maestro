/**
 * Tests for the WebSocket message routing switch used by useMaestroWebSocket.
 *
 * Regression: the Claude Code per-turn path on the desktop emits `session_exit`
 * instead of `session_state_change` -> 'idle'. Before this fix the mobile app
 * had no case for `session_exit`, so the spinner stayed visible forever and
 * `onSend` early-returned because `isGenerating` was always true.
 *
 * These tests verify the dispatch table separately from React so we don't have
 * to spin up the full RN module graph.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Handlers = {
	onConnectionChange?: (state: string) => void;
	onSessionsUpdate?: (sessions: any[]) => void;
	onSessionStateChange?: (sessionId: string, state: string) => void;
	onSessionOutput?: (
		sessionId: string,
		data: string,
		source: 'ai' | 'terminal',
		tabId?: string
	) => void;
	onSessionExit?: (sessionId: string) => void;
	onToolEvent?: (sessionId: string, tabId: string, toolLog: any) => void;
	onUserInput?: (sessionId: string, command: string, inputMode: 'ai' | 'terminal') => void;
	onTabsChanged?: (sessionId: string, aiTabs: any[], activeTabId: string) => void;
	onThemeUpdate?: (theme: any) => void;
	onError?: (error: string) => void;
};

/**
 * Mirror of the switch in src/lib/useMaestroWebSocket.ts:handleMessage.
 * Kept in sync intentionally so changes to either must update both.
 */
function dispatch(message: any, handlers: Handlers): void {
	switch (message.type) {
		case 'connected':
			handlers.onConnectionChange?.(message.authenticated ? 'authenticated' : 'connected');
			break;
		case 'auth_success':
			handlers.onConnectionChange?.('authenticated');
			break;
		case 'auth_failed':
			handlers.onError?.(message.message);
			break;
		case 'sessions_list':
			handlers.onSessionsUpdate?.(message.sessions);
			break;
		case 'session_state_change':
			handlers.onSessionStateChange?.(message.sessionId, message.state);
			break;
		case 'session_output':
			handlers.onSessionOutput?.(message.sessionId, message.data, message.source, message.tabId);
			break;
		case 'session_exit':
			handlers.onSessionExit?.(message.sessionId);
			break;
		case 'tool_event':
			handlers.onToolEvent?.(message.sessionId, message.tabId, message.toolLog);
			break;
		case 'user_input':
			handlers.onUserInput?.(message.sessionId, message.command, message.inputMode);
			break;
		case 'tabs_changed':
			handlers.onTabsChanged?.(message.sessionId, message.aiTabs, message.activeTabId);
			break;
		case 'error':
			handlers.onError?.(message.message);
			break;
		case 'theme':
			handlers.onThemeUpdate?.(message.theme);
			break;
		default:
			break;
	}
}

describe('WebSocket message routing', () => {
	it('routes session_exit to onSessionExit (regression: stuck spinner)', () => {
		const onSessionExit = jest.fn();
		const onSessionStateChange = jest.fn();

		dispatch({ type: 'session_exit', sessionId: 's1' }, { onSessionExit, onSessionStateChange });

		expect(onSessionExit).toHaveBeenCalledTimes(1);
		expect(onSessionExit).toHaveBeenCalledWith('s1');
		// session_exit must NOT be misrouted to onSessionStateChange.
		expect(onSessionStateChange).not.toHaveBeenCalled();
	});

	it('routes session_output to onSessionOutput with tabId', () => {
		const onSessionOutput = jest.fn();
		dispatch(
			{ type: 'session_output', sessionId: 's1', data: 'Hi', source: 'ai', tabId: 't1' },
			{ onSessionOutput }
		);
		expect(onSessionOutput).toHaveBeenCalledWith('s1', 'Hi', 'ai', 't1');
	});

	it('routes session_state_change to onSessionStateChange', () => {
		const onSessionStateChange = jest.fn();
		dispatch(
			{ type: 'session_state_change', sessionId: 's1', state: 'idle' },
			{ onSessionStateChange }
		);
		expect(onSessionStateChange).toHaveBeenCalledWith('s1', 'idle');
	});

	it('ignores unknown message types without throwing', () => {
		expect(() =>
			dispatch({ type: 'definitely-not-a-real-event' }, { onError: jest.fn() })
		).not.toThrow();
	});

	it('does not call session_exit handler for other message types', () => {
		const onSessionExit = jest.fn();
		dispatch({ type: 'session_state_change', sessionId: 's1', state: 'idle' }, { onSessionExit });
		dispatch(
			{ type: 'session_output', sessionId: 's1', data: 'x', source: 'ai' },
			{ onSessionExit }
		);
		dispatch({ type: 'sessions_list', sessions: [] }, { onSessionExit });
		expect(onSessionExit).not.toHaveBeenCalled();
	});
});

describe('Subscriber fan-out semantics', () => {
	/**
	 * Mirrors the Set-of-handlers fan-out pattern in SessionsContext: a single
	 * upstream event is delivered to every subscriber, and a thrown handler
	 * doesn't suppress others.
	 */
	function makeRegistry<T extends (...args: any[]) => void>() {
		const subs = new Set<T>();
		return {
			subscribe(handler: T) {
				subs.add(handler);
				return () => {
					subs.delete(handler);
				};
			},
			emit(...args: Parameters<T>) {
				subs.forEach((h) => {
					try {
						h(...args);
					} catch {
						// swallow per SessionsContext behavior
					}
				});
			},
			size: () => subs.size,
		};
	}

	it('delivers a single emit to every subscriber exactly once', () => {
		const r = makeRegistry<(s: string) => void>();
		const a = jest.fn();
		const b = jest.fn();
		const c = jest.fn();
		r.subscribe(a);
		r.subscribe(b);
		r.subscribe(c);

		r.emit('hello');

		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
		expect(c).toHaveBeenCalledTimes(1);
		expect(a).toHaveBeenCalledWith('hello');
	});

	it('does not double-deliver if the same handler subscribes twice (Set dedupe)', () => {
		const r = makeRegistry<() => void>();
		const a = jest.fn();
		r.subscribe(a);
		r.subscribe(a);
		expect(r.size()).toBe(1);
		r.emit();
		expect(a).toHaveBeenCalledTimes(1);
	});

	it('returns an unsubscribe that removes only the right handler', () => {
		const r = makeRegistry<() => void>();
		const a = jest.fn();
		const b = jest.fn();
		const unsubA = r.subscribe(a);
		r.subscribe(b);

		unsubA();

		r.emit();
		expect(a).not.toHaveBeenCalled();
		expect(b).toHaveBeenCalledTimes(1);
	});

	it('isolates exceptions: a throwing subscriber does not block later ones', () => {
		const r = makeRegistry<() => void>();
		const thrower = jest.fn(() => {
			throw new Error('boom');
		});
		const survivor = jest.fn();
		r.subscribe(thrower);
		r.subscribe(survivor);

		r.emit();

		expect(thrower).toHaveBeenCalledTimes(1);
		expect(survivor).toHaveBeenCalledTimes(1);
	});
});
