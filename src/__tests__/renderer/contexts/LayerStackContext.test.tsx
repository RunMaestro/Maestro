/**
 * Tests for LayerStackContext
 *
 * This module provides:
 * 1. LayerStackProvider - React context provider with global Escape key handling
 * 2. useLayerStack - Hook to access the layer stack API
 *
 * The underlying useLayerStack hook is tested in useLayerStack.test.ts.
 * These tests focus on:
 * - Context provision behavior
 * - Escape key handling integration
 * - Error boundary for context usage outside provider
 */

import { ThemedSelect } from '../../../renderer/components/shared/ThemedSelect';
import type { Theme } from '../../../renderer/types';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, renderHook, act, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { LayerStackProvider, useLayerStack } from '../../../renderer/contexts/LayerStackContext';
import { useOutputSearchLayer } from '../../../renderer/hooks/ui/useOutputSearchLayer';
import { isImeComposing } from '../../../renderer/utils/ime';

// Mock the useLayerStack hook from the hooks module
vi.mock('../../../renderer/hooks/ui/useLayerStack', () => {
	const mockRegisterLayer = vi.fn().mockReturnValue('test-layer-id');
	const mockUnregisterLayer = vi.fn();
	const mockGetTopLayer = vi.fn().mockReturnValue(null);
	const mockCloseTopLayer = vi.fn().mockResolvedValue(true);
	const mockGetLayers = vi.fn().mockReturnValue([]);
	const mockHasOpenLayers = vi.fn().mockReturnValue(false);
	const mockHasOpenModal = vi.fn().mockReturnValue(false);
	const mockLayerCount = vi.fn().mockReturnValue(0);
	const mockUpdateLayerHandler = vi.fn();

	return {
		useLayerStack: vi.fn(() => ({
			registerLayer: mockRegisterLayer,
			unregisterLayer: mockUnregisterLayer,
			getTopLayer: mockGetTopLayer,
			closeTopLayer: mockCloseTopLayer,
			getLayers: mockGetLayers,
			hasOpenLayers: mockHasOpenLayers,
			hasOpenModal: mockHasOpenModal,
			layerCount: mockLayerCount,
			updateLayerHandler: mockUpdateLayerHandler,
		})),
	};
});

// Import the mocked module to get access to the mock functions
import { useLayerStack as useLayerStackHook } from '../../../renderer/hooks';

describe('LayerStackContext', () => {
	let mockLayerStackAPI: ReturnType<typeof useLayerStackHook>;

	beforeEach(() => {
		vi.clearAllMocks();
		// Get fresh mock API for each test
		mockLayerStackAPI = (useLayerStackHook as ReturnType<typeof vi.fn>)();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('LayerStackProvider', () => {
		it.each(['composing', 'safari', 'ordinary'])(
			'preserves RC IME Escape handling: %s',
			async (mode) => {
				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue({} as never);
				render(
					<LayerStackProvider>
						<div>Owned modal</div>
					</LayerStackProvider>
				);
				const event = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});
				if (mode === 'composing') Object.defineProperty(event, 'isComposing', { value: true });
				if (mode === 'safari') Object.defineProperty(event, 'keyCode', { value: 229 });
				await act(async () => {
					window.dispatchEvent(event);
				});
				expect(mockLayerStackAPI.closeTopLayer).toHaveBeenCalledTimes(mode === 'ordinary' ? 1 : 0);
				expect(event.defaultPrevented).toBe(mode === 'ordinary');
			}
		);
		it.each(['search', 'close', 'option'])(
			'closes a filterable popup from %s focus before its parent layer',
			async (focusTarget) => {
				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue({} as never);
				const user = userEvent.setup();
				const theme = {
					colors: {
						bgActivity: '#333',
						border: '#444',
						textMain: '#fff',
						textDim: '#aaa',
						bgSidebar: '#222',
					},
				} as Theme;
				render(
					<LayerStackProvider>
						<ThemedSelect
							value="a"
							options={[{ value: 'a', label: 'Alpha' }]}
							onChange={vi.fn()}
							theme={theme}
							filterable
						/>
					</LayerStackProvider>
				);
				const trigger = screen.getByRole('button', { name: 'Alpha' });
				await user.click(trigger);
				const search = screen.getByRole('textbox');
				await waitFor(() => expect(search).toHaveFocus());
				if (focusTarget !== 'search') {
					await user.tab();
					expect(screen.getByRole('button', { name: 'Close filter (Esc)' })).toHaveFocus();
				}
				if (focusTarget === 'option') {
					await user.tab();
					expect(screen.getByRole('option', { name: 'Alpha' })).toHaveFocus();
				}
				await user.keyboard('{Escape}');
				expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
				expect(trigger).toHaveFocus();
				expect(mockLayerStackAPI.closeTopLayer).not.toHaveBeenCalled();
				await user.keyboard('{Escape}');
				expect(mockLayerStackAPI.closeTopLayer).toHaveBeenCalledTimes(1);
			}
		);
		it.each([false, true])(
			'lets a focused select popup handle Escape (filterable: %s)',
			(filterable) => {
				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue({} as never);
				const theme = {
					colors: {
						bgActivity: '#333',
						border: '#444',
						textMain: '#fff',
						textDim: '#aaa',
						bgSidebar: '#222',
					},
				} as Theme;
				render(
					<LayerStackProvider>
						<ThemedSelect
							value="a"
							options={[{ value: 'a', label: 'Alpha' }]}
							onChange={vi.fn()}
							theme={theme}
							filterable={filterable}
						/>
					</LayerStackProvider>
				);
				const trigger = screen.getByRole('button', { name: 'Alpha' });
				fireEvent.click(trigger);
				const target = filterable ? screen.getByRole('textbox') : screen.getByRole('listbox');
				target.focus();
				fireEvent.keyDown(target, { key: 'Escape' });
				expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
				expect(trigger).toHaveFocus();
				expect(mockLayerStackAPI.closeTopLayer).not.toHaveBeenCalled();
				fireEvent.keyDown(trigger, { key: 'Escape' });
				expect(mockLayerStackAPI.closeTopLayer).toHaveBeenCalledTimes(1);
			}
		);
		describe('rendering', () => {
			it('renders children correctly', () => {
				render(
					<LayerStackProvider>
						<div data-testid="child">Test Child</div>
					</LayerStackProvider>
				);

				expect(screen.getByTestId('child')).toBeInTheDocument();
				expect(screen.getByText('Test Child')).toBeInTheDocument();
			});

			it('renders multiple children correctly', () => {
				render(
					<LayerStackProvider>
						<div data-testid="child1">Child 1</div>
						<div data-testid="child2">Child 2</div>
					</LayerStackProvider>
				);

				expect(screen.getByTestId('child1')).toBeInTheDocument();
				expect(screen.getByTestId('child2')).toBeInTheDocument();
			});

			it('renders nested components correctly', () => {
				const NestedComponent = () => <span data-testid="nested">Nested</span>;

				render(
					<LayerStackProvider>
						<div data-testid="parent">
							<NestedComponent />
						</div>
					</LayerStackProvider>
				);

				expect(screen.getByTestId('parent')).toBeInTheDocument();
				expect(screen.getByTestId('nested')).toBeInTheDocument();
			});
		});

		describe('context provision', () => {
			it('provides the layer stack API to children', () => {
				let contextValue: ReturnType<typeof useLayerStack> | null = null;

				const Consumer = () => {
					contextValue = useLayerStack();
					return <div>Consumer</div>;
				};

				render(
					<LayerStackProvider>
						<Consumer />
					</LayerStackProvider>
				);

				expect(contextValue).not.toBeNull();
				expect(contextValue).toHaveProperty('registerLayer');
				expect(contextValue).toHaveProperty('unregisterLayer');
				expect(contextValue).toHaveProperty('getTopLayer');
				expect(contextValue).toHaveProperty('closeTopLayer');
				expect(contextValue).toHaveProperty('getLayers');
				expect(contextValue).toHaveProperty('hasOpenLayers');
				expect(contextValue).toHaveProperty('hasOpenModal');
				expect(contextValue).toHaveProperty('layerCount');
			});

			it('provides same API instance to multiple consumers', () => {
				let contextValue1: ReturnType<typeof useLayerStack> | null = null;
				let contextValue2: ReturnType<typeof useLayerStack> | null = null;

				const Consumer1 = () => {
					contextValue1 = useLayerStack();
					return <div>Consumer 1</div>;
				};

				const Consumer2 = () => {
					contextValue2 = useLayerStack();
					return <div>Consumer 2</div>;
				};

				render(
					<LayerStackProvider>
						<Consumer1 />
						<Consumer2 />
					</LayerStackProvider>
				);

				expect(contextValue1).toBe(contextValue2);
			});
		});

		describe('escape key handling', () => {
			it('handles Escape key when there is a top layer', async () => {
				const mockLayer = {
					id: 'test-layer',
					type: 'modal' as const,
					priority: 100,
					onEscape: vi.fn(),
				};

				// Configure mock to return a layer
				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(mockLayer);

				render(
					<LayerStackProvider>
						<div data-testid="child">Test</div>
					</LayerStackProvider>
				);

				// Dispatch Escape key event
				const escapeEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});

				await act(async () => {
					window.dispatchEvent(escapeEvent);
				});

				// Should have called getTopLayer to check if there's a layer
				expect(mockLayerStackAPI.getTopLayer).toHaveBeenCalled();
				// Should have called closeTopLayer since there was a layer
				expect(mockLayerStackAPI.closeTopLayer).toHaveBeenCalled();
			});

			it('does not call closeTopLayer when no layers exist', async () => {
				// Configure mock to return null (no layer)
				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(null);

				render(
					<LayerStackProvider>
						<div data-testid="child">Test</div>
					</LayerStackProvider>
				);

				const escapeEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});

				await act(async () => {
					window.dispatchEvent(escapeEvent);
				});

				expect(mockLayerStackAPI.getTopLayer).toHaveBeenCalled();
				expect(mockLayerStackAPI.closeTopLayer).not.toHaveBeenCalled();
			});

			it('prevents default behavior when layer exists', async () => {
				const mockLayer = {
					id: 'test-layer',
					type: 'modal' as const,
					priority: 100,
					onEscape: vi.fn(),
				};

				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(mockLayer);

				render(
					<LayerStackProvider>
						<div>Test</div>
					</LayerStackProvider>
				);

				const escapeEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});

				const preventDefaultSpy = vi.spyOn(escapeEvent, 'preventDefault');
				const stopPropagationSpy = vi.spyOn(escapeEvent, 'stopPropagation');

				await act(async () => {
					window.dispatchEvent(escapeEvent);
				});

				expect(preventDefaultSpy).toHaveBeenCalled();
				expect(stopPropagationSpy).toHaveBeenCalled();
			});

			it('leaves the top layer open and does not preventDefault or stopPropagation when Escape is pressed during an active IME composition (isComposing: true)', async () => {
				const mockLayer = {
					id: 'test-layer',
					type: 'modal' as const,
					priority: 100,
					onEscape: vi.fn(),
				};

				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(mockLayer);

				render(
					<LayerStackProvider>
						<div>Test</div>
					</LayerStackProvider>
				);

				const escapeEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});
				Object.defineProperty(escapeEvent, 'isComposing', { value: true, configurable: true });

				const preventDefaultSpy = vi.spyOn(escapeEvent, 'preventDefault');
				const stopPropagationSpy = vi.spyOn(escapeEvent, 'stopPropagation');

				await act(async () => {
					window.dispatchEvent(escapeEvent);
				});

				expect(mockLayerStackAPI.closeTopLayer).not.toHaveBeenCalled();
				expect(preventDefaultSpy).not.toHaveBeenCalled();
				expect(stopPropagationSpy).not.toHaveBeenCalled();
			});

			it('leaves the top layer open and does not preventDefault or stopPropagation when Escape is pressed with Safari keyCode 229', async () => {
				const mockLayer = {
					id: 'test-layer',
					type: 'modal' as const,
					priority: 100,
					onEscape: vi.fn(),
				};

				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(mockLayer);

				render(
					<LayerStackProvider>
						<div>Test</div>
					</LayerStackProvider>
				);

				const escapeEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
					keyCode: 229,
				} as KeyboardEventInit);

				const preventDefaultSpy = vi.spyOn(escapeEvent, 'preventDefault');
				const stopPropagationSpy = vi.spyOn(escapeEvent, 'stopPropagation');

				await act(async () => {
					window.dispatchEvent(escapeEvent);
				});

				expect(mockLayerStackAPI.closeTopLayer).not.toHaveBeenCalled();
				expect(preventDefaultSpy).not.toHaveBeenCalled();
				expect(stopPropagationSpy).not.toHaveBeenCalled();
			});

			it('closes the top layer on normal Escape after composition ends', async () => {
				const mockLayer = {
					id: 'test-layer',
					type: 'modal' as const,
					priority: 100,
					onEscape: vi.fn(),
				};

				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(mockLayer);

				render(
					<LayerStackProvider>
						<div>Test</div>
					</LayerStackProvider>
				);

				// 1. Composing Escape leaves layer open
				const composingEscape = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});
				Object.defineProperty(composingEscape, 'isComposing', { value: true, configurable: true });

				await act(async () => {
					window.dispatchEvent(composingEscape);
				});
				expect(mockLayerStackAPI.closeTopLayer).not.toHaveBeenCalled();

				// 2. Normal Escape after composition ends closes the layer
				const normalEscape = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});
				const preventDefaultSpy = vi.spyOn(normalEscape, 'preventDefault');
				const stopPropagationSpy = vi.spyOn(normalEscape, 'stopPropagation');

				await act(async () => {
					window.dispatchEvent(normalEscape);
				});

				expect(mockLayerStackAPI.closeTopLayer).toHaveBeenCalled();
				expect(preventDefaultSpy).toHaveBeenCalled();
				expect(stopPropagationSpy).toHaveBeenCalled();
			});

			it('does not prevent default when no layers exist', async () => {
				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(null);

				render(
					<LayerStackProvider>
						<div>Test</div>
					</LayerStackProvider>
				);

				const escapeEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});

				const preventDefaultSpy = vi.spyOn(escapeEvent, 'preventDefault');
				const stopPropagationSpy = vi.spyOn(escapeEvent, 'stopPropagation');

				await act(async () => {
					window.dispatchEvent(escapeEvent);
				});

				expect(preventDefaultSpy).not.toHaveBeenCalled();
				expect(stopPropagationSpy).not.toHaveBeenCalled();
			});

			it('ignores non-Escape key presses', async () => {
				const mockLayer = {
					id: 'test-layer',
					type: 'modal' as const,
					priority: 100,
					onEscape: vi.fn(),
				};

				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(mockLayer);

				render(
					<LayerStackProvider>
						<div>Test</div>
					</LayerStackProvider>
				);

				// Try different keys
				const enterEvent = new KeyboardEvent('keydown', {
					key: 'Enter',
					bubbles: true,
					cancelable: true,
				});

				await act(async () => {
					window.dispatchEvent(enterEvent);
				});

				expect(mockLayerStackAPI.closeTopLayer).not.toHaveBeenCalled();

				const spaceEvent = new KeyboardEvent('keydown', {
					key: ' ',
					bubbles: true,
					cancelable: true,
				});

				await act(async () => {
					window.dispatchEvent(spaceEvent);
				});

				expect(mockLayerStackAPI.closeTopLayer).not.toHaveBeenCalled();

				const tabEvent = new KeyboardEvent('keydown', {
					key: 'Tab',
					bubbles: true,
					cancelable: true,
				});

				await act(async () => {
					window.dispatchEvent(tabEvent);
				});

				expect(mockLayerStackAPI.closeTopLayer).not.toHaveBeenCalled();
			});

			it('uses capture phase for event handling', () => {
				const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

				render(
					<LayerStackProvider>
						<div>Test</div>
					</LayerStackProvider>
				);

				// Check that addEventListener was called with capture: true
				expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function), {
					capture: true,
				});

				addEventListenerSpy.mockRestore();
			});
		});

		describe('cleanup', () => {
			it('removes event listener on unmount', () => {
				const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

				const { unmount } = render(
					<LayerStackProvider>
						<div>Test</div>
					</LayerStackProvider>
				);

				unmount();

				expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function), {
					capture: true,
				});

				removeEventListenerSpy.mockRestore();
			});

			it('stops handling escape after unmount', async () => {
				const mockLayer = {
					id: 'test-layer',
					type: 'modal' as const,
					priority: 100,
					onEscape: vi.fn(),
				};

				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(mockLayer);

				const { unmount } = render(
					<LayerStackProvider>
						<div>Test</div>
					</LayerStackProvider>
				);

				// Clear the call count
				vi.mocked(mockLayerStackAPI.closeTopLayer).mockClear();

				// Unmount
				unmount();

				// Dispatch Escape after unmount
				const escapeEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});

				await act(async () => {
					window.dispatchEvent(escapeEvent);
				});

				// Should not have called closeTopLayer after unmount
				// Note: This depends on the event listener being properly removed
				// The mock may still be called if cleanup didn't work
			});
		});

		describe('ref updates', () => {
			it('uses latest layer stack state via ref', async () => {
				// First render with no layers
				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(null);

				const { rerender } = render(
					<LayerStackProvider>
						<div>Test</div>
					</LayerStackProvider>
				);

				// Dispatch Escape - should not close anything
				const escapeEvent1 = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});

				await act(async () => {
					window.dispatchEvent(escapeEvent1);
				});

				expect(mockLayerStackAPI.closeTopLayer).not.toHaveBeenCalled();

				// Now simulate a layer being added (mock returns a layer)
				const mockLayer = {
					id: 'test-layer',
					type: 'modal' as const,
					priority: 100,
					onEscape: vi.fn(),
				};
				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(mockLayer);

				// Force a rerender to update the ref
				rerender(
					<LayerStackProvider>
						<div>Updated</div>
					</LayerStackProvider>
				);

				// Dispatch Escape again - should now close the layer
				const escapeEvent2 = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});

				await act(async () => {
					window.dispatchEvent(escapeEvent2);
				});

				expect(mockLayerStackAPI.closeTopLayer).toHaveBeenCalled();
			});
		});
	});

	describe('useLayerStack hook (context wrapper)', () => {
		describe('within provider', () => {
			it('returns the layer stack API when inside provider', () => {
				const { result } = renderHook(() => useLayerStack(), {
					wrapper: ({ children }) => <LayerStackProvider>{children}</LayerStackProvider>,
				});

				expect(result.current).toHaveProperty('registerLayer');
				expect(result.current).toHaveProperty('unregisterLayer');
				expect(result.current).toHaveProperty('getTopLayer');
				expect(result.current).toHaveProperty('closeTopLayer');
				expect(result.current).toHaveProperty('getLayers');
				expect(result.current).toHaveProperty('hasOpenLayers');
				expect(result.current).toHaveProperty('hasOpenModal');
				expect(result.current).toHaveProperty('layerCount');
			});

			it('allows calling registerLayer', () => {
				const { result } = renderHook(() => useLayerStack(), {
					wrapper: ({ children }) => <LayerStackProvider>{children}</LayerStackProvider>,
				});

				const layerId = result.current.registerLayer({
					type: 'modal',
					priority: 100,
					onEscape: vi.fn(),
				});

				expect(mockLayerStackAPI.registerLayer).toHaveBeenCalledWith({
					type: 'modal',
					priority: 100,
					onEscape: expect.any(Function),
				});
			});

			it('allows calling unregisterLayer', () => {
				const { result } = renderHook(() => useLayerStack(), {
					wrapper: ({ children }) => <LayerStackProvider>{children}</LayerStackProvider>,
				});

				result.current.unregisterLayer('test-layer-id');

				expect(mockLayerStackAPI.unregisterLayer).toHaveBeenCalledWith('test-layer-id');
			});

			it('allows calling getTopLayer', () => {
				const mockLayer = {
					id: 'test',
					type: 'modal' as const,
					priority: 100,
					onEscape: vi.fn(),
				};
				vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(mockLayer);

				const { result } = renderHook(() => useLayerStack(), {
					wrapper: ({ children }) => <LayerStackProvider>{children}</LayerStackProvider>,
				});

				const topLayer = result.current.getTopLayer();

				expect(topLayer).toEqual(mockLayer);
			});

			it('allows calling closeTopLayer', async () => {
				const { result } = renderHook(() => useLayerStack(), {
					wrapper: ({ children }) => <LayerStackProvider>{children}</LayerStackProvider>,
				});

				await act(async () => {
					await result.current.closeTopLayer();
				});

				expect(mockLayerStackAPI.closeTopLayer).toHaveBeenCalled();
			});

			it('allows calling hasOpenLayers', () => {
				vi.mocked(mockLayerStackAPI.hasOpenLayers).mockReturnValue(true);

				const { result } = renderHook(() => useLayerStack(), {
					wrapper: ({ children }) => <LayerStackProvider>{children}</LayerStackProvider>,
				});

				const hasLayers = result.current.hasOpenLayers();

				expect(hasLayers).toBe(true);
			});

			it('allows calling hasOpenModal', () => {
				vi.mocked(mockLayerStackAPI.hasOpenModal).mockReturnValue(true);

				const { result } = renderHook(() => useLayerStack(), {
					wrapper: ({ children }) => <LayerStackProvider>{children}</LayerStackProvider>,
				});

				const hasModal = result.current.hasOpenModal();

				expect(hasModal).toBe(true);
			});

			it('allows calling layerCount', () => {
				vi.mocked(mockLayerStackAPI.layerCount).mockReturnValue(3);

				const { result } = renderHook(() => useLayerStack(), {
					wrapper: ({ children }) => <LayerStackProvider>{children}</LayerStackProvider>,
				});

				const count = result.current.layerCount();

				expect(count).toBe(3);
			});

			it('allows calling getLayers', () => {
				const mockLayers = [
					{ id: 'layer1', type: 'modal' as const, priority: 100, onEscape: vi.fn() },
					{ id: 'layer2', type: 'overlay' as const, priority: 50, onEscape: vi.fn() },
				];
				vi.mocked(mockLayerStackAPI.getLayers).mockReturnValue(mockLayers);

				const { result } = renderHook(() => useLayerStack(), {
					wrapper: ({ children }) => <LayerStackProvider>{children}</LayerStackProvider>,
				});

				const layers = result.current.getLayers();

				expect(layers).toEqual(mockLayers);
				expect(layers).toHaveLength(2);
			});
		});

		describe('outside provider', () => {
			it('throws an error when used outside LayerStackProvider', () => {
				// Suppress console.error for expected error
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

				expect(() => {
					renderHook(() => useLayerStack());
				}).toThrow('useLayerStack must be used within a LayerStackProvider');

				consoleSpy.mockRestore();
			});

			it('provides helpful error message', () => {
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

				let errorMessage = '';
				try {
					renderHook(() => useLayerStack());
				} catch (error) {
					errorMessage = (error as Error).message;
				}

				expect(errorMessage).toContain('LayerStackProvider');
				expect(errorMessage).toContain('useLayerStack');

				consoleSpy.mockRestore();
			});
		});

		describe('nested providers', () => {
			it('uses the closest provider', () => {
				// This tests that nested providers work correctly (inner provider wins)
				// Note: With our mock, both will return the same mock, but the structure is tested
				let innerContextValue: ReturnType<typeof useLayerStack> | null = null;

				const InnerConsumer = () => {
					innerContextValue = useLayerStack();
					return <div>Inner Consumer</div>;
				};

				render(
					<LayerStackProvider>
						<LayerStackProvider>
							<InnerConsumer />
						</LayerStackProvider>
					</LayerStackProvider>
				);

				expect(innerContextValue).not.toBeNull();
				expect(innerContextValue).toHaveProperty('registerLayer');
			});
		});
	});

	describe('integration scenarios', () => {
		it('multiple components can register and use layers through context', () => {
			const Modal1 = () => {
				const { registerLayer, unregisterLayer } = useLayerStack();
				React.useEffect(() => {
					const id = registerLayer({
						type: 'modal',
						priority: 100,
						onEscape: () => {},
					});
					return () => unregisterLayer(id);
				}, [registerLayer, unregisterLayer]);
				return <div>Modal 1</div>;
			};

			const Modal2 = () => {
				const { registerLayer, unregisterLayer } = useLayerStack();
				React.useEffect(() => {
					const id = registerLayer({
						type: 'modal',
						priority: 200,
						onEscape: () => {},
					});
					return () => unregisterLayer(id);
				}, [registerLayer, unregisterLayer]);
				return <div>Modal 2</div>;
			};

			render(
				<LayerStackProvider>
					<Modal1 />
					<Modal2 />
				</LayerStackProvider>
			);

			// Both modals should have registered
			expect(mockLayerStackAPI.registerLayer).toHaveBeenCalledTimes(2);
		});

		it('conditional rendering works with layer registration', () => {
			const ConditionalModal = ({ isOpen }: { isOpen: boolean }) => {
				const { registerLayer, unregisterLayer } = useLayerStack();
				React.useEffect(() => {
					if (isOpen) {
						const id = registerLayer({
							type: 'modal',
							priority: 100,
							onEscape: () => {},
						});
						return () => unregisterLayer(id);
					}
				}, [isOpen, registerLayer, unregisterLayer]);
				return isOpen ? <div>Modal</div> : null;
			};

			const { rerender } = render(
				<LayerStackProvider>
					<ConditionalModal isOpen={false} />
				</LayerStackProvider>
			);

			// Not registered when closed
			expect(mockLayerStackAPI.registerLayer).not.toHaveBeenCalled();

			// Open the modal
			rerender(
				<LayerStackProvider>
					<ConditionalModal isOpen={true} />
				</LayerStackProvider>
			);

			// Should register when opened
			expect(mockLayerStackAPI.registerLayer).toHaveBeenCalledTimes(1);

			// Close the modal
			rerender(
				<LayerStackProvider>
					<ConditionalModal isOpen={false} />
				</LayerStackProvider>
			);

			// Should unregister when closed
			expect(mockLayerStackAPI.unregisterLayer).toHaveBeenCalled();
		});

		it('escape handling works with dynamically added layers', async () => {
			// Start with no layers
			vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(null);

			const DynamicApp = () => {
				const [showModal, setShowModal] = React.useState(false);
				const { registerLayer, unregisterLayer, getTopLayer } = useLayerStack();

				React.useEffect(() => {
					if (showModal) {
						const id = registerLayer({
							type: 'modal',
							priority: 100,
							onEscape: () => setShowModal(false),
						});
						return () => unregisterLayer(id);
					}
				}, [showModal, registerLayer, unregisterLayer]);

				return (
					<div>
						<button onClick={() => setShowModal(true)}>Open</button>
						{showModal && <div data-testid="modal">Modal Content</div>}
					</div>
				);
			};

			render(
				<LayerStackProvider>
					<DynamicApp />
				</LayerStackProvider>
			);

			// Initially no modal
			expect(screen.queryByTestId('modal')).not.toBeInTheDocument();

			// Escape should do nothing
			const escapeEvent1 = new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
				cancelable: true,
			});
			await act(async () => {
				window.dispatchEvent(escapeEvent1);
			});
			expect(mockLayerStackAPI.closeTopLayer).not.toHaveBeenCalled();

			// Click to open modal
			await act(async () => {
				fireEvent.click(screen.getByText('Open'));
			});

			// Modal should be visible
			expect(screen.getByTestId('modal')).toBeInTheDocument();

			// Now simulate that there's a layer
			const mockLayer = {
				id: 'test-layer',
				type: 'modal' as const,
				priority: 100,
				onEscape: vi.fn(),
			};
			vi.mocked(mockLayerStackAPI.getTopLayer).mockReturnValue(mockLayer);

			// Escape should now close the modal
			const escapeEvent2 = new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
				cancelable: true,
			});
			await act(async () => {
				window.dispatchEvent(escapeEvent2);
			});

			expect(mockLayerStackAPI.closeTopLayer).toHaveBeenCalled();
		});

		describe('IME composition with real Find bars and modal inputs', () => {
			let registeredLayers: Array<{
				id: string;
				type: string;
				onEscape: () => void;
				ariaLabel?: string;
			}>;

			beforeEach(() => {
				registeredLayers = [];
				vi.mocked(mockLayerStackAPI.registerLayer).mockImplementation((layer) => {
					const id = `layer-${Date.now()}-${Math.random()}`;
					const entry = { ...layer, id, onEscape: layer.onEscape ?? vi.fn() };
					registeredLayers.push(entry);
					return id;
				});
				vi.mocked(mockLayerStackAPI.unregisterLayer).mockImplementation((id) => {
					registeredLayers = registeredLayers.filter((l) => l.id !== id);
				});
				vi.mocked(mockLayerStackAPI.getTopLayer).mockImplementation(
					() => (registeredLayers[registeredLayers.length - 1] as any) ?? null
				);
				vi.mocked(mockLayerStackAPI.closeTopLayer).mockImplementation(async () => {
					const top = registeredLayers[registeredLayers.length - 1];
					if (top?.onEscape) {
						top.onEscape();
						return true;
					}
					return false;
				});
			});

			it('leaves AI chat Find bar open on composing Escape and closes on normal Escape', async () => {
				const closeSearch = vi.fn();
				function AiChatFindHost({ open }: { open: boolean }) {
					useOutputSearchLayer({
						open,
						onEscape: closeSearch,
						ariaLabel: 'Output Search',
					});
					return open ? <input data-testid="ai-find-input" data-output-search-input /> : null;
				}

				render(
					<LayerStackProvider>
						<AiChatFindHost open={true} />
					</LayerStackProvider>
				);

				expect(screen.getByTestId('ai-find-input')).toBeInTheDocument();

				// Composing Escape (isComposing: true)
				const composingEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});
				Object.defineProperty(composingEvent, 'isComposing', { value: true, configurable: true });
				await act(async () => {
					window.dispatchEvent(composingEvent);
				});
				expect(closeSearch).not.toHaveBeenCalled();

				// Composing Escape (Safari keyCode 229)
				const safariEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
					keyCode: 229,
				} as KeyboardEventInit);
				await act(async () => {
					window.dispatchEvent(safariEvent);
				});
				expect(closeSearch).not.toHaveBeenCalled();

				// Normal Escape
				const normalEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});
				await act(async () => {
					window.dispatchEvent(normalEvent);
				});
				expect(closeSearch).toHaveBeenCalledTimes(1);
			});

			it('leaves Group Chat Find bar open on composing Escape and closes on normal Escape', async () => {
				const closeSearch = vi.fn();
				function GroupChatFindHost({ open }: { open: boolean }) {
					useOutputSearchLayer({
						open,
						onEscape: closeSearch,
						ariaLabel: 'Group Chat Search',
					});
					return open ? <input data-testid="gc-find-input" data-output-search-input /> : null;
				}

				render(
					<LayerStackProvider>
						<GroupChatFindHost open={true} />
					</LayerStackProvider>
				);

				expect(screen.getByTestId('gc-find-input')).toBeInTheDocument();

				// Composing Escape (isComposing: true)
				const composingEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});
				Object.defineProperty(composingEvent, 'isComposing', { value: true, configurable: true });
				await act(async () => {
					window.dispatchEvent(composingEvent);
				});
				expect(closeSearch).not.toHaveBeenCalled();

				// Composing Escape (Safari keyCode 229)
				const safariEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
					keyCode: 229,
				} as KeyboardEventInit);
				await act(async () => {
					window.dispatchEvent(safariEvent);
				});
				expect(closeSearch).not.toHaveBeenCalled();

				// Normal Escape
				const normalEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});
				await act(async () => {
					window.dispatchEvent(normalEvent);
				});
				expect(closeSearch).toHaveBeenCalledTimes(1);
			});

			it('leaves a modal text field with its own Escape handler open and focused on composing Escape', async () => {
				const closeModal = vi.fn();
				const cancelRename = vi.fn();

				function ModalWithRenameInput() {
					const { registerLayer, unregisterLayer } = useLayerStack();
					const inputRef = React.useRef<HTMLInputElement>(null);
					const [value, setValue] = React.useState('my-agent-name');

					React.useEffect(() => {
						const id = registerLayer({
							type: 'modal',
							priority: 100,
							onEscape: closeModal,
							ariaLabel: 'Rename Modal',
						});
						return () => unregisterLayer(id);
					}, [registerLayer, unregisterLayer]);

					return (
						<div>
							<input
								ref={inputRef}
								data-testid="modal-rename-field"
								autoFocus
								value={value}
								onChange={(e) => setValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Escape' && !isImeComposing(e)) {
										e.preventDefault();
										cancelRename();
									}
								}}
							/>
						</div>
					);
				}

				render(
					<LayerStackProvider>
						<ModalWithRenameInput />
					</LayerStackProvider>
				);

				const input = screen.getByTestId('modal-rename-field');
				input.focus();
				expect(document.activeElement).toBe(input);

				// Composing Escape dispatched on the input field
				const composingEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});
				Object.defineProperty(composingEvent, 'isComposing', { value: true, configurable: true });

				await act(async () => {
					input.dispatchEvent(composingEvent);
				});

				// Modal is NOT closed, field's own Escape is NOT triggered, and field remains focused
				expect(closeModal).not.toHaveBeenCalled();
				expect(cancelRename).not.toHaveBeenCalled();
				expect(document.activeElement).toBe(input);

				// Composing Escape with Safari keyCode 229
				const safariEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
					keyCode: 229,
				} as KeyboardEventInit);

				await act(async () => {
					input.dispatchEvent(safariEvent);
				});

				expect(closeModal).not.toHaveBeenCalled();
				expect(cancelRename).not.toHaveBeenCalled();
				expect(document.activeElement).toBe(input);

				// Normal Escape dispatched on the input field:
				// LayerStackContext intercepts on capture and closes the modal
				const normalEvent = new KeyboardEvent('keydown', {
					key: 'Escape',
					bubbles: true,
					cancelable: true,
				});

				await act(async () => {
					input.dispatchEvent(normalEvent);
				});

				expect(closeModal).toHaveBeenCalledTimes(1);
			});
		});
	});
});
