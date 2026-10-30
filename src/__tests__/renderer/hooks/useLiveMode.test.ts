import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../../renderer/utils/logger';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useLiveMode } from '../../../renderer/hooks/remote/useLiveMode';
import type {
	LiveModeSetResult,
	LiveModeStateEvent,
	LiveModeStatus,
} from '../../../shared/liveMode';

describe('useLiveMode', () => {
	const originalMaestro = (window as any).maestro;

	/** Main's Live state, as `live:getState` / `live:set` see it. */
	let mainState: LiveModeStatus;
	/** URL the next successful `set(true)` answers with. */
	let nextUrl: string;

	const status = (): LiveModeStatus => ({ ...mainState });

	const mockLive = {
		getState: vi.fn(),
		set: vi.fn(),
		startServer: vi.fn(),
		stopServer: vi.fn(),
		onUrlChanged: vi.fn(),
		onStateChanged: vi.fn(),
	};

	/** Captures the handler the hook registers so tests can fire a network change. */
	let emitUrlChanged: ((data: { url: string }) => void) | null = null;
	const unsubscribeUrlChanged = vi.fn();
	/** Captures the handler main's `live:stateChanged` broadcast reaches. */
	let emitStateChanged: ((state: LiveModeStateEvent) => void) | null = null;
	const unsubscribeStateChanged = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();

		mainState = {
			live: false,
			url: null,
			remoteControl: false,
			remoteControlUrl: null,
			revision: 0,
		};
		nextUrl = 'http://localhost:3000';

		mockLive.getState.mockImplementation(async () => status());
		mockLive.set.mockImplementation(async (live: boolean) => {
			if (mainState.live === live) return { success: true, changed: false, status: status() };
			mainState = {
				...mainState,
				live,
				url: live ? nextUrl : null,
				revision: mainState.revision + 1,
			};
			return { success: true, changed: true, status: status() };
		});
		mockLive.startServer.mockResolvedValue({ success: true, url: 'http://localhost:3000' });
		mockLive.stopServer.mockResolvedValue(undefined);

		emitUrlChanged = null;
		mockLive.onUrlChanged.mockImplementation((handler: (data: { url: string }) => void) => {
			emitUrlChanged = handler;
			return unsubscribeUrlChanged;
		});
		emitStateChanged = null;
		mockLive.onStateChanged.mockImplementation((handler: (state: LiveModeStateEvent) => void) => {
			emitStateChanged = handler;
			return unsubscribeStateChanged;
		});

		(window as any).maestro = {
			...originalMaestro,
			live: mockLive,
		};
	});

	afterEach(() => {
		(window as any).maestro = originalMaestro;
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------------------
	// Initial state
	// -----------------------------------------------------------------------

	it('returns all four expected properties', () => {
		const { result } = renderHook(() => useLiveMode());

		expect(result.current).toHaveProperty('isLiveMode');
		expect(result.current).toHaveProperty('webInterfaceUrl');
		expect(result.current).toHaveProperty('toggleGlobalLive');
		expect(result.current).toHaveProperty('restartWebServer');
		expect(typeof result.current.toggleGlobalLive).toBe('function');
		expect(typeof result.current.restartWebServer).toBe('function');
	});

	it('isLiveMode starts as false', () => {
		const { result } = renderHook(() => useLiveMode());

		expect(result.current.isLiveMode).toBe(false);
	});

	it('webInterfaceUrl starts as null', () => {
		const { result } = renderHook(() => useLiveMode());

		expect(result.current.webInterfaceUrl).toBeNull();
	});

	// -----------------------------------------------------------------------
	// Following main
	// -----------------------------------------------------------------------

	it('reads Live state from main on mount (a server left on before a reload)', async () => {
		mainState = {
			live: true,
			url: 'http://192.168.1.5:8080/tok',
			remoteControl: false,
			remoteControlUrl: null,
			revision: 3,
		};

		const { result } = renderHook(() => useLiveMode());

		await waitFor(() => expect(result.current.isLiveMode).toBe(true));
		expect(result.current.webInterfaceUrl).toBe('http://192.168.1.5:8080/tok');
		expect(mockLive.set).not.toHaveBeenCalled();
	});

	it('follows a switch made elsewhere (another window or maestro-cli live)', async () => {
		const { result } = renderHook(() => useLiveMode());
		await waitFor(() => expect(mockLive.getState).toHaveBeenCalledOnce());

		act(() => {
			emitStateChanged?.({
				live: true,
				url: 'http://192.168.1.5:8080/tok',
				remoteControl: false,
				remoteControlUrl: null,
			});
		});
		expect(result.current.isLiveMode).toBe(true);
		expect(result.current.webInterfaceUrl).toBe('http://192.168.1.5:8080/tok');

		act(() => {
			emitStateChanged?.({ live: false, url: null, remoteControl: false, remoteControlUrl: null });
		});
		expect(result.current.isLiveMode).toBe(false);
		expect(result.current.webInterfaceUrl).toBeNull();
	});

	it('unsubscribes from Live state changes on unmount', () => {
		const { unmount } = renderHook(() => useLiveMode());

		expect(mockLive.onStateChanged).toHaveBeenCalledTimes(1);
		unmount();
		expect(unsubscribeStateChanged).toHaveBeenCalledTimes(1);
	});

	it('does not read main in the web-desktop bundle, whose bridge refuses live:*', async () => {
		const runtime = await import('../../../renderer/utils/runtimeContext');
		const spy = vi.spyOn(runtime, 'isWebDesktop').mockReturnValue(true);

		renderHook(() => useLiveMode());

		expect(mockLive.getState).not.toHaveBeenCalled();
		expect(mockLive.onStateChanged).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	// -----------------------------------------------------------------------
	// Auto-start
	// -----------------------------------------------------------------------

	it('keeps a server already running when auto-start is enabled', async () => {
		mainState = {
			live: true,
			url: 'http://localhost:31999/secure',
			remoteControl: false,
			remoteControlUrl: null,
			revision: 1,
		};

		const { result } = renderHook(() => useLiveMode(true));

		await waitFor(() => expect(result.current.isLiveMode).toBe(true));
		expect(mockLive.set).toHaveBeenCalledWith(true);
		// Idempotent: nothing restarted, so the URL (and its token) is unchanged.
		expect(mainState.revision).toBe(1);
		expect(result.current.webInterfaceUrl).toBe('http://localhost:31999/secure');
	});

	it('turns Live on when auto-start is enabled and it is off', async () => {
		const { result } = renderHook(() => useLiveMode(true));

		await waitFor(() => expect(result.current.isLiveMode).toBe(true));

		expect(mockLive.set).toHaveBeenCalledOnce();
		expect(mockLive.set).toHaveBeenCalledWith(true);
		expect(result.current.webInterfaceUrl).toBe('http://localhost:3000');
	});

	it('stops a pending auto-start when the setting is disabled before startup completes', async () => {
		let resolveStart: ((result: LiveModeSetResult) => void) | undefined;
		mockLive.set.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveStart = resolve;
				})
		);

		const { result, rerender } = renderHook(({ autoStart }) => useLiveMode(autoStart), {
			initialProps: { autoStart: true },
		});
		await waitFor(() => expect(mockLive.set).toHaveBeenCalledOnce());

		rerender({ autoStart: false });
		await act(async () => {
			resolveStart?.({
				success: true,
				changed: true,
				status: {
					live: true,
					url: 'http://localhost:3000',
					remoteControl: false,
					remoteControlUrl: null,
					revision: 1,
				},
			});
		});

		expect(mockLive.set).toHaveBeenLastCalledWith(false);
		expect(result.current.isLiveMode).toBe(false);
		expect(result.current.webInterfaceUrl).toBeNull();
	});

	it('leaves a cancelled auto-start alone when it changed nothing', async () => {
		let resolveStart: ((result: LiveModeSetResult) => void) | undefined;
		mockLive.set.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveStart = resolve;
				})
		);

		const { rerender } = renderHook(({ autoStart }) => useLiveMode(autoStart), {
			initialProps: { autoStart: true },
		});
		await waitFor(() => expect(mockLive.set).toHaveBeenCalledOnce());

		rerender({ autoStart: false });
		await act(async () => {
			// Another window had already turned Live on: this one owns nothing.
			resolveStart?.({
				success: true,
				changed: false,
				status: {
					live: true,
					url: 'http://localhost:3000',
					remoteControl: false,
					remoteControlUrl: null,
					revision: 1,
				},
			});
		});

		expect(mockLive.set).toHaveBeenCalledOnce();
	});

	// -----------------------------------------------------------------------
	// toggleGlobalLive
	// -----------------------------------------------------------------------

	it('toggleGlobalLive turns on through live.set(true) and adopts the status', async () => {
		const { result } = renderHook(() => useLiveMode());

		expect(result.current.isLiveMode).toBe(false);

		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(mockLive.set).toHaveBeenCalledWith(true);
		expect(mockLive.startServer).not.toHaveBeenCalled();
		expect(result.current.isLiveMode).toBe(true);
		expect(result.current.webInterfaceUrl).toBe('http://localhost:3000');
	});

	it('toggleGlobalLive turns off through live.set(false) and clears state', async () => {
		const { result } = renderHook(() => useLiveMode());

		await act(async () => {
			await result.current.toggleGlobalLive();
		});
		expect(result.current.isLiveMode).toBe(true);

		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		// Main stops Remote Control and the server; the hook only asks.
		expect(mockLive.set).toHaveBeenLastCalledWith(false);
		expect(result.current.isLiveMode).toBe(false);
		expect(result.current.webInterfaceUrl).toBeNull();
	});

	it('toggleGlobalLive keeps the state main reports when a switch fails', async () => {
		mockLive.set.mockResolvedValueOnce({
			success: false,
			changed: true,
			status: {
				live: false,
				url: null,
				remoteControl: false,
				remoteControlUrl: null,
				revision: 1,
				lastError: 'Port in use',
			},
			error: 'Port in use',
		});

		const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		const { result } = renderHook(() => useLiveMode());

		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(result.current.isLiveMode).toBe(false);
		expect(result.current.webInterfaceUrl).toBeNull();
		expect(consoleSpy).toHaveBeenCalledWith(
			'[toggleGlobalLive] Failed to switch Live mode:',
			undefined,
			'Port in use'
		);

		consoleSpy.mockRestore();
	});

	it('toggleGlobalLive handles an IPC exception and logs it', async () => {
		const error = new Error('Network failure');
		mockLive.set.mockRejectedValueOnce(error);

		const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		const { result } = renderHook(() => useLiveMode());

		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(result.current.isLiveMode).toBe(false);
		expect(result.current.webInterfaceUrl).toBeNull();
		expect(consoleSpy).toHaveBeenCalledWith('[toggleGlobalLive] Error:', undefined, error);

		consoleSpy.mockRestore();
	});

	// -----------------------------------------------------------------------
	// restartWebServer
	// -----------------------------------------------------------------------

	it('restartWebServer returns null when not in live mode', async () => {
		const { result } = renderHook(() => useLiveMode());

		let returnValue: string | null = null;
		await act(async () => {
			returnValue = await result.current.restartWebServer();
		});

		expect(returnValue).toBeNull();
		expect(mockLive.stopServer).not.toHaveBeenCalled();
		expect(mockLive.startServer).not.toHaveBeenCalled();
	});

	it('restartWebServer calls stopServer then startServer and returns new URL', async () => {
		const { result } = renderHook(() => useLiveMode());

		// Turn on first
		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(result.current.isLiveMode).toBe(true);

		// Setup new URL for restart
		mockLive.startServer.mockResolvedValue({ success: true, url: 'http://localhost:4000' });

		let returnValue: string | null = null;
		await act(async () => {
			returnValue = await result.current.restartWebServer();
		});

		expect(mockLive.stopServer).toHaveBeenCalledOnce();
		expect(mockLive.startServer).toHaveBeenCalledOnce();
		expect(returnValue).toBe('http://localhost:4000');
	});

	it('restartWebServer does not follow its own stop push and flash Live off', async () => {
		const { result } = renderHook(() => useLiveMode());
		await act(async () => {
			await result.current.toggleGlobalLive();
		});
		expect(result.current.isLiveMode).toBe(true);

		// The stop half of the restart pushes live: false before the start lands.
		// Following it would leave Live off (a successful restart only sets the
		// URL) and reset the Remote Control row mid-restart.
		mockLive.stopServer.mockImplementation(async () => {
			emitStateChanged?.({
				live: false,
				url: null,
				remoteControl: false,
				remoteControlUrl: null,
			});
		});
		mockLive.startServer.mockResolvedValue({ success: true, url: 'http://localhost:4000' });

		await act(async () => {
			await result.current.restartWebServer();
		});

		expect(result.current.isLiveMode).toBe(true);
		expect(result.current.webInterfaceUrl).toBe('http://localhost:4000');
	});

	it('restartWebServer updates webInterfaceUrl on success', async () => {
		const { result } = renderHook(() => useLiveMode());

		// Turn on
		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(result.current.webInterfaceUrl).toBe('http://localhost:3000');

		// Restart with new URL
		mockLive.startServer.mockResolvedValue({ success: true, url: 'http://localhost:5000' });

		await act(async () => {
			await result.current.restartWebServer();
		});

		expect(result.current.webInterfaceUrl).toBe('http://localhost:5000');
	});

	it('restartWebServer returns null on startServer failure (success: false)', async () => {
		const { result } = renderHook(() => useLiveMode());

		// Turn on
		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		// Make restart fail
		mockLive.startServer.mockResolvedValue({ success: false, error: 'Restart failed' });

		const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

		let returnValue: string | null = 'not-null';
		await act(async () => {
			returnValue = await result.current.restartWebServer();
		});

		expect(returnValue).toBeNull();
		// State should reflect server is stopped after failed restart
		expect(result.current.isLiveMode).toBe(false);
		expect(result.current.webInterfaceUrl).toBeNull();
		expect(consoleSpy).toHaveBeenCalledWith(
			'[restartWebServer] Failed to restart server:',
			undefined,
			'Restart failed'
		);

		consoleSpy.mockRestore();
	});

	it('restartWebServer returns null on exception and logs error', async () => {
		const { result } = renderHook(() => useLiveMode());

		// Turn on
		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		// Make stopServer throw
		const error = new Error('Stop server crashed');
		mockLive.stopServer.mockRejectedValue(error);

		const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

		let returnValue: string | null = 'not-null';
		await act(async () => {
			returnValue = await result.current.restartWebServer();
		});

		expect(returnValue).toBeNull();
		// State should reflect server is stopped after exception
		expect(result.current.isLiveMode).toBe(false);
		expect(result.current.webInterfaceUrl).toBeNull();
		expect(consoleSpy).toHaveBeenCalledWith('[restartWebServer] Error:', undefined, error);

		consoleSpy.mockRestore();
	});

	// -----------------------------------------------------------------------
	// Multiple toggle cycles
	// -----------------------------------------------------------------------

	it('supports multiple toggle cycles (on -> off -> on)', async () => {
		const { result } = renderHook(() => useLiveMode());

		await act(async () => {
			await result.current.toggleGlobalLive();
		});
		expect(result.current.isLiveMode).toBe(true);
		expect(result.current.webInterfaceUrl).toBe('http://localhost:3000');

		await act(async () => {
			await result.current.toggleGlobalLive();
		});
		expect(result.current.isLiveMode).toBe(false);
		expect(result.current.webInterfaceUrl).toBeNull();

		// A fresh token on the next start gives a different URL.
		nextUrl = 'http://localhost:9000';
		await act(async () => {
			await result.current.toggleGlobalLive();
		});
		expect(result.current.isLiveMode).toBe(true);
		expect(result.current.webInterfaceUrl).toBe('http://localhost:9000');

		expect(mockLive.set.mock.calls.map(([live]) => live)).toEqual([true, false, true]);
	});
	// -----------------------------------------------------------------------
	// Network changes (WiFi to hotspot, dock to undock)
	// -----------------------------------------------------------------------

	it('adopts the new URL when the machine moves networks while live', async () => {
		const { result } = renderHook(() => useLiveMode());

		await act(async () => {
			await result.current.toggleGlobalLive();
		});
		expect(result.current.webInterfaceUrl).toBe('http://localhost:3000');

		act(() => {
			emitUrlChanged?.({ url: 'http://172.20.10.3:8080/token' });
		});

		expect(result.current.webInterfaceUrl).toBe('http://172.20.10.3:8080/token');
		// The server never restarted, so live mode must not have flickered off.
		expect(result.current.isLiveMode).toBe(true);
		expect(mockLive.set).toHaveBeenCalledTimes(1);
	});

	it('ignores address changes while live mode is off', () => {
		const { result } = renderHook(() => useLiveMode());

		act(() => {
			emitUrlChanged?.({ url: 'http://172.20.10.3:8080/token' });
		});

		// With Live off the server is CLI-only; its address is not user-facing.
		expect(result.current.webInterfaceUrl).toBeNull();
	});

	it('unsubscribes from address changes on unmount', () => {
		const { unmount } = renderHook(() => useLiveMode());

		expect(mockLive.onUrlChanged).toHaveBeenCalledTimes(1);
		unmount();
		expect(unsubscribeUrlChanged).toHaveBeenCalledTimes(1);
	});

	it('survives a preload without the address-change channel', () => {
		(window as any).maestro.live = {
			...mockLive,
			onUrlChanged: undefined,
			onStateChanged: undefined,
		};

		expect(() => renderHook(() => useLiveMode())).not.toThrow();
	});
});
