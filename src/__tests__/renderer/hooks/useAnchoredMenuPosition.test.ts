/**
 * Tests for useAnchoredMenuPosition - placement of a portaled menu against an
 * anchor element.
 *
 * The side placements ('right' / 'left') are what nested context-menu flyouts
 * use. They exist because a flyout cannot be an `absolute; left: 100%` child of
 * a context menu: the menu carries `overflow-y: auto` so a long one scrolls,
 * and CSS computes `overflow-x` to `auto` as soon as the other axis is not
 * `visible`, which clips the flyout out of view entirely.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useAnchoredMenuPosition } from '../../../renderer/hooks/ui/useAnchoredMenuPosition';

describe('useAnchoredMenuPosition', () => {
	const originalInnerWidth = window.innerWidth;
	const originalInnerHeight = window.innerHeight;
	const created: HTMLElement[] = [];

	afterEach(() => {
		Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
		Object.defineProperty(window, 'innerHeight', {
			value: originalInnerHeight,
			configurable: true,
		});
		created.splice(0).forEach((el) => el.remove());
	});

	function setupViewport(width: number, height: number) {
		Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
		Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
	}

	/** A real element whose measured box is fixed, so placement math is testable. */
	function elementWithRect(rect: { left: number; top: number; width: number; height: number }) {
		const el = document.createElement('div');
		el.getBoundingClientRect = () =>
			({
				left: rect.left,
				top: rect.top,
				right: rect.left + rect.width,
				bottom: rect.top + rect.height,
				width: rect.width,
				height: rect.height,
				x: rect.left,
				y: rect.top,
				toJSON: () => ({}),
			}) as DOMRect;
		document.body.appendChild(el);
		created.push(el);
		return el;
	}

	function placeBeside(
		anchorEl: HTMLElement,
		menuEl: HTMLElement,
		options: Parameters<typeof useAnchoredMenuPosition>[2]
	) {
		return renderHook(() => {
			const menuRef = useRef<HTMLElement>(menuEl);
			const anchorRef = useRef<HTMLElement>(anchorEl);
			return useAnchoredMenuPosition(menuRef, anchorRef, options);
		});
	}

	it('places a right-side flyout past the anchor edge, aligned to its top', () => {
		setupViewport(1000, 800);
		const anchor = elementWithRect({ left: 100, top: 300, width: 100, height: 28 });
		const menu = elementWithRect({ left: 0, top: 0, width: 160, height: 200 });

		const { result } = placeBeside(anchor, menu, { placement: 'right', gap: 4, flip: true });

		expect(result.current.left).toBe(204);
		expect(result.current.top).toBe(300);
		expect(result.current.ready).toBe(true);
	});

	it('flips a right-side flyout to the left when it would overflow the viewport', () => {
		setupViewport(400, 800);
		const anchor = elementWithRect({ left: 220, top: 100, width: 80, height: 28 });
		const menu = elementWithRect({ left: 0, top: 0, width: 160, height: 200 });

		const { result } = placeBeside(anchor, menu, { placement: 'right', gap: 4, flip: true });

		// 220 - 4 - 160: the flyout's right edge sits a gap short of the anchor.
		expect(result.current.left).toBe(56);
	});

	it('keeps the preferred side when neither side has room', () => {
		setupViewport(300, 800);
		const anchor = elementWithRect({ left: 100, top: 100, width: 100, height: 28 });
		const menu = elementWithRect({ left: 0, top: 0, width: 260, height: 100 });

		const { result } = placeBeside(anchor, menu, { placement: 'right', gap: 4, flip: true });

		// Preferred side wins and the viewport clamp pulls it back on screen
		// (300 - 260 - 8 padding) rather than flipping into another overflow.
		expect(result.current.left).toBe(32);
	});

	it('leaves below-placement behaviour alone', () => {
		setupViewport(1000, 800);
		const anchor = elementWithRect({ left: 100, top: 300, width: 100, height: 28 });
		const menu = elementWithRect({ left: 0, top: 0, width: 160, height: 200 });

		const { result } = placeBeside(anchor, menu, { placement: 'below', gap: 6 });

		expect(result.current.left).toBe(100);
		expect(result.current.top).toBe(334);
	});
});
