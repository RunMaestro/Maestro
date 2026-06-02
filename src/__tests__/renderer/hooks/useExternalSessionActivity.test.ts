/**
 * Tests for useExternalSessionActivity (Remote Agent Visibility, Phase 4).
 *
 * Mocks the `window.maestro.storage` preload bridge to verify the hook
 * hydrates on mount, applies live updates, unsubscribes on unmount, guards
 * against state-after-unmount, logs hydration failures, and degrades gracefully
 * when the storage API is absent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useExternalSessionActivity } from '../../../renderer/hooks/session/useExternalSessionActivity';
import { logger } from '../../../renderer/utils/logger';
import type { SessionActivityEvent } from '../../../shared/sessionActivity';

function makeEvent(overrides: Partial<SessionActivityEvent> = {}): SessionActivityEvent {
	return {
		agentId: 'claude-code',
		sessionId: 'sess-1',
		projectPath: '/proj',
		lastActivityAt: 1000,
		source: 'external',
		sizeBytes: 100,
		...overrides,
	};
}

// Per-test handles onto the mocked bridge.
let listExternalSessions: ReturnType<typeof vi.fn>;
let onExternalActivity: ReturnType<typeof vi.fn>;
let activityCallback: ((events: SessionActivityEvent[]) => void) | null;
let unsubscribe: ReturnType<typeof vi.fn>;

beforeEach(() => {
	activityCallback = null;
	unsubscribe = vi.fn();
	listExternalSessions = vi.fn().mockResolvedValue([]);
	onExternalActivity = vi.fn((cb: (events: SessionActivityEvent[]) => void) => {
		activityCallback = cb;
		return unsubscribe;
	});
	(window.maestro as unknown as { storage: unknown }).storage = {
		listExternalSessions,
		onExternalActivity,
	};
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('useExternalSessionActivity', () => {
	it('starts empty before hydration resolves', () => {
		const { result } = renderHook(() => useExternalSessionActivity());
		expect(result.current).toEqual([]);
	});

	it('hydrates from listExternalSessions on mount', async () => {
		const initial = [makeEvent({ sessionId: 'hydrated' })];
		listExternalSessions.mockResolvedValue(initial);

		const { result } = renderHook(() => useExternalSessionActivity());

		await waitFor(() => expect(result.current).toHaveLength(1));
		expect(result.current[0].sessionId).toBe('hydrated');
		expect(listExternalSessions).toHaveBeenCalledTimes(1);
	});

	it('applies live updates from onExternalActivity', async () => {
		const { result } = renderHook(() => useExternalSessionActivity());
		await waitFor(() => expect(onExternalActivity).toHaveBeenCalled());

		const update = [makeEvent({ sessionId: 'live-a' }), makeEvent({ sessionId: 'live-b' })];
		act(() => {
			activityCallback?.(update);
		});

		expect(result.current).toHaveLength(2);
		expect(result.current.map((e) => e.sessionId)).toEqual(['live-a', 'live-b']);
	});

	it('unsubscribes on unmount', async () => {
		const { unmount } = renderHook(() => useExternalSessionActivity());
		await waitFor(() => expect(onExternalActivity).toHaveBeenCalled());

		unmount();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('does not apply late hydration after unmount', async () => {
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		let resolveHydration: (events: SessionActivityEvent[]) => void = () => {};
		listExternalSessions.mockReturnValue(
			new Promise<SessionActivityEvent[]>((resolve) => {
				resolveHydration = resolve;
			})
		);

		const { result, unmount } = renderHook(() => useExternalSessionActivity());
		unmount();

		// Resolve hydration AFTER unmount — the mounted guard must drop it.
		await act(async () => {
			resolveHydration([makeEvent({ sessionId: 'too-late' })]);
			await Promise.resolve();
		});

		expect(result.current).toEqual([]);
		expect(errorSpy).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it('logs a hydration rejection without throwing', async () => {
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		listExternalSessions.mockRejectedValue(new Error('ipc down'));

		renderHook(() => useExternalSessionActivity());

		await waitFor(() => expect(errorSpy).toHaveBeenCalled());
		errorSpy.mockRestore();
	});

	it('degrades gracefully when the storage API is absent', () => {
		(window.maestro as unknown as { storage?: unknown }).storage = undefined;

		const { result } = renderHook(() => useExternalSessionActivity());

		expect(result.current).toEqual([]);
		expect(onExternalActivity).not.toHaveBeenCalled();
	});
});
