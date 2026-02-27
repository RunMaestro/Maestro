import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLiveMode } from '../../../renderer/hooks/remote/useLiveMode';

describe('useLiveMode', () => {
	const originalMaestro = (window as any).maestro;

	const mockTunnel = {
		stop: vi.fn(),
	};

	const mockLive = {
		startServer: vi.fn(),
		stopServer: vi.fn(),
		disableAll: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();

		mockTunnel.stop.mockResolvedValue(undefined);
		mockLive.startServer.mockResolvedValue({ success: true, url: 'http://localhost:3000' });
		mockLive.stopServer.mockResolvedValue(undefined);
		mockLive.disableAll.mockResolvedValue(undefined);

		(window as any).maestro = {
			...originalMaestro,
			tunnel: mockTunnel,
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
	// toggleGlobalLive — turning ON
	// -----------------------------------------------------------------------

	it('toggleGlobalLive turns on: calls startServer and sets state', async () => {
		const { result } = renderHook(() => useLiveMode());

		expect(result.current.isLiveMode).toBe(false);

		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(mockLive.startServer).toHaveBeenCalledOnce();
		expect(result.current.isLiveMode).toBe(true);
		expect(result.current.webInterfaceUrl).toBe('http://localhost:3000');
	});

	// -----------------------------------------------------------------------
	// toggleGlobalLive — turning OFF
	// -----------------------------------------------------------------------

	it('toggleGlobalLive turns off: calls tunnel.stop then disableAll, clears state', async () => {
		const { result } = renderHook(() => useLiveMode());

		// Turn on first
		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(result.current.isLiveMode).toBe(true);
		expect(result.current.webInterfaceUrl).toBe('http://localhost:3000');

		// Now turn off
		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(mockTunnel.stop).toHaveBeenCalledOnce();
		expect(mockLive.disableAll).toHaveBeenCalledOnce();
		expect(result.current.isLiveMode).toBe(false);
		expect(result.current.webInterfaceUrl).toBeNull();
	});

	// -----------------------------------------------------------------------
	// toggleGlobalLive — failure cases
	// -----------------------------------------------------------------------

	it('toggleGlobalLive handles startServer failure (success: false) without changing state', async () => {
		mockLive.startServer.mockResolvedValue({ success: false, error: 'Port in use' });

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { result } = renderHook(() => useLiveMode());

		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(mockLive.startServer).toHaveBeenCalledOnce();
		expect(result.current.isLiveMode).toBe(false);
		expect(result.current.webInterfaceUrl).toBeNull();
		expect(consoleSpy).toHaveBeenCalledWith(
			'[toggleGlobalLive] Failed to start server:',
			'Port in use'
		);

		consoleSpy.mockRestore();
	});

	it('toggleGlobalLive handles startServer exception and logs to console.error', async () => {
		const error = new Error('Network failure');
		mockLive.startServer.mockRejectedValue(error);

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { result } = renderHook(() => useLiveMode());

		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(result.current.isLiveMode).toBe(false);
		expect(result.current.webInterfaceUrl).toBeNull();
		expect(consoleSpy).toHaveBeenCalledWith('[toggleGlobalLive] Error:', error);

		consoleSpy.mockRestore();
	});

	it('toggleGlobalLive handles disableAll error when turning off', async () => {
		const { result } = renderHook(() => useLiveMode());

		// Turn on first
		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(result.current.isLiveMode).toBe(true);

		// Make disableAll throw
		const error = new Error('disableAll failed');
		mockLive.disableAll.mockRejectedValue(error);

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		// State should NOT have changed because the error was caught before setState
		expect(consoleSpy).toHaveBeenCalledWith('[toggleGlobalLive] Error:', error);

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
		// startServer called twice: once for toggle on, once for restart
		expect(mockLive.startServer).toHaveBeenCalledTimes(2);
		expect(returnValue).toBe('http://localhost:4000');
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

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		let returnValue: string | null = 'not-null';
		await act(async () => {
			returnValue = await result.current.restartWebServer();
		});

		expect(returnValue).toBeNull();
		expect(consoleSpy).toHaveBeenCalledWith(
			'[restartWebServer] Failed to restart server:',
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

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		let returnValue: string | null = 'not-null';
		await act(async () => {
			returnValue = await result.current.restartWebServer();
		});

		expect(returnValue).toBeNull();
		expect(consoleSpy).toHaveBeenCalledWith('[restartWebServer] Error:', error);

		consoleSpy.mockRestore();
	});

	// -----------------------------------------------------------------------
	// Multiple toggle cycles
	// -----------------------------------------------------------------------

	it('supports multiple toggle cycles (on -> off -> on)', async () => {
		const { result } = renderHook(() => useLiveMode());

		// Cycle 1: turn on
		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(result.current.isLiveMode).toBe(true);
		expect(result.current.webInterfaceUrl).toBe('http://localhost:3000');

		// Cycle 2: turn off
		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(result.current.isLiveMode).toBe(false);
		expect(result.current.webInterfaceUrl).toBeNull();

		// Cycle 3: turn on again with a different URL
		mockLive.startServer.mockResolvedValue({ success: true, url: 'http://localhost:9000' });

		await act(async () => {
			await result.current.toggleGlobalLive();
		});

		expect(result.current.isLiveMode).toBe(true);
		expect(result.current.webInterfaceUrl).toBe('http://localhost:9000');

		// Verify cumulative call counts:
		// startServer called twice (first "on" + third "on")
		expect(mockLive.startServer).toHaveBeenCalledTimes(2);
		// tunnel.stop and disableAll called once (the single "off" cycle)
		expect(mockTunnel.stop).toHaveBeenCalledTimes(1);
		expect(mockLive.disableAll).toHaveBeenCalledTimes(1);
	});
});
