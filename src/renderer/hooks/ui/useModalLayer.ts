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
	/**
	 * Whether the layer should be registered. Defaults to true.
	 * Set to `false` (e.g. when `!isOpen`) to skip registration without
	 * unmounting the host component.
	 */
	enabled?: boolean;
	/**
	 * Layer type. Defaults to `'modal'`. Use `'overlay'` for passive,
	 * non-blocking surfaces (floating inspectors, previews) that should still
	 * take Escape but must NOT count toward `hasOpenModal()` - otherwise simply
	 * opening them suppresses global shortcuts and file-tree navigation.
	 */
	layerType?: 'modal' | 'overlay';
	/** Overlay-only: whether a click outside should close it. Defaults to false. */
	allowClickOutside?: boolean;
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
	ariaLabel: string | undefined,
	onEscape: () => void,
	options: UseModalLayerOptions = {}
): void {
	const {
		isDirty,
		onBeforeClose,
		focusTrap = 'strict',
		blocksLowerLayers = true,
		capturesFocus = true,
		enabled = true,
		layerType = 'modal',
		allowClickOutside = false,
	} = options;

	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const onEscapeRef = useRef(onEscape);
	onEscapeRef.current = onEscape;

	// Register layer on mount (and re-register when `enabled` flips)
	useEffect(() => {
		if (!enabled) {
			return;
		}

		const id = registerLayer(
			layerType === 'overlay'
				? {
						type: 'overlay',
						priority,
						blocksLowerLayers,
						capturesFocus,
						focusTrap,
						ariaLabel,
						onEscape: () => onEscapeRef.current(),
						allowClickOutside,
					}
				: {
						type: 'modal',
						priority,
						blocksLowerLayers,
						capturesFocus,
						focusTrap,
						ariaLabel,
						isDirty,
						onBeforeClose,
						onEscape: () => onEscapeRef.current(),
					}
		);
		layerIdRef.current = id;

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
				layerIdRef.current = undefined;
			}
		};
	}, [
		enabled,
		registerLayer,
		unregisterLayer,
		priority,
		ariaLabel,
		blocksLowerLayers,
		capturesFocus,
		focusTrap,
		isDirty,
		onBeforeClose,
		layerType,
		allowClickOutside,
	]);

	// Update handler when onEscape changes (without re-registering)
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, () => onEscapeRef.current());
		}
	}, [onEscape, updateLayerHandler]);
}
