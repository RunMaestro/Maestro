/**
 * Tests for WindowContext
 *
 * This module provides:
 * 1. WindowProvider - React context provider for multi-window state
 * 2. useWindow - Hook to access the window context API
 *
 * These tests focus on:
 * - Context provision behavior
 * - State initialization from main process
 * - Session management operations (open, close, move)
 * - Event handling for session changes
 * - Error boundary for context usage outside provider
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { WindowProvider, useWindow } from '../../../renderer/contexts/WindowContext';
import type { WindowState, WindowInfo } from '../../../shared/types/window';
import type { SessionsChangedEvent, SessionMovedEvent } from '../../../main/preload/windows';

// Mock the window.maestro.windows API
const mockWindowsApi = {
	getState: vi.fn(),
	getWindowId: vi.fn(),
	list: vi.fn(),
	getForSession: vi.fn(),
	focusWindow: vi.fn(),
	setSessionsForWindow: vi.fn(),
	setActiveSession: vi.fn(),
	create: vi.fn(),
	moveSession: vi.fn(),
	onSessionsChanged: vi.fn(),
	onSessionMoved: vi.fn(),
};

// Set up global mock
beforeEach(() => {
	vi.clearAllMocks();

	// Default mock implementations
	mockWindowsApi.getState.mockResolvedValue({
		id: 'window-1',
		x: 100,
		y: 100,
		width: 1200,
		height: 800,
		isMaximized: false,
		isFullScreen: false,
		sessionIds: ['session-1', 'session-2'],
		activeSessionId: 'session-1',
		leftPanelCollapsed: false,
		rightPanelCollapsed: false,
	} satisfies WindowState);

	mockWindowsApi.getWindowId.mockResolvedValue('window-1');

	mockWindowsApi.list.mockResolvedValue([
		{
			id: 'window-1',
			isMain: true,
			sessionIds: ['session-1', 'session-2'],
			activeSessionId: 'session-1',
		},
	] satisfies WindowInfo[]);

	mockWindowsApi.getForSession.mockResolvedValue(null);
	mockWindowsApi.focusWindow.mockResolvedValue({ success: true });
	mockWindowsApi.setSessionsForWindow.mockResolvedValue({ success: true });
	mockWindowsApi.setActiveSession.mockResolvedValue({ success: true });
	mockWindowsApi.create.mockResolvedValue({ windowId: 'window-2' });
	mockWindowsApi.moveSession.mockResolvedValue({ success: true });
	mockWindowsApi.onSessionsChanged.mockReturnValue(() => {});
	mockWindowsApi.onSessionMoved.mockReturnValue(() => {});

	// Assign to window object
	(window as unknown as { maestro: { windows: typeof mockWindowsApi } }).maestro = {
		windows: mockWindowsApi,
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('WindowContext', () => {
	describe('WindowProvider', () => {
		describe('rendering', () => {
			it('renders children correctly', async () => {
				render(
					<WindowProvider>
						<div data-testid="child">Test Child</div>
					</WindowProvider>
				);

				expect(screen.getByTestId('child')).toBeInTheDocument();
				expect(screen.getByText('Test Child')).toBeInTheDocument();
			});

			it('renders multiple children correctly', async () => {
				render(
					<WindowProvider>
						<div data-testid="child1">Child 1</div>
						<div data-testid="child2">Child 2</div>
					</WindowProvider>
				);

				expect(screen.getByTestId('child1')).toBeInTheDocument();
				expect(screen.getByTestId('child2')).toBeInTheDocument();
			});
		});

		describe('initialization', () => {
			it('loads window state from main process on mount', async () => {
				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				expect(mockWindowsApi.getState).toHaveBeenCalled();
				expect(result.current.windowId).toBe('window-1');
				expect(result.current.sessionIds).toEqual(['session-1', 'session-2']);
				expect(result.current.activeSessionId).toBe('session-1');
			});

			it('fetches window list to determine isMainWindow', async () => {
				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				expect(mockWindowsApi.list).toHaveBeenCalled();
				expect(result.current.isMainWindow).toBe(true);
			});

			it('handles null state gracefully', async () => {
				mockWindowsApi.getState.mockResolvedValue(null);
				mockWindowsApi.getWindowId.mockResolvedValue('window-fallback');

				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				expect(result.current.windowId).toBe('window-fallback');
			});

			it('handles errors during initialization', async () => {
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
				mockWindowsApi.getState.mockRejectedValue(new Error('IPC failed'));

				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				expect(consoleSpy).toHaveBeenCalledWith(
					'[WindowContext] Failed to load window state:',
					expect.any(Error)
				);

				consoleSpy.mockRestore();
			});
		});

		describe('context provision', () => {
			it('provides the window API to children', async () => {
				let contextValue: ReturnType<typeof useWindow> | null = null;

				const Consumer = () => {
					contextValue = useWindow();
					return <div>Consumer</div>;
				};

				render(
					<WindowProvider>
						<Consumer />
					</WindowProvider>
				);

				await waitFor(() => {
					expect(contextValue?.isLoaded).toBe(true);
				});

				expect(contextValue).not.toBeNull();
				expect(contextValue).toHaveProperty('windowId');
				expect(contextValue).toHaveProperty('isMainWindow');
				expect(contextValue).toHaveProperty('sessionIds');
				expect(contextValue).toHaveProperty('activeSessionId');
				expect(contextValue).toHaveProperty('openSession');
				expect(contextValue).toHaveProperty('closeTab');
				expect(contextValue).toHaveProperty('moveSessionToNewWindow');
				expect(contextValue).toHaveProperty('setActiveSession');
				expect(contextValue).toHaveProperty('refresh');
			});

			it('provides same API instance to multiple consumers', async () => {
				let contextValue1: ReturnType<typeof useWindow> | null = null;
				let contextValue2: ReturnType<typeof useWindow> | null = null;

				const Consumer1 = () => {
					contextValue1 = useWindow();
					return <div>Consumer 1</div>;
				};

				const Consumer2 = () => {
					contextValue2 = useWindow();
					return <div>Consumer 2</div>;
				};

				render(
					<WindowProvider>
						<Consumer1 />
						<Consumer2 />
					</WindowProvider>
				);

				await waitFor(() => {
					expect(contextValue1?.isLoaded).toBe(true);
				});

				expect(contextValue1).toBe(contextValue2);
			});
		});

		describe('session change events', () => {
			it('subscribes to session change events on mount', async () => {
				renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				expect(mockWindowsApi.onSessionsChanged).toHaveBeenCalled();
			});

			it('updates state when session change event is received for this window', async () => {
				let sessionChangeCallback: ((event: SessionsChangedEvent) => void) | null = null;
				mockWindowsApi.onSessionsChanged.mockImplementation((cb) => {
					sessionChangeCallback = cb;
					return () => {};
				});

				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				// Simulate session change event
				await act(async () => {
					sessionChangeCallback?.({
						windowId: 'window-1',
						sessionIds: ['session-1', 'session-3'],
						activeSessionId: 'session-3',
					});
				});

				expect(result.current.sessionIds).toEqual(['session-1', 'session-3']);
				expect(result.current.activeSessionId).toBe('session-3');
			});

			it('ignores session change events for other windows', async () => {
				let sessionChangeCallback: ((event: SessionsChangedEvent) => void) | null = null;
				mockWindowsApi.onSessionsChanged.mockImplementation((cb) => {
					sessionChangeCallback = cb;
					return () => {};
				});

				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				const initialSessionIds = result.current.sessionIds;

				// Simulate session change event for a different window
				await act(async () => {
					sessionChangeCallback?.({
						windowId: 'window-other',
						sessionIds: ['session-5', 'session-6'],
						activeSessionId: 'session-5',
					});
				});

				// State should not have changed
				expect(result.current.sessionIds).toEqual(initialSessionIds);
			});

			it('cleans up event listener on unmount', async () => {
				const cleanupFn = vi.fn();
				mockWindowsApi.onSessionsChanged.mockReturnValue(cleanupFn);

				const { unmount } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				unmount();

				expect(cleanupFn).toHaveBeenCalled();
			});
		});

		describe('session moved events', () => {
			it('subscribes to session moved events on mount', async () => {
				renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				expect(mockWindowsApi.onSessionMoved).toHaveBeenCalled();
			});

			it('refreshes state when session moved event is received', async () => {
				let sessionMovedCallback: ((event: SessionMovedEvent) => void) | null = null;
				mockWindowsApi.onSessionMoved.mockImplementation((cb) => {
					sessionMovedCallback = cb;
					return () => {};
				});

				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				// Clear the mock to track refresh call
				mockWindowsApi.getState.mockClear();

				// Simulate session moved event (any session moving between windows)
				await act(async () => {
					sessionMovedCallback?.({
						sessionId: 'session-1',
						fromWindowId: 'window-1',
						toWindowId: 'window-other',
					});
				});

				// Should trigger a refresh of window state
				await waitFor(() => {
					expect(mockWindowsApi.getState).toHaveBeenCalled();
				});
			});

			it('cleans up session moved event listener on unmount', async () => {
				const cleanupFn = vi.fn();
				mockWindowsApi.onSessionMoved.mockReturnValue(cleanupFn);

				const { unmount } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				unmount();

				expect(cleanupFn).toHaveBeenCalled();
			});
		});
	});

	describe('useWindow hook operations', () => {
		describe('openSession', () => {
			it('adds session to this window when not in another window', async () => {
				mockWindowsApi.getForSession.mockResolvedValue(null);

				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				let opened = false;
				await act(async () => {
					opened = await result.current.openSession('session-new');
				});

				expect(opened).toBe(true);
				expect(result.current.sessionIds).toContain('session-new');
				expect(result.current.activeSessionId).toBe('session-new');
				expect(mockWindowsApi.setSessionsForWindow).toHaveBeenCalled();
			});

			it('focuses other window when session is already open there', async () => {
				mockWindowsApi.getForSession.mockResolvedValue('window-other');

				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				let opened = false;
				await act(async () => {
					opened = await result.current.openSession('session-in-other');
				});

				expect(opened).toBe(false);
				expect(mockWindowsApi.focusWindow).toHaveBeenCalledWith('window-other');
			});

			it('makes existing session active when already in this window', async () => {
				mockWindowsApi.getForSession.mockResolvedValue(null);

				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				let opened = false;
				await act(async () => {
					opened = await result.current.openSession('session-2');
				});

				expect(opened).toBe(true);
				expect(result.current.activeSessionId).toBe('session-2');
				expect(mockWindowsApi.setActiveSession).toHaveBeenCalledWith('window-1', 'session-2');
			});
		});

		describe('closeTab', () => {
			it('removes session from this window', async () => {
				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				await act(async () => {
					await result.current.closeTab('session-2');
				});

				expect(result.current.sessionIds).not.toContain('session-2');
				expect(mockWindowsApi.setSessionsForWindow).toHaveBeenCalled();
			});

			it('updates active session when closing active tab', async () => {
				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				// session-1 is active
				expect(result.current.activeSessionId).toBe('session-1');

				await act(async () => {
					await result.current.closeTab('session-1');
				});

				// Should switch to next session
				expect(result.current.activeSessionId).toBe('session-2');
			});
		});

		describe('moveSessionToNewWindow', () => {
			it('creates new window and moves session to it', async () => {
				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				let newWindowId = '';
				await act(async () => {
					newWindowId = await result.current.moveSessionToNewWindow('session-1');
				});

				expect(newWindowId).toBe('window-2');
				expect(mockWindowsApi.create).toHaveBeenCalledWith({
					sessionIds: ['session-1'],
					activeSessionId: 'session-1',
				});
				expect(mockWindowsApi.moveSession).toHaveBeenCalledWith({
					sessionId: 'session-1',
					fromWindowId: 'window-1',
					toWindowId: 'window-2',
				});
			});
		});

		describe('setActiveSession', () => {
			it('sets active session when session is in this window', async () => {
				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				await act(async () => {
					await result.current.setActiveSession('session-2');
				});

				expect(result.current.activeSessionId).toBe('session-2');
				expect(mockWindowsApi.setActiveSession).toHaveBeenCalledWith('window-1', 'session-2');
			});

			it('logs warning when session is not in this window', async () => {
				const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				await act(async () => {
					await result.current.setActiveSession('session-not-in-window');
				});

				expect(consoleSpy).toHaveBeenCalledWith(
					'[WindowContext] Cannot set active session - session not in window'
				);
				expect(mockWindowsApi.setActiveSession).not.toHaveBeenCalled();

				consoleSpy.mockRestore();
			});
		});

		describe('refresh', () => {
			it('reloads window state from main process', async () => {
				const { result } = renderHook(() => useWindow(), {
					wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
				});

				await waitFor(() => {
					expect(result.current.isLoaded).toBe(true);
				});

				// Clear the mock to track new calls
				mockWindowsApi.getState.mockClear();

				// Update the mock to return different state
				mockWindowsApi.getState.mockResolvedValue({
					id: 'window-1',
					x: 100,
					y: 100,
					width: 1200,
					height: 800,
					isMaximized: false,
					isFullScreen: false,
					sessionIds: ['session-1', 'session-2', 'session-3'],
					activeSessionId: 'session-3',
					leftPanelCollapsed: false,
					rightPanelCollapsed: false,
				} satisfies WindowState);

				await act(async () => {
					await result.current.refresh();
				});

				expect(mockWindowsApi.getState).toHaveBeenCalled();
				expect(result.current.sessionIds).toEqual(['session-1', 'session-2', 'session-3']);
				expect(result.current.activeSessionId).toBe('session-3');
			});
		});
	});

	describe('useWindow hook (context wrapper)', () => {
		describe('outside provider', () => {
			it('throws an error when used outside WindowProvider', () => {
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

				expect(() => {
					renderHook(() => useWindow());
				}).toThrow('useWindow must be used within a WindowProvider');

				consoleSpy.mockRestore();
			});

			it('provides helpful error message', () => {
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

				let errorMessage = '';
				try {
					renderHook(() => useWindow());
				} catch (error) {
					errorMessage = (error as Error).message;
				}

				expect(errorMessage).toContain('WindowProvider');
				expect(errorMessage).toContain('useWindow');

				consoleSpy.mockRestore();
			});
		});

		describe('nested providers', () => {
			it('uses the closest provider', async () => {
				let innerContextValue: ReturnType<typeof useWindow> | null = null;

				const InnerConsumer = () => {
					innerContextValue = useWindow();
					return <div>Inner Consumer</div>;
				};

				render(
					<WindowProvider>
						<WindowProvider>
							<InnerConsumer />
						</WindowProvider>
					</WindowProvider>
				);

				await waitFor(() => {
					expect(innerContextValue?.isLoaded).toBe(true);
				});

				expect(innerContextValue).not.toBeNull();
				expect(innerContextValue).toHaveProperty('windowId');
			});
		});
	});

	describe('edge cases', () => {
		it('handles operations before window ID is loaded', async () => {
			// Make getState hang
			let resolveGetState: (value: WindowState) => void;
			mockWindowsApi.getState.mockReturnValue(
				new Promise((resolve) => {
					resolveGetState = resolve;
				})
			);

			const { result } = renderHook(() => useWindow(), {
				wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
			});

			// Window ID should be null initially
			expect(result.current.windowId).toBeNull();
			expect(result.current.isLoaded).toBe(false);

			// Operations should handle null windowId gracefully
			await act(async () => {
				await result.current.closeTab('session-1');
			});

			// setSessionsForWindow should not be called when windowId is null
			expect(mockWindowsApi.setSessionsForWindow).not.toHaveBeenCalled();
		});

		it('handles unmount during async operations', async () => {
			const { unmount } = renderHook(() => useWindow(), {
				wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
			});

			// Unmount before async completes
			unmount();

			// Should not throw
		});

		it('handles secondary window (not main)', async () => {
			mockWindowsApi.list.mockResolvedValue([
				{
					id: 'window-1',
					isMain: false,
					sessionIds: ['session-1'],
					activeSessionId: 'session-1',
				},
			] satisfies WindowInfo[]);

			const { result } = renderHook(() => useWindow(), {
				wrapper: ({ children }) => <WindowProvider>{children}</WindowProvider>,
			});

			await waitFor(() => {
				expect(result.current.isLoaded).toBe(true);
			});

			expect(result.current.isMainWindow).toBe(false);
		});
	});
});
