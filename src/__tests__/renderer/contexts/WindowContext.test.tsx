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
	useWindowOwnsSession,
} from '../../../renderer/contexts/WindowContext';
import type { WindowInfo, WindowState } from '../../../shared/window-types';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { createMockSession } from '../../helpers/mockSession';

// The primary-window-empty guard surfaces a toast; mock it so tests assert the
// guard fired without the real toast's side effects (logger/notification IPC).
vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});

const windows = () => window.maestro.windows;

/** Replace the live agent list the guard reads when counting a window's agents. */
function seedSessions(ids: string[]): void {
	useSessionStore.setState({ sessions: ids.map((id) => createMockSession({ id })) });
}

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
		// The empty-primary guard reads the live agent list; start each test from a
		// clean store so a prior test's seed can't leak into one that doesn't seed.
		useSessionStore.setState({ sessions: [] });
		// Reset the windows IPC mocks to their neutral baseline; tests override.
		vi.mocked(windows().getState).mockResolvedValue(null);
		vi.mocked(windows().list).mockResolvedValue([]);
		vi.mocked(windows().getForSession).mockResolvedValue(null);
		vi.mocked(windows().focusWindow).mockResolvedValue({ focused: true });
		vi.mocked(windows().create).mockResolvedValue(null);
		vi.mocked(windows().moveSession).mockResolvedValue({ moved: true });
		// Default the broadcast subscription to a no-op unsubscribe; the refresh
		// tests capture the registered callback to simulate a broadcast.
		vi.mocked(windows().onSessionMoved).mockReturnValue(() => {});
		// Same for the drop-zone highlight push; highlight tests capture the callback.
		vi.mocked(windows().onHighlightDropZone).mockReturnValue(() => {});
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

			// No bounds passed -> the main process picks a default position.
			expect(windows().create).toHaveBeenCalledWith(['a'], undefined);
			expect(windows().moveSession).toHaveBeenCalledWith('a', 'win-1', 'win-3');
			expect(result.current.sessionIds).toEqual(['b']);
			// 'a' was active and left, so focus moves to the surviving neighbour.
			expect(result.current.activeSessionId).toBe('b');
		});

		it('positions the new window at the provided drop-point bounds', async () => {
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
				await result.current.moveSessionToNewWindow('a', { x: 540, y: 260 });
			});

			// The drop-point bounds are threaded straight through to windows.create.
			expect(windows().create).toHaveBeenCalledWith(['a'], { x: 540, y: 260 });
			expect(windows().moveSession).toHaveBeenCalledWith('a', 'win-1', 'win-3');
			expect(result.current.sessionIds).toEqual(['b']);
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

	describe('moveSessionToWindow', () => {
		it('docks the agent into an existing window and drops it locally', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-1', sessionIds: ['a', 'b'], activeSessionId: 'a' })
			);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('win-1'));

			await act(async () => {
				await result.current.moveSessionToWindow('a', 'win-2');
			});

			expect(windows().moveSession).toHaveBeenCalledWith('a', 'win-1', 'win-2');
			expect(result.current.sessionIds).toEqual(['b']);
			// 'a' was active and left, so focus moves to the surviving neighbour.
			expect(result.current.activeSessionId).toBe('b');
		});

		it('does nothing when the move is onto this same window', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-1', sessionIds: ['a', 'b'], activeSessionId: 'a' })
			);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('win-1'));

			await act(async () => {
				await result.current.moveSessionToWindow('a', 'win-1');
			});

			expect(windows().moveSession).not.toHaveBeenCalled();
			expect(result.current.sessionIds).toEqual(['a', 'b']);
			expect(result.current.activeSessionId).toBe('a');
		});

		it('keeps the agent locally when the registry reports the move failed', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-1', sessionIds: ['a', 'b'], activeSessionId: 'a' })
			);
			vi.mocked(windows().moveSession).mockResolvedValue({
				moved: false,
				error: 'Unknown source or destination window',
			});

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('win-1'));

			await act(async () => {
				await result.current.moveSessionToWindow('a', 'win-2');
			});

			expect(windows().moveSession).toHaveBeenCalledWith('a', 'win-1', 'win-2');
			// Move rejected: the agent stays put rather than being stranded.
			expect(result.current.sessionIds).toEqual(['a', 'b']);
			expect(result.current.activeSessionId).toBe('a');
		});
	});

	describe('primary-window-empty guard', () => {
		it('blocks detaching the last agent out of the primary window (toast shown)', async () => {
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'primary-1', sessionIds: [], activeSessionId: null })
			);
			vi.mocked(windows().list).mockResolvedValue([makeInfo({ id: 'primary-1', isMain: true })]);
			// The primary surfaces exactly one agent (catch-all owner, nothing claimed).
			seedSessions(['only']);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('primary-1'));

			await act(async () => {
				await result.current.moveSessionToNewWindow('only');
			});

			// Move is blocked: no window is created and the user is told why.
			expect(windows().create).not.toHaveBeenCalled();
			expect(windows().moveSession).not.toHaveBeenCalled();
			expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ color: 'yellow' }));
		});

		it('blocks docking the last agent out of the primary window (toast shown)', async () => {
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'primary-1', sessionIds: [], activeSessionId: null })
			);
			vi.mocked(windows().list).mockResolvedValue([
				makeInfo({ id: 'primary-1', isMain: true }),
				makeInfo({ id: 'win-2' }),
			]);
			seedSessions(['only']);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('primary-1'));

			await act(async () => {
				await result.current.moveSessionToWindow('only', 'win-2');
			});

			expect(windows().moveSession).not.toHaveBeenCalled();
			expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ color: 'yellow' }));
		});

		it('allows the move when the primary keeps another agent', async () => {
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'primary-1', sessionIds: [], activeSessionId: null })
			);
			vi.mocked(windows().list).mockResolvedValue([makeInfo({ id: 'primary-1', isMain: true })]);
			// Two unclaimed agents -> moving one still leaves the primary populated.
			seedSessions(['a', 'b']);
			vi.mocked(windows().create).mockResolvedValue(makeInfo({ id: 'win-3', sessionIds: ['a'] }));

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('primary-1'));

			await act(async () => {
				await result.current.moveSessionToNewWindow('a');
			});

			expect(windows().create).toHaveBeenCalledWith(['a'], undefined);
			expect(windows().moveSession).toHaveBeenCalledWith('a', 'primary-1', 'win-3');
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('allows emptying a SECONDARY window (only the primary is guarded)', async () => {
			setUrl('/?windowId=win-2');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-2', sessionIds: ['only'], activeSessionId: 'only' })
			);
			vi.mocked(windows().list).mockResolvedValue([
				makeInfo({ id: 'primary-1', isMain: true }),
				makeInfo({ id: 'win-2', sessionIds: ['only'], activeSessionId: 'only' }),
			]);
			// 'only' is this secondary's lone agent; a secondary may be emptied.
			seedSessions(['only']);
			vi.mocked(windows().create).mockResolvedValue(
				makeInfo({ id: 'win-3', sessionIds: ['only'] })
			);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.sessionIds).toEqual(['only']));

			await act(async () => {
				await result.current.moveSessionToNewWindow('only');
			});

			expect(windows().create).toHaveBeenCalledWith(['only'], undefined);
			expect(windows().moveSession).toHaveBeenCalledWith('only', 'win-2', 'win-3');
			expect(notifyToast).not.toHaveBeenCalled();
			expect(result.current.sessionIds).toEqual([]);
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

	describe('windows:sessionMoved broadcast', () => {
		it('re-hydrates scope and window list when a broadcast arrives', async () => {
			setUrl('/?windowId=win-2');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-2', sessionIds: ['a'], activeSessionId: 'a' })
			);
			vi.mocked(windows().list).mockResolvedValue([
				makeInfo({ id: 'primary-1', isMain: true }),
				makeInfo({ id: 'win-2', sessionIds: ['a'], activeSessionId: 'a' }),
			]);

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.sessionIds).toEqual(['a']));

			// Agent 'b' moves INTO this window: the registry now reports a + b.
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-2', sessionIds: ['a', 'b'], activeSessionId: 'a' })
			);

			// Fire the broadcast the preload would deliver on the IPC channel.
			const handler = vi.mocked(windows().onSessionMoved).mock.calls[0][0];
			await act(async () => {
				handler({
					type: 'session-moved',
					sessionId: 'b',
					fromWindowId: 'primary-1',
					toWindowId: 'win-2',
				});
			});

			await waitFor(() => expect(result.current.sessionIds).toEqual(['a', 'b']));
		});

		it('subscribes on mount and unsubscribes on unmount', async () => {
			const unsubscribe = vi.fn();
			vi.mocked(windows().onSessionMoved).mockReturnValue(unsubscribe);
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'win-1' }));

			const { unmount } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(windows().onSessionMoved).toHaveBeenCalled());

			unmount();
			expect(unsubscribe).toHaveBeenCalled();
		});
	});

	describe('windows:highlightDropZone (drop-zone highlight)', () => {
		it('defaults isDropTarget to false', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'win-1' }));

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('win-1'));

			expect(result.current.isDropTarget).toBe(false);
		});

		it('lights up and clears when a push targets this window', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'win-1' }));

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('win-1'));

			// Fire the push the preload would deliver on the IPC channel.
			const handler = vi.mocked(windows().onHighlightDropZone).mock.calls[0][0];
			act(() => handler({ windowId: 'win-1', active: true }));
			expect(result.current.isDropTarget).toBe(true);

			act(() => handler({ windowId: 'win-1', active: false }));
			expect(result.current.isDropTarget).toBe(false);
		});

		it('ignores a push targeting a different window', async () => {
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'win-1' }));

			const { result } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(result.current.windowId).toBe('win-1'));

			const handler = vi.mocked(windows().onHighlightDropZone).mock.calls[0][0];
			act(() => handler({ windowId: 'win-2', active: true }));
			expect(result.current.isDropTarget).toBe(false);
		});

		it('subscribes on mount and unsubscribes on unmount', async () => {
			const unsubscribe = vi.fn();
			vi.mocked(windows().onHighlightDropZone).mockReturnValue(unsubscribe);
			setUrl('/?windowId=win-1');
			vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'win-1' }));

			const { unmount } = renderHook(() => useWindowContext(), { wrapper });
			await waitFor(() => expect(windows().onHighlightDropZone).toHaveBeenCalled());

			unmount();
			expect(unsubscribe).toHaveBeenCalled();
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

	describe('useWindowOwnsSession', () => {
		it('returns true outside a provider so single-window views stay unscoped', () => {
			const { result } = renderHook(() => useWindowOwnsSession('any-agent'));
			expect(result.current).toBe(true);
		});

		it('returns true for a null/undefined sessionId (nothing to gate)', () => {
			setUrl('/?windowId=win-2');
			vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'win-2' }));

			const { result } = renderHook(() => useWindowOwnsSession(null), { wrapper });
			expect(result.current).toBe(true);
		});

		it('primary window owns an unclaimed agent but not one claimed elsewhere', async () => {
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'primary-1', sessionIds: [], activeSessionId: null })
			);
			vi.mocked(windows().list).mockResolvedValue([
				makeInfo({ id: 'primary-1', isMain: true }),
				makeInfo({ id: 'win-2', sessionIds: ['claimed'], activeSessionId: 'claimed' }),
			]);

			const { result: free } = renderHook(() => useWindowOwnsSession('free-agent'), { wrapper });
			expect(free.current).toBe(true);

			const { result: claimed } = renderHook(() => useWindowOwnsSession('claimed'), { wrapper });
			await waitFor(() => expect(claimed.current).toBe(false));
		});

		it('secondary window owns only its scoped agents', async () => {
			setUrl('/?windowId=win-2');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-2', sessionIds: ['a'], activeSessionId: 'a' })
			);

			const { result: owned } = renderHook(() => useWindowOwnsSession('a'), { wrapper });
			await waitFor(() => expect(owned.current).toBe(true));

			const { result: other } = renderHook(() => useWindowOwnsSession('b'), { wrapper });
			expect(other.current).toBe(false);
		});
	});
});
