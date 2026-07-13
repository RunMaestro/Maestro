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
 *    The container may hold one diagram (MermaidRenderer) or many (the Fast
 *    markdown tier renders every diagram in a document into one scroll root),
 *    so the click target decides which <svg> the menu acts on.
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
		const target = e.target as Element | null;
		// Prefer the <svg> the click actually landed in. Falling back to the
		// container's only <svg> keeps a right-click on a single-diagram
		// wrapper's padding working; a container with several diagrams (or none)
		// gets no menu unless the click hit one.
		const hit = target?.closest?.('svg') as SVGSVGElement | null;
		const all = e.currentTarget.querySelectorAll('svg');
		const svg = hit ?? (all.length === 1 ? (all[0] as SVGSVGElement) : null);
		if (!svg) return;
		e.preventDefault();
		setSvgMenu({ x: e.clientX, y: e.clientY, svg });
	}, []);

	return { svgMenu, dismissSvgMenu, openSvgMenu, openSvgMenuFromContainer };
}
