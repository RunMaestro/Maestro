import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveOverlay } from '../../../../renderer/hooks/remote/useLiveOverlay';

describe('useLiveOverlay', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it('cancels the copy flash timeout when unmounted', () => {
		const { result, unmount } = renderHook(() => useLiveOverlay(false));

		act(() => {
			result.current.setCopyFlash('Local URL copied!');
		});
		expect(result.current.copyFlash).toBe('Local URL copied!');
		expect(vi.getTimerCount()).toBe(1);

		unmount();

		expect(vi.getTimerCount()).toBe(0);
	});

	describe('live:stateChanged (a tunnel toggled by `maestro-cli live tunnel`)', () => {
		const originalMaestro = (window as any).maestro;
		let emit: ((state: any) => void) | null = null;
		const getStatus = vi.fn();

		beforeEach(() => {
			emit = null;
			getStatus.mockResolvedValue({
				isRunning: true,
				url: 'https://abc.trycloudflare.com/tok',
				error: null,
			});
			(window as any).maestro = {
				...originalMaestro,
				live: {
					onStateChanged: vi.fn((handler: (state: any) => void) => {
						emit = handler;
						return vi.fn();
					}),
				},
				tunnel: { getStatus, isCloudflaredInstalled: vi.fn().mockResolvedValue(true) },
			};
		});

		afterEach(() => {
			(window as any).maestro = originalMaestro;
		});

		it('shows a tunnel started elsewhere as connected', () => {
			const { result } = renderHook(() => useLiveOverlay(true));
			expect(result.current.tunnelStatus).toBe('off');

			act(() => {
				emit?.({
					live: true,
					url: 'http://192.168.1.5:8080/tok',
					remoteControl: true,
					remoteControlUrl: 'https://abc.trycloudflare.com/tok',
				});
			});

			expect(result.current.tunnelStatus).toBe('connected');
			expect(result.current.tunnelUrl).toBe('https://abc.trycloudflare.com/tok');
		});

		it('shows a tunnel stopped elsewhere as off', () => {
			const { result } = renderHook(() => useLiveOverlay(true));
			act(() => {
				emit?.({
					live: true,
					url: 'http://192.168.1.5:8080/tok',
					remoteControl: true,
					remoteControlUrl: 'https://abc.trycloudflare.com/tok',
				});
			});
			act(() => {
				emit?.({
					live: true,
					url: 'http://192.168.1.5:8080/tok',
					remoteControl: false,
					remoteControlUrl: null,
				});
			});

			expect(result.current.tunnelStatus).toBe('off');
			expect(result.current.tunnelUrl).toBeNull();
		});
	});
});
