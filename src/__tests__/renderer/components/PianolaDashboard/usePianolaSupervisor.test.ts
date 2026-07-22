/**
 * @file usePianolaSupervisor.test.ts
 * @description State-reconciliation tests for the watch hook: a disabled Pianola
 * clears stale rows, a transient IPC error keeps the last snapshot, and a slow
 * poll can never clobber a newer mutation's result.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePianolaSupervisor } from '../../../../renderer/components/PianolaDashboard/usePianolaSupervisor';
import type { PianolaSupervisorSnapshot } from '../../../../main/ipc/handlers/pianola';
import { notifyToast } from '../../../../renderer/stores/notificationStore';
import { captureException } from '../../../../renderer/utils/sentry';

vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const watchSnap: PianolaSupervisorSnapshot = {
	targets: [{ id: 't1', kind: 'watch', enabled: true, createdAt: 0, agentId: 'a', tabId: 'x' }],
	health: [],
};
const emptySnap: PianolaSupervisorSnapshot = { targets: [], health: [] };

// Behavior is steered per-test through these impl vars; the mocks just call them.
let listImpl: () => Promise<PianolaSupervisorSnapshot>;
let addImpl: () => Promise<PianolaSupervisorSnapshot>;
let originalMaestro: typeof window.maestro;

beforeEach(() => {
	listImpl = () => Promise.resolve(emptySnap);
	addImpl = () => Promise.resolve(watchSnap);
	originalMaestro = window.maestro;
	window.maestro = {
		...window.maestro,
		pianola: {
			...window.maestro?.pianola,
			supervisor: {
				list: vi.fn(() => listImpl()),
				add: vi.fn(() => addImpl()),
				remove: vi.fn(() => Promise.resolve(emptySnap)),
				setEnabled: vi.fn(() => Promise.resolve(emptySnap)),
			},
		},
	} as typeof window.maestro;
});

afterEach(() => {
	window.maestro = originalMaestro;
	vi.clearAllMocks();
});

describe('usePianolaSupervisor', () => {
	it('clears watched rows when Pianola becomes disabled', async () => {
		listImpl = () => Promise.resolve(watchSnap);
		const { result } = renderHook(() => usePianolaSupervisor());
		await waitFor(() => expect(result.current.watched).toHaveLength(1));

		// The gated channel now rejects (Electron wraps the message).
		listImpl = () =>
			Promise.reject(
				new Error("Error invoking remote method 'pianola:supervisor-list': Error: PianolaDisabled")
			);
		await act(async () => {
			result.current.refresh();
		});
		await waitFor(() => expect(result.current.watched).toHaveLength(0));
	});

	it('keeps the last snapshot on a transient IPC error (no flicker)', async () => {
		listImpl = () => Promise.resolve(watchSnap);
		const { result } = renderHook(() => usePianolaSupervisor());
		await waitFor(() => expect(result.current.watched).toHaveLength(1));

		listImpl = () => Promise.reject(new Error('ETIMEDOUT'));
		await act(async () => {
			result.current.refresh();
		});
		expect(result.current.watched).toHaveLength(1);
	});

	it('does not let a slow poll clobber a newer mutation', async () => {
		const slowPoll = deferred<PianolaSupervisorSnapshot>();
		listImpl = () => slowPoll.promise; // mount poll: stays pending
		addImpl = () => Promise.resolve(watchSnap);

		const { result } = renderHook(() => usePianolaSupervisor());
		// A watch mutation resolves while the mount poll is still in flight.
		await act(async () => {
			await result.current.watch('a', 'x');
		});
		expect(result.current.watched).toHaveLength(1);

		// The stale mount poll now resolves with pre-mutation (empty) state.
		await act(async () => {
			slowPoll.resolve(emptySnap);
			await slowPoll.promise;
		});
		// The mutation result must survive the late, stale poll.
		expect(result.current.watched).toHaveLength(1);
	});

	it('surfaces a toast and reports to Sentry when a mutation fails', async () => {
		addImpl = () => Promise.reject(new Error('disk full'));
		const { result } = renderHook(() => usePianolaSupervisor());
		await act(async () => {
			await result.current.watch('a', 'x');
		});
		expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }));
		expect(captureException).toHaveBeenCalled();
	});
});
