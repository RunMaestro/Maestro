import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWindowState } from '../../../renderer/hooks/useWindowState';
import { useUIStore } from '../../../renderer/stores/uiStore';

function TestHarness() {
	useWindowState();
	return null;
}

const initialUiState = useUIStore.getState();

function resetUiStore() {
	useUIStore.setState(initialUiState, true);
}

describe('useWindowState hook', () => {
	beforeEach(() => {
		resetUiStore();
		(window as any).maestro = undefined;
	});

	afterEach(() => {
		cleanup();
		(window as any).maestro = undefined;
	});

	it('hydrates panel state from persisted window metadata', async () => {
		const getState = vi.fn().mockResolvedValue({
			leftPanelCollapsed: true,
			rightPanelCollapsed: false,
		});
		const updateState = vi.fn().mockResolvedValue(true);
		(window as any).maestro = {
			windows: {
				getState,
				updateState,
			},
		};

		render(<TestHarness />);

		await waitFor(() => expect(getState).toHaveBeenCalled());

		expect(useUIStore.getState().leftSidebarOpen).toBe(false);
		expect(useUIStore.getState().rightPanelOpen).toBe(true);
		expect(updateState).not.toHaveBeenCalled();
	});

	it('persists panel toggles after hydration', async () => {
		const getState = vi.fn().mockResolvedValue({
			leftPanelCollapsed: false,
			rightPanelCollapsed: false,
		});
		const updateState = vi.fn().mockResolvedValue(true);
		(window as any).maestro = {
			windows: {
				getState,
				updateState,
			},
		};

		render(<TestHarness />);

		await waitFor(() => expect(getState).toHaveBeenCalled());

		act(() => {
			useUIStore.getState().setLeftSidebarOpen(false);
		});

		await waitFor(() => {
			expect(updateState).toHaveBeenCalledWith({ leftPanelCollapsed: true });
		});

		act(() => {
			useUIStore.getState().setRightPanelOpen(false);
		});

		await waitFor(() => {
			expect(updateState).toHaveBeenCalledWith({ rightPanelCollapsed: true });
		});

		expect(updateState).toHaveBeenCalledTimes(2);
	});
});
