import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCueToggle } from '../../../../renderer/hooks/cue/useCueToggle';

const mockNotifyToast = vi.fn();
vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));

describe('useCueToggle', () => {
	beforeEach(() => {
		mockNotifyToast.mockReset();
	});

	it('click when disabled → enable called, toggling flips true then false', async () => {
		let resolveEnable!: () => void;
		const enable = vi.fn(
			() =>
				new Promise<void>((r) => {
					resolveEnable = r;
				})
		);
		const disable = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useCueToggle({ isEnabled: false, enable, disable }));
		let pending: Promise<void>;
		act(() => {
			pending = result.current.handleToggle();
		});
		expect(result.current.toggling).toBe(true);
		expect(enable).toHaveBeenCalled();
		expect(disable).not.toHaveBeenCalled();
		await act(async () => {
			resolveEnable();
			await pending;
		});
		expect(result.current.toggling).toBe(false);
	});

	it('click when enabled → disable called', async () => {
		const enable = vi.fn();
		const disable = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useCueToggle({ isEnabled: true, enable, disable }));
		await act(async () => {
			await result.current.handleToggle();
		});
		expect(disable).toHaveBeenCalled();
		expect(enable).not.toHaveBeenCalled();
	});

	it('double-click while toggling → second call ignored', async () => {
		let resolveEnable!: () => void;
		const enable = vi.fn(
			() =>
				new Promise<void>((r) => {
					resolveEnable = r;
				})
		);
		const disable = vi.fn();
		const { result } = renderHook(() => useCueToggle({ isEnabled: false, enable, disable }));
		let first: Promise<void>;
		act(() => {
			first = result.current.handleToggle();
		});
		// Second call while first pending
		await act(async () => {
			await result.current.handleToggle();
		});
		expect(enable).toHaveBeenCalledTimes(1);
		await act(async () => {
			resolveEnable();
			await first;
		});
	});

	it('enable throws → toast invoked; toggling restored to false', async () => {
		const enable = vi.fn().mockRejectedValue(new Error('nope'));
		const disable = vi.fn();
		const { result } = renderHook(() => useCueToggle({ isEnabled: false, enable, disable }));
		await act(async () => {
			await result.current.handleToggle();
		});
		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'error', message: 'nope' })
		);
		expect(result.current.toggling).toBe(false);
	});

	it('disable throws with non-Error value → default message used', async () => {
		const enable = vi.fn();
		const disable = vi.fn().mockRejectedValue('string error');
		const { result } = renderHook(() => useCueToggle({ isEnabled: true, enable, disable }));
		await act(async () => {
			await result.current.handleToggle();
		});
		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('Failed to disable') })
		);
	});

	it('reads fresh isEnabled between calls', async () => {
		const enable = vi.fn().mockResolvedValue(undefined);
		const disable = vi.fn().mockResolvedValue(undefined);
		const { result, rerender } = renderHook(
			({ enabled }) => useCueToggle({ isEnabled: enabled, enable, disable }),
			{ initialProps: { enabled: false } }
		);
		await act(async () => {
			await result.current.handleToggle();
		});
		expect(enable).toHaveBeenCalledTimes(1);
		rerender({ enabled: true });
		await act(async () => {
			await result.current.handleToggle();
		});
		expect(disable).toHaveBeenCalledTimes(1);
	});
});
