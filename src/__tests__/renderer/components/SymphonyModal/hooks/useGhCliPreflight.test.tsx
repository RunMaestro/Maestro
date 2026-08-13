/**
 * Tests for SymphonyModal/hooks/useGhCliPreflight - gh CLI pre-flight state
 * machine. The dialog must open BEFORE the gh probe resolves so the spinner
 * is visible during the network round-trip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGhCliPreflight } from '../../../../../renderer/components/SymphonyModal/hooks/useGhCliPreflight';

function flushPromises() {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('useGhCliPreflight', () => {
	let checkGhCli: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		checkGhCli = vi.fn();
	});

	it('start() opens the dialog with isChecking=true and status=null BEFORE the probe resolves', async () => {
		let resolvePromise: (v: { installed: boolean; authenticated: boolean }) => void;
		checkGhCli.mockReturnValue(
			new Promise((res) => {
				resolvePromise = res;
			})
		);
		const { result } = renderHook(() => useGhCliPreflight(checkGhCli));
		expect(result.current.isOpen).toBe(false);
		expect(result.current.isChecking).toBe(false);

		act(() => result.current.start());
		// Dialog is open + checking before the probe finishes
		expect(result.current.isOpen).toBe(true);
		expect(result.current.isChecking).toBe(true);
		expect(result.current.status).toBeNull();

		await act(async () => {
			resolvePromise!({ installed: true, authenticated: true });
			await flushPromises();
		});
		expect(result.current.isChecking).toBe(false);
		expect(result.current.status).toEqual({ installed: true, authenticated: true });
		expect(result.current.isOpen).toBe(true);
	});

	it('falls back to {installed:false, authenticated:false} when the gh probe throws', async () => {
		checkGhCli.mockRejectedValue(new Error('boom'));
		const { result } = renderHook(() => useGhCliPreflight(checkGhCli));
		await act(async () => {
			result.current.start();
			await flushPromises();
		});
		expect(result.current.status).toEqual({ installed: false, authenticated: false });
		expect(result.current.isChecking).toBe(false);
	});

	it('confirm() closes the dialog and runs the callback', async () => {
		checkGhCli.mockResolvedValue({ installed: true, authenticated: true });
		const { result } = renderHook(() => useGhCliPreflight(checkGhCli));
		await act(async () => {
			result.current.start();
			await flushPromises();
		});
		const onConfirmed = vi.fn();
		act(() => result.current.confirm(onConfirmed));
		expect(result.current.isOpen).toBe(false);
		expect(onConfirmed).toHaveBeenCalledTimes(1);
	});

	it('cancel() closes the dialog without invoking any callback', async () => {
		checkGhCli.mockResolvedValue({ installed: true, authenticated: true });
		const { result } = renderHook(() => useGhCliPreflight(checkGhCli));
		await act(async () => {
			result.current.start();
			await flushPromises();
		});
		act(() => result.current.cancel());
		expect(result.current.isOpen).toBe(false);
	});

	it('repeating start() while in-flight replaces status and re-arms isChecking', async () => {
		let pendingResolver: ((v: { installed: boolean; authenticated: boolean }) => void) | null =
			null;
		checkGhCli.mockImplementation(
			() =>
				new Promise((res) => {
					pendingResolver = res;
				})
		);
		const { result } = renderHook(() => useGhCliPreflight(checkGhCli));
		act(() => result.current.start());
		expect(result.current.isChecking).toBe(true);
		// Resolve first probe
		await act(async () => {
			pendingResolver!({ installed: false, authenticated: false });
			await flushPromises();
		});
		expect(result.current.status).toEqual({ installed: false, authenticated: false });
		// Trigger again - status should reset to null synchronously
		act(() => result.current.start());
		expect(result.current.status).toBeNull();
		expect(result.current.isChecking).toBe(true);
	});

	it('does not invoke checkGhCli until start() is called', () => {
		renderHook(() => useGhCliPreflight(checkGhCli));
		expect(checkGhCli).not.toHaveBeenCalled();
	});

	it('calls checkGhCli on every start()', async () => {
		checkGhCli.mockResolvedValue({ installed: true, authenticated: true });
		const { result } = renderHook(() => useGhCliPreflight(checkGhCli));
		await act(async () => {
			result.current.start();
			await flushPromises();
		});
		await act(async () => {
			result.current.start();
			await flushPromises();
		});
		expect(checkGhCli).toHaveBeenCalledTimes(2);
	});

	it('isOpen toggles back to true on a fresh start() after cancel()', async () => {
		checkGhCli.mockResolvedValue({ installed: true, authenticated: true });
		const { result } = renderHook(() => useGhCliPreflight(checkGhCli));
		await act(async () => {
			result.current.start();
			await flushPromises();
		});
		act(() => result.current.cancel());
		expect(result.current.isOpen).toBe(false);
		await act(async () => {
			result.current.start();
			await flushPromises();
		});
		expect(result.current.isOpen).toBe(true);
	});
});
