/**
 * Layer Stack Management Hook
 *
 * This hook provides the core layer stack management functionality:
 * - Register/unregister layers dynamically
 * - Maintain priority-sorted stack
 * - Handle Escape key delegation to top layer
 * - Update handlers without re-registration (performance optimization)
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Layer, LayerInput } from '../../types/layer';
import { logger } from '../../utils/logger';

/**
 * Extend Window interface for debug API
 */
declare global {
	interface Window {
		__MAESTRO_DEBUG__?: {
			layers?: {
				list: () => void;
				top: () => void;
				simulate: {
					escape: () => void;
					closeAll: () => void;
				};
			};
		};
	}
}

/**
 * Generate a simple unique ID
 */
function generateId(): string {
	return `layer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * API for managing the layer stack
 */
export interface LayerStackAPI {
	/**
	 * Register a new layer in the stack
	 * @param layer - Layer configuration (without id)
	 * @returns Unique layer id
	 */
	registerLayer: (layer: LayerInput) => string;

	/**
	 * Remove a layer from the stack
	 * @param id - Layer id returned from registerLayer
	 */
	unregisterLayer: (id: string) => void;

	/**
	 * Update the Escape handler for an existing layer without re-registering
	 * This is a performance optimization to avoid re-sorting the stack
	 * @param id - Layer id
	 * @param handler - New Escape handler function
	 */
	updateLayerHandler: (id: string, handler: () => void) => void;

	/**
	 * Get the topmost layer in the stack
	 * @returns Top layer or undefined if stack is empty
	 */
	getTopLayer: () => Layer | undefined;

	/**
	 * Close the topmost layer by calling its Escape handler
	 * Respects onBeforeClose for modals
	 * @returns true if layer was closed, false if close was prevented
	 */
	closeTopLayer: () => Promise<boolean>;

	/**
	 * Get all layers in priority order (highest priority last)
	 * @returns Array of all registered layers
	 */
	getLayers: () => Layer[];

	/**
	 * Check if any shortcut-blocking layer is currently open
	 *
	 * Layers that declared `blocksAppShortcuts: false` are skipped - they are
	 * passive panels that happen to be stacked, not surfaces that own the
	 * keyboard. For the structural "is anything stacked?" question use
	 * `layerCount`.
	 *
	 * @returns true if at least one such layer is registered
	 */
	hasOpenLayers: () => boolean;

	/**
	 * Check if any true modal (not overlay) is currently open
	 * Modals block ALL shortcuts, overlays allow some navigation shortcuts
	 *
	 * A modal-type layer that declared `blocksLowerLayers: false` (a dropdown, a
	 * docked search bar, a floating panel) is NOT a true modal: it said it does
	 * not block what is under it, so it must not silently block the keyboard
	 * either. Those fall through to the caller's overlay handling.
	 *
	 * @returns true if at least one true modal layer is registered
	 */
	hasOpenModal: () => boolean;

	/**
	 * Get the current layer count
	 * @returns Number of registered layers
	 */
	layerCount: number;
}

/**
 * Does this layer suppress the app's global shortcuts while it is open?
 *
 * The flag is optional, so an undefined value means "yes" - every layer written
 * before passive panels existed keeps its old behavior, and only a surface that
 * explicitly opts out becomes transparent to the keyboard.
 */
function blocksAppShortcuts(layer: Layer): boolean {
	return layer.blocksAppShortcuts !== false;
}

/**
 * Hook that manages the layer stack
 * Should be used once at the root level via LayerStackContext
 */
export function useLayerStack(): LayerStackAPI {
	// State for all registered layers, sorted by priority
	const [layers, setLayers] = useState<Layer[]>([]);

	// Ref map to store handler functions without triggering re-renders
	// Key: layer id, Value: current Escape handler
	const handlerRefs = useRef<Map<string, () => void>>(new Map());

	// What had keyboard focus when each layer opened.
	// Key: layer id, Value: the element to hand the caret back to on close.
	const focusOriginRefs = useRef<Map<string, HTMLElement>>(new Map());

	/**
	 * Register a new layer in the stack
	 */
	const registerLayer = useCallback((layer: LayerInput): string => {
		const id = generateId();
		const newLayer: Layer = { ...layer, id } as Layer;

		// Store the initial handler in the ref map
		handlerRefs.current.set(id, newLayer.onEscape);

		// Remember what the user was typing in before this layer took the
		// keyboard, so closing it can hand the caret back (see unregisterLayer).
		if (newLayer.capturesFocus !== false) {
			const origin = document.activeElement;
			if (origin instanceof HTMLElement && origin !== document.body) {
				focusOriginRefs.current.set(id, origin);
			}
		}

		// Add layer and sort by priority (ascending order - lowest priority first)
		setLayers((prev: Layer[]) => {
			const updated = [...prev, newLayer];
			updated.sort((a, b) => a.priority - b.priority);
			return updated;
		});

		return id;
	}, []);

	/**
	 * Unregister a layer from the stack
	 */
	const unregisterLayer = useCallback((id: string): void => {
		// Remove from handler refs
		handlerRefs.current.delete(id);

		const focusOrigin = focusOriginRefs.current.get(id);
		focusOriginRefs.current.delete(id);

		// Remove from layers state
		setLayers((prev: Layer[]) => prev.filter((layer: Layer) => layer.id !== id));

		// Hand the caret back to whatever had it before this layer opened. Nothing
		// used to do this, so dismissing a modal left focus on `document.body`:
		// the pane behind it looked ready and then swallowed the next keystroke,
		// which in a keyboard-first app reads as the app locking up.
		//
		// Deferred a tick because the layer's DOM is still mounted at this point -
		// focusing now would be undone by its own teardown. Restored ONLY when
		// focus landed nowhere, which is the signal that no one else claimed it:
		// a modal that deliberately moves focus on its way out (opening a tab,
		// focusing a result) has already set an active element, and a surface that
		// restores focus itself via `useFocusOnClose` gets there first.
		if (!focusOrigin) return;
		setTimeout(() => {
			if (!focusOrigin.isConnected) return;
			const current = document.activeElement;
			if (current && current !== document.body && current.isConnected) return;
			focusOrigin.focus();
		}, 0);
	}, []);

	/**
	 * Update the Escape handler for an existing layer
	 * This is more efficient than unregistering and re-registering
	 */
	const updateLayerHandler = useCallback((id: string, handler: () => void): void => {
		handlerRefs.current.set(id, handler);
	}, []);

	/**
	 * Get the topmost layer (highest priority)
	 */
	const getTopLayer = useCallback((): Layer | undefined => {
		return layers[layers.length - 1];
	}, [layers]);

	/**
	 * Get all layers in priority order
	 */
	const getLayers = useCallback((): Layer[] => {
		return [...layers];
	}, [layers]);

	/**
	 * Check if any shortcut-blocking layer is open
	 */
	const hasOpenLayers = useCallback((): boolean => {
		return layers.some(blocksAppShortcuts);
	}, [layers]);

	/**
	 * Check if any true modal (not overlay) is open
	 */
	const hasOpenModal = useCallback((): boolean => {
		return layers.some(
			(layer: Layer) =>
				layer.type === 'modal' && layer.blocksLowerLayers && blocksAppShortcuts(layer)
		);
	}, [layers]);

	/**
	 * Close the topmost layer
	 * Handles onBeforeClose for modals
	 */
	const closeTopLayer = useCallback(async (): Promise<boolean> => {
		const topLayer = layers[layers.length - 1];
		if (!topLayer) return false;

		// Check if it's a modal with onBeforeClose callback
		if (topLayer.type === 'modal' && topLayer.onBeforeClose) {
			const canClose = await topLayer.onBeforeClose();
			if (!canClose) {
				return false; // Close was prevented
			}
		}

		// Get the handler from refs (most up-to-date version)
		const handler = handlerRefs.current.get(topLayer.id);
		if (handler) {
			handler();
		}

		return true;
	}, [layers]);

	/**
	 * Debug API - only available in development mode
	 * Access via window.__MAESTRO_DEBUG__.layers in browser console
	 */
	useEffect(() => {
		if (process.env.NODE_ENV === 'development') {
			// Initialize __MAESTRO_DEBUG__ if it doesn't exist
			if (!window.__MAESTRO_DEBUG__) {
				window.__MAESTRO_DEBUG__ = {};
			}

			// Set up the layers debug API
			window.__MAESTRO_DEBUG__.layers = {
				/**
				 * List all layers in a formatted table
				 */
				list: () => {
					console.table(
						layers.map((layer: Layer) => ({
							id: layer.id,
							type: layer.type,
							priority: layer.priority,
							blocksLower: layer.blocksLowerLayers,
							blocksShortcuts: layer.blocksAppShortcuts !== false,
							focusTrap: layer.focusTrap,
							ariaLabel: layer.ariaLabel || 'N/A',
						}))
					);
				},

				/**
				 * Log the topmost layer
				 */
				top: () => {
					const topLayer = layers[layers.length - 1];
					if (topLayer) {
						logger.info('Top Layer:', undefined, topLayer);
					} else {
						logger.info('No layers in stack');
					}
				},

				/**
				 * Simulation utilities
				 */
				simulate: {
					/**
					 * Dispatch an Escape key event
					 */
					escape: () => {
						const event = new KeyboardEvent('keydown', {
							key: 'Escape',
							code: 'Escape',
							keyCode: 27,
							bubbles: true,
							cancelable: true,
						});
						window.dispatchEvent(event);
						logger.info('Escape key event dispatched');
					},

					/**
					 * Close all layers immediately
					 */
					closeAll: () => {
						const count = layers.length;
						setLayers([]);
						handlerRefs.current.clear();
						logger.info(`Cleared ${count} layers from stack`);
					},
				},
			};

			// Cleanup on unmount
			return () => {
				if (window.__MAESTRO_DEBUG__) {
					delete window.__MAESTRO_DEBUG__.layers;
				}
			};
		}
	}, [layers]);

	return {
		registerLayer,
		unregisterLayer,
		updateLayerHandler,
		getTopLayer,
		closeTopLayer,
		getLayers,
		hasOpenLayers,
		hasOpenModal,
		layerCount: layers.length,
	};
}
