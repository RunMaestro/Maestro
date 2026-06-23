/**
 * Tests for WindowContext
 *
 * WindowContext teaches each renderer which window it is and which agents
 * (sessions) belong to it. The behaviour that matters most - and is exercised
 * here - is the single-window-per-agent invariant: opening an agent that lives
 * in another window focuses that window instead of stealing the agent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React, { ReactNode } from 'react';
import {
	WindowProvider,
	useWindowContext,
	useWindowContextOptional,
} from '../../../renderer/contexts/WindowContext';
import type { WindowInfo, WindowState } from '../../../shared/window-types';

const windows = () => window.maestro.windows;

/** Build a full WindowState, overriding only the fields a test cares about. */
function makeState(partial: Partial<WindowState> & Pick<WindowState, 'id'>): WindowState {
	return {
		x: 0,
		y: 0,
		width: 1200,
		height: 800,
		isMaximized: false,
		isFullScreen: false,
		sessionIds: [],
		activeSessionId: null,
		leftPanelCollapsed: false,
		rightPanelCollapsed: false,
		...partial,
	};
}

/** Build a WindowInfo for the `windows.list()` mock. */
function makeInfo(partial: Partial<WindowInfo> & Pick<WindowInfo, 'id'>): WindowInfo {
	return {
		isMain: false,
		sessionIds: [],
		activeSessionId: null,
		...partial,
	};
}

/** Set the renderer URL so the provider reads the desired `?windowId=` param. */
function setUrl(search: string): void {
	window.history.replaceState({}, '', search || '/');
}

function wrapper({ children }: { children: ReactNode }) {
	return <WindowProvider>{children}</WindowProvider>;
}

describe('WindowContext', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setUrl('/');
		// Reset the windows IPC mocks to their neutral baseline; tests override.
		vi.mocked(windows().getState).mockResolvedValue(null);
		vi.mocked(windows().list).mockResolvedValue([]);
		vi.mocked(windows().getForSession).mockResolvedValue(null);
		vi.mocked(windows().focusWindow).mockResolvedValue({ focused: true });
		vi.mocked(windows().create).mockResolvedValue(null);
		vi.mocked(windows().moveSession).mockResolvedValue({ moved: true });
	});

	afterEach(() => {
		setUrl('/');
	});

	describe('useWindowContext outside provider', () => {
		it('throws when used without a WindowProvider', () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			expect(() => renderHook(() => useWindowContext())).toThrow(
				'useWindowContext must be used within a WindowProvider'
			);
			consoleSpy.mockRestore();
		});
	});

	describe('window identity', () => {
		it('treats a window with no ?windowId param as the primary window', async () => {
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'primary-1', sessionIds: ['a', 'b'], activeSessionId: 'a' })
			);

			const { result } = renderHook(() => useWindowContext(), { wrapper });

			// isMainWindow is known synchronously from the URL.
			expect(result.current.isMainWindow).toBe(true);
			// The primary has no URL id, so it adopts the registry's id on hydrate.
			await waitFor(() => expect(result.current.windowId).toBe('primary-1'));
			expect(result.current.sessionIds).toEqual(['a', 'b']);
			expect(result.current.activeSessionId).toBe('a');
		});

		it('treats a window with a ?windowId param as a secondary window', async () => {
			setUrl('/?windowId=win-2');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-2', sessionIds: ['c'], activeSessionId: 'c' })
			);

			const { result } = renderHook(() => useWindowContext(), { wrapper });

			expect(result.current.isMainWindow).toBe(false);
			// Secondary windows know their id synchronously from the param.
			expect(result.current.windowId).toBe('win-2');
			await waitFor(() => expect(result.current.sessionIds).toEqual(['c']));
			expect(result.current.activeSessionId).toBe('c');
		});

		it('leaves state empty when getState returns null', async () => {
			setUrl('/?windowId=win-9');
			vi.mocked(windows().getState).mockResolvedValue(null);

			const { result } = renderHook(() => useWindowContext(), { wrapper });

			await waitFor(() => expect(windows().getState).toHaveBeenCalled());
			expect(result.current.windowId).toBe('win-9');
			expect(result.current.sessionIds).toEqual([]);
			expect(result.current.activeSessionId).toBeNull();
		});
	});

	describe('openSession - single-window-per-agent invariant', () => {
		it('focuses the owning window when the agent lives elsewhere', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'win-1' }));
			vi.mocked(windows().getForSession).mockResolvedValue('win-2');

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('win-1'));

			await act(async () => {
				await result.current.openSession('agent-x');
			});

			expect(windows().focusWindow).toHaveBeenCalledWith('win-2');
			// The agent is NOT stolen into this window.
			expect(result.current.sessionIds).toEqual([]);
			expect(result.current.activeSessionId).toBeNull();
		});

		it('opens an unowned agent locally', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'win-1' }));
			vi.mocked(windows().getForSession).mockResolvedValue(null);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('win-1'));

			await act(async () => {
				await result.current.openSession('agent-y');
			});

			expect(windows().focusWindow).not.toHaveBeenCalled();
			expect(result.current.sessionIds).toEqual(['agent-y']);
			expect(result.current.activeSessionId).toBe('agent-y');
		});

		it('activates an agent already owned by this window without re-adding it', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-1', sessionIds: ['agent-z', 'other'], activeSessionId: 'other' })
			);
			vi.mocked(windows().getForSession).mockResolvedValue('win-1');

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.sessionIds).toEqual(['agent-z', 'other']));

			await act(async () => {
				await result.current.openSession('agent-z');
			});

			expect(windows().focusWindow).not.toHaveBeenCalled();
			expect(result.current.sessionIds).toEqual(['agent-z', 'other']);
			expect(result.current.activeSessionId).toBe('agent-z');
		});
	});

	describe('closeTab', () => {
		it('removes the agent and focuses the left neighbour when it was active', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-1', sessionIds: ['a', 'b', 'c'], activeSessionId: 'b' })
			);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.sessionIds).toEqual(['a', 'b', 'c']));

			act(() => {
				result.current.closeTab('b');
			});

			expect(result.current.sessionIds).toEqual(['a', 'c']);
			expect(result.current.activeSessionId).toBe('a');
		});

		it('leaves the active agent unchanged when closing a different tab', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-1', sessionIds: ['a', 'b', 'c'], activeSessionId: 'b' })
			);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.sessionIds).toEqual(['a', 'b', 'c']));

			act(() => {
				result.current.closeTab('c');
			});

			expect(result.current.sessionIds).toEqual(['a', 'b']);
			expect(result.current.activeSessionId).toBe('b');
		});

		it('clears the active agent when the last tab closes', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-1', sessionIds: ['a'], activeSessionId: 'a' })
			);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.sessionIds).toEqual(['a']));

			act(() => {
				result.current.closeTab('a');
			});

			expect(result.current.sessionIds).toEqual([]);
			expect(result.current.activeSessionId).toBeNull();
		});
	});

	describe('moveSessionToNewWindow', () => {
		it('creates a new window, transfers ownership, and drops the agent locally', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-1', sessionIds: ['a', 'b'], activeSessionId: 'a' })
			);
			vi.mocked(windows().create).mockResolvedValue({
				id: 'win-3',
				isMain: false,
				sessionIds: ['a'],
				activeSessionId: null,
			});

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('win-1'));

			await act(async () => {
				await result.current.moveSessionToNewWindow('a');
			});

			expect(windows().create).toHaveBeenCalledWith(['a']);
			expect(windows().moveSession).toHaveBeenCalledWith('a', 'win-1', 'win-3');
			expect(result.current.sessionIds).toEqual(['b']);
			// 'a' was active and left, so focus moves to the surviving neighbour.
			expect(result.current.activeSessionId).toBe('b');
		});

		it('does nothing if the new window could not be created', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-1', sessionIds: ['a', 'b'], activeSessionId: 'a' })
			);
			vi.mocked(windows().create).mockResolvedValue(null);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('win-1'));

			await act(async () => {
				await result.current.moveSessionToNewWindow('a');
			});

			expect(windows().moveSession).not.toHaveBeenCalled();
			expect(result.current.sessionIds).toEqual(['a', 'b']);
			expect(result.current.activeSessionId).toBe('a');
		});
	});

	describe('callback stability', () => {
		it('keeps action callbacks stable across re-renders', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'win-1' }));

			const { result, rerender } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('win-1'));

			const { closeTab } = result.current;
			rerender();
			expect(result.current.closeTab).toBe(closeTab);
		});
	});

	describe('ownsSession', () => {
		it('primary window owns every agent no other window has claimed', async () => {
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'primary-1', sessionIds: [], activeSessionId: null })
			);
			vi.mocked(windows().list).mockResolvedValue([
				makeInfo({ id: 'primary-1', isMain: true }),
				makeInfo({ id: 'win-2', sessionIds: ['claimed'], activeSessionId: 'claimed' }),
			]);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('primary-1'));

			// The catch-all primary owns any agent no secondary window took over...
			expect(result.current.ownsSession('free-agent')).toBe(true);
			// ...but not one a secondary window has explicitly claimed.
			await waitFor(() => expect(result.current.ownsSession('claimed')).toBe(false));
		});

		it('secondary window owns only its scoped agents', async () => {
			setUrl('/?windowId=win-2');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-2', sessionIds: ['a', 'b'], activeSessionId: 'a' })
			);
			vi.mocked(windows().list).mockResolvedValue([
				makeInfo({ id: 'primary-1', isMain: true, sessionIds: ['x'], activeSessionId: 'x' }),
				makeInfo({ id: 'win-2', sessionIds: ['a', 'b'], activeSessionId: 'a' }),
			]);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.sessionIds).toEqual(['a', 'b']));

			expect(result.current.ownsSession('a')).toBe(true);
			expect(result.current.ownsSession('b')).toBe(true);
			// A secondary window is NOT a catch-all: it owns neither another window's
			// agent nor an entirely unclaimed one.
			expect(result.current.ownsSession('x')).toBe(false);
			expect(result.current.ownsSession('free-agent')).toBe(false);
		});
	});

	describe('getSessionWindow - cross-window ownership + numbering', () => {
		it('returns null for every agent in the common single-window case', async () => {
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'primary-1', sessionIds: ['a', 'b'], activeSessionId: 'a' })
			);
			vi.mocked(windows().list).mockResolvedValue([makeInfo({ id: 'primary-1', isMain: true })]);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('primary-1'));

			// The lone primary surfaces every agent, so nothing lives "elsewhere".
			expect(result.current.getSessionWindow('a')).toBeNull();
			expect(result.current.getSessionWindow('anything')).toBeNull();
		});

		it('from the primary window: badges agents a secondary has claimed', async () => {
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'primary-1', sessionIds: [], activeSessionId: null })
			);
			vi.mocked(windows().list).mockResolvedValue([
				makeInfo({ id: 'primary-1', isMain: true }),
				makeInfo({ id: 'win-2', sessionIds: ['claimed'], activeSessionId: 'claimed' }),
			]);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('primary-1'));

			// The secondary is the 2nd window in registry order -> number 2.
			await waitFor(() =>
				expect(result.current.getSessionWindow('claimed')).toEqual({
					windowId: 'win-2',
					windowNumber: 2,
				})
			);
			// A catch-all agent the primary itself surfaces gets no badge.
			expect(result.current.getSessionWindow('free-agent')).toBeNull();
		});

		it('from a secondary window: catch-all agents belong to the primary (window 1)', async () => {
			setUrl('/?windowId=win-2');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-2', sessionIds: ['claimed'], activeSessionId: 'claimed' })
			);
			vi.mocked(windows().list).mockResolvedValue([
				makeInfo({ id: 'primary-1', isMain: true }),
				makeInfo({ id: 'win-2', sessionIds: ['claimed'], activeSessionId: 'claimed' }),
			]);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.sessionIds).toEqual(['claimed']));

			// An unclaimed agent is surfaced by the primary catch-all -> window 1.
			await waitFor(() =>
				expect(result.current.getSessionWindow('free-agent')).toEqual({
					windowId: 'primary-1',
					windowNumber: 1,
				})
			);
			// This window's own agent gets no badge.
			expect(result.current.getSessionWindow('claimed')).toBeNull();
		});

		it('from a secondary window: badges an agent owned by ANOTHER secondary', async () => {
			setUrl('/?windowId=win-2');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-2', sessionIds: ['a'], activeSessionId: 'a' })
			);
			vi.mocked(windows().list).mockResolvedValue([
				makeInfo({ id: 'primary-1', isMain: true }),
				makeInfo({ id: 'win-2', sessionIds: ['a'], activeSessionId: 'a' }),
				makeInfo({ id: 'win-3', sessionIds: ['b'], activeSessionId: 'b' }),
			]);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.sessionIds).toEqual(['a']));

			// win-3 is the 3rd window in registry order -> number 3.
			await waitFor(() =>
				expect(result.current.getSessionWindow('b')).toEqual({
					windowId: 'win-3',
					windowNumber: 3,
				})
			);
			expect(result.current.getSessionWindow('a')).toBeNull();
		});
	});

	describe('useWindowContextOptional', () => {
		it('returns null outside a provider instead of throwing', () => {
			const { result } = renderHook(() => useWindowContextOptional());
			expect(result.current).toBeNull();
		});

		it('returns the live context value inside a provider', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'win-1' }));

			const { result } = renderHook(() => useWindowContextOptional(), { wrapper });

			await waitFor(() => expect(result.current?.windowId).toBe('win-1'));
			expect(typeof result.current?.ownsSession).toBe('function');
		});
	});
});
