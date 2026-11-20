/**
 * Tests for useSystemOneLedger: mounting reads the ledger once, a filter change
 * reads it again with that filter, a slow read never overwrites a newer one,
 * and a failed read is reported without dropping the page already shown.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
	useSystemOneLedger,
	type SystemOneLedgerFilters,
} from '../../../../renderer/hooks/localModels';
import type { SystemOneLedgerPage } from '../../../../shared/local-models/system-one-ledger';

const ledger = () =>
	window.maestro.localModels.systemOne.ledger as unknown as ReturnType<typeof vi.fn>;

function page(total: number): SystemOneLedgerPage {
	return { entries: [], total, retentionDays: 30, notice: null };
}

describe('useSystemOneLedger', () => {
	beforeEach(() => {
		ledger().mockReset();
		ledger().mockResolvedValue(page(0));
	});

	it('reads every decision on mount', async () => {
		ledger().mockResolvedValue(page(4));
		const { result } = renderHook(() => useSystemOneLedger({}));
		expect(result.current.loading).toBe(true);

		await waitFor(() => expect(result.current.page).toEqual(page(4)));

		expect(ledger()).toHaveBeenCalledTimes(1);
		expect(ledger()).toHaveBeenCalledWith({});
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toBeNull();
	});

	it('reads again with the filter when one changes', async () => {
		const { result, rerender } = renderHook(
			(filters: SystemOneLedgerFilters) => useSystemOneLedger(filters),
			{ initialProps: {} }
		);
		await waitFor(() => expect(result.current.page).not.toBeNull());

		ledger().mockResolvedValue(page(2));
		rerender({ taskId: 'cue-gate', outcome: 'timeout' });

		await waitFor(() => expect(result.current.page).toEqual(page(2)));
		expect(ledger()).toHaveBeenLastCalledWith({ taskId: 'cue-gate', outcome: 'timeout' });
	});

	it('does not read again when a re-render hands it equal filters', async () => {
		const { result, rerender } = renderHook(
			(filters: SystemOneLedgerFilters) => useSystemOneLedger(filters),
			{ initialProps: { taskId: 'cue-gate' } as SystemOneLedgerFilters }
		);
		await waitFor(() => expect(result.current.page).not.toBeNull());

		rerender({ taskId: 'cue-gate' });

		expect(ledger()).toHaveBeenCalledTimes(1);
	});

	it('reads again on refresh', async () => {
		const { result } = renderHook(() => useSystemOneLedger({}));
		await waitFor(() => expect(result.current.page).not.toBeNull());

		ledger().mockResolvedValue(page(7));
		await act(async () => {
			await result.current.refresh();
		});

		expect(result.current.page).toEqual(page(7));
	});

	it('lets only the newest read answer', async () => {
		let answerSlow: (value: SystemOneLedgerPage) => void = () => {};
		ledger().mockReturnValueOnce(
			new Promise<SystemOneLedgerPage>((resolve) => {
				answerSlow = resolve;
			})
		);
		const { result, rerender } = renderHook(
			(filters: SystemOneLedgerFilters) => useSystemOneLedger(filters),
			{ initialProps: {} }
		);

		ledger().mockResolvedValue(page(2));
		rerender({ outcome: 'ok' });
		await waitFor(() => expect(result.current.page).toEqual(page(2)));

		await act(async () => {
			answerSlow(page(99));
		});

		expect(result.current.page).toEqual(page(2));
	});

	it('reports a failed read and keeps the page it had', async () => {
		ledger().mockResolvedValue(page(3));
		const { result } = renderHook(() => useSystemOneLedger({}));
		await waitFor(() => expect(result.current.page).toEqual(page(3)));

		ledger().mockRejectedValue(new Error('The statistics database is locked.'));
		await act(async () => {
			await result.current.refresh();
		});

		expect(result.current.error).toContain('The statistics database is locked.');
		expect(result.current.page).toEqual(page(3));
		expect(result.current.loading).toBe(false);
	});
});
