/**
 * Layer Stack Type System
 *
 * This module defines the type system for the centralized layer stack management.
 * Layers represent UI elements that can capture focus and handle escape key events,
 * such as modals, overlays, search interfaces, and inline editors.
 */

/**
 * Types of layers in the UI hierarchy
 */
export type LayerType = 'modal' | 'overlay';

/**
 * Focus trap behavior modes
 * - strict: Focus must stay within the layer (Tab cycles back to first element)
 * - lenient: Focus can escape but layer still captures keyboard events
 * - none: No focus trapping
 */
export type FocusTrapMode = 'strict' | 'lenient' | 'none';

/**
 * Base properties shared by all layer types
 */
export interface BaseLayer {
	/** Unique identifier for this layer */
	id: string;

	/** Type of layer (discriminant for the union) */
	type: LayerType;

	/** Priority value - higher numbers appear on top */
	priority: number;

	/** Whether this layer blocks interaction with layers below it */
	blocksLowerLayers: boolean;

	/** Whether this layer captures keyboard focus */
	capturesFocus: boolean;

	/** Focus trapping behavior */
	focusTrap: FocusTrapMode;

	/** Optional ARIA label for accessibility */
	ariaLabel?: string;
}

/**
 * Modal layer - Full dialogs that block the entire UI
 */
export interface ModalLayer extends BaseLayer {
	type: 'modal';

	/** Whether the modal has unsaved changes */
	isDirty?: boolean;

	/** Callback to confirm closing when dirty - return false to prevent close */
	onBeforeClose?: () => boolean | Promise<boolean>;

	/** Handler called when Escape is pressed */
	onEscape: () => void;

	/** Optional parent modal ID for nested modals */
	parentModalId?: string;
}

/**
 * Overlay layer - Semi-transparent overlays like file preview, lightbox
 */
export interface OverlayLayer extends BaseLayer {
	type: 'overlay';

	/** Handler called when Escape is pressed */
	onEscape: () => void;

	/** Whether clicking outside the overlay should close it */
	allowClickOutside: boolean;
}

/**
 * Discriminated union of all layer types
 */
export type Layer = ModalLayer | OverlayLayer;

/**
 * Input types for registerLayer (without 'id' field)
 * These are separate types to preserve discriminated union behavior with Omit
 */
export type ModalLayerInput = Omit<ModalLayer, 'id'>;
export type OverlayLayerInput = Omit<OverlayLayer, 'id'>;
export type LayerInput = ModalLayerInput | OverlayLayerInput;

/**
 * Type guard to check if a layer is a modal
 * @internal Only used in tests - production code uses direct property checks
 */
export function isModalLayer(layer: Layer): layer is ModalLayer {
	return layer.type === 'modal';
}

/**
 * Type guard to check if a layer is an overlay
 * @internal Only used in tests - production code uses direct property checks
 */
export function isOverlayLayer(layer: Layer): layer is OverlayLayer {
	return layer.type === 'overlay';
}
