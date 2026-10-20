import React, { createContext, useContext, useEffect, useMemo, ReactNode } from 'react';
import { useLayerStack as useLayerStackHook, type LayerStackAPI } from '../hooks/ui/useLayerStack';
import { useLayerSwipeDismiss } from '../hooks/ui/useLayerSwipeDismiss';
import { deckModeArmedNow } from '../stores/uiStore';

// Create context with null as default (will throw if used outside provider)
const LayerStackContext = createContext<LayerStackAPI | null>(null);

interface LayerStackProviderProps {
	children: ReactNode;
}

/**
 * LayerStackProvider - Provides global layer stack management and Escape handling
 *
 * This provider creates a centralized layer stack that manages all modals, overlays,
 * and search interfaces. It automatically handles Escape key presses by delegating
 * to the topmost layer's onEscape handler.
 *
 * Usage:
 * Wrap your entire app in this provider:
 * <LayerStackProvider>
 *   <App />
 * </LayerStackProvider>
 */
export function LayerStackProvider({ children }: LayerStackProviderProps) {
	const layerStack = useLayerStackHook();

	// Global Escape key handler - delegates to top layer
	// We use a ref to always have access to the latest layerStack methods
	const layerStackRef = React.useRef(layerStack);
	layerStackRef.current = layerStack;

	useEffect(() => {
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				// The one thing Escape unwinds before the layer stack. An armed Deck
				// mode owns the next keystroke (see the Deck block in
				// useMainKeyboardHandler), and Escape is how the user cancels it -
				// closing their modal in the same keypress would charge them twice
				// for one mistyped leader. Declining here, with no preventDefault and
				// no stopPropagation, is what lets the event reach the bubble-phase
				// handler that disarms it: this listener is in the CAPTURE phase, so
				// acting would end the event before anything else saw it.
				//
				// Only reached on Escape, and only asks the question then, so the
				// hottest keyboard path pays nothing for it.
				if (deckModeArmedNow()) return;

				const stack = layerStackRef.current;
				const topLayer = stack.getTopLayer();
				if (topLayer) {
					// Prevent default Escape behavior and stop propagation
					e.preventDefault();
					e.stopPropagation();

					// Close the top layer (async but we don't need to await here since
					// we've already prevented default - the modal will close asynchronously)
					void stack.closeTopLayer();
				}
			}
		};

		// Use capture phase to handle Escape before it reaches child components
		window.addEventListener('keydown', handleEscape, { capture: true });

		return () => {
			window.removeEventListener('keydown', handleEscape, { capture: true });
		};
	}, []); // Empty deps - handler uses ref to get latest stack

	// Phones have no Escape key: a swipe down from the top of the screen closes
	// the top layer through the same path. Inert everywhere else (see the hook).
	const swipeDismissApi = useMemo(
		() => ({
			hasTopLayer: () => !!layerStackRef.current.getTopLayer(),
			closeTopLayer: () => layerStackRef.current.closeTopLayer(),
		}),
		[]
	);
	useLayerSwipeDismiss(swipeDismissApi);

	return <LayerStackContext.Provider value={layerStack}>{children}</LayerStackContext.Provider>;
}

/**
 * useLayerStack - Hook to access the layer stack API
 *
 * Must be used within a LayerStackProvider. Throws an error if used outside.
 *
 * @returns LayerStackAPI - Methods to register, unregister, and manage layers
 *
 * @example
 * const { registerLayer, unregisterLayer } = useLayerStack();
 *
 * useEffect(() => {
 *   const layerId = registerLayer({
 *     type: 'modal',
 *     priority: MODAL_PRIORITIES.SETTINGS,
 *     onEscape: () => setOpen(false),
 *     // ... other layer properties
 *   });
 *
 *   return () => unregisterLayer(layerId);
 * }, []);
 */
export function useLayerStack(): LayerStackAPI {
	const context = useContext(LayerStackContext);

	if (!context) {
		throw new Error('useLayerStack must be used within a LayerStackProvider');
	}

	return context;
}
