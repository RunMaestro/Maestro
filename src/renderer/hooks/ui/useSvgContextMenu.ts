/**
 * useSvgContextMenu - shared state for the right-click "Copy Image / Save Image"
 * menu on rendered SVG diagrams.
 *
 * Two kinds of SVG show up in the app and both need the menu:
 *  - Inline <svg> authored by an agent in markdown, rendered by React (the chat
 *    component map attaches onContextMenu directly and calls `openSvgMenu`).
 *  - Mermaid diagrams, whose <svg> is injected imperatively into a container div
 *    and therefore never passes through React's element tree - those use
 *    `openSvgMenuFromContainer`, which resolves the <svg> out of the container.
 */

import { useCallback, useState } from 'react';
import type React from 'react';
import type { SvgContextMenuState } from '../../components/SvgContextMenu';

export interface UseSvgContextMenu {
	svgMenu: SvgContextMenuState | null;
	dismissSvgMenu: () => void;
	/** Open the menu for an <svg> React already knows about. */
	openSvgMenu: (svg: SVGSVGElement, x: number, y: number) => void;
	/** Right-click handler for a container holding an imperatively injected <svg>. */
	openSvgMenuFromContainer: (e: React.MouseEvent<HTMLElement>) => void;
}

export function useSvgContextMenu(): UseSvgContextMenu {
	const [svgMenu, setSvgMenu] = useState<SvgContextMenuState | null>(null);

	const dismissSvgMenu = useCallback(() => setSvgMenu(null), []);

	const openSvgMenu = useCallback(
		(svg: SVGSVGElement, x: number, y: number) => setSvgMenu({ x, y, svg }),
		[]
	);

	const openSvgMenuFromContainer = useCallback((e: React.MouseEvent<HTMLElement>) => {
		const svg = e.currentTarget.querySelector('svg');
		if (!svg) return;
		e.preventDefault();
		setSvgMenu({ x: e.clientX, y: e.clientY, svg });
	}, []);

	return { svgMenu, dismissSvgMenu, openSvgMenu, openSvgMenuFromContainer };
}
