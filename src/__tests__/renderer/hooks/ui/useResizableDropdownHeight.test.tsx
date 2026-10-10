/**
 * `useResizableDropdownHeight` - a dropdown resized by its bottom edge.
 *
 * The invariant that matters: the remembered height is a PREFERENCE and the
 * window only clamps what is rendered. A height dragged on a big monitor must
 * shrink to fit a small one (bottom always on screen) and come back when the
 * window grows again, without the stored value ever being rewritten by a
 * resize.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import {
	DROPDOWN_VIEWPORT_MARGIN,
	fitDropdownHeight,
	useResizableDropdownHeight,
} from '../../../../renderer/hooks/ui/useResizableDropdownHeight';

const KEY = 'test.dropdownHeight';
const TOP = 100;
const originalInnerHeight = window.innerHeight;

function setWindowHeight(height: number) {
	Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

/** Stub the dropdown's on-screen box: fixed top, height = its current maxHeight. */
function stubBox(element: HTMLElement) {
	element.getBoundingClientRect = () => {
		const height = parseFloat(element.style.maxHeight) || 0;
		return { top: TOP, bottom: TOP + height, height, left: 0, right: 0, width: 0 } as DOMRect;
	};
}

function Dropdown({ open = true }: { open?: boolean }) {
	const { panelRef, maxHeight, onResizeStart, reset, isCustomized } = useResizableDropdownHeight({
		storageKey: KEY,
		open,
		defaultHeight: 500,
		minHeight: 150,
	});
	if (!open) return null;
	return (
		<div
			data-testid="panel"
			data-customized={isCustomized ? 'yes' : 'no'}
			ref={(el) => {
				(panelRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
				if (el) stubBox(el);
			}}
			style={{ maxHeight: `${maxHeight}px` }}
		>
			<div data-testid="grip" onMouseDown={(e) => onResizeStart('s', e)} />
			<button data-testid="reset" onClick={reset} />
		</div>
	);
}

const panelMaxHeight = () => parseFloat(screen.getByTestId('panel').style.maxHeight);

describe('fitDropdownHeight', () => {
	it('renders the preferred height when it fits', () => {
		expect(fitDropdownHeight(400, 900)).toBe(400);
	});

	it('shrinks to the room left, even below the minimum', () => {
		expect(fitDropdownHeight(400, 120.7)).toBe(120);
	});

	it('never goes negative', () => {
		expect(fitDropdownHeight(400, -30)).toBe(0);
	});
});

describe('useResizableDropdownHeight', () => {
	beforeEach(() => {
		installLocalStorageMock();
		setWindowHeight(1400);
	});

	afterEach(() => {
		setWindowHeight(originalInnerHeight);
	});

	it('opens at the default height when nothing is remembered', () => {
		render(<Dropdown />);
		expect(panelMaxHeight()).toBe(500);
		expect(screen.getByTestId('panel').dataset.customized).toBe('no');
	});

	it('restores a remembered height', () => {
		window.localStorage.setItem(KEY, '900');
		render(<Dropdown />);
		expect(panelMaxHeight()).toBe(900);
	});

	it('clamps a height remembered on a big monitor so the bottom stays on a small one', () => {
		window.localStorage.setItem(KEY, '1200');
		setWindowHeight(700);
		render(<Dropdown />);
		expect(panelMaxHeight()).toBe(700 - TOP - DROPDOWN_VIEWPORT_MARGIN);
	});

	it('follows the window as it shrinks and grows, without rewriting the preference', () => {
		window.localStorage.setItem(KEY, '1000');
		render(<Dropdown />);
		expect(panelMaxHeight()).toBe(1000);

		act(() => {
			setWindowHeight(600);
			window.dispatchEvent(new Event('resize'));
		});
		expect(panelMaxHeight()).toBe(600 - TOP - DROPDOWN_VIEWPORT_MARGIN);

		act(() => {
			setWindowHeight(1400);
			window.dispatchEvent(new Event('resize'));
		});
		expect(panelMaxHeight()).toBe(1000);
		expect(window.localStorage.getItem(KEY)).toBe('1000');
	});

	it('persists a dragged height on release', () => {
		render(<Dropdown />);
		fireEvent.mouseDown(screen.getByTestId('grip'), { clientY: 600 });
		fireEvent.mouseMove(document, { clientY: 750 });
		expect(panelMaxHeight()).toBe(650);
		fireEvent.mouseUp(document);

		expect(window.localStorage.getItem(KEY)).toBe('650');
		expect(panelMaxHeight()).toBe(650);
		expect(screen.getByTestId('panel').dataset.customized).toBe('yes');
	});

	it('stops a drag at the bottom of the window', () => {
		setWindowHeight(800);
		render(<Dropdown />);
		fireEvent.mouseDown(screen.getByTestId('grip'), { clientY: 600 });
		fireEvent.mouseMove(document, { clientY: 5000 });
		fireEvent.mouseUp(document);

		expect(panelMaxHeight()).toBe(800 - TOP - DROPDOWN_VIEWPORT_MARGIN);
	});

	it('stops a drag at the minimum height', () => {
		render(<Dropdown />);
		fireEvent.mouseDown(screen.getByTestId('grip'), { clientY: 600 });
		fireEvent.mouseMove(document, { clientY: 0 });
		fireEvent.mouseUp(document);

		expect(window.localStorage.getItem(KEY)).toBe('150');
	});

	it('swallows the click a drag release would synthesize under the cursor', () => {
		render(<Dropdown />);
		fireEvent.mouseDown(screen.getByTestId('grip'), { clientY: 600 });
		fireEvent.mouseUp(document);

		let clicked = false;
		const target = document.createElement('button');
		target.addEventListener('click', () => (clicked = true));
		document.body.appendChild(target);
		fireEvent.click(target);
		expect(clicked).toBe(false);
		target.remove();
	});

	it('commits the in-progress height if the window loses focus mid-drag', () => {
		render(<Dropdown />);
		fireEvent.mouseDown(screen.getByTestId('grip'), { clientY: 600 });
		fireEvent.mouseMove(document, { clientY: 700 });
		fireEvent.blur(window);

		expect(window.localStorage.getItem(KEY)).toBe('600');
	});

	it('forgets the remembered height on reset', () => {
		window.localStorage.setItem(KEY, '900');
		render(<Dropdown />);
		fireEvent.click(screen.getByTestId('reset'));

		expect(panelMaxHeight()).toBe(500);
		expect(window.localStorage.getItem(KEY)).toBeNull();
	});
});
