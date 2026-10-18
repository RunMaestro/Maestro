/**
 * ZoomViewerOverlay / ZoomViewerHost - the full-screen pan/zoom view any
 * diagram or image opens into.
 *
 * Pinned: an SVG is shown as a refitted CLONE (the original stays in the
 * transcript untouched), an image is shown from its src, the store drives the
 * host, and every way out (Escape through the layer stack, the ESC pill) closes
 * it. Keyboard zoom rides the shared useScaleShortcuts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import {
	ZoomViewerHost,
	prepareSvgForViewer,
} from '../../../../renderer/components/ZoomViewer/ZoomViewerOverlay';
import {
	openZoomViewer,
	useZoomViewerStore,
} from '../../../../renderer/components/ZoomViewer/zoomViewerStore';
import { mockTheme } from '../../../helpers/mockTheme';

const SVG_NS = 'http://www.w3.org/2000/svg';

function makeSvg(attrs: Record<string, string>): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
	for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
	svg.appendChild(document.createElementNS(SVG_NS, 'rect'));
	return svg;
}

function renderHost() {
	return render(
		<LayerStackProvider>
			<ZoomViewerHost theme={mockTheme} />
		</LayerStackProvider>
	);
}

describe('prepareSvgForViewer', () => {
	it('clones, drops the fixed size, and fills its box with the viewBox kept', () => {
		const source = makeSvg({ viewBox: '0 0 400 200', width: '100%', style: 'max-width: 400px;' });
		const clone = prepareSvgForViewer(source);

		expect(clone).not.toBe(source);
		expect(clone.querySelector('rect')).not.toBeNull();
		expect(clone.getAttribute('viewBox')).toBe('0 0 400 200');
		expect(clone.hasAttribute('width')).toBe(false);
		expect(clone.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
		expect(clone.style.maxWidth).toBe('none');
		expect(clone.style.width).toBe('100%');
		expect(clone.style.height).toBe('100%');
		// The on-screen original is untouched.
		expect(source.getAttribute('width')).toBe('100%');
		expect(source.style.maxWidth).toBe('400px');
	});

	it('derives a viewBox from the rendered size when the SVG has none', () => {
		// Without a viewBox, 100% x 100% would enlarge the canvas but not the drawing.
		const source = makeSvg({ width: '300', height: '150' });
		source.getBoundingClientRect = () => ({ width: 300, height: 150 }) as DOMRect;
		expect(prepareSvgForViewer(source).getAttribute('viewBox')).toBe('0 0 300 150');
	});
});

describe('ZoomViewerHost', () => {
	beforeEach(() => {
		act(() => useZoomViewerStore.getState().close());
	});

	afterEach(() => {
		act(() => useZoomViewerStore.getState().close());
	});

	it('renders nothing until something is opened', () => {
		renderHost();
		expect(screen.queryByTestId('zoom-viewer')).toBeNull();
	});

	it('shows a clone of an opened diagram, titled "Diagram" by default', () => {
		renderHost();
		const source = makeSvg({ viewBox: '0 0 10 10' });
		document.body.appendChild(source);

		act(() => openZoomViewer(source));

		const viewer = screen.getByTestId('zoom-viewer');
		const shown = viewer.querySelector('svg:not(.lucide)');
		expect(shown).not.toBeNull();
		expect(shown).not.toBe(source);
		expect(source.isConnected).toBe(true);
		expect(screen.getByText('Diagram')).toBeInTheDocument();
		source.remove();
	});

	it('shows an opened image from its src, titled by its alt text', () => {
		renderHost();
		const img = document.createElement('img');
		img.src = 'data:image/png;base64,iVBORw0KGgo=';
		img.alt = 'Topology';

		act(() => openZoomViewer(img));

		const shown = screen.getByTestId('zoom-viewer').querySelector('img');
		expect(shown?.getAttribute('src')).toBe(img.src);
		expect(screen.getByText('Topology')).toBeInTheDocument();
	});

	it('prefers an explicit title', () => {
		renderHost();
		act(() => openZoomViewer(makeSvg({ viewBox: '0 0 1 1' }), 'Kickoff flow'));
		expect(screen.getByText('Kickoff flow')).toBeInTheDocument();
	});

	it('closes on Escape through the layer stack', () => {
		renderHost();
		act(() => openZoomViewer(makeSvg({ viewBox: '0 0 1 1' })));
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.queryByTestId('zoom-viewer')).toBeNull();
		expect(useZoomViewerStore.getState().request).toBeNull();
	});

	it('closes from the ESC pill', () => {
		renderHost();
		act(() => openZoomViewer(makeSvg({ viewBox: '0 0 1 1' })));
		fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }));
		expect(screen.queryByTestId('zoom-viewer')).toBeNull();
	});

	it('zooms from the toolbar and the bare + / - / 0 keys', () => {
		renderHost();
		act(() => openZoomViewer(makeSvg({ viewBox: '0 0 1 1' })));
		const percent = () => screen.getByTestId('zoom-viewer-percent').textContent;

		expect(percent()).toBe('100%');
		fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
		expect(percent()).toBe('125%');
		fireEvent.keyDown(window, { key: '+' });
		expect(percent()).toBe('156%');
		fireEvent.keyDown(window, { key: '0' });
		expect(percent()).toBe('100%');
		fireEvent.keyDown(window, { key: '-' });
		expect(percent()).toBe('80%');
	});

	it('marks its root so the image menu can tell it is inside the viewer', () => {
		renderHost();
		act(() => openZoomViewer(makeSvg({ viewBox: '0 0 1 1' })));
		expect(screen.getByTestId('zoom-viewer').hasAttribute('data-zoom-viewer')).toBe(true);
	});
});
