/**
 * Tests for useAnchoredMenuPosition - places a portaled dropdown under an anchor.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import React, { useRef } from 'react';
import { render, screen } from '@testing-library/react';
import { useAnchoredMenuPosition } from '../../../../renderer/hooks/ui/useAnchoredMenuPosition';

/** Stub an element's rect, which jsdom otherwise reports as all zeroes. */
function stubRect(el: HTMLElement, rect: Partial<DOMRect>) {
	el.getBoundingClientRect = () =>
		({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...rect }) as DOMRect;
}

interface HarnessProps {
	anchorRect?: Partial<DOMRect>;
	menuSize?: { width: number; height: number };
	gap?: number;
	/** Render without ever attaching the anchor ref, simulating a missing anchor. */
	detachAnchor?: boolean;
}

function Harness({ anchorRect, menuSize, gap, detachAnchor }: HarnessProps) {
	const anchorRef = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	// Stub rects before the hook measures. Assigning during render is fine here:
	// the callback refs below run before the hook's layout effect.
	const setAnchor = (el: HTMLDivElement | null) => {
		if (el && anchorRect) stubRect(el, anchorRect);
		if (!detachAnchor) (anchorRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
	};
	const setMenu = (el: HTMLDivElement | null) => {
		if (el && menuSize) stubRect(el, menuSize);
		(menuRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
	};

	const { left, top, ready } = useAnchoredMenuPosition(menuRef, anchorRef, gap);

	return (
		<>
			<div ref={setAnchor} data-testid="anchor" />
			<div ref={setMenu} data-testid="menu" data-left={left} data-top={top} data-ready={ready} />
		</>
	);
}

function readPosition() {
	const menu = screen.getByTestId('menu');
	return {
		left: Number(menu.getAttribute('data-left')),
		top: Number(menu.getAttribute('data-top')),
		ready: menu.getAttribute('data-ready') === 'true',
	};
}

describe('useAnchoredMenuPosition', () => {
	beforeEach(() => {
		window.innerWidth = 1200;
		window.innerHeight = 800;
	});

	it('places the menu just below the anchor', () => {
		render(
			<Harness anchorRect={{ left: 100, bottom: 40 }} menuSize={{ width: 200, height: 150 }} />
		);

		const { left, top, ready } = readPosition();
		expect(left).toBe(100);
		expect(top).toBe(46); // anchor bottom + default 6px gap
		expect(ready).toBe(true);
	});

	it('honors a custom gap', () => {
		render(
			<Harness
				anchorRect={{ left: 100, bottom: 40 }}
				menuSize={{ width: 200, height: 150 }}
				gap={20}
			/>
		);

		expect(readPosition().top).toBe(60);
	});

	it('pulls the menu left so a wide menu near the right edge stays on screen', () => {
		window.innerWidth = 500;
		render(
			<Harness anchorRect={{ left: 420, bottom: 40 }} menuSize={{ width: 200, height: 100 }} />
		);

		// 420 would overflow; clamped to innerWidth - width - padding = 500-200-8.
		expect(readPosition().left).toBe(292);
	});

	it('lifts the menu up when it would run off the bottom', () => {
		window.innerHeight = 300;
		render(
			<Harness anchorRect={{ left: 10, bottom: 280 }} menuSize={{ width: 100, height: 200 }} />
		);

		// 286 would overflow; clamped to innerHeight - height - padding = 300-200-8.
		expect(readPosition().top).toBe(92);
	});

	it('never positions off the top-left edge', () => {
		window.innerWidth = 100;
		window.innerHeight = 100;
		render(<Harness anchorRect={{ left: 0, bottom: 0 }} menuSize={{ width: 400, height: 400 }} />);

		// A menu larger than the viewport clamps to the 8px padding, not negatives.
		const { left, top } = readPosition();
		expect(left).toBe(8);
		expect(top).toBe(8);
	});

	it('stays unready when the anchor never attaches', () => {
		render(<Harness menuSize={{ width: 100, height: 100 }} detachAnchor />);

		// Without a measurable anchor the menu must not flash at the top-left.
		expect(readPosition().ready).toBe(false);
	});

	it('measures an anchor that mounts in the same commit as the menu', () => {
		// The lazy initializer can't see the anchor here (refs attach after
		// render), so the layout-effect fallback has to pick it up.
		render(<Harness anchorRect={{ left: 60, bottom: 24 }} menuSize={{ width: 120, height: 80 }} />);

		const { left, top, ready } = readPosition();
		expect(ready).toBe(true);
		expect(left).toBe(60);
		expect(top).toBe(30);
	});
});
