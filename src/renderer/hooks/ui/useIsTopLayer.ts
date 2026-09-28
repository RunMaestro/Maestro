/**
 * Is this surface the topmost layer right now?
 *
 * A surface that binds a bare key (no modifier) has to stop listening the
 * moment something opens on top of it, or the key reaches two surfaces at
 * once - the organizer's zoom keys would keep firing behind an open lightbox.
 * The layer stack already knows the answer; this is the one-line read of it.
 *
 * Matching is by PRIORITY rather than layer id, because `useModalLayer` owns
 * the registration and never hands the id back. Priorities are unique per
 * surface in `MODAL_PRIORITIES`, so the comparison is exact.
 */

import { useLayerStack } from '../../contexts/LayerStackContext';

/**
 * @param priority the surface's own `MODAL_PRIORITIES` entry.
 * @returns true while that surface is the top layer in the stack.
 */
export function useIsTopLayer(priority: number): boolean {
	const { getLayers } = useLayerStack();
	const layers = getLayers();
	return layers[layers.length - 1]?.priority === priority;
}
