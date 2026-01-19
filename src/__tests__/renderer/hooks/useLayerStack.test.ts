/**
 * Tests for useLayerStack hook
 *
 * This hook manages a layer stack for modals, overlays, and other UI elements
 * that need to handle Escape key events in priority order.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLayerStack } from '../../../renderer/hooks';
import { ModalLayer, OverlayLayer } from '../../../renderer/types/layer';

describe('useLayerStack', () => {
	// Store original NODE_ENV
	const originalNodeEnv = process.env.NODE_ENV;

	beforeEach(() => {
		// Set to production to disable debug API by default
		process.env.NODE_ENV = 'production';
		// Reset window.__MAESTRO_DEBUG__ before each test
		delete (window as unknown as Record<string, unknown>).__MAESTRO_DEBUG__;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env.NODE_ENV = originalNodeEnv;
		delete (window as unknown as Record<string, unknown>).__MAESTRO_DEBUG__;
	});

	// Helper to create a modal layer config (without id)
	function createModalLayer(
		options: Partial<Omit<ModalLayer, 'id' | 'type'>> = {}
	): Omit<ModalLayer, 'id'> {
		return {
			type: 'modal',
			priority: options.priority ?? 100,
			blocksLowerLayers: options.blocksLowerLayers ?? true,
			capturesFocus: options.capturesFocus ?? true,
			focusTrap: options.focusTrap ?? 'strict',
			onEscape: options.onEscape ?? vi.fn(),
			ariaLabel: options.ariaLabel,
			isDirty: options.isDirty,
			onBeforeClose: options.onBeforeClose,
			parentModalId: options.parentModalId,
		};
	}

	// Helper to create an overlay layer config (without id)
	function createOverlayLayer(
		options: Partial<Omit<OverlayLayer, 'id' | 'type'>> = {}
	): Omit<OverlayLayer, 'id'> {
		return {
			type: 'overlay',
			priority: options.priority ?? 50,
			blocksLowerLayers: options.blocksLowerLayers ?? false,
			capturesFocus: options.capturesFocus ?? false,
			focusTrap: options.focusTrap ?? 'none',
			onEscape: options.onEscape ?? vi.fn(),
			allowClickOutside: options.allowClickOutside ?? true,
			ariaLabel: options.ariaLabel,
		};
	}

	describe('initial state', () => {
		it('should return empty layers array initially', () => {
			const { result } = renderHook(() => useLayerStack());

			expect(result.current.getLayers()).toEqual([]);
			expect(result.current.layerCount).toBe(0);
		});

		it('should return undefined for getTopLayer when no layers', () => {
			const { result } = renderHook(() => useLayerStack());

			expect(result.current.getTopLayer()).toBeUndefined();
		});

		it('should return false for hasOpenLayers when no layers', () => {
			const { result } = renderHook(() => useLayerStack());

			expect(result.current.hasOpenLayers()).toBe(false);
		});

		it('should return false for hasOpenModal when no layers', () => {
			const { result } = renderHook(() => useLayerStack());

			expect(result.current.hasOpenModal()).toBe(false);
		});
	});

	describe('registerLayer', () => {
		it('should register a layer and return a unique id', () => {
			const { result } = renderHook(() => useLayerStack());
			const layer = createModalLayer();

			let id: string;
			act(() => {
				id = result.current.registerLayer(layer);
			});

			expect(id!).toBeDefined();
			expect(typeof id!).toBe('string');
			expect(id!).toMatch(/^layer-\d+-[a-z0-9]+$/);
		});

		it('should generate unique ids for each layer', () => {
			const { result } = renderHook(() => useLayerStack());
			const ids: string[] = [];

			act(() => {
				// Register multiple layers
				for (let i = 0; i < 5; i++) {
					ids.push(result.current.registerLayer(createModalLayer({ priority: i })));
				}
			});

			// All ids should be unique
			const uniqueIds = new Set(ids);
			expect(uniqueIds.size).toBe(5);
		});

		it('should add layer to the layers array', () => {
			const { result } = renderHook(() => useLayerStack());
			const layer = createModalLayer({ priority: 100 });

			act(() => {
				result.current.registerLayer(layer);
			});

			expect(result.current.getLayers()).toHaveLength(1);
			expect(result.current.layerCount).toBe(1);
		});

		it('should set layer properties correctly', () => {
			const { result } = renderHook(() => useLayerStack());
			const onEscape = vi.fn();
			const layer = createModalLayer({
				priority: 150,
				ariaLabel: 'Test Modal',
				onEscape,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'strict',
			});

			act(() => {
				result.current.registerLayer(layer);
			});

			const registeredLayer = result.current.getLayers()[0];
			expect(registeredLayer.type).toBe('modal');
			expect(registeredLayer.priority).toBe(150);
			expect(registeredLayer.ariaLabel).toBe('Test Modal');
			expect(registeredLayer.blocksLowerLayers).toBe(true);
			expect(registeredLayer.capturesFocus).toBe(true);
			expect(registeredLayer.focusTrap).toBe('strict');
		});

		it('should sort layers by priority (ascending)', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer({ priority: 300 }));
				result.current.registerLayer(createModalLayer({ priority: 100 }));
				result.current.registerLayer(createModalLayer({ priority: 200 }));
			});

			const layers = result.current.getLayers();
			expect(layers[0].priority).toBe(100);
			expect(layers[1].priority).toBe(200);
			expect(layers[2].priority).toBe(300);
		});

		it('should maintain sort order when adding multiple layers', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer({ priority: 50, ariaLabel: 'First' }));
			});

			act(() => {
				result.current.registerLayer(createModalLayer({ priority: 25, ariaLabel: 'Second' }));
			});

			act(() => {
				result.current.registerLayer(createModalLayer({ priority: 75, ariaLabel: 'Third' }));
			});

			const layers = result.current.getLayers();
			expect(layers[0].priority).toBe(25);
			expect(layers[0].ariaLabel).toBe('Second');
			expect(layers[1].priority).toBe(50);
			expect(layers[1].ariaLabel).toBe('First');
			expect(layers[2].priority).toBe(75);
			expect(layers[2].ariaLabel).toBe('Third');
		});

		it('should handle layers with equal priority', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer({ priority: 100, ariaLabel: 'First' }));
				result.current.registerLayer(createModalLayer({ priority: 100, ariaLabel: 'Second' }));
			});

			const layers = result.current.getLayers();
			expect(layers).toHaveLength(2);
			// Both should have priority 100 (sort is stable for equal values)
			expect(layers.every((l) => l.priority === 100)).toBe(true);
		});

		it('should register overlay layers correctly', () => {
			const { result } = renderHook(() => useLayerStack());
			const layer = createOverlayLayer({
				priority: 75,
				allowClickOutside: false,
			});

			act(() => {
				result.current.registerLayer(layer);
			});

			const registeredLayer = result.current.getLayers()[0] as OverlayLayer;
			expect(registeredLayer.type).toBe('overlay');
			expect(registeredLayer.allowClickOutside).toBe(false);
		});

		it('should handle mixed modal and overlay layers', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer({ priority: 100 }));
				result.current.registerLayer(createOverlayLayer({ priority: 50 }));
				result.current.registerLayer(createModalLayer({ priority: 200 }));
			});

			const layers = result.current.getLayers();
			expect(layers[0].type).toBe('overlay');
			expect(layers[0].priority).toBe(50);
			expect(layers[1].type).toBe('modal');
			expect(layers[1].priority).toBe(100);
			expect(layers[2].type).toBe('modal');
			expect(layers[2].priority).toBe(200);
		});
	});

	describe('unregisterLayer', () => {
		it('should remove a layer by id', () => {
			const { result } = renderHook(() => useLayerStack());

			let id: string;
			act(() => {
				id = result.current.registerLayer(createModalLayer());
			});

			expect(result.current.layerCount).toBe(1);

			act(() => {
				result.current.unregisterLayer(id!);
			});

			expect(result.current.layerCount).toBe(0);
			expect(result.current.getLayers()).toEqual([]);
		});

		it('should only remove the specified layer', () => {
			const { result } = renderHook(() => useLayerStack());

			let id1: string, id2: string, id3: string;
			act(() => {
				id1 = result.current.registerLayer(
					createModalLayer({ priority: 100, ariaLabel: 'Layer 1' })
				);
				id2 = result.current.registerLayer(
					createModalLayer({ priority: 200, ariaLabel: 'Layer 2' })
				);
				id3 = result.current.registerLayer(
					createModalLayer({ priority: 300, ariaLabel: 'Layer 3' })
				);
			});

			act(() => {
				result.current.unregisterLayer(id2!);
			});

			const layers = result.current.getLayers();
			expect(layers).toHaveLength(2);
			expect(layers[0].id).toBe(id1!);
			expect(layers[1].id).toBe(id3!);
		});

		it('should handle unregistering non-existent layer gracefully', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer());
			});

			// Should not throw
			act(() => {
				result.current.unregisterLayer('non-existent-id');
			});

			expect(result.current.layerCount).toBe(1);
		});

		it('should handle unregistering from empty stack gracefully', () => {
			const { result } = renderHook(() => useLayerStack());

			// Should not throw
			act(() => {
				result.current.unregisterLayer('any-id');
			});

			expect(result.current.layerCount).toBe(0);
		});

		it('should allow unregistering and re-registering with same properties', () => {
			const { result } = renderHook(() => useLayerStack());
			const layer = createModalLayer({ priority: 100 });

			let id1: string, id2: string;
			act(() => {
				id1 = result.current.registerLayer(layer);
			});

			act(() => {
				result.current.unregisterLayer(id1!);
			});

			act(() => {
				id2 = result.current.registerLayer(layer);
			});

			// New id should be different
			expect(id2!).not.toBe(id1!);
			expect(result.current.layerCount).toBe(1);
		});
	});

	describe('updateLayerHandler', () => {
		it('should update the escape handler for an existing layer', async () => {
			const { result } = renderHook(() => useLayerStack());
			const originalHandler = vi.fn();
			const newHandler = vi.fn();

			let id: string;
			act(() => {
				id = result.current.registerLayer(createModalLayer({ onEscape: originalHandler }));
			});

			act(() => {
				result.current.updateLayerHandler(id!, newHandler);
			});

			// Close the top layer - should call the NEW handler
			await act(async () => {
				await result.current.closeTopLayer();
			});

			expect(originalHandler).not.toHaveBeenCalled();
			expect(newHandler).toHaveBeenCalledTimes(1);
		});

		it('should handle updating non-existent layer gracefully', () => {
			const { result } = renderHook(() => useLayerStack());

			// Should not throw
			act(() => {
				result.current.updateLayerHandler('non-existent-id', vi.fn());
			});
		});

		it('should allow multiple handler updates', async () => {
			const { result } = renderHook(() => useLayerStack());
			const handler1 = vi.fn();
			const handler2 = vi.fn();
			const handler3 = vi.fn();

			let id: string;
			act(() => {
				id = result.current.registerLayer(createModalLayer({ onEscape: handler1 }));
			});

			act(() => {
				result.current.updateLayerHandler(id!, handler2);
			});

			act(() => {
				result.current.updateLayerHandler(id!, handler3);
			});

			await act(async () => {
				await result.current.closeTopLayer();
			});

			expect(handler1).not.toHaveBeenCalled();
			expect(handler2).not.toHaveBeenCalled();
			expect(handler3).toHaveBeenCalledTimes(1);
		});
	});

	describe('getTopLayer', () => {
		it('should return undefined when stack is empty', () => {
			const { result } = renderHook(() => useLayerStack());

			expect(result.current.getTopLayer()).toBeUndefined();
		});

		it('should return the only layer when one exists', () => {
			const { result } = renderHook(() => useLayerStack());

			let id: string;
			act(() => {
				id = result.current.registerLayer(createModalLayer({ ariaLabel: 'Only Layer' }));
			});

			const topLayer = result.current.getTopLayer();
			expect(topLayer).toBeDefined();
			expect(topLayer!.id).toBe(id!);
			expect(topLayer!.ariaLabel).toBe('Only Layer');
		});

		it('should return the highest priority layer', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer({ priority: 100, ariaLabel: 'Low' }));
				result.current.registerLayer(createModalLayer({ priority: 300, ariaLabel: 'High' }));
				result.current.registerLayer(createModalLayer({ priority: 200, ariaLabel: 'Medium' }));
			});

			const topLayer = result.current.getTopLayer();
			expect(topLayer!.priority).toBe(300);
			expect(topLayer!.ariaLabel).toBe('High');
		});

		it('should update when layers change', () => {
			const { result } = renderHook(() => useLayerStack());

			let lowId: string;
			act(() => {
				lowId = result.current.registerLayer(createModalLayer({ priority: 100, ariaLabel: 'Low' }));
			});

			expect(result.current.getTopLayer()!.ariaLabel).toBe('Low');

			let highId: string;
			act(() => {
				highId = result.current.registerLayer(
					createModalLayer({ priority: 200, ariaLabel: 'High' })
				);
			});

			expect(result.current.getTopLayer()!.ariaLabel).toBe('High');

			act(() => {
				result.current.unregisterLayer(highId!);
			});

			expect(result.current.getTopLayer()!.ariaLabel).toBe('Low');
		});
	});

	describe('getLayers', () => {
		it('should return empty array when no layers', () => {
			const { result } = renderHook(() => useLayerStack());

			expect(result.current.getLayers()).toEqual([]);
		});

		it('should return a copy of the layers array', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer());
			});

			const layers1 = result.current.getLayers();
			const layers2 = result.current.getLayers();

			// Should be equal but not same reference
			expect(layers1).toEqual(layers2);
			expect(layers1).not.toBe(layers2);
		});

		it('should return layers in priority order (ascending)', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer({ priority: 500 }));
				result.current.registerLayer(createModalLayer({ priority: 100 }));
				result.current.registerLayer(createModalLayer({ priority: 300 }));
			});

			const layers = result.current.getLayers();
			expect(layers.map((l) => l.priority)).toEqual([100, 300, 500]);
		});
	});

	describe('hasOpenLayers', () => {
		it('should return false when no layers', () => {
			const { result } = renderHook(() => useLayerStack());

			expect(result.current.hasOpenLayers()).toBe(false);
		});

		it('should return true when one layer exists', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer());
			});

			expect(result.current.hasOpenLayers()).toBe(true);
		});

		it('should return true when multiple layers exist', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer());
				result.current.registerLayer(createOverlayLayer());
			});

			expect(result.current.hasOpenLayers()).toBe(true);
		});

		it('should return true for overlay layers', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createOverlayLayer());
			});

			expect(result.current.hasOpenLayers()).toBe(true);
		});

		it('should update when layers are removed', () => {
			const { result } = renderHook(() => useLayerStack());

			let id: string;
			act(() => {
				id = result.current.registerLayer(createModalLayer());
			});

			expect(result.current.hasOpenLayers()).toBe(true);

			act(() => {
				result.current.unregisterLayer(id!);
			});

			expect(result.current.hasOpenLayers()).toBe(false);
		});
	});

	describe('hasOpenModal', () => {
		it('should return false when no layers', () => {
			const { result } = renderHook(() => useLayerStack());

			expect(result.current.hasOpenModal()).toBe(false);
		});

		it('should return true when modal exists', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer());
			});

			expect(result.current.hasOpenModal()).toBe(true);
		});

		it('should return false when only overlays exist', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createOverlayLayer());
				result.current.registerLayer(createOverlayLayer({ priority: 100 }));
			});

			expect(result.current.hasOpenModal()).toBe(false);
		});

		it('should return true when mixed with overlays', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createOverlayLayer({ priority: 50 }));
				result.current.registerLayer(createModalLayer({ priority: 100 }));
				result.current.registerLayer(createOverlayLayer({ priority: 150 }));
			});

			expect(result.current.hasOpenModal()).toBe(true);
		});

		it('should update when modal is removed', () => {
			const { result } = renderHook(() => useLayerStack());

			let modalId: string;
			act(() => {
				result.current.registerLayer(createOverlayLayer());
				modalId = result.current.registerLayer(createModalLayer());
			});

			expect(result.current.hasOpenModal()).toBe(true);

			act(() => {
				result.current.unregisterLayer(modalId!);
			});

			expect(result.current.hasOpenModal()).toBe(false);
		});
	});

	describe('layerCount', () => {
		it('should be 0 when no layers', () => {
			const { result } = renderHook(() => useLayerStack());

			expect(result.current.layerCount).toBe(0);
		});

		it('should increment when layers are added', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer());
			});
			expect(result.current.layerCount).toBe(1);

			act(() => {
				result.current.registerLayer(createModalLayer());
			});
			expect(result.current.layerCount).toBe(2);

			act(() => {
				result.current.registerLayer(createOverlayLayer());
			});
			expect(result.current.layerCount).toBe(3);
		});

		it('should decrement when layers are removed', () => {
			const { result } = renderHook(() => useLayerStack());

			const ids: string[] = [];
			act(() => {
				ids.push(result.current.registerLayer(createModalLayer()));
				ids.push(result.current.registerLayer(createModalLayer()));
				ids.push(result.current.registerLayer(createModalLayer()));
			});

			expect(result.current.layerCount).toBe(3);

			act(() => {
				result.current.unregisterLayer(ids[1]);
			});
			expect(result.current.layerCount).toBe(2);

			act(() => {
				result.current.unregisterLayer(ids[0]);
			});
			expect(result.current.layerCount).toBe(1);
		});
	});

	describe('closeTopLayer', () => {
		it('should return false when no layers exist', async () => {
			const { result } = renderHook(() => useLayerStack());

			let closed: boolean;
			await act(async () => {
				closed = await result.current.closeTopLayer();
			});

			expect(closed!).toBe(false);
		});

		it('should call the escape handler of the top layer', async () => {
			const { result } = renderHook(() => useLayerStack());
			const handler = vi.fn();

			act(() => {
				result.current.registerLayer(createModalLayer({ onEscape: handler }));
			});

			await act(async () => {
				await result.current.closeTopLayer();
			});

			expect(handler).toHaveBeenCalledTimes(1);
		});

		it('should only call the top layer handler', async () => {
			const { result } = renderHook(() => useLayerStack());
			const handler1 = vi.fn();
			const handler2 = vi.fn();
			const handler3 = vi.fn();

			act(() => {
				result.current.registerLayer(createModalLayer({ priority: 100, onEscape: handler1 }));
				result.current.registerLayer(createModalLayer({ priority: 200, onEscape: handler2 }));
				result.current.registerLayer(createModalLayer({ priority: 300, onEscape: handler3 }));
			});

			await act(async () => {
				await result.current.closeTopLayer();
			});

			expect(handler1).not.toHaveBeenCalled();
			expect(handler2).not.toHaveBeenCalled();
			expect(handler3).toHaveBeenCalledTimes(1);
		});

		it('should return true when layer is closed successfully', async () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer());
			});

			let closed: boolean;
			await act(async () => {
				closed = await result.current.closeTopLayer();
			});

			expect(closed!).toBe(true);
		});

		describe('onBeforeClose handling', () => {
			it('should call onBeforeClose for modals before closing', async () => {
				const { result } = renderHook(() => useLayerStack());
				const onBeforeClose = vi.fn().mockResolvedValue(true);
				const onEscape = vi.fn();

				act(() => {
					result.current.registerLayer(
						createModalLayer({
							onBeforeClose,
							onEscape,
						})
					);
				});

				await act(async () => {
					await result.current.closeTopLayer();
				});

				expect(onBeforeClose).toHaveBeenCalledTimes(1);
				expect(onEscape).toHaveBeenCalledTimes(1);
			});

			it('should prevent close when onBeforeClose returns false', async () => {
				const { result } = renderHook(() => useLayerStack());
				const onBeforeClose = vi.fn().mockResolvedValue(false);
				const onEscape = vi.fn();

				act(() => {
					result.current.registerLayer(
						createModalLayer({
							onBeforeClose,
							onEscape,
						})
					);
				});

				let closed: boolean;
				await act(async () => {
					closed = await result.current.closeTopLayer();
				});

				expect(closed!).toBe(false);
				expect(onBeforeClose).toHaveBeenCalledTimes(1);
				expect(onEscape).not.toHaveBeenCalled();
			});

			it('should handle sync onBeforeClose returning false', async () => {
				const { result } = renderHook(() => useLayerStack());
				const onBeforeClose = vi.fn().mockReturnValue(false);
				const onEscape = vi.fn();

				act(() => {
					result.current.registerLayer(
						createModalLayer({
							onBeforeClose,
							onEscape,
						})
					);
				});

				let closed: boolean;
				await act(async () => {
					closed = await result.current.closeTopLayer();
				});

				expect(closed!).toBe(false);
				expect(onEscape).not.toHaveBeenCalled();
			});

			it('should handle sync onBeforeClose returning true', async () => {
				const { result } = renderHook(() => useLayerStack());
				const onBeforeClose = vi.fn().mockReturnValue(true);
				const onEscape = vi.fn();

				act(() => {
					result.current.registerLayer(
						createModalLayer({
							onBeforeClose,
							onEscape,
						})
					);
				});

				let closed: boolean;
				await act(async () => {
					closed = await result.current.closeTopLayer();
				});

				expect(closed!).toBe(true);
				expect(onEscape).toHaveBeenCalledTimes(1);
			});

			it('should not call onBeforeClose for overlay layers', async () => {
				const { result } = renderHook(() => useLayerStack());
				const onEscape = vi.fn();

				act(() => {
					result.current.registerLayer(createOverlayLayer({ onEscape }));
				});

				await act(async () => {
					await result.current.closeTopLayer();
				});

				expect(onEscape).toHaveBeenCalledTimes(1);
			});

			it('should handle async onBeforeClose that resolves to true', async () => {
				const { result } = renderHook(() => useLayerStack());
				const onBeforeClose = vi.fn().mockResolvedValue(true);
				const onEscape = vi.fn();

				act(() => {
					result.current.registerLayer(
						createModalLayer({
							onBeforeClose,
							onEscape,
						})
					);
				});

				let closed: boolean;
				await act(async () => {
					closed = await result.current.closeTopLayer();
				});

				expect(closed!).toBe(true);
				expect(onBeforeClose).toHaveBeenCalledTimes(1);
				expect(onEscape).toHaveBeenCalledTimes(1);
			});

			it('should handle async onBeforeClose that resolves to false', async () => {
				const { result } = renderHook(() => useLayerStack());
				const onBeforeClose = vi.fn().mockResolvedValue(false);
				const onEscape = vi.fn();

				act(() => {
					result.current.registerLayer(
						createModalLayer({
							onBeforeClose,
							onEscape,
						})
					);
				});

				let closed: boolean;
				await act(async () => {
					closed = await result.current.closeTopLayer();
				});

				expect(closed!).toBe(false);
				expect(onBeforeClose).toHaveBeenCalledTimes(1);
				expect(onEscape).not.toHaveBeenCalled();
			});
		});

		it('should use the updated handler after updateLayerHandler', async () => {
			const { result } = renderHook(() => useLayerStack());
			const originalHandler = vi.fn();
			const updatedHandler = vi.fn();

			let id: string;
			act(() => {
				id = result.current.registerLayer(createModalLayer({ onEscape: originalHandler }));
			});

			act(() => {
				result.current.updateLayerHandler(id!, updatedHandler);
			});

			await act(async () => {
				await result.current.closeTopLayer();
			});

			expect(originalHandler).not.toHaveBeenCalled();
			expect(updatedHandler).toHaveBeenCalledTimes(1);
		});
	});

	describe('callback stability', () => {
		it('should return stable registerLayer callback', () => {
			const { result, rerender } = renderHook(() => useLayerStack());

			const registerLayer1 = result.current.registerLayer;
			rerender();
			const registerLayer2 = result.current.registerLayer;

			expect(registerLayer1).toBe(registerLayer2);
		});

		it('should return stable unregisterLayer callback', () => {
			const { result, rerender } = renderHook(() => useLayerStack());

			const unregisterLayer1 = result.current.unregisterLayer;
			rerender();
			const unregisterLayer2 = result.current.unregisterLayer;

			expect(unregisterLayer1).toBe(unregisterLayer2);
		});

		it('should return stable updateLayerHandler callback', () => {
			const { result, rerender } = renderHook(() => useLayerStack());

			const updateLayerHandler1 = result.current.updateLayerHandler;
			rerender();
			const updateLayerHandler2 = result.current.updateLayerHandler;

			expect(updateLayerHandler1).toBe(updateLayerHandler2);
		});

		it('should update getTopLayer when layers change', () => {
			const { result } = renderHook(() => useLayerStack());

			// getTopLayer depends on layers, so it should update
			const getTopLayer1 = result.current.getTopLayer;

			act(() => {
				result.current.registerLayer(createModalLayer());
			});

			// The callback reference may change since it depends on layers state
			const getTopLayer2 = result.current.getTopLayer;

			// The important thing is that the function returns correct values
			expect(getTopLayer2()).toBeDefined();
		});
	});

	describe('debug API', () => {
		it('should set up debug API in development mode', () => {
			process.env.NODE_ENV = 'development';

			const { result } = renderHook(() => useLayerStack());

			// Force the effect to run by adding a layer
			act(() => {
				result.current.registerLayer(createModalLayer());
			});

			expect(window.__MAESTRO_DEBUG__).toBeDefined();
			expect(window.__MAESTRO_DEBUG__?.layers).toBeDefined();
			expect(typeof window.__MAESTRO_DEBUG__?.layers?.list).toBe('function');
			expect(typeof window.__MAESTRO_DEBUG__?.layers?.top).toBe('function');
			expect(typeof window.__MAESTRO_DEBUG__?.layers?.simulate?.escape).toBe('function');
			expect(typeof window.__MAESTRO_DEBUG__?.layers?.simulate?.closeAll).toBe('function');
		});

		it('should clean up debug API on unmount', () => {
			process.env.NODE_ENV = 'development';

			const { result, unmount } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer());
			});

			expect(window.__MAESTRO_DEBUG__?.layers).toBeDefined();

			unmount();

			expect(window.__MAESTRO_DEBUG__?.layers).toBeUndefined();
		});

		it('should not set up debug API in production mode', () => {
			process.env.NODE_ENV = 'production';

			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer());
			});

			expect(window.__MAESTRO_DEBUG__?.layers).toBeUndefined();
		});

		it('should preserve existing __MAESTRO_DEBUG__ properties', () => {
			process.env.NODE_ENV = 'development';

			// Pre-set some debug properties
			(window as unknown as Record<string, unknown>).__MAESTRO_DEBUG__ = {
				otherProperty: 'should remain',
			};

			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer());
			});

			expect((window.__MAESTRO_DEBUG__ as Record<string, unknown>)?.otherProperty).toBe(
				'should remain'
			);
			expect(window.__MAESTRO_DEBUG__?.layers).toBeDefined();
		});

		describe('debug API functions', () => {
			it('list() should log layers as a table', () => {
				process.env.NODE_ENV = 'development';
				const consoleSpy = vi.spyOn(console, 'table').mockImplementation(() => {});

				const { result } = renderHook(() => useLayerStack());

				act(() => {
					result.current.registerLayer(
						createModalLayer({ priority: 100, ariaLabel: 'Test Modal' })
					);
				});

				window.__MAESTRO_DEBUG__?.layers?.list();

				expect(consoleSpy).toHaveBeenCalledWith(
					expect.arrayContaining([
						expect.objectContaining({
							type: 'modal',
							priority: 100,
							ariaLabel: 'Test Modal',
						}),
					])
				);

				consoleSpy.mockRestore();
			});

			it('top() should log the top layer', () => {
				process.env.NODE_ENV = 'development';
				const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

				const { result } = renderHook(() => useLayerStack());

				act(() => {
					result.current.registerLayer(createModalLayer({ ariaLabel: 'Top Layer' }));
				});

				window.__MAESTRO_DEBUG__?.layers?.top();

				expect(consoleSpy).toHaveBeenCalledWith(
					'Top Layer:',
					expect.objectContaining({ ariaLabel: 'Top Layer' })
				);

				consoleSpy.mockRestore();
			});

			it('top() should log message when no layers exist', () => {
				process.env.NODE_ENV = 'development';
				const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

				// Need to register and then unregister to have debug API but no layers
				const { result } = renderHook(() => useLayerStack());

				let id: string;
				act(() => {
					id = result.current.registerLayer(createModalLayer());
				});

				act(() => {
					result.current.unregisterLayer(id!);
				});

				window.__MAESTRO_DEBUG__?.layers?.top();

				expect(consoleSpy).toHaveBeenCalledWith('No layers in stack');

				consoleSpy.mockRestore();
			});

			it('simulate.escape() should dispatch Escape key event', () => {
				process.env.NODE_ENV = 'development';
				const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
				const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

				const { result } = renderHook(() => useLayerStack());

				act(() => {
					result.current.registerLayer(createModalLayer());
				});

				window.__MAESTRO_DEBUG__?.layers?.simulate?.escape();

				expect(dispatchSpy).toHaveBeenCalledWith(
					expect.objectContaining({
						type: 'keydown',
						key: 'Escape',
						code: 'Escape',
					})
				);
				expect(consoleSpy).toHaveBeenCalledWith('Escape key event dispatched');

				consoleSpy.mockRestore();
				dispatchSpy.mockRestore();
			});

			it('simulate.closeAll() should clear all layers', () => {
				process.env.NODE_ENV = 'development';
				const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

				const { result } = renderHook(() => useLayerStack());

				act(() => {
					result.current.registerLayer(createModalLayer({ priority: 100 }));
					result.current.registerLayer(createModalLayer({ priority: 200 }));
					result.current.registerLayer(createOverlayLayer({ priority: 150 }));
				});

				expect(result.current.layerCount).toBe(3);

				act(() => {
					window.__MAESTRO_DEBUG__?.layers?.simulate?.closeAll();
				});

				expect(result.current.layerCount).toBe(0);
				expect(consoleSpy).toHaveBeenCalledWith('Cleared 3 layers from stack');

				consoleSpy.mockRestore();
			});
		});
	});

	describe('edge cases', () => {
		it('should handle rapid register/unregister cycles', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				for (let i = 0; i < 100; i++) {
					const id = result.current.registerLayer(createModalLayer({ priority: i }));
					if (i % 2 === 0) {
						result.current.unregisterLayer(id);
					}
				}
			});

			// Should have 50 layers (odd indices)
			expect(result.current.layerCount).toBe(50);
		});

		it('should handle very high priority values', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer({ priority: Number.MAX_SAFE_INTEGER }));
				result.current.registerLayer(createModalLayer({ priority: 1 }));
			});

			expect(result.current.getTopLayer()!.priority).toBe(Number.MAX_SAFE_INTEGER);
		});

		it('should handle negative priority values', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer({ priority: -100 }));
				result.current.registerLayer(createModalLayer({ priority: 100 }));
				result.current.registerLayer(createModalLayer({ priority: -50 }));
			});

			const layers = result.current.getLayers();
			expect(layers[0].priority).toBe(-100);
			expect(layers[1].priority).toBe(-50);
			expect(layers[2].priority).toBe(100);
		});

		it('should handle zero priority', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer(createModalLayer({ priority: 0 }));
				result.current.registerLayer(createModalLayer({ priority: -1 }));
				result.current.registerLayer(createModalLayer({ priority: 1 }));
			});

			const layers = result.current.getLayers();
			expect(layers[0].priority).toBe(-1);
			expect(layers[1].priority).toBe(0);
			expect(layers[2].priority).toBe(1);
		});

		it('should handle layer with undefined optional properties', () => {
			const { result } = renderHook(() => useLayerStack());

			act(() => {
				result.current.registerLayer({
					type: 'modal',
					priority: 100,
					blocksLowerLayers: true,
					capturesFocus: true,
					focusTrap: 'strict',
					onEscape: vi.fn(),
					// ariaLabel, isDirty, onBeforeClose, parentModalId are all undefined
				});
			});

			const layer = result.current.getTopLayer() as ModalLayer;
			expect(layer.ariaLabel).toBeUndefined();
			expect(layer.isDirty).toBeUndefined();
			expect(layer.onBeforeClose).toBeUndefined();
			expect(layer.parentModalId).toBeUndefined();
		});

		it('should handle closing layer when handler exists', async () => {
			const { result } = renderHook(() => useLayerStack());
			const handler = vi.fn();

			act(() => {
				result.current.registerLayer(createModalLayer({ onEscape: handler }));
			});

			let closed: boolean;
			await act(async () => {
				closed = await result.current.closeTopLayer();
			});

			expect(closed!).toBe(true);
			expect(handler).toHaveBeenCalledTimes(1);
		});
	});

	describe('multiple hook instances', () => {
		it('should maintain separate state for different hook instances', () => {
			const { result: result1 } = renderHook(() => useLayerStack());
			const { result: result2 } = renderHook(() => useLayerStack());

			act(() => {
				result1.current.registerLayer(createModalLayer({ ariaLabel: 'Instance 1' }));
			});

			expect(result1.current.layerCount).toBe(1);
			expect(result2.current.layerCount).toBe(0);

			act(() => {
				result2.current.registerLayer(createModalLayer({ ariaLabel: 'Instance 2' }));
				result2.current.registerLayer(createModalLayer({ ariaLabel: 'Instance 2b' }));
			});

			expect(result1.current.layerCount).toBe(1);
			expect(result2.current.layerCount).toBe(2);
		});
	});
});
