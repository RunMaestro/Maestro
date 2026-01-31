/**
 * Tests for UILayoutContext
 *
 * This module provides:
 * 1. UILayoutProvider - React context provider for UI layout state
 * 2. useUILayout - Hook to access the UI layout context API
 *
 * These tests focus on:
 * - Context provision behavior
 * - Panel state persistence (multi-window, GitHub issue #133)
 * - Panel state loading from multi-window store
 * - Sidebar and panel toggle operations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { UILayoutProvider, useUILayout } from '../../../renderer/contexts/UILayoutContext';

// Mock the window.maestro.windows API
const mockWindowsApi = {
	getPanelState: vi.fn(),
	setPanelState: vi.fn(),
};

// Set up global mock
beforeEach(() => {
	vi.clearAllMocks();

	// Default mock implementations
	mockWindowsApi.getPanelState.mockResolvedValue({
		leftPanelCollapsed: false,
		rightPanelCollapsed: false,
	});
	mockWindowsApi.setPanelState.mockResolvedValue({ success: true });

	// Assign to window object
	(window as unknown as { maestro: { windows: typeof mockWindowsApi } }).maestro = {
		windows: mockWindowsApi,
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('UILayoutContext', () => {
	describe('UILayoutProvider', () => {
		describe('rendering', () => {
			it('renders children correctly', async () => {
				render(
					<UILayoutProvider>
						<div data-testid="child">Test Child</div>
					</UILayoutProvider>
				);

				expect(screen.getByTestId('child')).toBeInTheDocument();
				expect(screen.getByText('Test Child')).toBeInTheDocument();
			});
		});

		describe('panel state persistence (GitHub issue #133)', () => {
			it('loads panel state from multi-window store on mount', async () => {
				mockWindowsApi.getPanelState.mockResolvedValue({
					leftPanelCollapsed: true,
					rightPanelCollapsed: false,
				});

				const { result } = renderHook(() => useUILayout(), {
					wrapper: ({ children }) => <UILayoutProvider>{children}</UILayoutProvider>,
				});

				// Wait for panel state to load
				await waitFor(() => {
					expect(mockWindowsApi.getPanelState).toHaveBeenCalled();
				});

				// leftPanelCollapsed=true means leftSidebarOpen=false
				await waitFor(() => {
					expect(result.current.leftSidebarOpen).toBe(false);
				});
				expect(result.current.rightPanelOpen).toBe(true);
			});

			it('restores both panels collapsed from persisted state', async () => {
				mockWindowsApi.getPanelState.mockResolvedValue({
					leftPanelCollapsed: true,
					rightPanelCollapsed: true,
				});

				const { result } = renderHook(() => useUILayout(), {
					wrapper: ({ children }) => <UILayoutProvider>{children}</UILayoutProvider>,
				});

				await waitFor(() => {
					expect(result.current.leftSidebarOpen).toBe(false);
					expect(result.current.rightPanelOpen).toBe(false);
				});
			});

			it('restores both panels open from persisted state', async () => {
				mockWindowsApi.getPanelState.mockResolvedValue({
					leftPanelCollapsed: false,
					rightPanelCollapsed: false,
				});

				const { result } = renderHook(() => useUILayout(), {
					wrapper: ({ children }) => <UILayoutProvider>{children}</UILayoutProvider>,
				});

				await waitFor(() => {
					expect(mockWindowsApi.getPanelState).toHaveBeenCalled();
				});

				// Default values are true, persisted state should confirm them
				expect(result.current.leftSidebarOpen).toBe(true);
				expect(result.current.rightPanelOpen).toBe(true);
			});

			it('persists panel state when left sidebar is toggled', async () => {
				const { result } = renderHook(() => useUILayout(), {
					wrapper: ({ children }) => <UILayoutProvider>{children}</UILayoutProvider>,
				});

				// Wait for initial load
				await waitFor(() => {
					expect(mockWindowsApi.getPanelState).toHaveBeenCalled();
				});

				// Clear mock to track new calls
				mockWindowsApi.setPanelState.mockClear();

				// Toggle left sidebar (open -> closed)
				act(() => {
					result.current.toggleLeftSidebar();
				});

				// Wait for persistence
				await waitFor(() => {
					expect(mockWindowsApi.setPanelState).toHaveBeenCalledWith({
						leftPanelCollapsed: true,
						rightPanelCollapsed: false,
					});
				});
			});

			it('persists panel state when right panel is toggled', async () => {
				const { result } = renderHook(() => useUILayout(), {
					wrapper: ({ children }) => <UILayoutProvider>{children}</UILayoutProvider>,
				});

				// Wait for initial load
				await waitFor(() => {
					expect(mockWindowsApi.getPanelState).toHaveBeenCalled();
				});

				// Clear mock to track new calls
				mockWindowsApi.setPanelState.mockClear();

				// Toggle right panel (open -> closed)
				act(() => {
					result.current.toggleRightPanel();
				});

				// Wait for persistence
				await waitFor(() => {
					expect(mockWindowsApi.setPanelState).toHaveBeenCalledWith({
						leftPanelCollapsed: false,
						rightPanelCollapsed: true,
					});
				});
			});

			it('persists panel state when setting left sidebar directly', async () => {
				const { result } = renderHook(() => useUILayout(), {
					wrapper: ({ children }) => <UILayoutProvider>{children}</UILayoutProvider>,
				});

				// Wait for initial load
				await waitFor(() => {
					expect(mockWindowsApi.getPanelState).toHaveBeenCalled();
				});

				// Clear mock to track new calls
				mockWindowsApi.setPanelState.mockClear();

				// Close left sidebar directly
				act(() => {
					result.current.setLeftSidebarOpen(false);
				});

				// Wait for persistence
				await waitFor(() => {
					expect(mockWindowsApi.setPanelState).toHaveBeenCalledWith({
						leftPanelCollapsed: true,
						rightPanelCollapsed: false,
					});
				});
			});

			it('persists panel state when setting right panel directly', async () => {
				const { result } = renderHook(() => useUILayout(), {
					wrapper: ({ children }) => <UILayoutProvider>{children}</UILayoutProvider>,
				});

				// Wait for initial load
				await waitFor(() => {
					expect(mockWindowsApi.getPanelState).toHaveBeenCalled();
				});

				// Clear mock to track new calls
				mockWindowsApi.setPanelState.mockClear();

				// Close right panel directly
				act(() => {
					result.current.setRightPanelOpen(false);
				});

				// Wait for persistence
				await waitFor(() => {
					expect(mockWindowsApi.setPanelState).toHaveBeenCalledWith({
						leftPanelCollapsed: false,
						rightPanelCollapsed: true,
					});
				});
			});

			it('handles null panel state from store gracefully', async () => {
				mockWindowsApi.getPanelState.mockResolvedValue(null);

				const { result } = renderHook(() => useUILayout(), {
					wrapper: ({ children }) => <UILayoutProvider>{children}</UILayoutProvider>,
				});

				await waitFor(() => {
					expect(mockWindowsApi.getPanelState).toHaveBeenCalled();
				});

				// Should use defaults when null
				expect(result.current.leftSidebarOpen).toBe(true);
				expect(result.current.rightPanelOpen).toBe(true);
			});

			it('handles error during panel state load gracefully', async () => {
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
				mockWindowsApi.getPanelState.mockRejectedValue(new Error('IPC failed'));

				const { result } = renderHook(() => useUILayout(), {
					wrapper: ({ children }) => <UILayoutProvider>{children}</UILayoutProvider>,
				});

				await waitFor(() => {
					expect(consoleSpy).toHaveBeenCalledWith(
						'[UILayoutContext] Failed to load panel state:',
						expect.any(Error)
					);
				});

				// Should use defaults on error
				expect(result.current.leftSidebarOpen).toBe(true);
				expect(result.current.rightPanelOpen).toBe(true);

				consoleSpy.mockRestore();
			});

			it('handles error during panel state persistence gracefully', async () => {
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
				mockWindowsApi.setPanelState.mockRejectedValue(new Error('IPC failed'));

				const { result } = renderHook(() => useUILayout(), {
					wrapper: ({ children }) => <UILayoutProvider>{children}</UILayoutProvider>,
				});

				// Wait for initial load
				await waitFor(() => {
					expect(mockWindowsApi.getPanelState).toHaveBeenCalled();
				});

				// Toggle should still work even if persistence fails
				act(() => {
					result.current.toggleLeftSidebar();
				});

				await waitFor(() => {
					expect(consoleSpy).toHaveBeenCalledWith(
						'[UILayoutContext] Failed to persist panel state:',
						expect.any(Error)
					);
				});

				// State should still be updated locally
				expect(result.current.leftSidebarOpen).toBe(false);

				consoleSpy.mockRestore();
			});

			it('does not persist before initial load completes', async () => {
				// Make getPanelState hang
				let resolveGetPanelState: (value: {
					leftPanelCollapsed: boolean;
					rightPanelCollapsed: boolean;
				}) => void;
				mockWindowsApi.getPanelState.mockReturnValue(
					new Promise((resolve) => {
						resolveGetPanelState = resolve;
					})
				);

				const { result } = renderHook(() => useUILayout(), {
					wrapper: ({ children }) => <UILayoutProvider>{children}</UILayoutProvider>,
				});

				// Initial values should be true (defaults)
				expect(result.current.leftSidebarOpen).toBe(true);

				// Toggle before load completes
				act(() => {
					result.current.toggleLeftSidebar();
				});

				// setPanelState should NOT be called before load completes
				expect(mockWindowsApi.setPanelState).not.toHaveBeenCalled();

				// Now complete the load
				await act(async () => {
					resolveGetPanelState!({
						leftPanelCollapsed: false,
						rightPanelCollapsed: false,
					});
				});

				// Now that load is complete, toggle again
				mockWindowsApi.setPanelState.mockClear();
				act(() => {
					result.current.toggleRightPanel();
				});

				// Now setPanelState should be called
				await waitFor(() => {
					expect(mockWindowsApi.setPanelState).toHaveBeenCalled();
				});
			});
		});

		describe('context provision', () => {
			it('provides the UI layout API to children', async () => {
				let contextValue: ReturnType<typeof useUILayout> | null = null;

				const Consumer = () => {
					contextValue = useUILayout();
					return <div>Consumer</div>;
				};

				render(
					<UILayoutProvider>
						<Consumer />
					</UILayoutProvider>
				);

				expect(contextValue).not.toBeNull();
				expect(contextValue).toHaveProperty('leftSidebarOpen');
				expect(contextValue).toHaveProperty('setLeftSidebarOpen');
				expect(contextValue).toHaveProperty('toggleLeftSidebar');
				expect(contextValue).toHaveProperty('rightPanelOpen');
				expect(contextValue).toHaveProperty('setRightPanelOpen');
				expect(contextValue).toHaveProperty('toggleRightPanel');
			});
		});
	});

	describe('useUILayout hook', () => {
		describe('outside provider', () => {
			it('throws an error when used outside UILayoutProvider', () => {
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

				expect(() => {
					renderHook(() => useUILayout());
				}).toThrow('useUILayout must be used within a UILayoutProvider');

				consoleSpy.mockRestore();
			});
		});
	});
});
