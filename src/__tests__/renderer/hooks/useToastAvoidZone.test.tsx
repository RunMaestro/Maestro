/**
 * Tests for useToastAvoidZone.
 *
 * jsdom has no layout engine, so getBoundingClientRect is stubbed. The behavior
 * under test is the registration lifecycle and the overlap arithmetic, neither
 * of which depends on real layout.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import {
	toastBottomInset,
	useToastAvoidZone,
	useToastAvoidZoneStore,
} from '../../../renderer/hooks/ui/useToastAvoidZone';

const rect = (left: number, top: number, right: number, bottom: number) => ({
	left,
	top,
	right,
	bottom,
});

describe('toastBottomInset', () => {
	const stack = { left: 1100, right: 1500 };

	it('returns 0 with no zones', () => {
		expect(toastBottomInset({}, stack, 900)).toBe(0);
	});

	it('lifts the stack above a zone it overlaps horizontally', () => {
		// Right Bar closed: the composer runs to the window's right edge.
		expect(toastBottomInset({ a: rect(300, 780, 1516, 900) }, stack, 900)).toBe(120);
	});

	it('ignores a zone that ends before the stack starts', () => {
		// Right Bar open and wider than the toast: composer stops short of the stack.
		expect(toastBottomInset({ a: rect(300, 780, 1100, 900) }, stack, 900)).toBe(0);
	});

	it('ignores a zero-height zone', () => {
		expect(toastBottomInset({ a: rect(300, 900, 1516, 900) }, stack, 900)).toBe(0);
	});

	it('clears the tallest overlapping zone', () => {
		const zones = { a: rect(300, 780, 1516, 900), b: rect(1000, 700, 1516, 900) };
		expect(toastBottomInset(zones, stack, 900)).toBe(200);
	});
});

function Harness() {
	const ref = useToastAvoidZone();
	return <div ref={ref} data-testid="zone" />;
}

describe('useToastAvoidZone', () => {
	beforeEach(() => {
		useToastAvoidZoneStore.setState({ zones: {} });
	});

	it('registers the element rect on mount and removes it on unmount', () => {
		const spy = vi
			.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
			.mockReturnValue({ left: 10, top: 700, right: 1000, bottom: 800 } as DOMRect);

		const { unmount } = render(<Harness />);
		expect(Object.values(useToastAvoidZoneStore.getState().zones)).toEqual([
			rect(10, 700, 1000, 800),
		]);

		unmount();
		expect(useToastAvoidZoneStore.getState().zones).toEqual({});
		spy.mockRestore();
	});

	it('re-measures on window resize', () => {
		const spy = vi
			.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
			.mockReturnValue({ left: 10, top: 700, right: 1000, bottom: 800 } as DOMRect);

		const { unmount } = render(<Harness />);
		spy.mockReturnValue({ left: 10, top: 500, right: 1000, bottom: 600 } as DOMRect);
		fireEvent(window, new Event('resize'));

		expect(Object.values(useToastAvoidZoneStore.getState().zones)).toEqual([
			rect(10, 500, 1000, 600),
		]);
		unmount();
		spy.mockRestore();
	});

	it('skips the store write when the rect is unchanged', () => {
		const spy = vi
			.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
			.mockReturnValue({ left: 10, top: 700, right: 1000, bottom: 800 } as DOMRect);

		const { unmount } = render(<Harness />);
		const before = useToastAvoidZoneStore.getState().zones;
		fireEvent(window, new Event('resize'));
		expect(useToastAvoidZoneStore.getState().zones).toBe(before);
		unmount();
		spy.mockRestore();
	});
});
