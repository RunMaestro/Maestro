/**
 * zoomViewerStore - which diagram or image the full-screen ZoomViewerOverlay
 * is showing, if any.
 *
 * Callers hand over the rendered element itself (a Mermaid `<svg>`, a markdown
 * `<img>`), not its source. The element is already laid out, themed, and
 * sanitized, so the viewer clones what the user is looking at instead of
 * re-rendering it and risking a different result.
 */

import { create } from 'zustand';
import type { ExportableImage } from '../../utils/imageExport';

/** Marks the overlay root so the image right-click menu can tell it is inside. */
export const ZOOM_VIEWER_ATTR = 'data-zoom-viewer';

export interface ZoomViewerRequest {
	element: ExportableImage;
	/** Shown in the viewer header; falls back to "Diagram" or "Image". */
	title?: string;
}

interface ZoomViewerState {
	request: ZoomViewerRequest | null;
	open: (element: ExportableImage, title?: string) => void;
	close: () => void;
}

export const useZoomViewerStore = create<ZoomViewerState>((set) => ({
	request: null,
	open: (element, title) => set({ request: { element, title } }),
	close: () => set({ request: null }),
}));

/** Open the full-screen pan/zoom viewer on a rendered diagram or image. */
export function openZoomViewer(element: ExportableImage, title?: string): void {
	useZoomViewerStore.getState().open(element, title);
}
