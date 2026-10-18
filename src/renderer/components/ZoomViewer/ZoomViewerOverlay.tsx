/**
 * ZoomViewerOverlay - full-window pan/zoom view of one diagram or image,
 * mounted once at the app root and driven by zoomViewerStore.
 *
 * Any surface opens it with `openZoomViewer(element)`: the Mermaid expand
 * button, markdown images in chat, and the "Expand" item of the app-wide image
 * right-click menu (which covers every other image and diagram on screen).
 *
 * An `<svg>` is CLONED rather than re-rendered: the clone is the exact themed,
 * sanitized drawing the user was looking at. It is refitted to fill the stage
 * (viewBox kept, fixed width/height dropped) so a diagram squeezed into a chat
 * column opens at full window size. An `<img>` is shown from its resolved src.
 *
 * Input: wheel or pinch zooms about the cursor, drag pans, double-click fits,
 * `+` `-` `0` step and reset (shared useScaleShortcuts), arrows pan, Escape
 * closes through the layer stack.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import type { Theme } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useIsTopLayer } from '../../hooks/ui/useIsTopLayer';
import { usePanZoom } from '../../hooks/ui/usePanZoom';
import { useScaleShortcuts } from '../../hooks/ui/useScaleShortcuts';
import type { UseScalePreferenceReturn } from '../../hooks/ui/useScalePreference';
import { useFocusOnMount } from '../../hooks/utils/useFocusAfterRender';
import { isTextInputTarget } from '../../utils/messageScrollNavigation';
import { isSvgElement } from '../../utils/imageExport';
import { GhostIconButton } from '../ui/GhostIconButton';
import { EscCloseButton } from '../ui/EscCloseButton';
import { useZoomViewerStore, ZOOM_VIEWER_ATTR, type ZoomViewerRequest } from './zoomViewerStore';

/** Vector content stays sharp at any zoom, so it gets more headroom than a bitmap. */
const SVG_MAX_ZOOM = 40;
const IMAGE_MAX_ZOOM = 10;
/** Arrow-key pan step, in screen pixels. */
const PAN_STEP = 60;

/**
 * Copy an on-screen SVG and make it scale to whatever box it is placed in.
 *
 * Mermaid (`useMaxWidth`) and agent-authored SVG pin their size with
 * `width`/`height` attributes or an inline max-width. Those are dropped and the
 * drawing is sized 100% x 100% with `meet`, which only works when there is a
 * viewBox to scale, so one is derived from the rendered size when missing.
 */
export function prepareSvgForViewer(source: SVGSVGElement): SVGSVGElement {
	const clone = source.cloneNode(true) as SVGSVGElement;
	if (!clone.getAttribute('viewBox')) {
		const rect = source.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			clone.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
		}
	}
	clone.removeAttribute('width');
	clone.removeAttribute('height');
	clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');
	clone.style.maxWidth = 'none';
	clone.style.maxHeight = 'none';
	clone.style.width = '100%';
	clone.style.height = '100%';
	return clone;
}

function defaultTitle(element: ZoomViewerRequest['element']): string {
	if (isSvgElement(element)) return 'Diagram';
	return element.alt || 'Image';
}

interface ZoomViewerOverlayProps {
	request: ZoomViewerRequest;
	theme: Theme;
	onClose: () => void;
}

export function ZoomViewerOverlay({ request, theme, onClose }: ZoomViewerOverlayProps) {
	const { element } = request;
	const isSvg = isSvgElement(element);
	const rootRef = useRef<HTMLDivElement>(null);
	const svgHostRef = useRef<HTMLDivElement>(null);
	const panZoom = usePanZoom({ maxZoom: isSvg ? SVG_MAX_ZOOM : IMAGE_MAX_ZOOM });
	const { containerRef, zoom, dragging, transform, onMouseDown, zoomIn, zoomOut, fitToView } =
		panZoom;

	useModalLayer(MODAL_PRIORITIES.ZOOM_VIEWER, 'Zoomed view', onClose);
	useFocusOnMount(rootRef);
	const isTop = useIsTopLayer(MODAL_PRIORITIES.ZOOM_VIEWER);

	const scaleControl = useMemo<UseScalePreferenceReturn>(
		() => ({
			scale: zoom,
			adjustScale: (direction) => (direction > 0 ? zoomIn() : zoomOut()),
			resetScale: fitToView,
			canDecrease: panZoom.canZoomOut,
			canIncrease: panZoom.canZoomIn,
		}),
		[zoom, zoomIn, zoomOut, fitToView, panZoom.canZoomOut, panZoom.canZoomIn]
	);
	useScaleShortcuts(scaleControl, { enabled: isTop });

	// Arrow keys pan. The content moves opposite to the key, like scrolling.
	const panBy = panZoom.panBy;
	useEffect(() => {
		if (!isTop) return;
		const handler = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			if (isTextInputTarget(e.target)) return;
			const step = e.shiftKey ? PAN_STEP * 4 : PAN_STEP;
			const delta: Record<string, [number, number]> = {
				ArrowLeft: [step, 0],
				ArrowRight: [-step, 0],
				ArrowUp: [0, step],
				ArrowDown: [0, -step],
			};
			const d = delta[e.key];
			if (!d) return;
			e.preventDefault();
			e.stopPropagation();
			panBy(d[0], d[1]);
		};
		window.addEventListener('keydown', handler, { capture: true });
		return () => window.removeEventListener('keydown', handler, { capture: true });
	}, [isTop, panBy]);

	useLayoutEffect(() => {
		const host = svgHostRef.current;
		if (!host || !isSvg) return;
		host.replaceChildren(prepareSvgForViewer(element));
		return () => host.replaceChildren();
	}, [element, isSvg]);

	const handleDoubleClick = useCallback(() => fitToView(), [fitToView]);

	const title = request.title || defaultTitle(element);
	const imageSrc = isSvg ? '' : element.currentSrc || element.src;

	return createPortal(
		<div
			ref={rootRef}
			className="fixed inset-0 z-[9999] flex flex-col select-none outline-none"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="dialog"
			aria-modal="true"
			aria-label={`Zoomed view: ${title}`}
			tabIndex={-1}
			data-testid="zoom-viewer"
			{...{ [ZOOM_VIEWER_ATTR]: '' }}
		>
			<div
				className="flex items-center gap-2 px-3 py-2 shrink-0 border-b"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			>
				<span className="text-xs truncate flex-1 min-w-0" style={{ color: theme.colors.textDim }}>
					{title}
				</span>
				<GhostIconButton
					onClick={zoomOut}
					disabled={!panZoom.canZoomOut}
					title="Zoom out (-)"
					ariaLabel="Zoom out"
					color={theme.colors.textDim}
				>
					<ZoomOut className="w-4 h-4" />
				</GhostIconButton>
				<span
					className="text-xs font-mono w-12 text-center"
					style={{ color: theme.colors.textMain }}
					data-testid="zoom-viewer-percent"
				>
					{Math.round(zoom * 100)}%
				</span>
				<GhostIconButton
					onClick={zoomIn}
					disabled={!panZoom.canZoomIn}
					title="Zoom in (+)"
					ariaLabel="Zoom in"
					color={theme.colors.textDim}
				>
					<ZoomIn className="w-4 h-4" />
				</GhostIconButton>
				<GhostIconButton
					onClick={fitToView}
					title="Fit to window (0)"
					ariaLabel="Fit to window"
					color={theme.colors.textDim}
				>
					<Maximize className="w-4 h-4" />
				</GhostIconButton>
				<EscCloseButton theme={theme} onClose={onClose} className="ml-1" />
			</div>

			<div
				ref={containerRef}
				className="flex-1 relative overflow-hidden"
				style={{ cursor: dragging ? 'grabbing' : 'grab' }}
				onMouseDown={onMouseDown}
				onDoubleClick={handleDoubleClick}
			>
				<div
					className="absolute inset-0 p-8 flex items-center justify-center"
					// No will-change here: it would rasterize the SVG once at zoom 1
					// and blur it as it scales. Without it Chromium redraws the vector.
					style={{ transform, transformOrigin: 'center center' }}
				>
					{isSvg ? (
						<div ref={svgHostRef} className="w-full h-full" />
					) : (
						<img
							src={imageSrc}
							alt={element.alt}
							className="max-w-full max-h-full object-contain"
							style={{ imageRendering: zoom > 2 ? 'pixelated' : 'auto' }}
							draggable={false}
						/>
					)}
				</div>
			</div>

			<div
				className="shrink-0 py-1 text-center text-2xs"
				style={{ color: theme.colors.textDim, backgroundColor: theme.colors.bgSidebar }}
			>
				Scroll or pinch to zoom · Drag or arrows to pan · Double-click or 0 to fit · Esc to close
			</div>
		</div>,
		document.body
	);
}

/** App-root host: renders the overlay while the store holds a request. */
export function ZoomViewerHost({ theme }: { theme: Theme }) {
	const request = useZoomViewerStore((s) => s.request);
	const close = useZoomViewerStore((s) => s.close);
	if (!request) return null;
	return <ZoomViewerOverlay request={request} theme={theme} onClose={close} />;
}
