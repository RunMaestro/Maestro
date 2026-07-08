/**
 * Tests for useLiveOverlay hook.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useLiveOverlay } from '../../renderer/hooks/remote/useLiveOverlay';

const clickOutsideMock = vi.hoisted(() => ({
	callback: undefined as (() => void) | undefined,
	useClickOutside: vi.fn(),
}));

vi.mock('../../renderer/hooks/ui', () => ({
	useClickOutside: (ref: unknown, callback: () => void, enabled: boolean, options?: unknown) => {
		clickOutsideMock.useClickOutside(ref, callback, enabled, options);
		if (enabled) {
			clickOutsideMock.callback = callback;
		}
	},
}));

describe('useLiveOverlay', () => {
	const createTunnelApi = () => ({
		isCloudflaredInstalled: vi.fn().mockResolvedValue(true),
		start: vi.fn().mockResolvedValue({ success: true, url: 'https://remote.example' }),
		getStatus: vi
			.fn()
			.mockResolvedValue({ isRunning: true, url: 'https://remote.example', error: null }),
		stop: vi.fn().mockResolvedValue(undefined),
	});

	beforeEach(() => {
		vi.useFakeTimers();
		clickOutsideMock.callback = undefined;
		clickOutsideMock.useClickOutside.mockClear();

		(window as any).maestro.tunnel = createTunnelApi();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('auto-clears copy flash messages and allows explicitly clearing them', () => {
		const { result } = renderHook(() => useLiveOverlay(true));

		act(() => {
			result.current.setCopyFlash('Local URL copied');
		});

		expect(result.current.copyFlash).toBe('Local URL copied');

		act(() => {
			vi.advanceTimersByTime(2000);
		});

		expect(result.current.copyFlash).toBeNull();

		act(() => {
			result.current.setCopyFlash(null);
		});

		expect(result.current.copyFlash).toBeNull();
	});

	it('closes the overlay through the click-outside callback', async () => {
		const { result } = renderHook(() => useLiveOverlay(true));

		await act(async () => {
			result.current.setLiveOverlayOpen(true);
			await Promise.resolve();
		});

		expect(result.current.liveOverlayOpen).toBe(true);
		expect(clickOutsideMock.useClickOutside).toHaveBeenLastCalledWith(
			result.current.liveOverlayRef,
			expect.any(Function),
			true,
			undefined
		);

		act(() => {
			clickOutsideMock.callback?.();
		});

		expect(result.current.liveOverlayOpen).toBe(false);
	});

	it('uses the default tunnel start error when the start result has no error message', async () => {
		window.maestro.tunnel.start = vi.fn().mockResolvedValue({ success: false });
		const { result } = renderHook(() => useLiveOverlay(true));

		await act(async () => {
			await result.current.handleTunnelToggle();
		});

		expect(result.current.tunnelStatus).toBe('error');
		expect(result.current.tunnelError).toBe('Failed to start tunnel');
		expect(result.current.activeUrlTab).toBe('local');
	});

	it('uses the default tunnel start error when start throws a non-Error value', async () => {
		window.maestro.tunnel.start = vi.fn().mockRejectedValue('offline');
		const { result } = renderHook(() => useLiveOverlay(true));

		await act(async () => {
			await result.current.handleTunnelToggle();
		});

		expect(result.current.tunnelStatus).toBe('error');
		expect(result.current.tunnelError).toBe('Failed to start tunnel');
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[handleTunnelToggle] Failed to start tunnel:',
			undefined,
			'offline'
		);
	});

	it('uses thrown Error messages when tunnel start throws an Error', async () => {
		window.maestro.tunnel.start = vi.fn().mockRejectedValue(new Error('network down'));
		const { result } = renderHook(() => useLiveOverlay(true));

		await act(async () => {
			await result.current.handleTunnelToggle();
		});

		expect(result.current.tunnelStatus).toBe('error');
		expect(result.current.tunnelError).toBe('network down');
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[handleTunnelToggle] Failed to start tunnel:',
			undefined,
			expect.any(Error)
		);
	});

	it('does nothing when toggled from an error state', async () => {
		window.maestro.tunnel.start = vi.fn().mockResolvedValue({ success: false, error: 'no tunnel' });
		const { result } = renderHook(() => useLiveOverlay(true));

		await act(async () => {
			await result.current.handleTunnelToggle();
		});

		expect(result.current.tunnelStatus).toBe('error');

		await act(async () => {
			await result.current.handleTunnelToggle();
		});

		expect(window.maestro.tunnel.start).toHaveBeenCalledTimes(1);
		expect(window.maestro.tunnel.stop).not.toHaveBeenCalled();
		expect(result.current.tunnelStatus).toBe('error');
	});

	it('logs stop failures but still clears connected tunnel state', async () => {
		window.maestro.tunnel.stop = vi.fn().mockRejectedValue(new Error('stop failed'));
		const { result } = renderHook(() => useLiveOverlay(true));

		await act(async () => {
			await result.current.handleTunnelToggle();
		});

		expect(result.current.tunnelStatus).toBe('connected');

		await act(async () => {
			await result.current.handleTunnelToggle();
		});

		expect(window.maestro.tunnel.stop).toHaveBeenCalledTimes(1);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[handleTunnelToggle] Failed to stop tunnel:',
			undefined,
			expect.any(Error)
		);
		expect(result.current.tunnelStatus).toBe('off');
		expect(result.current.tunnelUrl).toBeNull();
		expect(result.current.tunnelError).toBeNull();
		expect(result.current.activeUrlTab).toBe('local');
	});

	it('syncs connected tunnel state to process errors and interval refreshes', async () => {
		window.maestro.tunnel.getStatus = vi
			.fn()
			.mockResolvedValue({ isRunning: false, url: null, error: 'cloudflared exited' });
		const { result } = renderHook(() => useLiveOverlay(true));

		await act(async () => {
			await result.current.handleTunnelToggle();
			await Promise.resolve();
		});

		expect(result.current.tunnelStatus).toBe('error');
		expect(result.current.tunnelError).toBe('cloudflared exited');
		expect(result.current.tunnelUrl).toBeNull();
		expect(result.current.activeUrlTab).toBe('local');

		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});
		expect(window.maestro.tunnel.getStatus).toHaveBeenCalled();
	});

	it('syncs stopped tunnel state without an error and keeps polling while connected', async () => {
		window.maestro.tunnel.getStatus = vi
			.fn()
			.mockResolvedValueOnce({ isRunning: true, url: 'https://remote.example', error: null })
			.mockResolvedValueOnce({ isRunning: false, url: null, error: null });
		const { result } = renderHook(() => useLiveOverlay(true));

		await act(async () => {
			await result.current.handleTunnelToggle();
			await Promise.resolve();
		});

		expect(result.current.tunnelStatus).toBe('connected');

		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});

		expect(result.current.tunnelStatus).toBe('off');
		expect(result.current.tunnelUrl).toBeNull();
		expect(result.current.activeUrlTab).toBe('local');
	});

	it('ignores pending tunnel status results after cleanup', async () => {
		let resolveStatus: (value: {
			isRunning: boolean;
			url: string | null;
			error: null;
		}) => void = () => {};
		window.maestro.tunnel.getStatus = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveStatus = resolve;
				})
		);
		const { result, unmount } = renderHook(() => useLiveOverlay(true));

		await act(async () => {
			await result.current.handleTunnelToggle();
		});

		unmount();

		await act(async () => {
			resolveStatus({ isRunning: false, url: null, error: null });
			await Promise.resolve();
		});

		expect(window.maestro.tunnel.getStatus).toHaveBeenCalled();
	});

	it('ignores pending tunnel status errors after cleanup', async () => {
		let rejectStatus: (reason: unknown) => void = () => {};
		window.maestro.tunnel.getStatus = vi.fn(
			() =>
				new Promise((_resolve, reject) => {
					rejectStatus = reject;
				})
		);
		const { result, unmount } = renderHook(() => useLiveOverlay(true));

		await act(async () => {
			await result.current.handleTunnelToggle();
		});

		unmount();

		await act(async () => {
			rejectStatus(new Error('late status failure'));
			await Promise.resolve();
		});

		expect(window.maestro.tunnel.getStatus).toHaveBeenCalled();
	});

	it('uses fallback text when reading tunnel status throws a non-Error value', async () => {
		window.maestro.tunnel.getStatus = vi.fn().mockRejectedValue('status unavailable');
		const { result } = renderHook(() => useLiveOverlay(true));

		await act(async () => {
			await result.current.handleTunnelToggle();
			await Promise.resolve();
		});

		expect(result.current.tunnelStatus).toBe('error');
		expect(result.current.tunnelError).toBe('Failed to read tunnel status');
		expect(result.current.tunnelUrl).toBeNull();
		expect(result.current.activeUrlTab).toBe('local');
	});

	it('uses thrown Error messages when reading tunnel status fails', async () => {
		window.maestro.tunnel.getStatus = vi.fn().mockRejectedValue(new Error('status down'));
		const { result } = renderHook(() => useLiveOverlay(true));

		await act(async () => {
			await result.current.handleTunnelToggle();
			await Promise.resolve();
		});

		expect(result.current.tunnelStatus).toBe('error');
		expect(result.current.tunnelError).toBe('status down');
		expect(result.current.tunnelUrl).toBeNull();
		expect(result.current.activeUrlTab).toBe('local');
	});

	it('polls more quickly while the tunnel is starting', async () => {
		let resolveStart: (value: { success: boolean; url: string }) => void = () => {};
		window.maestro.tunnel.start = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveStart = resolve;
				})
		);
		const setIntervalSpy = vi.spyOn(window, 'setInterval');
		const { result } = renderHook(() => useLiveOverlay(true));

		await act(async () => {
			void result.current.handleTunnelToggle();
			await Promise.resolve();
		});

		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 500);

		await act(async () => {
			resolveStart({ success: true, url: 'https://remote.example' });
			await Promise.resolve();
		});

		expect(result.current.tunnelStatus).toBe('connected');
	});

	it('resets tunnel state when live mode is disabled', async () => {
		const { result, rerender } = renderHook(({ isLiveMode }) => useLiveOverlay(isLiveMode), {
			initialProps: { isLiveMode: true },
		});

		await act(async () => {
			await result.current.handleTunnelToggle();
		});

		expect(result.current.tunnelStatus).toBe('connected');
		expect(result.current.tunnelUrl).toBe('https://remote.example');
		expect(result.current.activeUrlTab).toBe('remote');

		rerender({ isLiveMode: false });

		expect(result.current.tunnelStatus).toBe('off');
		expect(result.current.tunnelUrl).toBeNull();
		expect(result.current.tunnelError).toBeNull();
		expect(result.current.activeUrlTab).toBe('local');
	});
});
