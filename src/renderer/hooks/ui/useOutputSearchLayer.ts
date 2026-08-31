/**
 * Shared Escape-layer lifecycle for the Find bar used by AI chat and group chat.
 * Keeps overlay options identical so both surfaces dismiss the same way.
 */
import { useEffect, useRef } from 'react';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

const OUTPUT_SEARCH_INPUT_SELECTOR = '[data-output-search-input]';

export interface UseOutputSearchLayerOptions {
	open: boolean;
	onEscape: () => void;
	ariaLabel: string;
	/** When true, focus the Find input after open (default true). */
	focusInputOnOpen?: boolean;
}

export function useOutputSearchLayer({
	open,
	onEscape,
	ariaLabel,
	focusInputOnOpen = true,
}: UseOutputSearchLayerOptions): void {
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();

	useEffect(() => {
		if (!open) return;
		layerIdRef.current = registerLayer({
			type: 'overlay',
			priority: MODAL_PRIORITIES.SLASH_AUTOCOMPLETE,
			blocksLowerLayers: false,
			capturesFocus: true,
			focusTrap: 'none',
			onEscape,
			allowClickOutside: true,
			ariaLabel,
		});
		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [open, registerLayer, unregisterLayer, onEscape, ariaLabel]);

	useEffect(() => {
		if (open && layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, onEscape);
		}
	}, [open, updateLayerHandler, onEscape]);

	useEffect(() => {
		if (open && focusInputOnOpen) {
			document.querySelector<HTMLInputElement>(OUTPUT_SEARCH_INPUT_SELECTOR)?.focus();
		}
	}, [open, focusInputOnOpen]);
}

/** Selector used by the global Cmd+F refocus path for an already-open Find bar. */
export const OUTPUT_SEARCH_INPUT_ATTR = 'data-output-search-input';
export { OUTPUT_SEARCH_INPUT_SELECTOR };
