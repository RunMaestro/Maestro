/**
 * Tests for useMobileViewState hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMobileViewState } from '../../../web/hooks/useMobileViewState';

const mockLoadViewState = vi.hoisted(() => vi.fn());
const mockLoadScrollState = vi.hoisted(() => vi.fn());
const mockDebouncedSaveViewState = vi.hoisted(() => vi.fn());

vi.mock('../../../web/utils/viewState', () => ({
	loadViewState: mockLoadViewState,
	loadScrollState: mockLoadScrollState,
	debouncedSaveViewState: mockDebouncedSaveViewState,
}));

describe('useMobileViewState', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(window, 'innerHeight', { value: 600, writable: true });

		mockLoadViewState.mockReturnValue({
			showAllSessions: false,
			showHistoryPanel: false,
			showTabSearch: false,
			activeSessionId: null,
			activeTabId: null,
			inputMode: 'ai',
			historyFilter: 'all',
			historySearchOpen: false,
			historySearchQuery: '',
			savedAt: Date.now(),
		});

		mockLoadScrollState.mockReturnValue({
			messageHistory: 0,
			allSessions: 0,
			historyPanel: 0,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('loads saved view and scroll state', () => {
		const { result } = renderHook(() => useMobileViewState());

		expect(result.current.savedState).toEqual(
			expect.objectContaining({
				showAllSessions: false,
				activeSessionId: null,
				inputMode: 'ai',
			})
		);
		expect(result.current.savedScrollState).toEqual({
			messageHistory: 0,
			allSessions: 0,
			historyPanel: 0,
		});
	});

	it('tracks small screen state and updates on resize', () => {
		const { result } = renderHook(() => useMobileViewState());

		expect(result.current.isSmallScreen).toBe(true);

		act(() => {
			Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });
			window.dispatchEvent(new Event('resize'));
		});

		expect(result.current.isSmallScreen).toBe(false);
	});

	it('persists view and history state via debounced save', () => {
		const { result } = renderHook(() => useMobileViewState());

		act(() => {
			result.current.persistViewState({
				showAllSessions: true,
				showHistoryPanel: false,
				showTabSearch: true,
			});
		});

		expect(mockDebouncedSaveViewState).toHaveBeenCalledWith({
			showAllSessions: true,
			showHistoryPanel: false,
			showTabSearch: true,
		});

		act(() => {
			result.current.persistHistoryState({
				historyFilter: 'AUTO',
				historySearchQuery: 'search',
				historySearchOpen: true,
			});
		});

		expect(mockDebouncedSaveViewState).toHaveBeenCalledWith({
			historyFilter: 'AUTO',
			historySearchQuery: 'search',
			historySearchOpen: true,
		});
	});

	it('persists session selection state', () => {
		const { result } = renderHook(() => useMobileViewState());

		act(() => {
			result.current.persistSessionSelection({
				activeSessionId: 'session-1',
				activeTabId: 'tab-1',
			});
		});

		expect(mockDebouncedSaveViewState).toHaveBeenCalledWith({
			activeSessionId: 'session-1',
			activeTabId: 'tab-1',
		});
	});
});
