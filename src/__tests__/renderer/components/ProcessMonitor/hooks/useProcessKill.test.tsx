import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCaptureException = vi.fn();
vi.mock('../../../../../renderer/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { useProcessKill } from '../../../../../renderer/components/ProcessMonitor/hooks/useProcessKill';

describe('useProcessKill', () => {
	let killMock: ReturnType<typeof vi.fn>;
	let stopRunMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockCaptureException.mockClear();
		killMock = vi.fn().mockResolvedValue(undefined);
		stopRunMock = vi.fn().mockResolvedValue(true);
		(window as unknown as { maestro: unknown }).maestro = {
			process: { kill: killMock },
			cue: { stopRun: stopRunMock },
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('routes non-cue kills through window.maestro.process.kill', async () => {
		const refresh = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useProcessKill(refresh));
		await act(async () => {
			await result.current.kill('session-1-ai-tab-a');
		});
		expect(killMock).toHaveBeenCalledWith('session-1-ai-tab-a');
		expect(stopRunMock).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalled();
	});

	it('routes cue runs through window.maestro.cue.stopRun', async () => {
		const refresh = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useProcessKill(refresh));
		await act(async () => {
			await result.current.kill('cue-run-x', 'cue-run-id-x');
		});
		expect(stopRunMock).toHaveBeenCalledWith('cue-run-id-x');
		expect(killMock).not.toHaveBeenCalled();
	});

	it('toggles isKilling true → false around the dispatch', async () => {
		let resolveKill: (() => void) | null = null;
		killMock.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveKill = () => resolve();
				})
		);
		const refresh = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useProcessKill(refresh));
		let killPromise: Promise<void>;
		act(() => {
			killPromise = result.current.kill('s-1');
		});
		await waitFor(() => expect(result.current.isKilling).toBe(true));
		await act(async () => {
			resolveKill?.();
			await killPromise!;
		});
		expect(result.current.isKilling).toBe(false);
	});

	it('calls onSettled regardless of success or failure', async () => {
		const onSettled = vi.fn();
		killMock.mockRejectedValueOnce(new Error('nope'));
		const { result } = renderHook(() =>
			useProcessKill(vi.fn().mockResolvedValue(undefined), onSettled)
		);
		await act(async () => {
			await result.current.kill('s-1');
		});
		expect(onSettled).toHaveBeenCalledTimes(1);
	});

	it('reports kill failures to Sentry but does not throw', async () => {
		const error = new Error('boom');
		killMock.mockRejectedValueOnce(error);
		const { result } = renderHook(() => useProcessKill(vi.fn().mockResolvedValue(undefined)));
		await expect(
			act(async () => {
				await result.current.kill('s-1');
			})
		).resolves.not.toThrow();
		expect(result.current.isKilling).toBe(false);
		expect(mockCaptureException).toHaveBeenCalledWith(
			error,
			expect.objectContaining({ extra: expect.objectContaining({ processSessionId: 's-1' }) })
		);
	});

	it('still calls refresh after a non-cue kill', async () => {
		const refresh = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useProcessKill(refresh));
		await act(async () => {
			await result.current.kill('s-1');
		});
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('still calls refresh in finally when the kill IPC throws', async () => {
		killMock.mockRejectedValueOnce(new Error('boom'));
		const refresh = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useProcessKill(refresh));
		await act(async () => {
			await result.current.kill('s-1');
		});
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('does not throw when refresh itself rejects', async () => {
		const refresh = vi.fn().mockRejectedValue(new Error('refresh-fail'));
		const { result } = renderHook(() => useProcessKill(refresh));
		await expect(
			act(async () => {
				await result.current.kill('s-1');
			})
		).resolves.not.toThrow();
		expect(result.current.isKilling).toBe(false);
	});
});
