/**
 * useModalLayer - Reusable hook for modal layer stack registration
 *
 * This hook encapsulates the common pattern of registering a modal with the
 * centralized layer stack. It handles:
 * - Layer registration on mount
 * - Layer unregistration on unmount
 * - Handler updates when the escape callback changes
 *
 * Usage:
 * ```tsx
 * function MyModal({ onClose }: { onClose: () => void }) {
 *   useModalLayer(MODAL_PRIORITIES.MY_MODAL, 'My Modal', onClose);
 *
 *   return <div>...</div>;
 * }
 * ```
 *
 * For modals with custom escape handling (e.g., checking for nested overlays):
 * ```tsx
 * const handleEscape = useCallback(() => {
 *   if (subOverlayOpen) {
 *     closeSubOverlay();
 *     return;
 *   }
 *   onClose();
 * }, [subOverlayOpen, onClose]);
 *
 * useModalLayer(MODAL_PRIORITIES.MY_MODAL, 'My Modal', handleEscape);
 * ```
 */

import { useEffect, useRef } from 'react';
import { useLayerStack } from '../../contexts/LayerStackContext';
import type { FocusTrapMode } from '../../types/layer';

export interface UseModalLayerOptions {
	/** Whether the modal has unsaved changes */
	isDirty?: boolean;
	/** Callback to confirm closing when dirty - return false to prevent close */
	onBeforeClose?: () => boolean | Promise<boolean>;
	/** Focus trap behavior. Defaults to 'strict' */
	focusTrap?: FocusTrapMode;
	/** Whether this layer blocks interaction with layers below. Defaults to true */
	blocksLowerLayers?: boolean;
	/** Whether this layer captures keyboard focus. Defaults to true */
	capturesFocus?: boolean;
}

/**
 * Register a modal with the layer stack
 *
 * @param priority - Modal priority from MODAL_PRIORITIES constant
 * @param ariaLabel - Accessibility label for the modal
 * @param onEscape - Callback when Escape is pressed (typically onClose)
 * @param options - Additional options for layer configuration
 *
 * @example
 * // Simple usage
 * useModalLayer(MODAL_PRIORITIES.SETTINGS, 'Settings', onClose);
 *
 * @example
 * // With options
 * useModalLayer(MODAL_PRIORITIES.EDITOR, 'Editor', onClose, {
 *   isDirty: hasUnsavedChanges,
 *   onBeforeClose: async () => {
 *     return await confirmDiscard();
 *   }
 * });
 */
export function useModalLayer(
	priority: number,
	ariaLabel: string,
	onEscape: () => void,
	options: UseModalLayerOptions = {}
): void {
	const {
		isDirty,
		onBeforeClose,
		focusTrap = 'strict',
		blocksLowerLayers = true,
		capturesFocus = true,
	} = options;

	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();

	// Register layer on mount
	useEffect(() => {
		const id = registerLayer({
			type: 'modal',
			priority,
			blocksLowerLayers,
			capturesFocus,
			focusTrap,
			ariaLabel,
			isDirty,
			onBeforeClose,
			onEscape,
		});
		layerIdRef.current = id;

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [
		registerLayer,
		unregisterLayer,
		priority,
		ariaLabel,
		blocksLowerLayers,
		capturesFocus,
		focusTrap,
		isDirty,
		onBeforeClose,
	]);

	// Update handler when onEscape changes (without re-registering)
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, onEscape);
		}
	}, [onEscape, updateLayerHandler]);
}
