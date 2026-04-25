/**
 * Tests for useTourActions hook
 *
 * Tests:
 *   - setRightTab event: calls setActiveRightTab for valid tab values
 *   - setRightTab event: ignores invalid tab values
 *   - openRightPanel event: calls setRightPanelOpen(true)
 *   - closeRightPanel event: calls setRightPanelOpen(false)
 *   - ensureAiTab event: switches to AI tab when on terminal/browser tab
 *   - unknown type: no store action called
 *   - missing detail: no store action called
 *   - cleanup on unmount: listener is removed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useTourActions } from '../../../renderer/hooks/ui/useTourActions';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useTabStore } from '../../../renderer/stores/tabStore';

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	useUIStore.setState({
		activeRightTab: 'files',
		rightPanelOpen: true,
	} as any);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Dispatch a tour:action custom event and return it.
 * Wrapped in act() so React can flush any state updates synchronously.
 */
function dispatchTourAction(detail: Record<string, unknown>): void {
	act(() => {
		window.dispatchEvent(new CustomEvent('tour:action', { detail }));
	});
}

// ============================================================================
// Tests
// ============================================================================

describe('useTourActions', () => {
	// ==========================================================================
	// setRightTab
	// ==========================================================================
	describe('setRightTab event', () => {
		it('switches the right tab to "files"', () => {
			useUIStore.setState({ activeRightTab: 'history' } as any);

			renderHook(() => useTourActions());

			dispatchTourAction({ type: 'setRightTab', value: 'files' });

			expect(useUIStore.getState().activeRightTab).toBe('files');
		});

		it('switches the right tab to "history"', () => {
			useUIStore.setState({ activeRightTab: 'files' } as any);

			renderHook(() => useTourActions());

			dispatchTourAction({ type: 'setRightTab', value: 'history' });

			expect(useUIStore.getState().activeRightTab).toBe('history');
		});

		it('switches the right tab to "autorun"', () => {
			useUIStore.setState({ activeRightTab: 'files' } as any);

			renderHook(() => useTourActions());

			dispatchTourAction({ type: 'setRightTab', value: 'autorun' });

			expect(useUIStore.getState().activeRightTab).toBe('autorun');
		});

		it('does not change the active tab when value is an invalid tab name', () => {
			useUIStore.setState({ activeRightTab: 'files' } as any);

			renderHook(() => useTourActions());

			dispatchTourAction({ type: 'setRightTab', value: 'invalid-tab' });

			expect(useUIStore.getState().activeRightTab).toBe('files');
		});

		it('does not change the active tab when value is absent', () => {
			useUIStore.setState({ activeRightTab: 'history' } as any);

			renderHook(() => useTourActions());

			dispatchTourAction({ type: 'setRightTab' });

			expect(useUIStore.getState().activeRightTab).toBe('history');
		});
	});

	// ==========================================================================
	// openRightPanel
	// ==========================================================================
	describe('openRightPanel event', () => {
		it('opens the right panel when it is closed', () => {
			useUIStore.setState({ rightPanelOpen: false } as any);

			renderHook(() => useTourActions());

			dispatchTourAction({ type: 'openRightPanel' });

			expect(useUIStore.getState().rightPanelOpen).toBe(true);
		});

		it('keeps the right panel open when it is already open', () => {
			useUIStore.setState({ rightPanelOpen: true } as any);

			renderHook(() => useTourActions());

			dispatchTourAction({ type: 'openRightPanel' });

			expect(useUIStore.getState().rightPanelOpen).toBe(true);
		});
	});

	// ==========================================================================
	// closeRightPanel
	// ==========================================================================
	describe('closeRightPanel event', () => {
		it('closes the right panel when it is open', () => {
			useUIStore.setState({ rightPanelOpen: true } as any);

			renderHook(() => useTourActions());

			dispatchTourAction({ type: 'closeRightPanel' });

			expect(useUIStore.getState().rightPanelOpen).toBe(false);
		});

		it('keeps the right panel closed when it is already closed', () => {
			useUIStore.setState({ rightPanelOpen: false } as any);

			renderHook(() => useTourActions());

			dispatchTourAction({ type: 'closeRightPanel' });

			expect(useUIStore.getState().rightPanelOpen).toBe(false);
		});
	});

	// ==========================================================================
	// ensureAiTab
	// ==========================================================================
	describe('ensureAiTab event', () => {
		it('switches to AI tab when session is on a terminal tab', () => {
			const selectTabSpy = vi.spyOn(useTabStore.getState(), 'selectTab');
			useSessionStore.setState({
				sessions: [
					{
						id: 'session-1',
						inputMode: 'terminal',
						activeTabId: 'ai-tab-1',
						activeBrowserTabId: null,
						activeTerminalTabId: 'term-1',
						aiTabs: [{ id: 'ai-tab-1' }],
					} as any,
				],
				activeSessionId: 'session-1',
			});

			renderHook(() => useTourActions());

			dispatchTourAction({ type: 'ensureAiTab' });

			expect(selectTabSpy).toHaveBeenCalledWith('ai-tab-1');
			selectTabSpy.mockRestore();
		});

		it('switches to AI tab when session has an active browser tab', () => {
			const selectTabSpy = vi.spyOn(useTabStore.getState(), 'selectTab');
			useSessionStore.setState({
				sessions: [
					{
						id: 'session-1',
						inputMode: 'ai',
						activeTabId: 'ai-tab-1',
						activeBrowserTabId: 'browser-1',
						activeTerminalTabId: null,
						aiTabs: [{ id: 'ai-tab-1' }],
					} as any,
				],
				activeSessionId: 'session-1',
			});

			renderHook(() => useTourActions());

			dispatchTourAction({ type: 'ensureAiTab' });

			expect(selectTabSpy).toHaveBeenCalledWith('ai-tab-1');
			selectTabSpy.mockRestore();
		});

		it('does nothing when already on an AI tab', () => {
			const selectTabSpy = vi.spyOn(useTabStore.getState(), 'selectTab');
			useSessionStore.setState({
				sessions: [
					{
						id: 'session-1',
						inputMode: 'ai',
						activeTabId: 'ai-tab-1',
						activeBrowserTabId: null,
						activeTerminalTabId: null,
						aiTabs: [{ id: 'ai-tab-1' }],
					} as any,
				],
				activeSessionId: 'session-1',
			});

			renderHook(() => useTourActions());

			dispatchTourAction({ type: 'ensureAiTab' });

			expect(selectTabSpy).not.toHaveBeenCalled();
			selectTabSpy.mockRestore();
		});

		it('does nothing when there is no active session', () => {
			const selectTabSpy = vi.spyOn(useTabStore.getState(), 'selectTab');
			useSessionStore.setState({
				sessions: [],
				activeSessionId: '',
			});

			renderHook(() => useTourActions());

			expect(() => dispatchTourAction({ type: 'ensureAiTab' })).not.toThrow();
			expect(selectTabSpy).not.toHaveBeenCalled();
			selectTabSpy.mockRestore();
		});
	});

	// ==========================================================================
	// Unknown / missing event detail
	// ==========================================================================
	describe('unrecognized event types', () => {
		it('does not mutate store state for an unrecognized type', () => {
			useUIStore.setState({ activeRightTab: 'files', rightPanelOpen: true } as any);

			renderHook(() => useTourActions());

			dispatchTourAction({ type: 'hamburgerMenu' });

			expect(useUIStore.getState().activeRightTab).toBe('files');
			expect(useUIStore.getState().rightPanelOpen).toBe(true);
		});

		it('does not throw and ignores an event with no detail.type', () => {
			useUIStore.setState({ activeRightTab: 'files', rightPanelOpen: true } as any);

			renderHook(() => useTourActions());

			// detail is present but type is missing
			expect(() => dispatchTourAction({ value: 'history' })).not.toThrow();

			expect(useUIStore.getState().activeRightTab).toBe('files');
			expect(useUIStore.getState().rightPanelOpen).toBe(true);
		});

		it('does not throw when the event has an empty detail object', () => {
			renderHook(() => useTourActions());

			expect(() => dispatchTourAction({})).not.toThrow();
		});
	});

	// ==========================================================================
	// Cleanup on unmount
	// ==========================================================================
	describe('cleanup on unmount', () => {
		it('removes the tour:action listener on unmount so later events are ignored', () => {
			useUIStore.setState({ activeRightTab: 'files' } as any);

			const { unmount } = renderHook(() => useTourActions());

			unmount();

			// Dispatch an event after the hook has been torn down.
			act(() => {
				window.dispatchEvent(
					new CustomEvent('tour:action', { detail: { type: 'setRightTab', value: 'history' } })
				);
			});

			// Store should not have changed because the listener was removed.
			expect(useUIStore.getState().activeRightTab).toBe('files');
		});

		it('does not affect a separately mounted instance after the first unmounts', () => {
			useUIStore.setState({ activeRightTab: 'files' } as any);

			const { unmount: unmount1 } = renderHook(() => useTourActions());
			renderHook(() => useTourActions()); // second instance

			// Unmount only the first instance.
			unmount1();

			// The second instance's listener should still be active.
			dispatchTourAction({ type: 'setRightTab', value: 'autorun' });

			expect(useUIStore.getState().activeRightTab).toBe('autorun');
		});
	});

	// ==========================================================================
	// Return value
	// ==========================================================================
	describe('return value', () => {
		it('returns void (undefined)', () => {
			const { result } = renderHook(() => useTourActions());

			expect(result.current).toBeUndefined();
		});
	});
});
