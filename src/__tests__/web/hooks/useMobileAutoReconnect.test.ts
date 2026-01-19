/**
 * Tests for useMobileAutoReconnect hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMobileAutoReconnect } from '../../../web/hooks/useMobileAutoReconnect';

const DEFAULT_COUNTDOWN = 30;

describe('useMobileAutoReconnect', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('counts down and reconnects when disconnected and online', () => {
		const connect = vi.fn();

		const { result } = renderHook(
			({ connectionState, isOffline }) =>
				useMobileAutoReconnect({
					connectionState,
					isOffline,
					connect,
				}),
			{
				initialProps: { connectionState: 'disconnected', isOffline: false },
			}
		);

		expect(result.current.reconnectCountdown).toBe(DEFAULT_COUNTDOWN);

		act(() => {
			vi.advanceTimersByTime(1000);
		});

		expect(result.current.reconnectCountdown).toBe(DEFAULT_COUNTDOWN - 1);

		act(() => {
			vi.advanceTimersByTime(29000);
		});

		expect(connect).toHaveBeenCalledTimes(1);
		expect(result.current.reconnectCountdown).toBe(DEFAULT_COUNTDOWN);
	});

	it('does not reconnect while offline', () => {
		const connect = vi.fn();

		const { result } = renderHook(
			({ connectionState, isOffline }) =>
				useMobileAutoReconnect({
					connectionState,
					isOffline,
					connect,
				}),
			{
				initialProps: { connectionState: 'disconnected', isOffline: true },
			}
		);

		expect(result.current.reconnectCountdown).toBe(DEFAULT_COUNTDOWN);

		act(() => {
			vi.advanceTimersByTime(60000);
		});

		expect(connect).not.toHaveBeenCalled();
		expect(result.current.reconnectCountdown).toBe(DEFAULT_COUNTDOWN);
	});
});
