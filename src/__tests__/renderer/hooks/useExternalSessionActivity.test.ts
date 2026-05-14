import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useExternalSessionActivity } from '../../../renderer/hooks/session/useExternalSessionActivity';
import type { SessionActivityEvent } from '../../../shared/sessionActivity';

function makeEvent(overrides: Partial<SessionActivityEvent> = {}): SessionActivityEvent {
	return {
		agentId: 'claude-code',
		sessionId: 'sess-1',
		projectPath: '/repo',
		lastActivityAt: Date.now(),
		source: 'external',
		sizeBytes: 1024,
		...overrides,
	};
}

describe('useExternalSessionActivity', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.storage.listExternalSessions).mockResolvedValue([]);
		vi.mocked(window.maestro.storage.onExternalActivity).mockReturnValue(() => {});
	});

	it('returns an empty array before hydration completes', () => {
		const { result } = renderHook(() => useExternalSessionActivity());
		expect(result.current).toEqual([]);
	});

	it('hydrates from listExternalSessions on mount', async () => {
		const initial = [makeEvent({ sessionId: 'a' }), makeEvent({ sessionId: 'b' })];
		vi.mocked(window.maestro.storage.listExternalSessions).mockResolvedValue(initial);

		const { result } = renderHook(() => useExternalSessionActivity());

		await waitFor(() => {
			expect(result.current).toEqual(initial);
		});
		expect(window.maestro.storage.listExternalSessions).toHaveBeenCalledTimes(1);
	});

	it('updates state when onExternalActivity fires', async () => {
		let pushUpdate: ((events: SessionActivityEvent[]) => void) | null = null;
		vi.mocked(window.maestro.storage.onExternalActivity).mockImplementation((cb) => {
			pushUpdate = cb;
			return () => {};
		});

		const { result } = renderHook(() => useExternalSessionActivity());

		await waitFor(() => {
			expect(window.maestro.storage.onExternalActivity).toHaveBeenCalled();
		});
		expect(pushUpdate).not.toBeNull();

		const next = [makeEvent({ sessionId: 'live-1' })];
		act(() => {
			pushUpdate!(next);
		});

		expect(result.current).toEqual(next);
	});

	it('unsubscribes from onExternalActivity on unmount', async () => {
		const unsubscribe = vi.fn();
		vi.mocked(window.maestro.storage.onExternalActivity).mockReturnValue(unsubscribe);

		const { unmount } = renderHook(() => useExternalSessionActivity());

		await waitFor(() => {
			expect(window.maestro.storage.onExternalActivity).toHaveBeenCalled();
		});

		unmount();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('does not setState after unmount when hydration resolves late', async () => {
		let resolveHydrate: (value: SessionActivityEvent[]) => void = () => {};
		vi.mocked(window.maestro.storage.listExternalSessions).mockReturnValue(
			new Promise<SessionActivityEvent[]>((resolve) => {
				resolveHydrate = resolve;
			})
		);

		const { unmount } = renderHook(() => useExternalSessionActivity());
		unmount();

		// Should not throw / warn after unmount.
		await act(async () => {
			resolveHydrate([makeEvent()]);
			await Promise.resolve();
		});
	});

	it('logs and continues when hydration rejects', async () => {
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.storage.listExternalSessions).mockRejectedValue(new Error('boom'));

		const { result } = renderHook(() => useExternalSessionActivity());

		await waitFor(() => {
			expect(consoleErrorSpy).toHaveBeenCalled();
		});
		expect(result.current).toEqual([]);

		consoleErrorSpy.mockRestore();
	});

	it('returns empty array and skips subscription when storage API is missing', () => {
		const original = window.maestro.storage;
		// Simulate older preload build / non-Electron renderer.
		(window.maestro as unknown as Record<string, unknown>).storage = undefined;

		try {
			const { result } = renderHook(() => useExternalSessionActivity());
			expect(result.current).toEqual([]);
		} finally {
			(window.maestro as unknown as Record<string, unknown>).storage = original;
		}
	});
});
