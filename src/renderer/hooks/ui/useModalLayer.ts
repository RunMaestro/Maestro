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

import { useEffect, useLayoutEffect, useRef } from 'react';
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
	 * Whether this layer suppresses the app's global shortcuts. Defaults to true.
	 *
	 * Pass `false` for a PASSIVE panel - a floating inspector or log viewer that
	 * takes no focus and registers only so Escape closes it at the right
	 * priority. Otherwise its mere presence makes Cmd+K, Opt+Cmd+T, and the
	 * file-tree keys go dead until the user closes it.
	 */
	blocksAppShortcuts?: boolean;
	/**
	 * Whether the layer should be registered. Defaults to true.
	 * Set to `false` (e.g. when `!isOpen`) to skip registration without
	 * unmounting the host component.
	 */
	enabled?: boolean;
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
		blocksAppShortcuts = true,
		enabled = true,
	} = options;

	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const onEscapeRef = useRef(onEscape);
	onEscapeRef.current = onEscape;

	// Snapshot what had focus before this modal took the keyboard, in a LAYOUT
	// effect so it is taken before any passive effect the host runs to focus its
	// own content. Registration below is passive, and effects fire in hook-call
	// order, so a host that calls `useFocusOnMount(ref, 0)` above this hook had
	// already moved focus onto its own surface by the time the stack looked -
	// the stack then "restored" to an element that unmounts with the modal,
	// which strands the caret on `document.body` and makes the next keystroke
	// (Ctrl+Enter in the composer) a no-op. Capturing here means the order a
	// host calls its hooks in cannot change the answer.
	const focusOriginRef = useRef<HTMLElement | null>(null);
	useLayoutEffect(() => {
		if (!enabled) {
			focusOriginRef.current = null;
			return;
		}
		const origin = document.activeElement;
		focusOriginRef.current =
			origin instanceof HTMLElement && origin !== document.body ? origin : null;
	}, [enabled]);

	// Register layer on mount (and re-register when `enabled` flips)
	useEffect(() => {
		if (!enabled) {
			return;
		}

		const id = registerLayer({
			focusOrigin: focusOriginRef.current,
			type: 'modal',
			priority,
			blocksLowerLayers,
			capturesFocus,
			blocksAppShortcuts,
			focusTrap,
			ariaLabel,
			isDirty,
			onBeforeClose,
			onEscape: () => onEscapeRef.current(),
		});
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
		blocksAppShortcuts,
		focusTrap,
		isDirty,
		onBeforeClose,
	]);

	// Update handler when onEscape changes (without re-registering)
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, () => onEscapeRef.current());
		}
	}, [onEscape, updateLayerHandler]);
}
