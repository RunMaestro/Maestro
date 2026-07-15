/**
 * Tests for SymphonyModal/hooks/usePrStatusSync - batch PR-status check and
 * per-contribution sync. Asserts message strings, 5s auto-clear via fake timers,
 * error paths, and id-tracking during in-flight syncs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePrStatusSync } from '../../../../../renderer/components/SymphonyModal/hooks/usePrStatusSync';

async function flushMicrotasks() {
	// Multiple yields cover the chain of awaited then() handlers inside the hook.
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

describe('usePrStatusSync', () => {
	let checkPRStatuses: ReturnType<typeof vi.fn>;
	let syncContribution: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		checkPRStatuses = vi.fn();
		syncContribution = vi.fn();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function setup() {
		return renderHook(() => usePrStatusSync({ checkPRStatuses, syncContribution }));
	}

	it('formats merged-only message', async () => {
		checkPRStatuses.mockResolvedValue({ merged: 2, closed: 0, checked: 3 });
		const { result } = setup();
		await act(async () => {
			await result.current.checkPRStatuses();
		});
		expect(result.current.prStatusMessage).toBe('2 PRs merged');
	});

	it('formats closed-only message', async () => {
		checkPRStatuses.mockResolvedValue({ merged: 0, closed: 1, checked: 5 });
		const { result } = setup();
		await act(async () => {
			await result.current.checkPRStatuses();
		});
		expect(result.current.prStatusMessage).toBe('1 PR closed');
	});

	it('combines merged + closed messages', async () => {
		checkPRStatuses.mockResolvedValue({ merged: 1, closed: 2, checked: 4 });
		const { result } = setup();
		await act(async () => {
			await result.current.checkPRStatuses();
		});
		expect(result.current.prStatusMessage).toBe('1 PR merged, 2 PRs closed');
	});

	it('says "All PRs up to date" when checked > 0 and nothing changed', async () => {
		checkPRStatuses.mockResolvedValue({ merged: 0, closed: 0, checked: 7 });
		const { result } = setup();
		await act(async () => {
			await result.current.checkPRStatuses();
		});
		expect(result.current.prStatusMessage).toBe('All PRs up to date');
	});

	it('says "No PRs to check" when checked is missing/0', async () => {
		checkPRStatuses.mockResolvedValue({});
		const { result } = setup();
		await act(async () => {
			await result.current.checkPRStatuses();
		});
		expect(result.current.prStatusMessage).toBe('No PRs to check');
	});

	it('surfaces "Failed to check statuses" on probe rejection', async () => {
		checkPRStatuses.mockRejectedValue(new Error('boom'));
		const { result } = setup();
		await act(async () => {
			await result.current.checkPRStatuses();
		});
		expect(result.current.prStatusMessage).toBe('Failed to check statuses');
	});

	it('clears the message after 5s', async () => {
		checkPRStatuses.mockResolvedValue({ merged: 1, closed: 0, checked: 1 });
		const { result } = setup();
		await act(async () => {
			await result.current.checkPRStatuses();
		});
		expect(result.current.prStatusMessage).toBe('1 PR merged');
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(result.current.prStatusMessage).toBeNull();
	});

	it('syncContribution tracks the syncing id during the call', async () => {
		let resolveSync: (v: { message?: string }) => void;
		syncContribution.mockReturnValue(
			new Promise((r) => {
				resolveSync = r;
			})
		);
		const { result } = setup();
		act(() => {
			result.current.syncContribution('contrib-A');
		});
		expect(result.current.syncingContributionId).toBe('contrib-A');
		await act(async () => {
			resolveSync!({ message: 'Updated' });
			await flushMicrotasks();
		});
		expect(result.current.syncingContributionId).toBeNull();
		expect(result.current.prStatusMessage).toBe('Updated');
	});

	it('clears the syncing id even when sync throws and shows "Sync failed"', async () => {
		syncContribution.mockRejectedValue(new Error('nope'));
		const { result } = setup();
		await act(async () => {
			await result.current.syncContribution('contrib-B');
		});
		expect(result.current.syncingContributionId).toBeNull();
		expect(result.current.prStatusMessage).toBe('Sync failed');
	});

	it('isCheckingPRStatuses toggles around the call', async () => {
		let resolveCheck: (v: { checked: number }) => void;
		checkPRStatuses.mockReturnValue(
			new Promise((r) => {
				resolveCheck = r;
			})
		);
		const { result } = setup();
		act(() => {
			result.current.checkPRStatuses();
		});
		expect(result.current.isCheckingPRStatuses).toBe(true);
		await act(async () => {
			resolveCheck!({ checked: 0 });
			await flushMicrotasks();
		});
		expect(result.current.isCheckingPRStatuses).toBe(false);
	});

	it('cancels prior clear-timer when a new message arrives', async () => {
		checkPRStatuses
			.mockResolvedValueOnce({ merged: 1, closed: 0, checked: 1 })
			.mockResolvedValueOnce({ merged: 0, closed: 1, checked: 1 });
		const { result } = setup();
		await act(async () => {
			await result.current.checkPRStatuses();
		});
		expect(result.current.prStatusMessage).toBe('1 PR merged');
		// Advance 4s - still visible
		await act(async () => {
			vi.advanceTimersByTime(4000);
		});
		expect(result.current.prStatusMessage).toBe('1 PR merged');
		// New call resets the timer
		await act(async () => {
			await result.current.checkPRStatuses();
		});
		expect(result.current.prStatusMessage).toBe('1 PR closed');
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		// 2s passed since second message - still visible
		expect(result.current.prStatusMessage).toBe('1 PR closed');
		await act(async () => {
			vi.advanceTimersByTime(3500);
		});
		expect(result.current.prStatusMessage).toBeNull();
	});
});
