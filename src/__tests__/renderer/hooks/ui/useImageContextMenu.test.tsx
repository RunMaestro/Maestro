/**
 * Tests for useImageContextMenu - the shared state behind the chat "Copy Image /
 * Save Image" right-click menu.
 *
 * The interesting logic is target resolution: the handler is attached to whole
 * containers (a mermaid wrapper, a strip of transcript thumbnails), so it has to
 * pick the image the click actually landed on rather than assume there is one.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type React from 'react';
import { useImageContextMenu } from '../../../../renderer/hooks/ui/useImageContextMenu';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Minimal stand-in for the React synthetic event the handler consumes. */
function contextMenuEvent(
	target: Element,
	currentTarget: Element,
	x = 42,
	y = 99
): React.MouseEvent & { defaultPrevented: boolean } {
	const event = {
		target,
		currentTarget,
		clientX: x,
		clientY: y,
		defaultPrevented: false,
		preventDefault() {
			event.defaultPrevented = true;
		},
	};
	return event as unknown as React.MouseEvent & { defaultPrevented: boolean };
}

function container(html: string): HTMLElement {
	const el = document.createElement('div');
	el.innerHTML = html;
	return el;
}

describe('useImageContextMenu', () => {
	it('opens at the pointer for an element the caller resolved', () => {
		const { result } = renderHook(() => useImageContextMenu());
		const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;

		act(() => result.current.openImageMenu(svg, 12, 34));

		expect(result.current.imageMenu).toEqual({ x: 12, y: 34, target: svg });

		act(() => result.current.dismissImageMenu());
		expect(result.current.imageMenu).toBeNull();
	});

	it('resolves the image the click landed in, not the container', () => {
		const { result } = renderHook(() => useImageContextMenu());
		const root = container('<img id="a" src="data:,a" /><img id="b" src="data:,b" />');
		const clicked = root.querySelector('#b')!;

		const event = contextMenuEvent(clicked, root);
		act(() => result.current.openImageMenuFromEvent(event));

		expect(result.current.imageMenu?.target).toBe(clicked);
		expect(result.current.imageMenu).toMatchObject({ x: 42, y: 99 });
		// The browser's own menu must not also open.
		expect(event.defaultPrevented).toBe(true);
	});

	it('walks up to the enclosing image when the click lands on a child node', () => {
		const { result } = renderHook(() => useImageContextMenu());
		const root = container('<div><svg><circle r="4"></circle></svg></div>');
		const circle = root.querySelector('circle')!;

		act(() => result.current.openImageMenuFromEvent(contextMenuEvent(circle, root)));

		expect(result.current.imageMenu?.target).toBe(root.querySelector('svg'));
	});

	it('falls back to the only image in the container when the click misses it', () => {
		const { result } = renderHook(() => useImageContextMenu());
		const root = container('<svg></svg>');

		// Right-click on the wrapper's padding, outside the diagram itself.
		act(() => result.current.openImageMenuFromEvent(contextMenuEvent(root, root)));

		expect(result.current.imageMenu?.target).toBe(root.querySelector('svg'));
	});

	it('stays closed when the container holds no image', () => {
		const { result } = renderHook(() => useImageContextMenu());
		const root = container('<p>no image here</p>');

		const event = contextMenuEvent(root.querySelector('p')!, root);
		act(() => result.current.openImageMenuFromEvent(event));

		expect(result.current.imageMenu).toBeNull();
		// Nothing to act on, so the default browser menu is left alone.
		expect(event.defaultPrevented).toBe(false);
	});

	it('stays closed when a multi-image container is clicked outside every image', () => {
		const { result } = renderHook(() => useImageContextMenu());
		const root = container('<svg></svg><svg></svg>');

		act(() => result.current.openImageMenuFromEvent(contextMenuEvent(root, root)));

		expect(result.current.imageMenu).toBeNull();
	});
});
