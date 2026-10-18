import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useComputerHistoryStatus } from '../../../../renderer/hooks/computerHistory/useComputerHistoryStatus';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { ComputerHistoryStatus } from '../../../../shared/computer-history/status';

const statusOf = (state: string) => ({ state }) as unknown as ComputerHistoryStatus;

let resolveInitial: (status: ComputerHistoryStatus) => void;
let push: (status: ComputerHistoryStatus) => void;
let original: unknown;

beforeEach(() => {
	const s = useSettingsStore.getState();
	useSettingsStore.setState({ encoreFeatures: { ...s.encoreFeatures, computerHistory: true } });
	const maestro = window.maestro as unknown as Record<string, unknown>;
	original = maestro.computerHistory;
	maestro.computerHistory = {
		status: vi.fn(
			() => new Promise<ComputerHistoryStatus>((resolve) => (resolveInitial = resolve))
		),
		onStatusChanged: vi.fn((cb: (status: ComputerHistoryStatus) => void) => {
			push = cb;
			return () => {};
		}),
	};
});
afterEach(() => {
	(window.maestro as unknown as Record<string, unknown>).computerHistory = original;
});

describe('useComputerHistoryStatus', () => {
	it('uses the first read when nothing was pushed meanwhile', async () => {
		const { result } = renderHook(() => useComputerHistoryStatus());
		await act(async () => resolveInitial(statusOf('blocked')));
		await waitFor(() => expect(result.current.status?.state).toBe('blocked'));
	});

	it('does not let a slow first read overwrite a newer pushed status', async () => {
		const { result } = renderHook(() => useComputerHistoryStatus());
		act(() => push(statusOf('recording')));
		expect(result.current.status?.state).toBe('recording');

		// The read that started first answers last, with the older state.
		await act(async () => resolveInitial(statusOf('blocked')));
		expect(result.current.status?.state).toBe('recording');
	});
});
