/**
 * useImageContextMenu - shared state for the right-click "Copy Image / Save
 * Image" menu on images rendered in AI chat.
 *
 * Two rendering routes need the menu and they resolve their target differently:
 *  - Elements React owns (a markdown `<img>`, an agent-authored inline `<svg>`)
 *    attach `openImageMenuFromEvent` directly.
 *  - Mermaid diagrams, whose `<svg>` is injected imperatively into a container
 *    div and therefore never passes through React's element tree, hang the same
 *    handler off the container - the click target decides which image the menu
 *    acts on, so a container holding several diagrams still works.
 */

import { useCallback, useState } from 'react';
import type React from 'react';
import type { ImageContextMenuState } from '../../components/ImageContextMenu';
import type { ExportableImage } from '../../utils/imageExport';

export interface UseImageContextMenu {
	imageMenu: ImageContextMenuState | null;
	dismissImageMenu: () => void;
	/** Open the menu for an element resolved by the caller. */
	openImageMenu: (target: ExportableImage, x: number, y: number) => void;
	/**
	 * Right-click handler that resolves the image out of the event. Works both on
	 * the image itself and on a container holding an imperatively injected one.
	 */
	openImageMenuFromEvent: (e: React.MouseEvent) => void;
}

export function useImageContextMenu(): UseImageContextMenu {
	const [imageMenu, setImageMenu] = useState<ImageContextMenuState | null>(null);

	const dismissImageMenu = useCallback(() => setImageMenu(null), []);

	const openImageMenu = useCallback(
		(target: ExportableImage, x: number, y: number) => setImageMenu({ x, y, target }),
		[]
	);

	const openImageMenuFromEvent = useCallback((e: React.MouseEvent) => {
		const target = e.target as Element | null;
		// Prefer the image the click actually landed in. Falling back to the
		// container's only image keeps a right-click on a single-diagram wrapper's
		// padding working; a container with several images (or none) gets no menu
		// unless the click hit one.
		const hit = target?.closest?.('svg, img') as ExportableImage | null;
		const all = (e.currentTarget as Element).querySelectorAll('svg, img');
		const resolved = hit ?? (all.length === 1 ? (all[0] as ExportableImage) : null);
		if (!resolved) return;
		e.preventDefault();
		setImageMenu({ x: e.clientX, y: e.clientY, target: resolved });
	}, []);

	return { imageMenu, dismissImageMenu, openImageMenu, openImageMenuFromEvent };
}
